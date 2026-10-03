// Lists the addresses whose ward cell is still empty, with the reason from the latest lookup report and a
// "Phường điền vào" column (dropdown of the 126 wards) for filling by hand.
//
//   pnpm missing [--file <xlsx>]   → output/dia-chi-chua-co-phuong.xlsx
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { WARD_REASON } from './reasons.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = path.join(ROOT, 'output');
const OUT_FILE = path.join(OUTPUT_DIR, 'dia-chi-chua-co-phuong.xlsx');
const fileArg = process.argv.indexOf('--file');
const WORKBOOK = fileArg > 0 ? process.argv[fileArg + 1] : path.join(ROOT, 'input', 'moves-2026-09-processed.xlsx');

const REASON = WARD_REASON;

const reports = readdirSync(OUTPUT_DIR).filter((f) => /^ward-lookup-report-\d{4}-\d\d-\d\dT[\d-]+\.csv$/.test(f)).sort();
const latest = reports.at(-1);
const result = new Map(latest ? readFileSync(path.join(OUTPUT_DIR, latest), 'utf8').split(/\r?\n/).slice(1).filter(Boolean)
  .map((l) => [...l.matchAll(/"((?:[^"]|"")*)"/g)].map((m) => m[1].replace(/""/g, '"')))
  .map((c) => [`${c[0]} ${c[2]}`, { query: c[4], status: c[5], google: c[6] }]) : []);

const wards = JSON.parse(readFileSync(path.join(ROOT, 'data', 'wards.json'), 'utf8'));
const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(WORKBOOK);
const moves = wb.getWorksheet('moves');
const col = new Map();
moves.getRow(1).eachCell((c, i) => col.set(String(c.value).trim(), i));
const byAddress = new Map();
moves.eachRow((row, r) => {
  if (r === 1) return;
  for (const side of ['origin', 'destination']) {
    const address = String(row.getCell(col.get(`${side}_address`)).value ?? '').trim();
    const ward = row.getCell(col.get(`${side}_ward_id`)).value;
    if (!address || (ward !== null && ward !== '')) continue;
    const entry = byAddress.get(address) ?? { rows: [], status: null, query: '', google: '' };
    entry.rows.push(`${r}${side === 'origin' ? 'o' : 'd'}`);
    if (!entry.status) Object.assign(entry, result.get(`${r} ${side}`) ?? {});
    byAddress.set(address, entry);
  }
});

const out = new ExcelJS.Workbook();
const sheet = out.addWorksheet('chua-co-phuong');
const list = out.addWorksheet('phuong-xa');
list.columns = [{ header: 'name', key: 'name', width: 34 }, { header: 'id', key: 'id', width: 6 }, { header: 'code', key: 'code', width: 8 }];
for (const w of wards) list.addRow(w);
list.getRow(1).font = { bold: true };

sheet.columns = [
  { header: 'Địa chỉ', key: 'address', width: 55 },
  { header: 'Phường điền vào', key: 'fill', width: 30 },
  { header: 'Lý do chưa có phường', key: 'reason', width: 55 },
  { header: 'Mã lý do', key: 'status', width: 16 },
  { header: 'Query đã gửi', key: 'query', width: 38 },
  { header: 'Google trả về', key: 'google', width: 60 },
  { header: 'Số lần', key: 'count', width: 8 },
  { header: 'Dòng Excel (o=origin, d=destination)', key: 'rows', width: 26 },
];
const order = Object.keys(REASON);
const sorted = [...byAddress].sort((a, b) => order.indexOf(a[1].status) - order.indexOf(b[1].status)
  || b[1].rows.length - a[1].rows.length || a[0].localeCompare(b[0], 'vi'));
for (const [address, e] of sorted) {
  sheet.addRow({ address, fill: '', reason: REASON[e.status] ?? 'Chưa chạy tra cứu', status: e.status ?? '', query: e.query, google: e.google, count: e.rows.length, rows: e.rows.join(', ') });
}
for (let r = 2; r <= sheet.rowCount; r++) {
  const cell = sheet.getCell(`B${r}`);
  cell.dataValidation = {
    type: 'list', allowBlank: true, formulae: [`'phuong-xa'!$A$2:$A$${wards.length + 1}`],
    showErrorMessage: true, errorTitle: 'Phường không hợp lệ', error: 'Chọn một phường/xã trong danh sách',
  };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
}
sheet.getRow(1).font = { bold: true };
sheet.getCell('B1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFD966' } };
sheet.views = [{ state: 'frozen', ySplit: 1 }];
sheet.autoFilter = 'A1:H1';
for (const s of out.worksheets) s.properties.defaultRowHeight = 15; // see the exceljs defaultRowHeight note in lookup-wards.mjs
await out.xlsx.writeFile(OUT_FILE);

const cells = sorted.reduce((n, [, e]) => n + e.rows.length, 0);
const byReason = sorted.reduce((m, [, e]) => ((m[e.status ?? '?'] = (m[e.status ?? '?'] ?? 0) + e.rows.length), m), {});
console.log(`${sorted.length} addresses, ${cells} empty cells (reasons from ${latest ?? 'no report'})`, byReason);
console.log(`file: ${OUT_FILE}`);
