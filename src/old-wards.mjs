// Old (pre-2025) ward names → the new wards they were merged into, read from data/ward-history.json
// (the "Ghi chú" column of the official list under Nghị quyết 1656/NQ-UBTVQH15).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HISTORY_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'ward-history.json');

// Notes were cut at 255 characters in the source file and then got ". Bỏ cấp huyện" (14) appended:
// the last item of such a note is incomplete ("…, 1 phần phường Thụy Khuê, 1 phần phường C. Bỏ cấp huyện")
const CUT_NOTE_LENGTH = 269;

// Old-style tone placement → new style, so "Thuỵ"/"Thụy" and "Hoà"/"Hòa" compare equal
const TONES = { 'oà': 'òa', 'oá': 'óa', 'oả': 'ỏa', 'oã': 'õa', 'oạ': 'ọa', 'oè': 'òe', 'oé': 'óe', 'oẻ': 'ỏe', 'oẽ': 'õe', 'oẹ': 'ọe',
  'uỳ': 'ùy', 'uý': 'úy', 'uỷ': 'ủy', 'uỹ': 'ũy', 'uỵ': 'ụy' };

/**
 * Lowercase words WITH diacritics: "Làng" must not read as phường Láng, nor "phường Định Công" as xã Phương
 * Đình. Unit words (phường, xã, quận…) are dropped. Addresses typed without diacritics simply match nothing.
 */
function words(text) {
  return String(text).normalize('NFC').toLowerCase()
    .replace(/o[àáảãạèéẻẽẹ]|u[ỳýỷỹỵ]/gu, (m) => TONES[m] ?? m)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w && !['phường', 'xã', 'thị', 'trấn', 'quận', 'huyện', 'p', 'q'].includes(w))
    .join(' ');
}

// Old district names: people write them after the street ("Vạn Phúc Hà Đông", "Nguyễn Văn Trỗi Thanh Xuân"),
// and several equal a ward name (xã Thanh Xuân in Sóc Sơn, phường Hà Đông), so they are never read as wards.
export const OLD_DISTRICT_NAMES = [
  'Ba Đình', 'Hoàn Kiếm', 'Tây Hồ', 'Long Biên', 'Cầu Giấy', 'Đống Đa', 'Hai Bà Trưng', 'Hoàng Mai', 'Thanh Xuân',
  'Nam Từ Liêm', 'Bắc Từ Liêm', 'Từ Liêm', 'Hà Đông', 'Sơn Tây', 'Ba Vì', 'Chương Mỹ', 'Đan Phượng', 'Đông Anh',
  'Gia Lâm', 'Hoài Đức', 'Mê Linh', 'Mỹ Đức', 'Phú Xuyên', 'Phúc Thọ', 'Quốc Oai', 'Sóc Sơn', 'Thạch Thất',
  'Thanh Oai', 'Thanh Trì', 'Thường Tín', 'Ứng Hòa',
];
const OLD_DISTRICTS = new Set(OLD_DISTRICT_NAMES.map(words));

const PREFIX = /^(?:hợp nhất|của|các|một phần|1\s*phần|p1 phần|\d+|phường|xã|thị trấn)(?!\p{L})\s*/iu;

/** "Đổi tên từ phường Trúc Bạch thành phường Ba Đình, hợp nhất phường Quán Thánh, 1 phần phường Cửa Nam…" → names */
export function oldWardNames(note) {
  const truncated = String(note).length >= CUT_NOTE_LENGTH;
  const text = String(note)
    .normalize('NFC')
    .replace(/(phường|xã)(?=\p{Lu})/gu, '$1 ')
    .replace(/\(trước khi thực hiện sắp xếp\)/giu, '')
    .replace(/\((?:huyện|quận)[^)]*\)/giu, '')
    .replace(/\.?\s*Bỏ cấp huyện\.?\s*$/iu, '')
    .replace(/\s+thuộc (?:quận|huyện) [^,]*?(?=,|\s+và\s+|$)/giu, '');
  const pieces = text.split(/,|\s+và\s+/u);
  if (truncated) pieces.pop();
  const names = [];
  for (let piece of pieces) {
    piece = piece.trim().replace(/[.\s]+$/u, '');
    const renamed = piece.match(/đổi tên (?:từ )?(?:phường|xã|thị trấn)\s*(.+?)\s+thành/iu);
    if (renamed) { names.push(renamed[1]); continue; }
    // "một phần diện tích tự nhiên, quy mô dân số của phường Mễ Trì"
    const share = piece.match(/(?:diện tích|quy mô).*của (?:phường|xã|thị trấn)\s+(.+)$/iu);
    if (share) { names.push(share[1]); continue; }
    if (/đổi loại hình|đổi tên|diện tích|quy mô/iu.test(piece)) continue;
    let prev;
    do { prev = piece; piece = piece.replace(PREFIX, ''); } while (piece !== prev);
    if (/^\p{L}/u.test(piece) && piece.split(/\s+/).length <= 6) names.push(piece);
  }
  return names;
}

/**
 * { names: Map of old (or current) ward name → Set of current ward codes, partial: codes whose note was cut,
 * so their list of old wards is incomplete }
 */
export function buildOldWardIndex(rows) {
  const names = new Map();
  const partial = new Set();
  const add = (name, code) => {
    const key = words(name);
    if (!key || OLD_DISTRICTS.has(key)) return;
    if (!names.has(key)) names.set(key, new Set());
    names.get(key).add(code);
  };
  for (const { code, name, note } of rows) {
    if (String(note).length >= CUT_NOTE_LENGTH) partial.add(code);
    add(name, code);
    for (const old of oldWardNames(note)) {
      add(old, code);
      // "Mỹ Đình 1", "Cổ Nhuế 2" are written "Mỹ Đình", "Cổ Nhuế"
      if (/\s\d+$/.test(old)) add(old.replace(/\s\d+$/, ''), code);
    }
  }
  return { names, partial };
}

export function loadOldWardIndex() {
  return buildOldWardIndex(JSON.parse(readFileSync(HISTORY_FILE, 'utf8')));
}

/**
 * Current ward codes allowed by the old/current ward names written in the address outside the street itself:
 * "45 Lê Trọng Tấn La Khê" (street "Lê Trọng Tấn") → La Khê → {Hà Đông, Dương Nội}. null when none is written.
 */
export function areaWardCodes(index, address, street) {
  let text = ` ${words(address)} `;
  const s = words(street);
  if (s) text = text.replace(` ${s} `, ' | ');
  const allowed = new Set();
  for (const key of [...index.names.keys()].sort((a, b) => b.length - a.length)) {
    if (!text.includes(` ${key} `)) continue;
    for (const code of index.names.get(key)) allowed.add(code);
    text = text.replaceAll(` ${key} `, ' | ');
  }
  return allowed.size ? allowed : null;
}

/** False only when the address names an old ward that was not merged into this ward (and its list is complete) */
export function wardFitsArea(index, address, street, code) {
  const allowed = areaWardCodes(index, address, street);
  return !allowed || allowed.has(code) || index.partial.has(code);
}

/**
 * Checks the ward read off an Autocomplete text against the rest of that text (`area`: everything before the
 * ward). Google writes the new ward ("27 Đường Đại Cồ Việt, Bạch Mai, Hà Nội"; "…, Từ Liêm, Hà Nội" is the new
 * phường Từ Liêm: Place Details agrees for 95% of predictions), but some texts are old ward + old district
 * ("595 Đường Lĩnh Nam, Vĩnh Hưng, Hai Bà Trưng, Hà Nội"): rejected when the old ward was not merged into it.
 * Only when the ward is named like an old district: otherwise the other names are housing estates or residential
 * groups ("Khu tập thể Nam Thành Công, Láng", "Hòa Bình, Yên Nghĩa"), not a competing ward.
 */
export function googleWardFits(index, area, street, code, wardName) {
  if (wardName && !OLD_DISTRICTS.has(words(wardName))) return true;
  // Only the part right before it, whole ("…, Vĩnh Hưng, Hai Bà Trưng"): names inside other parts are streets and
  // estates ("Đường Trần Phú", "Khu đô thị Phùng Khoang"), not the old xã Trần Phú or xã Phùng
  const before = String(area ?? '').split(',').at(-1)?.trim();
  const codes = before ? index.names.get(words(before)) : null;
  return !codes || codes.has(code) || index.partial.has(code);
}

export const isOldDistrict = (name) => OLD_DISTRICTS.has(words(name));
