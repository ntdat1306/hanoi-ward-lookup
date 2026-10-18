// Fills origin_ward_id / destination_ward_id (Google Places Autocomplete (New), one call per address) and the
// driving distance in metres (Routes API computeRoutes, one call per move) in the moves workbook.
//
//   pnpm lookup [--file <xlsx>] [--rows 4,5,10-20] [--dry-run] [--no-distance] [--concurrency 5]
//
// A ward is accepted only when Google's street equals the searched street and the result is in Hà Nội.
// Addresses without "number + street" (landmarks, buildings) are searched by place name instead and
// accepted when Google's place name matches the address (status filled-place: less reliable, review it).
// Only empty cells are filled; existing values are never overwritten. Everything else is reported.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { createGoogleClient, filledStatus, loadApiKey, loadWards, mapPool, readPlace } from './google.mjs';
import { DISTANCE_REASON, WARD_REASON } from './reasons.mjs';
import { buildQuery, isDisposalAddress, wardKey } from './address.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = path.join(ROOT, 'output');

// ---------- arguments & config ----------
function parseArgs(argv) {
  const args = { file: path.join(ROOT, 'input', 'moves-2026-09-processed.xlsx'), rows: null, dryRun: false, distance: true, concurrency: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') args.file = argv[++i];
    else if (a === '--rows') args.rows = parseRows(argv[++i]);
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-distance') args.distance = false;
    else if (a === '--concurrency') args.concurrency = Math.max(1, Number(argv[++i]) || 1);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return args;
}

/** "4,5,10-12" → Set {4,5,10,11,12} (Excel row numbers) */
function parseRows(spec) {
  const rows = new Set();
  for (const part of String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [from, to = from] = part.split('-').map(Number);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) throw new Error(`Invalid --rows value: ${part}`);
    for (let r = from; r <= to; r++) rows.add(r);
  }
  return rows;
}

// Fixes by hand for single moves of the September workbook, by source_row (see main)
const MANUAL_OVERRIDES = existsSync(path.join(ROOT, 'data', 'manual-overrides.json'))
  ? JSON.parse(readFileSync(path.join(ROOT, 'data', 'manual-overrides.json'), 'utf8')) : [];

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const google = createGoogleClient({ apiKey: loadApiKey() });

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(args.file);
  const moves = workbook.getWorksheet('moves');
  if (!moves) throw new Error('The workbook needs a "moves" sheet');

  // exceljs drops the (required by the OOXML schema) defaultRowHeight attribute when the source
  // file never set one, which makes Excel flag every sheet as corrupt on the next open.
  for (const sheet of workbook.worksheets) {
    if (!sheet.properties.defaultRowHeight) sheet.properties.defaultRowHeight = 15;
  }

  const header = (sheet) => {
    const map = new Map();
    sheet.getRow(1).eachCell((cell, col) => map.set(String(cell.value).trim(), col));
    return map;
  };
  const col = header(moves);
  for (const name of ['source_row', 'origin_address', 'destination_address', 'origin_ward_id', 'destination_ward_id', 'distance']) {
    if (!col.has(name)) throw new Error(`Column "${name}" not found in the moves sheet`);
  }
  // The 126 current wards (id written into the cells, official code, name) live in data/wards.json
  const { wardsByKey, wardsById } = loadWards();

  // Moves whose pick-up or drop-off only names a disposal action ("Vứt", "Chở Đi Bỏ") are deleted from the
  // sheet on a whole-workbook run. Not with --rows (deleting shifts the row numbers it refers to), nor on a dry run.
  const disposal = [];
  moves.eachRow((row, r) => {
    if (r === 1) return;
    const side = ['origin', 'destination'].find((s) => isDisposalAddress(row.getCell(col.get(`${s}_address`)).value));
    if (side) disposal.push({ r, side, sourceRow: row.getCell(col.get('source_row')).value, address: row.getCell(col.get(`${side}_address`)).value });
  });
  const deleteDisposal = disposal.length > 0 && !args.rows && !args.dryRun;
  for (const d of disposal) {
    console.log(`  ${deleteDisposal ? 'deleted' : 'would delete (whole-workbook run only)'}: Excel row ${d.r} (source_row ${d.sourceRow}) ${d.side} "${d.address}"`);
  }
  const save = async () => {
    try {
      await workbook.xlsx.writeFile(args.file);
    } catch (error) {
      if (error.code === 'EBUSY' || error.code === 'EPERM') {
        throw new Error(`Cannot write ${args.file}: it is open in Excel. Save and close it, then run again on the remaining rows (progress so far is saved, cache avoids repeat API calls).`);
      }
      throw error;
    }
  };
  if (deleteDisposal) {
    for (const d of [...disposal].reverse()) moves.spliceRows(d.r, 1);
    await save();
  }
  const skipRows = new Set(deleteDisposal ? [] : disposal.map((d) => d.r));

  // Collect the addresses to look up
  const jobs = [];
  moves.eachRow((row, r) => {
    if (r === 1 || (args.rows && !args.rows.has(r)) || skipRows.has(r)) return;
    for (const side of ['origin', 'destination']) {
      const address = row.getCell(col.get(`${side}_address`)).value;
      if (!address) continue;
      const wardCell = row.getCell(col.get(`${side}_ward_id`));
      const current = wardCell.value === null || wardCell.value === '' ? null : Number(wardCell.value);
      jobs.push({ excelRow: r, sourceRow: row.getCell(col.get('source_row')).value, side, address: String(address), wardCell, current, query: buildQuery(String(address)) });
    }
  });

  // Process in checkpoints: on a long run, save the workbook after every batch instead of
  // only at the very end, so a crash or rate-limit error partway through doesn't lose progress.
  const CHECKPOINT_SIZE = 40;
  const results = [];
  for (let start = 0; start < jobs.length; start += CHECKPOINT_SIZE) {
    const batch = jobs.slice(start, start + CHECKPOINT_SIZE);
    const batchResults = await mapPool(batch, args.concurrency, async (job) => {
      const { d, searched } = await google.lookup(job, wardsByKey);
      if (d.status !== 'found') return { ...job, ...d, searched };
      if (job.current === null) {
        if (!args.dryRun) job.wardCell.value = d.ward.id;
        return { ...job, ...d, searched, status: filledStatus(d) };
      }
      return { ...job, ...d, searched, status: job.current === d.ward.id ? 'same' : 'differs' };
    });
    results.push(...batchResults);

    const isFilled = (r) => r.status === 'filled' || r.status === 'filled-place';
    const filledInBatch = batchResults.filter(isFilled).length;
    if (!args.dryRun && filledInBatch > 0) {
      await save();
      const totalFilled = results.filter(isFilled).length;
      console.log(`  checkpoint: saved (${Math.min(start + CHECKPOINT_SIZE, jobs.length)}/${jobs.length} processed, ${totalFilled} filled so far)`);
    }
  }

  // Manual fixes (data/manual-overrides.json, by source_row): a ward, a point to search for the distance (its ward
  // is taken when none is given), or the other side's ward and point ("Nhà đối diện"). Status filled-manual.
  const overrideFor = (r, side) => MANUAL_OVERRIDES.find((o) => String(o.source_row) === String(r.sourceRow) && o.side === side);
  for (const r of results) {
    const o = overrideFor(r, r.side);
    if (!o || o.sameAsOther) continue;
    let ward = o.ward ? wardsByKey.get(wardKey(o.ward))?.[0] : null;
    if (o.ward && !ward) throw new Error(`data/manual-overrides.json: unknown ward "${o.ward}"`);
    let placeId = r.placeId;
    if (o.point) {
      const point = (await google.searchPlaces(`${o.point}, Hà Nội`)).map((p) => readPlace(p, wardsByKey)).find((p) => p.isHanoi);
      placeId = point?.placeId;
      // Only a point for a cell that already has its ward: the ward stays
      ward ??= (r.current != null ? wardsById.get(r.current) : point?.ward) ?? null;
      r.google = point ? `điểm sửa tay "${o.point}" → ${point.address}` : r.google;
    }
    applyManual(r, ward, placeId);
  }
  for (const r of results) {
    const o = overrideFor(r, r.side);
    if (!o?.sameAsOther) continue;
    const other = results.find((x) => x.excelRow === r.excelRow && x.side !== r.side);
    applyManual(r, other?.ward ?? (other?.current != null ? wardsById.get(other.current) : null), other?.placeId);
    r.google = 'cùng chỗ với đầu kia';
  }
  function applyManual(r, ward, placeId) {
    if (!ward) return;
    r.ward = ward;
    r.placeId = placeId;
    if (r.current === null) {
      if (!args.dryRun) r.wardCell.value = ward.id;
      r.status = 'filled-manual';
    } else r.status = r.current === ward.id ? 'same' : 'differs';
  }

  // Driving distance of each move (metres, the "distance" column) between the predictions chosen for its pick-up
  // and drop-off. Only when both got a ward from Google (filled, same or differs); an existing distance is kept.
  const moveRows = new Map();
  for (const r of results) moveRows.set(r.excelRow, { ...moveRows.get(r.excelRow), excelRow: r.excelRow, sourceRow: r.sourceRow, [r.side]: r });
  const routeOne = async (m) => {
    const cell = moves.getRow(m.excelRow).getCell(col.get('distance'));
    const current = cell.value === null || cell.value === '' ? null : Number(cell.value);
    // A distance given by hand (from raw_text, "cách 300m"; or "Nhà đối diện") wins over the route
    const fixed = MANUAL_OVERRIDES.find((o) => String(o.source_row) === String(m.sourceRow) && o.distance != null)?.distance;
    if (fixed != null) {
      const route = { distanceMeters: fixed, duration: null };
      if (current !== null) return { ...m, current, route, routeStatus: current === fixed ? 'same' : 'differs' };
      if (!args.dryRun) cell.value = fixed;
      return { ...m, current, route, routeStatus: 'filled' };
    }
    if (!m.origin?.placeId || !m.destination?.placeId) return { ...m, current, routeStatus: 'no-point' };
    const route = await google.computeRoute(m.origin.placeId, m.destination.placeId);
    if (!route) return { ...m, current, routeStatus: 'no-route' };
    if (current !== null) return { ...m, current, route, routeStatus: current === route.distanceMeters ? 'same' : 'differs' };
    if (!args.dryRun) cell.value = route.distanceMeters;
    return { ...m, current, route, routeStatus: 'filled' };
  };
  // Same checkpoints as the ward lookup: the workbook is saved after every batch that wrote a distance
  const routes = [];
  const moveList = args.distance ? [...moveRows.values()] : [];
  for (let start = 0; start < moveList.length; start += CHECKPOINT_SIZE * 5) {
    const batch = await mapPool(moveList.slice(start, start + CHECKPOINT_SIZE * 5), args.concurrency, routeOne);
    routes.push(...batch);
    if (!args.dryRun && batch.some((r) => r.routeStatus === 'filled')) {
      await save();
      console.log(`  distance checkpoint: saved (${routes.length}/${moveList.length} moves, ${google.stats.routes} Routes calls so far)`);
    }
  }
  const routeByRow = new Map(routes.map((r) => [r.excelRow, r]));

  google.save();

  // Report
  const label = (id) => (id == null ? '' : `${id} ${wardsById.get(id)?.name ?? '?'}`);
  const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['excel_row', 'source_row', 'side', 'address', 'query', 'status', 'google_address', 'google_ward', 'existing_ward',
    'place_id', 'lat', 'lng', 'distance_m', 'duration', 'distance_status'].map(csv).join(',')];
  for (const r of results) {
    const m = routeByRow.get(r.excelRow);
    lines.push([r.excelRow, r.sourceRow, r.side, r.address, r.searched, r.status, r.google, label(r.ward?.id), label(r.current),
      r.placeId, m?.route?.[r.side]?.lat, m?.route?.[r.side]?.lng, m?.route?.distanceMeters, m?.route?.duration, m?.routeStatus].map(csv).join(','));
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });
  // A --rows run carries the other rows over from the previous report and error list, so both stay complete
  const previous = (prefix, ext) => (args.rows ? readdirSync(OUTPUT_DIR).filter((f) => f.startsWith(prefix) && f.endsWith(ext)).sort().at(-1) : null);
  const prevReport = previous('ward-lookup-report-', '.csv');
  if (prevReport) {
    for (const line of readFileSync(path.join(OUTPUT_DIR, prevReport), 'utf8').replace(/^﻿/, '').split(/\r?\n/).slice(1).filter(Boolean)) {
      if (!args.rows.has(Number(line.match(/^"(\d+)"/)?.[1]))) lines.push(line);
    }
  }
  const rowOf = (line) => Number(line.match(/^"(\d+)"/)?.[1]);
  lines.splice(1, lines.length - 1, ...lines.slice(1).sort((a, b) => rowOf(a) - rowOf(b)));
  const prevErrors = previous('dong-loi-', '.xlsx');
  const carried = [];
  if (prevErrors) {
    const old = new ExcelJS.Workbook();
    await old.xlsx.readFile(path.join(OUTPUT_DIR, prevErrors));
    old.worksheets[0].eachRow((row, r) => { if (r > 1 && !args.rows.has(Number(row.getCell(1).value))) carried.push(row.values.slice(1)); });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const reportFile = path.join(OUTPUT_DIR, `ward-lookup-report-${stamp}.csv`);
  writeFileSync(reportFile, '﻿' + lines.join('\r\n') + '\r\n');
  const errorFile = await writeErrorRows(path.join(OUTPUT_DIR, `dong-loi-${stamp}.xlsx`), moveRows, routeByRow, args.distance, carried);
  // Only the latest report and error list are kept in output/
  for (const old of readdirSync(OUTPUT_DIR)) {
    if (!/^(?:ward-lookup-report-.+\.csv|dong-loi-.+\.xlsx)$/.test(old) || old.includes(stamp)) continue;
    try { rmSync(path.join(OUTPUT_DIR, old)); } catch { console.log(`  kept ${old}: it is open (in Excel?)`); }
  }

  const counts = results.reduce((m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m), {});
  console.log(`${args.dryRun ? '[dry run] ' : ''}addresses: ${results.length}, API calls: ${google.stats.autocomplete} Autocomplete + ${google.stats.routes} Routes (rest from cache)`);
  console.log('by status:', counts);
  const routeCounts = routes.reduce((m, r) => ((m[r.routeStatus] = (m[r.routeStatus] ?? 0) + 1), m), {});
  console.log(`distance (moves: ${routes.length}):`, routeCounts);
  // Console: only what needs a human (filled/same rows are in the CSV report); everything when few rows were asked for
  const toShow = args.rows ? results : results.filter((x) => !['same', 'filled', 'filled-place', 'filled-area', 'filled-single', 'filled-street', 'filled-written', 'filled-manual'].includes(x.status));
  for (const r of toShow) {
    console.log(`  Excel row ${r.excelRow} (source_row ${r.sourceRow}) ${r.side.padEnd(11)} ${r.status.padEnd(15)} ${r.address}` +
      (r.searched ? `  [query: ${r.searched}]` : '') + (r.google ? `  → ${r.google}` : '') +
      (r.ward ? `  => ${label(r.ward.id)}` : '') + (r.status === 'differs' ? `  (kept ${label(r.current)})` : ''));
  }
  // Distances: every move when few rows were asked for, otherwise only those without one
  for (const m of args.rows ? routes : routes.filter((r) => !['filled', 'same'].includes(r.routeStatus))) {
    const p = (x) => (x ? `${x.lat.toFixed(6)},${x.lng.toFixed(6)}` : '?');
    console.log(`  Excel row ${m.excelRow} (source_row ${m.sourceRow}) distance ${m.routeStatus.padEnd(8)}` +
      (m.route ? ` ${m.route.distanceMeters} m, ${m.route.duration}  [${p(m.route.origin)} → ${p(m.route.destination)}]` : '') +
      (m.routeStatus === 'differs' ? `  (kept ${m.current} m)` : ''));
  }
  console.log(`report: ${reportFile}`);
  console.log(`error rows: ${errorFile.count} → ${errorFile.file}`);
  if (args.dryRun) console.log('dry run: the workbook was not modified');
}

const WARD_OK = new Set(['filled', 'filled-place', 'filled-area', 'filled-single', 'filled-street', 'filled-written', 'filled-manual', 'same', 'differs']);

/**
 * One line per move with a problem: a side without a ward, or (when distances were computed) no distance.
 * Reasons in Vietnamese from reasons.mjs. `carried`: lines (cell values) kept from the previous list. Returns { file, count }.
 */
async function writeErrorRows(file, moveRows, routeByRow, withDistance, carried = []) {
  const out = new ExcelJS.Workbook();
  const sheet = out.addWorksheet('dong-loi');
  sheet.columns = [
    { header: 'Dòng Excel', key: 'row', width: 10 },
    { header: 'source_row', key: 'source', width: 10 },
    { header: 'Địa chỉ đi', key: 'oAddress', width: 45 },
    { header: 'Lỗi điểm đi', key: 'oStatus', width: 16 },
    { header: 'Lý do điểm đi', key: 'oReason', width: 55 },
    { header: 'Google trả về (đi)', key: 'oGoogle', width: 50 },
    { header: 'Địa chỉ đến', key: 'dAddress', width: 45 },
    { header: 'Lỗi điểm đến', key: 'dStatus', width: 16 },
    { header: 'Lý do điểm đến', key: 'dReason', width: 55 },
    { header: 'Google trả về (đến)', key: 'dGoogle', width: 50 },
    { header: 'Lỗi quãng đường', key: 'distStatus', width: 16 },
    { header: 'Lý do quãng đường', key: 'distReason', width: 55 },
  ];
  const entries = [...carried];
  for (const m of [...moveRows.values()].sort((a, b) => a.excelRow - b.excelRow)) {
    const side = (r) => (!r || WARD_OK.has(r.status) ? {} : { address: r.address, status: r.status, reason: WARD_REASON[r.status] ?? r.status, google: r.google ?? '' });
    const o = side(m.origin);
    const d = side(m.destination);
    const route = routeByRow.get(m.excelRow);
    const dist = withDistance && route && DISTANCE_REASON[route.routeStatus] ? route.routeStatus : null;
    if (!o.status && !d.status && !dist) continue;
    entries.push([m.excelRow, m.sourceRow, m.origin?.address ?? '', o.status ?? '', o.reason ?? '', o.google ?? '',
      m.destination?.address ?? '', d.status ?? '', d.reason ?? '', d.google ?? '', dist ?? '', dist ? DISTANCE_REASON[dist] : '']);
  }
  for (const values of entries.sort((a, b) => a[0] - b[0])) sheet.addRow(values);
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = 'A1:L1';
  sheet.properties.defaultRowHeight = 15; // see the exceljs defaultRowHeight note in main()
  await out.xlsx.writeFile(file);
  return { file, count: entries.length };
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
