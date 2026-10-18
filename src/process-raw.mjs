// Turns a raw order sheet (data.xlsx on the Desktop) into one review workbook with four sheets:
//   Original Data   the source sheet untouched (values, formatting, row order)
//   Formatted Data  one line per source record: timestamp (year typos fixed, UTC), pick-up / drop-off split and
//                   cleaned, price, phone (inferred from the row above when it is the same order), service type
//   Processed Data  the records that pass every check, with exactly the importable columns of the `moves` table
//   Failed Rows     every other record: its original cells plus each problem (stage, field, reason, temporary?)
//
//   pnpm process [--input <xlsx>] [--out <xlsx>] [--rows 2-40,55] [--cache-only] [--offline-schema]
//                [--statuses "Hoàn thành"] [--expected-years 2026] [--concurrency 5]
//
// Wards come from Google Places Autocomplete (one call per address, rules of google.mjs), distances from the Routes
// API; both cached in cache/, so a re-run only asks Google what it has not answered yet. --cache-only sends nothing
// (a cache miss is a temporary failure): use it to preview and to count the calls a real run would make.
// The database is only read (schema, wards, service types, existing moves for duplicates): nothing is inserted.
// The workbook goes to output/<input name>_processed.xlsx, with one log next to it (<name>_processed.log.jsonl:
// summary, every transformation, Google's answer per address); a re-run of the same input overwrites both.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { buildQuery, isDisposalAddress } from './address.mjs';
import { importColumns, loadDbSchema } from './db-schema.mjs';
import { createGoogleClient, filledStatus, loadApiKey, loadWards, mapPool } from './google.mjs';
import { addressKey, correctYear, findColumns, formatLocal, hanoiToUtc, inferFromRowAbove, mapService, parsePhone, parsePrice, parseTime, readDate, splitAddresses } from './raw.mjs';
import { WARD_REASON, DISTANCE_REASON } from './reasons.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = path.join(ROOT, 'output');
const SHEETS = ['Original Data', 'Formatted Data', 'Processed Data', 'Failed Rows'];

// ---------- arguments ----------
/** The user's real Desktop (it may be redirected, e.g. to OneDrive) */
function desktopDir() {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"], { encoding: 'utf8' });
    const dir = r.stdout?.trim();
    if (dir && existsSync(dir)) return dir;
  }
  return path.join(os.homedir(), 'Desktop');
}

function parseRows(spec) {
  const rows = new Set();
  for (const part of String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [from, to = from] = part.split('-').map(Number);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from > to) throw new Error(`Invalid --rows value: ${part}`);
    for (let r = from; r <= to; r++) rows.add(r);
  }
  return rows;
}

function parseArgs(argv) {
  const desktop = desktopDir();
  const args = { input: path.join(desktop, 'data.xlsx'), out: null, rows: null, cacheOnly: false, offlineSchema: false,
    statuses: ['Hoàn thành'], expectedYears: [2026], concurrency: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') args.input = path.resolve(argv[++i]);
    else if (a === '--out') args.out = path.resolve(argv[++i]);
    else if (a === '--rows') args.rows = parseRows(argv[++i]);
    else if (a === '--cache-only') args.cacheOnly = true;
    else if (a === '--offline-schema') args.offlineSchema = true;
    else if (a === '--statuses') args.statuses = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--expected-years') args.expectedYears = argv[++i].split(',').map(Number);
    else if (a === '--concurrency') args.concurrency = Math.max(1, Number(argv[++i]) || 1);
    else throw new Error(`Unknown argument: ${a}`);
  }
  args.out ??= path.join(OUTPUT_DIR, `${path.basename(args.input, path.extname(args.input))}_processed.xlsx`);
  mkdirSync(path.dirname(args.out), { recursive: true });
  if (path.resolve(args.out).toLowerCase() === path.resolve(args.input).toLowerCase()) throw new Error('--out must not be the input file');
  return args;
}

// ---------- helpers ----------
const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && !v.trim()) || (typeof v === 'object' && !(v instanceof Date) && 'richText' in v && !v.richText.map((t) => t.text).join('').trim());
/** Plain value of a cell: rich text joined, formulas replaced by their result */
function plain(v) {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return v.result ?? null;
    if ('text' in v) return v.text;
  }
  return v;
}
const maskPhone = (p) => (p ? `${p.slice(0, 3)}****${p.slice(-3)}` : p);
const pad = (n) => String(n).padStart(2, '0');
const showDate = (v) => (v instanceof Date ? `${pad(v.getUTCDate())}/${pad(v.getUTCMonth() + 1)}/${v.getUTCFullYear()}` : v === null || v === undefined ? '' : String(v));
/** API natural key of a move (hanoi-moving-insights-api normalize.ts duplicateKey) */
const foldForKey = (a) => String(a ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
const hanoiDay = (date) => new Date(date.getTime() + 7 * 3600e3).toISOString().slice(0, 10);
const duplicateKey = (m) => [m.phone ?? '', hanoiDay(m.movedAt), foldForKey(m.originAddress), foldForKey(m.destinationAddress), m.serviceTypeId].join('|');

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();
  const log = [];
  const event = (row, stage, name, details = {}) => log.push({ row, stage, event: name, ...details });

  if (!existsSync(args.input)) throw new Error(`Input not found: ${args.input}`);
  console.log(`input:  ${args.input}\noutput: ${args.out}${args.cacheOnly ? '\nmode:   cache only (no Google call is sent)' : ''}`);

  // Database: the source of truth for columns, ids and constraints (read only)
  const schema = await loadDbSchema({ offline: args.offlineSchema });
  const columns = importColumns(schema);
  console.log(`schema: ${schema.database}.moves from ${schema.source} → ${columns.map((c) => c.name).join(', ')}`);
  const fkTable = new Map(schema.foreignKeys.map((f) => [f.column, f.table]));
  const idsOf = { wards: new Set(schema.wards.map((w) => w.id)), service_types: new Set(schema.serviceTypes.map((t) => t.id)) };
  const serviceTypeIdByName = new Map(schema.serviceTypes.map((t) => [t.name, t.id]));

  // data/wards.json gives Google's ward names their id: it must agree with the database, id for id
  const { wardsByKey, wardsById } = loadWards();
  const dbWards = new Map(schema.wards.map((w) => [w.id, w]));
  const wardMismatch = [...wardsById.values()].filter((w) => dbWards.get(w.id)?.code !== w.code || dbWards.get(w.id)?.name !== w.name);
  if (wardMismatch.length || dbWards.size !== wardsById.size) throw new Error(`data/wards.json and the wards table disagree (${wardMismatch.map((w) => w.id).join(', ') || 'count'}): fix that first`);

  // ---------- read ----------
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(args.input);
  let source = null;
  let col = null;
  for (const sheet of workbook.worksheets) {
    try { col = findColumns(sheet.getRow(1).values.slice(1).map((v) => plain(v))); source = sheet; break; } catch { /* not the orders sheet */ }
  }
  if (!source) throw new Error(`No sheet of ${args.input} has the expected header ("Thời gian", "Điểm đón và trả hàng", "Đơn Giá", "SĐT", "Loại DV")`);
  const otherSheets = workbook.worksheets.filter((s) => s !== source).map((s) => s.name);
  // Array.from: row values are sparse (an empty A1 is a hole that map/filter would skip)
  const width = Math.max(source.columnCount, source.getRow(1).cellCount);
  const headerCells = Array.from({ length: width }, (_, i) => plain(source.getRow(1).getCell(i + 1).value) ?? null);

  const records = [];
  const nonRecords = [];
  for (let r = 2; r <= source.rowCount; r++) {
    const row = source.getRow(r);
    const cells = Array.from({ length: width }, (_, i) => plain(row.getCell(i + 1).value));
    // A row is a record when any order field holds something; the "STT" counter alone does not make one
    const fields = ['date', 'address', 'price', 'phone', 'time', 'service', 'status'].map((f) => (col[f] ? cells[col[f] - 1] : null));
    if (fields.every(isBlank)) { if (cells.some((c) => !isBlank(c))) nonRecords.push({ row: r, why: 'only non-order columns filled' }); else nonRecords.push({ row: r, why: 'blank' }); continue; }
    records.push({ row: r, cells, issues: [] });
  }
  const selected = args.rows ? records.filter((x) => args.rows.has(x.row)) : records;
  console.log(`sheet "${source.name}": ${source.rowCount - 1} rows under the header = ${records.length} records + ${nonRecords.length} non-record rows${args.rows ? ` (${selected.length} selected by --rows)` : ''}`);

  const fail = (rec, stage, field, reason, temporary = false, diagnostic = '') => {
    rec.issues.push({ stage, field, reason, temporary, diagnostic });
    event(rec.row, stage, 'failure', { field, reason, temporary });
  };

  // ---------- format (no Google) ----------
  for (const rec of records) {
    const v = (f) => rec.cells[col[f] - 1];
    rec.status = col.status ? String(v('status') ?? '').trim() : '';
    rec.addressRaw = v('address') == null ? null : String(v('address'));

    const date = readDate(v('date'));
    if (date.value) {
      const year = correctYear(date.value, args.expectedYears);
      if (year.corrected) event(rec.row, 'datetime', 'year corrected', { from: year.corrected.from, to: year.corrected.to, reason: 'known year typo' });
      rec.yearCorrection = year.corrected ? `${year.corrected.from} → ${year.corrected.to}` : '';
      rec.date = year.value;
      rec.dateError = year.error;
    } else rec.dateError = date.error;
    const time = parseTime(v('time'));
    rec.time = time.value;
    rec.timeError = time.error;
    rec.timeRule = time.rule ?? '';
    for (const note of time.notes ?? []) event(rec.row, 'datetime', 'note', { note });

    const split = splitAddresses(rec.addressRaw);
    Object.assign(rec, { origin: split.origin ?? null, destination: split.destination ?? null, splitRule: split.rule ?? '', removedNotes: (split.removed ?? []).join(' | ') });
    if (split.error) fail(rec, 'address split', 'Điểm đón và trả hàng', split.error);
    else {
      event(rec.row, 'address', 'split', { rule: split.rule, notes: split.notes });
      for (const side of ['origin', 'destination']) {
        if (isDisposalAddress(rec[side])) fail(rec, 'address split', 'Điểm đón và trả hàng', `${side === 'origin' ? 'pick-up' : 'drop-off'} "${rec[side]}" is a disposal action, not an address`);
      }
    }

    const price = parsePrice(v('price'));
    rec.price = price.value;
    rec.priceRule = price.rule ?? '';
    if (price.error) fail(rec, 'price', 'Đơn Giá', price.error === 'missing' ? 'price is missing (moves.price is NOT NULL)' : price.error);
    else if (price.rule !== 'number') event(rec.row, 'price', 'normalized', { rule: price.rule, value: price.value });

    const phone = parsePhone(v('phone'));
    rec.phone = phone.value;
    rec.phoneRule = phone.rule ?? '';
    rec.phoneMissing = phone.error === 'missing';
    if (phone.error && !rec.phoneMissing) fail(rec, 'phone', 'SĐT', phone.error);
    for (const note of phone.notes ?? []) event(rec.row, 'phone', 'note', { note });

    const service = mapService(v('service'), serviceTypeIdByName);
    rec.service = service.value;
    rec.serviceRule = service.rule ?? '';
    if (service.error) fail(rec, 'service type', 'Loại DV', service.error);
    else event(rec.row, 'service type', 'mapped', { label: String(v('service')).trim(), to: service.value.name, rule: service.rule });

    if (!args.statuses.includes(rec.status)) fail(rec, 'order status', 'Tình Trạng', `order status "${rec.status || '(blank)'}" is not one of: ${args.statuses.join(', ')}`);
  }

  // ---------- infer missing phone / date / time from the row directly above, only for the same order ----------
  inferFromRowAbove(records, (row, name, details) => event(row, 'inference', name, { ...details, ...(details.value && name === 'phone inferred' ? { value: maskPhone(details.value) } : {}) }));
  for (const rec of records) {
    if (rec.dateError) fail(rec, 'datetime', 'Thời gian (ngày)', rec.dateError === 'missing' ? 'date is missing and cannot be inferred from the row above' : rec.dateError);
    if (rec.timeError) fail(rec, 'datetime', 'Thời gian (giờ)', rec.timeError === 'missing' ? 'time is missing and cannot be inferred safely (row above is not the same order on the same date)' : rec.timeError);
    if (rec.date && rec.time) {
      rec.movedAt = hanoiToUtc(rec.date, rec.time);
      rec.movedAtLocal = formatLocal(rec.date, rec.time);
      event(rec.row, 'datetime', 'converted to UTC', { local: rec.movedAtLocal, utc: rec.movedAt.toISOString() });
    }
  }

  // ---------- Google: wards, then distances ----------
  // Only for selected records with no permanent problem so far: a row that fails anyway is not worth an API call
  const google = createGoogleClient({ apiKey: args.cacheOnly ? 'cache-only' : loadApiKey(), cacheOnly: args.cacheOnly });
  const toLookUp = selected.filter((r) => r.origin && r.destination && r.issues.every((i) => i.temporary));
  const addresses = [...new Set(toLookUp.flatMap((r) => [r.origin, r.destination]))];
  console.log(`Google: ${addresses.length} distinct addresses for ${toLookUp.length} records`);
  const lookups = new Map();
  await mapPool(addresses, args.concurrency, async (address) => {
    try {
      const { d, searched } = await google.lookup({ address, query: buildQuery(address) }, wardsByKey);
      lookups.set(address, { ...d, searched, status: d.status === 'found' ? filledStatus(d) : d.status });
    } catch (error) {
      if (error.name !== 'GoogleError') throw error;
      lookups.set(address, { status: 'api-error', temporary: error.retryable, error: error.message });
    }
  });
  for (const rec of toLookUp) {
    for (const side of ['origin', 'destination']) {
      const l = lookups.get(rec[side]);
      rec[`${side}Lookup`] = l;
      const field = side === 'origin' ? 'origin_ward_id' : 'destination_ward_id';
      event(rec.row, 'ward', l.ward ? 'ward matched' : 'ward unresolved', { side, status: l.status, query: l.searched, ward: l.ward?.id });
      if (l.status === 'api-error') fail(rec, 'geocoding', field, `Google error: ${l.error}`, l.temporary);
      else if (!l.ward) fail(rec, 'ward matching', field, `${side === 'origin' ? 'pick-up' : 'drop-off'} ward not found confidently: ${WARD_REASON[l.status] ?? l.status}`, false, l.google ? `Google: ${l.google}` : '');
    }
  }
  const routable = toLookUp.filter((r) => r.originLookup.ward && r.destinationLookup.ward);
  await mapPool(routable, args.concurrency, async (rec) => {
    const [o, d] = [rec.originLookup.placeId, rec.destinationLookup.placeId];
    if (!o || !d) { fail(rec, 'distance', 'distance', DISTANCE_REASON['no-point'].replace('(xem lỗi phường)', '') + ` (ward known from ${!o ? rec.originLookup.status : rec.destinationLookup.status}, but no Google point)`); return; }
    // Two different addresses read as the same Google point (both "8 Lê Quang Đạo", the lane): 0 m would be invented.
    // The same address on both sides (a move inside one building) keeps its 0 m
    if (o === d && addressKey(rec.origin) !== addressKey(rec.destination)) {
      fail(rec, 'distance', 'distance', 'pick-up and drop-off resolved to the same Google point although the addresses differ: the distance cannot be measured', false, `Google: ${rec.originLookup.google}`);
      return;
    }
    try {
      const route = await google.computeRoute(o, d);
      if (!route) { fail(rec, 'distance', 'distance', DISTANCE_REASON['no-route']); return; }
      if (!Number.isInteger(route.distanceMeters) || route.distanceMeters < 0) { fail(rec, 'distance', 'distance', `unusable distance from Google: ${route.distanceMeters}`); return; }
      rec.distance = route.distanceMeters;
      event(rec.row, 'distance', 'route', { meters: route.distanceMeters, duration: route.duration });
    } catch (error) {
      if (error.name !== 'GoogleError') throw error;
      fail(rec, 'distance', 'distance', `Google error: ${error.message}`, error.retryable);
    }
  });
  google.save();

  // ---------- final validation against the moves table ----------
  const existingKeys = new Map((schema.existingMoves ?? []).map((m) => [duplicateKey({ ...m, phone: m.phone ? (parsePhone(m.phone).value ?? m.phone) : '' }), m.id]));
  const seenKeys = new Map();
  const processed = [];
  for (const rec of selected) {
    if (rec.issues.length === 0) {
      const values = {
        moved_at: rec.movedAt, origin_address: rec.origin, destination_address: rec.destination,
        origin_ward_id: rec.originLookup?.ward?.id ?? null, destination_ward_id: rec.destinationLookup?.ward?.id ?? null,
        service_type_id: rec.service?.id ?? null, distance: rec.distance ?? null, price: rec.price, phone: rec.phone ?? null,
      };
      for (const c of columns) {
        const value = values[c.name];
        if (!(c.name in values)) { fail(rec, 'schema', c.name, `column ${c.name} of the moves table is not produced by this tool`); continue; }
        // Wards and distance are nullable in the table but required for this dataset
        if (value === null && (!c.nullable || ['origin_ward_id', 'destination_ward_id', 'distance'].includes(c.name))) { fail(rec, 'schema', c.name, `${c.name} is required but empty`); continue; }
        if (value === null) continue;
        if (c.type === 'int') {
          const max = c.unsigned ? 4_294_967_295 : 2_147_483_647;
          if (!Number.isInteger(value) || value < (c.unsigned ? 0 : -2_147_483_648) || value > max) fail(rec, 'schema', c.name, `${value} is not a valid ${c.columnType}`);
          if (c.name in schema.minimums && value < schema.minimums[c.name]) fail(rec, 'schema', c.name, `${value} violates CHECK ${c.name} >= ${schema.minimums[c.name]}`);
        }
        if (c.type === 'varchar' && (typeof value !== 'string' || value.length > c.maxLength)) fail(rec, 'schema', c.name, `longer than ${c.maxLength} characters`);
        if (c.type === 'datetime' && (!(value instanceof Date) || Number.isNaN(value.getTime()))) fail(rec, 'schema', c.name, 'invalid datetime');
        const table = fkTable.get(c.name);
        if (table && !idsOf[table]?.has(value)) fail(rec, 'foreign key', c.name, `${value} does not exist in ${table}`);
      }
      const key = duplicateKey({ phone: rec.phone, movedAt: rec.movedAt, originAddress: rec.origin, destinationAddress: rec.destination, serviceTypeId: rec.service?.id });
      if (existingKeys.has(key)) fail(rec, 'duplicate', 'moves', `already in the database (moves.id ${existingKeys.get(key)}: same phone, day, addresses and service type)`);
      else if (seenKeys.has(key)) {
        // Kept, as for the September file: two rows with the same text are usually two vehicles/services of one move
        rec.duplicateOf = seenKeys.get(key);
        event(rec.row, 'duplicate', 'same natural key as an earlier row (kept)', { ofRow: rec.duplicateOf });
      } else seenKeys.set(key, rec.row);
      if (rec.issues.length === 0) { rec.values = values; processed.push(rec); rec.processedRow = processed.length + 1; }
    }
    event(rec.row, 'result', rec.issues.length ? 'failed' : 'processed', { issues: rec.issues.length });
  }
  const failed = selected.filter((r) => r.issues.length);

  // ---------- workbook ----------
  // Sheet 1 is the source sheet itself (formatting, column widths, row order kept); other sheets of the file are dropped
  for (const name of otherSheets) workbook.removeWorksheet(workbook.getWorksheet(name).id);
  source.name = SHEETS[0];
  // exceljs drops the (required by the OOXML schema) defaultRowHeight attribute when the source file never set one,
  // which makes Excel flag every sheet as corrupt on the next open
  const fixRowHeight = (sheet) => { if (!sheet.properties.defaultRowHeight) sheet.properties.defaultRowHeight = 15; };
  fixRowHeight(source);
  const addSheet = (name, cols) => {
    const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.columns = cols.map((c) => ({ header: c.header, key: c.key, width: c.width ?? 14, style: c.style }));
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE9EEF5' } };
    fixRowHeight(sheet);
    return sheet;
  };
  const dateTimeStyle = { numFmt: 'yyyy-mm-dd hh:mm:ss' };
  const textStyle = { numFmt: '@' };

  const formatted = addSheet(SHEETS[1], [
    { header: 'source_row', key: 'row', width: 10 }, { header: 'result', key: 'result', width: 10 }, { header: 'processed_data_row', key: 'processedRow', width: 12 },
    { header: 'order_status', key: 'status', width: 12 }, { header: 'date_original', key: 'dateOriginal', width: 12 }, { header: 'time_original', key: 'timeOriginal', width: 22 },
    { header: 'year_correction', key: 'yearCorrection', width: 12 }, { header: 'time_rule', key: 'timeRule', width: 18 },
    { header: 'moved_at_local (UTC+7)', key: 'local', width: 18 }, { header: 'moved_at (UTC)', key: 'utc', width: 20, style: dateTimeStyle },
    { header: 'timestamp_inferred_from_row', key: 'timestampFrom', width: 12 },
    { header: 'address_original', key: 'addressRaw', width: 60 }, { header: 'origin_address', key: 'origin', width: 45 }, { header: 'destination_address', key: 'destination', width: 45 },
    { header: 'split_rule', key: 'splitRule', width: 9 }, { header: 'removed_notes', key: 'removedNotes', width: 30 },
    { header: 'price_original', key: 'priceOriginal', width: 12 }, { header: 'price', key: 'price', width: 12, style: { numFmt: '#,##0' } }, { header: 'price_rule', key: 'priceRule', width: 14 },
    { header: 'phone_original', key: 'phoneOriginal', width: 16, style: textStyle }, { header: 'phone', key: 'phone', width: 13, style: textStyle }, { header: 'phone_rule', key: 'phoneRule', width: 20 },
    { header: 'service_label', key: 'serviceLabel', width: 11 }, { header: 'service_type', key: 'serviceType', width: 11 }, { header: 'service_type_id', key: 'serviceTypeId', width: 9 },
    { header: 'duplicate_of_row', key: 'duplicateOf', width: 10 }, { header: 'formatting_issues', key: 'formatIssues', width: 50 },
  ]);
  for (const rec of selected) {
    const v = (f) => rec.cells[col[f] - 1];
    formatted.addRow({
      row: rec.row, result: rec.issues.length ? 'failed' : 'processed', processedRow: rec.processedRow ?? null, status: rec.status,
      dateOriginal: showDate(v('date')), timeOriginal: v('time') == null ? '' : String(v('time')).trim(), yearCorrection: rec.yearCorrection ?? '', timeRule: rec.timeRule,
      local: rec.movedAtLocal ?? '', utc: rec.movedAt ?? null, timestampFrom: rec.timestampFrom ?? null,
      addressRaw: rec.addressRaw?.replace(/\s+/g, ' ').trim() ?? '', origin: rec.origin ?? '', destination: rec.destination ?? '', splitRule: rec.splitRule, removedNotes: rec.removedNotes,
      priceOriginal: v('price') ?? '', price: rec.price ?? null, priceRule: rec.priceRule,
      phoneOriginal: v('phone') == null ? '' : String(v('phone')), phone: rec.phone ?? '', phoneRule: rec.phoneRule,
      serviceLabel: v('service') ?? '', serviceType: rec.service?.name ?? '', serviceTypeId: rec.service?.id ?? null,
      duplicateOf: rec.duplicateOf ?? null,
      formatIssues: rec.issues.filter((i) => !['geocoding', 'ward matching', 'distance', 'schema', 'foreign key', 'duplicate'].includes(i.stage)).map((i) => i.reason).join('; '),
    });
  }

  // Exactly the importable columns of the moves table, in table order; the source row is in Formatted Data
  const processedSheet = addSheet(SHEETS[2], columns.map((c) => ({
    header: c.name, key: c.name, width: { origin_address: 45, destination_address: 45, moved_at: 20 }[c.name] ?? 14,
    style: c.type === 'datetime' ? dateTimeStyle : c.type === 'varchar' && c.name === 'phone' ? textStyle : undefined,
  })));
  for (const rec of processed) processedSheet.addRow(rec.values);

  const failedSheet = workbook.addWorksheet(SHEETS[3], { views: [{ state: 'frozen', ySplit: 1 }] });
  const failedHeader = [...headerCells.map((h) => h ?? ''), 'source_row', 'error_type', 'failure_stages', 'failed_fields', 'failure_reasons', 'diagnostics'];
  failedSheet.addRow(failedHeader);
  for (const rec of failed) {
    const temporary = rec.issues.some((i) => i.temporary);
    const permanent = rec.issues.some((i) => !i.temporary);
    failedSheet.addRow([...rec.cells.map((c) => (c instanceof Date || typeof c !== 'object' ? c : String(c))), rec.row,
      permanent && temporary ? 'permanent + temporary' : temporary ? 'temporary (retry)' : 'permanent',
      [...new Set(rec.issues.map((i) => i.stage))].join('; '), [...new Set(rec.issues.map((i) => i.field))].join('; '),
      rec.issues.map((i) => i.reason).join('\n'), rec.issues.map((i) => i.diagnostic).filter(Boolean).join('\n')]);
  }
  failedSheet.getRow(1).font = { bold: true };
  failedSheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8E1E1' } };
  failedHeader.forEach((h, i) => { failedSheet.getColumn(i + 1).width = i < headerCells.length ? source.getColumn(i + 1).width ?? 14 : [10, 18, 24, 24, 70, 50][i - headerCells.length]; });
  if (col.date) failedSheet.getColumn(col.date).numFmt = 'dd/mm/yyyy';
  if (col.phone) failedSheet.getColumn(col.phone).numFmt = '@';
  fixRowHeight(failedSheet);
  for (const sheet of [formatted, processedSheet, failedSheet]) sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };

  // Written next to the target and renamed, so a failed write never leaves a half-written workbook
  const tmp = `${args.out}.tmp-${process.pid}.xlsx`;
  try {
    await workbook.xlsx.writeFile(tmp);
    renameSync(tmp, args.out);
  } catch (error) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    if (error.code === 'EBUSY' || error.code === 'EPERM') throw new Error(`Cannot write ${args.out}: it is open in Excel. Close it and run again (Google answers are cached, nothing is asked twice).`);
    throw error;
  }

  // ---------- verify by reopening ----------
  const check = new ExcelJS.Workbook();
  await check.xlsx.readFile(args.out);
  const names = check.worksheets.map((s) => s.name);
  const problems = [];
  if (JSON.stringify(names) !== JSON.stringify(SHEETS)) problems.push(`sheets are ${names.join(', ')}`);
  const count = (name) => check.getWorksheet(name).actualRowCount - 1;
  if (check.getWorksheet(SHEETS[0]).rowCount !== source.rowCount) problems.push('Original Data row count differs from the source');
  if (count(SHEETS[1]) !== selected.length) problems.push(`Formatted Data has ${count(SHEETS[1])} rows, expected ${selected.length}`);
  if (count(SHEETS[2]) !== processed.length) problems.push(`Processed Data has ${count(SHEETS[2])} rows, expected ${processed.length}`);
  if (count(SHEETS[3]) !== failed.length) problems.push(`Failed Rows has ${count(SHEETS[3])} rows, expected ${failed.length}`);
  if (processed.length + failed.length !== selected.length) problems.push('processed + failed does not add up to the records');
  const header = check.getWorksheet(SHEETS[2]).getRow(1).values.slice(1);
  if (JSON.stringify(header) !== JSON.stringify(columns.map((c) => c.name))) problems.push(`Processed Data header is ${header.join(',')}`);
  check.getWorksheet(SHEETS[2]).eachRow((row, r) => {
    if (r === 1) return;
    columns.forEach((c, i) => {
      const value = row.getCell(i + 1).value;
      const ok = c.type === 'datetime' ? value instanceof Date : c.type === 'int' ? Number.isInteger(value) : value === null || typeof value === 'string';
      if (!ok) problems.push(`Processed Data row ${r} ${c.name}: ${JSON.stringify(value)}`);
    });
  });

  // ---------- log, report, summary ----------
  const counter = (list) => list.reduce((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {});
  const issues = failed.flatMap((r) => r.issues);
  const summary = {
    input: args.input, output: args.out, database: `${schema.database} (${schema.source})`, mode: args.cacheOnly ? 'cache-only' : 'live',
    sourceRows: source.rowCount - 1, records: records.length, nonRecordRows: nonRecords.map((n) => `${n.row} (${n.why})`),
    selected: selected.length, processed: processed.length, failed: failed.length,
    failedPermanentOnly: failed.filter((r) => r.issues.every((i) => !i.temporary)).length,
    failedTemporary: failed.filter((r) => r.issues.some((i) => i.temporary)).length,
    yearsCorrected: selected.filter((r) => r.yearCorrection).length,
    phonesInferred: selected.filter((r) => r.phoneFrom).length,
    timestampsInferred: selected.filter((r) => r.timestampFrom).length,
    uniquePickupAddresses: new Set(selected.map((r) => r.origin).filter(Boolean)).size,
    uniqueDropoffAddresses: new Set(selected.map((r) => r.destination).filter(Boolean)).size,
    googleAutocompleteRequests: google.stats.autocomplete, googleRouteRequests: google.stats.routes, cacheHits: google.stats.cacheHits,
    cacheMisses: google.stats.misses, retryableApiErrors: google.stats.retryableErrors, permanentApiErrors: google.stats.permanentErrors, apiRetries: google.stats.retries,
    expiredCacheEntriesDropped: google.stats.expired,
    unmappedWards: selected.flatMap((r) => [r.originLookup, r.destinationLookup]).filter((l) => l && !l.ward).length,
    unmappedServiceTypes: issues.filter((i) => i.stage === 'service type').length,
    invalidPrices: issues.filter((i) => i.stage === 'price').length,
    duplicatesKept: selected.filter((r) => r.duplicateOf).length,
    failuresByStage: counter(issues.map((i) => i.stage)),
    wardStatuses: counter(selected.flatMap((r) => [r.originLookup?.status, r.destinationLookup?.status]).filter(Boolean)),
    verification: problems.length ? problems : 'ok: 4 sheets in order, row counts and Processed Data columns/types checked after reopening',
    durationSeconds: Math.round((Date.now() - started) / 1000),
  };
  // One log file next to the workbook, overwritten by the next run of the same input: the summary on the first
  // line, then every event, then Google's answer for each address looked up (query, status, answer, ward, place id)
  for (const rec of toLookUp) {
    for (const side of ['origin', 'destination']) {
      const l = rec[`${side}Lookup`];
      log.push({ row: rec.row, stage: 'google', event: 'answer', side, address: rec[side], query: l.searched, status: l.status,
        google: l.google ?? l.error, wardId: l.ward?.id, ward: l.ward?.name, placeId: l.placeId, distance: rec.distance });
    }
  }
  const logFile = args.out.replace(/\.xlsx$/i, '.log.jsonl');
  writeFileSync(logFile, [{ summary }, ...log].map((e) => JSON.stringify(e)).join('\n') + '\n');
  // Files of the earlier layout (one log / report / summary per run, timestamped)
  for (const old of readdirSync(OUTPUT_DIR)) {
    if (/^process-(?:log|report|summary)-/.test(old)) try { rmSync(path.join(OUTPUT_DIR, old)); } catch { /* open elsewhere */ }
  }

  console.log(JSON.stringify(summary, null, 2));
  console.log(`workbook: ${args.out}\nlog: ${logFile}`);
  if (problems.length) { console.error('VERIFICATION FAILED'); process.exitCode = 1; }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
