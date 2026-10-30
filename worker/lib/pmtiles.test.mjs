// The archive reader the tile route stands on, and the route itself, against
// an archive made here: big enough that its root cannot hold every entry, so a
// tile is found through a leaf directory as it is in the real basemap.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEADER_BYTES, zxyToTileId, parseHeader, writeHeader, parseDirectory, serializeDirectory,
  findEntry, buildDirectories, gzip,
} from './pmtiles.mjs';
import { serveTile, forgetTileArchives, TILE_CACHE_CONTROL, TILE_CACHE_VERSION } from '../routes/assets.mjs';

test('tile ids walk the zooms, then the Hilbert curve', () => {
  assert.equal(zxyToTileId(0, 0, 0), 0);
  // Zoom 1, in curve order: top-left, bottom-left, bottom-right, top-right.
  assert.deepEqual([[0, 0], [0, 1], [1, 1], [1, 0]].map(([x, y]) => zxyToTileId(1, x, y)), [1, 2, 3, 4]);
  assert.equal(zxyToTileId(2, 0, 0), 5);
  // Values from protomaps' own reader.
  assert.equal(zxyToTileId(12, 3767, 2457), 18013225);
  assert.equal(zxyToTileId(10, 941, 614), 1125826);
  assert.throws(() => zxyToTileId(3, 8, 0));
});

test('a directory reads back as it was written, contiguous offsets and all', () => {
  const entries = [
    { tileId: 0, offset: 0, length: 10, runLength: 1 },
    { tileId: 1, offset: 10, length: 20, runLength: 3 },
    { tileId: 9, offset: 5, length: 10, runLength: 1 },   // repeats earlier bytes
    { tileId: 20, offset: 30, length: 7, runLength: 0 },  // a leaf
  ];
  assert.deepEqual(parseDirectory(serializeDirectory(entries)), entries);
  assert.equal(findEntry(entries, 2).tileId, 1, 'inside a run');
  assert.equal(findEntry(entries, 4), null, 'past a run');
  assert.equal(findEntry(entries, 25).runLength, 0, 'under a leaf');
});

/**
 * An archive of `count` one-tile entries, each tile's bytes its own id, at
 * irregular ids (gaps are tiles the archive does not have) so that the
 * directory does not compress into the root.
 */
async function makeArchive(count, { tileCompression = 1 } = {}) {
  const entries = [], data = [];
  let seed = 7, tileId = 0, offset = 0;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  for (let i = 0; i < count; i++) {
    tileId += 1 + Math.floor(rand() * 40);
    const bytes = new TextEncoder().encode(`tile ${tileId} ${'.'.repeat(Math.floor(rand() * 200))}`);
    entries.push({ tileId, offset, length: bytes.length, runLength: 1 });
    data.push(bytes);
    offset += bytes.length;
  }
  const { root, leaves } = await buildDirectories(entries);
  const dataBytes = new Uint8Array(offset);
  entries.forEach((e, i) => dataBytes.set(data[i], e.offset));
  const header = {
    rootOffset: HEADER_BYTES, rootLength: root.length,
    metadataOffset: HEADER_BYTES + root.length, metadataLength: 0,
    leafOffset: HEADER_BYTES + root.length, leafLength: leaves.length,
    dataOffset: HEADER_BYTES + root.length + leaves.length, dataLength: dataBytes.length,
    addressedTiles: count, tileEntries: count, tileContents: count, clustered: true,
    internalCompression: 2, tileCompression, tileType: 1, minZoom: 0, maxZoom: 14,
    minLon: 110, minLat: -50, maxLon: 180, maxLat: 0, centerZoom: 4, centerLon: 145, centerLat: -25,
  };
  const file = new Uint8Array(header.dataOffset + dataBytes.length);
  file.set(writeHeader(header), 0);
  file.set(root, header.rootOffset);
  file.set(leaves, header.leafOffset);
  file.set(dataBytes, header.dataOffset);
  return { file, entries, leaves };
}

/** An R2 bucket of one object, counting its reads. */
function bucketOf(key, file, etag = '"v1"') {
  const b = {
    reads: 0,
    async get(k, opts = {}) {
      if (k !== key) return null;
      b.reads++;
      const { offset = 0, length = file.length - offset } = opts.range || {};
      const slice = file.slice(offset, offset + length);
      return { httpEtag: etag, body: new Blob([slice]).stream(), arrayBuffer: async () => slice.buffer };
    },
  };
  return b;
}

test('the header reads back as it was written', async () => {
  const { file } = await makeArchive(10);
  const h = parseHeader(file);
  assert.equal(h.maxZoom, 14);
  assert.equal(h.minLon, 110);
  assert.equal(h.clustered, true);
});

/** z/x/y from a tile id: the zoom it falls in, then back along the curve. */
function tileIdToZxy(id) {
  let z = 0;
  while ((4 ** (z + 1) - 1) / 3 <= id) z++;
  let d = id - (4 ** z - 1) / 3, x = 0, y = 0;
  for (let s = 1; s < 2 ** z; s *= 2) {
    const rx = Math.floor(d / 2) & 1, ry = (d ^ rx) & 1;
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
      [x, y] = [y, x];
    }
    x += s * rx; y += s * ry;
    d = Math.floor(d / 4);
  }
  return [z, x, y];
}

const tileRequest = (env, [z, x, y]) => serveTile({
  env, request: new Request(`https://orthodoxy.au/tiles/oceania/${z}/${x}/${y}.mvt`),
  params: { archive: 'oceania', z: String(z), x: String(x), y: `${y}.mvt` },
});

test('a tile comes out of a leaf directory as an ordinary cacheable file', async () => {
  forgetTileArchives();
  const { file, entries, leaves } = await makeArchive(60000);
  assert.ok(leaves.length > 0, 'the archive is big enough to need leaves');
  const env = { ASSETS_BUCKET: bucketOf('tiles/oceania.pmtiles', file) };
  const i = entries.findIndex((e, k) => k > 30000 && entries[k + 1].tileId > e.tileId + 1);
  const want = entries[i].tileId;
  assert.equal(zxyToTileId(...tileIdToZxy(want)), want);

  const res = await tileRequest(env, tileIdToZxy(want));
  assert.equal(res.status, 200);
  assert.match(await res.text(), new RegExp(`^tile ${want} `));
  assert.equal(res.headers.get('cache-control'), TILE_CACHE_CONTROL);
  assert.equal(res.headers.get('content-type'), 'application/vnd.mapbox-vector-tile');
  assert.equal(res.headers.get('content-encoding'), null, 'an uncompressed archive sends it as it is');

  // A tile the archive does not have (open sea) is empty, not an error.
  const missing = await tileRequest(env, tileIdToZxy(want + 1));
  assert.equal(missing.status, 204);
});

test('gzipped tiles go out gzipped, with the encoding said', async () => {
  // A one-entry archive whose tile is gzip bytes, as the real basemap's are.
  const tile = await gzip(new TextEncoder().encode('vector tile'));
  const entries = [{ tileId: 0, offset: 0, length: tile.length, runLength: 1 }];
  const { root } = await buildDirectories(entries);
  const h = {
    rootOffset: HEADER_BYTES, rootLength: root.length, metadataOffset: 0, metadataLength: 0,
    leafOffset: 0, leafLength: 0, dataOffset: HEADER_BYTES + root.length, dataLength: tile.length,
    addressedTiles: 1, tileEntries: 1, tileContents: 1, clustered: true, internalCompression: 2,
    tileCompression: 2, tileType: 1, minZoom: 0, maxZoom: 0, minLon: 0, minLat: 0, maxLon: 0, maxLat: 0,
    centerZoom: 0, centerLon: 0, centerLat: 0,
  };
  const file = new Uint8Array(h.dataOffset + tile.length);
  file.set(writeHeader(h), 0); file.set(root, HEADER_BYTES); file.set(tile, h.dataOffset);
  forgetTileArchives();
  const env = { ASSETS_BUCKET: bucketOf('tiles/oceania.pmtiles', file, '"v2"') };
  const res = await serveTile({ env, request: new Request('https://orthodoxy.au/tiles/oceania/0/0/0.mvt'),
    params: { archive: 'oceania', z: '0', x: '0', y: '0.mvt' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-encoding'), 'gzip');
  assert.equal(res.headers.get('x-tile-encoding'), null);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), tile);
  // Past the archive's zooms: nothing, and no read of R2 for it.
  const reads = env.ASSETS_BUCKET.reads;
  const deep = await serveTile({ env, request: new Request('https://orthodoxy.au/tiles/oceania/3/1/1.mvt'),
    params: { archive: 'oceania', z: '3', x: '1', y: '1.mvt' } });
  assert.equal(deep.status, 204);
  assert.equal(env.ASSETS_BUCKET.reads, reads);
});

test('the edge cache keeps a tile under its path and the version, whatever was asked', async () => {
  const tile = await gzip(new TextEncoder().encode('vector tile'));
  const entries = [{ tileId: 0, offset: 0, length: tile.length, runLength: 1 }];
  const { root } = await buildDirectories(entries);
  const h = {
    rootOffset: HEADER_BYTES, rootLength: root.length, metadataOffset: 0, metadataLength: 0,
    leafOffset: 0, leafLength: 0, dataOffset: HEADER_BYTES + root.length, dataLength: tile.length,
    addressedTiles: 1, tileEntries: 1, tileContents: 1, clustered: true, internalCompression: 2,
    tileCompression: 2, tileType: 1, minZoom: 0, maxZoom: 0, minLon: 0, minLat: 0, maxLon: 0, maxLat: 0,
    centerZoom: 0, centerLon: 0, centerLat: 0,
  };
  const file = new Uint8Array(h.dataOffset + tile.length);
  file.set(writeHeader(h), 0); file.set(root, HEADER_BYTES); file.set(tile, h.dataOffset);
  forgetTileArchives();
  const env = { ASSETS_BUCKET: bucketOf('tiles/oceania.pmtiles', file, '"v3"') };
  const kept = new Map();
  const before = globalThis.caches;
  globalThis.caches = { default: {
    async match(req) { const r = kept.get(req.url); return r && r.clone(); },
    async put(req, res) { kept.set(req.url, res); },
  } };
  try {
    const params = { archive: 'oceania', z: '0', x: '0', y: '0.mvt' };
    const first = await serveTile({ env, request: new Request('https://orthodoxy.au/tiles/oceania/0/0/0.mvt?v=2'), params });
    assert.deepEqual(new Uint8Array(await first.arrayBuffer()), tile);
    const key = `https://orthodoxy.au/tiles/oceania/0/0/0.mvt?v=${TILE_CACHE_VERSION}`;
    assert.deepEqual([...kept.keys()], [key]);
    // Kept with no Content-Encoding, which came back out of the cache gzipped again.
    assert.equal(kept.get(key).headers.get('content-encoding'), null);
    assert.equal(kept.get(key).headers.get('x-tile-encoding'), 'gzip');
    // A copy kept under the bare address, as the first tiles were, is never served.
    kept.set('https://orthodoxy.au/tiles/oceania/0/0/0.mvt', new Response('gzipped twice'));
    const reads = env.ASSETS_BUCKET.reads;
    const again = await serveTile({ env, request: new Request('https://orthodoxy.au/tiles/oceania/0/0/0.mvt'), params });
    assert.equal(again.headers.get('content-encoding'), 'gzip');
    assert.deepEqual(new Uint8Array(await again.arrayBuffer()), tile);
    assert.equal(env.ASSETS_BUCKET.reads, reads, 'the second answer is the kept one');
  } finally {
    if (before === undefined) delete globalThis.caches; else globalThis.caches = before;
  }
});

test('only a known archive and a well-formed tile are asked for', async () => {
  const env = { ASSETS_BUCKET: { get() { throw new Error('R2 must not be read'); } } };
  for (const params of [
    { archive: 'planet', z: '0', x: '0', y: '0.mvt' },
    { archive: 'oceania', z: '0', x: '0', y: '0.png' },
    { archive: 'oceania', z: 'a', x: '0', y: '0.mvt' },
  ]) {
    const res = await serveTile({ env, request: new Request('https://orthodoxy.au/x'), params });
    assert.equal(res.status, 404);
  }
});
