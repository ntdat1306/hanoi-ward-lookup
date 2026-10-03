// Checks the whole moves sheet and lists every problem, spelling included, in output/kiem-tra-<time>.xlsx.
// No API calls: Google's answers are read from the cache filled by `pnpm lookup`.
//
//   pnpm check [--file <xlsx>]
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { buildQuery, fold, parseFormattedAddress, placeSearchText, sameStreetSpelling, streetsMatch } from './address.mjs';
import { OLD_DISTRICT_NAMES, loadOldWardIndex } from './old-wards.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIR = path.join(ROOT, 'output');
const fileArg = process.argv.indexOf('--file');
const WORKBOOK = fileArg > 0 ? process.argv[fileArg + 1] : path.join(ROOT, 'input', 'moves-2026-09-processed.xlsx');
const readJson = (file, fallback) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
const cache = readJson(path.join(ROOT, 'cache', 'places-cache.json'), {});
const wards = readJson(path.join(ROOT, 'data', 'wards.json'), []);
const overrides = readJson(path.join(ROOT, 'data', 'manual-overrides.json'), []);
const wardsById = new Map(wards.map((w) => [w.id, w]));

// Lowercase with diacritics, old tone placement made new ("Hoà" = "Hòa"), punctuation as spaces
const TONES = { 'oà': 'òa', 'oá': 'óa', 'oả': 'ỏa', 'oã': 'õa', 'oạ': 'ọa', 'uỳ': 'ùy', 'uý': 'úy', 'uỷ': 'ủy', 'uỹ': 'ũy', 'uỵ': 'ụy' };
const norm = (text) => String(text ?? '').normalize('NFC').toLowerCase().replace(/o[àáảãạ]|u[ỳýỷỹỵ]/gu, (m) => TONES[m])
  .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Known area names (current wards, old wards, old districts) to catch "Từ Liên" for "Từ Liêm"
const index = loadOldWardIndex();
const AREA_NAMES = new Map(); // normalised → as written
for (const name of [...wards.map((w) => w.name.replace(/^(?:Phường|Xã)\s+/u, '')), ...OLD_DISTRICT_NAMES]) AREA_NAMES.set(norm(name), name);
for (const key of index.names.keys()) if (!AREA_NAMES.has(key)) AREA_NAMES.set(key, key.replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase()));

function levenshtein(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return row[b.length];
}

/** Google's predictions cached for an address (street queries, retries and place searches) */
function predictionsFor(address) {
  const q = buildQuery(address);
  const place = placeSearchText(address);
  const texts = q ? [q.query, q.plainQuery].filter(Boolean) : [fold(place).includes('ha noi') ? place : `${place}, Hà Nội`];
  return texts.flatMap((t) => [cache[`ac:${t}`], cache[`acplain:${t}`]]).filter(Array.isArray).flat().map((p) => p.text).filter(Boolean);
}

// Words that say what kind of place it is: a near-miss on them is not a misspelt name ("Khu đô thị An Lạc" ≠ "Thọ An")
const GENERIC = new Set(['khu', 'đô', 'thị', 'mới', 'phố', 'đường', 'ngõ', 'ngách', 'hẻm', 'số', 'nhà', 'tòa', 'chung', 'cư', 'xã', 'phường',
  'quận', 'huyện', 'thôn', 'xóm', 'tổ', 'văn', 'hóa', 'trung', 'tâm', 'làng', 'cổng', 'chợ', 'trường', 'hà', 'nội']);

/** Problems of one address: [level, kind, detail, suggestion] */
function checkAddress(address) {
  const issues = [];
  const text = String(address ?? '').trim();
  if (!text) return [['Lỗi', 'Thiếu địa chỉ', 'Ô địa chỉ trống', '']];
  const predictions = predictionsFor(text);
  const googleStreets = predictions.map((p) => parseFormattedAddress(p).street).filter(Boolean);

  // Street spelling: the same street once diacritics are dropped, but written differently
  const q = buildQuery(text);
  // (not for a commune name, which Google sometimes misspells itself: "Xã Vĩnh Thạnh" for xã Vĩnh Thanh)
  if (q && googleStreets.length && !/^(?:xã|phường)\s/iu.test(q.street)) {
    const close = googleStreets.filter((s) => streetsMatch(q.street, s));
    if (close.length && !close.some((s) => sameStreetSpelling(q.street, s))) {
      issues.push(['Nghi ngờ', 'Sai chính tả tên đường', `"${q.street}" — Google viết "${close[0]}"`, close[0]]);
    }
  }

  // Area names one letter away from a known ward / old ward / district ("Từ Liên" → "Từ Liêm"), within one
  // comma-separated part. Skipped: words Google itself writes (a real name), and words of a name already right.
  const googleText = ` ${predictions.map(norm).join(' | ')} `;
  const flagged = new Set();
  for (const part of String(text).split(/[,+;.\-–>]/)) {
    const words = norm(part).split(' ').filter(Boolean);
    const taken = new Array(words.length).fill(false);
    for (const n of [3, 2, 1]) {
      for (let i = 0; i + n <= words.length; i++) {
        const gram = words.slice(i, i + n).join(' ');
        if (AREA_NAMES.has(gram) && n > 1) taken.fill(true, i, i + n);
      }
    }
    for (const n of [3, 2]) {
      for (let i = 0; i + n <= words.length; i++) {
        const span = words.slice(i, i + n);
        const gram = span.join(' ');
        if (gram.length < 6 || /\d/.test(gram) || taken.slice(i, i + n).some(Boolean) || span.some((w) => GENERIC.has(w))) continue;
        if (AREA_NAMES.has(gram) || googleText.includes(` ${gram} `) || flagged.has(gram)) continue;
        for (const [key, name] of AREA_NAMES) {
          if (key.split(' ').length !== n || Math.abs(key.length - gram.length) > 1 || levenshtein(gram, key) !== 1) continue;
          issues.push(['Nghi ngờ', 'Sai chính tả tên phường/khu', `"${gram}" — gần với "${name}"`, name]);
          flagged.add(gram);
          taken.fill(true, i, i + n);
          break;
        }
      }
    }
  }

  // Abbreviated or unaccented address words ("Ngo 139", "Ng Khánh Toàn", "Dg Mỹ Đình", "so nha")
  const bare = text.match(/(?<!\p{L})(?:ngo|ngach|hem)\s*\d+|(?<!\p{L})(?:ng|dg|đg)\.?\s+(?=\p{Lu})|(?<!\p{L})(?:duong|so nha|nha so)(?!\p{L})/giu);
  if (bare) issues.push(['Nghi ngờ', 'Viết tắt / không dấu', `"${[...new Set(bare.map((b) => b.trim()))].join('", "')}"`, '']);
  // Words stuck together ("Nhà SỐ6 NGÕ6", "15NGUYỄN Biểu", "ĐìnhThôn")
  const stuck = [...(text.match(/(?<!\p{L})(?:số|ngõ|ngách|nhà)\d+|\d+(?:nguyễn|phố|đường|ngõ|ngách)/giu) ?? []), ...(text.match(/\p{Ll}{2,}\p{Lu}\p{Ll}+/gu) ?? [])];
  if (stuck.length) issues.push(['Nghi ngờ', 'Viết dính chữ', `"${stuck.join('", "')}"`, '']);
  return issues;
}

/** A distance written in raw_text ("cách 300m", "(4km)", "38km"), in metres */
function statedDistance(raw) {
  const m = String(raw ?? '').match(/(?:cách|khoảng|tầm|chừng|xa)\s*(\d+(?:[.,]\d+)?)\s*(km|m)(?![\p{L}\d])|\(\s*(\d+(?:[.,]\d+)?)\s*(km|m)\s*\)|(\d+(?:[.,]\d+)?)\s*km(?![\p{L}\d])/iu);
  if (!m) return null;
  const value = Number((m[1] ?? m[3] ?? m[5]).replace(',', '.'));
  const unit = (m[2] ?? m[4] ?? 'km').toLowerCase();
  return Math.round(unit === 'km' ? value * 1000 : value);
}

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(WORKBOOK);
const moves = wb.getWorksheet('moves');
const col = new Map();
moves.getRow(1).eachCell((c, i) => col.set(String(c.value).trim(), i));

// Addresses whose spelling was corrected earlier (output/dia-chi-da-sua-*.xlsx), by their new text
const corrected = new Map();
for (const f of existsSync(OUTPUT_DIR) ? readdirSync(OUTPUT_DIR).filter((x) => /^dia-chi-da-sua-.*\.xlsx$/.test(x)) : []) {
  const fixed = new ExcelJS.Workbook();
  await fixed.xlsx.readFile(path.join(OUTPUT_DIR, f));
  fixed.worksheets[0].eachRow((row, r) => { if (r > 1) corrected.set(String(row.getCell(4).value), String(row.getCell(3).value)); });
}

const lines = [];
const add = (r, sourceRow, side, [level, kind, detail, suggestion], address) => lines.push({ row: r, sourceRow, side, level, kind, detail, address, suggestion });
moves.eachRow((row, r) => {
  if (r === 1) return;
  const get = (name) => row.getCell(col.get(name)).value;
  const sourceRow = get('source_row');
  for (const side of ['origin', 'destination']) {
    const label = side === 'origin' ? 'đi' : 'đến';
    const address = get(`${side}_address`);
    for (const issue of checkAddress(address)) add(r, sourceRow, label, issue, address);
    const ward = get(`${side}_ward_id`);
    if (ward === null || ward === '') add(r, sourceRow, label, ['Lỗi', 'Thiếu phường', 'Ô phường trống', ''], address);
    else if (!wardsById.has(Number(ward))) add(r, sourceRow, label, ['Lỗi', 'Phường không hợp lệ', `id ${ward} không có trong 126 phường/xã`, ''], address);
    if (corrected.has(String(address))) add(r, sourceRow, label, ['Thông tin', 'Đã sửa chính tả', `Trước: "${corrected.get(String(address))}"`, ''], address);
    const o = overrides.find((x) => String(x.source_row) === String(sourceRow) && x.side === side);
    if (o) add(r, sourceRow, label, ['Thông tin', 'Đã sửa tay', o.note ?? '', o.ward ?? ''], address);
  }
  const a = get('origin_address');
  const d = get('destination_address');
  if (a && d && norm(a) === norm(d)) add(r, sourceRow, 'chuyến', ['Nghi ngờ', 'Điểm đi = điểm đến', 'Hai địa chỉ giống hệt', ''], `${a} → ${d}`);
  const distance = get('distance');
  const route = `${a} → ${d}`;
  if (distance === null || distance === '') add(r, sourceRow, 'chuyến', ['Lỗi', 'Thiếu quãng đường', 'Ô distance trống', ''], route);
  else {
    const metres = Number(distance);
    if (metres <= 10) add(r, sourceRow, 'chuyến', ['Nghi ngờ', 'Quãng đường rất ngắn', `${metres} m: hai điểm trùng nhau hoặc cùng ngõ/tòa`, ''], route);
    if (metres > 40000) add(r, sourceRow, 'chuyến', ['Nghi ngờ', 'Quãng đường rất xa', `${(metres / 1000).toFixed(1)} km`, ''], route);
    const stated = statedDistance(get('raw_text'));
    if (stated && Math.abs(metres - stated) > 1000 && (metres / stated > 2.5 || stated / metres > 2.5)) {
      add(r, sourceRow, 'chuyến', ['Nghi ngờ', 'Lệch quãng đường ghi trong raw_text', `raw_text ghi ${stated} m, tính ra ${metres} m`, String(stated)], route);
    }
  }
});

// Output: one sheet with every line, one with counts
const out = new ExcelJS.Workbook();
const sheet = out.addWorksheet('chi-tiet');
sheet.columns = [
  { header: 'Dòng Excel', key: 'row', width: 10 }, { header: 'source_row', key: 'sourceRow', width: 10 },
  { header: 'Điểm', key: 'side', width: 8 }, { header: 'Mức', key: 'level', width: 10 },
  { header: 'Loại', key: 'kind', width: 32 }, { header: 'Chi tiết', key: 'detail', width: 70 },
  { header: 'Địa chỉ', key: 'address', width: 60 }, { header: 'Gợi ý', key: 'suggestion', width: 24 },
];
const levelOrder = { 'Lỗi': 0, 'Nghi ngờ': 1, 'Thông tin': 2 };
for (const line of lines.sort((x, y) => levelOrder[x.level] - levelOrder[y.level] || x.kind.localeCompare(y.kind, 'vi') || x.row - y.row)) sheet.addRow(line);
sheet.getRow(1).font = { bold: true };
sheet.views = [{ state: 'frozen', ySplit: 1 }];
sheet.autoFilter = 'A1:H1';
const summary = out.addWorksheet('tong-hop');
summary.columns = [{ header: 'Mức', key: 'level', width: 12 }, { header: 'Loại', key: 'kind', width: 36 }, { header: 'Số dòng', key: 'count', width: 10 }];
const counts = new Map();
for (const l of lines) counts.set(`${l.level}|${l.kind}`, (counts.get(`${l.level}|${l.kind}`) ?? 0) + 1);
for (const [key, count] of [...counts].sort((a, b) => levelOrder[a[0].split('|')[0]] - levelOrder[b[0].split('|')[0]] || b[1] - a[1])) {
  const [level, kind] = key.split('|');
  summary.addRow({ level, kind, count });
}
summary.getRow(1).font = { bold: true };
for (const s of out.worksheets) s.properties.defaultRowHeight = 15; // see the exceljs defaultRowHeight note in lookup-wards.mjs

mkdirSync(OUTPUT_DIR, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const file = path.join(OUTPUT_DIR, `kiem-tra-${stamp}.xlsx`);
await out.xlsx.writeFile(file);
for (const old of readdirSync(OUTPUT_DIR)) {
  if (!/^kiem-tra-.+\.xlsx$/.test(old) || old.includes(stamp)) continue;
  try { rmSync(path.join(OUTPUT_DIR, old)); } catch { /* open in Excel */ }
}
console.log(`moves: ${moves.rowCount - 1}, lines: ${lines.length}`);
for (const [key, count] of counts) console.log(`  ${key.replace('|', ': ')}: ${count}`);
console.log(`file: ${file}`);
