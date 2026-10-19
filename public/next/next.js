// orthodoxy.au — the next version, as a prototype.
//
// A page around a map rather than a map under a sheet. Borrowed, piece by piece:
//   NextThere   the viewport card: nothing on the map but full screen, and a
//               chip under it that counts what is in view and shows its logos.
//   Apple Maps  the parish card (glass toolbar, a summary line, a floating
//               + ☆ … bar) and Guides: rows of collections that open as cards.
//   App Store   the What's on shelf, poster first.
//   The app     its filter pills, behind a button beside the chips, opening
//               under it with the map still in sight.
//
// Order of the page is the answer to "how do I get into the feed": Today first,
// then the curated shelves, and underneath them, always, every service and
// event day after day for as long as you scroll — the way reviews wait at the
// bottom of a place in Google Maps.
//
// Data is the app's: /api/bundle through bundle.js and the /shared/ projection.
// Nothing here writes to the server. Lists live in this browser, and
// Favourites is the same store the current app's star writes.
//
// Links are the app's too: the filters are url-state.js's, read and written
// in the same grammar (/greek/en, /sun/liturgy, /sgr+snb, /sgr, /102), under
// /next while this is the prototype. The link shows on the page as it builds.

(function () {
  'use strict';

  // ── Small things ──────────────────────────────────────────────────────

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
  const DAY = 86400000;
  const TZ = 'Australia/Sydney';

  const JURIS = {
    greek: { short: 'Greek', long: 'Greek Orthodox' },
    antiochian: { short: 'Antiochian', long: 'Antiochian Orthodox' },
    serbian: { short: 'Serbian', long: 'Serbian Orthodox' },
    russian: { short: 'Russian', long: 'Russian Orthodox' },
    romanian: { short: 'Romanian', long: 'Romanian Orthodox' },
    macedonian: { short: 'Macedonian', long: 'Macedonian Orthodox' },
  };
  const JURIS_ORDER = ['greek', 'antiochian', 'serbian', 'russian', 'romanian', 'macedonian'];
  const jColor = (j) => (window.agoraJurisdictionColor ? window.agoraJurisdictionColor(j) : '#888');

  // Kinds, in the groups the app's toolbar already uses: Services, Talks, Socials.
  const GROUPS = [
    { id: 'services', label: 'Services', kinds: ['liturgy', 'prayer', 'feast'] },
    { id: 'talks', label: 'Talks', kinds: ['talk'] },
    { id: 'socials', label: 'Socials', kinds: ['social', 'youth'] },
    { id: 'other', label: 'Other', kinds: ['other'] },
  ];
  const groupOf = (kind) => (GROUPS.find(g => g.kinds.includes(kind)) || GROUPS[3]).id;
  const kindLabel = (k) => (window.AgoraEventTypes ? window.AgoraEventTypes.eventTypeLabel(k) : k);
  function roundel(kind, big) {
    const c = window.AgoraEventTypes.kindColors(kind || 'other', dark());
    const l = kindLabel(kind || 'other');
    return `<span class="roundel${big ? ' big' : ''}" style="--k-bg:${c.bg};--k-fg:${c.fg}" title="${esc(l)}" aria-label="${esc(l)}">${esc(l[0])}</span>`;
  }

  const parseLangs = (v) => {
    if (!v) return null;
    if (Array.isArray(v)) return v;
    try { const a = JSON.parse(v); return Array.isArray(a) ? a : null; } catch { return null; }
  };

  // ── State ─────────────────────────────────────────────────────────────

  const S = {
    parishes: [],
    byId: new Map(),
    rules: [],               // the bundle's schedules, parish fields joined
    rulesByParish: new Map(),
    loc: null,               // { lat, lng } once the person says where they are
    inView: null,            // Set of parish ids the viewport holds (null before the map)
    bounds: null,
    juris: null,             // a jurisdiction tab
    f: null,                 // the filters, in the app's shape (blankFilters)
    focus: null,             // { title, ids:Set } — a collection no link can name, on the map
    streamDays: 14,          // how far the stream has grown
    from: null,              // the date the stream starts from, when one is picked
    loadedTo: null,          // the last day the bundle holds
    loads: 0,                // bumped as the bundle widens
    streamBusy: false,
    panel: null,             // the filters open under their button: { pushed }
  };

  /**
   * The filters as the app keeps them (state.filters), so the shared readers
   * of a link (url-state.js) and of a timetable (timetable.js) take them as
   * they are. `monasteries` is /monasteries; `listId` names the saved list a
   * set of parishes came from, and `timesOnly` is this page's own, which no
   * link carries.
   */
  const blankFilters = () => ({
    kind: null, kindSub: null, lang: null, langStrict: false, day: null, dayGroup: null, part: null, service: null,
    location: null, monasteries: false, parishIds: null, listId: null, timesOnly: false,
  });
  S.f = blankFilters();

  try {
    const l = JSON.parse(localStorage.getItem('agora_location') || 'null');
    if (l && isFinite(l.lat) && isFinite(l.lng)) S.loc = { lat: +l.lat, lng: +l.lng };
  } catch { /* none */ }

  // ── Time ──────────────────────────────────────────────────────────────

  const fmtCache = new Map();
  function partsIn(zone, ms) {
    let f = fmtCache.get(zone);
    if (!f) {
      f = new Intl.DateTimeFormat('en-AU', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      fmtCache.set(zone, f);
    }
    const o = {};
    for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
    return { date: `${o.year}-${o.month}-${o.day}`, hm: `${o.hour}:${o.minute}` };
  }
  /** An event's wall clock where it is held: { date, hm }. */
  function local(e) {
    if (e.start_local) return { date: e.start_local.slice(0, 10), hm: e.start_local.slice(11, 16) };
    return partsIn(e.timezone || TZ, Date.parse(e.start_utc));
  }
  const todayKey = () => partsIn(Intl.DateTimeFormat().resolvedOptions().timeZone || TZ, Date.now()).date;
  function addDays(key, n) {
    const d = new Date(key + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  /** "9am", "6:30pm". */
  function hm12(hm) {
    if (!hm) return '';
    let [h, m] = hm.split(':').map(Number);
    const ap = h >= 12 ? 'pm' : 'am';
    h = h % 12 || 12;
    return m ? `${h}:${String(m).padStart(2, '0')}${ap}` : `${h}${ap}`;
  }
  /** The app's time (formatEventTime in app.js): "9", a small ":30", a small "AM". No serif. */
  function timeHTML(hm) {
    if (!hm) return '';
    const [h, m] = hm.split(':').map(Number);
    const mm = m ? `<span class="t-min">:${String(m).padStart(2, '0')}</span>` : '';
    return `<span class="t-time">${h % 12 || 12}${mm}<span class="t-mer">${h >= 12 ? 'pm' : 'am'}</span></span>`;
  }
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dayLabel(key, long) {
    const t = todayKey();
    const d = new Date(key + 'T00:00:00Z');
    const base = `${(long ? WD_LONG : WD)[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
    if (key === t) return long ? `Today · ${base}` : 'Today';
    if (key === addDays(t, 1)) return long ? `Tomorrow · ${base}` : 'Tomorrow';
    return base;
  }
  function whenShort(e) {
    const l = local(e);
    const t = todayKey();
    const d = new Date(l.date + 'T00:00:00Z');
    const day = l.date === t ? 'Today' : l.date === addDays(t, 1) ? 'Tomorrow'
      : (Date.parse(l.date) - Date.parse(t) < 6 * DAY) ? WD[d.getUTCDay()] : `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
    return `${day} ${hm12(l.hm)}`;
  }
  /** Two short lines for the summary: "Sun" over "8:30am"; "Today" when it is. */
  function summaryWhen(e) {
    const l = local(e);
    const d = new Date(l.date + 'T00:00:00Z');
    const near = Date.parse(l.date) - Date.parse(todayKey()) < 6 * DAY;
    const day = l.date === todayKey() ? 'Today' : near ? WD[d.getUTCDay()] : `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
    return `${esc(day)}<br>${esc(hm12(l.hm))}`;
  }
  const endMs = (e) => e.end_utc ? Date.parse(e.end_utc) : Date.parse(e.start_utc) + (e.event_type === 'liturgy' ? 2 : 1.25) * 3600000;

  // ── Distance and place ────────────────────────────────────────────────

  function km(a, b) {
    const R = 6371, r = Math.PI / 180;
    const dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r;
    const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }
  const fmtKm = (d) => d < 1 ? `${Math.round(d * 1000 / 50) * 50} m` : d < 10 ? `${d.toFixed(1)} km` : `${Math.round(d)} km`;
  /** Distance only in location mode, as the summary line asks. */
  const distOf = (p) => (S.loc && p && isFinite(p.lat)) ? km(S.loc, p) : null;
  const sortOrigin = () => S.loc || (map ? (({ lng, lat }) => ({ lat, lng }))(map.getCenter()) : null);

  const CITIES = [
    ['Sydney', -33.87, 151.21], ['Melbourne', -37.81, 144.96], ['Brisbane', -27.47, 153.03], ['Perth', -31.95, 115.86],
    ['Adelaide', -34.93, 138.6], ['Canberra', -35.28, 149.13], ['Hobart', -42.88, 147.33], ['Darwin', -12.46, 130.84],
    ['Newcastle', -32.93, 151.78], ['Wollongong', -34.42, 150.89], ['Gold Coast', -28.02, 153.4], ['Sunshine Coast', -26.65, 153.07],
    ['Geelong', -38.15, 144.36], ['Townsville', -19.26, 146.82], ['Cairns', -16.92, 145.77], ['Toowoomba', -27.56, 151.95],
    ['Ballarat', -37.56, 143.85], ['Bendigo', -36.76, 144.28], ['Launceston', -41.43, 147.14], ['Auckland', -36.85, 174.76],
    ['Wellington', -41.29, 174.78], ['Christchurch', -43.53, 172.64], ['Dunedin', -45.87, 170.5], ['Albury', -36.08, 146.92],
  ];
  function placeName(lat, lng, zoom) {
    if (zoom < 6.5) return lng > 166 ? 'New Zealand' : 'Australia & NZ';
    let best = null, bd = Infinity;
    for (const [n, la, lo] of CITIES) { const d = km({ lat, lng }, { lat: la, lng: lo }); if (d < bd) { bd = d; best = n; } }
    if (bd > 160) return lng > 166 ? 'New Zealand' : 'Australia';
    return best;
  }

  // ── Parishes: what they hold ──────────────────────────────────────────

  function rulesOf(pid) { return S.rulesByParish.get(pid) || []; }
  function liveRule(r) {
    if (!r.active) return false;
    const t = todayKey();
    return !(r.effective_to && r.effective_to < t);
  }
  function parishLangs(p) {
    const set = [];
    const add = (l) => { if (l && !set.includes(l)) set.push(l); };
    for (const r of rulesOf(p.id)) for (const l of parseLangs(r.languages) || []) add(l);
    for (const l of parseLangs(p.languages) || []) add(l);
    return set;
  }
  /** English is on every parish's list; English *first*, or on a service, is the signal. */
  function speaksEnglish(p) {
    const pl = parseLangs(p.languages) || [];
    if (pl[0] === 'English') return true;
    return rulesOf(p.id).some(r => (parseLangs(r.languages) || []).includes('English'));
  }
  function hasLang(p, lang) {
    if (lang === 'English') return speaksEnglish(p);
    return parishLangs(p).some(l => l === lang || (lang === 'Slavonic' && /slavonic|russian/i.test(l)));
  }

  // ── Lists: collections first, filters second ──────────────────────────
  //
  // Favourites is the current app's star (agora-favourites, [{id, at}]), so a
  // parish starred there is starred here. Every other list is new: a name and
  // its parishes, in this browser.

  const FAV = 'agora-favourites', LISTS = 'agora-lists';
  function readLS(k) { try { const v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
  function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* this page only */ } }
  const favIds = () => readLS(FAV).map(f => f.id).filter(id => S.byId.has(id));
  const isFav = (pid) => readLS(FAV).some(f => f.id === pid);
  function toggleFav(pid) {
    const l = readLS(FAV);
    writeLS(FAV, isFav(pid) ? l.filter(f => f.id !== pid) : [{ id: pid, at: Date.now() }, ...l]);
    toast(isFav(pid) ? 'Added to Favourites' : 'Removed from Favourites');
    renderLists();
    renderInView();
    syncMap();
    followList();
  }
  const userLists = () => readLS(LISTS);
  function allLists() {
    return [{ id: 'fav', name: 'Favourites', ids: favIds(), fav: true }, ...userLists().map(l => ({ ...l, ids: (l.ids || []).filter(id => S.byId.has(id)) }))];
  }
  function listById(id) { return allLists().find(l => l.id === id); }
  function inList(listId, pid) { return listId === 'fav' ? isFav(pid) : (userLists().find(l => l.id === listId)?.ids || []).includes(pid); }
  function toggleInList(listId, pid) {
    if (listId === 'fav') return toggleFav(pid);
    const ls = userLists();
    const l = ls.find(x => x.id === listId);
    if (!l) return;
    l.ids = l.ids || [];
    const had = l.ids.includes(pid);
    l.ids = had ? l.ids.filter(x => x !== pid) : [pid, ...l.ids];
    writeLS(LISTS, ls);
    toast(had ? `Removed from ${l.name}` : `Added to ${l.name}`);
    renderLists();
    followList();
  }
  /** A list switched on as a filter follows the list as it changes, and so does the link. */
  function followList() {
    if (!S.f.listId) return;
    const l = listById(S.f.listId);
    S.f.parishIds = l && l.ids.length ? new Set(l.ids) : null;
    if (!S.f.parishIds) S.f.listId = null;
    refilter({ url: 'replace' });
  }
  /** The saved list holding exactly these parishes, for a link like /sgr+snb to wear its name. */
  function listMatching(ids) {
    const l = allLists().find(x => x.ids.length === ids.size && x.ids.every(id => ids.has(id)));
    return l ? l.id : null;
  }
  function newList(name, firstPid) {
    const ls = userLists();
    const l = { id: 'l' + Date.now().toString(36), name: name.trim().slice(0, 40) || 'My list', ids: firstPid ? [firstPid] : [], at: Date.now() };
    writeLS(LISTS, [l, ...ls]);
    renderLists();
    return l;
  }

  // ── Filters ───────────────────────────────────────────────────────────
  //
  // The app's own readers, where it has them: timetable.js decides a kind,
  // services.js a service and a part of the day, locations.js a region. What
  // is this page's own is the language test (English is on every parish's
  // list, so English first or on a service is the signal) and "with times".

  const weekdayOf = (key) => new Date(key + 'T00:00:00Z').getUTCDay();
  /** Does a rule or an event answer what the filters ask: its kind, service, day and part of the day? */
  function whatMatches(row, f, isRule) {
    if (!window.AgoraTimetable.kindMatches(row, f)) return false;
    if (f.service && !window.AgoraServices.serviceMatches(f.service, row)) return false;
    const dow = isRule ? row.day_of_week : weekdayOf(local(row).date);
    if (f.day != null && dow !== f.day) return false;
    if (f.dayGroup && !window.AgoraServices.dayGroupMatches(f.dayGroup, dow, row)) return false;
    if (f.part && window.AgoraServices.partOfDayOf(row) !== f.part) return false;
    return true;
  }
  const asksWhat = (f) => !!(f.kind || f.service || f.day != null || f.dayGroup || f.part);
  const langIs = (l, want) => window.AgoraTimetable.langIs(l, want) || (want === 'Slavonic' && /slavonic|russian/i.test(l));
  /** English only, Greek only: a service in that language and no other. */
  const onlyIn = (langs, want) => !!langs && langs.length > 0 && langs.every(l => langIs(l, want));
  const regionOf = (f) => (f.location && window.AgoraLocations ? window.AgoraLocations.resolveLocation(f.location) : null);

  /** Does a parish answer these filters? Collections ask it of their own filters. */
  function parishMatches(p, f, juris) {
    if (juris && p.jurisdiction !== juris) return false;
    const loc = regionOf(f);
    if (loc && !window.AgoraLocations.locationMatchesParish(loc, p)) return false;
    if (f.monasteries && !window.AgoraTimetable.isMonastery(p)) return false;
    if (f.parishIds && !f.parishIds.has(p.id)) return false;
    if (f.lang && !hasLang(p, f.lang)) return false;
    if (f.lang && f.langStrict && !rulesOf(p.id).some(r => liveRule(r) && onlyIn(parseLangs(r.languages), f.lang))) return false;
    if (f.timesOnly && !rulesOf(p.id).some(liveRule)) return false;
    if (asksWhat(f) && !rulesOf(p.id).some(r => liveRule(r) && !r.parish_scoped && whatMatches(r, f, true))
      && !upcomingOneOffs(p.id).some(e => whatMatches(e, f, false))) return false;
    return true;
  }
  function parishPasses(p) {
    if (S.focus && !S.focus.ids.has(p.id)) return false;
    return parishMatches(p, S.f, S.juris);
  }
  const visible = (e) => !e.is_tombstone && (!e.status || e.status === 'approved') && !e.break_from && !e.combined_into_event_id;
  function eventParishIds(e) { return [e.parish_id, ...(e.extra_parishes || []).map(x => x.id || x.parish_id || x)].filter(Boolean); }
  function eventPasses(e, { scoped = true } = {}) {
    if (!visible(e)) return false;
    if (scoped && e.parish_scoped) return false;
    const pids = eventParishIds(e);
    const ps = pids.map(id => S.byId.get(id)).filter(Boolean);
    if (S.juris && !ps.some(p => p.jurisdiction === S.juris)) return false;
    if (S.focus && !pids.some(id => S.focus.ids.has(id))) return false;
    const f = S.f;
    const loc = regionOf(f);
    if (loc && !ps.some(p => window.AgoraLocations.locationMatchesParish(loc, p))) return false;
    if (f.monasteries && !ps.some(p => window.AgoraTimetable.isMonastery(p))) return false;
    if (f.parishIds && !pids.some(id => f.parishIds.has(id))) return false;
    if (!whatMatches(e, f, false)) return false;
    if (f.lang) {
      const own = parseLangs(e.languages);
      const ls = own || parseLangs(e.parish_languages) || [];
      const ok = f.langStrict ? onlyIn(own, f.lang)
        : f.lang === 'English' ? (ls.includes('English') && (own || ls[0] === 'English'))
        : ls.some(l => langIs(l, f.lang));
      if (!ok) return false;
    }
    return true;
  }
  function inViewEvent(e) {
    if (!S.bounds) return true;
    if (isFinite(e.lat) && isFinite(e.lng) && e.lat != null) return S.bounds.contains([e.lng, e.lat]);
    return eventParishIds(e).some(id => S.inView && S.inView.has(id));
  }
  const filterCount = () => { const f = S.f; return [f.kind, f.lang, f.day != null, f.dayGroup, f.part, f.service, f.location, f.monasteries, f.parishIds, f.timesOnly].filter(Boolean).length; };
  const filtersOn = () => filterCount() > 0;

  // ── Links ─────────────────────────────────────────────────────────────
  //
  // The app's grammar (url-state.js), written in the order the app writes it
  // (buildPathSegs in app.js): jurisdiction, region, day, part of the day,
  // service, kind, the parishes, language. /greek/en, /sun/liturgy, /sgr+snb.
  // A card with a link of its own takes the address while it is open, /sgr or
  // /102, and every card is a step the back button undoes. Under /next while
  // this is the prototype: BASE goes when it replaces /.

  const BASE = '/next';
  const acronymOf = (p) => String(p.acronym || p.id).toLowerCase().replace(/\s+/g, '');
  /** A parish by its acronym, or by its id for one without — as the app reads a link. */
  function parishBySlug(slug) {
    const k = String(slug || '').toLowerCase().replace(/\s+/g, '');
    if (!k) return null;
    return S.parishes.find(p => p.acronym && acronymOf(p) === k)
      || S.parishes.find(p => p.id.toLowerCase() === k) || null;
  }
  /** The path segments for a set of filters, or for one parish or one event. */
  function segsFor({ juris = null, f = blankFilters(), parish = null, eventId = null, from = null } = {}) {
    // A date is where a list of days starts, never one day (/sgr/2026-10-25).
    if (parish) return from ? [acronymOf(parish), from] : [acronymOf(parish)];
    if (eventId) return [String(eventId)];
    const U = window.AgoraUrlState, SV = window.AgoraServices;
    const segs = [];
    if (juris) segs.push(juris);
    if (f.location) segs.push(f.location);
    if (f.monasteries) segs.push('monasteries');
    if (f.day != null) segs.push(SV.daySlug(f.day));
    if (f.dayGroup) segs.push(f.dayGroup);
    if (f.part) segs.push(f.part);
    if (f.service) segs.push(f.service);
    const k = f.kind ? U.kindSegment(f.kind, f.kindSub) : null;
    if (k) segs.push(k);
    if (f.parishIds && f.parishIds.size) {
      const acrs = [...f.parishIds].map(id => S.byId.get(id)).filter(Boolean).map(acronymOf);
      if (acrs.length) segs.push(acrs.join('+'));
    }
    if (from) segs.push(from);
    const lang = U.englishSegment(f);
    if (lang) segs.push(lang);
    return segs;
  }
  const pathOf = (segs) => BASE + (segs && segs.length ? '/' + segs.join('/') : '');
  const pageSegs = () => segsFor({ juris: S.juris, f: S.f, from: S.from });

  /** What an address asks for: { juris, f, parish, eventId }. Needs the parishes. */
  function readPath(pathname) {
    const rest = pathname === BASE || pathname.startsWith(BASE + '/') ? pathname.slice(BASE.length) : pathname;
    const r = window.AgoraUrlState.classifyPath(rest, { today: todayKey() });
    const f = blankFilters();
    if (r.kind) { f.kind = r.kind; f.kindSub = r.kindSub || null; }
    if (r.lang) { f.lang = r.lang; f.langStrict = !!r.langStrict; }
    if (r.location) f.location = r.location;
    if (r.monasteries) f.monasteries = true;
    const named = (r.parishSlugs || []).map(parishBySlug).filter(Boolean);
    const parish = r.parishSlugs && r.parishSlugs.length === 1 ? named[0] || null : null;
    if (!parish && named.length) {
      f.parishIds = new Set(named.map(p => p.id));
      f.listId = listMatching(f.parishIds);
    }
    // A day, a part of the day or a service beside one parish is that card's,
    // as at /. Across the page, /liturgy is the kind filter with Liturgy
    // chosen, and /vespers a service of its own.
    if (!parish) {
      const asKind = r.service && window.AgoraUrlState.kindOfService(r.service);
      if (asKind && !r.kind) [f.kind, f.kindSub] = asKind;
      else if (r.service) f.service = r.service;
      if (r.day != null) f.day = r.day;
      if (r.dayGroup) f.dayGroup = r.dayGroup;
      if (r.part) f.part = r.part;
    }
    // A date already past starts the list today, which is the list with no date.
    const from = r.dateFocus && r.dateFocus > todayKey() ? r.dateFocus : null;
    return { juris: r.jurisdiction || null, f, parish: parish ? parish.id : null, eventId: r.eventId || null, from };
  }

  // The history. Every card is one entry; a filter changed with no card open
  // is one more, as at /. Closing a card is a step back, which lands later
  // (popstate), so anything that would write the address meanwhile waits for
  // it, or it would be written onto the entry being left.
  let ignorePops = 0, popTimer = null;
  const afterPop = [];
  const whenSettled = (fn) => { if (ignorePops) afterPop.push(fn); else fn(); };
  function settle() {
    ignorePops = 0;
    clearTimeout(popTimer);
    // What waited is written now: a step of its own (Show on map) leaves the
    // entry landed on as it was. With nothing waiting, that entry takes what
    // changed under the card (the filters screen), as the page is now.
    const waiting = afterPop.splice(0);
    if (waiting.length) waiting.forEach(fn => fn());
    else writeURL();
  }
  function goBack(n) {
    ignorePops++;
    try { history.go(-n); } catch { settle(); return; }
    // A step that never lands (nothing to go back to) must not hold the address forever.
    clearTimeout(popTimer);
    popTimer = setTimeout(() => { if (ignorePops) settle(); }, 700);
  }
  /** The address as things stand: the top card with a link of its own, else the page's filters. */
  function urlNow() {
    const top = [...stack].reverse().find(el => el._segs);
    return pathOf(top ? top._segs : pageSegs());
  }
  function writeURL({ push = false, step = false } = {}) {
    const target = urlNow();
    const st = { depth: stack.length };
    // A card is a step even where its address is the page's; a filter only when it changes the link.
    if (target !== location.pathname || step) {
      try { if (push) history.pushState(st, '', target); else history.replaceState(st, '', target); } catch { /* sandboxed */ }
    }
    renderLink();
  }
  const syncURL = (opts) => whenSettled(() => writeURL(opts));
  window.addEventListener('popstate', () => {
    if (ignorePops) { if (--ignorePops === 0) settle(); return; }
    // The back button with a card open closes it.
    const depth = (history.state && history.state.depth) || 0;
    if (depth < stack.length) {
      while (stack.length > depth) dropSheet();
      writeURL();
      return;
    }
    // Back or forward through filters, or forward onto a card: read the address.
    while (stack.length) dropSheet();
    applyRoute(readPath(location.pathname), { entry: false });
  });

  /** Make the page what an address asks for. */
  function applyRoute(route, { entry = true, animate = true } = {}) {
    S.juris = route.juris;
    S.f = route.f;
    S.focus = null;
    // A date beside a parish is that card's; across the page, the stream's.
    S.from = route.parish ? null : route.from;
    S.streamDays = 14;
    refilter({ url: 'none' });
    if (S.from) ensureLoaded(addDays(S.from, S.streamDays)).then(() => renderStream());
    if (route.f.location) frameRegion(route.f.location, animate);
    else if (route.f.parishIds) fitTo(route.f.parishIds, animate);
    if (route.parish) openParish(route.parish, { entry, from: route.from });
    else if (route.eventId) openEvent(route.eventId, { entry });
  }
  /** A region's parishes fill the small map; its whole box (Queensland reaches Torres Strait) would leave it empty. */
  function frameRegion(slug, animate) {
    const loc = window.AgoraLocations.resolveLocation(slug);
    if (!loc || !map) return;
    const ids = S.parishes.filter(p => window.AgoraLocations.locationMatchesParish(loc, p)).map(p => p.id);
    if (ids.length) return fitTo(ids, animate);
    const b = window.AgoraLocations.locationBbox(loc);
    // Fiji's box crosses the antimeridian, and MapLibre wants west < east.
    if (b && b[0] < b[2]) map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 20, duration: animate ? 600 : 0 });
  }

  // The link, as it builds: the host faint, each segment in full, a parish in
  // its colour. Tap to copy. The same chip as the app's (updateModeUrl).
  const COPY_ICON = '<svg class="url-copy" viewBox="0 0 256 256" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M216 32H88a8 8 0 0 0-8 8v40H40a8 8 0 0 0-8 8v128a8 8 0 0 0 8 8h128a8 8 0 0 0 8-8v-40h40a8 8 0 0 0 8-8V40a8 8 0 0 0-8-8m-56 176H48V96h112Zm48-48h-32V88a8 8 0 0 0-8-8H96V48h112Z"/></svg>';
  function linkText(segs) {
    const host = location.host.replace(/^www\./, '');
    const piece = (x) => {
      const p = parishBySlug(x);
      return p ? `<span class="url-seg url-parish" style="color:${shown(jColor(p.jurisdiction))}">${esc(x)}</span>` : `<span class="url-seg">${esc(x)}</span>`;
    };
    let h = `<span class="url-host">${esc(host)}${BASE ? `<span class="url-sep">/</span>${esc(BASE.slice(1))}` : ''}</span>`;
    for (const seg of segs) h += `<span class="url-sep">/</span>${seg.split('+').map(piece).join('<span class="url-sep">+</span>')}`;
    return h;
  }
  function linkChip(segs, id = '') {
    return `<button class="url-chip" type="button" ${id ? `id="${id}"` : ''} data-copy="${esc(pathOf(segs))}" aria-label="Copy this link"><span class="url-text">${linkText(segs)}</span>${COPY_ICON}</button>`;
  }
  /** Long links scroll to their end, faded where they hide something. */
  function fitLinks(root = document) {
    requestAnimationFrame(() => $$('.url-text', root).forEach(el => {
      el.scrollLeft = el.scrollWidth;
      el.classList.toggle('fade-left', el.scrollWidth > el.clientWidth + 1);
    }));
  }
  let lastLink = null;
  function renderLink() {
    const btn = $('#page-link');
    if (!btn || btn._copied) return;
    const segs = pageSegs();
    const key = segs.join('/');
    btn.dataset.copy = pathOf(segs);
    const el = btn.querySelector('.url-text');
    el.innerHTML = linkText(segs);
    // The whole link glows when it changes, in the colour of its parish if it names one.
    if (lastLink !== null && key !== lastLink) {
      const p = segs.map(x => x.split('+').map(parishBySlug).find(Boolean)).filter(Boolean).pop();
      el.style.setProperty('--glow', p ? shown(jColor(p.jurisdiction)) : 'var(--accent)');
      el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    }
    lastLink = key;
    fitLinks(btn.parentNode);
  }
  /** A day's link to the clipboard, and a tick where its icon was. */
  async function copyDay(btn) {
    const url = location.origin + btn.dataset.copyDay;
    try { await navigator.clipboard.writeText(url); } catch {
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* nothing more to try */ }
      ta.remove();
    }
    btn.classList.add('copied');
    btn.innerHTML = CHECK;
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = COPY_ICON; }, 1200);
  }
  async function copyLink(btn) {
    const url = location.origin + btn.dataset.copy;
    try { await navigator.clipboard.writeText(url); } catch {
      const ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch { /* nothing more to try */ }
      ta.remove();
    }
    const el = btn.querySelector('.url-text');
    const was = el.innerHTML;
    btn._copied = true;
    el.innerHTML = '<span class="url-copied">COPIED</span>';
    setTimeout(() => { btn._copied = false; el.innerHTML = was; if (btn.id === 'page-link') renderLink(); else fitLinks(btn.parentNode); }, 900);
  }

  // ── The feed, from the bundle ─────────────────────────────────────────

  let feedCache = { key: '', list: [] };
  function feedFor(days) {
    const t = todayKey();
    const from = new Date(Date.now() - 6 * 3600000).toISOString();
    const to = new Date(Date.parse(addDays(t, days) + 'T14:00:00Z')).toISOString();
    const key = `${from.slice(0, 13)}|${to}|${S.loads}`;
    if (feedCache.key !== key) {
      const list = window.agoraBundle.feed(from, to).sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
      feedCache = { key, list };
    }
    return feedCache.list;
  }
  function upcomingOneOffs(pid) {
    const raw = window.agoraBundle.raw;
    if (!raw) return [];
    const now = Date.now();
    return (raw.events || []).filter(e => visible(e) && (e.parish_id === pid || (raw.event_parishes || []).some(x => x.event_id === e.id && x.parish_id === pid))
      && endMs(e) >= now).sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
  }

  // ── Avatars ───────────────────────────────────────────────────────────

  function avatar(p, cls = '') {
    if (!p) return `<span class="av ${cls}"></span>`;
    const c = jColor(p.jurisdiction);
    if (p.logo_path) return `<span class="av ${cls}" style="--j:${c}"><img src="${esc(p.logo_path)}" alt="" loading="lazy" onerror="this.remove()"><b>${esc((p.acronym || p.name || '?').slice(0, 3))}</b></span>`;
    return `<span class="av ${cls}" style="--j:${c}"><b>${esc((p.acronym || p.name || '?').slice(0, 3))}</b></span>`;
  }

  // ── Icons ─────────────────────────────────────────────────────────────

  const I = {
    x: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    share: '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M8 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
    signIn: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 16l4-4-4-4M14 12H4"/></svg>',
    signOut: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="M16 16l4-4-4-4M20 12H10"/></svg>',
    sliders: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 4v6M5 14v6M12 4v10M12 18v2M19 4v2M19 10v10"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="16" r="2"/><circle cx="19" cy="8" r="2"/></svg>',
    plusSm: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    star: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1-4.5-4.2 6.1-.8z"/></svg>',
    starOn: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1-4.5-4.2 6.1-.8z"/></svg>',
    more: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    car: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11a2 2 0 0 1 2 2v4a1 1 0 0 1-1 1h-1v1a1 1 0 0 1-2 0v-1H7v1a1 1 0 0 1-2 0v-1H4a1 1 0 0 1-1-1v-4a2 2 0 0 1 2-2zm2.1 0h9.8l-1.2-3.6a.5.5 0 0 0-.5-.4H8.8a.5.5 0 0 0-.5.4zM7 15.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm10 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/></svg>',
    phone: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>',
    globe: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>',
    map: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/></svg>',
    chev: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>',
    // The footrest rises to the viewer's LEFT, Christ's right and the good
    // thief's side, as on every Orthodox cross (scripts/build-og-images.mjs).
    cross: '<svg viewBox="0 0 40 64" aria-hidden="true" fill="currentColor"><rect x="17" y="0" width="6" height="64" rx="1"/><rect x="9" y="9" width="22" height="5" rx="1"/><rect x="2" y="21" width="36" height="6" rx="1"/><rect x="9" y="44" width="22" height="5" rx="1" transform="rotate(20 20 46.5)"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>',
    pin: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  };

  // ── The map: the app's own, in a viewport ─────────────────────────────
  //
  // map.js, unchanged: the same basemap, dots, grapes, labels, halos, squares
  // and favourite stars as the map at /. This page hands it a state shaped
  // like app.js's — the parishes that pass this page's filters (a filter
  // prunes the map, as a jurisdiction or a language does there), the events of
  // today and tomorrow for the halos, the parish whose card is open as the
  // focus, and where the person is — and answers the few things it asks of
  // the page around it.

  let map = null;
  const mapState = {
    parishes: [],
    events: [],
    schedules: [],
    mode: 'events',
    filters: { jurisdiction: null, parishIds: null, lang: null, bookmarked: null, location: null },
    parishSheetFocus: null,
    selectionMode: false,
    locationActive: false,
    userLat: null,
    userLng: null,
    // This page frames the start itself (startMap), so the first load must
    // not fit the whole of Oceania over it.
    cameraOwned: true,
  };
  window.agoraStateRef = mapState;
  window.openParishSheet = (id) => openParish(id);
  window.agoraOpenEventSheet = (id) => openEvent(id);
  window.agoraClearParishFocus = () => {};
  window.agoraIsFavourite = (id) => isFav(id);
  window.rawJurisColor = (j) => jColor(j);
  // No sheet covers this map, so a fit or a grape's fly-in centres on the
  // whole viewport.
  window.agoraIsDesktop = () => false;
  window.agoraSheetY = () => window.innerHeight;
  // What lights a halo, and which parishes are "active": this page's filters,
  // never the viewport (map.js's own rule).
  window.applyFilters = window.applyNonViewportFilters = (evs) => evs.filter(e => eventPasses(e, { scoped: false }));
  window.agoraOnViewportMapPhase = () => onView();

  function syncMap() {
    if (!map) return;
    const dim = S.juris || S.focus || filtersOn();
    mapState.parishes = dim ? S.parishes.filter(parishPasses) : S.parishes;
    mapState.events = feedFor(2);
    mapState.locationActive = !!S.loc;
    mapState.userLat = S.loc ? S.loc.lat : null;
    mapState.userLng = S.loc ? S.loc.lng : null;
    window.updateMap(mapState);
  }
  /** The open parish card's parish wears its logo on the map, as at /. */
  function setMapFocus(pid) {
    if (mapState.parishSheetFocus === (pid || null)) return;
    mapState.parishSheetFocus = pid || null;
    syncMap();
  }
  /** The map starts while the bundle is still on its way; it needs nothing from it. */
  async function startMap() {
    mapState.locationActive = !!S.loc;
    mapState.userLat = S.loc ? S.loc.lat : null;
    mapState.userLng = S.loc ? S.loc.lng : null;
    await window.initMap(mapState);
    map = window.agoraMap;
    // The map's own first full draw. initMap returns before it can happen, so
    // this is never too late to hear it.
    S.mapLoaded = new Promise(resolve => map.once('load', resolve));
    // Where the person is; else Sydney, where most of the parishes are.
    map.fitBounds(S.loc ? [[S.loc.lng - 0.35, S.loc.lat - 0.28], [S.loc.lng + 0.35, S.loc.lat + 0.28]]
      : [[150.6, -34.15], [151.35, -33.6]], { animate: false, padding: 0 });
  }

  function onView() {
    if (!map) return;
    S.bounds = map.getBounds();
    S.inView = new Set(S.parishes.filter(p => isFinite(p.lat) && p.lat != null && S.bounds.contains([p.lng, p.lat])).map(p => p.id));
    const c = map.getCenter();
    $('#place-name').textContent = S.loc && km(S.loc, { lat: c.lat, lng: c.lng }) < 15 ? 'Near you' : placeName(c.lat, c.lng, map.getZoom());
    $('#place-sub').textContent = S.loc && km(S.loc, { lat: c.lat, lng: c.lng }) < 15 ? placeName(c.lat, c.lng, 10) : 'orthodoxy.au';
    renderInView();
    renderFeeds();
  }
  function fitTo(ids, animate = true) {
    const ps = [...ids].map(id => S.byId.get(id)).filter(p => p && isFinite(p.lat) && p.lat != null);
    if (!ps.length || !map) return;
    const near = S.loc ? ps.filter(p => km(S.loc, p) < 60) : [];
    const use = near.length >= 3 ? near : ps;
    const b = new maplibregl.LngLatBounds();
    use.forEach(p => b.extend([p.lng, p.lat]));
    map.fitBounds(b, { padding: 40, maxZoom: 13, duration: animate ? 600 : 0 });
  }

  // ── Full screen ───────────────────────────────────────────────────────

  function setFullscreen(on) {
    document.body.classList.toggle('map-full', on);
    $('#btn-fullscreen').setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    setTimeout(() => map && map.resize(), 30);
    setTimeout(() => map && map.resize(), 320);
  }

  // ── Jurisdiction tabs (above the viewport) ────────────────────────────
  //
  // The app's banner (filters.js): each name in its own colour, underlined
  // while none is chosen; the chosen one filled, the others dimmed.

  const TAB_ORDER = ['antiochian', 'greek', 'serbian', 'russian', 'romanian', 'macedonian'];
  /** A colour as it is drawn: lifted on the dark scheme, as app.js does. */
  const shown = (hex) => (dark() && window.agoraLiftForDark ? window.agoraLiftForDark(hex) : hex);
  function renderJurisChips() {
    const row = $('#juris-row');
    row.classList.toggle('has-active', !!S.juris);
    row.innerHTML = TAB_ORDER.map(j => {
      const on = S.juris === j;
      return `<button class="jurisdiction-chip${on ? ' active' : ''}" type="button" data-juris="${j}" style="--j:${shown(jColor(j))}" aria-pressed="${on}">${esc(JURIS[j].short)}</button>`;
    }).join('');
  }

  // ── What the viewport holds ───────────────────────────────────────────
  //
  // Under the small map, a chip that says it in words: how many parishes are
  // in view, how many with service times, and up to seven of their logos.
  //
  // Full screen, the app's row instead (renderParishPills), at the foot of the
  // map: each parish its logo, or its acronym in its colour on white, ringed
  // in that colour. Those in view first, nearest first; those out of view
  // faded and grey-ringed. With the person's location on, a small distance
  // under each.
  //
  // The chip, and the count at the row's head, open the parishes in view as a
  // collection.

  function viewParishes() {
    return S.parishes.filter(p => (!S.inView || S.inView.has(p.id)) && parishPasses(p));
  }
  function pillLogo(p) {
    if (p.logo_path) return `<span class="pill-logo avatar-logo"><img src="${esc(p.logo_path)}" alt="" loading="lazy"></span>`;
    const text = String(p.acronym || (p.name || '?')[0]).toUpperCase();
    return `<span class="pill-logo avatar-acronym" style="--avatar-ink:${shown(jColor(p.jurisdiction))}"><span class="avatar-acronym-text" data-len="${Math.min(text.length, 5)}">${esc(text)}</span></span>`;
  }
  function renderInView() {
    renderInViewChip();
    renderParishRow();
  }
  function renderInViewChip() {
    const ps = viewParishes();
    const o = sortOrigin();
    // Logos first, then parishes with times, then the nearest.
    const ranked = ps.slice().sort((a, b) => (!!b.logo_path - !!a.logo_path)
      || (rulesOf(b.id).length > 0) - (rulesOf(a.id).length > 0)
      || (o ? km(o, a) - km(o, b) : 0));
    const logos = ranked.slice(0, 7).map(p => avatar(p, 'stack')).join('');
    const withTimes = ps.filter(p => rulesOf(p.id).some(liveRule)).length;
    $('#inview').innerHTML = ps.length
      ? `<span class="stackrow">${logos}</span>
         <span class="inview-text"><span><b>${ps.length} ${ps.length === 1 ? 'parish' : 'parishes'}</b> in view</span><small>${withTimes} with service times</small></span>
         <span class="inview-go">${I.chev}</span>`
      : `<span class="inview-text"><b>No parishes here</b><small>Pan or zoom out</small></span>`;
  }
  function renderParishRow() {
    const o = S.loc || (map ? map.getCenter() : null);
    const vp = S.inView;
    let ps = S.parishes.filter(p => p.id !== '_unassigned' && parishPasses(p));
    ps = o ? ps.map(p => ({ p, d: isFinite(p.lat) && p.lat != null ? km(o, p) : Infinity })).sort((a, b) => a.d - b.d).map(x => x.p)
      : ps.sort((a, b) => String(a.acronym || a.name).localeCompare(String(b.acronym || b.name)));
    if (vp) ps = [...ps.filter(p => vp.has(p.id)), ...ps.filter(p => !vp.has(p.id))];
    $('#inview-n').textContent = viewParishes().length;
    $('#btn-favourites').hidden = !favIds().length;
    $('#parish-pills').innerHTML = ps.map(p => {
      const tone = !vp || vp.has(p.id) ? 'on' : 'off';
      const star = isFav(p.id) ? '<span class="pill-fav" aria-hidden="true">★</span>' : '';
      let dist = '';
      if (S.loc && isFinite(p.lat) && p.lat != null) {
        const k = km(S.loc, p);
        const cls = k <= 5 ? 'distance-near' : k <= 15 ? 'distance-mid' : 'distance-far';
        dist = `<span class="pill-dist ${cls}">${esc(k < 10 ? k.toFixed(1) : String(Math.round(k)))}km</span>`;
      }
      return `<button class="parish-pill pill-${tone}" type="button" data-parish="${esc(p.id)}" style="--pill-ring:${shown(jColor(p.jurisdiction))}" title="${esc(p.name || '')}" aria-label="${esc(p.name || p.acronym || '')}">${pillLogo(p)}${star}${dist}</button>`;
    }).join('');
    const list = $('#parish-pills');
    if (list.scrollLeft) list.scrollLeft = 0;
  }

  // ── Active filters, said once beside their button ────────────────────

  function renderActive() {
    const f = S.f, SV = window.AgoraServices;
    const chip = (k, label) => `<button class="afchip" type="button" data-clear="${k}" aria-label="${esc(`Remove ${label}`)}">${esc(label)}${I.x}</button>`;
    const bits = [];
    if (S.focus) bits.push(chip('focus', S.focus.title));
    const loc = regionOf(f);
    if (loc) bits.push(chip('location', loc.label));
    if (f.monasteries) bits.push(chip('monasteries', 'Monasteries'));
    if (f.day != null) bits.push(chip('day', SV.dayName(f.day)));
    if (f.dayGroup) bits.push(chip('dayGroup', SV.dayGroupLabel(f.dayGroup)));
    if (f.part) bits.push(chip('part', SV.partOfDayLabel(f.part)));
    if (f.service) bits.push(chip('service', SV.serviceLabel(f.service)));
    if (f.kind) bits.push(chip('kind', f.kindSub ? kindSubLabel(f.kindSub) : KIND_NAMES[f.kind] || f.kind));
    if (f.lang) bits.push(chip('lang', f.langStrict ? `${f.lang} only` : f.lang));
    if (f.timesOnly) bits.push(chip('timesOnly', 'With service times'));
    if (f.parishIds) {
      const l = f.listId && listById(f.listId);
      bits.push(chip('parishIds', l ? l.name : [...f.parishIds].map(id => S.byId.get(id)).filter(Boolean).map(p => p.acronym || p.name).join(' + ')));
    }
    $('#active-filters').innerHTML = bits.join('');
    const n = filterCount();
    const count = $('#filter-count');
    count.hidden = !n;
    count.textContent = n;
    renderPanel();
  }

  /** Repaint everything the filters touch. `url`: push a step, replace this one, or leave it. */
  function refilter({ url = 'push' } = {}) {
    syncMap();
    renderJurisChips();
    renderInView();
    renderActive();
    renderFeeds();
    if (url === 'none') return renderLink();
    // With the filters open, only their first change is a step of its own.
    const push = url === 'push' && !stack.length && !(S.panel && S.panel.pushed);
    if (S.panel && push) S.panel.pushed = true;
    syncURL({ push });
  }

  // ── Today ─────────────────────────────────────────────────────────────

  function eventRow(e, { showDay = false, now = false, here = null } = {}) {
    const p = S.byId.get(e.parish_id);
    const l = local(e);
    const d = distOf(e.lat != null ? e : p);
    const title = e.feast ? `${e.title}` : e.title;
    // On a parish's own card its name is the card's; another parish's is said.
    const sub = here && e.parish_id === here ? ''
      : `<span class="esub">${avatar(p, 'xs')}<span>${esc(p ? p.name : e.parish_name || '')}</span>${d != null ? `<em>${esc(fmtKm(d))}</em>` : ''}</span>`;
    return `<button class="erow${now ? ' now' : ''}" type="button" data-event="${esc(e.id)}">
        <span class="etime">${now ? '<i class="live"></i>Now' : timeHTML(l.hm)}${showDay ? `<small>${esc(dayLabel(l.date))}</small>` : ''}</span>
        ${roundel(e.event_type)}
        <span class="ebody"><span class="etitle">${esc(title)}</span>
          ${sub}
          ${e.feast ? `<span class="efeast">${esc(e.feast)}</span>` : ''}</span>
        ${e.poster_path ? `<img class="ethumb" src="${esc(e.poster_path)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      </button>`;
  }

  function renderToday() {
    const el = $('#today');
    const all = feedFor(2).filter(e => eventPasses(e) && inViewEvent(e));
    const now = Date.now();
    const t = todayKey();
    const live = all.filter(e => Date.parse(e.start_utc) <= now && endMs(e) > now);
    const later = all.filter(e => Date.parse(e.start_utc) > now && local(e).date === t);
    const tomorrow = all.filter(e => local(e).date === addDays(t, 1));
    let body = '';
    if (live.length) body += `<div class="tsub">Happening now</div>${live.slice(0, 4).map(e => eventRow(e, { now: true })).join('')}`;
    if (later.length) body += `<div class="tsub">Later today</div>${later.slice(0, live.length ? 3 : 5).map(e => eventRow(e)).join('')}`;
    if (!live.length && !later.length) {
      body += `<div class="tempty">Nothing more today in view.</div>`;
      if (tomorrow.length) body += `<div class="tsub">Tomorrow</div>${tomorrow.slice(0, 4).map(e => eventRow(e)).join('')}`;
    }
    const more = later.length + live.length - (live.length ? Math.min(4, live.length) + Math.min(3, later.length) : Math.min(5, later.length));
    const d = new Date(t + 'T00:00:00Z');
    el.innerHTML = `<header class="card-head"><div><h2>Today</h2><p>${WD_LONG[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}${live.length ? ` · <span class="livetxt">${live.length} on now</span>` : ''}</p></div></header>
      ${body}
      <button class="see-all" type="button" data-jump="stream">${more > 0 ? `${more} more today, and every day after` : 'Every service and event, day by day'} ${I.chev}</button>`;
  }

  // ── Shelves: collections of parishes ──────────────────────────────────

  /**
   * A collection is its link (shared/collections.js, which the Worker's page
   * for it and the sitemap read too): its filters are what the link means,
   * read as any link is, and its parishes the ones that pass them.
   */
  function byFilters(c) {
    if (!c.f && !c.juris) return c;
    const f = { ...blankFilters(), ...(c.f || {}) };
    return { ...c, f, ids: c.ids || S.parishes.filter(p => parishMatches(p, f, c.juris || null)).map(p => p.id), segs: segsFor({ juris: c.juris || null, f }) };
  }
  /** A shared collection with this page's look, and its filters from its link. */
  function fromShared(c, look) {
    const route = readPath(BASE + c.path);
    return byFilters({ ...c, ...look, juris: route.juris, f: route.f });
  }
  // The look of each, which is this page's business: the art behind its card
  // and what is drawn on it.
  const LOOK = {
    english: { art: 'linear-gradient(135deg,#1d4ed8,#0ea5e9)', glyph: 'En' },
    sunday: { art: 'linear-gradient(135deg,#7c2d12,#d97706)', icon: 'L', kind: 'liturgy' },
    vespers: { art: 'linear-gradient(135deg,#1e1b4b,#6d28d9)', icon: 'P', kind: 'prayer' },
    weeknights: { art: 'linear-gradient(135deg,#0f766e,#22c55e)', icon: 'P', kind: 'prayer' },
    talks: { art: 'linear-gradient(135deg,#78350f,#ca8a04)', icon: 'T', kind: 'talk' },
    socials: { art: 'linear-gradient(135deg,#9d174d,#f43f5e)', icon: 'S', kind: 'social' },
    monasteries: { art: 'linear-gradient(135deg,#3f3f46,#a8a29e)', glyph: '☦' },
  };
  /** The curated slices: preset filters that open as a card of parishes. */
  function curated() {
    return window.AgoraCollections.CURATED.map(c => fromShared(c, LOOK[c.id])).filter(c => c.ids.length);
  }
  const LANGS = [
    ['Greek', 'Ελ', '#0061fe'], ['Arabic', 'عر', '#7c3bc1'], ['Serbian', 'Ср', '#cc2234'], ['Slavonic', 'Сл', '#d38301'],
    ['Romanian', 'Ro', '#4e7a27'], ['Macedonian', 'Мк', '#b92d5d'],
  ];
  function languageCollections() {
    return window.AgoraCollections.LANGUAGES.map(c => {
      const [, glyph, color] = LANGS.find(([l]) => l === c.lang) || [c.lang, c.title.slice(0, 2), '#64748b'];
      return fromShared(c, { glyph, art: `linear-gradient(160deg,${color},${shade(color, -0.35)})` });
    }).filter(c => c.ids.length);
  }
  /** A jurisdiction's logo, once /admin has one: the picture on its card. */
  const jurisLogo = (j) => ((window.agoraBundle && window.agoraBundle.raw && window.agoraBundle.raw.jurisdiction_logos) || {})[j] || null;
  function jurisCollections() {
    return JURIS_ORDER.map(j => window.AgoraCollections.byId('j-' + j)).filter(Boolean).map(c => fromShared(c, {
      logo: jurisLogo(c.jurisdiction),
      art: `radial-gradient(120% 90% at 85% 10%, ${shade(jColor(c.jurisdiction), 0.35)}, ${jColor(c.jurisdiction)} 55%, ${shade(jColor(c.jurisdiction), -0.4)})`,
    }));
  }
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => Math.round(amt > 0 ? v + (255 - v) * amt : v * (1 + amt)));
    return '#' + ch.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
  }
  let COLL = new Map();
  function remember(cs) { cs.forEach(c => COLL.set(c.id, c)); return cs; }

  function collCard(c, size = '') {
    const n = c.ids.length;
    const inView = S.inView ? c.ids.filter(id => S.inView.has(id)).length : null;
    const sub = `${n} ${n === 1 ? 'place' : 'places'}${inView != null && inView && inView !== n ? ` · ${inView} in view` : ''}`;
    const art = c.logo ? `<span class="clogo"><img src="${esc(c.logo)}" alt=""></span>`
      : c.glyph ? `<span class="cglyph">${esc(c.glyph)}</span>`
      : c.icon ? roundel(c.kind, true)
      : c.juris ? `<span class="ccross">${I.cross}</span>`
      : '';
    const logos = c.ids.map(id => S.byId.get(id)).filter(p => p && p.logo_path).slice(0, 3);
    return `<button class="ccard ${size}" type="button" data-coll="${esc(c.id)}">
        <span class="cart" style="background:${c.art}">${art}${logos.length ? `<span class="clogos">${logos.map(p => avatar(p, 'xs')).join('')}</span>` : ''}</span>
        <span class="ctext"><span class="ckicker">${esc(c.kicker || '')}</span><span class="ctitle">${esc(c.title)}</span><span class="csub">${esc(sub)}</span></span>
      </button>`;
  }
  function shelf(el, title, sub, cards, { action } = {}) {
    el.innerHTML = `<header class="shelf-head"><h2>${esc(title)} ${action ? `<button class="shelf-act" type="button" data-shelf="${esc(action)}">${I.chev}</button>` : ''}</h2>${sub ? `<p>${esc(sub)}</p>` : ''}</header>
      <div class="shelf-row">${cards}</div>`;
  }
  function renderCollections() {
    shelf($('#shelf-collections'), 'Collections', null, remember(curated()).map(c => collCard(c)).join(''));
    shelf($('#shelf-languages'), 'By language', null, remember(languageCollections()).map(c => collCard(c, 'sm')).join(''));
    shelf($('#shelf-jurisdictions'), 'Jurisdictions', null, remember(jurisCollections()).map(c => collCard(c, 'wide')).join(''));
    renderLists();
  }
  function renderLists() {
    const ls = allLists().map(l => ({
      id: 'list-' + l.id, listId: l.id, title: l.name, kicker: l.fav ? 'Your list' : 'Your list',
      art: l.fav ? 'linear-gradient(160deg,#fde68a,#f59e0b)' : 'linear-gradient(160deg,#cbd5e1,#64748b)',
      glyph: l.fav ? '★' : '☰', ids: l.ids, blurb: l.fav ? 'Parishes you starred.' : 'A list you made.',
      // A list of parishes is a link: /sgr+snb.
      ...(l.ids.length ? byFilters({ ids: l.ids, f: { parishIds: new Set(l.ids), listId: l.id } }) : {}),
    }));
    remember(ls);
    shelf($('#shelf-lists'), 'Your lists', null,
      ls.map(c => collCard(c, 'sm')).join('') + `<button class="ccard sm new" type="button" data-newlist><span class="cart">${I.plus}</span><span class="ctext"><span class="ctitle">New list</span><span class="csub">Collect parishes</span></span></button>`);

    renderPanel();
  }

  // ── What's on: the App Store's poster shelf ───────────────────────────

  function renderWhatsOn() {
    const el = $('#shelf-whatson');
    const raw = window.agoraBundle.raw;
    if (!raw) return;
    const now = Date.now();
    const horizon = now + 60 * DAY;
    // One-offs with posters first, then rule occurrences that carry their own.
    const pool = feedFor(Math.max(S.streamDays, 21))
      .concat((raw.events || []).filter(e => Date.parse(e.start_utc) > now + 21 * DAY && Date.parse(e.start_utc) < horizon))
      // Regular services are the timetable's; this shelf is for the things that happen once.
      .filter(e => e.poster_path && endMs(e) > now && !['liturgy', 'prayer'].includes(e.event_type) && eventPasses(e));
    const seen = new Set();
    const uniq = pool.filter(e => {
      const k = e.schedule_id ? `r${e.schedule_id}` : `e${e.id}`;
      if (seen.has(k)) return false; seen.add(k); return true;
    });
    let list = uniq.filter(inViewEvent);
    let far = false;
    if (list.length < 2) { list = uniq; far = true; }
    list = list.sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc)).slice(0, 12);
    if (!list.length) { el.innerHTML = ''; return; }
    const cards = list.map(e => {
      const p = S.byId.get(e.parish_id);
      return `<button class="poster" type="button" data-event="${esc(e.id)}">
          <span class="pimg"><img src="${esc(e.poster_path)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('noimg')">
            <span class="pover"><span class="pkicker">${esc(kindLabel(e.event_type))} · ${esc(whenShort(e))}</span><span class="ptitle">${esc(e.title)}</span></span></span>
          <span class="pfoot">${avatar(p, 'sm')}<span class="pfname"><b>${esc(p ? p.name : '')}</b><small>${esc(p ? JURIS[p.jurisdiction]?.long || '' : '')}${distOf(p) != null ? ` · ${fmtKm(distOf(p))}` : ''}</small></span><span class="pbtn">View</span></span>
        </button>`;
    }).join('');
    shelf(el, "What's on", far ? 'Nothing with a poster in view, so from further afield' : 'Festivals, talks and gatherings, in view', cards);
  }

  // ── Days: the stream's, and a parish's Coming up ───────────────────────
  //
  // The app's dated list: a quiet header for each day with its own link, the
  // morning's services and events, then the evening's under the moon. A date
  // picked from the calendar is where the list starts — a FROM, as every date
  // in a link is — and it goes in the link: /next/2026-10-25, /next/sgr/2026-10-25.

  /** The bundle holds every day to `end`, asking for more when it does not. */
  async function ensureLoaded(end) {
    if (S.loadedTo && end <= S.loadedTo) return;
    await window.agoraBundle.load({ from: new Date().toISOString(), to: new Date(Date.parse(end + 'T14:00:00Z')).toISOString() });
    if (!S.loadedTo || end > S.loadedTo) S.loadedTo = end;
    S.loads++;
  }
  /** Every service and event on a day in [start, start + days), each by its own day. */
  let rangeCache = { key: '', list: [] };
  function feedRange(start, days) {
    // Wide enough for New Zealand's morning and Perth's night; each event's own day decides.
    const from = new Date(Date.parse(start + 'T00:00:00Z') - 14 * 3600000).toISOString();
    const to = new Date(Date.parse(addDays(start, days) + 'T12:00:00Z')).toISOString();
    const key = `${from}|${to}|${S.loads}`;
    if (rangeCache.key !== key) {
      const list = window.agoraBundle.feed(from, to).sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
      rangeCache = { key, list };
    }
    const end = addDays(start, days);
    return rangeCache.list.filter(e => { const k = local(e).date; return k >= start && k < end; });
  }
  const shortDate = (k) => { const d = new Date(k + 'T00:00:00Z'); return `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };
  const CHECK = '<svg viewBox="0 0 256 256" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="m229.66 77.66-128 128a8 8 0 0 1-11.32 0l-56-56a8 8 0 0 1 11.32-11.32L96 188.69 218.34 66.34a8 8 0 0 1 11.32 11.32"/></svg>';
  const CAL = '<svg viewBox="0 0 256 256" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M208 32h-24v-8a8 8 0 0 0-16 0v8H88v-8a8 8 0 0 0-16 0v8H48a16 16 0 0 0-16 16v160a16 16 0 0 0 16 16h160a16 16 0 0 0 16-16V48a16 16 0 0 0-16-16M72 48v8a8 8 0 0 0 16 0v-8h80v8a8 8 0 0 0 16 0v-8h24v32H48V48Zm136 160H48V96h160z"/></svg>';
  /** Where a list of days starts: today, or a date picked from the calendar. */
  function datePickHTML(scope, from) {
    const t = todayKey();
    return `<div class="date-pick">
        <button class="fpill${from ? ' on' : ''}" type="button" data-pick-date="${scope}">${CAL}<span>${from ? esc(`From ${shortDate(from)}`) : 'Pick a date'}</span></button>
        ${from ? `<button class="fpill" type="button" data-date-clear="${scope}">Today</button>` : ''}
        <input class="date-input" type="date" data-date-input="${scope}" min="${t}" max="${addDays(t, 365)}" value="${esc(from || t)}" tabindex="-1" aria-label="Start from a date">
      </div>`;
  }
  /** A day's own link, copied with a tap, as the app's day headers have. */
  const dayLink = (k, path) => `<button class="day-link" type="button" data-copy-day="${esc(path)}" aria-label="${esc(`Copy the link from ${shortDate(k)}`)}" title="Copy the link from this day">${COPY_ICON}</button>`;
  function daysHTML(list, { start, days, linkFor, empty = false, row = {} }) {
    const byDay = new Map();
    for (const e of list) {
      const k = local(e).date;
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(e);
    }
    const out = [];
    for (let i = 0; i < days; i++) {
      const k = addDays(start, i);
      const es = byDay.get(k) || [];
      if (!es.length && !empty) continue;
      const head = `<h3 class="dh${weekdayOf(k) === 0 ? ' sun' : ''}"><span>${esc(dayLabel(k, true))}</span>${dayLink(k, linkFor(k))}</h3>`;
      if (!es.length) { out.push(`<section class="sday empty" data-date="${k}">${head}<p>Nothing in view</p></section>`); continue; }
      const morning = es.filter(e => !isEvening(e)), evening = es.filter(isEvening);
      out.push(`<section class="sday" data-date="${k}">${head}${morning.map(e => eventRow(e, row)).join('')}${evening.length ? EVENING + evening.map(e => eventRow(e, row)).join('') : ''}</section>`);
    }
    return out.join('');
  }

  // ── The stream: every service and event, for as long as you scroll ────

  function renderStream() {
    const start = S.from || todayKey();
    const now = Date.now();
    const list = feedRange(start, S.streamDays).filter(e => eventPasses(e) && inViewEvent(e) && endMs(e) > now);
    $('#stream-days').innerHTML = daysHTML(list, {
      start, days: S.streamDays, empty: true,
      linkFor: (k) => pathOf(segsFor({ juris: S.juris, f: S.f, from: k })),
    });
    $('#stream-when').innerHTML = datePickHTML('page', S.from);
    const n = S.inView ? viewParishes().length : S.parishes.length;
    $('#stream-sub').textContent = `${n} parishes in view, day by day. Keep scrolling.`;
  }
  async function growStream() {
    if (S.streamBusy || S.streamDays >= 365) return;
    S.streamBusy = true;
    const next = S.streamDays + 14;
    try {
      await ensureLoaded(addDays(S.from || todayKey(), next));
      S.streamDays = next;
      renderStream();
    } catch (err) { console.warn(err); }
    S.streamBusy = false;
    if (S.streamDays >= 365) $('#stream-more').textContent = 'That’s a year. Come back closer to the time.';
  }
  /** The stream from a date, or from today again; a step back undoes it. */
  async function setPageDate(k) {
    S.from = k && k > todayKey() ? k : null;
    S.streamDays = 14;
    if (S.from) await ensureLoaded(addDays(S.from, S.streamDays)).catch(err => console.warn(err));
    refilter();
    $('#stream').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderFeeds() {
    renderToday();
    renderWhatsOn();
    renderStream();
    // Counts on the shelves move with the view.
    $$('.ccard[data-coll]').forEach(b => {
      const c = COLL.get(b.dataset.coll);
      if (!c || !S.inView) return;
      const n = c.ids.length, v = c.ids.filter(id => S.inView.has(id)).length;
      const s = b.querySelector('.csub');
      if (s) s.textContent = `${n} ${n === 1 ? 'place' : 'places'}${v && v !== n ? ` · ${v} in view` : ''}`;
    });
  }

  // ── Sheets ────────────────────────────────────────────────────────────

  const stack = [];
  /**
   * A card over the page. `segs` is its own link (/sgr, /102, /sun/liturgy),
   * which the address takes while it is open; `entry: false` when the history
   * already holds its step (forward onto it).
   */
  function pushSheet(html, cls = '', { segs = null, entry = true } = {}) {
    const host = $('#sheets');
    const el = document.createElement('section');
    el.className = `sheet ${cls}`;
    el.setAttribute('role', 'dialog');
    el.innerHTML = html;
    el._segs = segs;
    host.appendChild(el);
    stack.push(el);
    $('#scrim').hidden = false;
    document.body.classList.add('sheet-open');
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
    const scroller = el.querySelector('.sheet-scroll');
    if (scroller) scroller.addEventListener('scroll', () => el.classList.toggle('scrolled', scroller.scrollTop > 40), { passive: true });
    if (entry) syncURL({ push: true, step: true });
    else writeURL();
    fitLinks(el);
    return el;
  }
  /** Take the top card away, without touching the history. */
  function dropSheet() {
    const el = stack.pop();
    if (!el) return;
    el.classList.remove('open');
    setTimeout(() => el.remove(), 320);
    if (!stack.length) { $('#scrim').hidden = true; document.body.classList.remove('sheet-open'); }
    const under = stack.filter(s => s.classList.contains('parish')).pop();
    setMapFocus(under ? under.dataset.pid : null);
  }
  /** Close the top card: a step back. */
  function popSheet() {
    if (!stack.length) return;
    dropSheet();
    goBack(1);
  }
  function closeAll() {
    const n = stack.length;
    while (stack.length) dropSheet();
    if (n) goBack(n);
  }

  function glassBar(title, sub, { share = true } = {}) {
    return `<div class="glassbar">
        ${share ? `<button class="gbtn" type="button" data-act="share" aria-label="Share">${I.share}</button>` : '<span class="gbtn-sp"></span>'}
        <div class="gtitle"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
        <button class="gbtn" type="button" data-act="close" aria-label="Close">${I.x}</button>
      </div>`;
  }

  async function share(title, path) {
    const url = location.origin + path;
    try {
      if (navigator.share) { await navigator.share({ title, url }); return; }
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch { /* dismissed */ }
  }

  // ── A parish's timetable, one line per service ────────────────────────
  //
  // Mon, Wed and Fri Vespers is ONE line with three days on it, not three
  // copies of Vespers. Rules that share a title, kind and time merge; what
  // differs between them (the days) is what the line lists. Set in the app's
  // timetable type: the days as quiet as its day names, the time with a small
  // AM, the morning's services before the evening's under the app's moon, and
  // the whole block on a rule in the parish's colour.

  const ORD = { first: '1st', second: '2nd', third: '3rd', fourth: '4th', last: 'last' };
  function qualifier(r) {
    const bits = [];
    if (r.week_of_month) bits.push(r.week_of_month.split(',').map(w => ORD[w.trim()] || w).join(' & '));
    if (r.week_parity) bits.push('fortnightly');
    return bits.join(' ');
  }
  function dayList(days) {
    const ds = [...new Set(days)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)); // Monday first, Sunday last
    if (ds.length === 7) return 'Every day';
    // Runs of three or more become a range: Mon–Fri.
    const idx = ds.map(d => (d + 6) % 7);
    const out = [];
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
      if (j - i >= 2) out.push(`${WD[(idx[i] + 1) % 7]}–${WD[(idx[j] + 1) % 7]}`);
      else for (let k = i; k <= j; k++) out.push(WD[(idx[k] + 1) % 7]);
      i = j + 1;
    }
    return out.join(', ');
  }
  /** The app's Evening divider: its moon and the word, as faint as a day's name. */
  const MOON = '<svg class="moon" viewBox="0 0 10 10" width="10" height="10" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M8.5,5 A3.5,3.5 0 1,0 1.5,5 A3.5,3.5 0 1,0 8.5,5Z M9.1,4.5 A2.9,2.9 0 1,0 3.3,4.5 A2.9,2.9 0 1,0 9.1,4.5Z"/></svg>';
  const EVENING = `<div class="eve">${MOON}<span>Evening</span></div>`;
  const isEvening = (row) => window.AgoraServices.partOfDayOf(row) === 'evening';
  /** A parish's colour where it marks the parish: its jurisdiction's, lifted in the dark. */
  const parishColor = (p) => shown(jColor(p ? p.jurisdiction : null));

  /** `edit`: whoever may change the timetable gets a pencil on each line. */
  function timetable(pid, { compact = false, edit = false } = {}) {
    const rs = rulesOf(pid).filter(liveRule);
    const lines = new Map();
    for (const r of rs) {
      const key = [r.title, r.event_type, r.start_time, qualifier(r), r.languages || ''].join('|');
      if (!lines.has(key)) lines.set(key, { r, days: [], ids: [] });
      lines.get(key).days.push(r.day_of_week);
      lines.get(key).ids.push(r.id);
    }
    // One week, as the app's timetable reads: the morning's services, then
    // the evening's under the moon, each from Sunday; the roundels say which kind.
    const firstDay = (l) => Math.min(...l.days);
    const ls = [...lines.values()].sort((a, b) => isEvening(a.r) - isEvening(b.r) || firstDay(a) - firstDay(b)
      || String(a.r.start_time).localeCompare(String(b.r.start_time)));
    const eve = ls.findIndex(l => isEvening(l.r));
    const line = (l) => {
      const q = qualifier(l.r);
      const langs = !compact && parseLangs(l.r.languages);
      return `<div class="tt-line">
          <span class="tt-days">${esc((q ? q + ' ' : '') + dayList(l.days))}</span>
          ${timeHTML(l.r.start_time)}
          <span class="tt-what">${roundel(l.r.event_type)}<span class="tt-title">${esc(l.r.title)}${langs && langs.length ? `<span class="tt-lang">${esc(langs.join(', '))}</span>` : ''}</span></span>
          ${edit ? `<button class="tt-edit" type="button" data-edit-rules="${esc(l.ids.join(','))}" aria-label="${esc(`Edit ${l.r.title}`)}">${I.pencil}</button>` : ''}
        </div>`;
    };
    const out = ls.map((l, i) => (i === eve ? EVENING : '') + line(l));
    return `<div class="tt${compact ? ' compact' : ''}${edit ? ' editing' : ''}" style="--pc:${parishColor(S.byId.get(pid))}">${out.join('')}</div>`;
  }
  function nextOf(pid, pred = () => true) {
    const now = Date.now();
    return feedFor(Math.max(S.streamDays, 14)).find(e => Date.parse(e.start_utc) > now && eventParishIds(e).includes(pid) && visible(e) && pred(e)) || null;
  }

  // ── Signed in ─────────────────────────────────────────────────────────
  //
  // The app's way of knowing (app.js checkAdmin, adminMay). /api/admin/ping is
  // the Worker reading the Access token Cloudflare put on the request, so its
  // answer IS whether this browser may administer, and `can` is the capability
  // map from worker/lib/roles.mjs that every route re-checks. Signed in is not
  // editing: what this decides is which controls a card offers, never whether
  // a write is allowed.

  const NOBODY = { signedIn: false, identity: null, role: null, parishIds: [], can: {}, openAsks: 0, parishNotices: 0, suggestions: 0 };
  S.who = NOBODY;
  async function checkSignIn() {
    const ping = await fetch('/api/admin/ping', { cache: 'no-store' }).catch(() => null);
    const who = ping && ping.ok ? await ping.json().catch(() => null) : null;
    S.who = who ? {
      signedIn: true,
      identity: typeof who.identity === 'string' ? who.identity : null,
      role: who.role || null,
      parishIds: who.parishIds || [],
      can: who.can || {},
      // What is waiting on this person: an owner's asks, a contact's notices,
      // and suggestions at the parishes they may edit (the Worker scopes all three).
      openAsks: who.openAsks || 0,
      parishNotices: who.parishNotices || 0,
      suggestions: who.suggestions || 0,
    } : NOBODY;
    // The cookie the Worker reads to answer a parish link with the app rather
    // than its lite card (worker/routes/pages.mjs). It grants nothing.
    try {
      document.cookie = S.who.role
        ? 'agora_admin=1; path=/; max-age=2592000; samesite=lax; secure'
        : 'agora_admin=; path=/; max-age=0; samesite=lax; secure';
    } catch { /* refused cookies only mean the lite card */ }
    syncAccount();
    // A card drawn before the answer came was drawn for a visitor.
    if (S.who.signedIn) for (const el of stack) if (el.classList.contains('parish')) repaintParish(el);
  }
  /**
   * May this account do `capability`, at this parish? The Worker's two
   * questions in its order: the role's map, then (for a parish contact only)
   * whether the parish is theirs.
   */
  function may(capability, parishId = null) {
    const w = S.who;
    if (!w.signedIn || !w.can[capability]) return false;
    if (w.role !== 'parish') return true;
    return !!parishId && w.parishIds.includes(parishId);
  }
  /** What is waiting, in words, or ''. */
  function waiting() {
    const { openAsks: a, parishNotices: n, suggestions: g } = S.who;
    return [a && `${a} ${a === 1 ? 'ask' : 'asks'} waiting`, n && `${n} new at your ${n === 1 ? 'parish' : 'parishes'}`,
      g && `${g} ${g === 1 ? 'suggestion' : 'suggestions'}`].filter(Boolean).join(', ');
  }
  function syncAccount() {
    const btn = $('#btn-account');
    const w = waiting();
    btn.classList.toggle('signed-in', S.who.signedIn);
    $('#account-dot').hidden = !(S.who.signedIn && w);
    const label = !S.who.signedIn ? 'Sign in' : w ? `Account: ${w}` : 'Account';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }
  // Signing in is a redirect Cloudflare owns: /admin is behind Access, so going
  // there is what shows its sign-in, and signing out is its own logout path.
  function openAccount() {
    const w = waiting();
    const rows = S.who.signedIn
      ? `<a class="lrow" href="/admin">${I.sliders}<span class="ln"><b>Admin panel</b>${w ? `<small>${esc(w)}</small>` : ''}</span></a>
         <a class="lrow" href="/cdn-cgi/access/logout">${I.signOut}<span class="ln"><b>Sign out</b></span></a>`
      : `<a class="lrow" href="/admin">${I.signIn}<span class="ln"><b>Sign in</b></span></a>`;
    const html = `<div class="lay-head"><h2>${S.who.signedIn ? 'Account' : 'Sign in'}</h2><button class="gbtn" type="button" data-act="close" aria-label="Close">${I.x}</button></div>
      <div class="sheet-scroll">
        ${S.who.signedIn && S.who.identity ? `<p class="lay-note">${esc(S.who.identity)}</p>` : ''}
        <div class="lists">${rows}</div>
      </div>`;
    pushSheet(html, 'mini');
  }

  // ── Contributing, and where things came from ───────────────────────────
  //
  // Wherever somebody could add something, a dotted "Add +". It opens the
  // app's suggest dialog (public/shared/suggest-dialog.js) with the topic
  // already chosen, and the suggestion goes to whoever keeps the parish, the
  // way the app's "Suggest edits" does. Nothing on the page changes.

  const SUGGEST = { service: 'A service time not listed', event: 'An event', details: "The parish's details — address, phone, website" };
  const addBox = (about, label) =>
    `<button class="add-box" type="button" data-suggest="${esc(about)}" aria-label="${esc(label)}">Add${I.plusSm}</button>`;

  // A rule as the suggest page lists it, so the dialog's choice is the one
  // selected there: "Sunday 9:30am · Divine Liturgy".
  const clock = (t) => {
    const [h, m] = String(t || '').split(':').map(Number);
    if (!Number.isFinite(h)) return t || '';
    return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`;
  };
  const serviceLine = (r) => `${WD_LONG[r.day_of_week]} ${clock(r.start_time)} · ${r.title}`;
  if (window.AgoraSuggest) {
    window.AgoraSuggest.servicesFor = (pid) => [...new Set(rulesOf(pid)
      .filter(r => !(r.effective_to && r.effective_to < todayKey()))
      .sort((a, b) => a.day_of_week - b.day_of_week || String(a.start_time).localeCompare(b.start_time))
      .map(serviceLine))];
  }
  // "Suggest an edit" is for whoever cannot make the edit themselves, as the
  // app's "Suggest edits" is (app.js contributeButtonHTML).
  const suggestsHere = (pid) => !may('schedule.edit', pid);
  const suggestEditHTML = (pid) => (suggestsHere(pid) ? '<button class="wide-btn" type="button" data-suggest="">Suggest an edit</button>' : '');
  function suggest(pid, about = '') {
    const p = S.byId.get(pid);
    if (!p || !window.AgoraSuggest) return;
    window.AgoraSuggest.open({ parishId: pid, parishName: p.full_name || p.name, services: window.AgoraSuggest.servicesFor(pid), about });
  }

  /** "Updated 3 months ago · Antiochian Archdiocese ↗", as the app has it. */
  const timesSource = (pid) => window.AgoraSourceLine.timetableSourceHTML(rulesOf(pid).filter(liveRule), { cls: 'src-line' });
  const detailsSource = (p) => window.AgoraSourceLine.detailsSourceHTML(p, { cls: 'src-line' });

  // ── The parish card ───────────────────────────────────────────────────

  // Coming up: this parish's days, from today or from a date picked, a
  // fortnight at a time. The date is in the card's link.
  const CU_DAYS = 14;
  function comingUpHTML(pid, from, days) {
    const p = S.byId.get(pid);
    const start = from || todayKey();
    const now = Date.now();
    const list = feedRange(start, days).filter(e => visible(e) && eventParishIds(e).includes(pid) && endMs(e) > now);
    const body = daysHTML(list, { start, days, row: { here: pid }, linkFor: (k) => pathOf(segsFor({ parish: p, from: k })) });
    return `${datePickHTML('card', from)}
      ${body || '<div class="tt-none sm">Nothing on file for these days.</div>'}
      ${days < 365 ? `<button class="more-days" type="button" data-more-days>The ${CU_DAYS} days after ${esc(shortDate(addDays(start, days - 1)))}</button>` : ''}`;
  }
  async function refreshComingUp(el) {
    const box = el.querySelector('.cu');
    if (!box) return;
    try { await ensureLoaded(addDays(el._from || todayKey(), el._days)); } catch (err) { console.warn(err); }
    box.innerHTML = comingUpHTML(el.dataset.pid, el._from, el._days);
  }
  /** The card's days from a date, or from today again. The card's link says which. */
  function setCardDate(el, k) {
    el._from = k && k > todayKey() ? k : null;
    el._days = CU_DAYS;
    el._segs = segsFor({ parish: S.byId.get(el.dataset.pid), from: el._from });
    const link = el.querySelector('.sheet-link');
    if (link) { link.innerHTML = linkChip(el._segs); fitLinks(link); }
    syncURL();
    refreshComingUp(el);
  }

  function timesHTML(p) {
    const hasTimes = rulesOf(p.id).some(liveRule);
    return `${hasTimes ? timetable(p.id, { edit: may('schedule.edit', p.id) }) : `<div class="tt-none">No service times on file yet.${p.website ? ` The parish website is the best place to check.` : ''}</div>`}
      ${timesSource(p.id)}
      ${addBox(SUGGEST.service, 'Add a service time')}`;
  }
  function detailsHTML(p) {
    return `<div class="details">
        ${p.phone ? `<div class="drow"><small>Phone</small><a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">${esc(p.phone)}</a></div>` : ''}
        ${p.website ? `<div class="drow"><small>Website</small><a href="${esc(p.website)}" target="_blank" rel="noopener">${esc(p.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a></div>` : ''}
        ${p.email ? `<div class="drow"><small>Email</small><a href="mailto:${esc(p.email)}">${esc(p.email)}</a></div>` : ''}
        ${p.address ? `<div class="drow"><small>Address</small><span>${esc(p.address)}</span></div>` : ''}
        ${p.feast_day ? `<div class="drow"><small>Feast day</small><span>${esc(p.feast_day)}</span></div>` : ''}
      </div>
      ${detailsSource(p)}`;
  }
  /** An open card again, from the bundle as it now is, where it was scrolled to. */
  function repaintParish(el) {
    const p = S.byId.get(el.dataset.pid);
    if (!p) return;
    const times = el.querySelector('.p-times'), details = el.querySelector('.p-details');
    if (times) times.innerHTML = timesHTML(p);
    if (details) details.innerHTML = detailsHTML(p);
    const sug = el.querySelector('.p-suggest');
    if (sug) sug.innerHTML = suggestEditHTML(p.id);
    refreshComingUp(el);
  }

  function openParish(pid, { entry = true, from = null } = {}) {
    const p = S.byId.get(pid);
    if (!p) return;
    const segs = segsFor({ parish: p, from });
    const d = distOf(p);
    const nextLit = nextOf(pid, e => e.event_type === 'liturgy') || nextOf(pid);
    const langs = parishLangs(p);
    const summary = [
      `<div class="sum"><small>${nextLit ? `Next ${esc(kindLabel(nextLit.event_type))}` : 'Next'}</small><b class="${nextLit ? 'ok' : ''}">${nextLit ? summaryWhen(nextLit) : '—'}</b></div>`,
      `<div class="sum"><small>Languages</small><b>${esc(langs.slice(0, 2).join(' · ') || '—')}</b></div>`,
      // The jurisdiction says itself in its colour, as its tab does.
      `<div class="sum"><small>Jurisdiction</small><b style="color:${parishColor(p)}">${esc(JURIS[p.jurisdiction]?.short || p.jurisdiction)}</b></div>`,
    ].join('');
    const dirs = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
    const html = `${glassBar(p.name, JURIS[p.jurisdiction]?.long)}
      <div class="sheet-scroll">
        <div class="ph">
          ${avatar(p, 'xl')}
          <div class="ph-text"><h1>${esc(p.full_name || p.name)}</h1><p>${esc(p.address || '')}${d != null ? ` <span class="ph-dist">${esc(fmtKm(d))}</span>` : ''}</p></div>
        </div>
        <div class="sheet-link">${linkChip(segs)}</div>
        <div class="actions">
          <a class="abtn primary" href="${esc(dirs)}" target="_blank" rel="noopener">${I.car}<span>Directions</span></a>
          ${p.phone ? `<a class="abtn" href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">${I.phone}<span>Call</span></a>` : ''}
          ${p.website ? `<a class="abtn" href="${esc(p.website)}" target="_blank" rel="noopener">${I.globe}<span>Website</span></a>` : ''}
        </div>
        <div class="summary">${summary}</div>
        <h2 class="sec">Service times</h2>
        <div class="p-times">${timesHTML(p)}</div>
        <h2 class="sec">Details</h2>
        <div class="p-details">${detailsHTML(p)}</div>
        <!-- What is coming up changes; the timetable above is the parish's for good. -->
        <section class="cu-band">
          <h2 class="sec">Coming up</h2>
          <div class="cu" style="--pc:${parishColor(p)}">${comingUpHTML(pid, from, CU_DAYS)}</div>
          ${addBox(SUGGEST.event, 'Add an event')}
        </section>
        <div class="p-suggest">${suggestEditHTML(pid)}</div>
        <div class="toolbar-space"></div>
      </div>
      <div class="floatbar" role="toolbar">
        <button type="button" data-act="addlist" aria-label="Add to a list">${I.plus}</button>
        <button type="button" data-act="fav" class="${isFav(pid) ? 'on' : ''}" aria-label="Favourite" aria-pressed="${isFav(pid)}">${isFav(pid) ? I.starOn : I.star}</button>
        <button type="button" data-act="more" aria-label="More">${I.more}</button>
      </div>`;
    const el = pushSheet(html, 'parish', { segs, entry });
    el.dataset.pid = pid;
    el._from = from;
    el._days = CU_DAYS;
    // A date further out than the bundle holds fills in once it has it.
    if (from) refreshComingUp(el);
    el.style.setProperty('--j', jColor(p.jurisdiction));
    setMapFocus(pid);
    // Bring it into the viewport without zooming the page's scope away.
    if (map && isFinite(p.lat) && !map.getBounds().contains([p.lng, p.lat])) map.easeTo({ center: [p.lng, p.lat], duration: 500 });
  }

  // ── A collection's card: a bunch of parishes, with their timetables ───

  function openCollection(c, { entry = true } = {}) {
    const o = sortOrigin();
    const ps = c.ids.map(id => S.byId.get(id)).filter(Boolean)
      .sort((a, b) => (rulesOf(b.id).some(liveRule)) - (rulesOf(a.id).some(liveRule)) || (o ? km(o, a) - km(o, b) : a.name.localeCompare(b.name)));
    const LIMIT = 30;
    const item = (p) => {
      const d = distOf(p);
      const nx = nextOf(p.id, e => !c.kind || groupOf(e.event_type) === groupOf(c.kind)) || nextOf(p.id);
      const times = rulesOf(p.id).some(liveRule);
      return `<article class="citem">
          <button class="citem-head" type="button" data-parish="${esc(p.id)}">
            ${avatar(p, 'md')}
            <span class="citem-t"><b>${esc(p.name)}</b><small>${esc(JURIS[p.jurisdiction]?.short || '')}${d != null ? ` · ${esc(fmtKm(d))}` : ''}${parishLangs(p).length ? ` · ${esc(parishLangs(p).slice(0, 2).join(', '))}` : ''}</small>
              ${nx ? `<span class="citem-next">${roundel(nx.event_type)} Next: ${esc(nx.title)} · ${esc(whenShort(nx))}</span>` : ''}</span>
          </button>
          <button class="cadd" type="button" data-quickadd="${esc(p.id)}" aria-label="Add to a list">${I.plus}</button>
          ${times ? timetable(p.id, { compact: true }) : `<div class="tt-none sm">No service times on file yet.</div>`}
        </article>`;
    };
    const html = `${glassBar(c.title, `${ps.length} places`)}
      <div class="sheet-scroll">
        <div class="chero" style="background:${c.art}">
          <span class="ckicker">${esc(c.kicker || '')}</span>
          <h1>${esc(c.title)}</h1>
          <div class="chero-acts">
            <button class="hbtn" type="button" data-act="showmap">${I.map}<span>Show on map</span></button>
            ${c.listId ? '' : `<button class="hbtn" type="button" data-act="savelist">${I.plus}<span>Save as list</span></button>`}
            <button class="hbtn" type="button" data-act="share">${I.share}<span>Share</span></button>
          </div>
          <p>${esc(c.blurb || '')}</p>
        </div>
        ${c.segs ? `<div class="sheet-link">${linkChip(c.segs)}</div>` : ''}
        <div class="clist">${ps.slice(0, LIMIT).map(item).join('') || '<div class="tt-none">Nothing here yet. Add parishes from their cards with +.</div>'}</div>
        ${ps.length > LIMIT ? `<button class="wide-btn" type="button" data-act="more-items">Show ${ps.length - LIMIT} more</button>` : ''}
      </div>`;
    const el = pushSheet(html, 'collection', { segs: c.segs || null, entry });
    el._coll = c;
    el._rest = () => ps.slice(LIMIT).map(item).join('');
  }

  // ── An event ──────────────────────────────────────────────────────────

  function findEvent(id) {
    const s = String(id);
    return feedFor(S.streamDays).find(e => String(e.id) === s)
      || (window.agoraBundle.raw?.events || []).find(e => String(e.id) === s)
      || window.agoraBundle.resolveEvent(s);
  }
  function openEvent(id, { entry = true } = {}) {
    const e = findEvent(id);
    if (!e) return;
    const segs = segsFor({ eventId: e.id });
    const p = S.byId.get(e.parish_id);
    const l = local(e);
    const end = e.end_local ? e.end_local.slice(11, 16) : (e.end_utc ? partsIn(e.timezone || TZ, Date.parse(e.end_utc)).hm : null);
    const where = e.location_override || p?.address || '';
    const lat = e.lat ?? p?.lat, lng = e.lng ?? p?.lng;
    // A service's date is about its rule, which the dialog lists by name.
    const rule = e.schedule_id != null ? S.rules.find(r => String(r.id) === String(e.schedule_id)) : null;
    const html = `${glassBar(e.title, p ? p.name : '')}
      <div class="sheet-scroll">
        ${e.poster_path ? `<div class="ev-poster"><img src="${esc(e.poster_path)}" alt=""></div>` : `<div class="ev-band" style="--j:${jColor(p?.jurisdiction)}">${roundel(e.event_type, true)}</div>`}
        <div class="ev-head">
          <span class="ckicker">${esc(kindLabel(e.event_type))}${e.feast ? ` · ${esc(e.feast)}` : ''}</span>
          <h1>${esc(e.title)}</h1>
          <p class="ev-when">${esc(dayLabel(l.date, true))} · ${esc(hm12(l.hm))}${end ? `–${esc(hm12(end))}` : ''}</p>
        </div>
        <div class="sheet-link">${linkChip(segs)}</div>
        <div class="actions">
          <a class="abtn primary" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}" target="_blank" rel="noopener">${I.car}<span>Directions</span></a>
          <button class="abtn" type="button" data-parish="${esc(e.parish_id)}">${avatar(p, 'xs')}<span>Parish</span></button>
          <button class="abtn" type="button" data-act="share">${I.share}<span>Share</span></button>
        </div>
        ${where ? `<div class="details"><div class="drow"><small>Where</small><span>${esc(where)}</span></div></div>` : ''}
        ${e.description ? `<div class="ev-desc">${esc(e.description).replace(/\n/g, '<br>')}</div>` : ''}
        ${p && !may('event.edit', p.id) ? `<button class="wide-btn" type="button" data-suggest="${esc(rule ? serviceLine(rule) : SUGGEST.event)}" data-pid="${esc(p.id)}">Suggest an edit</button>` : ''}
        <div class="toolbar-space sm"></div>
      </div>`;
    const el = pushSheet(html, 'event', { segs, entry });
    el._event = e;
  }

  // ── Filters: the app's pills, behind a button beside the chips ─────────
  //
  // The app's toolbar pills (app.css .mode-bar-pill), laid out in rows that
  // open under the button rather than on a screen of their own: the map and
  // the chips stay in sight, and every tap applies. Tapping a pill that is on
  // turns it off, so no row needs an "Any". Kinds wear the app's roundels
  // once one is chosen, and a language its "only".

  const KIND_NAMES = { services: 'Services', talks: 'Talks', socials: 'Socials' };
  const KIND_SUBS = { services: ['liturgy', 'prayer', 'feast'], talks: ['bible-study'], socials: ['social', 'youth'] };
  /** A sub-kind's name. Bible studies are Talks' one, and a title, not a type. */
  const kindSubLabel = (id) => (id === 'bible-study' ? 'Bible Studies' : kindLabel(id));
  // The services a link can name that are not a kind's own (those are roundels).
  const PANEL_SERVICES = ['vespers', 'matins', 'paraklesis', 'compline', 'confession'];
  const REGIONS = ['nsw', 'vic', 'qld', 'wa', 'sa', 'tas', 'act', 'nt', 'nz'];
  const regionShort = (slug) => (REGIONS.includes(slug) ? slug.toUpperCase() : window.AgoraLocations.resolveLocation(slug)?.label || slug);

  const fpill = (set, val, on, label, cls = '') =>
    `<button class="fpill${cls}${on ? ' on' : ''}" type="button" data-set="${set}" data-val="${esc(val)}" aria-pressed="${on}">${label}</button>`;
  function kindSub(id, on) {
    const c = window.AgoraEventTypes.kindColors(id === 'bible-study' ? 'talk' : id, dark());
    const l = kindSubLabel(id);
    return `<button class="kind-sub${on ? ' on' : ''}" type="button" data-set="kindSub" data-val="${id}" style="--k-bg:${c.bg};--k-fg:${c.fg}" aria-pressed="${on}" aria-label="${esc(l)}" title="${esc(l)}">${esc(on ? l : l[0])}</button>`;
  }
  function panelHTML() {
    const f = S.f, SV = window.AgoraServices;
    // A group of pills per question, as the app's toolbar has, with no label:
    // what, which language, when, where, which parishes. A break starts a line.
    const group = (label, ...lines) => `<div class="frow" role="group" aria-label="${label}">${lines.filter(Boolean).join('<span class="fbreak"></span>')}</div>`;
    const kinds = Object.entries(KIND_NAMES).map(([k, l]) => fpill('kind', k, f.kind === k, esc(l))
      + (f.kind === k ? `<span class="kind-subs">${KIND_SUBS[k].map(id => kindSub(id, f.kindSub === id)).join('')}</span>` : '')).join('');
    const services = PANEL_SERVICES.map(sv => fpill('service', sv, f.service === sv, esc(SV.serviceLabel(sv)))).join('');
    const langs = ['English', ...LANGS.map(([l]) => l)].map(l => fpill('lang', l, f.lang === l, esc(l))
      + (f.lang === l ? fpill('langStrict', '1', f.langStrict, 'only', ' fpill-only') : '')).join('');
    const days = `<span class="fdays">${WD.map((d, i) => fpill('day', i, f.day === i, d)).join('')}</span>`;
    const spans = SV.DAY_GROUPS.map(g => fpill('dayGroup', g.slug, f.dayGroup === g.slug, esc(g.label))).join('');
    const parts = SV.PARTS_OF_DAY.map(pt => fpill('part', pt.slug, f.part === pt.slug, esc(pt.label))).join('');
    const regions = [...REGIONS, ...(f.location && !REGIONS.includes(f.location) ? [f.location] : [])]
      .map(r => fpill('location', r, f.location === r, esc(regionShort(r)))).join('');
    const lists = allLists().filter(l => l.ids.length);
    const parishes = fpill('monasteries', '1', f.monasteries, 'Monasteries')
      + fpill('timesOnly', '1', f.timesOnly, 'With service times')
      + lists.map(l => fpill('list', l.id, f.listId === l.id, `${l.fav ? '<span class="fstar" aria-hidden="true">★</span>' : ''}${esc(l.name)}`)).join('');
    return group('What', kinds, services) + group('Language', langs) + group('When', days, spans, parts)
      + group('Where', regions) + group('Parishes', parishes)
      + `<div class="fpanel-foot">${filterCount() ? '<button class="fpill fpill-ghost" type="button" data-act="clear-filters">Clear all</button>' : '<span></span>'}
          <button class="fpill on" type="button" data-act="filters-done">Done</button></div>`;
  }
  // Open, the panel is one step: the first change in it is a step back, the
  // rest are written onto it, so back undoes a whole go at the filters.
  const panelOpen = () => !!S.panel;
  function setPanel(open) {
    const el = $('#filter-panel');
    S.panel = open ? { pushed: false } : null;
    el.hidden = !open;
    $('#btn-filters').setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('filters-open', open);
    if (open) renderPanel();
    else el.innerHTML = '';
  }
  function renderPanel() {
    if (panelOpen()) $('#filter-panel').innerHTML = panelHTML();
  }
  /** One pill tapped: on if it was off, off if it was on. */
  function setFilter(k, v) {
    const f = S.f;
    const flip = (key, val) => { f[key] = f[key] === val ? null : val; };
    if (k === 'kind') { flip('kind', v); f.kindSub = null; }
    else if (k === 'kindSub') flip('kindSub', v);
    else if (k === 'lang') { flip('lang', v); f.langStrict = false; }
    else if (k === 'langStrict') f.langStrict = !f.langStrict;
    // A day and a span of the week are one question, asked one way at a time.
    else if (k === 'day') { f.day = f.day === +v ? null : +v; f.dayGroup = null; }
    else if (k === 'dayGroup') { flip('dayGroup', v); f.day = null; }
    else if (k === 'part' || k === 'service' || k === 'location') flip(k, v);
    else if (k === 'timesOnly' || k === 'monasteries') f[k] = !f[k];
    else if (k === 'list') {
      const l = f.listId === v ? null : listById(v);
      f.parishIds = l && l.ids.length ? new Set(l.ids) : null;
      f.listId = f.parishIds ? l.id : null;
    }
    refilter();
    // A region or a list chosen is shown, as a link to one is.
    if (k === 'location' && f.location) frameRegion(f.location, true);
    if (k === 'list' && f.parishIds) fitTo([...f.parishIds]);
  }

  // ── Add to a list ─────────────────────────────────────────────────────

  function openAddToList(pid) {
    const p = S.byId.get(pid);
    const html = `<div class="lay-head"><h2>Add to a list</h2><button class="gbtn" type="button" data-act="close" aria-label="Close">${I.x}</button></div>
      <div class="sheet-scroll">
        <p class="lay-note">${esc(p ? p.name : '')}. A list is a collection you can open, and a filter you can switch on.</p>
        <div class="lists">${allLists().map(l => `<button class="lrow${inList(l.id, pid) ? ' on' : ''}" type="button" data-inlist="${esc(l.id)}">
            <span class="lic">${l.fav ? '★' : '☰'}</span><span class="ln"><b>${esc(l.name)}</b><small>${l.ids.length} places</small></span><span class="lck">${I.check}</span></button>`).join('')}
          <button class="lrow new" type="button" data-act="newlist"><span class="lic">${I.plus}</span><span class="ln"><b>New list…</b></span></button>
        </div>
      </div>`;
    const el = pushSheet(html, 'mini');
    el.dataset.pid = pid;
  }
  function openMore(pid) {
    const p = S.byId.get(pid);
    const html = `<div class="lay-head"><h2>${esc(p.name)}</h2><button class="gbtn" type="button" data-act="close" aria-label="Close">${I.x}</button></div>
      <div class="sheet-scroll"><div class="lists">
        <button class="lrow" type="button" data-act="share-parish">${I.share}<span class="ln"><b>Share</b></span></button>
        <a class="lrow" href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}" target="_blank" rel="noopener">${I.car}<span class="ln"><b>Directions</b></span></a>
        ${p.website ? `<a class="lrow" href="${esc(p.website)}" target="_blank" rel="noopener">${I.globe}<span class="ln"><b>Website</b></span></a>` : ''}
        <button class="lrow" type="button" data-act="juris-of">${jurisLogo(p.jurisdiction)
          ? `<span class="lrow-ic"><img src="${esc(jurisLogo(p.jurisdiction))}" alt=""></span>`
          : `<span class="lrow-ic">${I.cross.replace('<svg', '<svg width="14" height="22"')}</span>`}<span class="ln"><b>More ${esc(JURIS[p.jurisdiction]?.long || '')} parishes</b></span></button>
        ${suggestsHere(pid) ? `<button class="lrow" type="button" data-suggest="">${I.pencil}<span class="ln"><b>Suggest an edit</b></span></button>` : ''}
        <a class="lrow" href="/${esc((p.acronym || '').toLowerCase())}" target="_blank" rel="noopener">${I.chev}<span class="ln"><b>Open in the current app</b></span></a>
      </div></div>`;
    const el = pushSheet(html, 'mini');
    el.dataset.pid = pid;
  }

  // ── Search ────────────────────────────────────────────────────────────
  //
  // One field, answered as you type, in four kinds of result: parishes, places
  // (a suburb, a postcode, a city — the map goes there), services and events,
  // and collections. A few words are read as intent rather than text, so
  // "english liturgy sunday" or "vespers tonight" ask the timetable a question
  // instead of looking for those words in titles.

  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[’'`.]/g, '').replace(/\bsaints?\b|\bsts?\b/g, 'st')
    .replace(/[^a-z0-9Ͱ-ϿЀ-ӿ؀-ۿ]+/g, ' ').trim();
  const hasWord = (hay, tok) => (' ' + hay).includes(' ' + tok);

  const DAY_WORDS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
  const KIND_WORDS = {
    liturgy: 'liturgy', liturgies: 'liturgy', mass: 'liturgy', eucharist: 'liturgy',
    talk: 'talk', talks: 'talk', bible: 'talk', study: 'talk', catechism: 'talk', class: 'talk', classes: 'talk', lecture: 'talk',
    youth: 'youth', young: 'youth', kids: 'youth', children: 'youth',
    social: 'social', socials: 'social', festival: 'social', fete: 'social', dinner: 'social', picnic: 'social', fundraiser: 'social',
    feast: 'feast', feasts: 'feast',
  };
  // Prayer services are asked for by name; these stay as text, and also mean "a service".
  const PRAYER_WORDS = ['vespers', 'vigil', 'matins', 'orthros', 'paraklesis', 'akathist', 'akatist', 'compline', 'confession', 'supplication', 'prayer', 'prayers'];
  const LANG_WORDS = { english: 'English', greek: 'Greek', arabic: 'Arabic', serbian: 'Serbian', russian: 'Slavonic', slavonic: 'Slavonic', romanian: 'Romanian', macedonian: 'Macedonian' };
  const FILLER = new Set(['the', 'a', 'an', 'in', 'at', 'on', 'of', 'for', 'this', 'next', 'service', 'services', 'church', 'parish', 'parishes', 'orthodox', 'and', 'with', 'times', 'time', 'whats', 'what', 'is', 'near', 'me', 'nearby', 'around', 'week']);

  function parseQuery(q) {
    const toks = norm(q).split(' ').filter(Boolean);
    const out = { text: [], days: null, tonight: false, kind: null, prayer: false, lang: null, nearMe: /\bnear me\b|\bnearby\b|\baround me\b/.test(norm(q)), raw: toks };
    const t = todayKey();
    const addDay = (k) => { out.days = out.days || new Set(); out.days.add(k); };
    for (let i = 0; i < toks.length; i++) {
      const w = toks[i];
      if (w === 'today') { addDay(t); continue; }
      if (w === 'tonight') { addDay(t); out.tonight = true; continue; }
      if (w === 'tomorrow') { addDay(addDays(t, 1)); continue; }
      if (w === 'weekend') { for (let d = 0; d < 7; d++) { const k = addDays(t, d); const wd = new Date(k + 'T00:00:00Z').getUTCDay(); if (wd === 0 || wd === 6) addDay(k); } continue; }
      if (w in DAY_WORDS) { for (let d = 0; d < 14; d++) { const k = addDays(t, d); if (new Date(k + 'T00:00:00Z').getUTCDay() === DAY_WORDS[w]) addDay(k); } continue; }
      if (w in KIND_WORDS) { out.kind = KIND_WORDS[w]; if (w !== 'bible' && w !== 'study') continue; }
      if (w in LANG_WORDS) { out.lang = LANG_WORDS[w]; }
      if (PRAYER_WORDS.includes(w)) out.prayer = true;
      if (FILLER.has(w)) continue;
      out.text.push(w);
    }
    // A language word is both: "greek" is a language for services and a
    // jurisdiction (and a word in names) for parishes. Keep it as text too.
    return out;
  }

  let parishHay = null;
  function hayOf(p) {
    if (!parishHay) {
      parishHay = new Map(S.parishes.map(x => [x.id, {
        name: norm(`${x.name} ${x.full_name || ''}`),
        acr: norm(x.acronym || ''),
        addr: norm(x.address || ''),
        rest: norm(`${JURIS[x.jurisdiction]?.long || ''} ${(parseLangs(x.languages) || []).join(' ')}`),
      }]));
    }
    return parishHay.get(p.id);
  }

  function searchParishes(Q) {
    const o = sortOrigin();
    // Language words are read as intent (hasLang), never matched as text: every
    // parish lists English, so the text match would hand back all of them.
    const toks = Q.text.filter(w => !(w in LANG_WORDS));
    const res = [];
    for (const p of S.parishes) {
      const h = hayOf(p);
      let score = 0;
      if (toks.length) {
        const all = `${h.name} ${h.acr} ${h.addr} ${h.rest}`;
        if (!toks.every(w => hasWord(all, w))) continue;
        if (Q.lang && !hasLang(p, Q.lang)) continue;
        const q = toks.join(' ');
        if (h.acr === q) score += 100;
        if (h.name.startsWith(q)) score += 50;
        score += toks.filter(w => hasWord(h.name, w)).length * 12;
        score += toks.filter(w => hasWord(h.addr, w)).length * 6;
      } else if (Q.kind || Q.prayer || Q.lang || Q.days) {
        // A pure question ("english liturgy sunday"): parishes whose timetable answers it.
        const ok = rulesOf(p.id).some(r => liveRule(r)
          && (!Q.kind || r.event_type === Q.kind)
          && (!Q.prayer || r.event_type === 'prayer')
          && (!Q.days || [...Q.days].some(k => new Date(k + 'T00:00:00Z').getUTCDay() === r.day_of_week))
          && (!Q.lang || (r.languages ? (parseLangs(r.languages) || []).includes(Q.lang) : hasLang(p, Q.lang))));
        if (!ok && !(Q.lang && !Q.kind && !Q.prayer && !Q.days && hasLang(p, Q.lang))) continue;
        score = 10;
      } else if (Q.nearMe) {
        score = 1;
      } else continue;
      if (rulesOf(p.id).some(liveRule)) score += 3;
      res.push({ p, score, d: o ? km(o, p) : 0 });
    }
    return res.sort((a, b) => b.score - a.score || a.d - b.d).map(x => x.p);
  }

  function searchPlaces(Q) {
    const q = Q.text.join(' ');
    if (!q) return [];
    const out = [];
    for (const [n, la, lo] of CITIES) {
      if (norm(n).startsWith(q)) out.push({ label: n, sub: 'City', lat: la, lng: lo, zoom: 10.5 });
    }
    // A suburb or a postcode: the parishes whose ADDRESS holds it (not their name).
    const ids = S.parishes.filter(p => Q.text.every(w => hasWord(hayOf(p).addr, w))).map(p => p.id);
    if (ids.length && !out.some(c => norm(c.label) === q)) {
      const label = /^\d{4}$/.test(q) ? `Postcode ${q}` : q.replace(/\b\w/g, c => c.toUpperCase());
      out.push({ label, sub: `${ids.length} ${ids.length === 1 ? 'parish' : 'parishes'}`, ids });
    }
    return out.slice(0, 4);
  }

  function searchEvents(Q) {
    const intent = Q.kind || Q.prayer || Q.lang || Q.days;
    if (!Q.text.length && !intent) return [];
    const now = Date.now();
    const pids = Q.text.length ? new Set(searchParishes({ ...Q, kind: null, prayer: false, days: null })
      .filter(p => { const h = hayOf(p); return Q.text.every(w => hasWord(`${h.name} ${h.acr} ${h.addr}`, w)); }).map(p => p.id)) : null;
    const res = feedFor(Math.max(S.streamDays, 42)).filter(e => {
      if (!visible(e) || e.parish_scoped || endMs(e) < now) return false;
      const l = local(e);
      if (Q.days && !Q.days.has(l.date)) return false;
      if (Q.tonight && l.hm < '16:00') return false;
      if (Q.kind && e.event_type !== Q.kind && !(Q.kind === 'social' && e.event_type === 'youth')) return false;
      if (Q.lang) {
        const ls = parseLangs(e.languages) || parseLangs(e.parish_languages) || [];
        if (!ls.includes(Q.lang) || (Q.lang === 'English' && !parseLangs(e.languages) && ls[0] !== 'English')) return false;
      }
      const words = Q.text.filter(w => !(w in LANG_WORDS));
      if (!words.length) return !Q.prayer || e.event_type === 'prayer';
      const hay = norm(`${e.title} ${e.feast || ''} ${e.description || ''}`);
      if (words.every(w => hasWord(hay, w))) return true;
      // Or the words name the parish (or its suburb): its services.
      return pids && eventParishIds(e).some(id => pids.has(id)) && (!Q.prayer || e.event_type === 'prayer');
    });
    // By day; within a day, what is near you first (when we know where you
    // are), then by time. A Liturgy in Perth at 8 should not sit between two
    // in Sydney at 8 and 9.
    const o = S.loc;
    const far = (e) => { if (!o) return 0; const at = e.lat != null ? e : S.byId.get(e.parish_id); return at && km(o, at) > 40 ? 1 : 0; };
    return res.map(e => ({ e, day: local(e).date, far: far(e), t: Date.parse(e.start_utc) }))
      .sort((a, b) => a.day.localeCompare(b.day) || a.far - b.far || a.t - b.t).map(x => x.e);
  }

  function searchCollections(Q) {
    const q = Q.raw.filter(w => !FILLER.has(w));
    if (!q.length) return [];
    return [...COLL.values()].filter(c => c.id !== 'inview' && q.every(w => hasWord(norm(`${c.title} ${c.kicker || ''} ${c.lang || ''}`), w)
      || (w === 'english' && c.id === 'english') || (w in DAY_WORDS && c.id === (DAY_WORDS[w] === 0 ? 'sunday' : DAY_WORDS[w] === 6 ? 'vespers' : '')))).slice(0, 4);
  }

  const RECENT = 'agora-next-recent';
  function rememberQuery(q) {
    q = q.trim();
    if (!q) return;
    writeLS(RECENT, [q, ...readLS(RECENT).filter(x => x.toLowerCase() !== q.toLowerCase())].slice(0, 6));
  }

  function parishResult(p) {
    const d = distOf(p);
    const nx = nextOf(p.id);
    return `<button class="sr-row" type="button" data-parish="${esc(p.id)}">
        ${avatar(p, 'sm')}
        <span class="sr-t"><b>${esc(p.name)}</b><small>${esc(JURIS[p.jurisdiction]?.short || '')}${d != null ? ` · ${esc(fmtKm(d))}` : ''}${nx ? ` · Next: ${esc(nx.title)} ${esc(whenShort(nx))}` : ' · No times on file'}</small></span>
      </button>`;
  }
  function placeResult(pl, i) {
    return `<button class="sr-row" type="button" data-place="${i}">
        <span class="sr-ic">${I.pin}</span>
        <span class="sr-t"><b>${esc(pl.label)}</b><small>${esc(pl.sub)} · Show on the map</small></span>
      </button>`;
  }

  let lastPlaces = [];
  function searchResultsHTML(q) {
    if (!q.trim()) {
      const recent = readLS(RECENT);
      const sugg = ['Liturgy this Sunday', 'Vespers tonight', 'English liturgy', 'Talks', 'Youth', 'Near me'];
      return `<h3 class="sr-sec">Try</h3><div class="sr-chips">${sugg.map(s => `<button class="sr-chip" type="button" data-q="${esc(s)}">${esc(s)}</button>`).join('')}</div>
        ${recent.length ? `<h3 class="sr-sec">Recent</h3><div class="sr-group">${recent.map(s => `<button class="sr-row" type="button" data-q="${esc(s)}"><span class="sr-ic">${I.clock}</span><span class="sr-t"><b>${esc(s)}</b></span></button>`).join('')}</div>` : ''}
        <h3 class="sr-sec">Collections</h3><div class="sr-group">${[...COLL.values()].filter(c => !c.listId && c.id !== 'inview').slice(0, 7).map(collResult).join('')}</div>`;
    }
    const Q = parseQuery(q);
    const ps = searchParishes(Q);
    lastPlaces = searchPlaces(Q);
    const es = searchEvents(Q);
    const cs = searchCollections(Q);
    const intent = Q.kind || Q.prayer || Q.days || (Q.lang && !Q.text.some(w => !(w in LANG_WORDS)));
    const sections = [];
    const evSec = es.length ? `<h3 class="sr-sec">${intent ? 'Services & events' : 'Services & events'}<span>${es.length > 60 ? '60+' : es.length}</span></h3>
      <div class="sr-group">${es.slice(0, intent ? 8 : 5).map(e => eventRow(e, { showDay: true })).join('')}</div>
      ${es.length > (intent ? 8 : 5) ? `<button class="sr-more" type="button" data-more-events>Show ${Math.min(es.length, 60) - (intent ? 8 : 5)} more</button>` : ''}` : '';
    const parSec = ps.length ? `<h3 class="sr-sec">Parishes<span>${ps.length}</span></h3><div class="sr-group">${ps.slice(0, 6).map(parishResult).join('')}</div>
      ${ps.length > 6 ? `<button class="sr-more" type="button" data-act="search-coll">See all ${ps.length} as a collection</button>` : ''}` : '';
    const placeSec = lastPlaces.length ? `<h3 class="sr-sec">Places</h3><div class="sr-group">${lastPlaces.map(placeResult).join('')}</div>` : '';
    const collSec = cs.length ? `<h3 class="sr-sec">Collections</h3><div class="sr-group">${cs.map(collResult).join('')}</div>` : '';
    // A question about the timetable answers with services first; a name, with parishes.
    if (intent) sections.push(evSec, parSec, collSec, placeSec);
    else sections.push(placeSec, parSec, collSec, evSec);
    const body = sections.join('');
    searchState = { q, Q, es, ps };
    return body || `<div class="sr-empty"><b>Nothing for “${esc(q)}”</b><p>Try a suburb, a parish’s name or initials, or a service like “vespers tonight”.</p></div>`;
  }
  function collResult(c) {
    const art = c.glyph ? `<span class="sr-art" style="background:${c.art}">${esc(c.glyph)}</span>` : `<span class="sr-art" style="background:${c.art}">${c.kind ? esc(kindLabel(c.kind)[0]) : '☦'}</span>`;
    return `<button class="sr-row" type="button" data-coll="${esc(c.id)}">${art}<span class="sr-t"><b>${esc(c.title)}</b><small>${esc(c.kicker || '')} · ${c.ids.length} places</small></span></button>`;
  }
  let searchState = null;

  function openSearch(initial = '') {
    const el = pushSheet(`<div class="sr-head">
        <label class="sr-field">${I.search}<input type="search" id="sr-input" placeholder="Parishes, suburbs, services…" autocomplete="off" enterkeyhint="search" value="${esc(initial)}"></label>
        <button class="sr-cancel" type="button" data-act="close">Cancel</button>
      </div>
      <div class="sheet-scroll"><div class="sr-results" id="sr-results">${searchResultsHTML(initial)}</div></div>`, 'search');
    const input = el.querySelector('#sr-input');
    let t = null;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { el.querySelector('#sr-results').innerHTML = searchResultsHTML(input.value); }, 70); });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      clearTimeout(t);
      el.querySelector('#sr-results').innerHTML = searchResultsHTML(input.value);
      const first = el.querySelector('#sr-results [data-parish], #sr-results [data-place], #sr-results [data-event], #sr-results [data-coll]');
      if (first) first.click();
      input.blur();
    });
    setTimeout(() => input.focus(), 60);
  }
  function setSearch(q) {
    const el = stack[stack.length - 1];
    const input = el && el.querySelector('#sr-input');
    if (!input) return;
    input.value = q;
    el.querySelector('#sr-results').innerHTML = searchResultsHTML(q);
  }

  // ── Toast ─────────────────────────────────────────────────────────────

  let toastT = null;
  function toast(msg) {
    let t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove('show'), 1600);
  }

  // ── Location ──────────────────────────────────────────────────────────

  function locate() {
    if (!('geolocation' in navigator)) return toast('Location isn’t available here');
    navigator.geolocation.getCurrentPosition((pos) => {
      S.loc = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      try { localStorage.setItem('agora_location', JSON.stringify(S.loc)); } catch { /* fine */ }
      document.body.classList.add('located');
      syncMap();
      renderInView();
      if (map) map.flyTo({ center: [S.loc.lng, S.loc.lat], zoom: 11.5, duration: 900 });
    }, () => toast('Couldn’t get your location'), { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }

  // ── Wiring ────────────────────────────────────────────────────────────

  document.addEventListener('click', (ev) => {
    const t = ev.target;
    const top = stack[stack.length - 1];
    let b;

    // Search: a tap on any result remembers what was typed.
    if (top && top.classList.contains('search') && t.closest('[data-parish],[data-event],[data-coll],[data-place]')) {
      rememberQuery(top.querySelector('#sr-input').value);
    }
    if ((b = t.closest('[data-copy]'))) { copyLink(b); return; }
    if (t.closest('#search-pill')) { openSearch(); return; }
    if ((b = t.closest('[data-q]'))) {
      setSearch(b.dataset.q);
      if (/near me/i.test(b.dataset.q) && !S.loc) locate();
      return;
    }
    if ((b = t.closest('[data-place]'))) {
      const pl = lastPlaces[+b.dataset.place];
      if (!pl) return;
      closeAll();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      if (pl.ids) fitTo(pl.ids); else if (map) map.flyTo({ center: [pl.lng, pl.lat], zoom: pl.zoom, duration: 800 });
      return;
    }
    if ((b = t.closest('[data-more-events]')) && searchState) {
      b.previousElementSibling.innerHTML = searchState.es.slice(0, 60).map(e => eventRow(e, { showDay: true })).join('');
      b.remove();
      return;
    }

    if ((b = t.closest('[data-juris]'))) {
      S.juris = S.juris === b.dataset.juris ? null : b.dataset.juris;
      renderJurisChips();
      refilter();
      return;
    }
    if ((b = t.closest('[data-clear]'))) {
      const k = b.dataset.clear;
      if (k === 'focus') S.focus = null;
      else if (k === 'kind') { S.f.kind = null; S.f.kindSub = null; }
      else if (k === 'lang') { S.f.lang = null; S.f.langStrict = false; }
      else if (k === 'parishIds') { S.f.parishIds = null; S.f.listId = null; }
      else S.f[k] = k === 'timesOnly' || k === 'monasteries' ? false : null;
      refilter();
      return;
    }
    if (t.closest('#btn-favourites')) { const c = COLL.get('list-fav'); if (c) openCollection(c); return; }
    if (t.closest('#inview, [data-inview]')) {
      const ids = viewParishes().map(p => p.id);
      openCollection({ id: 'inview', title: `In view`, kicker: $('#place-name').textContent, blurb: 'Every parish the map is showing, nearest and best-documented first.', art: 'linear-gradient(135deg,#334155,#0f172a)', ids });
      return;
    }
    if ((b = t.closest('[data-coll]'))) { const c = COLL.get(b.dataset.coll); if (c) openCollection(c); return; }
    if (t.closest('[data-newlist]')) {
      const name = prompt('Name your list', 'Parishes to visit');
      if (name) { const l = newList(name); toast(`Made “${l.name}”`); }
      return;
    }
    if ((b = t.closest('[data-quickadd]'))) { openAddToList(b.dataset.quickadd); return; }
    if ((b = t.closest('[data-edit-rules]'))) { window.NextEdit.editLine(b.dataset.editRules.split(',')); return; }
    if ((b = t.closest('[data-suggest]'))) {
      const under = stack.filter(x => x.dataset.pid).pop();
      const pid = b.dataset.pid || (under && under.dataset.pid);
      // Somebody who may add it adds it, in the app's editor; anybody else suggests it.
      if (b.classList.contains('add-box') && b.dataset.suggest === SUGGEST.event && may('event.edit', pid)) {
        window.NextEdit.addEvent(pid);
        return;
      }
      if (b.classList.contains('add-box') && b.dataset.suggest === SUGGEST.service && may('schedule.create', pid)) {
        window.NextEdit.addService(pid);
        return;
      }
      suggest(pid, b.dataset.suggest);
      return;
    }
    if ((b = t.closest('[data-parish]'))) { openParish(b.dataset.parish); return; }
    if ((b = t.closest('[data-event]'))) { openEvent(b.dataset.event); return; }
    if ((b = t.closest('[data-jump]'))) { $('#stream').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }

    // Days: a date to start from, a day's own link, more days.
    if ((b = t.closest('[data-pick-date]'))) {
      const input = b.parentNode.querySelector('.date-input');
      try { input.showPicker(); } catch { input.focus(); input.click(); }
      return;
    }
    if ((b = t.closest('[data-date-clear]'))) {
      if (b.dataset.dateClear === 'page') setPageDate(null); else if (top) setCardDate(top, null);
      return;
    }
    if ((b = t.closest('[data-copy-day]'))) { copyDay(b); return; }
    if ((b = t.closest('[data-more-days]')) && top) { top._days = Math.min(365, top._days + CU_DAYS); refreshComingUp(top); return; }

    // The filters apply as you tap; the map is above them.
    if (t.closest('#btn-filters')) { setPanel(!panelOpen()); return; }
    if ((b = t.closest('[data-set]'))) { setFilter(b.dataset.set, b.dataset.val); return; }

    if ((b = t.closest('[data-inlist]'))) {
      const pid = top.dataset.pid;
      toggleInList(b.dataset.inlist, pid);
      b.classList.toggle('on', inList(b.dataset.inlist, pid));
      return;
    }

    if ((b = t.closest('[data-act]'))) {
      const a = b.dataset.act;
      if (a === 'close') return popSheet();
      if (a === 'search-coll' && searchState) {
        rememberQuery(searchState.q);
        return openCollection({ id: 'search', title: `“${searchState.q}”`, kicker: 'Search', blurb: `Parishes matching “${searchState.q}”.`, art: 'linear-gradient(135deg,#475569,#1e293b)', ids: searchState.ps.map(p => p.id) });
      }
      if (a === 'clear-filters') { S.f = blankFilters(); S.focus = null; refilter(); return; }
      if (a === 'filters-done') { setPanel(false); return; }
      if (a === 'share') {
        if (top && top._segs) return share(top._coll ? top._coll.title : top._event ? top._event.title : S.byId.get(top.dataset.pid)?.name || '', pathOf(top._segs));
        if (top && top._coll) return share(top._coll.title, pathOf(pageSegs()));
        return;
      }
      if (a === 'share-parish') { const p = S.byId.get(top.dataset.pid); return share(p.name, pathOf(segsFor({ parish: p }))); }
      if (a === 'fav') {
        const pid = top.dataset.pid;
        toggleFav(pid);
        b.classList.toggle('on', isFav(pid));
        b.innerHTML = isFav(pid) ? I.starOn : I.star;
        return;
      }
      if (a === 'addlist') return openAddToList(top.dataset.pid);
      if (a === 'more') return openMore(top.dataset.pid);
      if (a === 'juris-of') { const p = S.byId.get(top.dataset.pid); const c = COLL.get('j-' + p.jurisdiction); if (c) openCollection(c); return; }
      if (a === 'newlist') {
        const name = prompt('Name your list', 'Parishes to visit');
        if (!name) return;
        const l = newList(name, top.dataset.pid);
        toast(`Added to “${l.name}”`);
        popSheet();
        return;
      }
      if (a === 'showmap') {
        const c = top._coll;
        // One with a link is its filters, and the page takes them; one without is its parishes.
        if (c.segs) { S.juris = c.juris || null; S.f = { ...c.f }; S.focus = null; }
        else S.focus = { title: c.title, ids: new Set(c.ids) };
        closeAll();
        refilter();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        fitTo(c.ids);
        return;
      }
      if (a === 'savelist') {
        const c = top._coll;
        const l = newList(c.title);
        const ls = userLists(); const mine = ls.find(x => x.id === l.id); mine.ids = c.ids.slice(); writeLS(LISTS, ls);
        renderLists();
        toast(`Saved “${c.title}” to your lists`);
        return;
      }
      if (a === 'more-items') { top.querySelector('.clist').insertAdjacentHTML('beforeend', top._rest()); b.remove(); return; }
    }
  });
  document.addEventListener('change', (e) => {
    const input = e.target.closest && e.target.closest('[data-date-input]');
    if (!input || !input.value) return;
    if (input.dataset.dateInput === 'page') setPageDate(input.value);
    else { const top = stack[stack.length - 1]; if (top) setCardDate(top, input.value); }
  });
  $('#scrim').addEventListener('click', () => popSheet());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (stack.length) popSheet();
    else if (document.body.classList.contains('map-full')) setFullscreen(false);
    else if (panelOpen()) setPanel(false);
  });
  $('#btn-fullscreen').addEventListener('click', () => setFullscreen(!document.body.classList.contains('map-full')));
  document.addEventListener('keydown', (e) => {
    // "/" opens search on a keyboard, as most sites do.
    if (e.key === '/' && !stack.length && !/input|textarea/i.test(document.activeElement?.tagName || '')) { e.preventDefault(); openSearch(); }
  });
  $('#btn-locate').addEventListener('click', locate);
  $('#btn-account').addEventListener('click', openAccount);
  $('#place').addEventListener('click', locate);

  new IntersectionObserver((ents) => { if (ents.some(e => e.isIntersecting)) growStream(); }, { rootMargin: '600px' }).observe($('#stream-more'));

  // ── The bundle, held and re-read ──────────────────────────────────────

  /** What the page reads from the bundle it has just been given. */
  function adopt() {
    S.parishes = window.agoraBundle.parishes();
    S.byId = new Map(S.parishes.map(p => [p.id, p]));
    S.rules = window.agoraBundle.schedules();
    S.rulesByParish = new Map();
    for (const r of S.rules) {
      if (!S.rulesByParish.has(r.parish_id)) S.rulesByParish.set(r.parish_id, []);
      S.rulesByParish.get(r.parish_id).push(r);
    }
  }
  /**
   * After a write: the bundle again, past the browser's copy, as the app does
   * (app.js fetchSchedules({ fresh })), then the page and every open card
   * drawn from it. `through` is a day the page must now hold, such as the
   * last date of an event just published.
   */
  async function reload({ through = null } = {}) {
    const end = [S.loadedTo, through, addDays(todayKey(), 60)].filter(Boolean).sort().pop();
    await window.agoraBundle.load({ from: new Date().toISOString(), to: new Date(Date.parse(end + 'T14:00:00Z')).toISOString(), fresh: true });
    S.loadedTo = end;
    S.loads++;
    adopt();
    renderInView();
    renderFeeds();
    syncMap();
    for (const el of stack) if (el.classList.contains('parish')) repaintParish(el);
  }

  // What editing.js works on: this page, through the same questions it asks itself.
  if (window.NextEdit) {
    window.NextEdit.init({
      parish: (id) => S.byId.get(id),
      parishes: () => S.parishes,
      rule: (id) => S.rules.find(r => String(r.id) === String(id)),
      today: todayKey,
      may,
      reload,
      openParish: (id) => openParish(id),
      toast,
      recheck: checkSignIn,
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────

  async function boot() {
    // Who is looking, alongside everything else; the cards ask it as they open.
    checkSignIn();
    const mapStarted = startMap().catch(err => console.warn('map', err));
    const t = todayKey();
    // The loader's tree grows with each real step, as it does at / (app.js).
    const step = (line, p) => { if (window.lsLog) window.lsLog(line); if (window.lsProgress) window.lsProgress(p); };
    step('GET /api/bundle …', 0.15);
    await window.agoraBundle.load({ from: new Date().toISOString(), to: new Date(Date.parse(addDays(t, 60) + 'T14:00:00Z')).toISOString() });
    adopt();
    step(`✓ ${S.parishes.length} parishes, ${S.rules.length} service times`, 0.6);
    if (S.loc) document.body.classList.add('located');
    // What the address asks for. The older /next#sgr is /next/sgr.
    const route = readPath(location.pathname);
    const h = decodeURIComponent(location.hash.slice(1));
    if (h && !route.parish) { const p = parishBySlug(h); if (p) route.parish = p.id; }
    S.juris = route.juris;
    S.f = route.f;
    S.from = route.parish ? null : route.from;
    renderJurisChips();
    renderInView();
    renderActive();
    renderCollections();
    renderFeeds();
    // The page's own address first, so a card opened from a link is one step
    // back from the page rather than from wherever the person came from.
    try { history.replaceState({ depth: 0 }, '', pathOf(pageSegs()) + location.search); } catch { /* sandboxed */ }
    renderLink();
    step('✓ page drawn', 0.7);
    await mapStarted;
    applyRoute(route, { animate: false });
    // A map that settled before the parishes came counted none in view: count again.
    onView();
    // The loader is the map's: it goes when the map has drawn, its tiles in
    // and its dots on. Not on 'idle', which a ringing halo never lets come.
    if (map) {
      step('Drawing the map…', 0.85);
      await S.mapLoaded;
      if (!map.areTilesLoaded()) {
        await new Promise(resolve => {
          const done = () => { if (map.areTilesLoaded()) { map.off('render', done); resolve(); } };
          map.on('render', done);
        });
      }
    }
    if (window.lsHide) window.lsHide();
  }
  boot().catch(err => {
    console.error(err);
    if (window.lsHide) window.lsHide();
    $('#today').innerHTML = `<div class="tempty">Couldn’t load the parishes. ${esc(err.message)}</div>`;
  });
  // map.js rebuilds its own style on a scheme change; the colours this page
  // stamps inline are lifted for the dark scheme, so they are stamped again.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    renderJurisChips();
    renderInView();
  });
})();
