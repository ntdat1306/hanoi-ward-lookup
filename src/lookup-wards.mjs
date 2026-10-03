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
import { OLD_DISTRICT_NAMES, areaWardCodes, googleWardFits, isOldDistrict, loadOldWardIndex, wardFitsArea } from './old-wards.mjs';
import { DISTANCE_REASON, WARD_REASON } from './reasons.mjs';
import { PLUS_CODE, addressHasNumberAndStreet, buildQuery, fold, isBareStreet, isDisposalAddress, parseFormattedAddress, placeNameMatches, placeSearchText, sameStreetSpelling, streetFromGoogle, streetsMatch, wardKey } from './address.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE_FILE = path.join(ROOT, 'cache', 'places-cache.json');
const OUTPUT_DIR = path.join(ROOT, 'output');
const WARDS_FILE = path.join(ROOT, 'data', 'wards.json');
const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

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

function loadApiKey() {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env is optional when the variable is already set */ }
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY is missing: copy .env.example to .env and set it');
  return key;
}

// ---------- Google Places with an on-disk cache ----------
const cache = existsSync(CACHE_FILE) ? JSON.parse(readFileSync(CACHE_FILE, 'utf8')) : {};
const calls = { autocomplete: 0, routes: 0 };

function saveCache() {
  mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bounding box of Hà Nội (Ba Vì to Gia Lâm, Mỹ Đức to Sóc Sơn), sent as locationBias: results inside it
// are preferred, results outside are still returned and rejected later as not-hanoi.
const HANOI_RECTANGLE = { low: { latitude: 20.53, longitude: 105.28 }, high: { latitude: 21.39, longitude: 106.03 } };
const AUTOCOMPLETE_FIELDS = 'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text';

// Client-side pacing per API, far below Google's per-minute quotas: a whole-workbook run spreads its calls
// evenly instead of bursting with --concurrency parallel requests. 429 / 5xx still back off (postGoogle).
const MAX_CALLS_PER_SECOND = 5;
const nextSlot = { autocomplete: 0, routes: 0 };

async function throttle(counter) {
  const now = Date.now();
  const slot = Math.max(now, nextSlot[counter]);
  nextSlot[counter] = slot + 1000 / MAX_CALLS_PER_SECOND;
  if (slot > now) await sleep(slot - now);
}

/** POSTs a JSON body to a Google API, paced and backing off on 429 / 5xx; returns the parsed response */
async function postGoogle(url, fieldMask, body, apiKey, counter) {
  let attempt = 0;
  for (;;) {
    await throttle(counter);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fieldMask },
      body: JSON.stringify(body),
    });
    calls[counter]++;
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      attempt++;
      await sleep(attempt * 10_000); // 10s, 20s, 30s... back off for per-minute quota resets and transient 503s
      continue;
    }
    if (!res.ok) throw new Error(`${new URL(url).hostname} ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return res.json();
  }
}

/** Autocomplete (New): place predictions for the text, [{ placeId, text }] */
/**
 * Request variants. 'vi': Vietnamese text, Hà Nội preferred (the normal call). 'plain': no languageCode and no
 * bias, the retry when 'vi' found nothing on the street: with languageCode vi Google drops some addresses
 * ("54 Tây Đam, Tây Tựu, Bắc Từ Liêm" → only "Tây Tựu, Hà Nội"; without it → "54 Phố Tây Đam, …, Tây Tựu, Ha Noi").
 * Its text mixes unaccented names ("Tay Tuu, Ha Noi"), so the old-ward check on Google's text rarely bites.
 */
const AUTOCOMPLETE_VARIANTS = {
  vi: { cacheKey: 'ac', params: { languageCode: 'vi', regionCode: 'VN', includedRegionCodes: ['vn'], locationBias: { rectangle: HANOI_RECTANGLE } } },
  plain: { cacheKey: 'acplain', params: { regionCode: 'VN', includedRegionCodes: ['vn'] } },
};

async function autocomplete(input, apiKey, variant) {
  // Only the address text is sent: never phone numbers or other row data
  const body = await postGoogle(AUTOCOMPLETE_URL, AUTOCOMPLETE_FIELDS, { input, ...AUTOCOMPLETE_VARIANTS[variant].params }, apiKey, 'autocomplete');
  return (body.suggestions ?? []).map((s) => s.placePrediction).filter(Boolean).map((p) => ({ placeId: p.placeId, text: p.text?.text ?? '' }));
}

// Autocomplete gives no coordinates: the route is asked between the two chosen predictions by placeId, and
// its leg gives back their coordinates (snapped to the road)
const ROUTE_FIELDS = 'routes.distanceMeters,routes.duration,routes.legs.startLocation,routes.legs.endLocation';

/**
 * Routes API computeRoutes by car: one route (no alternatives), TRAFFIC_UNAWARE = the fastest route on the
 * road network without live traffic. Cache key "route:<origin placeId>|<destination placeId>";
 * null when Google finds no route.
 */
const pendingRoutes = new Map(); // same pair asked by two moves at once (repeated rows): one call

async function computeRoute(originPlaceId, destinationPlaceId, apiKey) {
  const key = `route:${originPlaceId}|${destinationPlaceId}`;
  if (!(key in cache)) {
    if (!pendingRoutes.has(key)) pendingRoutes.set(key, fetchRoute(originPlaceId, destinationPlaceId, apiKey));
    cache[key] = await pendingRoutes.get(key);
    saveCache();
  }
  return cache[key];
}

async function fetchRoute(originPlaceId, destinationPlaceId, apiKey) {
  const body = await postGoogle(ROUTES_URL, ROUTE_FIELDS, {
    origin: { placeId: originPlaceId }, destination: { placeId: destinationPlaceId },
    travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', computeAlternativeRoutes: false, languageCode: 'vi', units: 'METRIC',
  }, apiKey, 'routes');
  const route = body.routes?.[0];
  const point = (location) => (location?.latLng ? { lat: location.latLng.latitude, lng: location.latLng.longitude } : null);
  // distanceMeters is left out when it is 0 (same place)
  return route ? { distanceMeters: route.distanceMeters ?? 0, duration: route.duration ?? null,
    origin: point(route.legs?.[0]?.startLocation), destination: point(route.legs?.[0]?.endLocation) } : null;
}

/**
 * One Autocomplete call per text; the prediction text ("Ngõ 27 Đường Đại Cồ Việt, Bạch Mai, Hà Nội") is read
 * like a formattedAddress: the part before the city is the ward, the part before the first comma is the name.
 * Cache key "ac:<text>". Older keys ("details:", Text Search "v4:"/"v3:"/none) are no longer used.
 */
async function searchPlaces(input, apiKey, variant = 'vi') {
  const key = `${AUTOCOMPLETE_VARIANTS[variant].cacheKey}:${input}`;
  if (!cache[key]) {
    cache[key] = await autocomplete(input, apiKey, variant);
    saveCache(); // persist immediately so a later failure doesn't lose already-fetched results
  }
  return cache[key].filter((p) => p.text).map((p) => ({ address: p.text, name: p.text.split(',')[0].trim(), placeId: p.placeId }));
}

/** Searches a landmark/building by its name */
async function searchPlaceByName(address, apiKey, variant) {
  // Building and lot codes are not searched ("Tòa S3 Goldmark City" → "Goldmark City"); the address itself is kept
  const text = placeSearchText(address);
  const textQuery = fold(text).includes('ha noi') ? text : `${text}, Hà Nội`;
  return { textQuery, places: await searchPlaces(textQuery, apiKey, variant) };
}

/** Runs fn over items with at most `limit` concurrent calls */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

// ---------- decision for one address ----------
/**
 * Status values:
 *   filled          ward found and written into an empty cell
 *   filled-place    same, but found by place name (no "number + street" in the address): less reliable
 *   same            cell already holds the ward Google found
 *   differs         cell holds another ward: kept, reported for review
 *   no-result       Google returned nothing
 *   not-hanoi       no result in Hà Nội
 *   street-mismatch results are in Hà Nội but on another street
 *   name-mismatch   place search: results are in Hà Nội but no place name matches the address
 *   bare-street     place search: the matching result is a whole street, which crosses wards
 *   area-mismatch   right street and number, but not in a ward the old ward written in the address became
 *   old-area        Google's text names an old ward that was not merged into its ward
 *   unknown-ward    Google's ward name is not in the wards sheet
 *   ambiguous       matching results point to different wards
 */
/**
 * Reads an Autocomplete text like a formattedAddress: street candidates, and the ward (the part before the city)
 * when it names exactly one known ward.
 */
function readPlace(p, wardsByKey) {
  const f = parseFormattedAddress(p.address);
  const routes = p.routes ?? (p.route ? [p.route] : []);
  const streets = [f.street, ...routes.map(streetFromGoogle)].filter(Boolean);
  // A prediction that is only an area ("Phúc Thọ, Hà Nội", "Tây Mỗ, Hà Nội") names its ward in that one part
  const areaOnly = !f.ward && f.area && !f.area.includes(',') ? f.area : null;
  // "595 Đường Lĩnh Nam, Vĩnh Hưng, Hai Bà Trưng, Hà Nội": new ward, then the old district Google appends
  const before = f.ward && isOldDistrict(f.ward) ? f.area.split(',').at(-1).trim() : null;
  if (before && wardsByKey.get(wardKey(before))?.length === 1) {
    const ward = wardsByKey.get(wardKey(before))[0];
    return { ...p, isHanoi: f.isHanoi, streets, ward, wardName: before, numbers: f.numbers, area: f.area.split(',').slice(0, -1).join(',') };
  }
  const ward = [f.ward, p.ward, areaOnly].map((n) => (n ? wardsByKey.get(wardKey(n)) ?? [] : [])).find((c) => c.length === 1)?.[0] ?? null;
  return { ...p, isHanoi: f.isHanoi, streets, ward, wardName: f.ward ?? areaOnly, numbers: f.numbers, area: f.ward ? f.area : '' };
}

function decide(query, places, wardsByKey, address, oldWards) {
  if (places.length === 0) return { status: 'no-result' };
  const inHanoi = places.map((p) => readPlace(p, wardsByKey)).filter((p) => p.isHanoi);
  if (inHanoi.length === 0) return { status: 'not-hanoi', google: places[0].address };
  // Same street, and when Google writes a house/lane number it must be the searched one: a long street
  // crosses several wards ("593 Nguyễn Trãi" must not be read off "316 Nguyễn Trãi, Đại Mỗ")
  const onStreet = inHanoi
    .map((p) => ({ ...p, street: p.streets.find((s) => streetsMatch(query.street, s)) }))
    .filter((p) => p.street && (p.numbers.length === 0 || p.numbers.includes(query.number)));
  if (onStreet.length === 0) return { status: 'street-mismatch', google: inHanoi[0].address, candidate: inHanoi[0] };
  // Google's own text must back its ward: "Vĩnh Hưng, Hai Bà Trưng" is old ward + old district, not phường Hai Bà Trưng.
  // When the best-ranked result fails, lower ones are not tried: they are often a same-name street elsewhere
  // ("33 Phú Mỹ": Từ Liêm first, then Phú Mỹ in xã Quảng Oai)
  const fits = (p) => !p.ward || googleWardFits(oldWards, p.area, p.street, p.ward.code, p.wardName);
  if (!fits(onStreet[0])) return { status: 'old-area', google: onStreet[0].address, candidate: onStreet[0] };
  const confirmed = onStreet.filter(fits);
  // An old ward written in the address besides the street ("45 Lê Trọng Tấn La Khê", "50 Vũ Hữu, Nhân Chính")
  // must have been merged into Google's ward
  const matching = confirmed.filter((p) => !p.ward || wardFitsArea(oldWards, address, p.street, p.ward.code));
  if (matching.length === 0) return { status: 'area-mismatch', google: confirmed[0].address, candidate: confirmed[0] };
  // Google's best-ranked result that has both the street and the searched number decides, even when lower
  // results point elsewhere ("593 Nguyễn Trãi": Thanh Liệt first, Thanh Xuân second)
  // …preferring one spelt with the same diacritics ("1 Đông Quan": Nghĩa Đô, not "1 Đồng Quan" in Thiên Lộc)
  const exacts = matching.filter((p) => p.ward && p.numbers.includes(query.number));
  const exact = exacts.find((p) => sameStreetSpelling(query.street, p.street)) ?? exacts[0];
  if (exact) return { status: 'found', google: exact.address, ward: exact.ward, placeId: exact.placeId, exact: true };
  const wards = [...new Map(matching.filter((p) => p.ward).map((p) => [p.ward.id, p.ward])).values()];
  if (wards.length === 0) return { status: 'unknown-ward', google: matching[0].address };
  if (wards.length > 1) return { status: 'ambiguous', google: matching.map((p) => p.address).join(' | ') };
  const best = matching.find((p) => p.ward);
  return { status: 'found', google: best.address, ward: wards[0], placeId: best.placeId };
}

/** Current wards whose name is written as whole words in the address ("…, Tương Mai, Hà Nội" → phường Tương Mai) */
function currentWardsIn(address, wardsByKey) {
  const text = ` ${fold(address).replace(/[^a-z0-9]+/g, ' ')} `;
  return [...wardsByKey].filter(([key, wards]) => wards.length === 1 && text.includes(` ${key} `)).map(([, wards]) => wards[0]);
}

const OLD_DISTRICT_KEYS = OLD_DISTRICT_NAMES.map((n) => fold(n));

/** The text without current ward and old district names, or null when nothing else is left */
function withoutAreaNames(text, wardsByKey) {
  let t = ` ${fold(text).replace(/[^a-z0-9]+/g, ' ')} `;
  for (const key of [...wardsByKey.keys(), ...OLD_DISTRICT_KEYS].sort((a, b) => b.length - a.length)) t = t.replaceAll(` ${key} `, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  return /[a-z]{3}/.test(t) && t !== fold(text) ? t : null;
}

/** Place-name search: the best-ranked Hà Nội result whose name matches the address gives the ward */
function decidePlace(address, places, wardsByKey) {
  if (places.length === 0) return { status: 'no-result' };
  const inHanoi = places.map((p) => readPlace(p, wardsByKey)).filter((p) => p.isHanoi);
  if (inHanoi.length === 0) return { status: 'not-hanoi', google: places[0].address };
  // A plus code result ("2P8W+W54 Hà Nội") matches when the address holds that code
  const samePlusCode = (p) => { const code = p.name.match(PLUS_CODE)?.[0]; return Boolean(code) && fold(address).includes(fold(code)); };
  // Also compared without its ward and district names, which a place's own name leaves out ("Kepler Hà Đông" ↔
  // "Thùy Lưu Kepler Land")
  const searched = placeSearchText(address);
  const bare = withoutAreaNames(searched, wardsByKey);
  const match = inHanoi.find((p) => samePlusCode(p) || placeNameMatches(searched, p.name) || (bare && placeNameMatches(bare, p.name))
    || addressHasNumberAndStreet(address, p.numbers, p.streets));
  if (!match) return { status: 'name-mismatch', google: `${inHanoi[0].name} — ${inHanoi[0].address}`, candidate: inHanoi[0] };
  const google = `${match.name} — ${match.address}`;
  // A whole street ("Đường Nguyễn Khang") crosses wards. Lower results are not tried: they are other places
  // sharing the name ("Hồ Tùng Mậu" → Trường THPT Hồ Tùng Mậu, "Trần Hữu Tước" → Trần Hữu Moto in Sóc Sơn)
  // Its ward is still taken (status filled-street: short streets lie in one ward, "Phố Mộ Lao, Hà Đông") when it fits
  // any ward or area written in the address, checked strictly ("Hà Trì Hà Cầu" is not Phố Hà Cầu in Kiến Hưng)
  if (isBareStreet(match.name)) {
    const named = match.ward ? areaWardCodes(oldWards, address, match.streets[0] ?? '') : null;
    if (!match.ward || (named && !named.has(match.ward.code)) || !googleWardFits(oldWards, match.area, match.streets[0] ?? '', match.ward.code, match.wardName)) {
      return { status: 'bare-street', google, candidate: match };
    }
    return { status: 'found', google, ward: match.ward, viaStreet: true, placeId: match.placeId };
  }
  if (!match.ward) {
    // A plus code ("XRRR+JJX Hà Nội") pins the place but names no ward: the one current ward written in the
    // address ("Xrrr+jjx Tương Mai, Hà Nội") is taken
    const written = PLUS_CODE.test(match.name) ? currentWardsIn(address, wardsByKey) : [];
    if (written.length !== 1) return { status: 'unknown-ward', google };
    return { status: 'found', google, ward: written[0], viaPlace: true, placeId: match.placeId };
  }
  if (!googleWardFits(oldWards, match.area, match.streets[0] ?? '', match.ward.code, match.wardName)) return { status: 'old-area', google, candidate: match };
  return { status: 'found', google, ward: match.ward, viaPlace: true, placeId: match.placeId };
}

// Google found nothing on the searched street: asked once more without languageCode vi (AUTOCOMPLETE_VARIANTS),
// then as the bare "number + street" without the area;
// its answer is kept only when it has the searched street and number
const RETRY_PLAIN = new Set(['street-mismatch', 'no-result']);

/**
 * Looks one address up with one Autocomplete call (street query with its area, or the place name), and a
 * second one without languageCode vi only when the first found nothing on the street.
 */
// Areas known to lie wholly in one ward (data/area-wards.json): an address naming one (and one of its "with"
// names, when given) gets that ward, whatever Google said (status filled-area)
// Fixes by hand for single moves, by source_row (see main)
const MANUAL_OVERRIDES = existsSync(path.join(ROOT, 'data', 'manual-overrides.json'))
  ? JSON.parse(readFileSync(path.join(ROOT, 'data', 'manual-overrides.json'), 'utf8')) : [];
const AREA_WARDS = JSON.parse(readFileSync(path.join(ROOT, 'data', 'area-wards.json'), 'utf8'))
  .map((rule) => ({ ...rule, keys: rule.areas.map((a) => fold(a)), withKeys: (rule.with ?? []).map((a) => fold(a)) }));
const foldedWords = (text) => ` ${fold(text).replace(/[^a-z0-9]+/g, ' ')} `;
const namesAny = (text, keys) => keys.some((k) => foldedWords(text).includes(` ${k} `));

/**
 * Looks one address up on Google, then applies data/area-wards.json. The point used for the distance stays
 * Google's when Google's own text is in that area too (or names the ward); otherwise the rule's "point" text is
 * searched and its first Hà Nội prediction used (roughly the middle of the area); without one there is none.
 */
/** The one current ward the address writes out as "phường X" / "xã X" ("Chung cư X20 phường Thanh Liệt") */
function writtenWard(address, wardsByKey) {
  // With diacritics: folded, "Đê Song Phương, Hoài Đức" would read as "phường Hoài Đức"
  const tones = { 'oà': 'òa', 'oá': 'óa', 'oả': 'ỏa', 'oã': 'õa', 'oạ': 'ọa', 'uỳ': 'ùy', 'uý': 'úy', 'uỷ': 'ủy', 'uỹ': 'ũy', 'uỵ': 'ụy' };
  const words = (text) => ` ${String(text).normalize('NFC').toLowerCase().replace(/o[àáảãạ]|u[ỳýỷỹỵ]/gu, (m) => tones[m]).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const text = words(address);
  const hits = [...wardsByKey.values()].flat().filter((ward) => text.includes(words(ward.name)));
  return hits.length === 1 ? hits[0] : null;
}

async function lookup(job, apiKey, wardsByKey) {
  const result = await lookupGoogle(job, apiKey, wardsByKey);
  const rule = AREA_WARDS.find((r) => namesAny(job.address, r.keys) && (r.withKeys.length === 0 || namesAny(job.address, r.withKeys)));
  if (!rule) {
    // Nothing fit, but the address writes its ward out: that ward is taken (status filled-written), with Google's
    // point when it lies in that ward
    const ward = result.d.status === 'found' ? null : writtenWard(job.address, wardsByKey);
    if (!ward) return result;
    const c = result.d.candidate;
    const inWard = c?.ward?.id === ward.id;
    return { ...result, d: { status: 'found', viaWritten: true, ward, google: inWard ? c.address : '', placeId: inWard ? c.placeId : undefined } };
  }
  const ward = wardsByKey.get(wardKey(rule.ward))?.[0];
  if (!ward) throw new Error(`data/area-wards.json: unknown ward "${rule.ward}"`);
  const { d } = result;
  if (d.status === 'found' && d.ward.id === ward.id) return result;
  const place = d.status === 'found' ? { address: d.google, placeId: d.placeId } : d.candidate;
  const inArea = place?.address && namesAny(place.address, [...rule.keys, wardKey(rule.ward)]);
  let placeId = inArea ? place.placeId : undefined;
  let google = inArea ? d.google : '';
  if (!placeId && rule.point) {
    const point = (await searchPlaces(`${rule.point}, Hà Nội`, apiKey)).find((p) => parseFormattedAddress(p.address).isHanoi);
    placeId = point?.placeId;
    // Report the point actually used, not Google's unrelated answer ("Phố Hạ Yên Quyết" for "khu đô thị mới Hạ Đình")
    if (point) google = `điểm dự phòng "${rule.point}" → ${point.address}`;
  }
  return { ...result, d: { status: 'found', viaArea: true, ward, google, placeId } };
}

/**
 * Asked by the user: when a call gives exactly one prediction and it is in Hà Nội, it is taken even though the
 * street, number or name checks failed (status filled-single). Its ward must still read as one of the 126
 * wards and pass the old-ward checks: on Google's own text ("…, Vĩnh Hưng, Hai Bà Trưng" is old ward + district) and
 * on the address ("Tingtong Ngọc Trục, Đại Mỗ" is not the TingTong in Hà Đông). Not for an address that only
 * places itself relative to the other one ("Nhà đối diện", "Đầu Ngõ", "Cùng Ngõ"): Google matches the words.
 */
const RELATIVE_ADDRESS = /đối diện|đầu ngõ|cùng ngõ|nội khu này|bên cạnh|sát vách/iu;

function singleResult(d, places, wardsByKey, address) {
  if (d.status === 'found' || places.length !== 1 || RELATIVE_ADDRESS.test(address)) return d;
  const p = readPlace(places[0], wardsByKey);
  if (!p.isHanoi || !p.ward || !googleWardFits(oldWards, p.area, p.streets[0] ?? '', p.ward.code, p.wardName)) return d;
  // Strictly here: no benefit of the doubt for wards whose list of old wards was cut in the source
  const named = areaWardCodes(oldWards, address, p.streets[0] ?? '');
  if (named && !named.has(p.ward.code)) return d;
  const google = p.name && p.name !== p.address.split(',')[0].trim() ? `${p.name} — ${p.address}` : p.address;
  return { status: 'found', viaSingle: true, ward: p.ward, google, placeId: p.placeId };
}

async function lookupGoogle(job, apiKey, wardsByKey) {
  const once = async (variant, text = job.query?.query) => {
    const tag = variant === 'plain' ? ' (no vi)' : '';
    if (job.query) {
      const places = await searchPlaces(text, apiKey, variant);
      return { searched: text + tag, d: singleResult(decide(job.query, places, wardsByKey, job.address, oldWards), places, wardsByKey, job.address) };
    }
    const { textQuery, places } = await searchPlaceByName(job.address, apiKey, variant);
    return { searched: textQuery + tag, d: singleResult(decidePlace(job.address, places, wardsByKey), places, wardsByKey, job.address) };
  };
  const first = await once('vi');
  if (!RETRY_PLAIN.has(first.d.status)) return first;
  const retry = await once('plain');
  // Without the Hà Nội bias, same-name streets elsewhere come up ("Ngô Quyền HĐ" → Phố Ngô Quyền, Cửa Nam): the retry
  // counts only when Google has the searched street AND number (or gave a single Hà Nội prediction)
  if (retry.d.status === 'found' && (retry.d.exact || retry.d.viaSingle)) return retry;
  // Last, the bare "number + street" without the area written after it ("8 Lê Quang Đạo" for "…, Từ Liêm")
  if (job.query?.plainQuery && job.query.plainQuery !== job.query.query) {
    const bare = await once('vi', job.query.plainQuery);
    if (bare.d.status === 'found') return bare;
  }
  return first;
}

const oldWards = loadOldWardIndex();

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = loadApiKey();

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
  const wardsByKey = new Map();
  const wardsById = new Map();
  for (const ward of JSON.parse(readFileSync(WARDS_FILE, 'utf8'))) {
    wardsById.set(ward.id, ward);
    const key = wardKey(ward.name);
    wardsByKey.set(key, [...(wardsByKey.get(key) ?? []), ward]);
  }

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
      const { d, searched } = await lookup(job, apiKey, wardsByKey);
      if (d.status !== 'found') return { ...job, ...d, searched };
      if (job.current === null) {
        if (!args.dryRun) job.wardCell.value = d.ward.id;
        return { ...job, ...d, searched, status: d.viaArea ? 'filled-area' : d.viaWritten ? 'filled-written' : d.viaSingle ? 'filled-single' : d.viaStreet ? 'filled-street' : d.viaPlace ? 'filled-place' : 'filled' };
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
      const point = (await searchPlaces(`${o.point}, Hà Nội`, apiKey)).map((p) => readPlace(p, wardsByKey)).find((p) => p.isHanoi);
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
    const route = await computeRoute(m.origin.placeId, m.destination.placeId, apiKey);
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
      console.log(`  distance checkpoint: saved (${routes.length}/${moveList.length} moves, ${calls.routes} Routes calls so far)`);
    }
  }
  const routeByRow = new Map(routes.map((r) => [r.excelRow, r]));

  mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1));

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
  console.log(`${args.dryRun ? '[dry run] ' : ''}addresses: ${results.length}, API calls: ${calls.autocomplete} Autocomplete + ${calls.routes} Routes (rest from cache)`);
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
