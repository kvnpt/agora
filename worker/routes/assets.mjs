// Binary assets out of R2: map tiles, parish logos, event posters.
//
// These lived on the VM's disk — /opt/agora/tiles mounted read-only, and
// /opt/agora/data/{logos,posters} written by the admin panel. Express served
// them with express.static.
//
// RANGE REQUESTS ARE THE POINT. PMTiles is a single multi-hundred-megabyte
// archive that the map client reads a few kilobytes at a time using HTTP byte
// serving. Without a correct 206 the map fails with exactly the error the
// browser test surfaced: "Server returned no content-length header or
// content-length exceeding request. Check that your storage backend supports
// HTTP Byte Serving." R2 supports ranged reads natively; this translates
// between the HTTP header and R2's range option, which is the whole reason the
// tiles can move off a disk at all.
//
// Paths are unchanged from the Express app on purpose: logo_path and
// poster_path are stored in the database as '/logos/x.png'. Keeping the URLs
// identical meant no data migration. map.js no longer reads the archive
// whole; it asks for single tiles (serveTile, below).

import { json } from '../lib/router.mjs';
import { ROOT_BYTES, parseHeader, parseDirectory, decompress, zxyToTileId, locateTile } from '../lib/pmtiles.mjs';

// Long cache: tiles are immutable, and a logo change writes a new object.
const CACHE_CONTROL = {
  tiles: 'public, max-age=604800, immutable',   // 7 days
  logos: 'public, max-age=86400',               // 1 day
  posters: 'public, max-age=86400',
};

/** Parse `Range: bytes=start-end`. Returns null when absent or unsatisfiable-by-syntax. */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null;
  const [, rawStart, rawEnd] = m;

  if (rawStart === '' && rawEnd === '') return null;

  // Suffix form: "bytes=-500" means the LAST 500 bytes.
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!suffix) return null;
    const start = Math.max(0, size - suffix);
    return { offset: start, length: size - start };
  }

  const start = Number(rawStart);
  if (start >= size) return { unsatisfiable: true };
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (end < start) return { unsatisfiable: true };
  return { offset: start, length: end - start + 1 };
}

async function serve(env, kind, key, request) {
  if (!env.ASSETS_BUCKET) {
    return json({ error: 'Asset storage not configured', detail: 'R2 binding ASSETS_BUCKET is missing' }, 503);
  }

  // HEAD first so a range can be validated against the real size without
  // pulling the body.
  const head = await env.ASSETS_BUCKET.head(key);
  if (!head) return json({ error: 'Not found' }, 404);

  const headers = new Headers();
  head.writeHttpMetadata(headers);
  headers.set('etag', head.httpEtag);
  headers.set('accept-ranges', 'bytes');
  headers.set('cache-control', headers.get('cache-control') || CACHE_CONTROL[kind] || 'public, max-age=3600');

  // Conditional request — cheap win for tiles, which are requested constantly.
  if (request.headers.get('if-none-match') === head.httpEtag) {
    return new Response(null, { status: 304, headers });
  }

  const range = parseRange(request.headers.get('range'), head.size);

  if (range && range.unsatisfiable) {
    headers.set('content-range', `bytes */${head.size}`);
    return new Response(null, { status: 416, headers });
  }

  if (request.method === 'HEAD') {
    headers.set('content-length', String(head.size));
    return new Response(null, { status: 200, headers });
  }

  if (range) {
    const obj = await env.ASSETS_BUCKET.get(key, { range: { offset: range.offset, length: range.length } });
    if (!obj) return json({ error: 'Not found' }, 404);
    const end = range.offset + range.length - 1;
    headers.set('content-range', `bytes ${range.offset}-${end}/${head.size}`);
    headers.set('content-length', String(range.length));
    return new Response(obj.body, { status: 206, headers });
  }

  const obj = await env.ASSETS_BUCKET.get(key);
  if (!obj) return json({ error: 'Not found' }, 404);
  headers.set('content-length', String(head.size));
  return new Response(obj.body, { status: 200, headers });
}

// Reject traversal and absolute keys before they reach R2.
const safeKey = (p) => (p && !p.includes('..') && !p.startsWith('/')) ? p : null;

// ── The basemap, a tile at a time ───────────────────────────────────────
//
// /tiles/oceania/{z}/{x}/{y}.mvt: one tile out of the archive, as an ordinary
// file. The page used to read the archive itself with range requests (header,
// then directory, then tile: three trips before the first tile), and Safari
// keeps no range response, so every visit fetched every tile again. Here the
// Worker does the reading, near R2, and the browser gets a 200 it keeps a day
// and the edge keeps for everyone. The archive's own URL above still answers
// ranges, for anything that reads it whole.
//
// A tile can change only when the archive is rebuilt (.github/workflows/
// basemap.yml), rarely and by hand, so a day's caching costs at worst a day of
// old tiles beside new ones after a rebuild.
export const TILE_ARCHIVES = { oceania: 'tiles/oceania.pmtiles' };
export const TILE_CACHE_CONTROL = 'public, max-age=86400, stale-while-revalidate=604800';
// What this isolate knows of each archive: header, root directory, the leaf
// directories it has read. The header is read again every few minutes, and a
// new ETag (a rebuilt archive) throws the rest away.
const ARCHIVE_RECHECK_MS = 5 * 60 * 1000;
const LEAVES_KEPT = 64;
const archives = new Map();
/** Forget every archive this isolate has read (tests: one archive, then another). */
export function forgetTileArchives() { archives.clear(); }

async function openArchive(env, key) {
  const had = archives.get(key);
  if (had && Date.now() - had.checkedAt < ARCHIVE_RECHECK_MS) return had;
  const obj = await env.ASSETS_BUCKET.get(key, { range: { offset: 0, length: ROOT_BYTES } });
  if (!obj) return null;
  if (had && had.etag === obj.httpEtag) { had.checkedAt = Date.now(); return had; }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const header = parseHeader(bytes);
  const rootBytes = bytes.subarray(header.rootOffset, header.rootOffset + header.rootLength);
  const archive = {
    etag: obj.httpEtag, checkedAt: Date.now(), header,
    root: parseDirectory(await decompress(rootBytes, header.internalCompression)),
    leaves: new Map(),
  };
  archives.set(key, archive);
  return archive;
}

async function readLeaf(env, key, archive, entry) {
  const at = archive.header.leafOffset + entry.offset;
  let leaf = archive.leaves.get(at);
  if (!leaf) {
    const obj = await env.ASSETS_BUCKET.get(key, { range: { offset: at, length: entry.length } });
    if (!obj) throw new Error('pmtiles: leaf directory missing');
    leaf = parseDirectory(await decompress(new Uint8Array(await obj.arrayBuffer()), archive.header.internalCompression));
    if (archive.leaves.size >= LEAVES_KEPT) archive.leaves.delete(archive.leaves.keys().next().value);
    archive.leaves.set(at, leaf);
  }
  return leaf;
}

/** One tile, from the edge cache or the archive. Exported for tests. */
export async function serveTile({ env, ctx, request, params }) {
  const key = TILE_ARCHIVES[params.archive];
  const y = /^(\d+)\.mvt$/.exec(params.y || '');
  const z = Number(params.z), x = Number(params.x);
  if (!key || !y || !/^\d+$/.test(params.z) || !/^\d+$/.test(params.x)) return json({ error: 'Not found' }, 404);
  if (!env.ASSETS_BUCKET) return json({ error: 'Asset storage not configured' }, 503);

  const cache = (typeof caches !== 'undefined' && caches && caches.default) ? caches.default : null;
  const hit = cache && await cache.match(request);
  if (hit) return hit;

  const archive = await openArchive(env, key);
  if (!archive) return json({ error: 'Not found' }, 404);
  let tileId;
  try { tileId = zxyToTileId(z, x, Number(y[1])); } catch { return json({ error: 'Not found' }, 404); }

  const headers = new Headers({ 'cache-control': TILE_CACHE_CONTROL });
  const loc = (z >= archive.header.minZoom && z <= archive.header.maxZoom)
    ? await locateTile(archive.header, archive.root, tileId, (e) => readLeaf(env, key, archive, e))
    : null;
  let res;
  if (!loc) {
    // Open sea, or past the region: no tile, which MapLibre draws as empty
    // without calling it an error.
    res = new Response(null, { status: 204, headers });
  } else {
    const obj = await env.ASSETS_BUCKET.get(key, { range: { offset: loc.offset, length: loc.length } });
    if (!obj) return json({ error: 'Not found' }, 404);
    headers.set('content-type', 'application/vnd.mapbox-vector-tile');
    headers.set('etag', `"${String(archive.etag).replace(/"/g, '')}-${tileId}"`);
    // The archive keeps its tiles gzipped: they go out as they are, and the
    // browser undoes it.
    if (archive.header.tileCompression === 2) headers.set('content-encoding', 'gzip');
    res = new Response(obj.body, { headers, encodeBody: 'manual' });
  }
  if (cache) {
    const put = cache.put(request, res.clone()).catch(() => {});
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(put);
  }
  return res;
}

export function registerAssetRoutes(router) {
  router.get('/tiles/:archive/:z/:x/:y', serveTile);
  for (const kind of ['tiles', 'logos', 'posters']) {
    // The router matches one segment, which is all these need.
    router.get(`/${kind}/:name`, async ({ env, params, request }) => {
      const name = safeKey(params.name);
      if (!name) return json({ error: 'Bad request' }, 400);
      return serve(env, kind, `${kind}/${name}`, request);
    });
    router.add('HEAD', `/${kind}/:name`, async ({ env, params, request }) => {
      const name = safeKey(params.name);
      if (!name) return json({ error: 'Bad request' }, 400);
      return serve(env, kind, `${kind}/${name}`, request);
    });
  }
}
