// Address helpers: build the Google Places query, parse Google's formatted address, compare street names.

/** Lowercase, strip Vietnamese diacritics (đ → d) and collapse spaces, so "Hòa"/"Hoà"/"Hoa" compare equal */
export function fold(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

const STREET_PREFIX = /^(?:đường|phố|đ\.|p\.|đg\.?)\s*/iu;
// Words that start a component but are not a street name ("Số 2 dãy C", "10 tầng 5"...). "Đội" only
// with a number ("đội 5"): "Đội Cấn" is a street.
// A lot or building code is not a street either ("16 Lk 30 khu đô thị Vân Canh", "Số 2 TT31 khu đô thị Văn Phú",
// "Số 108 A5"): such addresses are searched by place name
const NOT_A_STREET = /^(?:(?:dãy|ngách|hẻm|ngõ|tầng|tòa|toà|căn|lô|phòng|sảnh|khu|tổ|xóm|thôn|cụm|lk|liền kề|dv|nv|tt|bt|biệt thự)(?!\p{L})|đội(?=\s*\d|\s*$)|\p{L}{1,3}\d)/iu;
// "Số nhà 12A 230/21/15 Mễ Trì Thượng", "Nhà số 6 167 phố Quang Tiến": the house number in front of
// another number is dropped, so the lane/street number that follows is the one searched.
const LEADING_UNIT_NUMBER = /^(?:số nhà|nhà số|số|nhà)\s*\d+[A-Za-z]?\s+(?=\d)/iu;
// "Ngõ 32, ngách 101, hẻm 9 ..." / "ngõ"'s number wins — it is the outermost, broadest lane and
// the one address systems key off; ngách/hẻm are narrower lanes nested inside it.
const LANE_PRIORITY = ['ngõ', 'ngách', 'hẻm'];
const LANE_RE = /(?:^|\s)(ngõ|ngách|hẻm)\s+((?:[\dA-Za-z]+\/)*\d+[A-Za-z]?)(?:\s+(.+))?$/iu;
const UNIT_PREFIX = /^(?:số nhà|nhà số|số|nhà)\s*\d+[A-Za-z]?\s*/iu;

function lanePlusStreet(number, rawStreet) {
  // A slash after the name means the name is itself a named lane with a further sub-number nested
  // inside it ("Hẻm 101 Gốc Đề / 7B" — "Gốc Đề" is the lane; "/ 7B" is dropped, not part of it).
  // A house number written between the lane and the street goes ("Ngõ 8 số 75 Lê Quang Đạo" → "8 Lê Quang Đạo")
  const street = stripToStreet(rawStreet.split('/')[0]).replace(STREET_PREFIX, '').trim();
  if (!/^\p{L}/u.test(street) || NOT_A_STREET.test(street)) return null;
  return { query: `${number} ${street}`, street, number: String(number).toLowerCase() };
}

/** Strips a leading lane keyword+number and "số nhà"/"nhà số" unit-number prefixes, repeatedly */
function stripToStreet(text) {
  let s = text.trim();
  let prev;
  do {
    prev = s;
    s = s.replace(/^(?:ngõ|ngách|hẻm)\s+(?:[\dA-Za-z]+\/)*\d+[A-Za-z]?\s*/iu, '').replace(UNIT_PREFIX, '');
  } while (s !== prev);
  return s;
}

/**
 * Builds the search text "<lane or house number> <street>" from a cleaned address, e.g.
 *   "Số nhà 49, ngõ 27 Đại Cồ Việt" → "27 Đại Cồ Việt"
 *   "201/4 Đê Tô Hoàng"            → "4 Đê Tô Hoàng"   (slash notation: the last number is the lane on the street)
 *   "11/61/1002 Láng"              → "1002 Láng"
 *   "141 An Dương Vương"           → "141 An Dương Vương"
 *   "Ngõ 32, ngách 101, hẻm 9 số nhà 21 Đỗ Đức Dục" → "32 Đỗ Đức Dục"   (ngõ's number wins; the
 *                                    street is read off the last part once unit prefixes are stripped)
 * Returns null when there is no "number + street" to search for (landmarks, buildings, lanes without a number):
 * such addresses cannot pass the street check, so they are searched by place name instead (placeNameMatches).
 */
export function buildQuery(address) {
  if (!address) return null;
  const parts = String(address).normalize('NFC').split(',').map((p) => p.trim()).filter(Boolean);
  const found = findStreet(parts);
  if (!found) return null;
  // Area names written after the street ("…, ngõ 6 Ngô Quyền, Quang Trung, Hà Đông") are searched too, so
  // Google picks the right one of several same-name streets (Ngô Quyền in Hà Đông, not in Hoàn Kiếm)
  const area = parts.slice(found.index + 1).filter((p) => !/\d/.test(p) && !AREA_NOISE.test(p));
  // plainQuery (without the area) is the fallback when an old area name throws Google off ("50 Vũ Hữu, Nhân Chính")
  return area.length ? { ...found.result, query: `${found.result.query}, ${area.join(', ')}`, plainQuery: found.result.query } : found.result;
}

const AREA_NOISE = /^(?:thành phố\s+|tp\.?\s*)?(?:hà nội|hn|việt nam|vietnam)\.?$/iu;

/** Finds "number + street" and the index of the comma-separated part it was read from */
function findStreet(parts) {

  // 1. A lane on the street: "ngõ 27 Đại Cồ Việt", "ngách 99/110/67 Định Công Hạ", "hẻm 12 ..."
  //    (first number is the lane itself; anything after a slash is a narrower ngách/house number
  //    nested inside it) — "ngõ", "ngách" and "hẻm" all follow the same convention. When more than
  //    one shows up across the comma-separated parts, the outermost (ngõ, then ngách, then hẻm)
  //    gives the number; if its own part has no street text, the street is read from the last part.
  const candidates = {};
  parts.forEach((part, index) => {
    const m = part.match(LANE_RE);
    const keyword = m?.[1].toLowerCase();
    if (keyword && !candidates[keyword]) candidates[keyword] = { number: m[2].split('/')[0], tail: m[3], index };
  });
  for (const keyword of LANE_PRIORITY) {
    const c = candidates[keyword];
    if (!c) continue;
    const streetText = c.tail ?? stripToStreet(parts.at(-1));
    const result = lanePlusStreet(c.number, streetText);
    if (result) return { result, index: c.tail ? c.index : parts.length - 1 };
  }
  // 2. Slash notation without "ngõ"/"ngách"/"hẻm" (optionally after "Số", "Số nhà", "Nhà"): the ngõ
  //    is whichever of the first/last number is bigger, e.g. "201/4 Đê Tô Hoàng" → 201 (201 > 4);
  //    "11/61/1002 Láng" → 1002 (1002 > 11, the middle number is ignored)
  const plainParts = parts.map((p) => p.replace(LEADING_UNIT_NUMBER, ''));
  for (const [index, part] of plainParts.entries()) {
    const m = part.match(/^(?:số nhà|nhà số|số|nhà)?\s*((?:[\dA-Za-z]+\/)+\d+[A-Za-z]?)\s+(.+)$/iu);
    if (m) {
      const numbers = m[1].split('/');
      const first = numbers[0];
      const last = numbers.at(-1);
      const chosen = parseInt(first, 10) >= parseInt(last, 10) ? first : last;
      const result = lanePlusStreet(chosen, m[2]);
      if (result) return { result, index };
    }
  }
  // 3. House number on the street: "141 An Dương Vương", "Số 3 Lương Yên"
  for (const [index, part] of plainParts.entries()) {
    const m = part.match(/^(?:số nhà|nhà số|số|nhà)?\s*(\d+[A-Za-z]?)\s+(.+)$/iu);
    if (m) {
      const result = lanePlusStreet(m[1], m[2]);
      if (result) return { result, index };
    }
  }
  return null;
}

/** Strips lane/house number and "Đ."/"P."/"Phố"/"Đường" from a Google address part or route ("Đường Hồng Hà") */
export function streetFromGoogle(firstPart) {
  let s = firstPart.trim();
  let prev;
  do {
    prev = s;
    s = s
      .replace(/^(?:ng\.|ngh\.|ngõ|ngách|hẻm|tổ)\s*(?:[\dA-Za-z]+\/)*\d+[A-Za-z]?\s*/iu, '') // "Tổ 1/24 Phố Ngọc Trục"
      .replace(/^(?:số\s+)?(?:[\dA-Za-z]+\/)*\d+[A-Za-z]?(?:-\d+[A-Za-z]?)?\s+/iu, '')
      .replace(STREET_PREFIX, '');
  } while (s !== prev);
  return s.trim();
}

/** Open Location Code at the start of a text ("XRRR+JJX Hà Nội", "2P8W+W54") */
export const PLUS_CODE = /^[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}(?![A-Z0-9])/iu;

/**
 * Parses a Google formattedAddress such as "Ng. 27 Đ. Đại Cồ Việt, Bạch Mai, Hà Nội, Vietnam".
 * Returns { street, ward, isHanoi }; ward is the component right before the city. For a building or shop
 * Google puts its name first ("Chung cư Goldseason, 47 Đ. Nguyễn Tuân, Thanh Xuân, Hà Nội"), so the street
 * is read from the first component that starts with a house/lane number, falling back to the first one.
 */
export function parseFormattedAddress(formatted) {
  const parts = String(formatted).normalize('NFC').split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length && /^(?:vietnam|việt nam|socialist republic of vietnam)$/iu.test(parts.at(-1))) parts.pop();
  // A plus code result is "XRRR+JJX Hà Nội": the code is stuck to the city
  if (parts.length) parts[parts.length - 1] = parts.at(-1).replace(PLUS_CODE, '').trim();
  const city = parts.pop() ?? '';
  const isHanoi = /^(?:thành phố\s+)?(?:hà nội|hanoi|ha noi)(?:\s+\d+)?$/iu.test(city);
  const ward = parts.length >= 2 ? parts.pop() : null;
  // A corner written "Phố Trần Quý Kiên/44 Phố Dịch Vọng": the number belongs to the street after the slash. Only
  // after a street name ("…Kiên/"), not lane numbers ("28/132a Phố Đại Linh", "800A/1 Phố Đông Quan").
  for (const [i, part] of parts.entries()) parts[i] = part.replace(/^.*\p{L}{2}\/(?=\d+[A-Za-z]?\s+\p{L})/u, '');
  // House/lane numbers written before the ward ("39 Ng. 143 Đ. Xuân Phương" → 39, 143); plus codes are not numbers
  const numbers = parts.join(' ').split(/[\s/]+/).filter((t) => /^\d+[A-Za-z]?$/.test(t)).map((t) => t.toLowerCase());
  // Everything before the ward: street, and sometimes the old ward ("…, Vĩnh Hưng, Hai Bà Trưng, Hà Nội")
  const area = parts.join(', ');
  if (!parts.length) return { street: null, ward, isHanoi, numbers, area };
  const numbered = parts.find((p) => /^(?:(?:ng\.|ngh\.|ngõ|ngách|hẻm|số)\s*|tổ\s*\d+[A-Za-z]?\/)?\d/iu.test(p));
  return { street: streetFromGoogle(numbered ?? parts[0]), ward, isHanoi, numbers, area };
}

/**
 * The street Google found must be the street we searched for. Old area names typed after the street are tolerated:
 * searched "Quang Trung Hà Đông" vs Google "Quang Trung" matches; "Quang Trung" vs "Đàm Quang Trung" does not.
 */
/**
 * streetsMatch ignores diacritics, so "Đông Quan" also matches "Đồng Quan" (another place). This tells whether
 * Google's street is spelt with the same diacritics as the searched one ("Hoà"/"Hòa" aside), to prefer it.
 */
export function sameStreetSpelling(searched, google) {
  const tones = { 'oà': 'òa', 'oá': 'óa', 'oả': 'ỏa', 'oã': 'õa', 'oạ': 'ọa', 'uỳ': 'ùy', 'uý': 'úy', 'uỷ': 'ủy', 'uỹ': 'ũy', 'uỵ': 'ụy' };
  const key = (text) => String(text).normalize('NFC').toLowerCase().replace(/o[àáảãạ]|u[ỳýỷỹỵ]/gu, (m) => tones[m])
    .replace(/^(?:ngõ|ngách|hẻm|ng\.|đê)\s+(?=\p{L})/u, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const a = key(searched);
  const b = key(google);
  return Boolean(a && b) && (a === b || a.startsWith(`${b} `));
}

export function streetsMatch(searched, google) {
  // Punctuation separates words like a space: "Xuân Đỉnh- Phường Xuân Đỉnh" is "Xuân Đỉnh" + area.
  // Before folding (so "Ngõ" ≠ "Ngô"): a named lane is its name ("56 Ngõ Gốc Đề" is on "Gốc Đề") and a dyke
  // road is its name ("Đê Nguyễn Khoái" = "Đường Nguyễn Khoái"). After folding, y = i ("Mĩ Đình" = "Mỹ Đình").
  const words = (text) => fold(String(text).normalize('NFC').trim().replace(/^(?:ngõ|ngách|hẻm|ng\.|đê)\s+(?=\p{L})/iu, ''))
    .replace(/y/g, 'i').replace(/[^a-z0-9]+/g, ' ').trim();
  const a = words(searched);
  const b = words(google);
  return Boolean(a && b) && (a === b || a.startsWith(`${b} `));
}

// Address filler words that say nothing about which place it is
const PLACE_STOPWORDS = new Set(['so', 'nha', 'ngo', 'ngach', 'hem', 'duong', 'pho', 'ha', 'noi', 'phuong', 'xa', 'quan', 'huyen', 'tp']);

// Words of a place name that say what kind of place it is, not which one ("Khu tập thể", "Trường đh")
const GENERIC_PLACE_WORDS = new Set(['khu', 'tap', 'the', 'ktt', 'kdt', 'truong', 'dh', 'dai', 'hoc', 'chung', 'cu', 'toa', 'nha',
  'do', 'thi', 'moi', 'kdtm', 'benh', 'vien', 'cho', 'cong', 'ty', 'to', 'thon', 'xom', 'lang', 'cum', 'tang',
  // kinds of shop: "Cà phê Alasca Văn Khê" is not a place Google names just "Cà Phê" (in Trung Giã, 40 km away)
  'ca', 'phe', 'cafe', 'coffee', 'tiem', 'cua', 'sieu', 'khach', 'san']);

// Abbreviations spelt out, so "Khu Công Nghiệp Vĩnh Tuy" meets "CT KCN Vĩnh Tuy"
const ABBREVIATIONS = { kcn: 'khu cong nghiep', kdt: 'khu do thi', kdtm: 'khu do thi moi', ktt: 'khu tap the' };

function placeTokens(text) {
  return new Set(fold(text).split(/[^a-z0-9]+/).flatMap((t) => (ABBREVIATIONS[t] ?? t).split(' ')).filter((t) => t && !PLACE_STOPWORDS.has(t)));
}

const isWord = (t) => /^[a-z]+$/.test(t); // "132a", "t02" are numbers

/**
 * For addresses without a street ("Bến xe Nước Ngầm"), the address and Google's place name must share
 * at least 60% of the words of the shorter of the two. Besides:
 *   - every word of Google's name, up to two, is shared, numbers aside ("Tổ 6 Phúc Đồng" ≠ "6 Phố Hoa Động")
 *   - one shared word names the place itself ("Khu tập thể nhà Hát Chèo Mai Dịc" ≠ "Khu tập thể")
 *   - when the address has numbers, one of Google's is among them ("Vinaconex 1" ≠ "Vinaconex 2", "CTI1-1A" ≠ "1 Đường Vĩnh Hoàng")
 * "Vinaconex 1" matches "Sảnh B Tòa Vinaconex 1 Khuất Duy Tiến"; "Học Viện Cảnh Sát" matches "Học viện Cảnh
 * sát nhân dân (T02) Bộ Công an".
 */
export function placeNameMatches(address, placeName) {
  const name = placeTokens(placeName);
  const input = placeTokens(address);
  const shorter = Math.min(name.size, input.size);
  if (shorter === 0) return false;
  const shared = [...name].filter((t) => input.has(t));
  const nameWords = [...name].filter(isWord);
  const sharedWords = shared.filter(isWord);
  const nameNumbers = [...name].filter((t) => !isWord(t));
  // When both sides hold numbers, one must be shared: "Vinaconex 1" is not "Vinaconex 2"
  const numbersAgree = nameNumbers.length === 0 || ![...input].some((t) => !isWord(t)) || nameNumbers.some((t) => input.has(t));
  // The same name, word for word ("Khu đô thị Dương Nội 2", "Phố 8-3"): the stopwords above would drop "Dương"
  // (đường) and "Nội" (Hà Nội) and leave nothing to compare
  const plain = (text) => fold(text).replace(/,?\s*ha noi$/, '').replace(/[^a-z0-9]+/g, ' ').trim();
  if (plain(address) && plain(address) === plain(placeName)) return true;
  // Same estate: every distinctive word of the address is in Google's name, which may add a brand or another
  // tower ("Chung cư Westpoint" ↔ "Vinhomes Westpoint W2", "Feliz Home Tòa Zen A" ↔ "Feliz Homes - Zen Tower");
  // one of them long enough to name a place by itself
  const inName = (t) => name.has(t) || (t.length >= 4 && [...name].some((n) => n.startsWith(t)));
  const distinctive = [...input].filter((t) => isWord(t) && t.length > 1 && !GENERIC_PLACE_WORDS.has(t));
  if (numbersAgree && distinctive.length > 0 && distinctive.every(inName) && distinctive.some((t) => t.length >= 4)) return true;
  // A project name no Vietnamese syllable can be (7+ letters, "Imperia", "Westpoint") shared by both
  if (numbersAgree && [...input].some((t) => isWord(t) && t.length >= 7 && t !== 'nghieng' && name.has(t))) return true;
  return sharedWords.length >= Math.min(2, nameWords.length) && sharedWords.length > 0
    // a one-letter word ("Viện K") is too short to tell the place: Bệnh viện K has three sites
    && sharedWords.some((t) => !GENERIC_PLACE_WORDS.has(t) && t.length > 1)
    && numbersAgree
    && shared.length / shorter >= 0.6;
}

// A unit code: letters and digits mixed ("S3", "15C1", "CT12C", "N2B", "B21-05", "LK1B"), with the unit words
// before it if any ("Tòa S3", "Số 15C1"); or unit words with a number ("tầng 28", "liền kề 4", "Lk 20.16", "Ô Số 12").
// A number alone stays ("Phố 8-3", "Vinhomes Ocean Park 1").
const UNIT_WORDS = '(?:(?:tòa nhà|toà nhà|tòa|toà|tầng|sảnh|lô|ô|lk|liền kề|căn hộ|căn|phòng|nhà số|số nhà|số|nhà|block|đơn nguyên|dv|nv|tt|bt)\\s*)';
const UNIT_CODE = new RegExp(`(?<![\\p{L}\\p{N}])${UNIT_WORDS}*(?=[\\p{L}\\p{N}.\\-/]*\\p{N})(?=[\\p{L}\\p{N}.\\-/]*\\p{L})[\\p{L}\\p{N}.\\-/]+(?![\\p{L}\\p{N}])`, 'giu');
const UNIT_NUMBER = new RegExp(`(?<![\\p{L}\\p{N}])${UNIT_WORDS}+\\d[\\d.\\-/]*(?![\\p{L}\\p{N}])`, 'giu');

/**
 * The text searched by place name: building and lot codes dropped, since Google matches the development, not
 * the unit ("Tòa S3 Goldmark City" → "Goldmark City", "Số 15C1 khu đô thị Yên Hòa" → "Khu đô thị Yên Hòa").
 * Plain numbers stay ("Vinhomes Ocean Park 1"); an address holding a plus code is left as it is.
 */
export function placeSearchText(address) {
  const text = String(address).normalize('NFC').trim();
  if (/[23456789CFGHJMPQRVWX]{4,8}\+[23456789CFGHJMPQRVWX]{2,3}/iu.test(text)) return text;
  // A house number in front goes too ("16 khu đô thị Vân Canh" → "Khu đô thị Vân Canh")
  const cleaned = text.replace(UNIT_CODE, ' ').replace(UNIT_NUMBER, ' ').replace(/^\s*\d+[A-Za-z]?\s+(?=\p{L})/u, '')
    .replace(/(?<=^|[\s,])[-–.\/]+(?=[\s,]|$)/g, ' ') // punctuation left between removed codes ("lô A19 - NV8")
    .replace(/\s+/g, ' ').replace(/\s*,\s*(?:,\s*)*/g, ', ').replace(/^[\s,.\-]+|[\s,.\-]+$/g, '').trim();
  // Nothing meaningful left (the address was only codes): search it as written
  if (!/\p{L}{2,}/u.test(cleaned)) return text;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** An Autocomplete prediction that is a whole street ("Đường Nguyễn Xiển"): it crosses wards, so it gives none */
export function isBareStreet(placeName) {
  return /^(?:đường|phố|ngõ|ngách|hẻm|đ\.|p\.)\s/iu.test(String(placeName).trim()) && !/\d/.test(placeName);
}

/**
 * For a place search, Google's own address may vouch for the result instead of its name: one of its house/lane
 * numbers followed by its street must appear in the address. "Chung cư Sictech 304 Hồ Tùng Mậu" (name misspelt)
 * is vouched for by "304 Đ. Hồ Tùng Mậu". "Đường"/"Phố" are ignored on both sides.
 */
export function addressHasNumberAndStreet(address, numbers, streets) {
  const words = (text) => fold(text).split(/[^a-z0-9]+/).filter((t) => t && t !== 'duong' && t !== 'pho');
  const text = ` ${words(address).join(' ')} `;
  return numbers.some((n) => streets.some((s) => {
    const street = words(s).join(' ');
    return street !== '' && text.includes(` ${n} ${street} `);
  }));
}

// Words of an "address" that only says what happens to the goods ("Vứt", "Chở Đi Bỏ", "Đổ rác"). Compared with
// diacritics, so "Bộ", "Đồ" or "Bờ" never count.
const ACTION_WORDS = new Set(['chở', 'đi', 'mang', 'đem', 'vứt', 'bỏ', 'đổ', 'hủy', 'huỷ', 'rác', 'thanh', 'lý', 'luôn']);
const DISPOSAL_WORDS = new Set(['vứt', 'bỏ', 'đổ', 'hủy', 'huỷ', 'rác', 'lý']);

/** True for a non-address that only names a disposal action: "Vứt", "Bỏ đi", "Chở Đi Vứt" */
export function isDisposalAddress(address) {
  const words = String(address ?? '').normalize('NFC').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return words.length > 0 && words.every((w) => ACTION_WORDS.has(w)) && words.some((w) => DISPOSAL_WORDS.has(w));
}

/** "Phường Bạch Mai" / "Xã Sóc Sơn" → "bach mai" / "soc son", to compare with Google's bare ward name */
export function wardKey(name) {
  return fold(String(name).replace(/^(?:phường|xã)\s+/iu, ''));
}
