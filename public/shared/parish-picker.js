// A parish, or several, chosen — the one list every place that asks uses:
// a list of your own on the page ("Parishes to visit"), whose event it is,
// where it is held, the parishes an event also appears at, and which parish
// "Become an editor" is about (Kevin, 17 Nov 2026: "a well divided list
// sortable by distance, archdiocese, or location and the same everywhere").
//
// One list, two ways to divide it, a switch from one to the other:
//
//   Jurisdiction  the jurisdiction collections (collections.js JURISDICTIONS),
//                 in their order, the asker's own first
//   Location      a city's parishes (locations.js), then the rest of its state
//
// and two orders inside a section, the pair of arrows the page's Nearest
// button is: nearest first (from whoever asks: you, or the parish the form
// is for), or A to Z. Distance is an order, never a division of its own
// (Kevin, 17 Nov 2026: "dont have nearest first as a category").
//
// A section folds at its heading, words typed or not. Both choices are kept
// per phone, so the list opens as it was left, wherever it is opened from.
// Words typed find a parish by its name, its short name, its suburb, its
// jurisdiction or its city.
//
// Three doors, one list:
//   mount(el, o)   the list itself, in a box
//   open(o)        the list as a card of its own (form-sheet.js; a <dialog>
//                  where the page has no form cards, /admin)
//   field(el, o)   what a form shows: the parish chosen (or the parishes, as
//                  chips), and a tap opens the card
//
// PURE where it can be: sectionsOf, placeOf and matches know parishes, not
// the page (d1/parish-picker.test.mjs).
//
// Same dual-mode wrapper as its neighbours.
(function (root) {
  const isCjs = typeof module === 'object' && !!module.exports;
  const collections = () => (isCjs ? require('./collections.js') : (root && root.AgoraCollections)) || null;
  const locations = () => (isCjs ? require('./locations.js') : (root && root.AgoraLocations)) || null;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ── What is not the DOM ───────────────────────────────────────────────

  const SORTS = [['juris', 'Jurisdiction'], ['place', 'Location']];
  const SORT_KEY = 'agora_pick_sort';
  const ORDER_KEY = 'agora_pick_order';   // 'near' | 'az'

  function km(a, b) {
    if (!a || !b || !isFinite(a.lat) || !isFinite(b.lat) || a.lat == null || b.lat == null) return Infinity;
    const R = 6371, r = Math.PI / 180;
    const dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
    const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  // The page's own (next.js fmtKm): whole kilometres, a decimal only under one.
  const fmtKm = (d) => (Math.round(d * 10) < 10 ? `${Math.max(1, Math.round(d * 10)) / 10}km` : `${Math.round(d)}km`);
  const distClass = (d) => (d <= 5 ? 'near' : d <= 15 ? 'mid' : 'far');

  const JURIS_SHORT = { greek: 'Greek', antiochian: 'Antiochian', serbian: 'Serbian', russian: 'Russian', romanian: 'Romanian', macedonian: 'Macedonian' };
  /** The jurisdictions as the collections list them: [[key, 'Greek Orthodox'], …]. */
  function jurisdictions() {
    const C = collections();
    if (C && C.JURISDICTIONS) return C.JURISDICTIONS.map(c => [c.jurisdiction, c.title]);
    return Object.entries(JURIS_SHORT).map(([j, s]) => [j, `${s} Orthodox`]);
  }

  // The suburb out of an address: the last part that is not a state, a
  // postcode or a country, with any state and postcode trailing it taken off
  // — "12/14 Balmoral Ave, Croydon Park, NSW 2133" is Croydon Park.
  const NOT_A_PLACE = /^(n\.?s\.?w\.?|vic|qld|s\.?a|w\.?a|tas|n\.?t|a\.?c\.?t|australia|new zealand|nz|\d{4})$/i;
  const STATE_TAIL = /\s+(n\.?s\.?w\.?|vic|qld|sa|wa|tas|nt|act)\.?(\s+\d{4})?$|\s+\d{4}$/i;
  function suburbOf(address) {
    const parts = String(address || '').split(',').map(x => x.trim().replace(STATE_TAIL, '').trim()).filter(Boolean);
    for (let i = parts.length - 1; i >= 0; i--) {
      if (!NOT_A_PLACE.test(parts[i]) && !/^\d/.test(parts[i])) return parts[i];
    }
    return '';
  }

  /** Words as a search compares them: no accents, no case, no punctuation. */
  const fold = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // Where a parish is, as a heading: its city, or the rest of its state or
  // country. A city's region is its centre's, so the Gold Coast is
  // Queensland's whichever side of Boundary Street a parish is on.
  let cityRegions = null;
  const places = new WeakMap();
  function regionOf(L, at, parish) {
    const st = parish ? L.parishAuState(parish) : L.auStateFromPoint(at.lat, at.lng);
    if (st) return L.LOCATIONS.find(l => l.kind === 'state' && l.auState === st) || null;
    return L.LOCATIONS.find(l => l.kind === 'country' && L.locationMatchesParish(l, at)) || null;
  }
  /** { key, label, region, regionLabel, city } for a parish; `region` '' where it is nowhere on file. */
  function placeOf(p) {
    if (places.has(p)) return places.get(p);
    const L = locations();
    let out = { key: 'elsewhere', label: 'Elsewhere', region: '', regionLabel: '', city: false };
    if (L && p && p.lat != null && p.lng != null) {
      if (!cityRegions) {
        cityRegions = new Map(L.LOCATIONS.filter(l => l.kind === 'city')
          .map(c => [c.slug, regionOf(L, { lat: c.center[0], lng: c.center[1] }, null)]));
      }
      const city = L.LOCATIONS.find(l => l.kind === 'city' && L.locationMatchesParish(l, p));
      const region = city ? cityRegions.get(city.slug) : regionOf(L, p, p);
      if (city) out = { key: city.slug, label: city.label, region: region ? region.slug : '', regionLabel: region ? region.label : '', city: true };
      else if (region) out = { key: `in-${region.slug}`, label: region.label, region: region.slug, regionLabel: region.label, city: false };
    }
    if (p && typeof p === 'object') places.set(p, out);
    return out;
  }

  /** Does every word typed turn up in what a parish is called or where it is? */
  function matches(p, q) {
    const words = fold(q).split(' ').filter(Boolean);
    if (!words.length) return true;
    const pl = placeOf(p);
    const hay = ` ${fold([p.name, p.full_name, p.acronym, p.address, JURIS_SHORT[p.jurisdiction] || p.jurisdiction, pl.label, pl.regionLabel].join(' '))}`;
    // A word's start, so "st" does not find every Constantine.
    return words.every(w => hay.includes(` ${w}`));
  }

  const byName = (a, b) => String(a.p.name || '').localeCompare(String(b.p.name || ''));
  const byKm = (a, b) => a.km - b.km || byName(a, b);

  /**
   * The parishes in their sections: [{ key, label, jurisdiction?, rows: [{ p, km }] }].
   *
   *   sort     'juris' | 'place': what the sections are
   *   order    'near' | 'az': nearest first inside a section, or by name.
   *            Nearest with nowhere to measure from is by name.
   *   origin   { lat, lng }, where distance is measured from (or null); a
   *            row says how far whichever the order
   *   first    the jurisdiction that goes first under Jurisdiction (the asker's own)
   *   q        words typed
   */
  function sectionsOf(parishes, { sort = 'juris', order: by = 'near', origin = null, first = null, q = '' } = {}) {
    const measured = origin && origin.lat != null && isFinite(origin.lat) ? origin : null;
    const rows = (parishes || []).filter(p => p && p.id && p.id !== '_unassigned' && matches(p, q))
      .map(p => ({ p, km: measured ? km(measured, p) : Infinity }));
    const from = by === 'az' ? null : measured;
    const order = from ? byKm : byName;

    if (sort !== 'place') {
      const known = jurisdictions();
      const keys = known.map(([j]) => j);
      const out = new Map([...(first && keys.includes(first) ? [first] : []), ...keys]
        .map(j => [j, { key: `j-${j}`, label: known.find(([k]) => k === j)[1], jurisdiction: j, rows: [] }]));
      const other = { key: 'j-other', label: 'Other', jurisdiction: 'other', rows: [] };
      for (const r of rows) (out.get(r.p.jurisdiction) || other).rows.push(r);
      return [...out.values(), other].filter(s => s.rows.length).map(s => ({ ...s, rows: s.rows.sort(order) }));
    }

    // Location: a region's cities, then the rest of it. Regions nearest
    // first; A to Z, as locations.js lists them. Cities the same way.
    const L = locations();
    const rank = new Map((L ? L.LOCATIONS : []).map((l, i) => [l.slug, i]));
    const secs = new Map();
    for (const r of rows) {
      const pl = placeOf(r.p);
      if (!secs.has(pl.key)) secs.set(pl.key, { ...pl, rows: [], near: Infinity });
      const s = secs.get(pl.key);
      s.rows.push(r);
      s.near = Math.min(s.near, r.km);
    }
    const regions = new Map();
    for (const s of secs.values()) {
      if (!regions.has(s.region)) regions.set(s.region, { slug: s.region, near: Infinity, secs: [] });
      const g = regions.get(s.region);
      g.secs.push(s);
      g.near = Math.min(g.near, s.near);
    }
    const at = (slug) => (rank.has(slug) ? rank.get(slug) : 1e6);
    const nowhere = (g) => (g.slug ? 0 : 1);
    return [...regions.values()]
      .sort((a, b) => nowhere(a) - nowhere(b) || (from ? a.near - b.near : 0) || at(a.slug) - at(b.slug))
      .flatMap(g => {
        const cities = g.secs.filter(s => s.city)
          .sort((a, b) => (from ? a.near - b.near : 0) || at(a.key) - at(b.key));
        const rest = g.secs.filter(s => !s.city)
          .map(s => ({ ...s, label: cities.length && s.region ? `Elsewhere in ${s.regionLabel}` : s.label }));
        return [...cities, ...rest];
      })
      .map(s => ({ key: `p-${s.key}`, label: s.label, rows: s.rows.sort(order) }));
  }

  /**
   * The line under a parish's name: its jurisdiction, and its suburb where
   * its name does not say it. Only a suburb: an address's last part is as
   * often "NSW 2165 Australia" or a street corner, and that is not said.
   */
  function subOf(p, sort) {
    const sub = suburbOf(p.address).replace(/\b(new zealand|australia)\b/ig, '').split(/\s+/)
      .filter(w => w && !NOT_A_PLACE.test(w.replace(/\.$/, ''))).join(' ');
    const where = sub && !/\d|&|\b(st|rd|ave|cnr|street|road)\b\.?/i.test(sub) && sub.split(' ').length <= 3
      && !fold(p.name).includes(fold(sub)) ? sub : '';
    return [sort === 'juris' ? '' : (JURIS_SHORT[p.jurisdiction] || ''), where].filter(Boolean).join(' · ');
  }

  // ── The list ──────────────────────────────────────────────────────────

  const CHECK = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';
  const PLUS = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
  const CHEV = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>';
  const FIND = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/></svg>';
  // The page's Nearest button's sign (next.js SORT_ICON): a pair of arrows, up and down.
  const ORDER = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 20V4M4.5 7.5 8 4l3.5 3.5M16 4v16M12.5 16.5 16 20l3.5-3.5"/></svg>';
  const X = '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';

  const colorOf = (j) => (root && root.agoraJurisdictionColor ? root.agoraJurisdictionColor(j) : '#888');
  // A logo that did not come leaves the parish's letters, and is not asked for again.
  const badLogos = new Set();
  function dropBadLogos(el) {
    el.addEventListener('error', (e) => {
      const i = e.target;
      if (!i || i.tagName !== 'IMG' || !i.closest('.pp-av')) return;
      badLogos.add(i.getAttribute('src'));
      i.remove();
    }, true);
  }
  /** A parish's round logo, or its letters in its jurisdiction's colour. */
  function avatar(p, cls = '') {
    const logo = p.logo_path && !badLogos.has(p.logo_path) ? `<img src="${esc(p.logo_path)}" alt="" loading="lazy" decoding="async">` : '';
    return `<span class="pp-av ${cls}" style="--j:${esc(colorOf(p.jurisdiction))}"><b>${esc(String(p.acronym || p.name || '?').slice(0, 3))}</b>${logo}</span>`;
  }
  const paint = (el, html) => { if (root.AgoraMorph) root.AgoraMorph.morph(el, html); else el.innerHTML = html; };

  function kept(k) { try { return root.localStorage.getItem(k); } catch { return null; } }
  function keep(k, v) { try { root.localStorage.setItem(k, v); } catch { /* this page only */ } }

  /**
   * The list, in a box.
   *
   * @param {HTMLElement} el
   * @param {object} o
   *   parishes   those to choose from: [{ id, name, jurisdiction, address, lat, lng, logo_path, acronym }]
   *   multiple   several, each tap a toggle; else one, and a tap is the answer
   *   value      the id chosen, or the ids
   *   fixed      ids that are in and stay in (an event's own parish), tagged `fixedTag`
   *   origin     { lat, lng, label }: where "how far" is from, and its words ("you", a parish's name)
   *   first      the jurisdiction listed first under Jurisdiction
   *   tagOf      (p) => '' | 'needs an owner': a word beside a parish's name
   *   onChange   (ids) => void, as each is tapped (multiple)
   *   onPick     (id) => void (one)
   */
  function mount(el, o) {
    const st = {
      o,
      q: '',
      sort: SORTS.some(([k]) => k === kept(SORT_KEY)) ? kept(SORT_KEY) : SORTS[0][0],
      az: kept(ORDER_KEY) === 'az',
      folds: new Map(),          // `${sort}:${key}` → open? (`q:` before it, while words are typed)
      value: new Set(o.multiple ? (o.value || []) : (o.value ? [o.value] : [])),
    };
    const fixed = () => new Set(st.o.fixed || []);
    const from = () => (st.o.origin && st.o.origin.lat != null ? st.o.origin : null);
    el.classList.add('pp');
    dropBadLogos(el);
    el.innerHTML = `
      <label class="pp-find">${FIND}<input type="search" placeholder="Find a parish" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="search" aria-label="Find a parish"></label>
      <div class="pp-chips" data-pp-chips hidden></div>
      <div class="pp-sortrow">
        <div class="pp-bar">
          <div class="pp-sorts" role="group" aria-label="Divide by"></div>
          <button type="button" class="pp-order" data-pp-order>${ORDER}</button>
        </div>
        <div class="pp-from"></div>
      </div>
      <div class="pp-list" role="listbox"${o.multiple ? ' aria-multiselectable="true"' : ''}></div>`;
    const $ = (sel) => el.querySelector(sel);
    const find = $('.pp-find input');
    const byId = () => new Map((st.o.parishes || []).map(p => [p.id, p]));

    function renderSorts() {
      $('.pp-sorts').innerHTML = SORTS.map(([k, label]) =>
        `<button type="button" class="pp-sort${k === st.sort ? ' on' : ''}" data-pp-sort="${k}" aria-pressed="${k === st.sort}">${esc(label)}</button>`).join('');
      // The arrows: nearest first, or A to Z. Nowhere to measure from, and
      // there is one order and no button.
      const o2 = from(), near = !!o2 && !st.az;
      const order = $('[data-pp-order]');
      order.hidden = !o2;
      order.setAttribute('aria-pressed', String(near));
      order.setAttribute('aria-label', near ? 'Nearest first. Sort A to Z' : 'A to Z. Sort nearest first');
      order.title = near ? 'Nearest first' : 'A to Z';
      $('.pp-from').textContent = !o2 ? '' : near ? `Nearest first${o2.label ? `, from ${o2.label}` : ''}` : 'A to Z';
      $('.pp-sortrow').hidden = (st.o.parishes || []).length < 2;
    }

    function renderChips() {
      const box = $('[data-pp-chips]');
      const all = byId(), fx = fixed();
      const chosen = st.o.multiple ? [...st.value].filter(id => !fx.has(id)).map(id => all.get(id)).filter(Boolean) : [];
      box.hidden = !chosen.length;
      paint(box, chosen.map(p => chipHTML(p, true)).join(''));
    }

    function rowHTML({ p, km: d }) {
      const fx = fixed().has(p.id);
      const on = fx || st.value.has(p.id);
      const tag = fx ? (st.o.fixedTag || '') : (st.o.tagOf ? st.o.tagOf(p) || '' : '');
      const sub = subOf(p, st.sort);
      return `<button type="button" class="pp-row${on ? ' on' : ''}" role="option" aria-selected="${on}" data-key="${esc(p.id)}" data-pp-id="${esc(p.id)}"${fx ? ' disabled' : ''}>
          ${avatar(p)}
          <span class="pp-t"><b>${esc(p.name)}</b>${sub || tag ? `<small>${esc(sub)}${sub && tag ? ' · ' : ''}${tag ? `<em class="pp-tag${fx ? '' : ' warn'}">${esc(tag)}</em>` : ''}</small>` : ''}</span>
          ${isFinite(d) ? `<span class="pp-km ${distClass(d)}">${esc(fmtKm(d))}</span>` : ''}
          <span class="pp-ck">${st.o.multiple ? `<span class="pp-ck-on">${CHECK}</span><span class="pp-ck-off">${PLUS}</span>` : CHECK}</span>
        </button>`;
    }

    function renderList() {
      const secs = sectionsOf(st.o.parishes, { sort: st.sort, order: st.az ? 'az' : 'near', origin: from(), first: st.o.first || null, q: st.q });
      const list = $('.pp-list');
      if (!secs.length) {
        paint(list, `<div class="pp-none">${st.q.trim() ? `No parish matches “${esc(st.q.trim())}”.` : 'No parishes to choose from.'}</div>`);
        return;
      }
      // Open at the first section; words typed open every section they are
      // found in, and so do a few parishes. A heading tapped folds its own
      // either way: what was folded while searching is forgotten with the words.
      const few = secs.reduce((n, s) => n + s.rows.length, 0) <= 12;
      const isOpen = (s, i) => {
        const k = foldKey(s.key);
        return st.folds.has(k) ? st.folds.get(k) : (searching() || few || i === 0);
      };
      paint(list, secs.map((s, i) => {
        const open = isOpen(s, i);
        const mine = s.rows.filter(r => st.value.has(r.p.id) || fixed().has(r.p.id)).length;
        return `<section class="pp-sec${open ? ' open' : ''}" data-key="${esc(s.key)}"${s.jurisdiction ? ` style="--j:${esc(colorOf(s.jurisdiction))}"` : ''}>
            <button type="button" class="pp-head" data-pp-sec="${esc(s.key)}" aria-expanded="${open}">
              ${s.jurisdiction ? '<span class="pp-dot"></span>' : ''}<b>${esc(s.label)}</b>
              <small>${st.o.multiple && mine ? `<span class="pp-mine">${mine} chosen</span> · ` : ''}${s.rows.length}</small>
              <span class="pp-chev">${CHEV}</span>
            </button>
            <div class="pp-group"${open ? '' : ' hidden'}>${open ? s.rows.map(rowHTML).join('') : ''}</div>
          </section>`;
      }).join(''));
    }

    const searching = () => !!st.q.trim();
    const foldKey = (key) => `${searching() ? 'q:' : ''}${st.sort}:${key}`;

    function render() { renderSorts(); renderChips(); renderList(); }

    function emit() {
      if (st.o.multiple && st.o.onChange) st.o.onChange([...st.value]);
    }
    function toggle(id) {
      if (fixed().has(id)) return;
      if (!st.o.multiple) {
        st.value = new Set([id]);
        renderList();
        if (st.o.onPick) st.o.onPick(id);
        return;
      }
      if (st.value.has(id)) st.value.delete(id); else st.value.add(id);
      renderChips();
      renderList();
      emit();
    }

    el.addEventListener('click', (e) => {
      const s = e.target.closest('[data-pp-sort]');
      if (s) {
        st.sort = s.dataset.ppSort;
        keep(SORT_KEY, st.sort);
        renderSorts();
        renderList();
        return;
      }
      if (e.target.closest('[data-pp-order]')) {
        st.az = !st.az;
        keep(ORDER_KEY, st.az ? 'az' : 'near');
        renderSorts();
        renderList();
        return;
      }
      const h = e.target.closest('[data-pp-sec]');
      if (h) {
        st.folds.set(foldKey(h.dataset.ppSec), h.getAttribute('aria-expanded') !== 'true');
        renderList();
        return;
      }
      const chip = e.target.closest('[data-pp-drop]');
      if (chip) { toggle(chip.dataset.ppDrop); return; }
      const row = e.target.closest('[data-pp-id]');
      if (row && !row.disabled) toggle(row.dataset.ppId);
    });
    find.addEventListener('input', () => {
      st.q = find.value;
      if (!searching()) for (const k of [...st.folds.keys()]) if (k.startsWith('q:')) st.folds.delete(k);
      renderList();
    });
    // Enter is "search", not the form's Save.
    find.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); find.blur(); } });

    render();
    return {
      get: () => (st.o.multiple ? [...st.value] : ([...st.value][0] || null)),
      set(v) { st.value = new Set(st.o.multiple ? (v || []) : (v ? [v] : [])); renderChips(); renderList(); },
      update(next) { st.o = { ...st.o, ...next }; render(); },
      focus: () => find.focus({ preventScroll: true }),
    };
  }

  /** A chosen parish as a chip; `drop`: with its × to take it off. */
  function chipHTML(p, drop) {
    return `<span class="pp-chip" data-key="${esc(p.id)}">${avatar(p, 'xs')}<span>${esc(p.name)}</span>${drop
      ? `<button type="button" class="pp-x" data-pp-drop="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">${X}</button>` : ''}</span>`;
  }

  // ── The list as a card ────────────────────────────────────────────────

  /**
   * The list in a card of its own, over whatever asked. `o` is mount's, and:
   *   title, sub   the card's bar
   *   note         a line over the list
   *   closeLabel   the bar's way out, where it is not the form under it ("Close")
   *   onClose      () => void
   * One: a tap answers and the card goes. Several: each tap counts as it is
   * made, and Done (or the way back) closes it.
   */
  function open(o) {
    const title = o.title || (o.multiple ? 'Choose parishes' : 'Choose a parish');
    const inner = `${o.note ? `<p class="pp-note">${esc(o.note)}</p>` : ''}<div data-pp-host></div>
      ${o.multiple ? '<div class="form-actions"><button class="btn-save" type="button" data-pp-done>Done</button></div>' : ''}`;
    let close = () => {};
    let body;
    const FS = root.AgoraFormSheet;
    if (FS) {
      const sheet = FS.open({ title, sub: o.sub || '', cls: 'pp-backdrop', guard: false, label: o.closeLabel || null, onClose: () => { if (o.onClose) o.onClose(); } });
      body = sheet.body;
      close = () => sheet.close();
    } else {
      // No form cards on this page (/admin): the browser's own dialog.
      const d = document.createElement('dialog');
      d.className = 'pp-dialog';
      d.innerHTML = `<div class="pp-dbar"><button type="button" class="pp-dclose" data-pp-close>${o.multiple ? 'Done' : 'Cancel'}</button><b>${esc(title)}</b><span></span></div><div class="pp-dbody"></div>`;
      document.body.appendChild(d);
      body = d.querySelector('.pp-dbody');
      d.addEventListener('close', () => { d.remove(); if (o.onClose) o.onClose(); });
      d.addEventListener('click', (e) => { if (e.target === d || e.target.closest('[data-pp-close]')) d.close(); });
      close = () => { if (d.open) d.close(); };
      d.showModal();
    }
    body.classList.add('pp-body');
    body.innerHTML = inner;
    const live = mount(body.querySelector('[data-pp-host]'), {
      ...o,
      onPick: (id) => { if (o.onPick) o.onPick(id); close(); },
    });
    const done = body.querySelector('[data-pp-done]');
    if (done) done.addEventListener('click', () => close());
    return { ...live, close };
  }

  // ── What a form shows ─────────────────────────────────────────────────

  /**
   * A form's parish, or its parishes: what is chosen, and a tap opens the
   * card. `o` is open's, and:
   *   placeholder  what one says with nothing chosen ("Choose the parish…")
   *   add          what several's button says ("Add parishes")
   *   lone         with one parish to choose from and it chosen, just say it
   * `onChange(value)` hears the id, or the ids.
   */
  function field(el, o) {
    const st = { o, disabled: false, card: null };
    st.value = o.multiple ? [...(o.value || [])] : (o.value || null);
    el.classList.add(o.multiple ? 'pp-chosen' : 'pp-fieldbox');
    dropBadLogos(el);
    const all = () => new Map((st.o.parishes || []).map(p => [p.id, p]));

    function render() {
      const m = all();
      if (st.o.multiple) {
        const fx = new Set(st.o.fixed || []);
        const chosen = st.value.filter(id => !fx.has(id)).map(id => m.get(id)).filter(Boolean);
        el.innerHTML = `${chosen.map(p => chipHTML(p, !st.disabled)).join('')}
          <button type="button" class="pp-add" data-pp-open${st.disabled ? ' disabled' : ''}>${PLUS}<span>${esc(st.o.add || 'Add parishes')}</span></button>`;
        return;
      }
      const p = st.value ? m.get(st.value) : null;
      const lone = st.o.lone && p && (st.o.parishes || []).length === 1;
      const sub = p ? subOf(p) : '';
      el.innerHTML = `<button type="button" class="pp-field${p ? '' : ' none'}${lone ? ' lone' : ''}" data-pp-open aria-haspopup="dialog"${st.disabled || lone ? ' disabled' : ''}>
          ${p ? `${avatar(p)}<span class="pp-t"><b>${esc(p.name)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</span>`
            : `<span class="pp-t"><b>${esc(st.o.placeholder || 'Choose a parish…')}</b></span>`}
          ${lone ? '' : `<span class="pp-chev">${CHEV}</span>`}
        </button>`;
    }
    const say = () => { if (st.o.onChange) st.o.onChange(st.o.multiple ? [...st.value] : st.value); };

    function openCard() {
      if (st.disabled || st.card) return;
      st.card = open({
        ...st.o,
        value: st.value,
        onChange: (ids) => { st.value = ids; render(); say(); },
        onPick: (id) => { const was = st.value; st.value = id; render(); if (id !== was) say(); },
        onClose: () => { st.card = null; },
      });
    }
    el.addEventListener('click', (e) => {
      const x = e.target.closest('[data-pp-drop]');
      if (x && st.o.multiple && !st.disabled) {
        st.value = st.value.filter(id => id !== x.dataset.ppDrop);
        render();
        say();
        return;
      }
      if (e.target.closest('[data-pp-open]')) openCard();
    });

    render();
    return {
      get: () => (st.o.multiple ? [...st.value] : st.value),
      set(v) { st.value = st.o.multiple ? [...(v || [])] : (v || null); render(); },
      update(next) { st.o = { ...st.o, ...next }; if ('value' in next) st.value = st.o.multiple ? [...(next.value || [])] : (next.value || null); render(); },
      disable(on) { if (st.disabled !== !!on) { st.disabled = !!on; render(); } },
      open: openCard,
    };
  }

  const api = { mount, open, field, sectionsOf, placeOf, matches, suburbOf, subOf, fmtKm, km, SORTS };
  if (isCjs) module.exports = api;
  else if (root) root.AgoraParishPicker = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
