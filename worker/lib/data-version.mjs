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
  return cachedBody({
    request, env, ctx, name, cache,
    type: 'application/json; charset=utf-8',
    build: async () => JSON.stringify(await build()),
  });
}

/**
 * The same, for a page: a link's head and card (routes/pages.mjs), or
 * the sitemap. `build` returns the markup, or null when the path turned out not
 * to be a page at all — nothing is cached and the caller answers otherwise.
 */
export async function cachedHtml({ request, env, ctx, name, build, type = 'text/html; charset=utf-8', cache = edgeCache() }) {
  return cachedBody({ request, env, ctx, name, cache, type, build });
}

/**
 * The text `build` makes, kept under the data version like a body is, for a
 * caller that answers with something more than it: the page around a link
 * (routes/pages.mjs) keeps what D1 says about the link here and wraps it in
 * the page as deployed on every request, so a deploy never waits on the
 * cache. Null when `build` says the path is nothing.
 */
export async function cachedText({ request, env, ctx, name, build, cache = edgeCache() }) {
  const origin = new URL(request.url).origin;
  const version = await currentVersion(env, origin, cache);
  const key = bodyKey(origin, version, name);
  const hit = cache ? await cache.match(key).catch(() => null) : null;
  if (hit) return { text: await hit.text(), etag: hit.headers.get('etag'), version };
  const text = await build();
  if (text == null) return null;
  const etag = await hashEtag(text);
  if (cache) {
    const put = cache.put(key, new Response(text, {
      headers: { etag, 'cache-control': `public, max-age=${BODY_TTL}` },
    })).catch(() => {});
    if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
  }
  return { text, etag, version };
}

/**
 * A finished body's answer: a 304 when the browser holds this exact one, and
 * never a reuse without asking first. `etag` is the body's hash (hashEtag).
 */
export function revalidated(request, { body, etag, version, type, status = 200, headers: extra = {} }) {
  const headers = {
    etag,
    // Revalidate on every use. What makes that cheap is the 304 below, not a
    // lifetime during which the browser answers for us.
    'cache-control': 'no-cache',
    ...(version ? { 'x-data-version': version } : {}),
    ...extra,
  };
  if (status === 200 && etagMatches(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === 'HEAD' ? null : body, {
    status, headers: { 'content-type': type, ...headers },
  });
}

export { hashEtag };

async function cachedBody({ request, env, ctx, name, build, type, cache }) {
  const kept = await cachedText({ request, env, ctx, name, build, cache });
  if (!kept) return null;
  return revalidated(request, { body: kept.text, etag: kept.etag, version: kept.version, type });
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
  const path = new URL(request.url).pathname;
  if (!path.startsWith('/api/admin/')) return false;
  // A draft is the one admin write nothing public can see (lib/drafts.mjs),
  // and the editor autosaves one on every pause in typing — a bump each time
  // would rebuild the bundle for everybody for nothing. The exception is the
  // other way round from a list of routes that touch the bundle, so a draft
  // route that forgets to join it costs a rebuild, never a stale page.
  // Publishing writes `events`, and bumps like any other write. A suggestion
  // is the same — a message for a person, which the bundle never reads, and
  // starting a draft from one is a draft. An acronym suggestion writes nothing
  // at all; it is a POST only because it carries the names.
  if (/^\/api\/admin\/(drafts|draft-events|suggestions)(\/|$)/.test(path) && !path.endsWith('/publish')) return false;
  if (path === '/api/admin/acronym-suggestion') return false;
  return true;
}
