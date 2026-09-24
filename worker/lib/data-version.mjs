// When did the public data last change, and a cached answer built on it.
//
// /api/bundle used to be served `max-age=60, stale-while-revalidate=600`, and
// nothing ever asked the server whether it had moved on: for eleven minutes a
// browser would hand back its own copy without a request. The person that hurt
// most was an admin — change a service in /admin, press Back to app, and the
// app drew the old one from the browser's cache while a private window showed
// the new one.
//
// Now every load asks, and asking is cheap:
//
//   • The browser gets `Cache-Control: no-cache` and an ETag, so it revalidates
//     on every use and a matching ETag costs a 304 with no body.
//   • The ETag is a hash of the body, so it changes exactly when the answer
//     does — including for writes that never pass through the Worker (an
//     import run from a terminal straight into D1).
//   • The body is kept in the edge cache under a DATA VERSION, which every
//     successful admin write and every scrape bumps. A bump changes the key, so
//     the next request rebuilds; nobody has to find and purge the old entry.
//
// The version lives in one small R2 object rather than a D1 row. R2 reads are
// strongly consistent everywhere, and keeping it out of D1 means no migration
// has to land in production before this code does. It is read at most once
// per VERSION_TTL per Cloudflare location — the edge cache holds it between —
// and the location that makes a write stores the new value there at once, so
// the admin's own next load (which lands on the same location) sees it.
// Everywhere else sees it within VERSION_TTL.
//
// Writes that bypass the Worker do not bump the version. BODY_TTL bounds how
// long those can hide: the cached body expires and is rebuilt, its hash
// differs, and browsers pick it up on their next revalidation.

const VERSION_KEY = 'meta/data-version';
export const VERSION_TTL = 15;        // seconds a location trusts its copy of the version
export const BODY_TTL = 600;          // seconds a cached body may outlive an unbumped change

const edgeCache = () =>
  (typeof caches !== 'undefined' && caches && caches.default) ? caches.default : null;

// Cache API keys have to be URLs. They are never fetched: a key under the
// request's own origin just keeps the entries in this zone's cache.
const versionKey = (origin) => `${origin}/__cache/data-version`;
const bodyKey = (origin, version, name) =>
  `${origin}/__cache/${encodeURIComponent(version)}/${name}`;

/** The current data version. '0' when none has ever been written. */
export async function currentVersion(env, origin, cache = edgeCache()) {
  if (cache) {
    const hit = await cache.match(versionKey(origin)).catch(() => null);
    if (hit) return hit.text();
  }
  let version = '0';
  if (env.ASSETS_BUCKET) {
    const obj = await env.ASSETS_BUCKET.get(VERSION_KEY).catch(() => null);
    if (obj) version = (await obj.text()).trim() || '0';
  }
  if (cache) await putVersion(cache, origin, version);
  return version;
}

function putVersion(cache, origin, version) {
  return cache.put(versionKey(origin), new Response(version, {
    headers: { 'cache-control': `public, max-age=${VERSION_TTL}` },
  })).catch(() => {});
}

/**
 * Record that the public data changed. Awaited by the caller rather than left
 * to waitUntil: the admin's very next request must see the new version, and a
 * bump still in flight when it arrives would hand it the old body.
 */
export async function bumpVersion(env, origin, cache = edgeCache()) {
  const version = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  if (env.ASSETS_BUCKET) {
    await env.ASSETS_BUCKET.put(VERSION_KEY, version, {
      httpMetadata: { contentType: 'text/plain', cacheControl: 'no-store' },
    });
  }
  if (cache && origin) await putVersion(cache, origin, version);
  return version;
}

/** Does this request's If-None-Match already hold `etag`? Weak or strong. */
export function etagMatches(ifNoneMatch, etag) {
  if (!ifNoneMatch || !etag) return false;
  const bare = (t) => t.trim().replace(/^W\//, '');
  const want = bare(etag);
  return ifNoneMatch.split(',').some(t => t.trim() === '*' || bare(t) === want);
}

async function hashEtag(body) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest)].slice(0, 16)
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return `"${hex}"`;
}

/**
 * Serve a JSON body that is expensive to build and changes rarely.
 *
 * `name` identifies the answer within a version (the route and its
 * parameters); `build` produces the object. Returns a 304 when the browser
 * already holds this exact body, and never lets a browser reuse one without
 * asking first.
 */
export async function cachedJson({ request, env, ctx, name, build, cache = edgeCache() }) {
  const origin = new URL(request.url).origin;
  const version = await currentVersion(env, origin, cache);
  const key = bodyKey(origin, version, name);

  let body = null, etag = null;
  const hit = cache ? await cache.match(key).catch(() => null) : null;
  if (hit) {
    etag = hit.headers.get('etag');
    body = await hit.text();
  } else {
    body = JSON.stringify(await build());
    etag = await hashEtag(body);
    if (cache) {
      const put = cache.put(key, new Response(body, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          etag,
          'cache-control': `public, max-age=${BODY_TTL}`,
        },
      })).catch(() => {});
      if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
    }
  }

  const headers = {
    etag,
    // Revalidate on every use. What makes that cheap is the 304 below, not a
    // lifetime during which the browser answers for us.
    'cache-control': 'no-cache',
    'x-data-version': version,
  };
  if (etagMatches(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * Should this request, having got this response, bump the version?
 *
 * Every successful write under /api/admin/. Not a list of routes that touch
 * the bundle: a list is a thing a new route forgets to join, and a bump nobody
 * needed costs one rebuild. The whole of the panel is a write to public data or
 * near enough, and the handful that are not (people, asks) are rare.
 */
export function isDataWrite(request, response) {
  if (!response || response.status < 200 || response.status >= 300) return false;
  if (request.method === 'GET' || request.method === 'HEAD' || request.method === 'OPTIONS') return false;
  return new URL(request.url).pathname.startsWith('/api/admin/');
}
