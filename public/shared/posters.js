// A poster is one picture, or several shown as a gallery to swipe through.
//
// Kevin, 27 Nov 2026: "I want posters to follow the insta-style multi-pic
// format when there's multiple ones instead of the combining we've been
// doing. Same applies to PDFs". Until then a WhatsApp forward of several
// pictures, several chosen at once under Add an image, and a PDF's pages were
// all joined side by side into one picture, each part too small to read on a
// phone. Now each stays a picture of its own, in order, and the card shows
// one at a time with a dot for each, as Instagram does.
//
// WHERE IT IS KEPT. The same columns as ever (events.poster_path,
// schedules.poster_path, schedule_overrides.patch_poster_path,
// drafts.poster_path), so a gallery goes wherever a poster goes — published
// from a draft, put on a range of dates, made a rule's own — with nothing
// else to carry. One picture is its path, '/posters/<key>', exactly as it was.
// Several are a JSON list of those paths, in order: the value starts with
// '[', which no path does. Nothing else about a poster changed, so a value
// written before this file is read as it always was.
//
// What only a picture can be (an og:image, a thumbnail in a list, a sign's
// source line) is the FIRST picture: the cover, as it is on Instagram.
//
// Same dual-mode wrapper as its neighbours: window.AgoraPosters for the page
// and /admin, module.exports for the Worker (worker/lib/page-card.mjs paints
// the same gallery into a link's card, worker/lib/poster-range.mjs counts
// its pictures) and the tests.
(function (root) {
  /** The most pictures one poster holds: Instagram's ten, and a programme's pages. */
  const MAX = 10;

  const isPath = (s) => typeof s === 'string' && s.trim() !== '';

  /** Every picture of a poster value, in order: [] for none. */
  function list(value) {
    if (Array.isArray(value)) return value.filter(isPath);
    const v = typeof value === 'string' ? value.trim() : '';
    if (!v) return [];
    if (v[0] !== '[') return [v];
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) ? a.filter(isPath) : [];
    } catch {
      return [];
    }
  }

  /** The cover: the first picture, or null. */
  const first = (value) => list(value)[0] || null;
  /** How many pictures. */
  const count = (value) => list(value).length;
  /** Several pictures, shown as a gallery. */
  const isGallery = (value) => count(value) > 1;

  /**
   * The value that holds these pictures: null for none, the path for one
   * (as a poster always was), a JSON list for several — each once, in order,
   * the first MAX.
   */
  function valueOf(paths) {
    const seen = new Set();
    const l = [];
    for (const p of list(paths)) {
      if (seen.has(p)) continue;
      seen.add(p);
      l.push(p);
    }
    const some = l.slice(0, MAX);
    return !some.length ? null : some.length === 1 ? some[0] : JSON.stringify(some);
  }

  // ── The gallery ─────────────────────────────────────────────────────
  //
  // One row of pictures that scrolls sideways a picture at a time (CSS scroll
  // snap, so a finger swipes it and nothing has to be running for that), a
  // dot for each under it, the one shown in the user's blue, and on a screen
  // with a mouse an arrow at each side. Each picture is a link to itself, so
  // a card painted by the Worker opens it before any script has come; the
  // page's own click opens its viewer there instead (next.js openPoster).
  //
  // The page draws its boxes again and again, changing what differs
  // (shared/morph.js), and which picture is showing is in no markup. So the
  // gallery is an island there (data-keep), named by its pictures: the same
  // poster drawn again is left exactly as it is, scrolled where it was, and
  // another poster is another island.

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CHEVRON = (d) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"/></svg>`;
  const PREV = CHEVRON('m15 5-7 7 7 7');
  const NEXT = CHEVRON('m9 5 7 7-7 7');
  /** Instagram's mark for a post of several: two cards, one behind the other. */
  const MARK = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><rect x="3" y="7" width="13" height="14" rx="2.5"/><path d="M8 3.5h10.5A2.5 2.5 0 0 1 21 6v11"/></svg>';

  /**
   * A gallery's markup. `value` is the poster; `at` the picture showing first.
   *   label   what a picture is, for a screen reader: "Picture 2 of 3, full size"
   *   picAttrs (src, i) => more attributes for a picture's <img>
   *   keep    false where nothing redraws the box (the editor, a viewer)
   *   link    false for pictures that are not links to themselves (the
   *           viewer, where a tap puts it away; the editor, whose own tap
   *           opens the viewer): each says its place in `data-poster-at`
   */
  function galleryHTML(value, { cls = '', label = 'full size', picAttrs = null, keep = true, link = true } = {}) {
    const pics = list(value);
    const n = pics.length;
    if (!n) return '';
    const v = valueOf(pics);
    const img = (src, i) => {
      const more = picAttrs ? ` ${picAttrs(src, i)}` : '';
      // The first two now; the rest as the gallery comes near them (wire).
      const lazy = i > 1 ? ' loading="lazy"' : '';
      return `<img src="${esc(src)}" alt=""${lazy}${more}>`;
    };
    const slides = pics.map((src, i) => (link
      ? `<a class="pg-pic" href="${esc(src)}" target="_blank" rel="noopener" data-poster="${esc(v)}" data-poster-at="${i}" aria-label="Picture ${i + 1} of ${n}, ${esc(label)}">${img(src, i)}</a>`
      : `<div class="pg-pic" data-poster-at="${i}">${img(src, i)}</div>`)).join('');
    const dots = pics.map((_, i) => `<button type="button" class="pg-dot${i ? '' : ' on'}" data-pg-to="${i}" aria-label="Picture ${i + 1}"${i ? '' : ' aria-current="true"'}></button>`).join('');
    return `<div class="pg${cls ? ` ${cls}` : ''}"${keep ? ` data-keep="pg ${esc(v)}"` : ''} data-pg-n="${n}" role="group" aria-roledescription="gallery" aria-label="${n} pictures">
      <div class="pg-track">${slides}</div>
      <button type="button" class="pg-arrow pg-prev" data-pg-step="-1" aria-label="Previous picture" hidden>${PREV}</button>
      <button type="button" class="pg-arrow pg-next" data-pg-step="1" aria-label="Next picture">${NEXT}</button>
      <div class="pg-dots">${dots}</div>
    </div>`;
  }

  /** The mark on a thumbnail of a poster of several pictures ('' for one); a value, or how many. */
  const markHTML = (value) => {
    const n = typeof value === 'number' ? value : count(value);
    return n > 1 ? `<span class="pg-mark" aria-label="${n} pictures" title="${n} pictures">${MARK}</span>` : '';
  };

  // ── Live ────────────────────────────────────────────────────────────
  //
  // Once for the document, for every gallery in it, whoever drew it (the
  // page, the Worker's paint, the editor): its dots and arrows follow its
  // scroll, and a dot or an arrow scrolls it.

  /** Which picture a gallery is showing. */
  function indexOf(g) {
    const t = g.querySelector('.pg-track');
    if (!t || !t.clientWidth) return 0;
    return Math.max(0, Math.min(t.children.length - 1, Math.round(t.scrollLeft / t.clientWidth)));
  }

  /** Dots, arrows and the next picture's loading, as the gallery stands. */
  function sync(g) {
    const t = g.querySelector('.pg-track');
    if (!t) return;
    const i = indexOf(g);
    const n = t.children.length;
    g.querySelectorAll('.pg-dot').forEach((d, k) => {
      d.classList.toggle('on', k === i);
      if (k === i) d.setAttribute('aria-current', 'true');
      else d.removeAttribute('aria-current');
    });
    const prev = g.querySelector('.pg-prev'), next = g.querySelector('.pg-next');
    if (prev) prev.hidden = i <= 0;
    if (next) next.hidden = i >= n - 1;
    // The one after, and the one before, asked for now: lazily, a picture
    // off to the side of a scroller is often not asked for until it is in
    // view, blank as it slides in.
    for (const k of [i - 1, i + 1]) {
      const img = t.children[k] && t.children[k].querySelector('img[loading="lazy"]');
      if (img) img.loading = 'eager';
    }
    g.dataset.pgAt = String(i);
  }

  /** Show picture `i` of the gallery `g`. */
  function go(g, i, smooth = true) {
    const t = g.querySelector('.pg-track');
    if (!t) return;
    const k = Math.max(0, Math.min(t.children.length - 1, i));
    const reduce = root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches;
    t.scrollTo({ left: k * t.clientWidth, behavior: smooth && !reduce ? 'smooth' : 'auto' });
  }

  const wired = new WeakSet();
  function wire(doc) {
    if (!doc || wired.has(doc)) return;
    wired.add(doc);
    let frame = 0;
    const pending = new Set();
    // A scroll does not bubble; caught on its way down, every gallery's is heard here.
    doc.addEventListener('scroll', (ev) => {
      const t = ev.target;
      if (!t || !t.classList || !t.classList.contains('pg-track')) return;
      pending.add(t.parentNode);
      if (frame) return;
      frame = (root.requestAnimationFrame || setTimeout)(() => {
        frame = 0;
        for (const g of pending) sync(g);
        pending.clear();
      });
    }, true);
    doc.addEventListener('click', (ev) => {
      const b = ev.target && ev.target.closest && ev.target.closest('[data-pg-to], [data-pg-step]');
      if (!b) return;
      const g = b.closest('.pg');
      if (!g) return;
      ev.preventDefault();
      ev.stopPropagation();
      if (b.hasAttribute('data-pg-to')) go(g, Number(b.dataset.pgTo));
      else go(g, indexOf(g) + Number(b.dataset.pgStep));
    }, true);
    // ← and → on a gallery that has the focus.
    doc.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      const g = ev.target && ev.target.closest && ev.target.closest('.pg');
      if (!g || ev.target.closest('input, textarea, select, [contenteditable]')) return;
      ev.preventDefault();
      go(g, indexOf(g) + (ev.key === 'ArrowRight' ? 1 : -1));
    });
  }

  const api = { MAX, list, first, count, isGallery, valueOf, galleryHTML, markHTML, indexOf, sync, go, wire };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) {
    root.AgoraPosters = api;
    if (root.document) wire(root.document);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
