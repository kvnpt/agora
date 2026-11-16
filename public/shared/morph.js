// A box drawn again, changing only what differs.
//
// The page writes its lists as strings. Put in whole (innerHTML), every row
// was a new element and every logo and poster in it a new picture, which the
// browser draws a frame or more after the row: so each time the map moved, a
// day was tapped or a sign-in answered, the pictures on screen blinked out
// and back (Kevin, 16 Nov 2026: "I still see flashing"). A list that had not
// changed at all was torn down and built again just the same.
//
// morph(box, html) makes the box read as the markup says and touches nothing
// that already does. A row still wanted stays the element it was, where it
// was or moved to its new place, its pictures with it; only its changed words
// and attributes are written. What the markup no longer has goes, and what
// is new comes in.
//
// Which old element is which new one:
//   - A named one, by its name among its siblings (keyOf): a row by its
//     event, a day by its date, a parish by its id, a picture by its address,
//     so a list that reorders moves its rows, and only those out of their
//     order (staying). Of two with one name, the first is the one kept.
//   - An unnamed one, the next old one of its sort (same tag, same class),
//     so the furniture between rows (headings, dividers, wrappers) stays put.
//   - A picture wanted somewhere new (its row drawn afresh) is the old
//     element still, carried over (reuse).
//
// An island (data-keep="name") is the page's scripts' own: found again, it is
// left exactly as it is, children and all. The week bar is one: its dots, its
// swiped week and its listeners are not in any markup.
//
// What a person did to an element that no attribute says (a box ticked, a
// row scrolled sideways) stays, since the element does.
//
// PURE of the page: it knows nodes, not parishes. d1/morph.test.mjs runs the
// matching on a stand-in tree.

(function (root) {
  // What names an element among its siblings, first found. `data-keep` and
  // `data-key` are this file's own; the rest are what the page's rows carry.
  const NAMES = ['data-keep', 'data-key', 'id', 'data-event', 'data-date', 'data-parish', 'data-coll', 'data-mg-day', 'data-mg-layer'];

  function keyOf(n) {
    if (n.nodeType !== 1) return null;
    if (n.tagName === 'IMG') return `IMG src=${n.getAttribute('src')}`;
    for (const a of NAMES) {
      const v = n.getAttribute(a);
      if (v != null && v !== '') return `${n.tagName} ${a}=${v}`;
    }
    return null;
  }
  /** Is this unnamed old node the sort of thing the new one is? */
  function alike(old, next) {
    if (old.nodeType !== next.nodeType) return false;
    if (old.nodeType !== 1) return true;
    return old.tagName === next.tagName && keyOf(old) == null && old.getAttribute('class') === next.getAttribute('class');
  }
  const imgsOf = (n) => (n.nodeType !== 1 ? [] : n.tagName === 'IMG' ? [n] : Array.from(n.querySelectorAll('img')));

  function attrs(old, next) {
    for (let i = old.attributes.length - 1; i >= 0; i--) {
      const name = old.attributes[i].name;
      if (!next.hasAttribute(name)) old.removeAttribute(name);
    }
    for (let i = 0; i < next.attributes.length; i++) {
      const { name, value } = next.attributes[i];
      if (old.getAttribute(name) !== value) old.setAttribute(name, value);
    }
  }

  /** `old`, an element or a text, made to read as `next`. */
  function patch(old, next, ctx) {
    if (old.nodeType !== 1) {
      if (old.nodeValue !== next.nodeValue) { old.nodeValue = next.nodeValue; ctx.changed = true; }
      return;
    }
    if (old.hasAttribute('data-keep') || old.isEqualNode(next)) return;
    ctx.changed = true;
    attrs(old, next);
    children(old, next, ctx);
  }

  /**
   * The named old ones that stay where they stand: the longest run of them
   * already in the order wanted. Only the rest are moved, so a row gone from
   * the top of a list moves none of the rows under it.
   */
  function staying(from, to, named) {
    const at = new Map();
    let i = 0;
    for (let n = from.firstChild; n; n = n.nextSibling) at.set(n, i++);
    const seq = [], seen = new Set();   // the old ones wanted, in the order wanted
    for (let n = to.firstChild; n; n = n.nextSibling) {
      const k = keyOf(n);
      if (k == null || seen.has(k) || !named.has(k)) continue;
      seen.add(k);
      seq.push(at.get(named.get(k)));
    }
    // The longest rising run of `seq`: tails[j] is where the best run of j + 1 ends.
    const tails = [], prev = [];
    for (let s = 0; s < seq.length; s++) {
      let lo = 0, hi = tails.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (seq[tails[mid]] < seq[s]) lo = mid + 1; else hi = mid; }
      prev[s] = lo ? tails[lo - 1] : -1;
      tails[lo] = s;
    }
    const stay = new Set();
    for (let s = tails.length ? tails[tails.length - 1] : -1; s >= 0; s = prev[s]) stay.add(seq[s]);
    return { stay, at };
  }

  /** `from`'s children made to read as `to`'s, which are taken out of `to` as they are used. */
  function children(from, to, ctx) {
    const named = new Map();
    for (let n = from.firstChild; n; n = n.nextSibling) {
      const k = keyOf(n);
      if (k != null && !named.has(k)) named.set(k, n);
    }
    const { stay, at } = staying(from, to, named);
    // Everything before `cur` is settled, but for `left`: the old ones stepped
    // over, wanted further on or not at all. From `cur` on, the old ones not yet used.
    let cur = from.firstChild;
    const left = [], passed = new Set(), used = new Set();
    for (let next = to.firstChild; next;) {
      const after = next.nextSibling;
      const k = keyOf(next);
      let hit = null, ahead = false;   // ahead: at `cur` or after it
      if (k != null) {
        hit = named.get(k) || null;
        if (hit) { named.delete(k); ahead = !passed.has(hit); }
      } else {
        for (const n of left) if (!used.has(n) && alike(n, next)) { hit = n; break; }
        for (let n = cur; n && !hit; n = n.nextSibling) if (alike(n, next)) { hit = n; ahead = true; }
      }
      if (hit) {
        used.add(hit);
        // It stays where it stands unless something else that stays is in its
        // way: what stands between steps aside, and only a thing wanted out of
        // its order is taken out and put back.
        let free = ahead;
        for (let n = cur; free && n !== hit; n = n.nextSibling) if (stay.has(at.get(n))) free = false;
        if (free) {
          for (let n = cur; n !== hit; n = n.nextSibling) { left.push(n); passed.add(n); }
          cur = hit.nextSibling;
        } else { from.insertBefore(hit, cur); ctx.changed = true; }
        patch(hit, next, ctx);
      } else {
        from.insertBefore(next, cur);
        ctx.added.push(next);
        ctx.changed = true;
      }
      next = after;
    }
    for (const n of left) if (!used.has(n)) { from.removeChild(n); ctx.gone.push(n); ctx.changed = true; }
    while (cur) {
      const n = cur.nextSibling;
      from.removeChild(cur);
      ctx.gone.push(cur);
      ctx.changed = true;
      cur = n;
    }
  }

  /**
   * A picture in something new that was in something taken away is the old
   * element, put where the new one stands: drawn already, it shows at once.
   */
  function reuse(ctx) {
    if (!ctx.added.length || !ctx.gone.length) return;
    const had = new Map();
    for (const n of ctx.gone) {
      for (const i of imgsOf(n)) {
        const src = i.getAttribute('src');
        if (!had.has(src)) had.set(src, []);
        had.get(src).push(i);
      }
    }
    if (!had.size) return;
    for (const n of ctx.added) {
      for (const i of imgsOf(n)) {
        const old = (had.get(i.getAttribute('src')) || []).pop();
        if (!old || !i.parentNode) continue;
        attrs(old, i);
        i.parentNode.replaceChild(old, i);
      }
    }
  }

  /** `el`'s children as `tree`'s (a fragment or an element, emptied as it is read). True when anything changed. */
  function morphInto(el, tree) {
    const ctx = { added: [], gone: [], changed: false };
    children(el, tree, ctx);
    reuse(ctx);
    return ctx.changed;
  }
  /** `el` drawn as `html`. True when anything changed. */
  function morph(el, html) {
    // A template's markup is inert: a picture in it is not fetched until it is on the page.
    const tpl = el.ownerDocument.createElement('template');
    tpl.innerHTML = html;
    return morphInto(el, tpl.content);
  }

  const api = { morph, morphInto, keyOf };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgoraMorph = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
