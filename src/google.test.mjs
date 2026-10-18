// Google client with a mocked fetch: no request leaves the machine, no API cost.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createGoogleClient, loadWards } from './google.mjs';
import { buildQuery } from './address.mjs';

const tmpCache = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'google-test-')), 'places-cache.json');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const predictions = (...texts) => ({ suggestions: texts.map((text, i) => ({ placePrediction: { placeId: `P${i}`, text: { text } } })) });
const fast = { maxCallsPerSecond: 1000, retryDelayMs: 1, timeoutMs: 200 };

test('identical requests in flight share one call, then come from the cache', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return json(predictions('27 Đường Đại Cồ Việt, Bạch Mai, Hà Nội')); };
  const g = createGoogleClient({ apiKey: 'k', cacheFile: tmpCache(), fetchImpl, ...fast });
  const [a, b] = await Promise.all([g.searchPlaces('27 Đại Cồ Việt'), g.searchPlaces('27 Đại Cồ Việt')]);
  assert.deepEqual(a, b);
  await g.searchPlaces('27 Đại Cồ Việt');
  assert.equal(calls, 1);
  assert.equal(g.stats.autocomplete, 1);
  assert.equal(g.stats.cacheHits, 2);
});

test('the API key goes in a header and only the address text is sent', async () => {
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return json(predictions()); };
  const g = createGoogleClient({ apiKey: 'SECRET', cacheFile: tmpCache(), fetchImpl, ...fast });
  await g.searchPlaces('141 An Dương Vương');
  assert.ok(!seen.url.includes('SECRET'));
  assert.equal(seen.init.headers['X-Goog-Api-Key'], 'SECRET');
  assert.equal(JSON.parse(seen.init.body).input, '141 An Dương Vương');
});

test('429 / 5xx are retried with back-off; a lasting 429 stops the run as a temporary error', async () => {
  let calls = 0;
  const flaky = async () => (++calls < 3 ? json({}, 503) : json(predictions('141 Đường An Dương Vương, Phú Thượng, Hà Nội')));
  const g = createGoogleClient({ apiKey: 'k', cacheFile: tmpCache(), fetchImpl: flaky, ...fast });
  assert.equal((await g.searchPlaces('141 An Dương Vương')).length, 1);
  assert.equal(g.stats.retries, 2);

  let quotaCalls = 0;
  const quota = createGoogleClient({ apiKey: 'k', cacheFile: tmpCache(), fetchImpl: async () => { quotaCalls++; return json({}, 429); }, ...fast, retries: 2 });
  await assert.rejects(quota.searchPlaces('a'), (e) => e.retryable === true && e.status === 429);
  const before = quotaCalls;
  await assert.rejects(quota.searchPlaces('b'), (e) => e.retryable === true);
  assert.equal(quotaCalls, before, 'no call after the quota stopped the run');
});

test('403 (key / billing) is permanent and stops every later call; errors are never cached', async () => {
  let calls = 0;
  const cacheFile = tmpCache();
  const g = createGoogleClient({ apiKey: 'k', cacheFile, fetchImpl: async () => { calls++; return new Response('{"error":{"status":"PERMISSION_DENIED","message":"billing"}}', { status: 403 }); }, ...fast });
  await assert.rejects(g.searchPlaces('a'), (e) => e.retryable === false && e.status === 403 && e.fatal);
  await assert.rejects(g.searchPlaces('b'), (e) => e.status === 403);
  assert.equal(calls, 1);
  g.save();
  assert.throws(() => readFileSync(cacheFile), /ENOENT/);
});

test('timeouts and network failures are temporary, not "address not found"', async () => {
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
  const g = createGoogleClient({ apiKey: 'k', cacheFile: tmpCache(), fetchImpl: hang, ...fast, timeoutMs: 20, retries: 1 });
  await assert.rejects(g.searchPlaces('a'), (e) => e.retryable === true && /no answer within/.test(e.message));
  const n = createGoogleClient({ apiKey: 'k', cacheFile: tmpCache(), fetchImpl: async () => { throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } }); }, ...fast, retries: 0 });
  await assert.rejects(n.searchPlaces('a'), (e) => e.retryable === true && /ENOTFOUND/.test(e.message));
});

test('cache-only sends nothing and counts the misses', async () => {
  const cacheFile = tmpCache();
  writeFileSync(cacheFile, JSON.stringify({ 'ac:cached': [{ placeId: 'X', text: 'Cached, Bạch Mai, Hà Nội' }] }));
  const g = createGoogleClient({ cacheFile, cacheOnly: true, fetchImpl: async () => { throw new Error('must not be called'); }, ...fast });
  assert.equal((await g.searchPlaces('cached')).length, 1);
  await assert.rejects(g.searchPlaces('new'), (e) => e.retryable === true && /cache-only/.test(e.message));
  assert.equal(g.stats.misses, 1);
});

test('cached answers older than the TTL are dropped and asked again', async () => {
  const cacheFile = tmpCache();
  writeFileSync(cacheFile, JSON.stringify({ 'ac:old': [], 'ac:fresh': [] }));
  writeFileSync(cacheFile.replace('.json', '.meta.json'), JSON.stringify({ 'ac:old': '2026-08-01T00:00:00Z', 'ac:fresh': '2026-10-10T00:00:00Z' }));
  let calls = 0;
  const g = createGoogleClient({ apiKey: 'k', cacheFile, ttlDays: 30, now: () => Date.parse('2026-10-18T00:00:00Z'), fetchImpl: async () => { calls++; return json(predictions()); }, ...fast });
  assert.equal(g.stats.expired, 1);
  await g.searchPlaces('fresh');
  await g.searchPlaces('old');
  assert.equal(calls, 1);
});

test('routes: metres from distanceMeters, no route is null (cached), coordinates from the leg', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls++;
    const { origin } = JSON.parse(init.body);
    return json(origin.placeId === 'NOROUTE' ? {} : { routes: [{ distanceMeters: 3780, duration: '612s', legs: [{ startLocation: { latLng: { latitude: 21, longitude: 105.8 } }, endLocation: { latLng: { latitude: 21.01, longitude: 105.81 } } }] }] });
  };
  const g = createGoogleClient({ apiKey: 'k', cacheFile: tmpCache(), fetchImpl, ...fast });
  const route = await g.computeRoute('A', 'B');
  assert.equal(route.distanceMeters, 3780);
  assert.deepEqual(route.origin, { lat: 21, lng: 105.8 });
  assert.equal(await g.computeRoute('NOROUTE', 'B'), null);
  assert.equal(await g.computeRoute('NOROUTE', 'B'), null);
  assert.equal(calls, 2);
});

test('lookup: a ward is taken only from a prediction on the searched street and number', async () => {
  const { wardsByKey } = loadWards();
  const answers = {
    '27 Đại Cồ Việt': predictions('27 Đường Đại Cồ Việt, Bạch Mai, Hà Nội'),
    // Two predictions (a single one is taken on its own: rule filled-single), neither with number 593
    '593 Nguyễn Trãi': predictions('316 Đường Nguyễn Trãi, Đại Mỗ, Hà Nội', '200 Đường Nguyễn Trãi, Thanh Xuân, Hà Nội'),
  };
  const fetchImpl = async (url, init) => json(answers[JSON.parse(init.body).input] ?? predictions());
  const g = createGoogleClient({ apiKey: 'k', cacheFile: tmpCache(), fetchImpl, ...fast });
  const found = await g.lookup({ address: 'Số nhà 49, ngõ 27 Đại Cồ Việt', query: buildQuery('Số nhà 49, ngõ 27 Đại Cồ Việt') }, wardsByKey);
  assert.equal(found.d.status, 'found');
  assert.equal(found.d.ward.name, 'Phường Bạch Mai');
  const other = await g.lookup({ address: '593 Nguyễn Trãi', query: buildQuery('593 Nguyễn Trãi') }, wardsByKey);
  assert.equal(other.d.status, 'street-mismatch'); // another house number on a long street: no ward
});
