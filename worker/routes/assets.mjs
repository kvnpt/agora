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
// poster_path are stored in the database as '/logos/x.png', and map.js asks for
// 'pmtiles:///tiles/oceania.pmtiles'. Keeping the URLs identical means no data
// migration and no frontend edit.

import { json } from '../lib/router.mjs';

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

export function registerAssetRoutes(router) {
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
