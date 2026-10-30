// The page saved to a phone's Home Screen opens with no signal
// (docs/architecture.md, "Saved to a Home Screen").
//
// Network first, always. Online, every request goes out exactly as it would
// without this file, so a deploy or an /admin edit shows at once. What comes
// back is kept, and handed out only when the network fails: the page, its
// scripts, styles, sprites and logos, and the last bundle. So the app opens to
// the last feed it saw instead of an error.
//
// Not kept: map tiles (the browser's own cache keeps them), posters, /admin,
// and every /api/ path but the bundle. They still go out through here, not
// around it: Safari sends a request this file lets fall through past its own
// HTTP cache, so a tile or a poster came down again on every visit (measured
// in the iOS Simulator, 30 Oct 2026). To retire this file, deploy one that
// unregisters itself: deleting it leaves phones with the copy they have.
const CACHE = 'agora-offline-v1';
const SHELL = '/';
const BUNDLE = '/api/bundle';
const NEVER = /^\/(api|admin|tiles|posters|cdn-cgi)(\/|$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.add(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n))))
    .then(() => self.clients.claim()));
});

/** Where a response is kept, or null for a request this file leaves alone. */
function keyFor(request) {
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || request.method !== 'GET' || request.headers.has('range')) return null;
  // The bundle under one key whatever its window: offline, the last one is the one.
  if (url.pathname === BUNDLE) return BUNDLE;
  if (NEVER.test(url.pathname)) return null;
  return url.pathname;
}

// The first visit's scripts, styles and bundle loaded before this file was
// there to keep them; the page sends their addresses once it is (index.html).
self.addEventListener('message', (event) => {
  const urls = event.data && event.data.keep;
  if (!Array.isArray(urls)) return;
  event.waitUntil(caches.open(CACHE).then((c) => Promise.all(urls.map((url) => {
    const key = keyFor(new Request(url));
    return key && fetch(url).then((res) => res.ok && c.put(key, res)).catch(() => {});
  }))));
});

/** Ours, a GET, and not a page: what goes out through here even when it is not kept. */
function passes(request) {
  return new URL(request.url).origin === self.location.origin && request.method === 'GET' && request.mode !== 'navigate';
}

self.addEventListener('fetch', (event) => {
  const key = keyFor(event.request);
  if (!key) {
    // Exactly as it would go without this file, and nothing kept; only not
    // left to fall through, which Safari sends past its HTTP cache.
    if (passes(event.request)) event.respondWith(fetch(event.request));
    return;
  }
  event.respondWith((async () => {
    try {
      const res = await fetch(event.request);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        event.waitUntil(caches.open(CACHE).then((c) => c.put(key, copy)));
      }
      return res;
    } catch (err) {
      // Every link is the one page, which reads its own address: a link never
      // opened before still opens, as the page kept from any other.
      const kept = await caches.match(key)
        || (event.request.mode === 'navigate' ? await caches.match(SHELL) : undefined);
      if (kept) return kept;
      throw err;
    }
  })());
});
