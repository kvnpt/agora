// What a person keeps: favourites, their lists of parishes, bookmarks and
// saved views. Each lives in this browser's localStorage under the current
// app's keys; signed in, the same four also live on the account (one row of
// `saved_items`, keyed by the address Access verified), so a phone and a
// laptop show the same star.
//
// Shared because two readers have to agree on the shape: the page, which
// writes these keys (public/next/next.js), and the Worker, which stores them
// and must refuse anything else (worker/routes/admin.mjs). `clean` is the one
// definition of a valid copy, and `merge` the one way two copies become one.
//
// Merging happens once per browser and account: the first time a browser
// signs in, what it kept as a visitor is added to the account, never put in
// its place. After that the account is the copy, and a removal on one device
// is a removal everywhere — which a union every time could never do.
//
// Same dual-mode wrapper as its neighbours.
(function (root) {
  const isCjs = typeof module === 'object' && !!module.exports;

  /** localStorage keys, as the current app named them. */
  const KEYS = {
    favourites: 'agora-favourites',
    lists: 'agora-lists',
    bookmarks: 'agora-bookmarks',
    views: 'agora-saved-filters',
  };
  const PARTS = Object.keys(KEYS);

  // Generous for a person, small for a row: a copy at every cap is well under
  // MAX_BYTES, which the Worker checks before it parses.
  const LIMITS = { favourites: 500, lists: 50, listIds: 500, bookmarks: 1000, views: 100 };
  const MAX_BYTES = 256 * 1024;

  const str = (v, max) => (typeof v === 'string' || typeof v === 'number') && String(v).trim()
    ? String(v).trim().slice(0, max) : null;
  const time = (v) => Number.isFinite(+v) && +v > 0 ? Math.round(+v) : 0;
  const arr = (v) => Array.isArray(v) ? v : [];
  /** Newest first, each key once (the first seen wins), at most `n`. */
  function uniq(items, keyOf, n) {
    const seen = new Set(), out = [];
    for (const x of items) {
      const k = keyOf(x);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(x);
    }
    return out.sort((a, b) => b.at - a.at).slice(0, n);
  }

  const cleanFav = (f) => { const id = str(f && f.id, 200); return id && { id, at: time(f.at) }; };
  const cleanMark = (b) => {
    const id = str(b && b.id, 200);
    const kind = b && (b.kind === 'rule' || b.kind === 'event') ? b.kind : null;
    return id && kind && { id, kind, at: time(b.at) };
  };
  const cleanView = (v) => {
    const path = str(v && v.path, 500);
    if (!path || path[0] !== '/' || path === '/' || path.startsWith('//')) return null;
    return { path, at: time(v.at) };
  };
  function cleanList(l) {
    const id = str(l && l.id, 40);
    if (!id || id === 'fav') return null;
    const ids = [...new Set(arr(l.ids).map(x => str(x, 200)).filter(Boolean))].slice(0, LIMITS.listIds);
    const out = { id, name: str(l.name, 80) || 'My list', ids, at: time(l.at) };
    const about = str(l.about, 300);
    if (about) out.about = about;
    return out;
  }
  const markKey = (b) => `${b.kind}:${b.id}`;

  /** A copy as it may be stored: the four parts, each item checked, capped. */
  function clean(doc) {
    const d = doc && typeof doc === 'object' ? doc : {};
    return {
      favourites: uniq(arr(d.favourites).map(cleanFav).filter(Boolean), f => f.id, LIMITS.favourites),
      lists: uniq(arr(d.lists).map(cleanList).filter(Boolean), l => l.id, LIMITS.lists),
      bookmarks: uniq(arr(d.bookmarks).map(cleanMark).filter(Boolean), markKey, LIMITS.bookmarks),
      views: uniq(arr(d.views).map(cleanView).filter(Boolean), v => v.path, LIMITS.views),
    };
  }

  /** The earlier of two times, ignoring a missing one. */
  const first = (a, b) => (a && b ? Math.min(a, b) : a || b);

  /**
   * Two copies as one: everything in either. An item in both keeps the time it
   * was first added. A list is the same list only by its id: two lists of one
   * name can hold different parishes ("Sydney" saved from two different
   * views), so both are kept, and the page tells them apart by name
   * (freeName in next.js).
   */
  function merge(a, b) {
    const x = clean(a), y = clean(b);
    const byKey = (items, keyOf) => {
      const m = new Map();
      for (const it of items) {
        const k = keyOf(it), had = m.get(k);
        m.set(k, had ? { ...had, at: first(had.at, it.at) } : it);
      }
      return [...m.values()];
    };
    const lists = [];
    for (const l of [...x.lists, ...y.lists]) {
      const same = lists.find(o => o.id === l.id);
      if (!same) { lists.push({ ...l, ids: l.ids.slice() }); continue; }
      for (const id of l.ids) if (!same.ids.includes(id)) same.ids.push(id);
      same.at = first(same.at, l.at);
      if (!same.about && l.about) same.about = l.about;
    }
    return clean({
      favourites: byKey([...x.favourites, ...y.favourites], f => f.id),
      lists,
      bookmarks: byKey([...x.bookmarks, ...y.bookmarks], markKey),
      views: byKey([...x.views, ...y.views], v => v.path),
    });
  }

  /** Is there anything in it? */
  const isEmpty = (doc) => PARTS.every(p => !clean(doc)[p].length);
  /** Do two copies hold the same things? */
  const same = (a, b) => JSON.stringify(clean(a)) === JSON.stringify(clean(b));

  const api = { KEYS, PARTS, LIMITS, MAX_BYTES, clean, merge, isEmpty, same };
  if (isCjs) module.exports = api;
  else if (root) root.AgoraSaved = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
