// Rules for the raw order sheet (data.xlsx: "Thời gian", "Điểm đón và trả hàng", "Đơn Giá", "SĐT", "Loại DV"…), ported
// from the scripts that built moves-2026-09-processed.xlsx and tightened. Pure functions: no I/O, no Google.
//
// Every function returns { value, … } plus what it did (rule / note), so the pipeline can log each transformation;
// a value it cannot read confidently comes back as { value: null, error } instead of a guess.
import { fold } from './address.mjs';

// ---------- header ----------
const HEADER_KEYS = {
  date: 'thoi gian', // the first "Thời gian" is the date, the second the time of day
  address: 'diem don va tra hang',
  price: 'don gia',
  phone: 'sdt',
  status: 'tinh trang',
  service: 'loai dv',
};

/** Column numbers (1-based) of the fields used, from the header cells. Throws when one is missing */
export function findColumns(headerCells) {
  const keys = headerCells.map((h) => fold(h ?? '').replace(/[^a-z0-9 ]/g, '').trim());
  const at = (key) => keys.findIndex((k) => k === key) + 1;
  const col = Object.fromEntries(Object.entries(HEADER_KEYS).map(([name, key]) => [name, at(key)]));
  col.time = keys.lastIndexOf(HEADER_KEYS.date) + 1;
  const missing = Object.entries(col).filter(([name, c]) => c === 0 && name !== 'status').map(([name]) => name);
  if (col.time === col.date) missing.push('time (second "Thời gian" column)');
  if (missing.length) throw new Error(`Columns not found in the header: ${missing.join(', ')}`);
  return col;
}

// ---------- date & time ----------
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
export const HANOI_OFFSET_HOURS = 7;

/**
 * Typo years fixed to 2026, as the user asked: 2036 / 2046, and 3026 (also fixed in the September file, confirmed again
 * for October). Any other unexpected year is only flagged
 */
export const YEAR_TYPOS = { 2036: 2026, 2046: 2026, 3026: 2026 };

/**
 * Calendar date of the date cell: { year, month, day } as written (no timezone: exceljs gives date cells as UTC
 * midnight, so only the getUTC* parts are read). Accepts a Date, an Excel serial and "dd/mm/yyyy" / "yyyy-mm-dd" text.
 */
export function readDate(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return { value: null, error: 'missing' };
  let y, m, d;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return { value: null, error: 'invalid date' };
    [y, m, d] = [value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate()];
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 1 || value > 2958465) return { value: null, error: `invalid Excel date ${value}` };
    const date = new Date(EXCEL_EPOCH_MS + Math.round(value * 86400) * 1000);
    [y, m, d] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
  } else {
    const text = String(value).trim();
    const dmy = text.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
    const ymd = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (dmy) [y, m, d] = [+dmy[3], +dmy[2], +dmy[1]];
    else if (ymd) [y, m, d] = [+ymd[1], +ymd[2], +ymd[3]];
    else return { value: null, error: `unreadable date "${text}"` };
    const check = new Date(Date.UTC(y, m - 1, d));
    if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return { value: null, error: `invalid date "${text}"` };
  }
  return { value: { year: y, month: m, day: d } };
}

/**
 * Year check, before the timezone conversion: 2036 / 2046 → 2026 (only the year changes); any other year outside
 * `expectedYears` is an error for review, never corrected silently.
 */
export function correctYear(date, expectedYears = [2026]) {
  if (YEAR_TYPOS[date.year]) return { value: { ...date, year: YEAR_TYPOS[date.year] }, corrected: { from: date.year, to: YEAR_TYPOS[date.year] } };
  if (!expectedYears.includes(date.year)) return { value: null, error: `suspicious year ${date.year} (expected ${expectedYears.join('/')}; only ${Object.keys(YEAR_TYPOS).join(', ')} are corrected)` };
  return { value: date };
}

/**
 * Time of day from the free-text column: "8h", "14h30p", "15g30", "8h30-45p sáng" (a range → its start),
 * "14-15h" (start), "7h tối" (+12). The note after the time ("( tải 5 tạ )") is ignored.
 * "mai" (tomorrow) keeps the row's own date, as decided for the September file (rows are in move-date order).
 */
export function parseTime(text) {
  if (text === null || text === undefined || !String(text).trim()) return { value: null, error: 'missing' };
  const t = String(text).toLowerCase().normalize('NFC');
  // Only a note, no time at all ("( bác tài hỗ trợ … )", "báo sau"): the time is missing
  if (!/\d/.test(t)) return { value: null, error: 'missing', notes: [`time column holds no time: "${String(text).trim()}"`] };
  // "14-15h" first: the general pattern would read its end ("15h")
  // (not the minutes of "16h30-17h")
  const range = t.match(/(?<![\dhg:])(\d{1,2})\s*-\s*\d{1,2}\s*[hg](?!\p{L})/u);
  const m = range ? null : t.match(/(?<!\d)(\d{1,2})\s*[hg:]\s*(\d{1,2})?/u);
  let hour;
  let minute;
  let rule = 'time';
  if (range) { hour = +range[1]; minute = 0; } else if (m) { hour = +m[1]; minute = m[2] ? +m[2] : 0; } else return { value: null, error: `unreadable time "${String(text).trim()}"` };
  if (range || /(?<!\d)\d{1,2}\s*[hg:]\s*\d{0,2}\s*p?\s*-\s*\d/u.test(t)) rule = 'range start';
  if (/chiều|tối/u.test(t) && hour < 12) { hour += 12; rule += ', afternoon/evening +12h'; }
  if (hour > 23 || minute > 59) return { value: null, error: `invalid time "${String(text).trim()}"` };
  const notes = [];
  if (/(?<!\p{L})mai(?!\p{L})/u.test(t)) notes.push('says "mai" (tomorrow): the row date is kept');
  return { value: { hour, minute }, rule, notes };
}

/** Hà Nội wall-clock date + time → UTC instant (Hà Nội is UTC+7 all year, no daylight saving) */
export function hanoiToUtc({ year, month, day }, { hour, minute }) {
  return new Date(Date.UTC(year, month - 1, day, hour - HANOI_OFFSET_HOURS, minute));
}

const pad = (n) => String(n).padStart(2, '0');
export const formatLocal = (date, time) => `${date.year}-${pad(date.month)}-${pad(date.day)}${time ? ` ${pad(time.hour)}:${pad(time.minute)}` : ''}`;

// ---------- price ----------
/** Prices under this are read as a typo for thousands ("200" for 200.000 đ) and sent for review */
export const MIN_PRICE = 10_000;

/**
 * Price in VND, an integer. Numbers stay as they are; text accepts "1.500.000", "1,500,000", "1 500 000 đ",
 * the shorthand "280k" (= 280.000) and "1tr5" / "3tr2" / "1tr" (= 1.500.000 / 3.200.000 / 1.000.000).
 * A decimal ("200.50"), anything else, or less than MIN_PRICE is an error: nothing is rounded or guessed.
 */
export function parsePrice(value) {
  if (value === null || value === undefined || (typeof value === 'string' && !value.trim())) return { value: null, error: 'missing' };
  let n;
  let rule = 'number';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) return { value: null, error: `not a whole number of đồng: ${value}` };
    n = value;
  } else {
    const t = String(value).trim().toLowerCase().replace(/\s+/g, '').replace(/(vnđ|vnd|đồng|đ)$/u, '');
    let m;
    if (/^\d+$/.test(t)) n = Number(t);
    else if (/^\d{1,3}(\.\d{3})+$/.test(t)) { n = Number(t.replace(/\./g, '')); rule = 'thousands separators'; } else if (/^\d{1,3}(,\d{3})+$/.test(t)) { n = Number(t.replace(/,/g, '')); rule = 'thousands separators'; } else if ((m = t.match(/^(\d+)k$/))) { n = Number(m[1]) * 1000; rule = '"k" = thousand'; } else if ((m = t.match(/^(\d+)tr(\d{0,3})$/))) {
      // "1tr5" = 1.5 million, "1tr25" = 1.25 million: the digits after "tr" are the fraction of a million
      n = Number(m[1]) * 1_000_000 + (m[2] ? Math.round(Number(`0.${m[2]}`) * 1_000_000) : 0);
      rule = '"tr" = million';
    } else return { value: null, error: `unreadable price "${String(value).trim()}"` };
  }
  if (n < 0) return { value: null, error: `negative price ${n}` };
  if (n < MIN_PRICE) return { value: null, error: `price ${n} đ is implausibly low (thousands typed without "000"?)` };
  if (n > 2_147_483_647) return { value: null, error: `price ${n} exceeds the database INT range` };
  return { value: n, rule };
}

// ---------- phone ----------
const PHONE = /^0\d{9}$/;

/**
 * The customer phone, "0xxxxxxxxx". As decided for the September file, a cell with two numbers ("đón: 09… - trả:
 * 03…") keeps the first; a 9-digit number Excel stripped of its leading 0 gets it back; +84 / 84 become 0.
 */
export function parsePhone(value) {
  if (value === null || value === undefined || !String(value).trim()) return { value: null, error: 'missing' };
  const raw = typeof value === 'number' ? String(Math.trunc(value)) : String(value).trim();
  const notes = [];
  const compact = raw.replace(/[\s.\-()]/g, '');
  if (/^[1-9]\d{8}$/.test(compact)) return { value: `0${compact}`, rule: 'leading 0 restored' };
  if (/^(?:\+?84)\d{9}$/.test(compact)) return { value: `0${compact.replace(/^\+?84/, '')}`, rule: '+84 → 0' };
  const numbers = (raw.match(/(?:\+?84|0)[\d .]{8,14}\d/g) ?? []).map((n) => n.replace(/\D/g, '').replace(/^84/, '0'));
  if (numbers.length === 0) return { value: null, error: `unreadable phone "${raw}"` };
  const first = numbers[0].slice(0, 10);
  if (!PHONE.test(first)) return { value: null, error: `invalid phone "${raw}"` };
  if (numbers.length > 1) notes.push('two numbers: the first is kept');
  return { value: first, rule: numbers.length > 1 ? 'first of two' : PHONE.test(compact) ? 'as entered' : 'cleaned', notes };
}

// ---------- service type ----------
/** Labels of the "Loại DV" column → service_types.name in the database */
export const SERVICE_LABELS = { 'ba gac': 'Ba gác', tai: 'Xe tải', 'xe tai': 'Xe tải', 'tron goi': 'Trọn gói' };

export function mapService(label, serviceTypeIdByName) {
  if (label === null || label === undefined || !String(label).trim()) return { value: null, error: 'missing' };
  const key = fold(label).replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
  const name = SERVICE_LABELS[key];
  if (!name) return { value: null, error: `unknown service type "${String(label).trim()}"` };
  const id = serviceTypeIdByName.get(name);
  if (id === undefined) return { value: null, error: `service type "${name}" is not in the service_types table` };
  return { value: { id, name }, rule: String(label).trim() === name ? 'same name' : `"${String(label).trim()}" → "${name}"` };
}

// ---------- addresses ----------
const W = (alts) => new RegExp(`(?<!\\p{L})(?:${alts})(?!\\p{L})`, 'giu');

// Generic address words: lowercase, unless they continue a proper name ("Đình Thôn", "Xã Đàn")
const ALWAYS_LOWER = new Set('và của ở tại gần cạnh đối diện trong'.split(' '));
const GENERIC = new Set('ngã dự án cơ sở số nhà ngõ ngách hẻm đường phố phường quận huyện xã tổ thôn xóm khu tập thể chung cư tòa tầng căn phòng lô dãy sảnh cổng đối diện gần cạnh và của ở tại trong cụm liền kề'.split(' '));
const GENERIC_PHRASES = W('khu đô thị mới|khu đô thị|đô thị mới|ký túc xá|thị trấn|bến xe|ngã ba|ngã tư|ngã năm|khu tập thể|chung cư|tổ dân phố|đơn nguyên');

const TYPOS = [
  [W('đên'), 'đến'], [W('vè'), 'về'], [W('nghách|ngachs'), 'ngách'], [W('trung cư'), 'chung cư'], [W('điịh'), 'định'],
  [W('quốc tự giám'), 'quốc tử giám'], [W('cầy giấy'), 'cầu giấy'], [W('hoàn kiêm'), 'hoàn kiếm'],
  [W('khám thiên'), 'khâm thiên'], [W('cố nhuế'), 'cổ nhuế'], [W('ocean part'), 'ocean park'], [W('hoè'), 'hòe'], [W('trieu khuc'), 'triều khúc'], [W('vinhome'), 'Vinhomes'],
];
const ABBR = [
  [/(?<!\p{L})sn(?=\s*\d)/giu, 'số nhà '], [/(?<!\p{L})Ngh\.\s*/gu, 'ngách '], [/(?<!\p{L})Ng\.\s*/gu, 'ngõ '],
  [/(?<!\p{L})Đ\.\s*/gu, 'đường '], [/(?<!\p{L})P\.\s*/gu, 'phố '], [/(?<!\p{L})p\.\s*/gu, 'phường '],
  [W('kđt|kdt'), 'khu đô thị'], [W('cc'), 'chung cư'], [W('ktx|kí túc xá'), 'ký túc xá'], [/(?<!\p{L})ĐH(?!\p{L})/gu, 'Đại học'],
  [W('hđ'), 'Hà Đông'],
  [W('ocp'), 'Vinhomes Ocean Park'], [W('vin ?ocean ?park'), 'Vinhomes Ocean Park'],
  [W('vinsmart ?city|vinsmart|vin smart ?city|vinhomes smart ?city|smart ?city'), 'Vinhomes Smart City'],
  [W('toà'), 'tòa'], [W('hoà'), 'hòa'], [W('thuỷ'), 'thủy'], [W('thuỵ'), 'thụy'], [W('hoá'), 'hóa'],
];

/**
 * Removes notes that are never part of an address, before splitting, so arrows inside them don't confuse the split:
 * parentheses ("( t3-t3/xbg ok )", "(t28 -->t2 trong 1 tòa)"), "xbg ok", distances ("8km", "cách 300m"),
 * "hỗ trợ…", "dự trù…", "ạ". Returns the text and the removed pieces (kept for the log, never lost).
 */
export function precleanAddress(raw) {
  const removed = [];
  const cut = (t, re, by = ' ') => t.replace(re, (m) => { if (m.trim()) removed.push(m.trim()); return by; });
  let t = String(raw).normalize('NFC').replace(/\s+/g, ' ');
  for (const [re, v] of TYPOS) t = t.replace(re, v);
  // A number stuck to a name: "63Trần Quốc Vượng" (codes such as "15C1", "2a" stay)
  t = t.replace(/(\d)(?=\p{Lu}\p{Ll}{2,})/gu, '$1 ');
  let prev;
  do { prev = t; t = cut(t, /\([^()]*\)/g); } while (t !== prev); // nested/multiple parentheses
  t = cut(t, /\([^)]*$/g);
  t = cut(t, /\)\S*/g);
  t = cut(t, /\/?\s*(xbg|tải|ba gác|xe|hầm)\s*ok\b/giu);
  t = cut(t, /(?<!\p{L})(?:cách nhau |cách |đi )?(?:tầm |khoảng )?\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)?\s*(km|m)(?!\p{L})\.?/giu);
  // "và điểm trả là ..." is a pick-up/drop-off separator
  t = t.replace(/\s+và\s+(?=điểm trả)/giu, ' --> ');
  t = cut(t, /[,;.]?\s*(hỗ trợ|cần xe|bác tài|đón xe đỗ|xe đỗ)(?:(?!-{2,}|->|=>|>>).)*/giu);
  t = cut(t, /(?<!\p{L})ạ(?!\p{L})/gu);
  t = cut(t, /[,;./]?\s*(dự trù|lưu ý)(?:(?!-{2,}|->|=>|>>).)*/giu);
  return { text: t.replace(/\s+/g, ' ').trim(), removed };
}

const LEADING = /^\s*(?:hàng|đồ|\d+)\s*:\s*|^\s*là\s+|^\s*(?:đón|trả|điểm|lấy)\s*(?:hàng|đồ|\d+)?\s*(?:\(\s*\p{L}+\s*\))?\s*:\s*|^\s*(?:(?:chuyển|chở hàng|chở|trở|đi|vận chuyển xe máy)\s+)?từ\s*:?\s*|^\s*(?:ừ|đón ở|đón tại|đón|điểm đón(?: là ở| là)?|điểm nhận|điểm \d+|điểm lấy đồ|điểm lấy hàng|lấy hàng|lấy đồ|trở đến|địa chỉ|trả hàng (?:ở|tại)|trả (?:ở|tại|về)|trả|điểm trả(?: hàng)?(?: là)?|điểm đến(?: là)?|chuyển đến|chở đồ về|về đến|đến|về|sang|qua|tới|ra|đi|em ở)(?:\s*:\s*|\s+)/iu;
const TRAILING = /[\s,]+(?:qua|về|đến|sang|tới|đi|ra|trả|chuyển|đón)\s*$/iu;

const titleWord = (lw) => lw.charAt(0).toUpperCase() + lw.slice(1);

/**
 * One side, cleaned: leading labels ("đón:", "từ") and trailing separator words removed, abbreviations spelt out
 * ("kđt" → "khu đô thị", "sn 5" → "số nhà 5", "Ng." → "ngõ"), ", Hà Nội, Việt Nam" dropped, and Vietnamese
 * capitalization: proper names capitalized, generic words (số, ngõ, ngách, chung cư…) lowercase, codes uppercase
 * ("ct1a" → "CT1A"). House numbers, lanes, buildings and area names are all kept.
 */
export function cleanAddress(part) {
  if (!part) return null;
  let t = part;
  let prev;
  do { prev = t; t = t.replace(LEADING, '').replace(TRAILING, ''); } while (t !== prev);
  for (const [re, v] of ABBR) t = t.replace(re, v);
  t = t.replace(/\s*,\s*/g, ', ');
  t = t.replace(/,?\s*(?:tp\.?\s*)?(?:hà nội|hn|hnoi)?\s*,?\s*việt nam\s*$/iu, '')
    .replace(/,\s*(?:tp\.?\s*|thành phố\s*)?(?:hà nội|hn|hnoi)\s*$/iu, '')
    .replace(/\s+(?:hn|hnoi)\s*$/iu, '');
  t = t.replace(/[\s.,;:\-_/>=<]+$/u, '').replace(/^[\s.,;:\-_/>=<]+/u, '');

  let prevProper = false;
  t = t.split(' ').filter(Boolean).map((w) => {
    const m = w.match(/^(.*?)([,.;:]*)$/u);
    const core = m[1];
    const punct = m[2];
    const lw = core.toLowerCase();
    let out;
    if (/\d/.test(core) && /\p{L}/u.test(core)) { out = core.toUpperCase(); prevProper = false; } else if (/^\p{Lu}{2,5}$/u.test(core) && !GENERIC.has(lw)) { out = core; prevProper = true; } else if (/^\d/.test(core) || !/\p{L}/u.test(core)) { out = core; prevProper = false; } else if (ALWAYS_LOWER.has(lw)) { out = lw; prevProper = false; } else if (GENERIC.has(lw) && !prevProper) { out = lw; prevProper = false; } else { out = titleWord(lw); prevProper = true; }
    if (punct) prevProper = false;
    return out + punct;
  }).join(' ');
  t = t.replace(GENERIC_PHRASES, (x) => x.toLowerCase());

  // ", " between house number, ngách and ngõ
  t = t.replace(/(\d[\p{L}\d/]*)\s+(ngách|ngõ|hẻm)\s/gu, '$1, $2 ');
  t = t.replace(/\s*,\s*/g, ', ').replace(/(?:,\s*)+/g, ', ').replace(/\s{2,}/g, ' ').trim().replace(/^, |, $/g, '').replace(/\s+\.(?=\s|$)/g, '');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : null;
}

/**
 * Separators, strongest first. Arrows are unambiguous; with labels, words and dashes the text must split in exactly
 * two, otherwise the split is not confident (a word like "về" or "ra" may also sit inside a name).
 */
const SEPARATORS = [
  { rule: 'arrow', re: /\s*(?:<-+>|-{2,}\s*>?|->|=>|>>|—>?|–>?|-\s*>|>)\s*/u, multi: true },
  { rule: 'label', re: /\s*,?\s*(?:điểm trả\s*(?:hàng)?\s*(?:là)?\s*:?|trả hàng\s*(?:ở|tại)?\s*:?|trả\s+(?:ở|tại)\s*:?\s+|đến\s*:|trả\s*:|điểm đến\s*(?:là)?\s*:?|chuyển đến\s*:|điểm \d+\s*:?|trả\s+(?=\d|số|ngõ|ngách))\s*/iu },
  { rule: 'word', re: /\s+(?:đi đến|chuyển tới|chuyển đến|chuyển ra|chuyển sang|chở về|chuyển đồ đến|về đến|đến|tới|sang|về|qua|ra|vào|xuống|lên|với|đi)\s*,?\s+/iu },
  { rule: 'dash', re: /\s+-\s*|\s*-\s+|(?<=\p{L})-(?=\p{L}|\d)/u },
];
// Several stops: as decided for the September file, the pick-up keeps only its first point, the drop-off its last
const INNER = /\s*,?\s*(?:điểm trả\s*(?:là)?\s*:|trả\s*\d*\s*:|trả về|trả|về|đến\s*:?|và)\s+/iu;
const firstPoint = (p) => p.split(INNER)[0].trim() || p;
const lastPoint = (p) => {
  const x = p.split(new RegExp(INNER.source, 'giu')).map((v) => v.trim()).filter(Boolean);
  return x.length ? x[x.length - 1] : p;
};
const EMPTY_PART = /^(?:đi|trả|đến|điểm|đón)?\s*:?\s*$/iu;
// A side that only gives a distance ("—> 300m") or names no place at all
const HAS_PLACE = /\p{L}{2,}/u;

/**
 * Splits "Điểm đón và trả hàng" into pick-up and drop-off.
 * { origin, destination, rule, removed, notes } or { error } when the text cannot be split confidently.
 */
export function splitAddresses(raw) {
  if (raw === null || raw === undefined || !String(raw).trim()) return { error: 'missing address' };
  const { text, removed } = precleanAddress(raw);
  const notes = [];
  for (const { rule, re, multi } of SEPARATORS) {
    const parts = text.split(new RegExp(re.source, `${re.flags}g`)).map((p) => p.trim()).filter((p) => p && !EMPTY_PART.test(p));
    if (parts.length < 2) continue;
    if (parts.length > 2 && !multi) return { error: `ambiguous split: "${rule}" separator occurs ${parts.length - 1} times`, removed };
    if (parts.length > 2) notes.push(`${parts.length} stops: first kept as pick-up, last as drop-off`);
    const [o, d] = [firstPoint(parts[0]), lastPoint(parts.at(-1))];
    if (o !== parts[0] || d !== parts.at(-1)) notes.push('several points on one side: first pick-up / last drop-off kept');
    const origin = cleanAddress(o);
    const destination = cleanAddress(d);
    if (!origin || !HAS_PLACE.test(origin)) return { error: 'pick-up address is empty after cleanup', removed };
    if (!destination || !HAS_PLACE.test(destination)) return { error: 'drop-off address is missing (only a distance or nothing after the separator)', removed };
    if (origin.length > 500 || destination.length > 500) return { error: 'address longer than 500 characters', removed };
    return { origin, destination, rule, removed, notes };
  }
  return { error: removed.some((r) => /\d\s*(km|m)\b/iu.test(r)) ? 'only one address (the other side is only a distance)' : 'only one address: no pick-up/drop-off separator found', removed };
}

/** Key to compare two addresses ("same order"): no diacritics, case or punctuation */
export const addressKey = (address) => fold(address ?? '').replace(/[^a-z0-9]+/g, ' ').trim();

// ---------- missing values ----------
const sameDate = (a, b) => Boolean(a.date && b.date && a.date.year === b.date.year && a.date.month === b.date.month && a.date.day === b.date.day);

/**
 * Fills a missing phone, date or time from the record on the Excel row directly above, only when it is the same
 * order: same pick-up and same drop-off (addressKey). A phone also needs the same date; a time only the same date;
 * a missing date needs both rows to have the same phone. Existing values are never replaced, and nothing is taken
 * from any other row. Chains work (the row above may hold an inferred value): phoneFrom / timestampFrom name the
 * row the value was really written on.
 * records: [{ row, origin, destination, date, time, phone, phoneMissing, dateError, timeError }], in sheet order;
 * they are updated in place. log(row, event, details) is called for every decision.
 */
export function inferFromRowAbove(records, log = () => {}) {
  const byRow = new Map(records.map((r) => [r.row, r]));
  for (const rec of records) {
    const above = byRow.get(rec.row - 1);
    const sameOrder = Boolean(above && rec.origin && above.origin && addressKey(rec.origin) === addressKey(above.origin)
      && addressKey(rec.destination) === addressKey(above.destination));
    if (rec.phoneMissing) {
      if (sameOrder && above.phone && sameDate(rec, above)) {
        rec.phone = above.phone;
        rec.phoneFrom = above.phoneFrom ?? above.row;
        rec.phoneRule = `inferred from row ${above.row}`;
        log(rec.row, 'phone inferred', { value: rec.phone, fromRow: above.row, originRow: rec.phoneFrom, reason: 'row above is the same order (same pick-up, drop-off and date)' });
      } else {
        rec.phoneRule = 'missing, not inferred';
        log(rec.row, 'phone left empty', { reason: !above ? 'no record directly above' : !sameOrder ? 'row above is a different order' : !above.phone ? 'row above has no phone either' : 'row above is on another date' });
      }
    }
    if (rec.dateError === 'missing' && sameOrder && above.date && rec.phone && rec.phone === above.phone) {
      rec.date = above.date;
      rec.dateError = null;
      rec.timestampFrom = above.timestampFrom ?? above.row;
      log(rec.row, 'date inferred', { value: formatLocal(above.date), fromRow: above.row, reason: 'same order and same phone as the row above' });
    }
    if (rec.timeError === 'missing' && rec.date && sameOrder && above.time && sameDate(rec, above)) {
      rec.time = above.time;
      rec.timeError = null;
      rec.timeRule = `inferred from row ${above.row}`;
      rec.timestampFrom = above.timestampFrom ?? above.row;
      log(rec.row, 'time inferred', { value: formatLocal(rec.date, rec.time), fromRow: above.row, reason: 'same order, same date as the row above' });
    }
  }
  return records;
}
