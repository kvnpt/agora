// orthodoxy.au — v3.
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
// Lists live in this browser, and Favourites is the same store the old app's
// star wrote. Somebody who may edit does it here (next/editing.js).
//
// Links are the app's too: the filters are url-state.js's, read and written
// in the same grammar (/greek/en, /sun/liturgy, /sgr+snb, /sgr, /102). The
// Worker answers every one with this page, its head saying what the link is
// (worker/routes/pages.mjs). The link shows on the page as it builds.
//
// v3 replaced the app at / (app.js, app.css, filters.js). Where a comment here
// names one of them, it is where a piece came from; git history has them.

(function () {
  'use strict';

  // ── Small things ──────────────────────────────────────────────────────

  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const dark = () => matchMedia('(prefers-color-scheme: dark)').matches;
  // The wide layout (next.css): cards come in from the right, not up from the foot.
  const WIDE = matchMedia('(min-width: 1080px)');
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
  /** A kind in its roundel's colours, said in full: the pill over an event card's title. */
  function kindPill(kind) {
    const c = window.AgoraEventTypes.kindColors(kind || 'other', dark());
    return `<span class="kpill" style="--k-bg:${c.bg};--k-fg:${c.fg}">${esc(kindLabel(kind || 'other'))}</span>`;
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
    fetched: new Map(),      // stored events read on their own, outside the bundle (fetchEvent)
    bounds: null,
    juris: null,             // a jurisdiction, or several from the filters: url-state.js's shape
    f: null,                 // the filters, in the app's shape (blankFilters)
    focus: null,             // { title, ids:Set } — a collection no link can name, on the map
    loadedTo: null,          // the last day the bundle holds
    loads: 0,                // bumped as the bundle widens
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
    // `day` is one weekday or several, as services.js holds them (null, 3, [3, 5]).
    kind: null, kindSub: null, lang: null, langStrict: false, day: null, dayGroup: null, part: null, service: null,
    location: null, monasteries: false, parishIds: null, listId: null, timesOnly: false,
    // A parish link's own words (/smmp/disco): what is asked of its card, as the search box reads them.
    words: null,
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
  const fmtKm = (d) => d < 1 ? `${Math.round(d * 1000 / 50) * 50}m` : d < 10 ? `${d.toFixed(1)}km` : `${Math.round(d)}km`;
  /** How far, in the app's blues: the nearer, the deeper (app.css .distance-near/-mid/-far). */
  const distClass = (d) => (d <= 5 ? 'distance-near' : d <= 15 ? 'distance-mid' : 'distance-far');
  const distHTML = (d, tag = 'em') => `<${tag} class="dist ${distClass(d)}">${esc(fmtKm(d))}</${tag}>`;
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
    if (zoom < 6.5) return lng > 166 ? 'New Zealand' : 'Oceania';
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
  /**
   * A parish's services that say what language they are in: its timetable,
   * and the one-offs ahead it holds or hosts. Not one it only takes part in:
   * an English Vespers at Crows Nest with 27 Greek parishes along is not
   * English at those 27 (Kevin, 28 Oct 2026).
   */
  const langRows = (pid) => [...rulesOf(pid).filter(liveRule), ...upcomingOneOffs(pid, { own: true })];
  /**
   * A parish's languages: what its services are tagged with, in any order,
   * and never the parish's own column (a directory's "Greek, English" at
   * every Greek parish). No tagged services, no languages (timetable.js).
   */
  function parishLangs(p) { return window.AgoraTimetable.parishLangsOf(langRows(p.id)); }
  /** Does a parish hold a service in this language (only in it, when strict)? */
  function hasLang(p, lang, strict = false) {
    return !!p && window.AgoraTimetable.parishAnswersLang(langRows(p.id), { lang, strict });
  }

  // ── Lists: collections first, filters second ──────────────────────────
  //
  // Favourites is the current app's star (agora-favourites, [{id, at}]), so a
  // parish starred there is starred here. Every other list is new: a name and
  // its parishes, in this browser.

  const FAV = 'agora-favourites', LISTS = 'agora-lists';
  function readLS(k) { try { const v = JSON.parse(localStorage.getItem(k) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
  function writeLS(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* this page only */ } savedChanged(k); }
  const favIds = () => readLS(FAV).map(f => f.id).filter(id => S.byId.has(id));
  const isFav = (pid) => readLS(FAV).some(f => f.id === pid);
  function toggleFav(pid) {
    const l = readLS(FAV), was = isFav(pid);
    writeLS(FAV, was ? l.filter(f => f.id !== pid) : [{ id: pid, at: Date.now() }, ...l]);
    // Signed in, this star is one of the count; a visitor's is this browser's alone.
    if (syncAs && favCounts.has(pid)) { favCounts.set(pid, Math.max(0, favCounts.get(pid) + (was ? -1 : 1))); paintFavCount(pid); }
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
  /** A name no other list has: "Parishes to visit", then "Parishes to visit (2)". */
  function freeName(name, exceptId = null) {
    const base = name.trim().slice(0, 80) || 'My list';
    const taken = new Set(allLists().filter(l => l.id !== exceptId).map(l => l.name.toLowerCase()));
    let out = base;
    for (let i = 2; taken.has(out.toLowerCase()); i++) out = `${base} (${i})`;
    return out;
  }
  function newList(name, firstPid) {
    const ls = userLists();
    const l = { id: 'l' + Date.now().toString(36), name: freeName(name), ids: firstPid ? [firstPid] : [], at: Date.now() };
    writeLS(LISTS, [l, ...ls]);
    renderLists();
    return l;
  }
  function renameList(id, name) {
    const ls = userLists();
    const l = ls.find(x => x.id === id);
    if (!l) return null;
    l.name = freeName(name, id);
    writeLS(LISTS, ls);
    renderLists();
    if (S.f.listId === id) refilter({ url: 'replace' });
    return l;
  }
  /** A list, gone: only the list — its parishes, and anything starred, stay as they are. */
  function deleteList(id) {
    writeLS(LISTS, userLists().filter(x => x.id !== id));
    renderLists();
    followList();
  }

  // Bookmarks are the current app's too (agora-bookmarks, [{ id, kind, at }]):
  // a date — a stored event, or one of a rule's by its "<rule>:<date>" id —
  // or a whole service, by its rule. They stay in this browser: a date's
  // link expires, so a list of them is not a link.
  const BOOKMARKS = 'agora-bookmarks';
  const ruleIdOf = (e) => {
    if (e.schedule_id != null) return String(e.schedule_id);
    const m = String(e.id || '').match(/^(\d+):\d{4}-\d{2}-\d{2}$/);
    return m ? m[1] : null;
  };
  const isMarked = (kind, id) => id != null && readLS(BOOKMARKS).some(b => b.kind === kind && String(b.id) === String(id));
  /** Every bookmark, read once: the dates' ids and the services'. */
  function marks() {
    const ev = new Set(), ru = new Set();
    for (const b of readLS(BOOKMARKS)) (b.kind === 'rule' ? ru : ev).add(String(b.id));
    return { ev, ru };
  }
  /** Is this date bookmarked, itself or as one of its service's? */
  const isBookmarked = (e, m = marks()) => m.ev.has(String(e.id)) || m.ru.has(ruleIdOf(e));
  function toggleMark(kind, id) {
    const l = readLS(BOOKMARKS);
    const had = isMarked(kind, id);
    writeLS(BOOKMARKS, had ? l.filter(b => !(b.kind === kind && String(b.id) === String(id))) : [{ id: String(id), kind, at: Date.now() }, ...l]);
    return !had;
  }
  /** What is bookmarked and still to come: the dates, by day, and the services bookmarked whole. */
  function bookmarked() {
    const now = Date.now();
    const raw = window.agoraBundle.raw;
    const m = marks(), seen = new Set();
    const dates = feedFor(60).concat(raw?.events || [])
      .filter(e => endMs(e) > now && isBookmarked(e, m) && (visible(e) || tombOf(e)) && !seen.has(String(e.id)) && seen.add(String(e.id)))
      .sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
    const rules = S.rules.filter(r => m.ru.has(String(r.id)) && liveRule(r));
    return { dates, rules };
  }

  // Saved views are the current app's saved filters (agora-saved-filters,
  // [{ url, path, at }]): a link to the page as its filters make it, kept to
  // come back to. They sit in Your lists beside the lists of parishes.
  const SAVED = 'agora-saved-filters';
  const savedViews = () => readLS(SAVED).filter(x => x && typeof x.path === 'string' && x.path !== '/').sort((a, b) => b.at - a.at);
  const isSavedView = (path) => savedViews().some(x => x.path === path);
  function toggleSavedView(path) {
    const had = isSavedView(path);
    const rest = readLS(SAVED).filter(x => x && x.path !== path);
    writeLS(SAVED, had ? rest : [{ url: location.origin + path, path, at: Date.now() }, ...rest]);
    return !had;
  }

  // ── Kept on the account ───────────────────────────────────────────────
  //
  // Signed in, favourites, lists, bookmarks and saved views are the account's
  // too (public/shared/saved.js, worker/lib/saved-items.mjs). The first time
  // this browser signs in as somebody, what it kept as a visitor joins their
  // account; after that the account is the copy — the page loads it, and every
  // change here sends the whole of it back. A change the send could not take
  // stays marked, and goes next time rather than being overwritten.

  const SV = window.AgoraSaved;
  const SYNCED_AS = 'agora-saved-account', UNSENT = 'agora-saved-unsent';
  const SYNC_KEYS = new Set(Object.values(SV.KEYS));
  let syncAs = null, sendTimer = null, edits = 0;
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* this page only */ } };
  function localSaved() {
    const d = {};
    for (const p of SV.PARTS) d[p] = readLS(SV.KEYS[p]);
    return d;
  }
  /** The account's copy into this browser. True when it changed anything. */
  function adoptSaved(doc) {
    const d = SV.clean(doc);
    if (SV.same(d, localSaved())) return false;
    for (const p of SV.PARTS) {
      const v = p === 'views' ? d.views.map(x => ({ url: location.origin + x.path, ...x })) : d[p];
      try { localStorage.setItem(SV.KEYS[p], JSON.stringify(v)); } catch { /* this page only */ }
    }
    return true;
  }
  function savedChanged(k) {
    if (!SYNC_KEYS.has(k)) return;
    edits++;
    lsSet(UNSENT, '1');
    if (!syncAs) return;
    clearTimeout(sendTimer);
    sendTimer = setTimeout(sendSaved, 800);
  }
  async function putSaved(merge) {
    const res = await fetch('/api/admin/saved', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ saved: SV.clean(localSaved()), merge }),
    }).catch(() => null);
    return res && res.ok ? res.json().catch(() => null) : null;
  }
  async function sendSaved() {
    const at = edits;
    const out = await putSaved(false);
    if (out && at === edits) lsSet(UNSENT, null);
    return out;
  }
  /**
   * Bring this browser and the account level: on load, and on coming back to
   * the tab. Answers who is signed in, or null for a visitor.
   */
  async function syncSaved() {
    const res = await fetch('/api/admin/saved', { cache: 'no-store' }).catch(() => null);
    const got = res && res.ok ? await res.json().catch(() => null) : null;
    if (!got || typeof got.identity !== 'string') return null;
    const who = got.identity.toLowerCase();
    const was = lsGet(SYNCED_AS);
    let doc = null;
    if (was == null) {
      // The first sign-in here: what this browser kept joins the account.
      const out = await putSaved(true);
      if (!out) return got;
      doc = out.saved;
    } else if (was !== who) {
      // Somebody else signed in here before: theirs is on their account.
      doc = got.saved || {};
    } else if (lsGet(UNSENT) || !got.saved) {
      // Changed here while the account could not hear, or the account has
      // nothing: this browser's copy is the newer one.
      await sendSaved();
    } else doc = got.saved;
    lsSet(SYNCED_AS, who);
    syncAs = who;
    if (doc) lsSet(UNSENT, null);
    if (doc && adoptSaved(doc)) {
      renderLists();
      renderInView();
      syncMap();
      followList();
      repaintSheets();
    }
    return got;
  }

  // ── Filters ───────────────────────────────────────────────────────────
  //
  // The app's own readers, where it has them: timetable.js decides a kind,
  // services.js a service and a part of the day, locations.js a region. What
  // is this page's own is "with times". A language is timetable.js's: a
  // service by its own tags, anything else by its parish's services.

  const weekdayOf = (key) => new Date(key + 'T00:00:00Z').getUTCDay();
  /** Does a rule or an event answer what the filters ask: its kind, service, day and part of the day? */
  function whatMatches(row, f, isRule) {
    if (f.words) {
      const Q = wordsQ(f.words);
      if (Q && !window.AgoraSearch.answers(row, Q, whereWhen(row, isRule))) return false;
    }
    if (!window.AgoraTimetable.kindMatches(row, f)) return false;
    if (f.service && !window.AgoraServices.serviceMatches(f.service, row)) return false;
    const dow = isRule ? row.day_of_week : weekdayOf(local(row).date);
    if (!window.AgoraServices.dayMatches(f.day, dow)) return false;
    if (f.dayGroup && !window.AgoraServices.dayGroupMatches(f.dayGroup, dow, row)) return false;
    if (f.part && window.AgoraServices.partOfDayOf(row) !== f.part) return false;
    return true;
  }
  const asksWhat = (f) => !!(f.kind || f.service || f.day != null || f.dayGroup || f.part);
  /**
   * Where and when a row is, as search-words.js asks it: an event's date and
   * time on its parish's clock, and whether its parishes hold a service in a
   * language. A rule happens on a weekday, which it carries.
   */
  function whereWhen(row, isRule) {
    const ids = isRule ? [row.parish_id] : eventParishIds(row);
    const parishLang = (lang) => ids.some(id => hasLang(S.byId.get(id), lang));
    if (isRule) return { parishLang };
    const l = local(row);
    return { date: l.date, hm: l.hm, parishLang };
  }
  const wordsQs = new Map();
  /** What a link's words ask (/smmp/disco → "disco"), or null when they ask nothing ("the"). */
  function wordsQ(words) {
    if (!words || !words.length) return null;
    const SW = window.AgoraSearch, t = todayKey(), k = `${t}|${words.join('/')}`;
    if (!wordsQs.has(k)) {
      const Q = SW.parseQuery(SW.phraseOf(words), t);
      wordsQs.set(k, SW.asks(Q) ? Q : null);
    }
    return wordsQs.get(k);
  }
  const langIs = (l, want) => window.AgoraTimetable.langIs(l, want) || (want === 'Church Slavonic' && /slavonic|russian/i.test(l));
  const regionOf = (f) => (f.location && window.AgoraLocations ? window.AgoraLocations.resolveLocation(f.location) : null);

  /** One jurisdiction or several (url-state.js), as a list. */
  const jList = (j) => window.AgoraUrlState.jurisdictionsOf(j);
  /** Does a parish answer these filters? Collections ask it of their own filters. */
  function parishMatches(p, f, juris) {
    if (juris && !jList(juris).includes(p.jurisdiction)) return false;
    const loc = regionOf(f);
    if (loc && !window.AgoraLocations.locationMatchesParish(loc, p)) return false;
    if (f.monasteries && !window.AgoraTimetable.isMonastery(p)) return false;
    if (f.parishIds && !f.parishIds.has(p.id)) return false;
    if (f.lang && !hasLang(p, f.lang, f.langStrict)) return false;
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
  // The three tombstones (public/shared/project.mjs): a date that is off and
  // says so, struck through on its parish's card, as the app's parish page
  // has it. Nothing disappears (docs/editing.md). A suppressed date ('hidden')
  // is the one that goes without notice; only its own link still opens it.
  const TOMB = { cancelled: 'Cancelled', combined: 'Combined', break: 'Break' };
  const tombOf = (e) => (e && TOMB[e.status]) || null;
  // What the veil over an off event's poster and words says (worker/lib/page-card.mjs).
  const OFF_SAYS = { cancelled: 'This event has been cancelled', combined: 'Combined with another event', break: 'On a break', hidden: 'Suppressed' };
  function eventParishIds(e) { return [e.parish_id, ...(e.extra_parishes || []).map(x => x.id || x.parish_id || x)].filter(Boolean); }
  /** Does an event answer the page's filters, and the collection on the map if there is one? */
  function eventPasses(e, opts) {
    if (S.focus && !eventParishIds(e).some(id => S.focus.ids.has(id))) return false;
    return eventMatches(e, S.f, S.juris, opts);
  }
  /** Does an event answer these filters? A collection asks it of its own. */
  function eventMatches(e, f, juris, { scoped = true } = {}) {
    if (!visible(e)) return false;
    if (scoped && e.parish_scoped) return false;
    const pids = eventParishIds(e);
    const ps = pids.map(id => S.byId.get(id)).filter(Boolean);
    if (juris && !ps.some(p => jList(juris).includes(p.jurisdiction))) return false;
    const loc = regionOf(f);
    if (loc && !ps.some(p => window.AgoraLocations.locationMatchesParish(loc, p))) return false;
    if (f.monasteries && !ps.some(p => window.AgoraTimetable.isMonastery(p))) return false;
    if (f.parishIds && !pids.some(id => f.parishIds.has(id))) return false;
    return rowAnswers(e, f, false);
  }
  /**
   * Does a rule or an event answer what the filters ask of it: its kind,
   * service, day, part of the day and language? A collection's timetables
   * keep the lines that do, and a parish's card lights them (its focus).
   * A service answers a language by its own tags; a talk or a social by its
   * parish holding a service in it.
   */
  function rowAnswers(row, f, isRule) {
    if (!whatMatches(row, f, isRule)) return false;
    if (!f.lang) return true;
    const T = window.AgoraTimetable;
    const pids = isRule ? [row.parish_id] : eventParishIds(row);
    return T.rowAnswersLang(row, { lang: f.lang, strict: !!f.langStrict },
      !T.isService(row) && pids.some(id => hasLang(S.byId.get(id), f.lang, f.langStrict)));
  }
  function inViewEvent(e) {
    if (!S.bounds) return true;
    if (isFinite(e.lat) && isFinite(e.lng) && e.lat != null) return S.bounds.contains([e.lng, e.lat]);
    return eventParishIds(e).some(id => S.inView && S.inView.has(id));
  }
  // A chip each: each jurisdiction and each day its own.
  const filterCount = () => { const f = S.f; return jList(S.juris).length + window.AgoraServices.daysOf(f.day).length + [f.kind, f.lang, f.dayGroup, f.part, f.service, f.location, f.monasteries, f.parishIds, f.timesOnly].filter(Boolean).length; };
  const filtersOn = () => filterCount() > 0;

  // ── Links ─────────────────────────────────────────────────────────────
  //
  // The app's grammar (url-state.js), written in the order the app writes it
  // (buildPathSegs in app.js): jurisdiction, region, day, part of the day,
  // service, kind, the parishes, language. /greek/en, /sun/liturgy, /sgr+snb.
  // A card with a link of its own takes the address while it is open, /sgr or
  // /102, and every card is a step the back button undoes.

  const acronymOf = (p) => String(p.acronym || p.id).toLowerCase().replace(/\s+/g, '');
  /** A parish by its acronym, or by its id for one without — as the app reads a link. */
  function parishBySlug(slug) {
    const k = String(slug || '').toLowerCase().replace(/\s+/g, '');
    if (!k) return null;
    return S.parishes.find(p => p.acronym && acronymOf(p) === k)
      || S.parishes.find(p => p.id.toLowerCase() === k) || null;
  }
  /** The path segments for a set of filters, or for one parish or one event. */
  function segsFor({ juris = null, f = blankFilters(), parish = null, focus = null, eventId = null, from = null } = {}) {
    const U = window.AgoraUrlState, SV = window.AgoraServices;
    // A date is where a list of days starts, never one day (/sgr/2026-10-25).
    // What a card lights is the link's too (/sgr/talk, /sgr/wed/liturgy).
    if (parish) {
      const x = focus || {};
      return [acronymOf(parish), ...(x.words || []), x.day != null ? SV.daySegment(x.day) : null, x.dayGroup, x.part, x.service,
        x.kind ? U.kindSegment(x.kind, x.kindSub) : null, from, U.englishSegment(x)].filter(Boolean);
    }
    if (eventId) return [String(eventId)];
    const segs = [];
    if (juris) segs.push(U.jurisdictionSegment(juris));
    if (f.location) segs.push(f.location);
    if (f.monasteries) segs.push('monasteries');
    if (f.day != null) segs.push(SV.daySegment(f.day));
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
  const pathOf = (segs) => '/' + (segs && segs.length ? segs.join('/') : '');
  const pageSegs = () => segsFor({ juris: S.juris, f: S.f });

  /** What an address asks for: { juris, f, parish, eventId }. Needs the parishes. */
  function readPath(pathname) {
    let r = window.AgoraUrlState.classifyPath(pathname, { today: todayKey() });
    // /disco/smmp: the parish may be any word nothing else claimed, and the
    // rest are what is asked of it (focusOf), as at /smmp/disco.
    if (r.parishSlugs && r.parishSlugs.length === 1 && !parishBySlug(r.parishSlugs[0])) {
      const named = r.words.find(parishBySlug);
      if (named) r = window.AgoraUrlState.parishNamed(r, named);
    }
    const f = blankFilters();
    if (r.location) f.location = r.location;
    if (r.monasteries) f.monasteries = true;
    const named = (r.parishSlugs || []).map(parishBySlug).filter(Boolean);
    const parish = r.parishSlugs && r.parishSlugs.length === 1 ? named[0] || null : null;
    if (!parish && named.length) {
      f.parishIds = new Set(named.map(p => p.id));
      f.listId = listMatching(f.parishIds);
    }
    // A kind, a service, a day, a part of the day or a language beside one
    // parish is that card's (focusOf). Across the page, /liturgy is the kind
    // filter with Liturgy chosen, and /vespers a service of its own.
    if (!parish) {
      if (r.kind) { f.kind = r.kind; f.kindSub = r.kindSub || null; }
      if (r.lang) { f.lang = r.lang; f.langStrict = !!r.langStrict; }
      const asKind = r.service && window.AgoraUrlState.kindOfService(r.service);
      if (asKind && !r.kind) [f.kind, f.kindSub] = asKind;
      else if (r.service) f.service = r.service;
      if (r.day != null) f.day = r.day;
      if (r.dayGroup) f.dayGroup = r.dayGroup;
      if (r.part) f.part = r.part;
    }
    // A date already past starts the list today, which is the list with no date.
    const from = r.dateFocus && r.dateFocus > todayKey() ? r.dateFocus : null;
    // /donate and /greek/donate are the parishes that take donations. A
    // parish's own (/smg/donate) went to its page from the Worker, unless it
    // has none on file: then its jurisdiction's, as the app had it.
    // One jurisdiction's donations; a link to several is everybody's.
    const one = typeof r.jurisdiction === 'string' ? r.jurisdiction : null;
    if (r.donate) return { juris: one, f, parish: null, eventId: null, from: null, donate: (parish && parish.jurisdiction) || one || 'all' };
    return { juris: r.jurisdiction || null, f, parish: parish ? parish.id : null, focus: parish ? focusOf(r) : null, eventId: r.eventId || null, from };
  }
  /**
   * What a link asks of one parish, as filters: /sgr/talk, /sgr/wed/liturgy,
   * /sgr/evening, /sgr/en. Its card lights what answers and dims the rest,
   * hiding nothing; null when the link asks nothing of it.
   */
  function focusOf(r) {
    const x = { ...blankFilters(), kind: r.kind || null, kindSub: r.kindSub || null, service: r.service || null,
      day: r.day == null ? null : r.day, dayGroup: r.dayGroup || null, part: r.part || null, lang: r.lang || null, langStrict: !!r.langStrict,
      // Words that ask nothing ("the") are not kept: the link is the parish's.
      words: wordsQ(r.words) ? [...r.words] : null };
    return x.kind || x.service || x.day != null || x.dayGroup || x.part || x.lang || x.words ? x : null;
  }
  /**
   * The focus a card opened by a tap takes from where it was: the collection
   * it was in (Sunday Liturgy, the services in view), else the page's filters
   * (/talks, /wed/evening). Every parish card answers every filter one way,
   * however it was reached: /talks, then St George, is /sgr/talks.
   */
  function focusAround() {
    const top = stack[stack.length - 1];
    return focusOf((top && top._coll && top._coll.f) || S.f || {});
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

  /** The collection a link names (/en, /greek, /talks), as the page has it, or null. */
  function collectionAt(path) {
    const r = window.AgoraUrlState.classifyPath(path, { today: todayKey() });
    const meant = window.AgoraCollections.collectionFor(r);
    if (meant) return COLL.get(meant.id) || null;
    // /greek/sun/liturgy: Sunday Liturgy under a jurisdiction, as its shelf opens it on /greek.
    const bare = r.jurisdiction && window.AgoraCollections.collectionFor({ ...r, jurisdiction: null });
    const c = bare && COLL.get(bare.id);
    return c ? underJuris(c, readPath(path).juris) : null;
  }
  /**
   * Follow one of this site's links from inside the page, as if it had been
   * opened: its filters are a step, and the card it names opens over them.
   */
  function go(path) {
    if (panelOpen()) setPanel(false);
    const route = readPath(path);
    applyRoute(route);
    if (!route.parish && !route.eventId && !route.donate) {
      syncURL({ push: true });
      openPageCard(route, path);
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /** Make the page what an address asks for. */
  function applyRoute(route, { entry = true, animate = true } = {}) {
    S.juris = route.juris;
    S.f = route.f;
    S.focus = null;
    refilter({ url: 'none' });
    if (route.f.location) frameRegion(route.f.location, animate);
    else if (route.f.parishIds) fitTo(route.f.parishIds, animate);
    // A link that asks something of one parish (/sgr/talks) opens the first
    // that answers it, in front of the parish's own card.
    if (route.parish && route.focus) return openMatch(route.parish, route.focus, { entry, from: route.from });
    if (route.parish) openParish(route.parish, { entry, from: route.from, focus: null });
    else if (route.eventId) return openEvent(route.eventId, { entry });
    else if (route.donate) openDonate(route.donate === 'all' ? null : route.donate, { entry });
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
    let h = `<span class="url-host">${esc(host)}</span>`;
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
  /** A parish's one-offs ahead: its own, those held in its church and, unless `own`, those it takes part in. */
  function upcomingOneOffs(pid, { own = false } = {}) {
    const raw = window.agoraBundle.raw;
    if (!raw) return [];
    const now = Date.now();
    return (raw.events || []).filter(e => visible(e) && (e.parish_id === pid || e.location_parish_id === pid || (!own && (raw.event_parishes || []).some(x => x.event_id === e.id && x.parish_id === pid)))
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
    up: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
    share: '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M8 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
    signIn: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4"/><path d="M10 16l4-4-4-4M14 12H4"/></svg>',
    signOut: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4"/><path d="M16 16l4-4-4-4M20 12H10"/></svg>',
    // The page's Filters button's (index.html), for a card's.
    filters: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/></svg>',
    sliders: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 4v6M5 14v6M12 4v10M12 18v2M19 4v2M19 10v10"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="16" r="2"/><circle cx="19" cy="8" r="2"/></svg>',
    plusSm: '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    star: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1-4.5-4.2 6.1-.8z"/></svg>',
    starOn: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1-4.5-4.2 6.1-.8z"/></svg>',
    list: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1" fill="currentColor"/><circle cx="4.5" cy="12" r="1" fill="currentColor"/><circle cx="4.5" cy="18" r="1" fill="currentColor"/></svg>',
    more: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    phone: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>',
    globe: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>',
    map: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/></svg>',
    chev: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>',
    // The footrest rises to the viewer's LEFT, Christ's right and the good
    // thief's side, as on every Orthodox cross (scripts/build-og-images.mjs).
    cross: '<svg viewBox="0 0 40 64" aria-hidden="true" fill="currentColor"><rect x="17" y="0" width="6" height="64" rx="1"/><rect x="9" y="9" width="22" height="5" rx="1"/><rect x="2" y="21" width="36" height="6" rx="1"/><rect x="9" y="44" width="22" height="5" rx="1" transform="rotate(20 20 46.5)"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>',
    place: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>',
    pin: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    bookmark: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6.5 3.5h11v17L12 16.6l-5.5 3.9z"/></svg>',
    bookmarkOn: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M6.5 3.5h11v17L12 16.6l-5.5 3.9z"/></svg>',
    live: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none"/><path d="M8.3 8.3a5.2 5.2 0 0 0 0 7.4M15.7 8.3a5.2 5.2 0 0 1 0 7.4M5.4 5.4a9.3 9.3 0 0 0 0 13.2M18.6 5.4a9.3 9.3 0 0 1 0 13.2"/></svg>',
    heart: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/></svg>',
    link: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg>',
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
    // Where the map is looking, said in the parish chip under it.
    const c = map.getCenter();
    S.place = S.loc && km(S.loc, { lat: c.lat, lng: c.lng }) < 15 ? 'Near you' : placeName(c.lat, c.lng, map.getZoom());
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
    // The filters float on the full-screen map, so a panel open in the dock comes down to them.
    if (on && panelInDock()) setPanel(true);
    document.body.classList.toggle('map-full', on);
    $('#btn-fullscreen').setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    syncDock();
    setTimeout(() => map && map.resize(), 30);
    setTimeout(() => map && map.resize(), 320);
  }

  // ── The dock ──────────────────────────────────────────────────────────
  //
  // Scrolled past the parish chip and the filters, they come down the page
  // with you: a header of their own, holding the chip, the filters' button,
  // search and the account, and the filters' chips under them. It is there
  // while the page's own filters are out of sight above, or while the panel
  // is open under it; never over the full-screen map. The days' headers stick
  // under it (--dock-h).

  let pageBarGone = false;
  function syncDock() {
    const dock = $('#dock');
    const on = !document.body.classList.contains('map-full') && (pageBarGone || panelInDock());
    document.body.classList.toggle('docked', on);
    dock.inert = !on;
  }
  new IntersectionObserver(([e]) => {
    pageBarGone = !e.isIntersecting && e.boundingClientRect.top < 0;
    syncDock();
  }).observe($('#page > .filter-bar'));
  new ResizeObserver(() => document.documentElement.style.setProperty('--dock-h', `${$('#dock .dock-head').offsetHeight}px`))
    .observe($('#dock .dock-head'));
  // On the full-screen map the panel sits under the filters' button and its chips, however many rows they make.
  new ResizeObserver(() => document.documentElement.style.setProperty('--fbar-h', `${$('#page > .filter-bar').offsetHeight}px`))
    .observe($('#page > .filter-bar'), { box: 'border-box' });

  // ── Jurisdiction tabs (above the viewport) ────────────────────────────
  //
  // The app's banner (filters.js): each name in its own colour, underlined
  // while none is chosen; the chosen one filled, the others dimmed. A tab is
  // one jurisdiction at a time, and a second tap lets it go; several at once
  // are the filters' (setFilter), and each of those is filled here too.

  const TAB_ORDER = ['antiochian', 'greek', 'serbian', 'russian', 'romanian', 'macedonian'];
  /** A colour as it is drawn: lifted on the dark scheme, as app.js does. */
  const shown = (hex) => (dark() && window.agoraLiftForDark ? window.agoraLiftForDark(hex) : hex);
  function renderJurisChips() {
    const row = $('#juris-row');
    row.classList.toggle('has-active', !!S.juris);
    row.innerHTML = TAB_ORDER.map(j => {
      const on = jList(S.juris).includes(j);
      return `<button class="jurisdiction-chip${on ? ' active' : ''}" type="button" data-juris="${j}" style="--j:${shown(jColor(j))}" aria-pressed="${on}">${esc(JURIS[j].short)}</button>`;
    }).join('');
  }

  // ── What the viewport holds ───────────────────────────────────────────
  //
  // Under the small map, a chip that says it in words: how many parishes are
  // in view, where the map is looking, and up to seven of their logos. With
  // one parish in view it is that parish, by its full name, and opens its
  // card. Scrolled past, the same chip rides in the dock.
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
  // What the places in view are called: monasteries under /monasteries.
  const placeNoun = (n) => S.f.monasteries ? (n === 1 ? 'monastery' : 'monasteries') : (n === 1 ? 'parish' : 'parishes');
  /**
   * The parishes in view, named for what they are: "64 parishes in Sydney",
   * and the filters as a link's preview says them (shared/link-words.js):
   * "Orthodox youth groups in Sydney", "Antiochian Orthodox Liturgies in
   * English near you". Their card wears these, and so does a list saved
   * from it.
   */
  function viewWords(n) {
    const place = !S.place ? '' : S.place === 'Near you' ? 'near you' : `in ${S.place}`;
    const r = window.AgoraUrlState.classifyPath(pathOf(viewSegs()), { today: todayKey() });
    const loc = regionOf(S.f);
    const list = S.f.listId && listById(S.f.listId);
    const named = !list && S.f.parishIds ? [...S.f.parishIds].map(id => S.byId.get(id)).filter(Boolean) : null;
    let what = window.AgoraLinkWords.headingOf(r, { loc, named: named && named.length <= 3 ? named : null });
    if (list) what += ` from ${list.name}`;
    else if (named && named.length > 3) what += ` at ${named.length} parishes`;
    // Saved as a list, it is named for what it holds, not how many.
    let name = window.AgoraLinkWords.listNameOf(r, { loc, place: S.place });
    if (list) name += ` from ${list.name}`;
    else if (named) name = named.map(p => p.acronym || p.name).join(' + ');
    return {
      title: `${n} ${placeNoun(n)}${place ? ` ${place}` : ''}`,
      // A region or the parishes named say where already.
      blurb: loc || named ? what : [what, place].filter(Boolean).join(' '),
      name,
    };
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
    const logos = (n) => `<span class="stackrow">${ranked.slice(0, n).map(p => avatar(p, 'stack')).join('')}</span>`;
    const place = esc(S.place || '');
    const one = ps.length === 1 ? ps[0] : null;
    const chip = $('#inview');
    chip.classList.toggle('one', !!one);
    chip.setAttribute('aria-label', one ? `${one.full_name || one.name}: open its card` : S.f.monasteries ? 'Monasteries in view' : 'Parishes in view');
    chip.innerHTML = one
      ? `${logos(1)}<span class="inview-text"><b>${esc(one.full_name || one.name)}</b><small>${place}</small></span><span class="inview-go">${I.chev}</span>`
      : ps.length
        ? `${logos(7)}<span class="inview-text"><span>Viewing <b>${ps.length} ${placeNoun(ps.length)}</b></span><small>${place}</small></span><span class="inview-go">${I.chev}</span>`
        : `<span class="inview-text"><b>No ${placeNoun(0)} here</b><small>${place ? `${place} · ` : ''}Pan or zoom out</small></span>`;
    // The dock's, in a line: its short name where the chip has room for the full one.
    $('.dock-chip').innerHTML = `${ps.length ? logos(one ? 1 : 3) : ''}<span class="dock-chip-t"><b>${one ? esc(one.name) : ps.length ? `Viewing ${ps.length}` : 'None in view'}</b><small>${place}</small></span>`;
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
        dist = `<span class="pill-dist ${distClass(k)}">${esc(k < 10 ? k.toFixed(1) : String(Math.round(k)))}km</span>`;
      }
      return `<button class="parish-pill pill-${tone}" type="button" data-parish="${esc(p.id)}" style="--pill-ring:${shown(jColor(p.jurisdiction))}" title="${esc(p.name || '')}" aria-label="${esc(p.name || p.acronym || '')}">${pillLogo(p)}${star}${dist}</button>`;
    }).join('');
    const list = $('#parish-pills');
    if (list.scrollLeft) list.scrollLeft = 0;
  }

  // ── Active filters, said once beside their button ────────────────────

  /** Each filter that is on, as [its key, what its chip says, and which of several it is]. */
  function activeBits(f) {
    const SV = window.AgoraServices;
    const bits = [];
    const loc = regionOf(f);
    if (loc) bits.push(['location', loc.label]);
    if (f.monasteries) bits.push(['monasteries', 'Monasteries']);
    // Each day its own chip, to let go of one of them.
    SV.daysOf(f.day).forEach(d => bits.push(['day', SV.dayName(d), d]));
    if (f.dayGroup) bits.push(['dayGroup', SV.dayGroupLabel(f.dayGroup)]);
    if (f.part) bits.push(['part', SV.partOfDayLabel(f.part)]);
    if (f.service) bits.push(['service', SV.serviceLabel(f.service)]);
    if (f.kind) bits.push(['kind', f.kindSub ? kindSubLabel(f.kindSub) : KIND_NAMES[f.kind] || f.kind]);
    if (f.lang) bits.push(['lang', f.langStrict ? `${f.lang} only` : f.lang]);
    if (f.timesOnly) bits.push(['timesOnly', 'With service times']);
    if (f.parishIds) {
      const l = f.listId && listById(f.listId);
      bits.push(['parishIds', l ? l.name : [...f.parishIds].map(id => S.byId.get(id)).filter(Boolean).map(p => p.acronym || p.name).join(' + ')]);
    }
    return bits;
  }
  function renderActive() {
    const f = S.f;
    const chip = (k, label, val = null, style = '') => `<button class="afchip${style ? ' afj' : ''}" type="button" data-clear="${k}"${val != null ? ` data-val="${esc(val)}"` : ''}${style ? ` style="${style}"` : ''} aria-label="${esc(`Remove ${label}`)}">${esc(label)}${I.x}</button>`;
    const bits = activeBits(f).map(([k, label, val]) => chip(k, label, val));
    // A jurisdiction first, in its colour, as its tab is.
    bits.unshift(...jList(S.juris).map(j => chip('juris', JURIS[j]?.short || j, j, `--j:${shown(jColor(j))}`)));
    if (S.focus) bits.unshift(chip('focus', S.focus.title));
    // Beside the button on the page, and under the dock's.
    $('#active-filters').innerHTML = $('#dock-active').innerHTML = bits.join('');
    const n = filterCount();
    $$('.fcount').forEach(count => { count.hidden = !n; count.textContent = n; });
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

  /**
   * A language badge says something only where the filters do not already:
   * under a language filter (or a card lit by one), a row in that language
   * alone wears none, and one in two languages still says both.
   */
  const langBadge = (langs, asked) => !!(langs && langs.length) && !(asked && langs.every(l => langIs(l, asked)));
  function eventRow(e, { showDay = false, now = false, here = null, focus = null, lit = false, lang: asked = null } = {}) {
    const p = S.byId.get(e.parish_id);
    const l = local(e);
    const d = distOf(e.lat != null ? e : p);
    const title = e.feast ? `${e.title}` : e.title;
    // Its own languages, as its line in the timetable has them, run on after its name. Services only.
    const langs = window.AgoraTimetable.serviceLangs(e);
    const lang = langBadge(langs, asked || (focus && focus.lang)) ? `<span class="elang">${esc(langs.map(window.AgoraLanguages.shortOf).join(', '))}</span>` : '';
    // On a parish's own card its name is the card's; another parish's is said.
    // Held in another parish's church, each card says the other's part: the
    // venue's names its host, the host's names where it is.
    const venue = e.location_parish_id && e.location_parish_id !== e.parish_id ? S.byId.get(e.location_parish_id) : null;
    // The second block: whose it is, with how far, all one line that may run to two.
    const sub = here && venue && here === venue.id ? `<span class="esub">${avatar(p, 'xs')}<span class="epar">Hosted by ${esc(p ? p.name : e.parish_name || '')}</span></span>`
      : here && venue && e.parish_id === here ? `<span class="esub">${avatar(venue, 'xs')}<span class="epar">At ${esc(venue.name)}</span></span>`
      : here && e.parish_id === here ? ''
      : `<span class="esub">${avatar(p, 'xs')}<span class="epar">${esc(p ? p.name : e.parish_name || '')}${d != null ? ` ${distHTML(d)}` : ''}</span></span>`;
    const tomb = tombOf(e);
    // A card's focus (/sgr/talk) lights its next and dims what does not answer it.
    const dim = focus && !rowAnswers(e, focus, false);
    return `<button class="erow${now ? ' now' : ''}${tomb ? ` tomb ${e.status}` : ''}${lit ? ' lit' : ''}${dim ? ' dim' : ''}" type="button" data-event="${esc(e.id)}">
        <span class="etime">${now ? '<i class="live"></i>Now' : timeHTML(l.hm)}${showDay ? `<small>${esc(dayLabel(l.date))}</small>` : ''}</span>
        ${roundel(e.event_type)}
        <span class="ebody"><span class="etitle-row"><span class="etitle">${esc(title)}${lang ? ` ${lang}` : ''}</span>${tomb ? `<span class="etomb">${esc(tomb)}</span>` : ''}</span>
          ${sub}
          ${e.feast ? `<span class="efeast">${esc(e.feast)}</span>` : ''}
          ${tomb && e.break_note ? `<span class="enote">${esc(e.break_note)}</span>` : ''}</span>
        ${e.poster_path ? `<img class="ethumb" src="${esc(e.poster_path)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
      </button>`;
  }

  function renderToday() {
    const html = todayHTML(feedFor(2).filter(e => eventPasses(e) && inViewEvent(e)), { lang: S.f.lang });
    $('#today').innerHTML = html;
    $('#today').hidden = !html;
  }
  /**
   * Today, from the rows given. With something on now, "Happening now" and
   * then "Later today"; with nothing on now, the rest of the day under the
   * box's own title, "This evening" when it all is; once the day is done,
   * tomorrow, titled so. A day with both has the Evening divider. The page's
   * box is what is in view; a collection's card has one of its own, of its
   * parishes (openCollection), and a parish's card its own (parishTodayHTML).
   * Its button goes on to the days after, in the Events feed or the card's
   * Coming up. Nothing today or tomorrow, and no focus to say, is no box:
   * '', and its place goes with it.
   *
   * At a parish, `here` is it. A `focus` dims what does not answer it, and
   * `next` is the next that does, lit where it already is and under its own
   * day where it is not; 'none' when there is none. `clear` names the focus
   * on the button that lets it go.
   */
  function todayHTML(all, { here = null, focus = null, next = null, clear = '', lang = null } = {}) {
    const now = Date.now();
    const t = todayKey();
    const live = all.filter(e => Date.parse(e.start_utc) <= now && endMs(e) > now);
    const later = all.filter(e => Date.parse(e.start_utc) > now && local(e).date === t);
    const tomorrow = all.filter(e => local(e).date === addDays(t, 1));
    const seen = [];
    // The rows come in order, so the evening starts once: the divider goes
    // there when the morning or afternoon came before it.
    let day = false, eve = false;
    const rows = (es, o = {}) => es.map(e => {
      seen.push(e.id);
      let div = '';
      if (!isEvening(e)) day = true;
      else if (!eve) { eve = true; if (day) div = EVENING; }
      return div + eventRow(e, { ...o, here, focus, lang, lit: !!next && next.id === e.id });
    }).join('');
    let title = 'Today', k = t, body = '';
    const showsTomorrow = !live.length && !later.length && tomorrow.length > 0;
    if (!live.length && !later.length && !showsTomorrow && !next && !clear) return '';
    if (live.length) {
      body += `<div class="tsub">Happening now</div>${rows(live.slice(0, 4), { now: true })}`;
      if (later.length) body += `<div class="tsub">Later today</div>${rows(later.slice(0, 3))}`;
    } else if (later.length) {
      if (later.every(isEvening)) title = 'This evening';
      body += rows(later.slice(0, 5));
    } else if (showsTomorrow) {
      title = 'Tomorrow';
      k = addDays(t, 1);
      body += rows(tomorrow.slice(0, 4));
    } else body += '<div class="tempty">Nothing more today.</div>';
    // The next that answers the focus, by its day, where the rows above do not have it.
    if (next === 'none') body += `<div class="tsub">${esc(clear)}</div><div class="tempty">None on file in the next few months.</div>`;
    else if (next && !seen.includes(next.id)) {
      const nk = local(next).date;
      body += `<div class="tsub tnext">Next · ${esc(nk === addDays(t, 1) ? 'Tomorrow' : dayLabel(nk, true))}</div>${eventRow(next, { here, lang, focus, lit: true })}`;
    }
    const d = new Date(k + 'T00:00:00Z');
    // Tomorrow is the Events feed's, from its day on: the rest of the week,
    // once tomorrow is here already.
    return `<header class="card-head"><div><h2>${title}</h2><p>${WD_LONG[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}</p></div>${clear ? `<button class="tfocus" type="button" data-act="unfocus" aria-label="${esc(`Show everything, not only ${clear.toLowerCase()}`)}"><span>${esc(clear)}</span>${I.x}</button>` : ''}</header>
      ${body}
      <button class="see-all" type="button" data-jump="tomorrow">${showsTomorrow ? 'This week' : !live.length && !later.length ? 'Coming up' : 'Tomorrow'} ${I.chev}</button>`;
  }

  // ── The page under Today: Favourites, lists, collections ──────────────
  //
  // Quiet on purpose, the app's white and its hairlines: Favourites open on
  // the page, each starred parish with what is on next there; your other
  // lists as rows; one shelf of collections and one of posters; languages and
  // jurisdictions as links in a row, not two more shelves.

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
    const route = readPath(c.path);
    return byFilters({ ...c, ...look, juris: route.juris, f: route.f });
  }
  // The look of each — a tint and its sign, or a jurisdiction's colour — is
  // collections.js's, which the Worker's first paint of a card reads too.
  const lookOf = (c) => window.AgoraCollections.lookOf(c, jColor);
  /** What paints a look: `class` and `style` for its tile or its card's head. */
  const lookAttrs = (c, cls) => `class="${cls}${c.tint ? ' soft' : ''}" style="${esc(window.AgoraCollections.lookStyle(c))}"`;
  /** The curated slices: preset filters that open as a card of parishes. English is the languages'. */
  function curated() {
    return window.AgoraCollections.CURATED.filter(c => c.id !== 'english').map(c => fromShared(c, lookOf(c))).filter(c => c.ids.length);
  }
  const LANGS = Object.keys(window.AgoraCollections.LANGUAGE_LOOK).map(l => [l]);
  /** English first, then the others, as the filters list them. */
  function languageCollections() {
    const en = window.AgoraCollections.byId('english');
    return [{ ...en, short: 'English', ...lookOf(en) }, ...window.AgoraCollections.LANGUAGES.map(c => ({ ...c, ...lookOf(c) }))]
      .map(c => fromShared(c, {})).filter(c => c.ids.length);
  }
  /** A jurisdiction's logo, once /admin has one: the picture on its card. */
  const jurisLogo = (j) => ((window.agoraBundle && window.agoraBundle.raw && window.agoraBundle.raw.jurisdiction_logos) || {})[j] || null;
  function jurisCollections() {
    return JURIS_ORDER.map(j => window.AgoraCollections.byId('j-' + j)).filter(Boolean).map(c => fromShared(c, {
      logo: jurisLogo(c.jurisdiction), ...lookOf(c),
    }));
  }
  let COLL = new Map();
  function remember(cs) { cs.forEach(c => COLL.set(c.id, c)); return cs; }
  /**
   * A collection opened under the page's jurisdiction keeps to it: on /greek
   * (greek.orthodoxy.au), Sunday Liturgy is /greek/sun/liturgy. A
   * jurisdiction's own, a list and a search keep to themselves.
   */
  function underJuris(c, juris = S.juris) {
    if (!juris || c.juris || c.listId || !c.segs) return c;
    return byFilters({ ...c, ids: null, juris });
  }

  /** A collection's sign: a logo, its letters, its kind's roundel, or the cross. */
  function signOf(c) {
    return c.logo ? `<span class="clogo"><img src="${esc(c.logo)}" alt=""></span>`
      : c.glyph ? `<span class="cglyph">${c.glyph.startsWith('<svg') ? c.glyph : esc(c.glyph)}</span>`
      : c.icon ? roundel(c.kind, true)
      : `<span class="ccross">${I.cross}</span>`;
  }
  function collCard(c) {
    const n = c.ids.length;
    const inView = S.inView ? c.ids.filter(id => S.inView.has(id)).length : null;
    const sub = `${n} ${n === 1 ? 'place' : 'places'}${inView != null && inView && inView !== n ? ` · ${inView} in view` : ''}`;
    const logos = c.ids.map(id => S.byId.get(id)).filter(p => p && p.logo_path).slice(0, 3);
    return `<button class="ccard" type="button" data-coll="${esc(c.id)}">
        <span ${lookAttrs(c, 'cart')}>${signOf(c)}${logos.length ? `<span class="clogos">${logos.map(p => avatar(p, 'xs')).join('')}</span>` : ''}</span>
        <span class="ctext"><span class="ctitle">${esc(c.title)}</span><span class="csub">${esc(sub)}</span></span>
      </button>`;
  }
  const secHead = (title, act = '') => `<header class="shelf-head"><h2>${esc(title)}</h2>${act}</header>`;
  function shelf(el, title, sub, cards) {
    el.innerHTML = `${secHead(title)}${sub ? `<p class="shelf-sub">${esc(sub)}</p>` : ''}<div class="shelf-row">${cards}</div>`;
  }
  function renderCollections() {
    shelf($('#shelf-collections'), 'Collections', null, remember(curated()).map(collCard).join(''));
    // Languages: a chip each, its letters in its own script.
    $('#shelf-languages').innerHTML = `${secHead('Languages')}<div class="lang-row">${remember(languageCollections()).map(c => `<button class="lchip" type="button" data-coll="${esc(c.id)}">
        <span ${lookAttrs(c, 'lglyph')}>${esc(c.glyph || '')}</span><span>${esc(c.short || c.title)}</span><small>${c.ids.length}</small></button>`).join('')}</div>`;
    // Jurisdictions: a row each, in its colour, two to a line.
    $('#shelf-jurisdictions').innerHTML = `${secHead('Jurisdictions')}<div class="juris-grid">${remember(jurisCollections()).map(c => `<button class="jrow" type="button" data-coll="${esc(c.id)}" style="--j:${shown(c.color || '#64748b')}">
        <span class="jmark">${c.logo ? `<img src="${esc(c.logo)}" alt="">` : I.cross}</span>
        <span class="jt"><b>${esc(JURIS[c.jurisdiction]?.short || c.title)}</b><small>${c.ids.length} ${c.ids.length === 1 ? 'parish' : 'parishes'}</small></span></button>`).join('')}</div>`;
    renderLists();
  }
  // Bookmarks, saved views and lists made by hand: a tint and a sign each.
  const BOOKMARK_LOOK = { tint: '#4f46e5', glyph: I.bookmarkOn };
  const VIEW_LOOK = { tint: '#0f766e', glyph: I.sliders };
  const LIST_LOOK = { tint: '#64748b', glyph: '☰' };
  const FAV_LOOK = { tint: '#b45309', glyph: '★' };
  /** A saved view's name: what its link asks for, as its chips say it. */
  function viewTitle(path) {
    const r = readPath(path);
    if (r.parish) return S.byId.get(r.parish)?.name || path;
    const bits = activeBits(r.f).map(b => b[1]);
    if (r.juris) bits.unshift(jList(r.juris).map(j => JURIS[j]?.short || j).join(' + '));
    return bits.join(' · ') || path;
  }

  /**
   * Favourites, open on the page rather than behind a card: each starred
   * parish, in the order starred, with what is on next there. Its card of
   * timetables is a tap away. Nothing starred, no section: the star on a
   * parish's card says what it does.
   */
  function renderFavs() {
    const ps = favIds().map(id => S.byId.get(id)).filter(Boolean);
    const rows = ps.map(p => {
      const nx = nextOf(p.id, e => e.event_type === 'liturgy') || nextOf(p.id);
      const d = distOf(p);
      return `<button class="hrow" type="button" data-parish="${esc(p.id)}">${avatar(p, 'sm')}
          <span class="ht"><b>${esc(p.name)}</b><small>${nx ? `${roundel(nx.event_type)}<span>${esc(nx.title)} · ${esc(whenShort(nx))}</span>` : '<span>No service times on file yet</span>'}</small></span>
          ${d != null ? distHTML(d) : ''}${I.chev}</button>`;
    }).join('');
    const el = $('#favs');
    el.hidden = !rows;
    el.innerHTML = rows ? `${secHead('Favourites', `<button class="shelf-act" type="button" data-coll="list-fav">Timetables${I.chev}</button>`)}
      <div class="hlist">${rows}</div>` : '';
  }
  /** Your other lists, bookmarks and saved views, as rows: only once there is one. */
  function renderLists() {
    const ls = allLists().map(l => ({
      id: 'list-' + l.id, listId: l.id, title: l.name, kicker: 'Your list',
      ...(l.fav ? FAV_LOOK : LIST_LOOK), ids: l.ids, blurb: l.about || (l.fav ? 'Parishes you starred.' : 'A list you made.'),
      // A list of parishes is a link: /sgr+snb.
      ...(l.ids.length ? byFilters({ ids: l.ids, f: { parishIds: new Set(l.ids), listId: l.id } }) : {}),
    }));
    remember(ls);
    renderFavs();
    const row = (attr, look, title, sub) => `<button class="hrow" type="button" ${attr}><span ${lookAttrs(look, 'hic')}>${look.glyph}</span>
        <span class="ht"><b>${esc(title)}</b><small><span>${esc(sub)}</span></small></span>${I.chev}</button>`;
    const bm = bookmarked();
    const rows = [
      ...ls.filter(c => c.listId !== 'fav').map(c => row(`data-coll="${esc(c.id)}"`, LIST_LOOK, c.title, `${c.ids.length} ${c.ids.length === 1 ? 'place' : 'places'}`)),
      ...(bm.dates.length || bm.rules.length ? [row('data-act="bookmarks"', BOOKMARK_LOOK, 'Bookmarks', `${bm.dates.length} to come`)] : []),
      ...savedViews().map(v => row(`data-view="${esc(v.path)}"`, VIEW_LOOK, viewTitle(v.path), v.path)),
    ];
    $('#shelf-lists').hidden = !rows.length;
    $('#shelf-lists').innerHTML = rows.length ? `${secHead('Your lists')}<div class="hlist">${rows.join('')}
        <button class="hrow new" type="button" data-newlist><span class="hic">${I.plusSm}</span><span class="ht"><b>New list</b></span></button></div>` : '';
    renderPanel();
  }

  // ── What's on: the one-offs, poster first ─────────────────────────────

  function renderWhatsOn() {
    const el = $('#shelf-whatson');
    const raw = window.agoraBundle.raw;
    if (!raw) return;
    const now = Date.now();
    const horizon = now + 60 * DAY;
    // One-offs with posters first, then rule occurrences that carry their own.
    const pool = feedFor(21)
      .concat((raw.events || []).filter(e => Date.parse(e.start_utc) > now + 21 * DAY && Date.parse(e.start_utc) < horizon))
      // Regular services are the timetable's; this shelf is for the things that happen once.
      .filter(e => e.poster_path && endMs(e) > now && !['liturgy', 'prayer'].includes(e.event_type) && eventPasses(e));
    const seen = new Set();
    const uniq = pool.filter(e => {
      const k = e.schedule_id ? `r${e.schedule_id}` : `e${e.id}`;
      if (seen.has(k)) return false; seen.add(k); return true;
    });
    let list = uniq.filter(inViewEvent);
    // Too few in view: the nearest a dozen, wherever they are.
    if (list.length < 2) {
      const o = sortOrigin();
      const away = (e) => { const at = e.lat != null ? e : S.byId.get(e.parish_id); return o && at && at.lat != null ? km(o, at) : Infinity; };
      list = uniq.map(e => [e, away(e)]).sort((a, b) => a[1] - b[1]).slice(0, 12).map(x => x[0]);
    }
    list = list.sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc)).slice(0, 12);
    if (!list.length) { el.innerHTML = ''; return; }
    // The poster whole, and what it is under it: its own words are on it already.
    const cards = list.map(e => {
      const p = S.byId.get(e.parish_id);
      const d = distOf(p);
      return `<button class="poster" type="button" data-event="${esc(e.id)}">
          <span class="pimg"><img src="${esc(e.poster_path)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('noimg')"></span>
          <span class="ptext"><span class="pkicker">${esc(kindLabel(e.event_type))} · ${esc(whenShort(e))}</span><span class="ptitle">${esc(e.title)}</span>
            <span class="pfrom">${avatar(p, 'xs')}<span>${esc(p ? p.name : '')}${d != null ? ` · ${distHTML(d, 'span')}` : ''}</span></span></span>
        </button>`;
    }).join('');
    shelf(el, "What's on", whatsOnWords(), cards);
  }
  // The feed's kinds, as What's on says them.
  const ON_KINDS = { services: 'services', talks: 'talks and Bible studies', socials: 'youth groups and socials' };
  const ON_SUBS = { 'bible-study': 'Bible studies', youth: 'youth groups', social: 'social gatherings', feast: 'feasts' };
  /**
   * What's on, said as the filters ask it: "Nearby events", "Nearby talks and
   * Bible studies in Greek", "Nearby Greek Orthodox evening events on
   * Saturdays"; where the filters say where, there instead: "Events in
   * Queensland", "Events at St Savvas".
   */
  function whatsOnWords() {
    const f = S.f, W = window.AgoraLinkWords, SV = window.AgoraServices;
    const full = f.lang && f.langStrict ? (/^english$/i.test(f.lang) ? 'fully-English' : `${f.lang}-only`) : '';
    let noun = f.service ? SV.servicePlural(f.service)
      : f.kindSub ? ON_SUBS[f.kindSub] || `${kindLabel(f.kindSub).toLowerCase()} events`
      : ON_KINDS[f.kind] || 'events';
    if (f.monasteries) noun += ' at monasteries';
    const what = [S.juris ? W.jurisLabel(S.juris) : '', full, f.part || '', noun].filter(Boolean).join(' ')
      + W.daysPhrase(f) + (f.lang && !full ? ` in ${f.lang}` : '');
    const loc = regionOf(f);
    const list = f.listId && listById(f.listId);
    const named = !list && f.parishIds ? [...f.parishIds].map(id => S.byId.get(id)).filter(Boolean) : [];
    const where = loc ? ` in ${loc.label}` : list ? ` from ${list.name}` : S.focus ? ` from ${S.focus.title}`
      : named.length > 3 ? ` at ${named.length} parishes` : named.length ? ` at ${named.map(p => p.name).join(', ').replace(/, ([^,]*)$/, ' and $1')}` : '';
    const line = where ? what + where : `nearby ${what}`;
    return line.charAt(0).toUpperCase() + line.slice(1);
  }

  // ── Days: the stream's, and a parish's Coming up ───────────────────────
  //
  // The app's dated list: a quiet header for each day with its own link, the
  // morning's services and events, then the evening's under the moon. A date
  // picked from the calendar is where the list starts — a FROM, as every date
  // in a link is — and it goes in the link: /2026-10-25, /sgr/2026-10-25.

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
  function datePickHTML(scope, from, beside = '') {
    const t = todayKey();
    return `<div class="date-pick">
        <span class="date-btn"><button class="fpill${from ? ' on' : ''}" type="button" data-pick-date="${scope}">${CAL}<span>${from ? esc(`From ${shortDate(from)}`) : 'Pick a date'}</span></button><input class="date-input" type="date" data-date-input="${scope}" min="${t}" max="${addDays(t, 365)}" value="${esc(from || t)}" tabindex="-1" aria-label="Start from a date"></span>
        ${from ? `<button class="fpill" type="button" data-date-clear="${scope}">Today</button>` : ''}${beside}
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
      const head = `<h3 class="dh${weekdayOf(k) === 0 ? ' sun' : ''}"><span>${esc(dayLabel(k, true))}</span>${linkFor ? dayLink(k, linkFor(k)) : ''}</h3>`;
      if (!es.length) { out.push(`<section class="sday empty" data-date="${k}">${head}<p>Nothing in view</p></section>`); continue; }
      const morning = es.filter(e => !isEvening(e)), evening = es.filter(isEvening);
      out.push(`<section class="sday" data-date="${k}">${head}${morning.map(e => eventRow(e, row)).join('')}${evening.length ? EVENING + evening.map(e => eventRow(e, row)).join('') : ''}</section>`);
    }
    return out.join('');
  }

  /**
   * The days after Today: the In view card, under the page's filters, at its
   * Coming up from `k` (a date from a link, or tomorrow). One parish in view
   * is that parish's card. The page has no feed of its own.
   */
  function openInView({ at = null, from = null } = {}) {
    const ids = viewParishes().map(p => p.id);
    if (ids.length === 1) openParish(ids[0], { from });
    else {
      // Its events are the page's filters' too. Shared, it is those parishes
      // by name under the same filters (/sgr+snb/en-only), not the page's link.
      const shareSegs = segsFor({ juris: S.juris, f: { ...S.f, parishIds: new Set(ids), listId: null } });
      openCollection({ id: 'inview', kicker: 'In view', tint: '#475569', ids, f: { ...S.f }, juris: S.juris, shareSegs, ...viewWords(ids.length) }, { from });
    }
    if (at || from) toDay(stack[stack.length - 1], at || from);
  }
  /** A card's Coming up, scrolled to the first day from `k` on. */
  function toDay(el, k) {
    if (!el || !el.querySelector('.cu')) return;
    const day = [...el.querySelectorAll('.cu [data-date]')].find(d => d.dataset.date >= k);
    (day || el.querySelector('.cu-band')).scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  /** A link that names a collection opens its card; a bare date, the In view card from it. */
  function openPageCard(route, path) {
    const c = collectionAt(path);
    if (c) openCollection(c, { from: route.from });
    else if (route.from) openInView({ from: route.from });
  }

  function renderFeeds() {
    renderToday();
    renderWhatsOn();
    // Counts on the shelves move with the view.
    $$('.ccard[data-coll]').forEach(b => {
      const c = COLL.get(b.dataset.coll) && underJuris(COLL.get(b.dataset.coll));
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
    // The card the Worker painted for this link (worker/lib/page-card.mjs)
    // gives way to this one where it stands, with no slide.
    const painted = $$(':scope > .ssr', host);
    if (painted.length) {
      el.classList.add('open', 'instant');
      painted.forEach(x => x.remove());
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.remove('instant')));
    } else {
      requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
    }
    const scroller = el.querySelector('.sheet-scroll');
    // A card or a collection scrolled a screen down has its way back up, under its bar.
    const tall = scroller && /\b(parish|collection|event)\b/.test(cls);
    if (tall) el.insertAdjacentHTML('beforeend', `<button class="totop" type="button" data-act="totop" aria-label="Back to top" tabindex="-1">${I.up}</button>`);
    // Its bar takes its name once the card's own title has scrolled under it.
    const titled = () => {
      const h = scroller.querySelector('.ph h1, .ev-head h1, .chero h1'), bar = el.querySelector('.glassbar');
      el.classList.toggle('titled', !h || !bar || h.getBoundingClientRect().bottom <= bar.getBoundingClientRect().bottom);
    };
    if (scroller) {
      scroller.addEventListener('scroll', () => {
        el.classList.toggle('scrolled', scroller.scrollTop > 40);
        if (tall) el.classList.toggle('deep', scroller.scrollTop > scroller.clientHeight);
        titled();
      }, { passive: true });
      titled();
    }
    swipeToClose(el);
    if (entry) syncURL({ push: true, step: true });
    else writeURL();
    fitLinks(el);
    return el;
  }
  /**
   * A card goes the way it came: pulled down by its bar, or anywhere on it
   * once it is scrolled to its top, it follows the finger, and let go far
   * enough down (or flicked) it closes, a step back like its X. Short of
   * that it springs back. A sideways drag is the row under the finger's
   * (the buttons, a link), and an upward one the card's own scroll.
   * Wide, a card stands at the right and has its X alone.
   */
  function swipeToClose(el) {
    const scroller = el.querySelector('.sheet-scroll');
    let g = null;
    const reset = () => { el.style.transform = ''; $('#scrim').style.opacity = ''; el.classList.remove('dragging'); };
    el.addEventListener('touchstart', (e) => {
      g = null;
      if (WIDE.matches || e.touches.length !== 1 || el !== stack[stack.length - 1]) return;
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      const y = e.touches[0].clientY;
      const bar = el.querySelector('.glassbar');
      const onBar = y - el.getBoundingClientRect().top < (bar ? bar.offsetHeight : 64);
      if (!onBar && scroller && scroller.scrollTop > 0) return;
      g = { y, x: e.touches[0].clientX, t: Date.now(), dy: 0, live: false };
    }, { passive: true });
    el.addEventListener('touchmove', (e) => {
      if (!g) return;
      const dy = e.touches[0].clientY - g.y, dx = e.touches[0].clientX - g.x;
      if (!g.live) {
        // Decided on the first real move, before the card's own scroll can start.
        if (Math.abs(dy) < 3 && Math.abs(dx) < 3) return;
        if (dy <= 0 || Math.abs(dx) > dy) { g = null; return; }
        g.live = true;
        el.classList.add('dragging');
      }
      if (e.cancelable) e.preventDefault();
      g.dy = Math.max(0, dy);
      el.style.transform = `translateY(${g.dy}px)`;
      $('#scrim').style.opacity = String(Math.max(0.2, 1 - g.dy / el.offsetHeight));
    }, { passive: false });
    const end = () => {
      const was = g;
      g = null;
      if (!was || !was.live) return;
      const fast = was.dy > 40 && was.dy / Math.max(1, Date.now() - was.t) > 0.6;
      // The card slides on from where the finger left it, down or back.
      reset();
      if (was.dy > Math.min(160, el.offsetHeight * 0.25) || fast) popSheet();
    };
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', () => { g = null; reset(); });
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

  // Which rules make a line, how its days and dates are said, and the order:
  // public/shared/timetable-lines.js, which the Worker's first paint of this
  // card reads too.
  const TL = window.AgoraTimetableLines;
  /**
   * "on a break, back Sun 10 Jan · Christmas break": a rule on a break today
   * says when it runs again (app.js scheduleBreakLine), from the projection's
   * own arithmetic, so the timetable never promises a service that is off.
   */
  function ruleBreak(r) {
    const t = todayKey();
    const b = window.agoraBundle.breaks().find(x => (x.schedule_id != null ? String(x.schedule_id) === String(r.id) : x.parish_id === r.parish_id)
      && t >= x.from_date && t <= x.to_date);
    if (!b) return '';
    const back = window.agoraBundle.nextOccurrenceAfterBreak(r, t);
    return `on a break, ${back ? `back ${shortDate(back)}` : 'no return date set'}${b.note ? ` · ${b.note}` : ''}`;
  }
  /** The app's Evening divider: its moon and the word, as faint as a day's name. */
  const MOON = '<svg class="moon" viewBox="0 0 10 10" width="10" height="10" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M8.5,5 A3.5,3.5 0 1,0 1.5,5 A3.5,3.5 0 1,0 8.5,5Z M9.1,4.5 A2.9,2.9 0 1,0 3.3,4.5 A2.9,2.9 0 1,0 9.1,4.5Z"/></svg>';
  const EVENING = `<div class="eve">${MOON}<span>Evening</span></div>`;
  const isEvening = (row) => TL.isEvening(row);
  /** A parish's colour where it marks the parish: its jurisdiction's, lifted in the dark. */
  const parishColor = (p) => shown(jColor(p ? p.jurisdiction : null));

  /**
   * A parish's week. `edit`: whoever may change the timetable gets a pencil
   * on each line. `only` keeps the lines that answer those filters, as a
   * collection's card has them (/services is its services); `focus` dims the
   * ones that do not, as a parish's own card has them (/sgr/talk).
   */
  function timetable(pid, { compact = false, edit = false, only = null, focus = null } = {}) {
    // One week, as the app's timetable reads: the morning's services, then
    // the evening's under the moon, each from Sunday; the roundels say which kind.
    const rules = rulesOf(pid).filter(r => liveRule(r) && (!only || rowAnswers(r, only, true)));
    if (!rules.length) return '';
    const byId = new Map(rules.map(r => [r.id, r]));
    const ls = TL.linesOf(rules, { today: todayKey(), offOf: ruleBreak });
    const eve = ls.findIndex(l => l.evening);
    const line = (l) => {
      const { q, range, off } = l;
      const langs = !compact && window.AgoraTimetable.serviceLangs(l.r);
      const asked = (only && only.lang) || (focus && focus.lang);
      const dim = focus && !l.ids.some(id => rowAnswers(byId.get(id), focus, true));
      return `<div class="tt-line${dim ? ' dim' : ''}">
          <span class="tt-days">${esc((q ? q + ' ' : '') + TL.dayList(l.days))}</span>
          ${timeHTML(l.r.start_time)}
          <span class="tt-what">${roundel(l.r.event_type)}<span class="tt-title">${esc(l.r.title)}${langBadge(langs, asked) ? `<span class="tt-lang">${esc(langs.map(window.AgoraLanguages.shortOf).join(', '))}</span>` : ''}${range ? `<span class="tt-range">${esc(range)}</span>` : ''}${off ? `<span class="tt-range tt-break">${esc(off)}</span>` : ''}</span></span>
          ${edit ? `<button class="tt-edit" type="button" data-edit-rules="${esc(l.ids.join(','))}" aria-label="${esc(`Edit ${l.r.title}`)}">${I.pencil}</button>` : ''}
        </div>`;
    };
    const out = ls.map((l, i) => (i === eve ? EVENING : '') + line(l));
    return `<div class="tt${compact ? ' compact' : ''}${edit ? ' editing' : ''}" style="--pc:${parishColor(S.byId.get(pid))}">${out.join('')}</div>`;
  }
  function nextOf(pid, pred = () => true) {
    const now = Date.now();
    return feedFor(14).find(e => Date.parse(e.start_utc) > now && eventParishIds(e).includes(pid) && visible(e) && pred(e)) || null;
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
    // A 403 is Access letting the request through and admin_roles not: signed
    // in, with no role. Favourites still go to the account (syncSaved), which
    // also says who it is.
    const noRole = !!ping && ping.status === 403;
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
    syncAccount();
    // A card drawn before the answer came was drawn for a visitor.
    if (S.who.signedIn) repaintSheets();
    return who || noRole;
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
  /**
   * The header's account button and the dock's, with the red dot while
   * something waits (the app's .account-dot), and the faint line at the
   * header's left: who is signed in, or what the site is.
   */
  function syncAccount() {
    const w = waiting();
    const label = !S.who.signedIn ? 'Sign in' : w ? `Account: ${w}` : 'Account';
    for (const btn of $$('[data-account]')) {
      btn.classList.toggle('signed-in', S.who.signedIn);
      btn.querySelector('.account-dot').hidden = !(S.who.signedIn && w);
      btn.setAttribute('aria-label', label);
      btn.title = label;
    }
    const who = $('#top-who');
    if (who) {
      who.textContent = S.who.signedIn && S.who.identity ? S.who.identity : 'Eastern Orthodox events & parishes';
      who.classList.toggle('signed-in', !!(S.who.signedIn && S.who.identity));
    }
  }
  // Signing in is a redirect Cloudflare owns: /admin is behind Access, so going
  // there is what shows its sign-in, and signing out is its own logout path.
  function openAccount(btn) {
    const w = waiting();
    const rows = S.who.signedIn
      ? `${S.who.identity ? `<div class="pm-note">${esc(S.who.identity)}</div>` : ''}
         ${S.who.role ? `<a class="pm-row" role="menuitem" href="/admin">${I.sliders}<span class="pm-t"><b>Admin panel</b>${w ? `<small class="pm-wait">${esc(w)}</small>` : ''}</span></a>` : ''}
         <a class="pm-row" role="menuitem" href="/cdn-cgi/access/logout">${I.signOut}<span class="pm-t"><b>Sign out</b></span></a>`
      : `<a class="pm-row" role="menuitem" href="/admin">${I.signIn}<span class="pm-t"><b>Sign in</b></span></a>`;
    openMenu(btn, rows);
  }

  // ── Menus ─────────────────────────────────────────────────────────────
  //
  // The account's and a card's ⋯: a little menu out of the button tapped,
  // as Apple's are, not a card up from the bottom. A tap anywhere else, a
  // scroll or Escape puts it away; a second tap on its button too.

  let menu = null;
  function closeMenu() {
    if (!menu) return;
    const el = menu;
    menu = null;
    el._btn.setAttribute('aria-expanded', 'false');
    el.classList.add('out');
    setTimeout(() => el.remove(), 140);
  }
  /** A menu of `rows` out of `btn`: under it, or above it where it sits low (a card's toolbar). */
  function openMenu(btn, rows) {
    closeMenu();
    const el = document.createElement('div');
    el.className = 'popmenu';
    el.setAttribute('role', 'menu');
    el.innerHTML = rows;
    document.body.appendChild(el);
    const r = btn.getBoundingClientRect();
    const up = r.top > window.innerHeight / 2;
    // Its right edge on the button's, kept on the screen.
    const right = Math.max(10, Math.min(window.innerWidth - r.right, window.innerWidth - el.offsetWidth - 10));
    el.style.right = `${right}px`;
    if (up) el.style.bottom = `${window.innerHeight - r.top + 8}px`;
    else el.style.top = `${r.bottom + 8}px`;
    // It grows out of the button: its origin at the button's middle.
    const fromRight = window.innerWidth - right - (r.left + r.width / 2);
    el.style.transformOrigin = `${Math.round(el.offsetWidth - Math.max(0, fromRight))}px ${up ? '100%' : '0'}`;
    el._btn = btn;
    btn.setAttribute('aria-expanded', 'true');
    menu = el;
  }
  // Any scroll, the page's or a card's.
  document.addEventListener('scroll', closeMenu, { capture: true, passive: true });
  window.addEventListener('resize', closeMenu);

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

  // The foot of the page's "Become an editor" (index.html): the same form,
  // asking which parish first (those in view, then each jurisdiction's),
  // with "Add me as a permanent editor" ticked and "Something else" chosen
  // (Kevin, 27 Oct 2026). The only parish in view is chosen already.
  function becomeEditor() {
    const ps = S.parishes.filter(p => p.id !== '_unassigned');
    if (!ps.length || !window.AgoraSuggest) return;
    const byName = (a, b) => String(a.name).localeCompare(String(b.name));
    const seen = S.inView && S.inView.size < ps.length ? ps.filter(p => S.inView.has(p.id)).sort(byName) : [];
    const rest = ps.filter(p => !seen.includes(p));
    const parishes = [
      { label: 'In view', parishes: seen },
      ...JURIS_ORDER.map(j => ({ label: JURIS[j].long, parishes: rest.filter(p => p.jurisdiction === j).sort(byName) })),
      { label: 'Other', parishes: rest.filter(p => !JURIS[p.jurisdiction]).sort(byName) },
    ].filter(g => g.parishes.length);
    window.AgoraSuggest.open({ title: 'Become an editor', parishes, parishId: seen.length === 1 ? seen[0].id : null, about: 'Something else', editor: true });
  }
  // The directories the parishes were read from (docs/parish-ingestion.md),
  // each by its jurisdiction, for the Disclaimer.
  const DIRECTORIES = [
    ['Greek Orthodox Archdiocese of Australia', 'https://greekorthodox.org.au/churches/'],
    ['Antiochian Orthodox Archdiocese of Australia, New Zealand & the Philippines', 'https://www.antiochian.org.au/'],
    ['Serbian Orthodox Metropolitanate of Australia & New Zealand', 'https://soc.org.au/web-links/parishes-of-the-metropolitanate-of-australia-and-new-zealand/'],
    ['Russian Orthodox Church Outside Russia, Diocese of Australia & New Zealand', 'https://rocor.org.au/2-directories/directory/',
      'Hard to reach at the moment. Addresses also from orthodox-world.org.'],
    ['Romanian Orthodox Diocese of Australia & New Zealand', 'https://roeanz.com.au/harta-parohiilor'],
    ['Macedonian Orthodox Diocese of Australia & New Zealand', 'https://www.mocdanz.org.au/'],
    ['Macedonian Orthodox Diocese of Australia–Sydney', 'https://www.macedonianorthodoxdiocese.org.au/'],
  ];
  /** The foot's Disclaimer, a card of its own (Kevin's words, 27 Oct 2026). */
  function openDisclaimer() {
    const site = (u) => new URL(u).host.replace(/^www\./, '');
    pushSheet(`<div class="lay-head"><h2>Disclaimer</h2><button class="gbtn" type="button" data-act="close" aria-label="Close">${I.x}</button></div>
      <div class="sheet-scroll">
        <p class="lay-note">Best efforts have been made to aggregate canonical Eastern Orthodox parishes, groups, and associations in Oceania. I read from archdiocesan and jurisdictional directories. Call the parish if you’re unsure of times!</p>
        <p class="lay-note">orthodoxy.au is run by volunteers and does not speak for any jurisdiction.</p>
        <ul class="disc-list">${DIRECTORIES.map(([name, url, note]) => `<li>${esc(name)}
          <a href="${esc(url)}" target="_blank" rel="noopener">${esc(site(url))}</a>${note ? `<small>${esc(note)}</small>` : ''}</li>`).join('')}</ul>
      </div>`, 'mini');
  }

  /** "Updated 3 months ago · Antiochian Archdiocese ↗", as the app has it. */
  const timesSource = (pid) => window.AgoraSourceLine.timetableSourceHTML(rulesOf(pid).filter(liveRule), { cls: 'src-line' });
  const detailsSource = (p) => window.AgoraSourceLine.detailsSourceHTML(p, { cls: 'src-line' });

  // ── The parish card ───────────────────────────────────────────────────

  // Coming up: this parish's days, from today or from a date picked, a
  // fortnight at a time. The date is in the card's link.
  const CU_DAYS = 14;
  function comingUpHTML(pid, from, days, focus = null, panel = false) {
    const p = S.byId.get(pid);
    const start = from || todayKey();
    const now = Date.now();
    const list = feedRange(start, days).filter(e => (visible(e) || tombOf(e)) && eventParishIds(e).includes(pid) && endMs(e) > now);
    const body = daysHTML(list, { start, days, row: { here: pid, focus }, linkFor: (k) => pathOf(segsFor({ parish: p, focus, from: k })) });
    const n = focusCount(focus);
    const filters = `<button class="fpill fbtn" type="button" data-card-filters aria-expanded="${panel}">${I.filters}<span>Filters</span>${n ? `<span class="fcount-card">${n}</span>` : ''}</button>`;
    return `${datePickHTML('card', from, filters)}
      ${panel ? cardPanelHTML(pid, focus) : ''}
      ${body || '<div class="tt-none sm">Nothing on file for these days.</div>'}
      ${MORE(days)}`;
  }
  // The foot of a Coming up, which brings the next fortnight as it scrolls into view.
  const MORE = (days) => days < 365 ? '<div class="more-days" data-more-days>Loading…</div>' : '';
  /** A card's Coming up grows as its foot comes into view (moreIO). */
  function watchMore(el) {
    const m = el.querySelector('[data-more-days]');
    if (m) moreIO.observe(m);
  }
  async function refreshComingUp(el) {
    const box = el.querySelector('.cu');
    if (!box) return;
    try { await ensureLoaded(addDays(el._from || todayKey(), el._days)); } catch (err) { console.warn(err); }
    const m = box.querySelector('[data-more-days]');
    if (m) moreIO.unobserve(m);
    box.innerHTML = el._coll ? collFeedHTML(el._coll, el._days, el._from) : comingUpHTML(el.dataset.pid, el._from, el._days, el._focus, !!el._fpanel);
    watchMore(el);
  }
  /** The card's days from a date, or from today again. The card's link says which. */
  function setCardDate(el, k) {
    el._from = k && k > todayKey() ? k : null;
    el._days = CU_DAYS;
    const c = el._coll;
    // A collection with no link of its own (In view) has no date to put in one.
    if (c && !c.segs) { refreshComingUp(el); return; }
    el._segs = c ? collSegs(c, el._from) : segsFor({ parish: S.byId.get(el.dataset.pid), focus: el._focus, from: el._from });
    const link = el.querySelector('.sheet-link');
    if (link) { link.innerHTML = linkChip(el._segs); fitLinks(link); }
    syncURL();
    refreshComingUp(el);
  }

  function timesHTML(p, focus = null) {
    const hasTimes = rulesOf(p.id).some(liveRule);
    return `${hasTimes ? timetable(p.id, { edit: may('schedule.edit', p.id), focus }) : `<div class="tt-none">No service times on file yet.${p.website ? ` The parish website is the best place to check.` : ''}</div>`}
      ${timesSource(p.id)}
      ${addBox(SUGGEST.service, 'Add a service time')}`;
  }
  /**
   * What's on at a parish: the page's shelf (renderWhatsOn) kept to this
   * parish, under its timetable. The things that happen once, poster first;
   * its name is the card's, so a poster says whose only when it is another
   * parish's. None, no section.
   */
  function parishWhatsOnHTML(pid) {
    const raw = window.agoraBundle.raw;
    if (!raw) return '';
    const now = Date.now();
    const pool = feedFor(21)
      .concat((raw.events || []).filter(e => Date.parse(e.start_utc) > now + 21 * DAY))
      .filter(e => e.poster_path && visible(e) && endMs(e) > now && !['liturgy', 'prayer'].includes(e.event_type) && eventParishIds(e).includes(pid));
    const seen = new Set();
    const list = pool.filter(e => {
      const k = e.schedule_id ? `r${e.schedule_id}` : `e${e.id}`;
      if (seen.has(k)) return false; seen.add(k); return true;
    }).sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc)).slice(0, 12);
    if (!list.length) return '';
    const cards = list.map(e => {
      const host = e.parish_id !== pid ? S.byId.get(e.parish_id) : null;
      return `<button class="poster" type="button" data-event="${esc(e.id)}">
          <span class="pimg"><img src="${esc(e.poster_path)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('noimg')"></span>
          <span class="ptext"><span class="pkicker">${esc(kindLabel(e.event_type))} · ${esc(whenShort(e))}</span><span class="ptitle">${esc(e.title)}</span>
            ${host ? `<span class="pfrom">${avatar(host, 'xs')}<span>${esc(host.name)}</span></span>` : ''}</span>
        </button>`;
    }).join('');
    return `<h2 class="sec">What's on</h2><div class="shelf-row">${cards}</div>`;
  }
  function detailsHTML(p) {
    // For whoever may change them, the heading's pencil (next/editing.js editDetails).
    const pen = may('parish.edit', p.id)
      ? `<button class="tt-edit" type="button" data-edit-details="${esc(p.id)}" aria-label="Edit details">${I.pencil}</button>` : '';
    return `<h2 class="sec${pen ? ' sec-row' : ''}"><span>Details</span>${pen}</h2>
      <div class="details">
        ${p.phone ? `<div class="drow"><small>Phone</small><a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">${esc(p.phone)}</a></div>` : ''}
        ${p.website ? `<div class="drow"><small>Website</small><a href="${esc(p.website)}" target="_blank" rel="noopener">${esc(p.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a></div>` : ''}
        ${p.email ? `<div class="drow"><small>Email</small><a href="mailto:${esc(p.email)}">${esc(p.email)}</a></div>` : ''}
        ${p.address ? `<div class="drow"><small>Address</small><span>${esc(p.address)}</span></div>` : ''}
        ${p.feast_day ? `<div class="drow"><small>Feast day</small><span>${esc(p.feast_day)}</span></div>` : ''}
      </div>
      ${detailsSource(p)}`;
  }
  /** Next, languages, jurisdiction: the line under a parish's buttons. Nothing next, no Next. */
  function summaryHTML(p) {
    const nextLit = nextOf(p.id, e => e.event_type === 'liturgy') || nextOf(p.id);
    const langs = parishLangs(p);
    return [
      nextLit ? `<div class="sum"><small>Next ${esc(kindLabel(nextLit.event_type))}</small><b class="ok">${summaryWhen(nextLit)}</b></div>` : '',
      // What its services are tagged with; none tagged, no box.
      langs.length ? `<div class="sum"><small>Languages</small><b>${esc(langs.slice(0, 2).join(' · '))}</b></div>` : '',
      // The jurisdiction says itself in its colour, as its tab does, and opens
      // its collection, as More's "More … parishes" does.
      `<button class="sum sum-link" type="button" data-act="juris-of"><small>Jurisdiction</small><b style="color:${parishColor(p)}">${esc(JURIS[p.jurisdiction]?.short || p.jurisdiction)}${I.chev}</b></button>`,
    ].join('');
  }
  /** The card's top: its logo, its names and where it is. */
  function parishTopHTML(p) {
    const d = distOf(p);
    return `${avatar(p, 'xl')}
      <div class="ph-text"><h1>${esc(p.full_name || p.name)}</h1><p>${esc(p.address || '')}${d != null ? ` <span class="ph-dist dist ${distClass(d)}">${esc(fmtKm(d))}</span>` : ''}${favCountHTML(p.id)}</p></div>`;
  }
  // How many signed-in people starred a parish (worker saved-items.mjs
  // favouriteCount), beside its distance. Asked once per parish a visit and
  // kept; this browser's own star moves it at once rather than waiting on the
  // send. Nobody yet, no star.
  const favCounts = new Map();
  function favCountHTML(pid) {
    const n = favCounts.get(pid);
    return n ? ` <span class="ph-favs" title="Favourited by ${n} ${n === 1 ? 'person' : 'people'}" aria-label="Favourited by ${n} ${n === 1 ? 'person' : 'people'}">${I.starOn}<b>${n}</b></span>` : '';
  }
  async function loadFavCount(pid) {
    if (favCounts.has(pid)) return;
    favCounts.set(pid, 0);
    const res = await fetch(`/api/parishes/${encodeURIComponent(pid)}/favourites`, { cache: 'no-store' }).catch(() => null);
    const got = res && res.ok ? await res.json().catch(() => null) : null;
    if (!got || !(got.count > 0)) return;
    favCounts.set(pid, got.count);
    paintFavCount(pid);
  }
  function paintFavCount(pid) {
    for (const el of document.querySelectorAll(`[data-pid="${CSS.escape(pid)}"] .ph`)) {
      const p = S.byId.get(pid);
      if (p) el.innerHTML = parishTopHTML(p);
    }
  }
  /**
   * Where Google Maps opens: the parish's own place there, where somebody
   * picked one, else its pin — the place, never directions to it, as the
   * Worker's card has it (lite-page.mjs mapsHref).
   */
  const pinHref = (lat, lng) => (lat != null && lng != null && isFinite(lat) && isFinite(lng) ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` : '');
  const mapsHref = (p) => (p ? p.maps_url || pinHref(p.lat, p.lng) : '');
  /** A parish's own links (parish_links), named by their label: a festival, a building fund. */
  const parishLinks = (pid) => ((window.agoraBundle.raw && window.agoraBundle.raw.parish_links) || []).filter(l => l.parish_id === pid && l.url);
  /**
   * Google Maps, then whatever the parish has: a phone, a website, a live
   * stream, a way to donate. More than fit scroll sideways, as Maps' do. Its
   * own links are smaller, under these (linksHTML).
   */
  function actionsHTML(p) {
    const gmaps = mapsHref(p);
    const out = (href, icon, label) => `<a class="abtn" href="${esc(href)}" target="_blank" rel="noopener">${icon}<span>${esc(label)}</span></a>`;
    return `${gmaps ? `<a class="abtn primary" href="${esc(gmaps)}" target="_blank" rel="noopener">${I.place}<span>Google Maps</span></a>` : ''}
      ${p.phone ? `<a class="abtn" href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">${I.phone}<span>Call</span></a>` : ''}
      ${p.website ? out(p.website, I.globe, 'Website') : ''}
      ${p.live_url ? out(p.live_url, I.live, 'Watch live') : ''}
      ${p.donation_url ? out(p.donation_url, I.heart, 'Donate') : ''}`;
  }
  /** A parish's own links (a festival, a youth group's Instagram), as small buttons, or ''. */
  function linksHTML(p) {
    return parishLinks(p.id).map(l => `<a class="lbtn" href="${esc(l.url)}" target="_blank" rel="noopener">${I.link}<span>${esc(l.label || l.slug)}</span></a>`).join('');
  }
  /**
   * An open card again, from the bundle as it now is, where it was scrolled
   * to. A parish that has gone (deleted) takes its card with it.
   */
  function repaintParish(el) {
    const p = S.byId.get(el.dataset.pid);
    if (!p) {
      if (stack[stack.length - 1] === el) popSheet();
      return;
    }
    // Its names, logo, link and buttons, which an edit to its details changes.
    const bar = el.querySelector('.gtitle');
    if (bar) bar.innerHTML = `<b>${esc(p.name)}</b>${JURIS[p.jurisdiction]?.long ? `<small>${esc(JURIS[p.jurisdiction].long)}</small>` : ''}`;
    const top = el.querySelector('.ph');
    if (top) top.innerHTML = parishTopHTML(p);
    const acts = el.querySelector('.actions');
    if (acts) acts.innerHTML = actionsHTML(p);
    const own = el.querySelector('.p-links');
    if (own) { own.innerHTML = linksHTML(p); own.hidden = !own.innerHTML; }
    el._segs = segsFor({ parish: p, focus: el._focus, from: el._from });
    const link = el.querySelector('.sheet-link');
    if (link) { link.innerHTML = linkChip(el._segs); fitLinks(link); }
    el.style.setProperty('--j', jColor(p.jurisdiction));
    const sum = el.querySelector('.summary');
    if (sum) sum.innerHTML = summaryHTML(p);
    paintParishToday(el);
    const times = el.querySelector('.p-times'), details = el.querySelector('.p-details');
    if (times) times.innerHTML = timesHTML(p, el._focus);
    const on = el.querySelector('.p-whatson');
    if (on) { on.innerHTML = parishWhatsOnHTML(p.id); on.hidden = !on.innerHTML; }
    if (details) details.innerHTML = detailsHTML(p);
    const sug = el.querySelector('.p-suggest');
    if (sug) sug.innerHTML = suggestEditHTML(p.id);
    refreshComingUp(el);
  }

  /**
   * A parish's Today, above its timetable: what is on there now and later,
   * as the page's. With a focus (/sgr/talk) it lights the next that answers
   * it, under that day's name when it is not today, and dims the rest.
   */
  function parishTodayHTML(pid, focus, next) {
    const all = feedFor(2).filter(e => eventParishIds(e).includes(pid) && visible(e));
    return todayHTML(all, { here: pid, focus, next, clear: focus ? focusLabel(focus) : '' });
  }
  /** The next event at a parish that answers its card's focus, a season ahead at most. */
  async function nextLit(pid, focus) {
    const now = Date.now();
    const find = (days) => feedRange(todayKey(), days).find(e => Date.parse(e.start_utc) > now && eventParishIds(e).includes(pid) && visible(e) && rowAnswers(e, focus, false)) || null;
    const near = find(CU_DAYS);
    if (near) return near;
    try { await ensureLoaded(addDays(todayKey(), 120)); } catch (err) { console.warn(err); }
    return find(120);
  }
  /** A card's Today again: its focus's next, which may be further out than the bundle had. */
  function paintParishToday(el) {
    const box = el.querySelector('.ptoday');
    if (!box) return;
    const pid = el.dataset.pid, focus = el._focus;
    box.innerHTML = parishTodayHTML(pid, focus, null);
    box.hidden = !box.innerHTML;
    if (!focus) return;
    const ask = el._todayAsk = {};
    nextLit(pid, focus).then(next => {
      if (el._todayAsk !== ask || !el.isConnected) return;
      box.innerHTML = parishTodayHTML(pid, focus, next || 'none');
    });
  }
  /** "Talks", "Liturgies on Wednesdays", "Evening services in English": what a focus asks. */
  function focusLabel(x) {
    const SV = window.AgoraServices;
    const sub = { youth: 'Youth groups', social: 'Social gatherings', 'bible-study': 'Bible studies' };
    // A sub-kind that is a service too (/sun/liturgy's Liturgy) is said as one: "Liturgies".
    const noun = (x.service && SV.servicePlural(x.service))
      || (x.kindSub ? sub[x.kindSub] || (SV.resolveService(x.kindSub) ? SV.servicePlural(x.kindSub) : `${kindLabel(x.kindSub)} services`) : null)
      || KIND_NAMES[x.kind] || 'Services';
    const text = (x.part ? `${x.part} ${noun.toLowerCase()}` : noun) + window.AgoraLinkWords.daysPhrase(x)
      + (x.lang ? (x.langStrict ? ` in ${x.lang} only` : ` in ${x.lang}`) : '');
    // A link's words, as typed: “disco”, or Saturday services matching “disco”.
    const said = x.words ? `“${window.AgoraSearch.phraseOf(x.words)}”` : '';
    if (said && !(x.kind || x.service || x.kindSub || x.day != null || x.dayGroup || x.part || x.lang)) return said;
    return text.charAt(0).toUpperCase() + text.slice(1) + (said ? ` matching ${said}` : '');
  }
  // ── A parish card's Filters, beside Pick a date ───────────────────────
  //
  // What the page's panel asks of a service (what, which language, when),
  // asked of one parish: the card's focus, as a link to it would set it
  // (/sgr/talks), lighting what answers and dimming the rest, its link
  // following. Only what the parish has is offered.

  /** How many things a focus asks: each day its own, as the page's count has them. */
  const focusCount = (x) => (x ? window.AgoraServices.daysOf(x.day).length + [x.kind, x.service, x.dayGroup, x.part, x.lang, x.words].filter(Boolean).length : 0);
  function cardPanelHTML(pid, focus) {
    const f = { ...blankFilters(), ...(focus || {}) }, SV = window.AgoraServices;
    const p = S.byId.get(pid);
    // What it holds: its running services, and what is on file from today.
    const rows = [...rulesOf(pid).filter(liveRule).map(r => [r, true]),
      ...feedRange(todayKey(), CU_DAYS).filter(e => visible(e) && eventParishIds(e).includes(pid)).map(e => [e, false])];
    const has = (x) => rows.some(([r, isRule]) => whatMatches(r, { ...blankFilters(), ...x }, isRule));
    const group = (label, ...lines) => `<div class="frow" role="group" aria-label="${label}">${lines.filter(Boolean).join('<span class="fbreak"></span>')}</div>`;
    const langs = parishLangs(p);
    const langPills = langs.length > 1 ? langs.map(l => fpill('card:lang', l, f.lang === l, esc(l))
      + (f.lang === l ? fpill('card:langStrict', '1', f.langStrict, 'only', ' fpill-only') : '')).join('') : '';
    const days = `<span class="fdays">${WD.map((d, i) => fpill('card:day', i, SV.daysOf(f.day).includes(i), d)).join('')}</span>`;
    const spans = SV.DAY_GROUPS.map(g => fpill('card:dayGroup', g.slug, f.dayGroup === g.slug, esc(g.label))).join('');
    const parts = SV.PARTS_OF_DAY.map(pt => fpill('card:part', pt.slug, f.part === pt.slug, esc(pt.label))).join('');
    return `<div class="filter-panel card-fpanel" role="group" aria-label="Filters">
        ${group('What', ...kindLines(f, SV, 'card:', has))}${langPills ? group('Language', langPills) : ''}${group('When', days, spans, parts)}
        <div class="fpanel-foot">${focusCount(focus) ? '<button class="fpill fpill-ghost" type="button" data-act="card-filters-clear">Clear all</button>' : '<span></span>'}
          <button class="fpill on" type="button" data-act="card-filters-done">Done</button></div>
      </div>`;
  }
  /** A card's focus as it now is: its link, its lit and dimmed rows, its Today. */
  function setCardFocus(el, focus) {
    el._focus = focus;
    el._segs = segsFor({ parish: S.byId.get(el.dataset.pid), focus, from: el._from });
    const link = el.querySelector('.sheet-link');
    if (link) { link.innerHTML = linkChip(el._segs); fitLinks(link); }
    syncURL();
    repaintParish(el);
  }
  /** One of a card's pills tapped. */
  function setCardFilter(el, k, v) {
    const f = { ...blankFilters(), ...(el._focus || {}) };
    if (flipWhat(f, k, v)) setCardFocus(el, focusOf(f));
  }
  /** Light everything at a card again: /sgr/talk becomes /sgr. */
  function unfocusCard(el) { setCardFocus(el, null); }

  // ── A parish link that asks something (/sgr/talks, /sgr/wed/liturgy) ──
  //
  // It opens the first that answers, an event's card in front of the
  // parish's own, plain card, so a step back (or the card's Parish) is the
  // parish. Under the event, the others that answer, a season ahead at most.
  // The card's link is the one followed. With none on file, the parish's
  // card is all there is, as if the link had named only the parish.

  const MATCH_DAYS = 120;
  const MATCH_CAP = 10;
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  /** What answers a parish link, from its date to as far as the bundle holds, a season at most. */
  function matchesAt({ pid, focus, from }) {
    const start = from || todayKey();
    const last = [addDays(start, MATCH_DAYS), S.loadedTo || todayKey()].sort()[0];
    if (last < start) return [];
    const now = Date.now();
    return feedRange(start, daysBetween(start, last) + 1).filter(e => eventParishIds(e).includes(pid)
      && (visible(e) || tombOf(e)) && endMs(e) > now && rowAnswers(e, focus, false));
  }
  const matchSegs = (m) => segsFor({ parish: S.byId.get(m.pid), focus: m.focus, from: m.from });
  async function openMatch(pid, focus, { entry = true, from = null } = {}) {
    openParish(pid, { entry, from, focus: null });
    const under = stack[stack.length - 1];
    if (!under || under.dataset.pid !== pid) return;
    const match = { pid, focus, from };
    let e = matchesAt(match).find(visible);
    if (!e) {
      try { await ensureLoaded(addDays(from || todayKey(), MATCH_DAYS)); } catch (err) { console.warn(err); }
      // Closed meanwhile, or something opened over it.
      if (stack[stack.length - 1] !== under) return;
      e = matchesAt(match).find(visible);
    }
    if (e) openEvent(e.id, { entry, match });
  }
  /** "More talks", "More liturgies on Wednesdays": what else answers, under the first. */
  function matchFeedHTML(m, id) {
    const list = matchesAt(m).filter(e => String(e.id) !== String(id)).slice(0, MATCH_CAP);
    if (!list.length) return '';
    const label = focusLabel(m.focus);
    const start = local(list[0]).date;
    const days = daysBetween(start, local(list[list.length - 1]).date) + 1;
    return `<section class="cu-band ev-more">
        <h2 class="sec">More ${esc(/^Bible\b/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1))}</h2>
        <div class="cu" style="--pc:${parishColor(S.byId.get(m.pid))}">${daysHTML(list, { start, days, row: { here: m.pid, focus: m.focus } })}</div>
      </section>`;
  }

  function openParish(pid, { entry = true, from = null, focus } = {}) {
    const p = S.byId.get(pid);
    if (!p) return;
    // A link says its own (/sgr/talk, or none at /sgr); a tap takes where it was.
    if (focus === undefined) focus = focusAround();
    const segs = segsFor({ parish: p, focus, from });
    const won = parishWhatsOnHTML(pid);
    const html = `${glassBar(p.name, JURIS[p.jurisdiction]?.long)}
      <div class="sheet-scroll">
        <div class="ph">${parishTopHTML(p)}</div>
        <div class="sheet-link">${linkChip(segs)}</div>
        <div class="actions">${actionsHTML(p)}</div>
        <div class="p-links"${linksHTML(p) ? '' : ' hidden'}>${linksHTML(p)}</div>
        <div class="summary">${summaryHTML(p)}</div>
        <section class="today card ptoday" aria-label="Today" style="--pc:${parishColor(p)}"></section>
        <div class="p-details">${detailsHTML(p)}</div>
        <div class="p-suggest">${suggestEditHTML(pid)}</div>
        <h2 class="sec">Timetable</h2>
        <div class="p-times">${timesHTML(p, focus)}</div>
        <section class="p-whatson"${won ? '' : ' hidden'}>${won}</section>
        <!-- What is coming up changes; the timetable above is the parish's for good. -->
        <section class="cu-band">
          <h2 class="sec">Coming up</h2>
          <div class="cu" style="--pc:${parishColor(p)}">${comingUpHTML(pid, from, CU_DAYS, focus)}</div>
          ${addBox(SUGGEST.event, 'Add an event')}
        </section>
        <div class="toolbar-space"></div>
      </div>
      <div class="floatbar" role="toolbar">
        <button type="button" data-act="addevent" aria-label="${may('event.edit', pid) ? 'Add an event' : 'Suggest an event'}">${I.plus}</button>
        <button type="button" data-act="fav" class="${isFav(pid) ? 'on' : ''}" aria-label="Favourite" aria-pressed="${isFav(pid)}">${isFav(pid) ? I.starOn : I.star}</button>
        <button type="button" data-act="more" aria-label="More" aria-haspopup="menu" aria-expanded="false">${I.more}</button>
      </div>`;
    const el = pushSheet(html, 'parish', { segs, entry });
    el.dataset.pid = pid;
    el._from = from;
    el._focus = focus;
    el._days = CU_DAYS;
    watchMore(el);
    paintParishToday(el);
    loadFavCount(pid);
    // A date further out than the bundle holds fills in once it has it.
    if (from) refreshComingUp(el);
    el.style.setProperty('--j', jColor(p.jurisdiction));
    setMapFocus(pid);
    // Bring it into the viewport without zooming the page's scope away.
    if (map && isFinite(p.lat) && !map.getBounds().contains([p.lng, p.lat])) map.easeTo({ center: [p.lng, p.lat], duration: 500 });
  }

  // ── A collection's card: a bunch of parishes, with their timetables ───
  //
  // The timetables folded to the first few lines of the first, under a fade,
  // with Show timetables to open them all; under them, what is coming up at
  // these parishes, by the collection's own filters. The fold is a checkbox
  // in its label (next.css .ctimes), so the Worker's first paint of the card
  // opens the same way with no script (worker/lib/page-card.mjs).

  /** Is this event at one of a collection's parishes, and does it answer its filters? */
  function inCollection(c) {
    const ids = new Set(c.ids);
    const f = { ...blankFilters(), ...(c.f || {}) };
    return (e) => eventParishIds(e).some(id => ids.has(id)) && eventMatches(e, f, c.juris || null);
  }
  /** A collection's link, from a date when one is picked. */
  const collSegs = (c, from) => from ? segsFor({ juris: c.juris || null, f: { ...blankFilters(), ...(c.f || {}) }, from }) : c.segs;
  /** What is on at a collection's parishes, by its filters, from today or a date, a fortnight at a time. */
  function collFeedHTML(c, days, from = null) {
    const start = from || todayKey();
    const now = Date.now();
    const f = { ...blankFilters(), ...(c.f || {}) };
    const list = feedRange(start, days).filter(e => endMs(e) > now).filter(inCollection(c));
    // A day's link, where the collection has one of its own.
    const linkFor = c.segs ? (k) => pathOf(collSegs(c, k)) : null;
    const body = daysHTML(list, { start, days, linkFor, row: { lang: f.lang } });
    return `${datePickHTML('card', from)}
      ${body || '<div class="tt-none sm">Nothing on file for these days.</div>'}
      ${MORE(days)}`;
  }
  const foldHTML = () => `<label class="ctimes-open"><input type="checkbox" hidden><span>Show timetables</span>${I.chev}</label>`;

  function openCollection(c, { entry = true, from = null } = {}) {
    const o = sortOrigin();
    // What the collection asks of a parish's services (/services, /sun/liturgy,
    // /en), its timetables and its Next keep to; /greek and /monasteries ask nothing.
    const cf = { ...blankFilters(), ...(c.f || {}) };
    const only = asksWhat(cf) || cf.lang ? cf : null;
    // Asked something, every parish here answers it, by its timetable or a
    // one-off, so they are one list by distance (Kevin, 29 Oct 2026). Asked
    // nothing (/greek, a list), the parishes with times come first.
    const near = (a, b) => (o ? km(o, a) - km(o, b) : a.name.localeCompare(b.name));
    const ps = c.ids.map(id => S.byId.get(id)).filter(Boolean)
      .sort((a, b) => (only ? 0 : (rulesOf(b.id).some(liveRule)) - (rulesOf(a.id).some(liveRule))) || near(a, b));
    const LIMIT = 30;
    const item = (p) => {
      const d = distOf(p);
      // Its Next is its own, held by it or in its church, before one it only
      // takes part in; and a one-off that puts it here may be months off,
      // past nextOf's fortnight.
      const answers = (e) => rowAnswers(e, only, false);
      const nx = !only ? nextOf(p.id)
        : nextOf(p.id, e => (e.parish_id === p.id || e.location_parish_id === p.id) && answers(e))
          || upcomingOneOffs(p.id, { own: true }).find(e => Date.parse(e.start_utc) > Date.now() && answers(e))
          || nextOf(p.id, answers);
      const times = rulesOf(p.id).some(liveRule);
      const tt = times ? timetable(p.id, { compact: true, only }) : '';
      // Its Next says it when it has no lines here: words only for a parish with nothing.
      const none = nx || only ? '' : '<div class="tt-none sm">No service times on file yet.</div>';
      return `<article class="citem">
          <button class="citem-head" type="button" data-parish="${esc(p.id)}">
            ${avatar(p, 'md')}
            <span class="citem-t"><b>${esc(p.name)}</b><small>${esc(JURIS[p.jurisdiction]?.short || '')}${d != null ? ` · ${distHTML(d, 'span')}` : ''}${parishLangs(p).length ? ` · ${esc(parishLangs(p).slice(0, 2).join(', '))}` : ''}</small>
              ${nx ? `<span class="citem-next">${roundel(nx.event_type)} Next: ${esc(nx.title)} · ${esc(whenShort(nx))}</span>` : ''}</span>
          </button>
          <button class="cadd" type="button" data-quickadd="${esc(p.id)}" aria-label="Add to a list">${I.plus}</button>
          ${tt || none}
        </article>`;
    };
    const today = ps.length ? todayHTML(feedFor(2).filter(inCollection(c)), { lang: cf.lang }) : '';
    const html = `${glassBar(c.title, `${ps.length} places`)}
      <div class="sheet-scroll">
        <div ${lookAttrs(c, 'chero')}>
          <span class="ckicker">${esc(c.kicker || '')}</span>
          <h1>${esc(c.title)}</h1>
          <div class="chero-acts">
            <button class="hbtn" type="button" data-act="showmap">${I.map}<span>Show on map</span></button>
            ${c.listId ? '' : `<button class="hbtn" type="button" data-act="savelist">${I.plus}<span>Save as list</span></button>`}
            <button class="hbtn" type="button" data-act="share">${I.share}<span>Share</span></button>
            ${c.listId && c.listId !== 'fav' ? `<button class="hbtn" type="button" data-act="renamelist">${I.pencil}<span>Rename</span></button>
            <button class="hbtn" type="button" data-act="deletelist">${I.x}<span>Delete</span></button>` : ''}
          </div>
          <p>${esc(c.blurb || '')}</p>
        </div>
        ${c.segs ? `<div class="sheet-link">${linkChip(collSegs(c, from))}</div>` : ''}
        ${today ? `<section class="today card ctoday" aria-label="Today">${today}</section>` : ''}
        <section class="ctimes${ps.length > 1 ? ' folded' : ''}">
          <div class="clist">${ps.slice(0, LIMIT).map(item).join('') || '<div class="tt-none">Nothing here yet. Add parishes from their cards with +.</div>'}</div>
          ${ps.length > LIMIT ? `<button class="wide-btn" type="button" data-act="more-items">Show ${ps.length - LIMIT} more</button>` : ''}
          ${ps.length > 1 ? foldHTML() : ''}
        </section>
        ${ps.length ? `<section class="cu-band">
          <h2 class="sec">Coming up</h2>
          <div class="cu">${collFeedHTML(c, CU_DAYS, from)}</div>
        </section>` : ''}
        <div class="toolbar-space"></div>
      </div>`;
    const el = pushSheet(html, 'collection', { segs: (c.segs && collSegs(c, from)) || null, entry });
    el._coll = c;
    el._from = from;
    el._days = CU_DAYS;
    watchMore(el);
    // A date further out than the bundle holds fills in once it has it.
    if (from) refreshComingUp(el);
    // Folded to the first parish's first few lines, however tall its name.
    const tt = el.querySelector('.ctimes.folded .citem .tt');
    if (tt) {
      const list = tt.closest('.clist');
      list.style.setProperty('--fold', `${Math.round(tt.getBoundingClientRect().top - list.getBoundingClientRect().top + Math.min(tt.offsetHeight, 130))}px`);
    }
    el._rest = () => ps.slice(LIMIT).map(item).join('');
  }

  // ── Donate: the parishes that take donations online ───────────────────
  //
  // /donate, and /greek/donate for one jurisdiction's: what the app's picker
  // listed (app.js openDonateDialog), as a card. A parish's own Donate is on
  // its card, and /smg/donate goes straight to its page from the Worker.

  const DONATE_LOOK = { tint: '#be185d' };
  function donateBodyHTML(juris) {
    const o = sortOrigin();
    const all = S.parishes.filter(p => p.donation_url);
    const ps = all.filter(p => !juris || p.jurisdiction === juris)
      .sort((a, b) => (o ? km(o, a) - km(o, b) : a.name.localeCompare(b.name)));
    const tabs = JURIS_ORDER.filter(j => all.some(p => p.jurisdiction === j));
    const item = (p) => {
      const d = distOf(p);
      return `<article class="citem">
          <button class="citem-head" type="button" data-parish="${esc(p.id)}">${avatar(p, 'md')}
            <span class="citem-t"><b>${esc(p.name)}</b><small>${esc(JURIS[p.jurisdiction]?.short || '')}${d != null ? ` · ${distHTML(d, 'span')}` : ''}</small></span></button>
          <a class="cgive" href="${esc(p.donation_url)}" target="_blank" rel="noopener" aria-label="${esc(`Donate to ${p.name}`)}">${I.heart}</a>
        </article>`;
    };
    return `<div ${lookAttrs(DONATE_LOOK, 'chero')}>
          <span class="ckicker">Give</span>
          <h1>Donate</h1>
          <p>Parishes that take donations online.</p>
        </div>
        <div class="sheet-link">${linkChip(donateSegs(juris))}</div>
        ${tabs.length > 1 ? `<div class="frow donate-tabs">${fpill('donate', '', !juris, 'All')}${tabs.map(j => fpill('donate', j, juris === j, esc(JURIS[j].short))).join('')}</div>` : ''}
        <div class="clist">${ps.map(item).join('') || '<div class="tt-none">No parish here takes donations online yet.</div>'}</div>
        <div class="toolbar-space sm"></div>`;
  }
  const donateSegs = (juris) => (juris ? [juris, 'donate'] : ['donate']);
  function openDonate(juris, { entry = true } = {}) {
    const el = pushSheet(`${glassBar('Donate', juris ? JURIS[juris]?.long : null)}<div class="sheet-scroll">${donateBodyHTML(juris)}</div>`, 'donate', { segs: donateSegs(juris), entry });
    el._juris = juris;
    return el;
  }
  /** One jurisdiction's, or all: the card and its link change where they are. */
  function setDonate(el, juris) {
    el._juris = juris || null;
    el._segs = donateSegs(el._juris);
    el.querySelector('.gtitle').innerHTML = `<b>Donate</b>${el._juris ? `<small>${esc(JURIS[el._juris]?.long || '')}</small>` : ''}`;
    el.querySelector('.sheet-scroll').innerHTML = donateBodyHTML(el._juris);
    fitLinks(el);
    syncURL();
  }

  // ── An event ──────────────────────────────────────────────────────────

  function findEvent(id) {
    const s = String(id);
    return feedFor(14).find(e => String(e.id) === s)
      || (window.agoraBundle.raw?.events || []).find(e => String(e.id) === s)
      || window.agoraBundle.resolveEvent(s)
      || S.fetched.get(s);
  }
  /**
   * A stored event the bundle does not hold — one already over, which is what
   * a link shared last week is — read on its own, as the Worker painted it.
   * A date of a service needs no read: resolveEvent projects it.
   */
  async function fetchEvent(id) {
    if (!/^\d+$/.test(String(id))) return null;
    const r = await fetch(`/api/events/${encodeURIComponent(id)}`).catch(() => null);
    const e = r && r.ok ? await r.json().catch(() => null) : null;
    if (!e || e.status === 'hidden' || e.status === 'rejected') return null;
    S.fetched.set(String(e.id), e);
    return e;
  }
  /**
   * An event's card, inside its bar: drawn when it opens, and again after a
   * write. Opened by a parish link (`match`), its link is that one, and the
   * others that answer it follow.
   */
  /**
   * Every parish an event is at, once each, with its part in it: the host,
   * the parish whose church it is held in when that is another's
   * (location_parish_id), then the parishes a combine added (event_parishes).
   */
  function eventParishes(e) {
    const venueId = e.location_parish_id && e.location_parish_id !== e.parish_id ? e.location_parish_id : null;
    // A feed event carries its combine's parishes; one read from the bundle or
    // /api/events does not, and the bundle's rows say the same.
    const added = e.combined_parishes || (window.agoraBundle.raw?.event_parishes || [])
      .filter(x => String(x.event_id) === String(e.id)).map(x => x.parish_id);
    const seen = new Set();
    const out = [];
    for (const [id, role] of [[e.parish_id, 'Hosting'], [venueId, 'Held here'], ...added.map(id => [id, 'Taking part'])]) {
      const p = id && !seen.has(id) && S.byId.get(id);
      if (!p) continue;
      seen.add(id);
      out.push({ p, role });
    }
    return out;
  }
  /**
   * More parishes than a glance takes (a deanery's vespers has dozens) are
   * folded to the first few under a fade, with Show all, as a collection's
   * timetables are: a checkbox in its label (next.css .ev-parishes), so the
   * Worker's first paint opens the same way with no script (page-card.mjs).
   */
  const PARISH_FOLD = 4;
  const parishFold = (n, list) => (n > PARISH_FOLD
    ? `<section class="ev-parishes folded">${list}<label class="ctimes-open"><input type="checkbox" hidden><span>Show all ${n} parishes</span>${I.chev}</label></section>`
    : list);
  function eventBodyHTML(e, match = null) {
    const segs = match ? matchSegs(match) : segsFor({ eventId: e.id });
    const p = S.byId.get(e.parish_id);
    const l = local(e);
    const last = e.end_local ? { date: e.end_local.slice(0, 10), hm: e.end_local.slice(11, 16) } : (e.end_utc ? partsIn(e.timezone || TZ, Date.parse(e.end_utc)) : null);
    const end = last ? last.hm : null;
    // Over days (a weekend camp), each end says its day. A vigil past midnight is one night.
    const overDays = last && last.date > l.date && endMs(e) - Date.parse(e.start_utc) >= 12 * 3600000;
    const venue = e.location_parish_id && e.location_parish_id !== e.parish_id ? S.byId.get(e.location_parish_id) : null;
    const where = e.location_override || (venue ? `${venue.name}${venue.address ? ` — ${venue.address}` : ''}` : p?.address) || '';
    const lat = e.location_lat ?? e.lat ?? venue?.lat ?? p?.lat, lng = e.location_lng ?? e.lng ?? venue?.lng ?? p?.lng;
    // The host alone needs no list: its button is in the actions.
    const parishes = eventParishes(e);
    // A service's date is about its rule, which the dialog lists by name.
    const rule = e.schedule_id != null ? S.rules.find(r => String(r.id) === String(e.schedule_id)) : null;
    // What the date is, when it is not on: in its kicker, and the title struck through.
    const off = tombOf(e) || (e.status === 'hidden' ? 'Suppressed' : null);
    // A date combined into another event points at it.
    const into = e.status === 'combined' && e.combined_into_event_id ? findEvent(e.combined_into_event_id) : null;
    const edits = p && may('event.edit', p.id);
    // The parish's stream, unless this date hides it (hide_live).
    const live = !e.hide_live && (e.parish_live_url || p?.live_url);
    // What it is said in: a service's own tags, never its parish's.
    const langs = window.AgoraTimetable.serviceLangs(e) || [];
    // Off, a quiet veil over the poster and the words, which still say it is on.
    const offCls = off ? ` off ${esc(e.status)}` : '';
    const stamp = off ? `<span class="off-veil"><span>${esc(OFF_SAYS[e.status] || off)}</span></span>` : '';
    return `${e.poster_path ? `<button class="ev-poster${offCls}" type="button" data-poster="${esc(e.poster_path)}" aria-label="The poster, full size"><img src="${esc(e.poster_path)}" alt="">${stamp}</button>` : `<div class="ev-band${offCls}" style="--j:${jColor(p?.jurisdiction)}">${roundel(e.event_type, true)}${stamp}</div>`}
        <div class="ev-head${off ? ` off ${esc(e.status)}` : ''}">
          <div class="ev-kind">${off ? `<span class="ev-off">${esc(off)}</span>` : ''}${kindPill(e.event_type)}</div>
          <h1>${esc(e.title)}</h1>
          ${e.feast ? `<p class="ev-sub">${esc(e.feast)}</p>` : ''}
          <p class="ev-when">${overDays ? `${esc(dayLabel(l.date))} ${esc(hm12(l.hm))} – ${esc(dayLabel(last.date))} ${esc(hm12(end))}`
            : `${esc(dayLabel(l.date, true))} · ${esc(hm12(l.hm))}${end ? `–${esc(hm12(end))}` : ''}`}</p>
          ${off && e.break_note ? `<p class="ev-note">${esc(e.break_note)}</p>` : ''}
          ${into ? `<p class="ev-note">In its place: <button class="ev-link" type="button" data-event="${esc(into.id)}">${esc(into.title)}</button></p>` : ''}
        </div>
        <div class="sheet-link">${linkChip(segs)}</div>
        <div class="actions">
          ${pinHref(lat, lng) ? `<a class="abtn primary" href="${esc(pinHref(lat, lng))}" target="_blank" rel="noopener">${I.place}<span>Google Maps</span></a>` : ''}
          ${live ? `<a class="abtn" href="${esc(live)}" target="_blank" rel="noopener">${I.live}<span>Watch live</span></a>` : ''}
          <button class="abtn" type="button" data-parish="${esc(e.parish_id)}">${avatar(p, 'xs')}<span>Parish</span></button>
          ${edits ? `<button class="abtn" type="button" data-edit-event="${esc(e.id)}">${I.pencil}<span>Edit</span></button>` : ''}
        </div>
        ${where || langs.length ? `<div class="details">${where ? `<div class="drow"><small>Where</small><span>${esc(where)}</span></div>` : ''}${langs.length ? `<div class="drow"><small>Languages</small><span>${esc(langs.join(', '))}</span></div>` : ''}</div>` : ''}
        ${e.description ? (off ? `<div class="ev-desc${offCls}">${stamp}<div class="ev-desc-text">${window.AgoraLinkify.linkify(e.description).replace(/\n/g, '<br>')}</div></div>`
          : `<div class="ev-desc">${window.AgoraLinkify.linkify(e.description).replace(/\n/g, '<br>')}</div>`) : ''}
        ${parishes.length > 1 ? `<h2 class="sec">Parishes</h2>${parishFold(parishes.length, `<div class="lists">${parishes.map(({ p: x, role }) => `<button class="lrow" type="button" data-parish="${esc(x.id)}">${avatar(x, 'sm')}
          <span class="ln"><b>${esc(x.name)}</b><small>${esc(role)}</small></span>${I.chev}</button>`).join('')}</div>`)}` : ''}
        ${!edits && p ? `<button class="wide-btn" type="button" data-suggest="${esc(rule ? serviceLine(rule) : SUGGEST.event)}" data-pid="${esc(p.id)}">Suggest an edit</button>` : ''}
        ${match ? matchFeedHTML(match, e.id) : ''}
        <div class="toolbar-space"></div>`;
  }
  /** An event card's toolbar: its bookmark, and its pencil for whoever may edit it. */
  function eventTools(e) {
    const rule = e.schedule_id != null;
    return bookmarkButton(e) + (S.byId.has(e.parish_id) && may('event.edit', e.parish_id)
      ? `<button type="button" data-edit-event="${esc(e.id)}" aria-label="${rule ? 'Edit this date' : 'Edit this event'}">${I.pencil}</button>` : '');
  }
  function openEvent(id, { entry = true, match = null } = {}) {
    const e = findEvent(id);
    if (!e) {
      if (S.fetched.has(String(id))) return null;
      return fetchEvent(id).then(x => (x ? openEvent(id, { entry, match }) : null));
    }
    const p = S.byId.get(e.parish_id);
    // Its bookmark floats, as a parish's star does, and its pencil beside it.
    const html = `${glassBar(e.title, p ? p.name : '')}<div class="sheet-scroll">${eventBodyHTML(e, match)}</div>
      <div class="floatbar" role="toolbar">${eventTools(e)}</div>`;
    const el = pushSheet(html, 'event', { segs: match ? matchSegs(match) : segsFor({ eventId: e.id }), entry });
    el._event = e;
    el._match = match;
  }
  /**
   * An open event card again, from the bundle as it now is. A date that has
   * gone (a deleted event, a service that has ended) takes its card with it.
   */
  function repaintEvent(el) {
    const e = findEvent(el._event.id);
    if (!e) {
      if (stack[stack.length - 1] === el) popSheet();
      return;
    }
    el._event = e;
    el._segs = el._match ? matchSegs(el._match) : segsFor({ eventId: e.id });
    const p = S.byId.get(e.parish_id);
    const bar = el.querySelector('.gtitle');
    if (bar) bar.innerHTML = `<b>${esc(e.title)}</b>${p ? `<small>${esc(p.name)}</small>` : ''}`;
    const scroller = el.querySelector('.sheet-scroll');
    const top = scroller.scrollTop;
    scroller.innerHTML = eventBodyHTML(e, el._match);
    scroller.scrollTop = top;
    const tools = el.querySelector('.floatbar');
    if (tools) tools.innerHTML = eventTools(e);
    fitLinks(el);
  }
  // ── Bookmarks ─────────────────────────────────────────────────────────

  /** An event card's bookmark: on for the date, or for its whole service. */
  function bookmarkButton(e) {
    const on = isBookmarked(e);
    return `<button class="bm${on ? ' on' : ''}" type="button" data-act="bookmark" aria-pressed="${on}" aria-label="${on ? 'Bookmarked' : 'Bookmark'}">${on ? I.bookmarkOn : I.bookmark}</button>`;
  }
  /**
   * A one-off is bookmarked with a tap. A date of a regular service asks
   * which: this date, or every date of the service, as the app's pair of
   * buttons did.
   */
  function bookmarkEvent(e) {
    const rid = ruleIdOf(e);
    const r = rid && S.rules.find(x => String(x.id) === rid);
    if (!r) {
      toast(toggleMark('event', e.id) ? 'Bookmarked' : 'Bookmark removed');
      return afterMarks();
    }
    const html = `<div class="lay-head"><h2>Bookmark</h2><button class="gbtn" type="button" data-act="close" aria-label="Close">${I.x}</button></div>
      <div class="sheet-scroll">
        <p class="lay-note">${esc(e.title)}</p>
        <div class="lists">
          <button class="lrow${isMarked('event', e.id) ? ' on' : ''}" type="button" data-mark="event" data-id="${esc(e.id)}">
            <span class="lic">${I.bookmark}</span><span class="ln"><b>${esc(dayLabel(local(e).date, true))}</b><small>This date</small></span><span class="lck">${I.check}</span></button>
          <button class="lrow${isMarked('rule', rid) ? ' on' : ''}" type="button" data-mark="rule" data-id="${esc(rid)}">
            <span class="lic">${I.bookmark}</span><span class="ln"><b>Every ${esc(WD_LONG[r.day_of_week])}, ${esc(clock(r.start_time))}</b><small>Every date of this service</small></span><span class="lck">${I.check}</span></button>
        </div>
      </div>`;
    pushSheet(html, 'mini');
  }
  /** After a bookmark changes: the cards that show one, and Your lists. */
  function afterMarks() {
    for (const el of stack) {
      if (el._event) { const b = el.querySelector('[data-act="bookmark"]'); if (b) b.outerHTML = bookmarkButton(el._event); }
      if (el.classList.contains('bookmarks')) el.querySelector('.sheet-scroll').innerHTML = bookmarksBodyHTML();
    }
    renderLists();
  }
  function bookmarksBodyHTML() {
    const { dates, rules } = bookmarked();
    const byDay = new Map();
    for (const e of dates) {
      const k = local(e).date;
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(e);
    }
    const days = [...byDay].map(([k, es]) => `<section class="sday"><h3 class="dh${weekdayOf(k) === 0 ? ' sun' : ''}"><span>${esc(dayLabel(k, true))}</span></h3>${es.map(e => eventRow(e)).join('')}</section>`).join('');
    // A service bookmarked whole: its line, and its parish, which opens.
    const services = rules.map(r => {
      const p = S.byId.get(r.parish_id);
      return `<button class="lrow" type="button" data-parish="${esc(r.parish_id)}">${avatar(p, 'sm')}
          <span class="ln"><b>${esc(r.title)}</b><small>${esc(`${WD_LONG[r.day_of_week]}s, ${clock(r.start_time)}`)} · ${esc(p ? p.name : '')}</small></span>${I.chev}</button>`;
    }).join('');
    return `<div ${lookAttrs(BOOKMARK_LOOK, 'chero')}>
          <span class="ckicker">Your list</span>
          <h1>Bookmarks</h1>
          <p>Kept in this browser.</p>
        </div>
        ${services ? `<h2 class="sec">Services</h2><div class="lists">${services}</div>` : ''}
        <h2 class="sec">Coming up</h2>
        <div class="cu">${days || '<div class="tt-none sm">Nothing bookmarked is coming up.</div>'}</div>
        <div class="toolbar-space sm"></div>`;
  }
  function openBookmarks() {
    const el = pushSheet(`${glassBar('Bookmarks', null, { share: false })}<div class="sheet-scroll">${bookmarksBodyHTML()}</div>`, 'bookmarks');
    return el;
  }

  /**
   * A poster, as big as the screen allows: a tap, or Escape, puts it away.
   * Copy and Share hand over the picture itself. Safari's own long press on
   * the image often hands over its address instead, and pasting that gives a
   * link, so these two are the sure way to the image.
   */
  function openPoster(src) {
    const el = document.createElement('div');
    el.className = 'poster-view';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Poster');
    const canCopy = !!(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem);
    el.innerHTML = `<img src="${esc(src)}" alt=""><button class="gbtn" type="button" aria-label="Close">${I.x}</button>
      <div class="poster-acts">
        ${canCopy ? '<button class="pbtn" type="button" data-pv="copy">Copy image</button>' : ''}
        ${navigator.share ? `<button class="pbtn" type="button" data-pv="share">${I.share}<span>Share</span></button>` : ''}
      </div>`;
    // Fetched now, so Share has the file at the tap: Safari lets a share go
    // only straight from the tap, not after a wait for the network.
    let file = null;
    const blob = fetch(src).then(r => (r.ok ? r.blob() : null)).catch(() => null);
    blob.then(b => { if (b) file = new File([b], `poster.${/png/.test(b.type) ? 'png' : 'jpg'}`, { type: b.type || 'image/jpeg' }); });
    // A clipboard takes PNG everywhere; a JPEG only in some browsers.
    const png = () => blob.then(b => new Promise((ok, no) => {
      if (!b) return no(new Error('no image'));
      const img = new Image();
      const url = URL.createObjectURL(b);
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        c.toBlob(x => (x ? ok(x) : no(new Error('no png'))), 'image/png');
      };
      img.onerror = () => { URL.revokeObjectURL(url); no(new Error('no image')); };
      img.src = url;
    }));
    const close = () => { el.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } };
    el.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-pv]');
      if (!b) return close();
      ev.stopPropagation();
      try {
        if (b.dataset.pv === 'copy') {
          // The item is made in the tap, its picture filled in after (Safari's rule).
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': png() })]);
          toast('Image copied');
        } else if (file && navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] });
        } else {
          await navigator.share({ url: new URL(src, location.href).href });
        }
      } catch (e) {
        if (b.dataset.pv === 'copy') toast('Could not copy the image');
      }
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(el);
  }

  /** Every open card, redrawn. */
  function repaintSheets() {
    for (const el of [...stack]) {
      if (el.classList.contains('parish')) repaintParish(el);
      else if (el.classList.contains('event')) repaintEvent(el);
    }
  }

  // ── Filters: the app's pills, behind a button beside the chips ─────────
  //
  // The app's toolbar pills (app.css .mode-bar-pill), laid out in rows that
  // open under the button rather than on a screen of their own: the map and
  // the chips stay in sight, and every tap applies. Tapping a pill that is on
  // turns it off, so no row needs an "Any". A language wears its "only" once
  // chosen.
  //
  // What: a line per kind, its name and then every type it holds, each in
  // its roundel's colour, all in sight (no compact roundels to open). One of
  // them at a time: Services lights everything it covers, as Prayer does the
  // prayer services, so what a kind matches is plain before it is narrowed.

  const KIND_NAMES = { services: 'Services', talks: 'Talks', socials: 'Socials' };
  const KIND_SUBS = { services: ['liturgy', 'prayer', 'feast'], talks: ['bible-study'], socials: ['social', 'youth'] };
  /** The type a sub-kind's colour is: Bible studies are a talk's. */
  const subColorOf = (id) => (id === 'bible-study' ? 'talk' : id);
  /** A sub-kind's name. Bible studies are Talks' one, and a title, not a type. */
  const kindSubLabel = (id) => (id === 'bible-study' ? 'Bible Studies' : kindLabel(id));
  // The services a link can name that are not a kind's own: Services' prayers, by name.
  const PANEL_SERVICES = ['vespers', 'matins', 'paraklesis', 'compline', 'confession'];
  const REGIONS = ['nsw', 'vic', 'qld', 'wa', 'sa', 'tas', 'act', 'nt', 'nz'];
  const regionShort = (slug) => (REGIONS.includes(slug) ? slug.toUpperCase() : window.AgoraLocations.resolveLocation(slug)?.label || slug);

  const fpill = (set, val, on, label, cls = '', style = '') =>
    `<button class="fpill${cls}${on ? ' on' : ''}" type="button" data-set="${set}" data-val="${esc(val)}"${style ? ` style="${style}"` : ''} aria-pressed="${on}">${label}</button>`;
  /** A type's pill, in its colour: on, or lit as one of what the chosen kind covers (`match`). */
  function typePill(set, val, color, label, on, match) {
    const c = window.AgoraEventTypes.kindColors(color, dark());
    return `<button class="fpill ftype${on ? ' on' : match ? ' match' : ''}" type="button" data-set="${set}" data-val="${esc(val)}" style="--k-bg:${c.bg};--k-fg:${c.fg}" aria-pressed="${on}">${esc(label)}</button>`;
  }
  /**
   * What: a line per kind, its name first, then each type it holds. A
   * card's (`pre` 'card:') offers only what its parish has (`has`, asked of
   * a filter of one kind, type or service).
   */
  function kindLines(f, SV, pre = '', has = () => true) {
    return Object.entries(KIND_NAMES).filter(([k]) => has({ kind: k })).map(([k, l]) => {
      const whole = f.kind === k && !f.kindSub;
      const head = `<button class="fpill fcat${whole ? ' on' : f.kind === k ? ' part' : ''}" type="button" data-set="${pre}kind" data-val="${k}" aria-pressed="${whole}">${esc(l)}</button>`;
      const subs = KIND_SUBS[k].filter(id => has({ kind: k, kindSub: id }))
        .map(id => typePill(`${pre}kindSub`, `${k}:${id}`, subColorOf(id), kindSubLabel(id), f.kind === k && f.kindSub === id, whole));
      // Services' prayers by name, lit by Services and by Prayer.
      const prayers = k === 'services' ? PANEL_SERVICES.filter(sv => has({ service: sv })).map(sv => typePill(`${pre}service`, sv, 'prayer', SV.serviceLabel(sv), f.service === sv,
        f.kind === 'services' && (!f.kindSub || f.kindSub === 'prayer'))) : [];
      return `<span class="fkind">${head}${subs.join('')}${prayers.join('')}</span>`;
    });
  }
  function panelHTML() {
    const f = S.f, SV = window.AgoraServices;
    // A group of pills per question, as the app's toolbar has, with no label:
    // what, which language, when, where, which parishes. A break starts a line.
    const group = (label, ...lines) => `<div class="frow" role="group" aria-label="${label}">${lines.filter(Boolean).join('<span class="fbreak"></span>')}</div>`;
    const langs = LANGS.map(([l]) => l).map(l => fpill('lang', l, f.lang === l, esc(l))
      + (f.lang === l ? fpill('langStrict', '1', f.langStrict, 'only', ' fpill-only') : '')).join('');
    const days = `<span class="fdays">${WD.map((d, i) => fpill('day', i, SV.daysOf(f.day).includes(i), d)).join('')}</span>`;
    // Jurisdictions, as many as you like; each in its colour, as its tab is.
    const juris = TAB_ORDER.map(j => fpill('juris', j, jList(S.juris).includes(j), esc(JURIS[j].short), ' fpill-j', `--j:${shown(jColor(j))}`)).join('');
    const spans = SV.DAY_GROUPS.map(g => fpill('dayGroup', g.slug, f.dayGroup === g.slug, esc(g.label))).join('');
    const parts = SV.PARTS_OF_DAY.map(pt => fpill('part', pt.slug, f.part === pt.slug, esc(pt.label))).join('');
    const regions = [...REGIONS, ...(f.location && !REGIONS.includes(f.location) ? [f.location] : [])]
      .map(r => fpill('location', r, f.location === r, esc(regionShort(r)))).join('');
    const lists = allLists().filter(l => l.ids.length);
    const parishes = fpill('monasteries', '1', f.monasteries, 'Monasteries')
      + fpill('timesOnly', '1', f.timesOnly, 'With service times')
      + lists.map(l => fpill('list', l.id, f.listId === l.id, `${l.fav ? '<span class="fstar" aria-hidden="true">★</span>' : ''}${esc(l.name)}`)).join('');
    return group('What', ...kindLines(f, SV)) + group('Language', langs) + group('When', days, spans, parts)
      + group('Jurisdiction', juris) + group('Where', regions) + group('Parishes', parishes)
      + `<div class="fpanel-foot">${filterCount() ? '<button class="fpill fpill-ghost" type="button" data-act="clear-filters">Clear all</button>' : '<span></span>'}
          <span class="fpanel-end">${saveViewHTML()}<button class="fpill on" type="button" data-act="filters-done">Done</button></span></div>`;
  }
  /** What a saved view keeps: the page's filters, without a date, which would pass. */
  const viewSegs = () => segsFor({ juris: S.juris, f: S.f });
  /** Save: the page as its filters make it, kept in Your lists. Saved: tap to let it go. */
  function saveViewHTML() {
    const path = pathOf(viewSegs());
    if (path === '/') return '';
    const on = isSavedView(path);
    return `<button class="fpill fpill-ghost${on ? ' fpill-saved' : ''}" type="button" data-act="save-view" aria-pressed="${on}">${on ? `${CHECK}<span>Saved</span>` : 'Save'}</button>`;
  }
  // Open, the panel is one step: the first change in it is a step back, the
  // rest are written onto it, so back undoes a whole go at the filters.
  const panelOpen = () => !!S.panel;
  // Opened from the dock, the panel opens under it, where you are, and goes
  // back under the page's button when it closes.
  const panelInDock = () => $('#filter-panel').parentNode === $('#dock');
  function setPanel(open, { dock = false } = {}) {
    const el = $('#filter-panel');
    if (!open || !dock) $('#page > .filter-bar').after(el);
    else $('#dock').appendChild(el);
    // Moving it is not a new go at the filters: back still undoes the whole of it.
    if (!open) S.panel = null;
    else if (!S.panel) S.panel = { pushed: false };
    el.hidden = !open;
    $$('[data-filters]').forEach(b => b.setAttribute('aria-expanded', String(open)));
    document.body.classList.toggle('filters-open', open);
    if (open) renderPanel();
    else el.innerHTML = '';
    syncDock();
  }
  function renderPanel() {
    if (panelOpen()) $('#filter-panel').innerHTML = panelHTML();
  }
  /**
   * One pill of what, which language or when, tapped on `f`: on if it was
   * off, off if it was on. The page's filters and a parish card's (its
   * focus) ask these alike. False for any other pill.
   */
  function flipWhat(f, k, v) {
    const flip = (key, val) => { f[key] = f[key] === val ? null : val; };
    // One kind, type or service at a time: each replaces the others.
    if (k === 'kind') { f.kind = f.kind === v && !f.kindSub ? null : v; f.kindSub = null; f.service = null; }
    else if (k === 'kindSub') {
      const [kind, sub] = v.split(':');
      const was = f.kind === kind && f.kindSub === sub;
      f.kind = was ? null : kind; f.kindSub = was ? null : sub; f.service = null;
    }
    else if (k === 'service') { flip('service', v); f.kind = null; f.kindSub = null; }
    else if (k === 'lang') { flip('lang', v); f.langStrict = false; }
    else if (k === 'langStrict') f.langStrict = !f.langStrict;
    // Days, as many as you like. A day and a span of the week are one
    // question, asked one way at a time.
    else if (k === 'day') {
      const SV = window.AgoraServices, ds = SV.daysOf(f.day);
      f.day = SV.dayValue(ds.includes(+v) ? ds.filter(d => d !== +v) : [...ds, +v]);
      f.dayGroup = null;
    }
    else if (k === 'dayGroup') { flip('dayGroup', v); f.day = null; }
    else if (k === 'part') flip(k, v);
    else return false;
    return true;
  }
  /** One pill tapped: on if it was off, off if it was on. */
  function setFilter(k, v) {
    const f = S.f;
    const flip = (key, val) => { f[key] = f[key] === val ? null : val; };
    if (flipWhat(f, k, v)) { /* what, language, when */ }
    else if (k === 'juris') {
      const js = jList(S.juris);
      S.juris = window.AgoraUrlState.jurisdictionValue(js.includes(v) ? js.filter(j => j !== v) : [...js, v]);
    }
    else if (k === 'location') flip(k, v);
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
  /** A parish card's ⋯: a menu out of the button, over the card. */
  function openMore(pid, btn) {
    const p = S.byId.get(pid);
    openMenu(btn, `<button class="pm-row" role="menuitem" type="button" data-act="share-parish">${I.share}<span class="pm-t"><b>Share</b></span></button>
        <button class="pm-row" role="menuitem" type="button" data-act="addlist">${I.list}<span class="pm-t"><b>Add to list</b></span></button>
        ${mapsHref(p) ? `<a class="pm-row" role="menuitem" href="${esc(mapsHref(p))}" target="_blank" rel="noopener">${I.place}<span class="pm-t"><b>Google Maps</b></span></a>` : ''}
        ${p.website ? `<a class="pm-row" role="menuitem" href="${esc(p.website)}" target="_blank" rel="noopener">${I.globe}<span class="pm-t"><b>Website</b></span></a>` : ''}
        <button class="pm-row" role="menuitem" type="button" data-act="juris-of">${jurisLogo(p.jurisdiction)
          ? `<span class="pm-ic"><img src="${esc(jurisLogo(p.jurisdiction))}" alt=""></span>`
          : `<span class="pm-ic">${I.cross.replace('<svg', '<svg width="14" height="22"')}</span>`}<span class="pm-t"><b>More ${esc(JURIS[p.jurisdiction]?.short || '')} parishes</b></span></button>
        ${may('parish.edit', pid) ? `<button class="pm-row" role="menuitem" type="button" data-edit-details="${esc(pid)}">${I.pencil}<span class="pm-t"><b>Edit</b></span></button>` : ''}
        ${suggestsHere(pid) ? `<button class="pm-row" role="menuitem" type="button" data-suggest="">${I.pencil}<span class="pm-t"><b>Suggest an edit</b></span></button>` : ''}`);
  }

  // ── Search ────────────────────────────────────────────────────────────
  //
  // One field, answered as you type, in four kinds of result: parishes, places
  // (a suburb, a postcode, a city — the map goes there), services and events,
  // and collections. A few words are read as intent rather than text, so
  // "english liturgy sunday" or "vespers tonight" ask the timetable a question
  // instead of looking for those words in titles.

  // What words mean, and whether a row answers them, is search-words.js's: a
  // link's own words (/smmp/disco) are read there too, so the two agree.
  const SW = window.AgoraSearch;
  const { norm, hasWord, DAY_WORDS, LANG_WORDS, FILLER } = SW;
  const parseQuery = (q) => SW.parseQuery(q, todayKey());

  let parishHay = null;
  function hayOf(p) {
    if (!parishHay) {
      parishHay = new Map(S.parishes.map(x => [x.id, {
        name: norm(`${x.name} ${x.full_name || ''}`),
        acr: norm(x.acronym || ''),
        addr: norm(x.address || ''),
        rest: norm(`${JURIS[x.jurisdiction]?.long || ''} ${parishLangs(x).join(' ')}`),
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
          && (!Q.lang || window.AgoraTimetable.rowAnswersLang(r, { lang: Q.lang }, hasLang(p, Q.lang))));
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
    const res = feedFor(42).filter(e => {
      if (!visible(e) || e.parish_scoped || endMs(e) < now) return false;
      const at = whereWhen(e);
      if (SW.answers(e, Q, at)) return true;
      // Or the words name the parish (or its suburb): its services, as the
      // rest of the query asks.
      return !!pids && eventParishIds(e).some(id => pids.has(id)) && SW.answers(e, { ...Q, text: [] }, at);
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
        <span class="sr-t"><b>${esc(p.name)}</b><small>${esc(JURIS[p.jurisdiction]?.short || '')}${d != null ? ` · ${distHTML(d, 'span')}` : ''}${nx ? ` · Next: ${esc(nx.title)} ${esc(whenShort(nx))}` : ' · No times on file'}</small></span>
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
    const sign = c.glyph ? (c.glyph.startsWith('<svg') ? c.glyph : esc(c.glyph)) : c.kind ? esc(kindLabel(c.kind)[0]) : '☦';
    const art = `<span ${lookAttrs(c, 'sr-art')}>${sign}</span>`;
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
    // Enter searches and puts the keyboard away, so the results are in sight; a result opens with a tap.
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      clearTimeout(t);
      el.querySelector('#sr-results').innerHTML = searchResultsHTML(input.value);
      rememberQuery(input.value);
      input.blur();
    });
    // Ready to type: focused inside the tap that opened it, which is the only
    // focus a phone brings its keyboard up for; again once the card is up.
    try { input.focus({ preventScroll: true }); } catch { /* not focusable yet */ }
    setTimeout(() => { if (document.activeElement !== input) input.focus({ preventScroll: true }); }, 340);
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
      renderFavs();
      if (map) map.flyTo({ center: [S.loc.lng, S.loc.lat], zoom: 11.5, duration: 900 });
    }, () => toast('Couldn’t get your location'), { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  }

  // ── Wiring ────────────────────────────────────────────────────────────

  document.addEventListener('click', (ev) => {
    const t = ev.target;
    const top = stack[stack.length - 1];
    let b;

    // An open menu goes with any tap: off it, that is all the tap does (on
    // its own button, it closes it); on one of its rows, the row does its part.
    if (menu) {
      const own = menu._btn.contains(t), inside = menu.contains(t);
      closeMenu();
      if (own || !inside) return;
    }

    // Search: a tap on any result remembers what was typed.
    if (top && top.classList.contains('search') && t.closest('[data-parish],[data-event],[data-coll],[data-place]')) {
      rememberQuery(top.querySelector('#sr-input').value);
    }
    if ((b = t.closest('[data-copy]'))) { copyLink(b); return; }
    if (t.closest('[data-search]')) { openSearch(); return; }
    if ((b = t.closest('[data-account]'))) { openAccount(b); return; }
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
      else if (k === 'juris') S.juris = window.AgoraUrlState.jurisdictionValue(jList(S.juris).filter(j => j !== b.dataset.val));
      else if (k === 'day' && b.dataset.val != null) S.f.day = window.AgoraServices.dayValue(window.AgoraServices.daysOf(S.f.day).filter(d => d !== +b.dataset.val));
      else if (k === 'kind') { S.f.kind = null; S.f.kindSub = null; }
      else if (k === 'lang') { S.f.lang = null; S.f.langStrict = false; }
      else if (k === 'parishIds') { S.f.parishIds = null; S.f.listId = null; }
      else S.f[k] = k === 'timesOnly' || k === 'monasteries' ? false : null;
      refilter();
      return;
    }
    if (t.closest('#btn-favourites')) { const c = COLL.get('list-fav'); if (c) openCollection(c); return; }
    if (t.closest('#inview, [data-inview]')) { openInView(); return; }
    if ((b = t.closest('[data-coll]'))) { const c = COLL.get(b.dataset.coll); if (c) openCollection(underJuris(c)); return; }
    if (t.closest('[data-newlist]')) {
      const name = prompt('Name your list', 'Parishes to visit');
      if (name) { const l = newList(name); toast(`Made “${l.name}”`); }
      return;
    }
    if ((b = t.closest('[data-quickadd]'))) { openAddToList(b.dataset.quickadd); return; }
    if ((b = t.closest('[data-edit-rules]'))) { window.NextEdit.editLine(b.dataset.editRules.split(',')); return; }
    if ((b = t.closest('[data-edit-event]'))) { window.NextEdit.editEvent(b.dataset.editEvent); return; }
    if ((b = t.closest('[data-edit-details]'))) { window.NextEdit.editDetails(b.dataset.editDetails); return; }
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
    if (t.closest('[data-become-editor]')) { becomeEditor(); return; }
    if (t.closest('[data-disclaimer]')) { openDisclaimer(); return; }
    // A link on the page to one of the site's own (/smg), opened in place as
    // a link inside it is; a new tab, or a parish not loaded yet, follows it.
    if ((b = t.closest('a[data-go]'))) {
      const path = b.getAttribute('href');
      if (ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey || !readPath(path).parish) return;
      ev.preventDefault();
      go(path);
      return;
    }
    if ((b = t.closest('[data-poster]'))) { openPoster(b.dataset.poster); return; }
    if ((b = t.closest('[data-mark]'))) {
      toggleMark(b.dataset.mark, b.dataset.id);
      b.classList.toggle('on', isMarked(b.dataset.mark, b.dataset.id));
      afterMarks();
      return;
    }
    if ((b = t.closest('[data-view]'))) { go(b.dataset.view); return; }
    if ((b = t.closest('[data-parish]'))) {
      // An event's Parish, over that parish's own card, is a step back to it.
      const top = stack[stack.length - 1], under = stack[stack.length - 2];
      if (top && top._event && b.closest('.sheet') === top && under && under.dataset.pid === b.dataset.parish) { popSheet(); return; }
      openParish(b.dataset.parish);
      return;
    }
    if ((b = t.closest('[data-event]'))) { openEvent(b.dataset.event); return; }
    if ((b = t.closest('[data-jump]'))) {
      // Tomorrow on: a card's Today goes on in the card's own Coming up, the
      // page's in the In view card's.
      const sheet = b.closest('.sheet');
      const k = addDays(todayKey(), 1);
      if (sheet) toDay(sheet, k); else openInView({ at: k });
      return;
    }

    // Days: a date to start from, a day's own link, more days.
    if ((b = t.closest('[data-pick-date]'))) {
      const input = b.parentNode.querySelector('.date-input');
      try { input.showPicker(); } catch { input.focus(); input.click(); }
      return;
    }
    if ((b = t.closest('[data-date-clear]'))) {
      if (top) setCardDate(top, null);
      return;
    }
    if ((b = t.closest('[data-copy-day]'))) { copyDay(b); return; }

    // The filters apply as you tap; the map is above them.
    // From the page's button or the dock's: a second tap on the same one puts it away.
    if ((b = t.closest('[data-filters]'))) {
      const fromDock = !!b.closest('#dock');
      if (panelOpen() && fromDock === panelInDock()) setPanel(false);
      else setPanel(true, { dock: fromDock });
      return;
    }
    if ((b = t.closest('[data-set="donate"]')) && top) { setDonate(top, b.dataset.val); return; }
    // A parish card's own Filters, and its pills.
    if ((b = t.closest('[data-card-filters]')) && top) { top._fpanel = !top._fpanel; refreshComingUp(top); return; }
    if ((b = t.closest('[data-set^="card:"]')) && top) { setCardFilter(top, b.dataset.set.slice(5), b.dataset.val); return; }
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
      if (a === 'totop' && top) {
        const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
        top.querySelector('.sheet-scroll').scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
        return;
      }
      if (a === 'unfocus' && top) return unfocusCard(top);
      if (a === 'card-filters-done' && top) { top._fpanel = false; refreshComingUp(top); return; }
      if (a === 'card-filters-clear' && top) return unfocusCard(top);
      if (a === 'search-coll' && searchState) {
        rememberQuery(searchState.q);
        return openCollection({ id: 'search', title: `“${searchState.q}”`, kicker: 'Search', blurb: `Parishes matching “${searchState.q}”.`, tint: '#475569', ids: searchState.ps.map(p => p.id) });
      }
      if (a === 'clear-filters') { S.f = blankFilters(); S.juris = null; S.focus = null; refilter(); return; }
      if (a === 'filters-done') { setPanel(false); return; }
      if (a === 'save-view') {
        const path = pathOf(viewSegs());
        toast(toggleSavedView(path) ? 'Saved to your lists' : 'Removed from your lists');
        renderLists();
        return;
      }
      if (a === 'bookmark' && top && top._event) return bookmarkEvent(top._event);
      if (a === 'bookmarks') return openBookmarks();
      if (a === 'share') {
        if (top && top._segs) return share(top._coll ? top._coll.title : top._event ? top._event.title : S.byId.get(top.dataset.pid)?.name || '', pathOf(top._segs));
        if (top && top._coll) return share(top._coll.title, pathOf(top._coll.shareSegs || pageSegs()));
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
      // The bar's +: whoever may add an event adds one; anybody else suggests one.
      if (a === 'addevent') return may('event.edit', top.dataset.pid) ? window.NextEdit.addEvent(top.dataset.pid) : suggest(top.dataset.pid, SUGGEST.event);
      if (a === 'more') return openMore(top.dataset.pid, b);
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
        // Named for what it holds ("English Antiochian parishes in Sydney"),
        // never "64 parishes in Sydney" twice over for two different views.
        const l = newList(c.name || c.title);
        // Its parishes, and what they were: "Orthodox youth groups in Sydney".
        const ls = userLists(); const mine = ls.find(x => x.id === l.id); mine.ids = c.ids.slice(); mine.about = c.blurb || ''; writeLS(LISTS, ls);
        renderLists();
        toast(`Saved “${l.name}” to your lists`);
        return;
      }
      if (a === 'renamelist') {
        const l = listById(top._coll.listId);
        if (!l) return;
        const name = prompt('Rename your list', l.name);
        if (!name || !name.trim() || name.trim() === l.name) return;
        const now = renameList(l.id, name);
        if (!now) return;
        top._coll = { ...top._coll, title: now.name };
        $$('h1, .gtitle b', top).forEach(h => { if (h.textContent === l.name) h.textContent = now.name; });
        toast(`Renamed to “${now.name}”`);
        return;
      }
      if (a === 'deletelist') {
        const l = listById(top._coll.listId);
        if (!l || !confirm(`Delete “${l.name}”? The parishes in it are not touched.`)) return;
        deleteList(l.id);
        popSheet();
        toast(`Deleted “${l.name}”`);
        return;
      }
      if (a === 'more-items') { top.querySelector('.clist').insertAdjacentHTML('beforeend', top._rest()); b.remove(); return; }
    }
  });
  document.addEventListener('change', (e) => {
    const input = e.target.closest && e.target.closest('[data-date-input]');
    if (!input || !input.value) return;
    const top = stack[stack.length - 1];
    if (top) setCardDate(top, input.value);
  });
  $('#scrim').addEventListener('click', () => popSheet());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (menu) closeMenu();
    else if (stack.length) popSheet();
    else if (document.body.classList.contains('map-full')) setFullscreen(false);
    else if (panelOpen()) setPanel(false);
  });
  $('#btn-fullscreen').addEventListener('click', () => setFullscreen(!document.body.classList.contains('map-full')));
  document.addEventListener('keydown', (e) => {
    // "/" opens search on a keyboard, as most sites do.
    if (e.key === '/' && !stack.length && !/input|textarea/i.test(document.activeElement?.tagName || '')) { e.preventDefault(); openSearch(); }
  });
  $('#btn-locate').addEventListener('click', locate);

  // A card's Coming up goes on as it is scrolled, a fortnight at a time, to a year.
  const moreIO = new IntersectionObserver((ents) => {
    for (const en of ents) {
      const el = en.isIntersecting && en.target.closest('.sheet');
      if (!el || el._growing || el._days >= 365) continue;
      el._growing = true;
      el._days = Math.min(365, el._days + CU_DAYS);
      refreshComingUp(el).finally(() => { el._growing = false; });
    }
  }, { rootMargin: '400px' });

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
    renderLists();
    syncMap();
    repaintSheets();
    // A card that followed its date onto a new rule has a new link.
    syncURL();
  }

  // What editing.js works on: this page, through the same questions it asks itself.
  if (window.NextEdit) {
    window.NextEdit.init({
      parish: (id) => S.byId.get(id),
      parishes: () => S.parishes,
      rule: (id) => S.rules.find(r => String(r.id) === String(id)),
      event: findEvent,
      retarget: (from, to) => {
        const e = findEvent(to);
        for (const el of stack) if (el._event && String(el._event.id) === String(from)) el._event = e || { ...el._event, id: to };
      },
      today: todayKey,
      may,
      reload,
      openParish: (id) => openParish(id),
      avatar,
      toast,
      recheck: checkSignIn,
    });
  }

  // ── Boot ──────────────────────────────────────────────────────────────

  async function boot() {
    // Who is looking, alongside everything else; the cards ask it as they open.
    const signedIn = checkSignIn();
    const mapStarted = startMap().catch(err => console.warn('map', err));
    const t = todayKey();
    // The loader's tree grows with each real step, as it does at / (app.js).
    const step = (line, p) => { if (window.lsLog) window.lsLog(line); if (window.lsProgress) window.lsProgress(p); };
    step('GET /api/bundle …', 0.15);
    await window.agoraBundle.load({ from: new Date().toISOString(), to: new Date(Date.parse(addDays(t, 60) + 'T14:00:00Z')).toISOString() });
    S.loadedTo = addDays(t, 60);
    adopt();
    step(`✓ ${S.parishes.length} parishes, ${S.rules.length} service times`, 0.6);
    if (S.loc) document.body.classList.add('located');
    // What the address asks for. The older /#sgr is /sgr.
    const route = readPath(location.pathname);
    const h = decodeURIComponent(location.hash.slice(1));
    if (h && !route.parish) { const p = parishBySlug(h); if (p) route.parish = p.id; }
    // greek.orthodoxy.au never gets here: the Worker sends it to /greek (lib/admin-host.mjs).
    S.juris = route.juris;
    S.f = route.f;
    renderJurisChips();
    renderInView();
    renderActive();
    renderCollections();
    renderFeeds();
    // The page's own address first, so a card opened from a link is one step
    // back from the page rather than from wherever the person came from.
    // ?app was the old lite card's way into the app, and means nothing now.
    const q = new URLSearchParams(location.search);
    q.delete('app');
    try { history.replaceState({ depth: 0 }, '', pathOf(pageSegs()) + (q.toString() ? `?${q}` : '')); } catch { /* sandboxed */ }
    renderLink();
    step('✓ page drawn', 0.7);
    // Signed in, role or not: the account's favourites and lists, once the
    // parishes they name are here to draw.
    signedIn.then(any => any && syncSaved()).then(got => {
      if (!got) return;
      if (!S.who.signedIn) { S.who = { ...NOBODY, signedIn: true, identity: got.identity }; syncAccount(); }
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') syncSaved(); });
    }).catch(() => {});
    await mapStarted;
    const opening = applyRoute(route, { animate: false });
    // A collection's link opens its card, over the page its filters make, as
    // the shelf's card does: a step back is that page.
    if (!route.parish && !route.eventId && !route.donate) openPageCard(route, location.pathname);
    // A card painted for a link this page did not open (a parish since gone),
    // once an event the bundle did not hold has been read.
    Promise.resolve(opening).catch(() => {}).then(() => $$('#sheets > .ssr').forEach(x => x.remove()));
    // /admin's New parish asks only what the row needs, then sends its maker
    // here to finish it: the logo, the buttons, the links, the Maps place.
    let made = null;
    try { made = sessionStorage.getItem('agora-edit-parish'); sessionStorage.removeItem('agora-edit-parish'); } catch { /* storage refused */ }
    if (made && made === route.parish && window.NextEdit) {
      signedIn.then(() => { if (may('parish.edit', made)) window.NextEdit.editDetails(made); }).catch(() => {});
    }
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
    $('#today').hidden = false;
  });
  // map.js rebuilds its own style on a scheme change; the colours this page
  // stamps inline are lifted for the dark scheme, so they are stamped again.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    renderJurisChips();
    renderInView();
  });
})();
