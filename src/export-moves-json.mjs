// Turns the moves sheet into the JSON that hanoi-moving-insights-api imports (`pnpm db:import-moves`), keeping
// only the columns of the `moves` table. Wards go out as their official code and service types as their name,
// so the file does not depend on database ids.
//
//   pnpm export-json [--file <xlsx>] [--out <json>]   → output/moves-db.json
//
// Every record is checked against the same rules as the API (lengths, integers, non-negative values) and the
// export stops on the first problem list, so the import never runs on a file it would reject.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DEFAULT_JSON = path.join(ROOT, 'output', 'moves-db.json');

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const WORKBOOK = arg('--file') ?? path.join(ROOT, 'input', 'moves-2026-09-processed.xlsx');
const OUT = arg('--out') ?? DEFAULT_JSON;
const MYSQL_INT_MAX = 2_147_483_647;

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(WORKBOOK);
const sheet = (name) => {
  const s = wb.getWorksheet(name);
  if (!s) throw new Error(`The workbook needs a "${name}" sheet`);
  return s;
};
/** Rows of a sheet as objects keyed by the header row */
const rowsOf = (s) => {
  const header = [];
  s.getRow(1).eachCell((cell, col) => { header[col] = String(cell.value).trim(); });
  const rows = [];
  s.eachRow((row, r) => {
    if (r === 1) return;
    const record = { excelRow: r };
    header.forEach((name, col) => { if (name) record[name] = row.getCell(col).value; });
    rows.push(record);
  });
  return rows;
};

// The workbook's own lookup sheets give id → code / name
const wardCodeById = new Map(rowsOf(sheet('wards')).map((w) => [Number(w.id), String(w.code)]));
const serviceTypeById = new Map(rowsOf(sheet('service_types')).map((t) => [Number(t.id), String(t.name)]));

/** "2026-08-31 23:00:00" (UTC, see moved_at_local = +7 h) → "2026-08-31T23:00:00Z" */
function isoUtc(value) {
  if (value instanceof Date) return value.toISOString().replace('.000Z', 'Z');
  const m = String(value ?? '').trim().match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})(:\d{2})?$/);
  return m ? `${m[1]}T${m[2]}${m[3] ?? ':00'}Z` : null;
}
const text = (value) => (value === null || value === undefined ? '' : String(value).normalize('NFC').replace(/\s+/g, ' ').trim());
const isInt = (n) => Number.isInteger(n) && n >= 0 && n <= MYSQL_INT_MAX;

const errors = [];
const records = [];
for (const row of rowsOf(sheet('moves'))) {
  const where = `Excel row ${row.excelRow} (source_row ${row.source_row})`;
  const problem = (message) => errors.push(`${where}: ${message}`);
  const sourceRow = Number(row.source_row);
  if (!Number.isInteger(sourceRow) || sourceRow <= 0) problem('source_row is not a positive integer');

  const movedAt = isoUtc(row.moved_at);
  if (!movedAt || Number.isNaN(Date.parse(movedAt))) problem(`moved_at "${row.moved_at}" is not "YYYY-MM-DD HH:MM[:SS]"`);

  const originAddress = text(row.origin_address);
  const destinationAddress = text(row.destination_address);
  for (const [name, value] of [['origin_address', originAddress], ['destination_address', destinationAddress]]) {
    if (!value) problem(`${name} is empty`);
    if (value.length > 500) problem(`${name} is longer than 500 characters`);
  }

  const wardCode = (name) => {
    const id = row[name];
    if (id === null || id === undefined || id === '') return null; // the API accepts an unidentified ward
    const code = wardCodeById.get(Number(id));
    if (!code) problem(`${name} ${id} is not in the wards sheet`);
    return code ?? null;
  };
  const originWardCode = wardCode('origin_ward_id');
  const destinationWardCode = wardCode('destination_ward_id');

  const serviceType = serviceTypeById.get(Number(row.service_type_id));
  if (!serviceType) problem(`service_type_id ${row.service_type_id} is not in the service_types sheet`);

  const price = Number(row.price);
  if (!isInt(price)) problem(`price "${row.price}" is not a non-negative integer`);
  const distance = row.distance === null || row.distance === undefined || row.distance === '' ? null : Number(row.distance);
  if (distance !== null && !isInt(distance)) problem(`distance "${row.distance}" is not a non-negative integer (metres)`);

  const phone = text(row.phone) || null;
  if (phone && phone.length > 100) problem('phone is longer than 100 characters');

  records.push({ sourceRow, movedAt, originAddress, destinationAddress, originWardCode, destinationWardCode, serviceType, price, phone, distance });
}

const duplicates = records.map((r) => r.sourceRow).filter((n, i, all) => all.indexOf(n) !== i);
if (duplicates.length) errors.push(`source_row used more than once: ${[...new Set(duplicates)].join(', ')}`);

if (errors.length) {
  console.error(`${errors.length} problem(s), no JSON written:\n${errors.join('\n')}`);
  process.exit(1);
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(records, null, 2)}\n`);
const count = (pick) => records.reduce((m, r) => ((m[pick(r)] = (m[pick(r)] ?? 0) + 1), m), {});
console.log(`${records.length} moves → ${OUT}`);
console.log('service types:', count((r) => r.serviceType));
console.log(`without ward: origin ${records.filter((r) => !r.originWardCode).length}, destination ${records.filter((r) => !r.destinationWardCode).length}; without distance: ${records.filter((r) => r.distance === null).length}`);
