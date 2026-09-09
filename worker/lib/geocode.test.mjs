import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geocode } from './geocode.mjs';

/** Runs geocode with fetch stubbed; returns { result, url }. */
async function withFetch(reply, address, opts) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => { calls.push(String(url)); return reply(); };
  try {
    return { result: await geocode(address, opts), url: calls[0], calls };
  } finally {
    globalThis.fetch = real;
  }
}

const hit = (lat, lon) => () => new Response(JSON.stringify([{ lat, lon }]), { status: 200 });
const empty = () => new Response('[]', { status: 200 });

test('an empty address never reaches the network', async () => {
  for (const a of [undefined, null, '', '   ']) {
    const { result, calls } = await withFetch(empty, a);
    assert.equal(result, null);
    assert.equal(calls.length, 0);
  }
});

test('New Zealand is not filtered out', async () => {
  // The bug this replaces: countrycodes=au is a hard filter, so every NZ
  // address returned no match and the pin silently stayed where it was.
  const { url } = await withFetch(hit('-36.8485', '174.7633'), '1 Queen St, Auckland');
  const cc = new URL(url).searchParams.get('countrycodes').split(',');
  assert.ok(cc.includes('nz'), `nz missing from ${cc}`);
  assert.ok(cc.includes('au'));
});

test('no Sydney viewbox biases a Melbourne address', async () => {
  const { url } = await withFetch(hit('-37.9115', '145.1330'), 'Monash University, Clayton VIC 3800');
  const q = new URL(url).searchParams;
  assert.equal(q.get('viewbox'), null);
  assert.equal(q.get('bounded'), null);
});

test('the country list matches the basemap bbox', async () => {
  // Tonga and Samoa are east of the antimeridian and outside the extract in
  // .github/workflows/basemap.yml, so geocoding there would land on blank map.
  const { url } = await withFetch(hit('0', '0'), 'anywhere');
  const cc = new URL(url).searchParams.get('countrycodes').split(',');
  assert.deepEqual(cc, ['au', 'nz', 'pg', 'fj', 'nc', 'vu', 'sb']);
});

test('a hit is parsed as numbers, not strings', async () => {
  const { result } = await withFetch(hit('-37.9115', '145.1330'), 'x');
  assert.deepEqual(result, { lat: -37.9115, lng: 145.133 });
});

test('no match, a bad status, and a thrown fetch all return null', async () => {
  assert.equal((await withFetch(empty, 'x')).result, null);
  assert.equal((await withFetch(() => new Response('', { status: 429 }), 'x')).result, null);
  assert.equal((await withFetch(() => { throw new Error('offline'); }, 'x')).result, null);
});

test('countryCodes can still be narrowed by a caller', async () => {
  const { url } = await withFetch(hit('0', '0'), 'x', { countryCodes: 'nz' });
  assert.equal(new URL(url).searchParams.get('countrycodes'), 'nz');
});
