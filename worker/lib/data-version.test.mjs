// The version, the ETag and the edge copy, against fakes of R2 and the Cache
// API. The route test (routes/public.bundle.test.mjs) drives the same thing
// through the real Worker entry and a real database.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  currentVersion, bumpVersion, cachedJson, etagMatches, isDataWrite,
} from './data-version.mjs';
import { fakeBucket, fakeCache } from './test-fakes.mjs';

const ORIGIN = 'https://orthodoxy.au';
const req = (headers = {}) => new Request(`${ORIGIN}/api/bundle`, { headers });

test('no version written yet reads as "0", and a bump replaces it everywhere', async () => {
  const env = { ASSETS_BUCKET: fakeBucket() };
  const cache = fakeCache();
  assert.equal(await currentVersion(env, ORIGIN, cache), '0');
  const v = await bumpVersion(env, ORIGIN, cache);
  assert.notEqual(v, '0');
  // The location that wrote it answers with it at once, without R2…
  assert.equal(await currentVersion(env, ORIGIN, cache), v);
  // …and a location that has never seen it reads it from R2.
  assert.equal(await currentVersion(env, ORIGIN, fakeCache()), v);
});

test('a bump with no request (the cron) still moves the version', async () => {
  const env = { ASSETS_BUCKET: fakeBucket() };
  const v = await bumpVersion(env, null, fakeCache());
  assert.equal(await currentVersion(env, ORIGIN, null), v);
});

test('the browser is told to ask every time, and asking again costs a 304', async () => {
  const env = { ASSETS_BUCKET: fakeBucket() };
  let builds = 0;
  const build = async () => { builds++; return { hello: 'world' }; };
  const cache = fakeCache();

  const first = await cachedJson({ request: req(), env, name: 'b', build, cache });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-cache');
  const etag = first.headers.get('etag');
  assert.match(etag, /^"[0-9a-f]{32}"$/);
  assert.deepEqual(await first.json(), { hello: 'world' });

  const again = await cachedJson({ request: req({ 'if-none-match': etag }), env, name: 'b', build, cache });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get('etag'), etag);
  assert.equal(builds, 1, 'the second request should have been answered from the edge copy');
});

test('a bump rebuilds, and an unchanged body keeps its ETag through the rebuild', async () => {
  const env = { ASSETS_BUCKET: fakeBucket() };
  const cache = fakeCache();
  let title = 'Vespers';
  const build = async () => ({ title });

  const a = await cachedJson({ request: req(), env, name: 'b', build, cache });
  const etagA = a.headers.get('etag');

  // A write that changed nothing visible: rebuilt, same hash, still a 304.
  await bumpVersion(env, ORIGIN, cache);
  const b = await cachedJson({ request: req({ 'if-none-match': etagA }), env, name: 'b', build, cache });
  assert.equal(b.status, 304);

  // A write that did: rebuilt, new hash, the new body.
  title = 'Great Vespers';
  await bumpVersion(env, ORIGIN, cache);
  const c = await cachedJson({ request: req({ 'if-none-match': etagA }), env, name: 'b', build, cache });
  assert.equal(c.status, 200);
  assert.notEqual(c.headers.get('etag'), etagA);
  assert.deepEqual(await c.json(), { title: 'Great Vespers' });
});

test('with no edge cache at all (tests, wrangler dev) it still answers and still 304s', async () => {
  const env = {};
  const build = async () => ({ n: 1 });
  const a = await cachedJson({ request: req(), env, name: 'b', build, cache: null });
  const b = await cachedJson({ request: req({ 'if-none-match': a.headers.get('etag') }), env, name: 'b', build, cache: null });
  assert.equal(b.status, 304);
});

test('If-None-Match is compared the way a proxy leaves it', () => {
  // Cloudflare weakens an ETag when it compresses the body, so the browser
  // sends back W/"…" for a "…" we issued.
  assert.ok(etagMatches('W/"abc"', '"abc"'));
  assert.ok(etagMatches('"x", "abc"', '"abc"'));
  assert.ok(etagMatches('*', '"abc"'));
  assert.ok(!etagMatches('"abd"', '"abc"'));
  assert.ok(!etagMatches(null, '"abc"'));
});

test('only a successful admin write moves the version', () => {
  const r = (method, path) => new Request(`${ORIGIN}${path}`, { method });
  const ok = new Response(null, { status: 200 });
  assert.ok(isDataWrite(r('PATCH', '/api/admin/schedules/4'), ok));
  assert.ok(isDataWrite(r('POST', '/api/admin/events'), new Response(null, { status: 201 })));
  assert.ok(isDataWrite(r('DELETE', '/api/admin/overrides/9'), ok));
  assert.ok(!isDataWrite(r('GET', '/api/admin/schedules'), ok), 'a read');
  assert.ok(!isDataWrite(r('PATCH', '/api/admin/schedules/4'), new Response(null, { status: 403 })), 'a refusal');
  assert.ok(!isDataWrite(r('POST', '/api/bundle'), ok), 'not an admin route');
});
