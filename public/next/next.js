// orthodoxy.au — the next version, as a prototype.
//
// A page around a map rather than a map under a sheet. Borrowed, piece by piece:
//   NextThere   the viewport card: nothing on the map but full screen, and a
//               chip under it that counts what is in view and shows its logos.
//   Apple Maps  the parish card (glass toolbar, a summary line, a floating
//               + ☆ … bar) and Guides: rows of collections that open as cards.
//   App Store   the What's on shelf, poster first.
//   Google Maps the layers button: every filter on one screen, away from the map.
//
// Order of the page is the answer to "how do I get into the feed": Today first,
// then the curated shelves, and underneath them, always, every service and
// event day after day for as long as you scroll — the way reviews wait at the
// bottom of a place in Google Maps.
//
// Data is the app's: /api/bundle through bundle.js and the /shared/ projection.
// Nothing here writes to the server. Lists live in this browser, and
// Favourites is the same store the current app's star writes.

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
    greek: { short: 'Greek', long: 'Greek Orthodox', blurb: 'The Greek Orthodox Archdiocese of Australia and its parishes.' },
    antiochian: { short: 'Antiochian', long: 'Antiochian Orthodox', blurb: 'The Antiochian Archdiocese — Arabic and English, and the most English of the jurisdictions.' },
    serbian: { short: 'Serbian', long: 'Serbian Orthodox', blurb: 'The Serbian Orthodox Church in Australia and New Zealand.' },
    russian: { short: 'Russian', long: 'Russian Orthodox', blurb: 'The Russian Orthodox Church Outside of Russia, Diocese of Australia and New Zealand.' },
    romanian: { short: 'Romanian', long: 'Romanian Orthodox', blurb: 'Romanian Orthodox parishes of Australia and New Zealand.' },
    macedonian: { short: 'Macedonian', long: 'Macedonian Orthodox', blurb: 'The Macedonian Orthodox Diocese of Australia and New Zealand.' },
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
    juris: null,             // a jurisdiction chip
    f: { group: null, lang: null, timesOnly: false, list: null }, // the layers screen
    focus: null,             // { title, ids:Set } — a collection shown on the map
    streamDays: 14,          // how far the stream has grown
    streamBusy: false,
  };

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
  }
  function newList(name, firstPid) {
    const ls = userLists();
    const l = { id: 'l' + Date.now().toString(36), name: name.trim().slice(0, 40) || 'My list', ids: firstPid ? [firstPid] : [], at: Date.now() };
    writeLS(LISTS, [l, ...ls]);
    renderLists();
    return l;
  }

  // ── Filters ───────────────────────────────────────────────────────────

  function parishPasses(p) {
    if (S.juris && p.jurisdiction !== S.juris) return false;
    if (S.focus && !S.focus.ids.has(p.id)) return false;
    const f = S.f;
    if (f.lang && !hasLang(p, f.lang)) return false;
    if (f.timesOnly && !rulesOf(p.id).some(liveRule)) return false;
    if (f.list) { const l = listById(f.list); if (!l || !l.ids.includes(p.id)) return false; }
    if (f.group && !rulesOf(p.id).some(r => liveRule(r) && groupOf(r.event_type) === f.group)
      && !upcomingOneOffs(p.id).some(e => groupOf(e.event_type) === f.group)) return false;
    return true;
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
    if (f.group && groupOf(e.event_type) !== f.group) return false;
    if (f.lang) {
      const ls = parseLangs(e.languages) || parseLangs(e.parish_languages) || [];
      const ok = f.lang === 'English' ? (ls.includes('English') && (parseLangs(e.languages) || ls[0] === 'English'))
        : ls.some(l => l === f.lang || (f.lang === 'Slavonic' && /slavonic|russian/i.test(l)));
      if (!ok) return false;
    }
    if (f.list) { const l = listById(f.list); if (!l || !pids.some(id => l.ids.includes(id))) return false; }
    return true;
  }
  function inViewEvent(e) {
    if (!S.bounds) return true;
    if (isFinite(e.lat) && isFinite(e.lng) && e.lat != null) return S.bounds.contains([e.lng, e.lat]);
    return eventParishIds(e).some(id => S.inView && S.inView.has(id));
  }
  const filtersOn = () => !!(S.f.group || S.f.lang || S.f.timesOnly || S.f.list);

  // ── The feed, from the bundle ─────────────────────────────────────────

  let feedCache = { key: '', list: [] };
  function feedFor(days) {
    const t = todayKey();
    const from = new Date(Date.now() - 6 * 3600000).toISOString();
    const to = new Date(Date.parse(addDays(t, days) + 'T14:00:00Z')).toISOString();
    const key = `${from.slice(0, 13)}|${to}`;
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
    star: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1-4.5-4.2 6.1-.8z"/></svg>',
    starOn: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><path d="m12 3 2.7 5.6 6.1.8-4.5 4.2 1.1 6.1L12 16.8 6.6 19.7l1.1-6.1-4.5-4.2 6.1-.8z"/></svg>',
    more: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    car: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><path d="M5 11l1.5-4.5A2 2 0 0 1 8.4 5h7.2a2 2 0 0 1 1.9 1.5L19 11a2 2 0 0 1 2 2v4a1 1 0 0 1-1 1h-1v1a1 1 0 0 1-2 0v-1H7v1a1 1 0 0 1-2 0v-1H4a1 1 0 0 1-1-1v-4a2 2 0 0 1 2-2zm2.1 0h9.8l-1.2-3.6a.5.5 0 0 0-.5-.4H8.8a.5.5 0 0 0-.5.4zM7 15.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zm10 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/></svg>',
    phone: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>',
    globe: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>',
    map: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M9 4 3 6.5v13.5l6-2.5 6 2.5 6-2.5V4l-6 2.5z"/><path d="M9 4v13.5M15 6.5V20"/></svg>',
    chev: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>',
    cross: '<svg viewBox="0 0 40 64" aria-hidden="true" fill="currentColor"><rect x="17" y="0" width="6" height="64" rx="1"/><rect x="9" y="9" width="22" height="5" rx="1"/><rect x="2" y="21" width="36" height="6" rx="1"/><rect x="9" y="44" width="22" height="5" rx="1" transform="rotate(-22 20 46.5)"/></svg>',
    search: '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg>',
    pin: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  };

  // ── The map: a viewport, not the page ─────────────────────────────────

  let map = null;
  let mapReady = false;
  async function baseStyle() {
    let layers;
    if (dark()) {
      try { layers = await (await fetch('/protomaps-dark.json')).json(); } catch { layers = null; }
      if (!Array.isArray(layers)) layers = protomaps_themes_base.default('protomaps', 'dark');
    } else {
      layers = protomaps_themes_base.default('protomaps', 'light');
    }
    return {
      version: 8,
      glyphs: '/glyphs/{fontstack}/{range}.pbf',
      sprite: location.origin + '/sprites/protomaps',
      sources: { protomaps: { type: 'vector', url: 'pmtiles:///tiles/oceania.pmtiles' } },
      layers,
    };
  }
  window.agoraNextBaseStyle = baseStyle; // a browser check drops the tiles through this

  function parishGeoJSON() {
    const dim = S.juris || S.focus || filtersOn();
    return {
      type: 'FeatureCollection',
      features: S.parishes.filter(p => isFinite(p.lat) && isFinite(p.lng) && p.lat != null).map(p => {
        const on = !dim || parishPasses(p);
        return {
          type: 'Feature',
          geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
          properties: { id: p.id, color: jColor(p.jurisdiction), on: on ? 1 : 0, label: p.acronym || '', times: rulesOf(p.id).some(liveRule) ? 1 : 0 },
        };
      }),
    };
  }
  function paintMap() {
    if (!mapReady) return;
    const src = map.getSource('parishes');
    if (src) src.setData(parishGeoJSON());
  }
  async function initMap() {
    try {
      const proto = new pmtiles.Protocol();
      maplibregl.addProtocol('pmtiles', proto.tile);
    } catch { /* already */ }
    const style = await (window.agoraNextBaseStyle || baseStyle)();
    map = new maplibregl.Map({
      container: 'map', style,
      bounds: S.loc ? [[S.loc.lng - 0.35, S.loc.lat - 0.28], [S.loc.lng + 0.35, S.loc.lat + 0.28]]
        : [[150.6, -34.15], [151.35, -33.6]], // Sydney, where most of the parishes are
      attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false, boxZoom: false,
      cooperativeGestures: false,
    });
    map.touchZoomRotate.disableRotation();
    map.on('load', () => { addLayers(); onView(); });
    map.on('click', 'p-dot', (ev) => { const f = ev.features && ev.features[0]; if (f) openParish(f.properties.id); });
    map.on('mouseenter', 'p-dot', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'p-dot', () => { map.getCanvas().style.cursor = ''; });
    map.on('moveend', onView);
    map.on('error', (e) => { if (!/pmtiles|tiles/i.test(String(e && e.error && e.error.message))) console.warn(e && e.error); });
  }
  /** Our layers over the base style — on load, and again after a scheme change. */
  function addLayers() {
    map.addSource('parishes', { type: 'geojson', data: parishGeoJSON() });
    map.addLayer({
      id: 'p-dot', type: 'circle', source: 'parishes',
      paint: {
        'circle-color': ['get', 'color'],
        'circle-radius': ['interpolate', ['linear'], ['zoom'], 4, ['case', ['==', ['get', 'times'], 1], 3.5, 2.5], 10, ['case', ['==', ['get', 'times'], 1], 7, 5], 14, 10],
        'circle-stroke-color': dark() ? '#0f1013' : '#ffffff',
        'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 4, 1, 12, 2],
        'circle-opacity': ['case', ['==', ['get', 'on'], 1], 1, 0.18],
        'circle-stroke-opacity': ['case', ['==', ['get', 'on'], 1], 1, 0.2],
      },
    });
    map.addLayer({
      id: 'p-label', type: 'symbol', source: 'parishes', minzoom: 11.5,
      filter: ['==', ['get', 'on'], 1],
      layout: { 'text-field': ['get', 'label'], 'text-font': ['Noto Sans Medium'], 'text-size': 11, 'text-offset': [0, 1.25], 'text-anchor': 'top', 'text-optional': true },
      paint: { 'text-color': dark() ? '#e8e8ea' : '#2a2a2e', 'text-halo-color': dark() ? '#0f1013' : '#ffffff', 'text-halo-width': 1.4 },
    });
    mapReady = true;
    if (S.loc) addMe();
  }
  function addMe() {
    if (!mapReady || !S.loc) return;
    const data = { type: 'Feature', geometry: { type: 'Point', coordinates: [S.loc.lng, S.loc.lat] } };
    if (map.getSource('me')) { map.getSource('me').setData(data); return; }
    map.addSource('me', { type: 'geojson', data });
    map.addLayer({ id: 'me-halo', type: 'circle', source: 'me', paint: { 'circle-radius': 16, 'circle-color': '#0a84ff', 'circle-opacity': 0.16 } });
    map.addLayer({ id: 'me', type: 'circle', source: 'me', paint: { 'circle-radius': 6.5, 'circle-color': '#0a84ff', 'circle-stroke-color': '#fff', 'circle-stroke-width': 2.5 } });
  }

  let viewTimer = null;
  function onView() {
    if (!map) return;
    S.bounds = map.getBounds();
    S.inView = new Set(S.parishes.filter(p => isFinite(p.lat) && p.lat != null && S.bounds.contains([p.lng, p.lat])).map(p => p.id));
    const c = map.getCenter();
    $('#place-name').textContent = S.loc && km(S.loc, { lat: c.lat, lng: c.lng }) < 15 ? 'Near you' : placeName(c.lat, c.lng, map.getZoom());
    $('#place-sub').textContent = S.loc && km(S.loc, { lat: c.lat, lng: c.lng }) < 15 ? placeName(c.lat, c.lng, 10) : 'orthodoxy.au';
    renderInView();
    renderJurisChips();
    clearTimeout(viewTimer);
    viewTimer = setTimeout(renderFeeds, 60);
  }
  function fitTo(ids) {
    const ps = [...ids].map(id => S.byId.get(id)).filter(p => p && isFinite(p.lat) && p.lat != null);
    if (!ps.length || !map) return;
    const near = S.loc ? ps.filter(p => km(S.loc, p) < 60) : [];
    const use = near.length >= 3 ? near : ps;
    const b = new maplibregl.LngLatBounds();
    use.forEach(p => b.extend([p.lng, p.lat]));
    map.fitBounds(b, { padding: 40, maxZoom: 13, duration: 600 });
  }

  // ── Full screen ───────────────────────────────────────────────────────

  function setFullscreen(on) {
    document.body.classList.toggle('map-full', on);
    $('#btn-fullscreen').setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
    setTimeout(() => map && map.resize(), 30);
    setTimeout(() => map && map.resize(), 320);
  }

  // ── Jurisdiction chips (above the viewport) ───────────────────────────

  function renderJurisChips() {
    const row = $('#juris-row');
    const counts = {};
    for (const p of S.parishes) if (!S.inView || S.inView.has(p.id)) counts[p.jurisdiction] = (counts[p.jurisdiction] || 0) + 1;
    row.innerHTML = JURIS_ORDER.map(j => {
      const on = S.juris === j;
      const n = counts[j] || 0;
      return `<button class="jchip${on ? ' on' : ''}${n ? '' : ' none'}" type="button" data-juris="${j}" style="--j:${jColor(j)}" aria-pressed="${on}">
          <span class="jdot"></span>${esc(JURIS[j].short)}<span class="jn">${n}</span></button>`;
    }).join('');
  }

  // ── The in-view chip: a count and up to seven logos ───────────────────

  function viewParishes() {
    return S.parishes.filter(p => (!S.inView || S.inView.has(p.id)) && parishPasses(p));
  }
  function renderInView() {
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

  // ── Active filters, said once under the map ───────────────────────────

  function renderActive() {
    const bits = [];
    if (S.focus) bits.push(`<button class="afchip" data-clear="focus">${esc(S.focus.title)} ${I.x}</button>`);
    if (S.f.group) bits.push(`<button class="afchip" data-clear="group">${esc(GROUPS.find(g => g.id === S.f.group).label)} ${I.x}</button>`);
    if (S.f.lang) bits.push(`<button class="afchip" data-clear="lang">${esc(S.f.lang)} ${I.x}</button>`);
    if (S.f.timesOnly) bits.push(`<button class="afchip" data-clear="timesOnly">With service times ${I.x}</button>`);
    if (S.f.list) { const l = listById(S.f.list); bits.push(`<button class="afchip" data-clear="list">${esc(l ? l.name : 'List')} ${I.x}</button>`); }
    const el = $('#active-filters');
    el.hidden = !bits.length;
    el.innerHTML = bits.join('');
    const n = (S.f.group ? 1 : 0) + (S.f.lang ? 1 : 0) + (S.f.timesOnly ? 1 : 0) + (S.f.list ? 1 : 0);
    const badge = $('#layers-badge');
    badge.hidden = !n;
    badge.textContent = n;
  }

  function refilter() {
    paintMap();
    renderInView();
    renderActive();
    renderFeeds();
  }

  // ── Today ─────────────────────────────────────────────────────────────

  function eventRow(e, { showDay = false, now = false } = {}) {
    const p = S.byId.get(e.parish_id);
    const l = local(e);
    const d = distOf(e.lat != null ? e : p);
    const title = e.feast ? `${e.title}` : e.title;
    return `<button class="erow${now ? ' now' : ''}" type="button" data-event="${esc(e.id)}">
        <span class="etime">${now ? '<i class="live"></i>Now' : esc(hm12(l.hm))}${showDay ? `<small>${esc(dayLabel(l.date))}</small>` : ''}</span>
        ${roundel(e.event_type)}
        <span class="ebody"><span class="etitle">${esc(title)}</span>
          <span class="esub">${avatar(p, 'xs')}<span>${esc(p ? p.name : e.parish_name || '')}</span>${d != null ? `<em>${esc(fmtKm(d))}</em>` : ''}</span>
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

  /** Curated slices — preset filters that open as a card of parishes. */
  function curated() {
    const P = S.parishes;
    const rules = (p) => rulesOf(p.id).filter(liveRule);
    const has = (p, pred) => rules(p).some(pred);
    return [
      { id: 'english', title: 'English services', kicker: 'For inquirers', blurb: 'Parishes that hold services in English, or put English first.',
        art: 'linear-gradient(135deg,#1d4ed8,#0ea5e9)', glyph: 'En', ids: P.filter(speaksEnglish).map(p => p.id) },
      { id: 'sunday', title: 'Sunday Liturgy', kicker: 'This Sunday', blurb: 'Every parish with a Sunday Liturgy on its timetable.',
        art: 'linear-gradient(135deg,#7c2d12,#d97706)', icon: 'L', kind: 'liturgy', ids: P.filter(p => has(p, r => r.event_type === 'liturgy' && r.day_of_week === 0)).map(p => p.id) },
      { id: 'vespers', title: 'Saturday Vespers', kicker: 'Saturday evening', blurb: 'Vespers and Vigils on Saturday evenings.',
        art: 'linear-gradient(135deg,#1e1b4b,#6d28d9)', icon: 'P', kind: 'prayer', ids: P.filter(p => has(p, r => r.event_type === 'prayer' && r.day_of_week === 6 && (r.start_time || '') >= '15:00')).map(p => p.id) },
      { id: 'weeknights', title: 'Weeknight services', kicker: 'After work', blurb: 'Services Monday to Friday, from late afternoon.',
        art: 'linear-gradient(135deg,#0f766e,#22c55e)', icon: 'P', kind: 'prayer', ids: P.filter(p => has(p, r => ['liturgy', 'prayer'].includes(r.event_type) && r.day_of_week >= 1 && r.day_of_week <= 5 && (r.start_time || '') >= '16:00')).map(p => p.id) },
      { id: 'talks', title: 'Talks & Bible studies', kicker: 'Learn', blurb: 'Catechism, Bible study and talks — the easiest way in.',
        art: 'linear-gradient(135deg,#78350f,#ca8a04)', icon: 'T', kind: 'talk', ids: P.filter(p => has(p, r => r.event_type === 'talk') || upcomingOneOffs(p.id).some(e => e.event_type === 'talk')).map(p => p.id) },
      { id: 'socials', title: 'Youth & socials', kicker: 'Meet people', blurb: 'Youth groups, festivals, meals and fundraisers.',
        art: 'linear-gradient(135deg,#9d174d,#f43f5e)', icon: 'S', kind: 'social', ids: P.filter(p => has(p, r => ['social', 'youth'].includes(r.event_type)) || upcomingOneOffs(p.id).some(e => ['social', 'youth'].includes(e.event_type))).map(p => p.id) },
      { id: 'monasteries', title: 'Monasteries', kicker: 'Pilgrimage', blurb: 'Monasteries and sketes, often a drive away and worth it.',
        art: 'linear-gradient(135deg,#3f3f46,#a8a29e)', glyph: '☦', ids: P.filter(p => /monaster|skete|convent/i.test(`${p.name} ${p.full_name || ''}`)).map(p => p.id) },
    ].filter(c => c.ids.length);
  }
  const LANGS = [
    ['Greek', 'Ελ', '#0061fe'], ['Arabic', 'عر', '#7c3bc1'], ['Serbian', 'Ср', '#cc2234'], ['Slavonic', 'Сл', '#d38301'],
    ['Romanian', 'Ro', '#4e7a27'], ['Macedonian', 'Мк', '#b92d5d'],
  ];
  function languageCollections() {
    return LANGS.map(([lang, glyph, color]) => ({
      id: 'lang-' + lang, title: lang, kicker: 'Language', lang, glyph, art: `linear-gradient(160deg,${color},${shade(color, -0.35)})`,
      blurb: `Parishes that pray in ${lang}.`,
      ids: S.parishes.filter(p => hasLang(p, lang)).map(p => p.id),
    })).filter(c => c.ids.length);
  }
  function jurisCollections() {
    return JURIS_ORDER.map(j => ({
      id: 'j-' + j, title: JURIS[j].long, kicker: 'Jurisdiction', juris: j, blurb: JURIS[j].blurb,
      art: `radial-gradient(120% 90% at 85% 10%, ${shade(jColor(j), 0.35)}, ${jColor(j)} 55%, ${shade(jColor(j), -0.4)})`,
      ids: S.parishes.filter(p => p.jurisdiction === j).map(p => p.id),
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
    const art = c.glyph ? `<span class="cglyph">${esc(c.glyph)}</span>`
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
    shelf($('#shelf-collections'), 'Collections', 'Ready-made slices, for a first visit or a new habit', remember(curated()).map(c => collCard(c)).join(''));
    shelf($('#shelf-languages'), 'By language', null, remember(languageCollections()).map(c => collCard(c, 'sm')).join(''));
    shelf($('#shelf-jurisdictions'), 'Jurisdictions', null, remember(jurisCollections()).map(c => collCard(c, 'wide')).join(''));
    renderLists();
  }
  function renderLists() {
    const ls = allLists().map(l => ({
      id: 'list-' + l.id, listId: l.id, title: l.name, kicker: l.fav ? 'Your list' : 'Your list',
      art: l.fav ? 'linear-gradient(160deg,#fde68a,#f59e0b)' : 'linear-gradient(160deg,#cbd5e1,#64748b)',
      glyph: l.fav ? '★' : '☰', ids: l.ids, blurb: l.fav ? 'Parishes you starred.' : 'A list you made.',
    }));
    remember(ls);
    shelf($('#shelf-lists'), 'Your lists', null,
      ls.map(c => collCard(c, 'sm')).join('') + `<button class="ccard sm new" type="button" data-newlist><span class="cart">${I.plus}</span><span class="ctext"><span class="ctitle">New list</span><span class="csub">Collect parishes</span></span></button>`);
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

  // ── The stream: every service and event, for as long as you scroll ────

  function renderStream() {
    const t = todayKey();
    const list = feedFor(S.streamDays).filter(e => eventPasses(e) && inViewEvent(e) && endMs(e) > Date.now());
    const byDay = new Map();
    for (const e of list) {
      const k = local(e).date;
      if (k < t) continue;
      if (!byDay.has(k)) byDay.set(k, []);
      byDay.get(k).push(e);
    }
    const out = [];
    for (let i = 0; i < S.streamDays; i++) {
      const k = addDays(t, i);
      const es = byDay.get(k) || [];
      if (!es.length) { out.push(`<div class="sday empty"><h3>${esc(dayLabel(k, true))}</h3><p>Nothing in view</p></div>`); continue; }
      out.push(`<div class="sday"><h3>${esc(dayLabel(k, true))}<span>${es.length}</span></h3>${es.map(e => eventRow(e)).join('')}</div>`);
    }
    $('#stream-days').innerHTML = out.join('');
    const n = S.inView ? viewParishes().length : S.parishes.length;
    $('#stream-sub').textContent = `${n} parishes in view, day by day. Keep scrolling.`;
  }
  async function growStream() {
    if (S.streamBusy || S.streamDays >= 365) return;
    S.streamBusy = true;
    const next = S.streamDays + 14;
    try {
      const to = new Date(Date.parse(addDays(todayKey(), next) + 'T14:00:00Z')).toISOString();
      await window.agoraBundle.load({ from: new Date().toISOString(), to });
      S.streamDays = next;
      renderStream();
    } catch (err) { console.warn(err); }
    S.streamBusy = false;
    if (S.streamDays >= 365) $('#stream-more').textContent = 'That’s a year. Come back closer to the time.';
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
  function pushSheet(html, cls = '') {
    const host = $('#sheets');
    const el = document.createElement('section');
    el.className = `sheet ${cls}`;
    el.setAttribute('role', 'dialog');
    el.innerHTML = html;
    host.appendChild(el);
    stack.push(el);
    $('#scrim').hidden = false;
    document.body.classList.add('sheet-open');
    requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add('open')));
    const scroller = el.querySelector('.sheet-scroll');
    if (scroller) scroller.addEventListener('scroll', () => el.classList.toggle('scrolled', scroller.scrollTop > 40), { passive: true });
    return el;
  }
  function popSheet() {
    const el = stack.pop();
    if (!el) return;
    el.classList.remove('open');
    setTimeout(() => el.remove(), 320);
    if (!stack.length) { $('#scrim').hidden = true; document.body.classList.remove('sheet-open'); }
  }
  function closeAll() { while (stack.length) popSheet(); }

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
  // differs between them (the days) is what the line lists.

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
  function timetable(pid, { compact = false } = {}) {
    const rs = rulesOf(pid).filter(liveRule);
    const lines = new Map();
    for (const r of rs) {
      const key = [r.title, r.event_type, r.start_time, r.end_time || '', qualifier(r), r.languages || ''].join('|');
      if (!lines.has(key)) lines.set(key, { r, days: [] });
      lines.get(key).days.push(r.day_of_week);
    }
    const byGroup = new Map();
    for (const l of lines.values()) {
      const g = groupOf(l.r.event_type);
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(l);
    }
    const firstDay = (l) => Math.min(...l.days.map(d => (d + 6) % 7));
    const out = [];
    for (const g of GROUPS) {
      const ls = byGroup.get(g.id);
      if (!ls) continue;
      ls.sort((a, b) => firstDay(a) - firstDay(b) || String(a.r.start_time).localeCompare(String(b.r.start_time)));
      const kinds = [...new Set(ls.map(l => l.r.event_type))];
      out.push(`<div class="tt-group${compact ? ' compact' : ''}">
          <div class="tt-gh"><span>${esc(g.label)}</span><span class="tt-rs">${kinds.map(k => roundel(k)).join('')}</span></div>
          ${ls.map(l => {
            const q = qualifier(l.r);
            const langs = parseLangs(l.r.languages);
            return `<div class="tt-line">${roundel(l.r.event_type)}
              <span class="tt-what"><b>${esc(l.r.title)}</b>${!compact && langs && langs.length ? `<small>${esc(langs.join(' · '))}</small>` : ''}</span>
              <span class="tt-when"><b>${esc(hm12(l.r.start_time))}${!compact && l.r.end_time ? `–${esc(hm12(l.r.end_time))}` : ''}</b><small>${esc((q ? q + ' ' : '') + dayList(l.days))}</small></span>
            </div>`;
          }).join('')}
        </div>`);
    }
    return out.join('');
  }
  function nextOf(pid, pred = () => true) {
    const now = Date.now();
    return feedFor(Math.max(S.streamDays, 14)).find(e => Date.parse(e.start_utc) > now && eventParishIds(e).includes(pid) && visible(e) && pred(e)) || null;
  }

  // ── The parish card ───────────────────────────────────────────────────

  function openParish(pid) {
    const p = S.byId.get(pid);
    if (!p) return;
    const d = distOf(p);
    const nextLit = nextOf(pid, e => e.event_type === 'liturgy') || nextOf(pid);
    const langs = parishLangs(p);
    const ones = upcomingOneOffs(pid).slice(0, 8);
    const hasTimes = rulesOf(pid).some(liveRule);
    const summary = [
      `<div class="sum"><small>${nextLit ? `Next ${esc(kindLabel(nextLit.event_type))}` : 'Next'}</small><b class="${nextLit ? 'ok' : ''}">${nextLit ? summaryWhen(nextLit) : '—'}</b></div>`,
      `<div class="sum"><small>Languages</small><b>${esc(langs.slice(0, 2).join(' · ') || '—')}</b></div>`,
      d != null ? `<div class="sum"><small>Distance</small><b>${esc(fmtKm(d))}</b></div>` : '',
      `<div class="sum"><small>Jurisdiction</small><b><span class="jdot" style="--j:${jColor(p.jurisdiction)}"></span>${esc(JURIS[p.jurisdiction]?.short || p.jurisdiction)}</b></div>`,
    ].join('');
    const dirs = `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;
    const html = `${glassBar(p.name, JURIS[p.jurisdiction]?.long)}
      <div class="sheet-scroll">
        <div class="ph">
          ${avatar(p, 'xl')}
          <div class="ph-text"><h1>${esc(p.full_name || p.name)}</h1><p>${esc(p.address || '')}</p></div>
        </div>
        <div class="actions">
          <a class="abtn primary" href="${esc(dirs)}" target="_blank" rel="noopener">${I.car}<span>${d != null ? esc(fmtKm(d)) : 'Directions'}</span></a>
          ${p.phone ? `<a class="abtn" href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">${I.phone}<span>Call</span></a>` : ''}
          ${p.website ? `<a class="abtn" href="${esc(p.website)}" target="_blank" rel="noopener">${I.globe}<span>Website</span></a>` : ''}
        </div>
        <div class="summary">${summary}</div>
        ${ones.length ? `<h2 class="sec">Coming up</h2><div class="shelf-row tight">${ones.map(e => `
          <button class="mini-poster" type="button" data-event="${esc(e.id)}">
            ${e.poster_path ? `<img src="${esc(e.poster_path)}" alt="" loading="lazy">` : `<span class="mp-ph">${roundel(e.event_type, true)}</span>`}
            <span><small>${esc(whenShort(e))}</small><b>${esc(e.title)}</b></span></button>`).join('')}</div>` : ''}
        <h2 class="sec">Service times</h2>
        ${hasTimes ? `<div class="tt">${timetable(pid)}</div>` : `<div class="tt-none">No service times on file yet.${p.website ? ` The parish website is the best place to check.` : ''}</div>`}
        <h2 class="sec">Details</h2>
        <div class="details">
          ${p.phone ? `<div class="drow"><small>Phone</small><a href="tel:${esc(p.phone.replace(/[^\d+]/g, ''))}">${esc(p.phone)}</a></div>` : ''}
          ${p.website ? `<div class="drow"><small>Website</small><a href="${esc(p.website)}" target="_blank" rel="noopener">${esc(p.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, ''))}</a></div>` : ''}
          ${p.email ? `<div class="drow"><small>Email</small><a href="mailto:${esc(p.email)}">${esc(p.email)}</a></div>` : ''}
          ${p.address ? `<div class="drow"><small>Address</small><span>${esc(p.address)}</span></div>` : ''}
          ${p.feast_day ? `<div class="drow"><small>Feast day</small><span>${esc(p.feast_day)}</span></div>` : ''}
        </div>
        <a class="wide-btn" href="/${esc((p.acronym || '').toLowerCase() || '')}" target="_blank" rel="noopener">Suggest an edit or claim this parish</a>
        <div class="toolbar-space"></div>
      </div>
      <div class="floatbar" role="toolbar">
        <button type="button" data-act="addlist" aria-label="Add to a list">${I.plus}</button>
        <button type="button" data-act="fav" class="${isFav(pid) ? 'on' : ''}" aria-label="Favourite" aria-pressed="${isFav(pid)}">${isFav(pid) ? I.starOn : I.star}</button>
        <button type="button" data-act="more" aria-label="More">${I.more}</button>
      </div>`;
    const el = pushSheet(html, 'parish');
    el.dataset.pid = pid;
    el.style.setProperty('--j', jColor(p.jurisdiction));
    // Bring it into the viewport without zooming the page's scope away.
    if (map && isFinite(p.lat) && !map.getBounds().contains([p.lng, p.lat])) map.easeTo({ center: [p.lng, p.lat], duration: 500 });
  }

  // ── A collection's card: a bunch of parishes, with their timetables ───

  function openCollection(c) {
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
          ${times ? `<div class="tt">${timetable(p.id, { compact: true })}</div>` : `<div class="tt-none sm">No service times on file yet.</div>`}
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
        <div class="clist">${ps.slice(0, LIMIT).map(item).join('') || '<div class="tt-none">Nothing here yet. Add parishes from their cards with +.</div>'}</div>
        ${ps.length > LIMIT ? `<button class="wide-btn" type="button" data-act="more-items">Show ${ps.length - LIMIT} more</button>` : ''}
      </div>`;
    const el = pushSheet(html, 'collection');
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
  function openEvent(id) {
    const e = findEvent(id);
    if (!e) return;
    const p = S.byId.get(e.parish_id);
    const l = local(e);
    const end = e.end_local ? e.end_local.slice(11, 16) : (e.end_utc ? partsIn(e.timezone || TZ, Date.parse(e.end_utc)).hm : null);
    const where = e.location_override || p?.address || '';
    const lat = e.lat ?? p?.lat, lng = e.lng ?? p?.lng;
    const html = `${glassBar(e.title, p ? p.name : '')}
      <div class="sheet-scroll">
        ${e.poster_path ? `<div class="ev-poster"><img src="${esc(e.poster_path)}" alt=""></div>` : `<div class="ev-band" style="--j:${jColor(p?.jurisdiction)}">${roundel(e.event_type, true)}</div>`}
        <div class="ev-head">
          <span class="ckicker">${esc(kindLabel(e.event_type))}${e.feast ? ` · ${esc(e.feast)}` : ''}</span>
          <h1>${esc(e.title)}</h1>
          <p class="ev-when">${esc(dayLabel(l.date, true))} · ${esc(hm12(l.hm))}${end ? `–${esc(hm12(end))}` : ''}</p>
        </div>
        <div class="actions">
          <a class="abtn primary" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}" target="_blank" rel="noopener">${I.car}<span>Directions</span></a>
          <button class="abtn" type="button" data-parish="${esc(e.parish_id)}">${avatar(p, 'xs')}<span>Parish</span></button>
          <button class="abtn" type="button" data-act="share">${I.share}<span>Share</span></button>
        </div>
        ${where ? `<div class="details"><div class="drow"><small>Where</small><span>${esc(where)}</span></div></div>` : ''}
        ${e.description ? `<div class="ev-desc">${esc(e.description).replace(/\n/g, '<br>')}</div>` : ''}
        <div class="toolbar-space sm"></div>
      </div>`;
    const el = pushSheet(html, 'event');
    el._event = e;
  }

  // ── The layers screen: every filter, in one place, away from the map ───

  function tile(attr, val, on, art, label) {
    return `<button class="tile${on ? ' on' : ''}" type="button" ${attr}="${esc(val)}" aria-pressed="${on}"><span class="tart">${art}</span><span class="tlabel">${esc(label)}</span></button>`;
  }
  function layersHTML() {
    const f = S.f;
    const kinds = [
      [null, 'Everything', `<span class="tstack">${roundel('liturgy')}${roundel('talk')}${roundel('social')}</span>`],
      ['services', 'Services', `<span class="tstack">${roundel('liturgy')}${roundel('prayer')}${roundel('feast')}</span>`],
      ['talks', 'Talks', roundel('talk', true)],
      ['socials', 'Socials', `<span class="tstack">${roundel('social')}${roundel('youth')}</span>`],
    ];
    const langs = [[null, 'Any', '<span class="tglyph">∗</span>'], ['English', 'English', '<span class="tglyph">En</span>'], ...LANGS.map(([l, g]) => [l, l, `<span class="tglyph">${esc(g)}</span>`])];
    const lists = allLists();
    return `<div class="lay-head"><h2>Filters</h2><button class="gbtn" type="button" data-act="close" aria-label="Close">${I.x}</button></div>
      <div class="sheet-scroll">
        <h3 class="lay-sec">Show</h3>
        <div class="tiles">${kinds.map(([v, l, a]) => tile('data-f-group', v || '', f.group === v, a, l)).join('')}</div>
        <h3 class="lay-sec">Language</h3>
        <div class="tiles">${langs.map(([v, l, a]) => tile('data-f-lang', v || '', f.lang === v, a, l)).join('')}</div>
        <h3 class="lay-sec">Parishes</h3>
        <div class="tiles">
          ${tile('data-f-times', '0', !f.timesOnly, '<span class="tglyph">◎</span>', 'All parishes')}
          ${tile('data-f-times', '1', f.timesOnly, roundel('liturgy', true), 'With service times')}
        </div>
        <h3 class="lay-sec">Your lists</h3>
        <div class="tiles">
          ${tile('data-f-list', '', !f.list, '<span class="tglyph">∗</span>', 'Any parish')}
          ${lists.map(l => tile('data-f-list', l.id, f.list === l.id, `<span class="tglyph">${l.fav ? '★' : '☰'}</span>`, `${l.name} (${l.ids.length})`)).join('')}
        </div>
        <div class="lay-foot">
          <button class="wide-btn ghost" type="button" data-act="reset">Reset</button>
          <button class="wide-btn solid" type="button" data-act="close">Show ${viewParishes().length} parishes</button>
        </div>
      </div>`;
  }
  function openLayers() { pushSheet(layersHTML(), 'layers'); }
  function repaintLayers() {
    const el = stack[stack.length - 1];
    if (!el || !el.classList.contains('layers')) return;
    const sc = el.querySelector('.sheet-scroll').scrollTop;
    el.innerHTML = layersHTML();
    el.querySelector('.sheet-scroll').scrollTop = sc;
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
        <button class="lrow" type="button" data-act="juris-of">${I.cross.replace('<svg', '<svg width="14" height="22"')}<span class="ln"><b>More ${esc(JURIS[p.jurisdiction]?.long || '')} parishes</b></span></button>
        <a class="lrow" href="/${esc((p.acronym || '').toLowerCase())}" target="_blank" rel="noopener">${I.chev}<span class="ln"><b>Open in the current app</b><small>Suggest an edit, claim the parish</small></span></a>
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
      addMe();
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
      if (k === 'focus') S.focus = null; else S.f[k] = k === 'timesOnly' ? false : null;
      refilter();
      return;
    }
    if (t.closest('#inview')) {
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
    if ((b = t.closest('[data-parish]'))) { openParish(b.dataset.parish); return; }
    if ((b = t.closest('[data-event]'))) { openEvent(b.dataset.event); return; }
    if ((b = t.closest('[data-jump]'))) { $('#stream').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }

    // The layers screen applies as you tap; the map is behind it.
    if ((b = t.closest('[data-f-group]'))) { S.f.group = b.dataset.fGroup || null; refilter(); repaintLayers(); return; }
    if ((b = t.closest('[data-f-lang]'))) { S.f.lang = b.dataset.fLang || null; refilter(); repaintLayers(); return; }
    if ((b = t.closest('[data-f-times]'))) { S.f.timesOnly = b.dataset.fTimes === '1'; refilter(); repaintLayers(); return; }
    if ((b = t.closest('[data-f-list]'))) { S.f.list = b.dataset.fList || null; refilter(); repaintLayers(); return; }

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
      if (a === 'reset') { S.f = { group: null, lang: null, timesOnly: false, list: null }; refilter(); repaintLayers(); return; }
      if (a === 'share') {
        if (top && top.dataset.pid) { const p = S.byId.get(top.dataset.pid); return share(p.name, '/' + (p.acronym || '').toLowerCase()); }
        if (top && top._event) return share(top._event.title, '/' + top._event.id);
        if (top && top._coll) return share(top._coll.title, '/next');
        return;
      }
      if (a === 'share-parish') { const p = S.byId.get(top.dataset.pid); return share(p.name, '/' + (p.acronym || '').toLowerCase()); }
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
        S.focus = { title: c.title, ids: new Set(c.ids) };
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
  $('#scrim').addEventListener('click', () => popSheet());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (stack.length) popSheet(); else if (document.body.classList.contains('map-full')) setFullscreen(false); } });
  $('#btn-fullscreen').addEventListener('click', () => setFullscreen(!document.body.classList.contains('map-full')));
  $('#btn-layers').addEventListener('click', openLayers);
  document.addEventListener('keydown', (e) => {
    // "/" opens search on a keyboard, as most sites do.
    if (e.key === '/' && !stack.length && !/input|textarea/i.test(document.activeElement?.tagName || '')) { e.preventDefault(); openSearch(); }
  });
  $('#btn-locate').addEventListener('click', locate);
  $('#place').addEventListener('click', locate);

  new IntersectionObserver((ents) => { if (ents.some(e => e.isIntersecting)) growStream(); }, { rootMargin: '600px' }).observe($('#stream-more'));

  // ── Boot ──────────────────────────────────────────────────────────────

  async function boot() {
    const t = todayKey();
    await window.agoraBundle.load({ from: new Date().toISOString(), to: new Date(Date.parse(addDays(t, 60) + 'T14:00:00Z')).toISOString() });
    S.parishes = window.agoraBundle.parishes();
    S.byId = new Map(S.parishes.map(p => [p.id, p]));
    S.rules = window.agoraBundle.schedules();
    S.rulesByParish = new Map();
    for (const r of S.rules) {
      if (!S.rulesByParish.has(r.parish_id)) S.rulesByParish.set(r.parish_id, []);
      S.rulesByParish.get(r.parish_id).push(r);
    }
    if (S.loc) document.body.classList.add('located');
    renderJurisChips();
    renderInView();
    renderActive();
    renderCollections();
    renderFeeds();
    initMap();
    // A link straight to a parish: /next#sgr
    const h = decodeURIComponent(location.hash.slice(1)).toLowerCase();
    if (h) { const p = S.parishes.find(x => (x.acronym || '').toLowerCase() === h || x.id === h); if (p) setTimeout(() => openParish(p.id), 300); }
  }
  boot().catch(err => {
    console.error(err);
    $('#today').innerHTML = `<div class="tempty">Couldn’t load the parishes. ${esc(err.message)}</div>`;
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
    if (!map) return;
    mapReady = false;
    map.setStyle(await (window.agoraNextBaseStyle || baseStyle)(), { diff: false });
    map.once('style.load', () => { addLayers(); paintMap(); });
  });
})();
