// Google layer shared by `pnpm lookup` (lookup-wards.mjs) and `pnpm process` (process-raw.mjs): Places Autocomplete
// (New), one call per address, read like a formattedAddress to find the ward; Routes API computeRoutes for the driving
// distance. Answers are cached in cache/places-cache.json; identical requests in flight share one call.
//
// Errors are GoogleError with `retryable`: 429 / 5xx / timeouts / network failures are temporary (the address is not
// wrong, run again later), 400 / 403 are permanent. A 403 (key, API not enabled, billing) or a quota still exhausted
// after the back-offs stops every later call of the run: they fail with the same error instead of hammering Google.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { areaWardCodes, googleWardFits, isOldDistrict, loadOldWardIndex, OLD_DISTRICT_NAMES, wardFitsArea } from './old-wards.mjs';
import { PLUS_CODE, addressHasNumberAndStreet, fold, isBareStreet, parseFormattedAddress, placeNameMatches, placeSearchText, sameStreetSpelling, streetFromGoogle, streetsMatch, wardKey } from './address.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_FILE = path.join(ROOT, 'cache', 'places-cache.json');
const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const ROUTES_URL = 'https://routes.googleapis.com/directions/v2:computeRoutes';

export function loadApiKey() {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* .env is optional when the variable is already set */ }
  const key = process.env.GOOGLE_MAPS_API_KEY;
  if (!key) throw new Error('GOOGLE_MAPS_API_KEY is missing: copy .env.example to .env and set it');
  return key;
}

/** The 126 current wards of data/wards.json: { wardsByKey: "bach mai" → [ward], wardsById } */
export function loadWards(file = path.join(ROOT, 'data', 'wards.json')) {
  const wardsByKey = new Map();
  const wardsById = new Map();
  for (const ward of JSON.parse(readFileSync(file, 'utf8'))) {
    wardsById.set(ward.id, ward);
    const key = wardKey(ward.name);
    wardsByKey.set(key, [...(wardsByKey.get(key) ?? []), ward]);
  }
  return { wardsByKey, wardsById };
}

export class GoogleError extends Error {
  constructor(message, { status = null, retryable, fatal = false } = {}) {
    super(message);
    this.name = 'GoogleError';
    this.status = status;
    this.retryable = retryable;
    /** Stops every later call of the run */
    this.fatal = fatal;
  }
}

// Bounding box of Hà Nội (Ba Vì to Gia Lâm, Mỹ Đức to Sóc Sơn), sent as locationBias: results inside it
// are preferred, results outside are still returned and rejected later as not-hanoi.
const HANOI_RECTANGLE = { low: { latitude: 20.53, longitude: 105.28 }, high: { latitude: 21.39, longitude: 106.03 } };
const AUTOCOMPLETE_FIELDS = 'suggestions.placePrediction.placeId,suggestions.placePrediction.text.text';

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

// Autocomplete gives no coordinates: the route is asked between the two chosen predictions by placeId, and
// its leg gives back their coordinates (snapped to the road)
const ROUTE_FIELDS = 'routes.distanceMeters,routes.duration,routes.legs.startLocation,routes.legs.endLocation';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Google client with the on-disk cache.
 *   cacheOnly       no request is sent: a cache miss is counted (stats.misses) and answered as a temporary error
 *   ttlDays         cached answers older than this are dropped and asked again (Google Maps Platform terms limit how
 *                   long content may be kept). The fetch time of each key lives in places-cache.meta.json; keys
 *                   cached before it existed count from the cache file's date
 *   timeoutMs       per request
 *   maxCallsPerSecond  client-side pacing per API, far below Google's per-minute quotas
 */
export function createGoogleClient({
  apiKey = null, cacheFile = CACHE_FILE, cacheOnly = false, ttlDays = Number(process.env.GOOGLE_CACHE_TTL_DAYS) || 30,
  timeoutMs = 15_000, maxCallsPerSecond = 5, retries = 5, retryDelayMs = 10_000, fetchImpl = (...a) => globalThis.fetch(...a), now = () => Date.now(),
} = {}) {
  const metaFile = cacheFile.replace(/\.json$/, '.meta.json');
  const cache = existsSync(cacheFile) ? JSON.parse(readFileSync(cacheFile, 'utf8')) : {};
  const meta = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};
  const legacyAt = existsSync(cacheFile) ? statSync(cacheFile).mtime.toISOString() : new Date(now()).toISOString();
  const stats = { autocomplete: 0, routes: 0, cacheHits: 0, misses: 0, expired: 0, retryableErrors: 0, permanentErrors: 0, retries: 0 };
  for (const key of Object.keys(cache)) {
    meta[key] ??= legacyAt;
    if (now() - Date.parse(meta[key]) > ttlDays * DAY_MS) { delete cache[key]; delete meta[key]; stats.expired++; }
  }
  for (const key of Object.keys(meta)) if (!(key in cache)) delete meta[key];

  let dirty = false;
  function save() {
    if (!dirty) return;
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cache, null, 1));
    writeFileSync(metaFile, JSON.stringify(meta));
    dirty = false;
  }
  const store = (key, value) => { cache[key] = value; meta[key] = new Date(now()).toISOString(); dirty = true; save(); };

  const nextSlot = { autocomplete: 0, routes: 0 };
  async function throttle(counter) {
    const t = Date.now();
    const slot = Math.max(t, nextSlot[counter]);
    nextSlot[counter] = slot + 1000 / maxCallsPerSecond;
    if (slot > t) await sleep(slot - t);
  }

  let halted = null; // the fatal error that stopped calls for the rest of the run
  /** POSTs a JSON body to a Google API, paced and backing off on 429 / 5xx / timeouts; returns the parsed response */
  async function postGoogle(url, fieldMask, body, counter) {
    if (halted) throw halted;
    if (!apiKey) throw new GoogleError('No API key', { retryable: false, fatal: true });
    const host = new URL(url).hostname;
    for (let attempt = 0; ; attempt++) {
      await throttle(counter);
      let res;
      let failure;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': fieldMask },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        stats[counter]++;
      } catch (error) {
        // The key travels in a header, never in the URL or the message
        failure = new GoogleError(`${host}: ${error.name === 'TimeoutError' ? `no answer within ${timeoutMs / 1000} s` : `network error (${error.cause?.code ?? error.message})`}`, { retryable: true });
      }
      if (res && (res.status === 429 || res.status >= 500)) {
        failure = new GoogleError(`${host} ${res.status}: ${res.status === 429 ? 'quota exceeded' : 'server error'}`, { status: res.status, retryable: true, fatal: res.status === 429 });
      }
      if (failure) {
        if (attempt < retries) {
          stats.retries++;
          await sleep((attempt + 1) * retryDelayMs); // 10s, 20s, 30s... per-minute quota resets and transient 503s
          continue;
        }
        stats.retryableErrors++;
        if (failure.fatal) halted = failure;
        throw failure;
      }
      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        // 403: key refused, API not enabled on the project, or billing disabled; nothing later can succeed
        const fatal = res.status === 403 || res.status === 401;
        const error = new GoogleError(`${host} ${res.status}: ${text}`, { status: res.status, retryable: false, fatal });
        stats.permanentErrors++;
        if (fatal) halted = error;
        throw error;
      }
      return res.json();
    }
  }

  const pending = new Map(); // same cache key asked twice at once: one call

  /** Cached value of `key`, else fetch() once (shared by concurrent callers) and store it. Errors are never cached */
  async function cached(key, fetch) {
    if (key in cache) { stats.cacheHits++; return cache[key]; }
    if (cacheOnly) {
      stats.misses++;
      throw new GoogleError('not in the cache (cache-only run)', { retryable: true });
    }
    if (!pending.has(key)) {
      pending.set(key, fetch().then((value) => { store(key, value); return value; }).finally(() => pending.delete(key)));
    } else stats.cacheHits++;
    return pending.get(key);
  }

  /** Autocomplete (New): place predictions for the text, [{ placeId, text }]. Only the address text is sent */
  async function autocomplete(input, variant) {
    const body = await postGoogle(AUTOCOMPLETE_URL, AUTOCOMPLETE_FIELDS, { input, ...AUTOCOMPLETE_VARIANTS[variant].params }, 'autocomplete');
    return (body.suggestions ?? []).map((s) => s.placePrediction).filter(Boolean).map((p) => ({ placeId: p.placeId, text: p.text?.text ?? '' }));
  }

  /**
   * One Autocomplete call per text; the prediction text ("Ngõ 27 Đường Đại Cồ Việt, Bạch Mai, Hà Nội") is read
   * like a formattedAddress: the part before the city is the ward, the part before the first comma is the name.
   * Cache key "ac:<text>". Older keys ("details:", Text Search "v4:"/"v3:"/none) are no longer used.
   */
  async function searchPlaces(input, variant = 'vi') {
    const predictions = await cached(`${AUTOCOMPLETE_VARIANTS[variant].cacheKey}:${input}`, () => autocomplete(input, variant));
    return predictions.filter((p) => p.text).map((p) => ({ address: p.text, name: p.text.split(',')[0].trim(), placeId: p.placeId }));
  }

  /**
   * Routes API computeRoutes by car: one route (no alternatives), TRAFFIC_UNAWARE = the fastest route on the
   * road network without live traffic. Cache key "route:<origin placeId>|<destination placeId>";
   * null when Google finds no route.
   */
  function computeRoute(originPlaceId, destinationPlaceId) {
    return cached(`route:${originPlaceId}|${destinationPlaceId}`, async () => {
      const body = await postGoogle(ROUTES_URL, ROUTE_FIELDS, {
        origin: { placeId: originPlaceId }, destination: { placeId: destinationPlaceId },
        travelMode: 'DRIVE', routingPreference: 'TRAFFIC_UNAWARE', computeAlternativeRoutes: false, languageCode: 'vi', units: 'METRIC',
      }, 'routes');
      const route = body.routes?.[0];
      const point = (location) => (location?.latLng ? { lat: location.latLng.latitude, lng: location.latLng.longitude } : null);
      // distanceMeters is left out when it is 0 (same place)
      return route ? { distanceMeters: route.distanceMeters ?? 0, duration: route.duration ?? null,
        origin: point(route.legs?.[0]?.startLocation), destination: point(route.legs?.[0]?.endLocation) } : null;
    });
  }

  /** Searches a landmark/building by its name */
  async function searchPlaceByName(address, variant) {
    // Building and lot codes are not searched ("Tòa S3 Goldmark City" → "Goldmark City"); the address itself is kept
    const text = placeSearchText(address);
    const textQuery = fold(text).includes('ha noi') ? text : `${text}, Hà Nội`;
    return { textQuery, places: await searchPlaces(textQuery, variant) };
  }

  async function lookupGoogle(job, wardsByKey) {
    const once = async (variant, text = job.query?.query) => {
      const tag = variant === 'plain' ? ' (no vi)' : '';
      if (job.query) {
        const places = await searchPlaces(text, variant);
        return { searched: text + tag, d: singleResult(decide(job.query, places, wardsByKey, job.address, oldWards), places, wardsByKey, job.address) };
      }
      const { textQuery, places } = await searchPlaceByName(job.address, variant);
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

  /**
   * Looks one address up on Google, then applies data/area-wards.json. The point used for the distance stays
   * Google's when Google's own text is in that area too (or names the ward); otherwise the rule's "point" text is
   * searched and its first Hà Nội prediction used (roughly the middle of the area); without one there is none.
   * job: { address, query: buildQuery(address) }. Returns { searched, d } with d.status 'found' or a rejection.
   */
  async function lookup(job, wardsByKey) {
    const result = await lookupGoogle(job, wardsByKey);
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
      const point = (await searchPlaces(`${rule.point}, Hà Nội`)).find((p) => parseFormattedAddress(p.address).isHanoi);
      placeId = point?.placeId;
      // Report the point actually used, not Google's unrelated answer ("Phố Hạ Yên Quyết" for "khu đô thị mới Hạ Đình")
      if (point) google = `điểm dự phòng "${rule.point}" → ${point.address}`;
    }
    return { ...result, d: { status: 'found', viaArea: true, ward, google, placeId } };
  }

  return { lookup, searchPlaces, computeRoute, save, stats, get halted() { return halted; } };
}

/** Runs fn over items with at most `limit` concurrent calls */
export async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await fn(items[i], i); }
  }));
  return results;
}

// ---------- decision for one address ----------
/**
 * Status values (d.status):
 *   found           ward found (viaPlace / viaStreet / viaSingle / viaArea / viaWritten say how)
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
export const oldWards = loadOldWardIndex();

// Areas known to lie wholly in one ward (data/area-wards.json): an address naming one (and one of its "with"
// names, when given) gets that ward, whatever Google said (status filled-area)
const AREA_WARDS = JSON.parse(readFileSync(path.join(ROOT, 'data', 'area-wards.json'), 'utf8'))
  .map((rule) => ({ ...rule, keys: rule.areas.map((a) => fold(a)), withKeys: (rule.with ?? []).map((a) => fold(a)) }));
const foldedWords = (text) => ` ${fold(text).replace(/[^a-z0-9]+/g, ' ')} `;
const namesAny = (text, keys) => keys.some((k) => foldedWords(text).includes(` ${k} `));

/**
 * Reads an Autocomplete text like a formattedAddress: street candidates, and the ward (the part before the city)
 * when it names exactly one known ward.
 */
export function readPlace(p, wardsByKey) {
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

export function decide(query, places, wardsByKey, address, oldWardIndex = oldWards) {
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
  const fits = (p) => !p.ward || googleWardFits(oldWardIndex, p.area, p.street, p.ward.code, p.wardName);
  if (!fits(onStreet[0])) return { status: 'old-area', google: onStreet[0].address, candidate: onStreet[0] };
  const confirmed = onStreet.filter(fits);
  // An old ward written in the address besides the street ("45 Lê Trọng Tấn La Khê", "50 Vũ Hữu, Nhân Chính")
  // must have been merged into Google's ward
  const matching = confirmed.filter((p) => !p.ward || wardFitsArea(oldWardIndex, address, p.street, p.ward.code));
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
export function decidePlace(address, places, wardsByKey) {
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

/** The one current ward the address writes out as "phường X" / "xã X" ("Chung cư X20 phường Thanh Liệt") */
export function writtenWard(address, wardsByKey) {
  // With diacritics: folded, "Đê Song Phương, Hoài Đức" would read as "phường Hoài Đức"
  const tones = { 'oà': 'òa', 'oá': 'óa', 'oả': 'ỏa', 'oã': 'õa', 'oạ': 'ọa', 'uỳ': 'ùy', 'uý': 'úy', 'uỷ': 'ủy', 'uỹ': 'ũy', 'uỵ': 'ụy' };
  const words = (text) => ` ${String(text).normalize('NFC').toLowerCase().replace(/o[àáảãạ]|u[ỳýỷỹỵ]/gu, (m) => tones[m]).replace(/[^\p{L}\p{N}]+/gu, ' ').trim()} `;
  const text = words(address);
  const hits = [...wardsByKey.values()].flat().filter((ward) => text.includes(words(ward.name)));
  return hits.length === 1 ? hits[0] : null;
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

/** Status of a found ward, as written in the reports */
export function filledStatus(d) {
  return d.viaArea ? 'filled-area' : d.viaWritten ? 'filled-written' : d.viaSingle ? 'filled-single' : d.viaStreet ? 'filled-street' : d.viaPlace ? 'filled-place' : 'filled';
}
