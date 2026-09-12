const TZ = 'Australia/Sydney';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LITURGICAL_TYPES = ['liturgy', 'prayer', 'feast', 'vespers', 'matins'];

// Archdiocese events page URLs
const ARCHDIOCESE_EVENTS = {
  antiochian: 'https://www.antiochian.org.au/events/list/',
  greek:      'https://greekorthodox.org.au/',
  serbian:    'https://soc.org.au/news/',
  russian:    'https://rocor.org.au/?cat=2',
  romanian:   'https://www.psmb.com.au/en',
  macedonian: 'https://macedonianorthodoxdiocese.org.au/en'
};

// Display-time type mapping: legacy DB types → display label
const TYPE_DISPLAY = { vespers: 'prayer', matins: 'prayer', festival: 'social', fundraiser: 'social' };

const state = {
  events: [],
  schedules: [],
  parishes: [],
  user: null,
  isAdmin: false,
  userLat: null,
  userLng: null,
  mode: 'events',
  _eventsExtended: false,
  _eventsShowCount: 30,
  _parishEventsShowCount: 30,
  // `location` is a region slug from /shared/locations.js ('qld', 'syd', 'nz'),
  // not the viewer's own position — that is locationActive/userLat below.
  filters: { jurisdiction: null, location: null, service: null, day: null, type: '', parishIds: null, socialOnly: false, englishOnly: false, englishStrict: false, showAllParishes: null, multiParish: false },
  parishFilters: { socialOnly: false, englishOnly: false, englishStrict: false },
  selectionMode: false,
  subdomainJurisdiction: null,
  locationActive: false,  // true once we have coords (set by either Near pill or Nearby sort)
  nearPillActive: false,  // true when Near pill is toggled on (sorts parish pills)
  eventsSort: 'time',  // 'time' | 'nearby'
  parishFocus: null,  // parish ID when focused, null when browsing
  // Rule focus inside the parish sheet: { scheduleId, slug }. Set by
  // /<acronym>/<service> and by tapping a schedule row; the sheet then pins
  // that rule's next occurrence and lists only its future recurrences. Kept
  // apart from filters.service, which is the feed-wide filter /liturgy sets —
  // one is "this rule at this parish", the other is "this kind of service".
  parishScheduleFocus: null,
  viewportParishIds: null,  // Set of parish IDs inside current map bounds; null until first moveend
  _dateFocus: null          // 'YYYY-MM-DD' when user has jumped to a specific date
};
// Expose so map.js's 'move' rAF-throttled handler can re-cluster without
// passing state through window-scoped callbacks.
window.agoraStateRef = state;

// Convert a UTC event timestamp to a Sydney-local ISO date string (YYYY-MM-DD)
const isoDateSyd = (utcStr) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(utcStr));

// Jump to a specific date in the events list stream.
window.setDateFocus = function(dateStr) {
  state._dateFocus = dateStr || null;
  renderEvents();
  if (dateStr) {
    requestAnimationFrame(() => {
      const el = document.querySelector(`.day-box[data-date="${dateStr}"], .day-section[data-date="${dateStr}"]`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }
};
window.clearDateFocus = function() {
  state._dateFocus = null;
  renderEvents();
};
window.openDatePicker = function(btn) {
  const picker = document.getElementById('date-focus-picker');
  if (!picker) return;
  const dates = (state.events || []).map(e => isoDateSyd(e.start_utc)).sort();
  const today = isoDateSyd(new Date().toISOString());
  picker.min = today;
  picker.max = dates[dates.length - 1] || today;
  picker.value = state._dateFocus || '';
  picker.onchange = () => { if (picker.value) window.setDateFocus(picker.value); };
  if (typeof picker.showPicker === 'function') {
    try { picker.showPicker(); return; } catch(e) { console.warn('[date-picker] showPicker failed:', e); }
  }
  picker.click();
};

// History flags — track whether we pushed a state entry so we know whether to call history.back()
let detailHistoryPushed = false;
let posterHistoryPushed = false;
// Guard: prevents syncURL() from writing while popstate is reading URL into state.
let _reconciling = false;

function loadMultiParishPref() {
  try { return localStorage.getItem('agoraParishPicker') === '1'; } catch { return false; }
}
function saveMultiParishPref(on) {
  try {
    if (on) localStorage.setItem('agoraParishPicker', '1');
    else localStorage.removeItem('agoraParishPicker');
  } catch {}
}

// ── Init ──
document.addEventListener('DOMContentLoaded', async () => {
  if (window.lsLog) window.lsLog('» DOM ready');
  const _layoutMql = window.matchMedia('(min-width: 1024px)');
  document.body.dataset.layout = _layoutMql.matches ? 'desktop' : 'mobile';
  window.agoraIsDesktop = () => _layoutMql.matches;
  _layoutMql.addEventListener('change', () => {
    document.body.dataset.layout = _layoutMql.matches ? 'desktop' : 'mobile';
    document.dispatchEvent(new CustomEvent('agora:layoutchange', { detail: { isDesktop: _layoutMql.matches } }));
    window.agoraMap?.resize?.();
  });
  state.filters.multiParish = loadMultiParishPref();
  detectUrlState();
  disablePageZoom();
  disablePullToRefresh();
  loadCachedLocation();
  if (window.lsProgress) window.lsProgress(0.15);
  await Promise.all([fetchParishes(), checkAdmin()]);
  _initLogout();
  applyParishSlugs();
  // Deep-link: /donate or /<juris>/donate opens the donation parish picker once
  // parishes are loaded. A bare slug+donate that reached the SPA (no link on
  // file) lands here too. Defer a tick so the first paint settles first.
  if (state._donateIntent) {
    delete state._donateIntent;
    setTimeout(() => openDonateDialog(state.filters.jurisdiction || null), 0);
  }
  initFilters(state);
  initModeBar();
  initBottomSheet();
  initParishSheet();
  initParishFilter();
  initSocialFilter();
  initEnglishFilter();
  initScheduleRowTaps();
  initFiltersMenu();
  initMultiParishToggle();
  initParishMultiToggle();
  initScrollFade(document.getElementById('mode-bar-row-pills'));
  // Juris banner + parish-pill row use a wrapper-with-overlays pattern;
  // classes go on the wrap, scroll listener attaches to the inner row.
  initScrollFade(
    document.getElementById('jurisdiction-chips'),
    document.getElementById('jurisdiction-banner-wrap')
  );
  initScrollFade(
    document.getElementById('parish-filter-row'),
    document.getElementById('parish-filter-row-wrap')
  );
  initResetFab();
  initLocationFab();
  initModeUrl();
  state._initialLoad = true;
  applyStartMode();
  updateArchdioceseEventsBanner();
  if (window.lsLog) window.lsLog('Initialising MapLibre…');
  initMap(state);
  updateMap(state);
  if (window.lsLog) window.lsLog('✓ map ready');
  if (window.lsProgress) window.lsProgress(0.9);

  // If the URL named a single parish (e.g. /gosr), open the parish sheet so
  // deep links and refreshes land on the parish card instead of just
  // filtering the main list. Defer past initMap's resize (100ms) so
  // the pan/zoom inside openParishSheet reads a real container size.
  if (state.parishFocus && state.parishSheetFocus !== state.parishFocus) {
    const focusPid = state.parishFocus;
    setTimeout(() => {
      if (window.agoraMap) window.agoraMap.resize();
      openParishSheet(focusPid, { replaceUrl: true });
    }, 150);
  }

  // Patch LIVE badges in place every minute. Was scheduleRenderEvents
  // before — full list re-render fired the events-pending fade animation
  // every 60s for any list with a parish_live_url event, which the user
  // saw as a random refresh. Now just iterate cards and update the badge
  // class + text. No render, no animation.
  setInterval(updateLiveBadgesInPlace, 60000);

  // Browser back button: poster first, then legacy parish-detail modal (flag-based,
  // not URL-backed), then reconcile state from the current URL. Every URL-backed
  // mutator pushes a history entry so back walks the full filter/mode history.
  window.addEventListener('popstate', () => {
    const fsEl = document.getElementById('poster-fullscreen');
    if (fsEl && !fsEl.classList.contains('hidden')) {
      posterHistoryPushed = false;
      closePosterFullscreenDOM();
      return;
    }
    if (detailHistoryPushed) {
      detailHistoryPushed = false;
      const panelEl = document.getElementById('event-detail');
      if (panelEl && !panelEl.classList.contains('hidden') && !state._openEventId) {
        closeDetailDOM();
        return;
      }
    }
    reconcileStateFromUrl();
  });
});

// ── Disable pinch/double-tap zoom on everything except the map ──
// The double-tap guard only fires for two STATIC taps within 300ms. A scroll
// gesture also ends in touchend, so blindly tracking every touchend as "last
// tap" caused the post-scroll click to be preventDefault-swallowed — taps
// felt dead for ~300ms after any list swipe. Fix: ignore touches that moved
// beyond a small threshold (i.e. scrolls/drags).
function disablePageZoom() {
  document.addEventListener('touchstart', e => {
    if (e.touches.length > 1 && !e.target.closest('#map')) {
      e.preventDefault();
    }
  }, { passive: false });

  let startX = 0, startY = 0, moved = false;
  document.addEventListener('touchstart', e => {
    if (e.touches.length === 1) {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      moved = false;
    }
  }, { passive: true });
  document.addEventListener('touchmove', e => {
    if (moved || !e.touches[0]) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;
    if (Math.abs(dx) > 10 || Math.abs(dy) > 10) moved = true;
  }, { passive: true });

  let lastTap = 0;
  document.addEventListener('touchend', e => {
    if (e.target.closest('#map')) return;
    if (moved) return;  // scroll/drag — neither records as a tap nor blocks the next one
    const now = Date.now();
    if (now - lastTap < 300) e.preventDefault();
    lastTap = now;
  }, { passive: false });
}

// ── Disable pull-to-refresh (iOS Safari ignores overscroll-behavior) ──
function disablePullToRefresh() {
  let touchStartY = 0;
  let touchStartX = 0;
  document.addEventListener('touchstart', e => {
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    const y = e.touches[0].clientY;
    const x = e.touches[0].clientX;
    const dy = y - touchStartY;
    const dx = x - touchStartX;

    // Only block vertical pull-down gestures
    if (Math.abs(dx) > Math.abs(dy)) return;

    const pullingDown = dy > 0;
    // With the bottom-sheet layout, document itself doesn't scroll.
    // Block pull-to-refresh only when the scroll ancestor under the finger is
    // at its top. Reading a hardcoded sheet element would falsely block
    // downward scroll inside other scrollable regions (parish sheet, drawer).
    if (!pullingDown) return;
    const scrollable = e.target.closest(
      '#parish-sheet-scroll, .detail-panel, #sheet-scroll'
    );
    if (scrollable && scrollable.scrollTop > 0) return;
    if (!scrollable) {
      const sheetScroll = document.getElementById('sheet-scroll');
      if (sheetScroll && sheetScroll.scrollTop > 0) return;
    }
    if (e.cancelable) e.preventDefault();
  }, { passive: false });
}

// ── URL state detection (subdomain soft-fallback + path parser) ──
const JURISDICTION_KEYS = ['antiochian', 'greek', 'serbian', 'russian', 'romanian', 'macedonian'];

// ── Location filter ──
// The registry is /shared/locations.js, loaded before this file. These three
// wrappers are all the rest of app.js needs, and they no-op safely if the
// script failed to load rather than taking the whole page down with a
// ReferenceError on the first parish drawn.
function resolveLocationSlug(slug) {
  const L = window.AgoraLocations;
  return L ? L.resolveLocation(slug) : null;
}
function activeLocation() {
  return state.filters.location ? resolveLocationSlug(state.filters.location) : null;
}
/** Is this parish inside the active location filter? True when none is set. */
function parishPassesLocation(parish) {
  const loc = activeLocation();
  if (!loc || !parish) return !loc;
  return window.AgoraLocations.locationMatchesParish(loc, parish);
}
/** Same question, for a row that carries a parish_id rather than a parish. */
function parishIdPassesLocation(parishId) {
  if (!state.filters.location) return true;
  const p = state.parishes.find(x => x.id === parishId);
  return p ? parishPassesLocation(p) : false;
}
function locationLabel() {
  const loc = activeLocation();
  return loc ? loc.label : '';
}

// ── Service filter ──
// Registry is /shared/services.js. Same guarded-wrapper shape as the location
// helpers above, for the same reason.
function resolveServiceSlug(slug) {
  const S = window.AgoraServices;
  return S ? S.resolveService(slug) : null;
}
function serviceOfRow(row) {
  const S = window.AgoraServices;
  return S ? S.serviceOf(row) : null;
}
function rowIsService(slug, row) {
  const S = window.AgoraServices;
  return S ? S.serviceMatches(slug, row) : true;
}
function serviceLabelFor(slug) {
  const S = window.AgoraServices;
  return S ? S.serviceLabel(slug) : String(slug || '');
}

function detectUrlState() {
  // Subdomain fallback — honoured while <juris>.orthodoxy.au redirects roll out
  const host = window.location.hostname;
  const subMatch = host.match(/^(antiochian|greek|serbian|russian|romanian|macedonian)\.orthodoxy\.au$/);
  if (subMatch) {
    state.subdomainJurisdiction = subMatch[1];
    state.filters.jurisdiction = subMatch[1];
  }

  const parts = decodeURIComponent(window.location.pathname)
    .toLowerCase().split('/').map(s => s.trim()).filter(Boolean);

  for (const seg of parts) {
    if (JURISDICTION_KEYS.includes(seg)) {
      state.filters.jurisdiction = seg;
    } else if (seg === 'social') {
      state.filters.socialOnly = true;
    } else if (seg === 'services') {
      state._startMode = 'services';
    } else if (seg === 'en') {
      state.filters.englishOnly = true;
      state.filters.englishStrict = true;
    } else if (seg === 'bilingual') {
      state.filters.englishOnly = true;
      state.filters.englishStrict = false;
    } else if (seg === 'donate') {
      // /donate, /<juris>/donate, or /<acronym>/donate that fell through the
      // server redirect (parish has no link on file) → open the picker dialog.
      state._donateIntent = true;
    } else if (/^\d+$/.test(seg) || /^\d+:\d{4}-\d{2}-\d{2}$/.test(seg)) {
      // integer (one-off) or synthetic schedule-instance id ("scheduleId:date")
      state._openEventId = seg;
    } else if (resolveDaySlug(seg) !== null) {
      // /wed, /wednesday — narrows a service to one day (/sgr/wed/liturgy) or
      // stands on its own (/wed, /wed/liturgy across the whole feed).
      state._daySlug = resolveDaySlug(seg);
    } else if (resolveServiceSlug(seg)) {
      // /liturgy on its own filters the feed. /smg/liturgy means the rule at
      // that parish instead — applyServiceFocus sorts out which once the
      // parish slug beside it has resolved.
      state._serviceSlug = resolveServiceSlug(seg).slug;
    } else if (resolveLocationSlug(seg)) {
      // /qld, /queensland, /syd, /nz … — composes with the jurisdiction, so
      // /qld/greek and /greek/queensland are the same view. Checked before the
      // parish-slug fallback below, which is why an acronym may not collide
      // with a location slug (the Worker refuses one that would).
      state.filters.location = resolveLocationSlug(seg).slug;
      state._fitLocation = true;
    } else if (seg.includes('+')) {
      state._parishSlugs = seg.split('+').map(s => s.trim()).filter(Boolean);
    } else {
      state._parishSlugs = [seg];
    }
  }

  // social + services are mutex — services wins
  if (state._startMode === 'services' && state.filters.socialOnly) {
    state.filters.socialOnly = false;
  }

  // A day or a service beside a parish is a schedule focus, not a feed
  // filter. The parish is still a slug at this point (ids arrive with the
  // parish list), so both are parked and applyServiceFocus finishes the job.
  const atOneParish = state._parishSlugs && state._parishSlugs.length === 1;
  if (state._serviceSlug || state._daySlug != null) {
    if (atOneParish) {
      state._pendingServiceFocus = state._serviceSlug || null;
      state._pendingDayFocus = state._daySlug != null ? state._daySlug : null;
    } else {
      if (state._serviceSlug) state.filters.service = state._serviceSlug;
      if (state._daySlug != null) state.filters.day = state._daySlug;
    }
  }
  delete state._serviceSlug;
  delete state._daySlug;
}

// The rules, loaded once. The events view never asks for them — only the
// services view and the parish sheet do — so anything that needs a rule
// outside those two has to say so.
let _schedulesPromise = null;
function ensureSchedulesLoaded() {
  if (state.schedules && state.schedules.length) return Promise.resolve(state.schedules);
  if (!_schedulesPromise) {
    _schedulesPromise = window.agoraBundle.load()
      .then(() => { state.schedules = window.agoraBundle.schedules() || []; return state.schedules; })
      .catch(() => [])
      .finally(() => { _schedulesPromise = null; });
  }
  return _schedulesPromise;
}

// Resolve /<acronym>/<day?>/<service?> to the rules it names, once parishes
// and schedules are both in hand.
//
// The URL names a KIND, so it focuses every rule of that kind: a parish with
// three liturgy rules under one /liturgy link shows all three, and the banner
// says "Showing Liturgies". A tapped row names one rule and focuses that one.
// Adding a day narrows the kind — /sgr/wed/liturgy is the Wednesday liturgy,
// and at most parishes that resolves to a single rule and reads back as the
// full sentence.
function applyServiceFocus() {
  const slug = state._pendingServiceFocus || null;
  const dow = state._pendingDayFocus != null ? state._pendingDayFocus : null;
  delete state._pendingServiceFocus;
  delete state._pendingDayFocus;
  if (!slug && dow == null) return;

  const parishId = state.parishFocus || state.parishSheetFocus;
  const rules = parishId ? matchingRules(parishId, slug, dow) : [];
  if (!rules.length) {
    // Nothing of that kind here, or no parish at all. Fall back to the
    // feed-wide reading rather than dropping the segments silently —
    // /sgr/vespers at a parish with no vespers rule should still say what it
    // was asked for.
    if (slug) state.filters.service = slug;
    if (dow != null) state.filters.day = dow;
    return;
  }
  setParishScheduleFocus(parishId, {
    ruleIds: rules.map(r => r.id), slug, dow, scope: 'kind',
  }, { silent: true });
}

/** This parish's rules of this kind, on this day. Either filter may be absent. */
function matchingRules(parishId, slug, dow) {
  return (state.schedules || []).filter(s =>
    s.parish_id === parishId
    && (!slug || rowIsService(slug, s))
    && (dow == null || s.day_of_week === dow));
}

/** Projected instances from now on, in time order. */
function upcomingOccurrences() {
  const now = Date.now();
  return (state.events || [])
    .filter(e => e.schedule_id != null && Date.parse(e.end_utc || e.start_utc) >= now)
    .sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
}

/** The soonest occurrence of any of these rules. */
function nextOccurrenceOfRules(ruleIds) {
  const ids = new Set(ruleIds);
  return upcomingOccurrences().find(e => ids.has(e.schedule_id)) || null;
}

// Enter the focus. Opens the parish sheet if it is not already the one
// showing, pins the next occurrence, narrows the sheet's feed and puts the
// "Showing …" banner between the service times and the list.
function setParishScheduleFocus(parishId, spec, opts = {}) {
  const ruleIds = (spec.ruleIds || []).filter(id => id != null);
  if (!parishId || !ruleIds.length) return;
  const only = ruleIds.length === 1 ? ruleIds[0] : null;
  const rule = only != null ? (state.schedules || []).find(s => s.id === only) : null;
  state.parishScheduleFocus = {
    ruleIds,
    // Set only when the focus is one rule — it is what the banner describes
    // in full and what the schedule panel emphasises.
    scheduleId: only,
    // The slug and the day are what the URL carries, and they record what was
    // ASKED, not what it happened to resolve to. /sgr/matins resolving to one
    // Sunday rule must not rewrite itself to /sgr/sun/matins: the parish
    // could add a Saturday matins tomorrow, and the link someone shared was
    // for matins, not for Sunday. A tapped row is the exception — that IS a
    // request for one rule, so its day and kind are written out so the link
    // comes back to the same row.
    //
    // A rule whose title names nothing the registry knows still focuses fine;
    // it just has no slug to write, so the URL falls back to the day alone
    // and the banner reads the rule's own title.
    slug: spec.slug || (spec.scope === 'rule' && rule ? serviceOfRow(rule) : null),
    dow: spec.dow != null ? spec.dow
      : (spec.scope === 'rule' && rule ? rule.day_of_week : null),
    scope: spec.scope || 'rule',
    title: rule ? (rule.title || '') : '',
  };
  const next = nextOccurrenceOfRules(ruleIds);
  state._openEventId = next ? next.id : null;
  if (state.parishSheetFocus !== parishId) {
    if (typeof openParishSheet === 'function') {
      openParishSheet(parishId, { focusEventId: state._openEventId, noServiceFocus: true });
    }
  } else if (typeof renderParishSheetContent === 'function') {
    renderParishSheetContent(parishId, { fullRender: true, focusEventId: state._openEventId });
  }
  if (!opts.silent && typeof syncURL === 'function') syncURL();
}

/** Focus exactly one rule — what tapping a schedule row means. */
function focusScheduleRule(parishId, scheduleId) {
  setParishScheduleFocus(parishId, { ruleIds: [scheduleId], scope: 'rule' });
}

/** Leave the focus, keeping the parish sheet open. */
function clearParishScheduleFocus(opts = {}) {
  if (!state.parishScheduleFocus) return;
  state.parishScheduleFocus = null;
  state._openEventId = null;
  const pid = state.parishSheetFocus;
  if (pid && typeof renderParishSheetContent === 'function') {
    renderParishSheetContent(pid, { fullRender: true });
  }
  if (!opts.silent && typeof syncURL === 'function') syncURL();
}
window.focusScheduleRule = focusScheduleRule;
window.setParishScheduleFocus = setParishScheduleFocus;
window.clearParishScheduleFocus = clearParishScheduleFocus;

// Back-compat shim — older call sites may still reference detectSubdomain
function detectSubdomain() { return detectUrlState(); }

// Resolve parish slugs (single or plus-joined) to parish IDs after parishes load.
// Single slug: set parishFocus only — the parish card owns that scope, so
// neither jurisdiction nor the events/schedules list filter is touched.
// Multi slug: still drives the picker (parishIds + multiParish) since that's
// the mode that surfaces them; jurisdiction only flips if URL carried it.
function applyParishSlugs() {
  if (!state._parishSlugs || !state._parishSlugs.length) return;
  const slugs = state._parishSlugs;
  const norm = s => (s || '').toLowerCase().replace(/\s+/g, '');
  const resolved = [];
  for (const slug of slugs) {
    const match = state.parishes.find(p => {
      if (p.id === '_unassigned') return false;
      return p.acronym && norm(p.acronym) === norm(slug);
    });
    if (match) resolved.push(match);
    else console.warn('applyParishSlugs: no parish for slug', slug);
  }
  if (!resolved.length) {
    delete state._parishSlugs;
    return;
  }
  // Single slug in services mode → main services list filtered to that parish
  // (no parish card). Single slug in any other mode → parish card focus.
  // Multi slug (any mode) → main list with multi-parish filter, no card.
  const servicesMode = state._startMode === 'services';
  if (resolved.length === 1 && !servicesMode) {
    state.parishFocus = resolved[0].id;
  } else if (resolved.length === 1) {
    state.filters.parishIds = new Set([resolved[0].id]);
  } else {
    state.filters.parishIds = new Set(resolved.map(p => p.id));
    state.filters.multiParish = true;
  }
  delete state._parishSlugs;
}

// Back-compat shim
function applyParishSlug() { return applyParishSlugs(); }

// Build URL path segments from current state. When includeEventId is true the
// open event's id is appended — this form is what the browser URL carries so
// the back button can walk through open/close transitions. The share-URL form
// (what the on-page URL chip displays and the chip-copy action writes) drops
// the id: viewers want to share the object they're looking at, not the exact
// modal-open moment. Browser URL and chip URL diverge on purpose.
function buildPathSegs(opts = {}) {
  if (!state || !state.filters) return [];
  const segs = [];
  if (state.filters.jurisdiction && state.filters.jurisdiction !== state.subdomainJurisdiction) {
    segs.push(state.filters.jurisdiction);
  }
  // Always the canonical short slug, so /greek/queensland reads back as
  // /greek/qld and a shared link has one spelling.
  if (state.filters.location) segs.push(state.filters.location);
  // The feed-wide service filter. A rule focus writes its slug after the
  // parish instead — see below — because /smg/liturgy has to read in that
  // order to mean "the liturgy at St Michael & Gabriel".
  if (state.filters.day != null && !state.parishScheduleFocus) {
    segs.push(daySlugFor(state.filters.day));
  }
  if (state.filters.service && !state.parishScheduleFocus) segs.push(state.filters.service);
  if (state.mode === 'services' && !state.parishSheetFocus) segs.push('services');
  else if (state.filters.socialOnly) segs.push('social');
  const psfId = state.parishSheetFocus;
  const psfParish = psfId ? state.parishes.find(x => x.id === psfId) : null;
  let parishSegWritten = false;
  if (psfParish && psfParish.acronym) {
    segs.push(psfParish.acronym.toLowerCase().replace(/\s+/g, ''));
    parishSegWritten = true;
  } else if (state.filters.parishIds && state.filters.parishIds.size) {
    const acrs = [...state.filters.parishIds].map(pid => {
      const p = state.parishes.find(x => x.id === pid);
      return p && p.acronym ? p.acronym.toLowerCase().replace(/\s+/g, '') : null;
    }).filter(Boolean);
    if (acrs.length === 1) segs.push(acrs[0]);
    else if (acrs.length > 1) segs.push(acrs.join('+'));
  }
  // Schedule focus, immediately after the parish it belongs to, day first:
  // /sgr/wed/liturgy reads in the order it is spoken.
  // Only when the parish itself made it into the path. Most parishes have no
  // acronym yet, and /sun/matins without one in front does not mean "this
  // parish's Sunday matins" — it means every Sunday matins in the country.
  if (state.parishScheduleFocus && parishSegWritten) {
    const f = state.parishScheduleFocus;
    // There is no segment for "rule 24", so a focus is written as the day and
    // service that name it. A tapped row whose title the registry does not
    // recognise writes only its day, and comes back as every rule that day.
    const daySeg = f.dow != null ? daySlugFor(f.dow) : null;
    if (daySeg) segs.push(daySeg);
    if (f.slug) segs.push(f.slug);
  }
  if (state.filters.englishOnly) {
    segs.push(state.filters.englishStrict ? 'en' : 'bilingual');
  }
  // The focused occurrence is already named by the parish + service pair, and
  // appending its id as well would make the shared link point at one date
  // rather than at "the next one" — which is the thing being linked to.
  if (opts.includeEventId && state._openEventId && !state.parishScheduleFocus) {
    segs.push(String(state._openEventId));
  }
  return segs;
}
window.agoraBuildPathSegs = buildPathSegs;

// Write current filter/mode/detail state back to the URL. Defaults to
// pushState so every mutator creates a history entry (back button walks
// through filter changes AND event open/close). Pass { replace: true } for
// initial canonicalization and for repair writes that shouldn't create entries.
function syncURL(opts = {}) {
  if (!state || !state.filters) return;
  // During popstate reconciliation we're reading the URL into state, not the
  // reverse — writing would fight the history stack and risk loops.
  if (_reconciling) return;

  // Browser URL includes event-id so back-button closes the drawer via the
  // popstate reconciler. Page-facing chip (updateModeUrl / updateParishSheetUrl)
  // builds its own share-form URL without the id.
  const segs = buildPathSegs({ includeEventId: true });
  const path = '/' + segs.join('/');
  const target = path + window.location.search + window.location.hash;
  // Dedupe — skip writes when URL already matches (avoids redundant history entries
  // when callers chain mutators that converge on the same URL).
  if (target === window.location.pathname + window.location.search + window.location.hash) return;
  try {
    if (opts.replace) history.replaceState({}, '', target);
    else history.pushState({ url: target }, '', target);
  } catch {}
  if (typeof updateModeUrl === 'function') updateModeUrl();
  if (typeof updateParishSheetUrl === 'function') updateParishSheetUrl();
}
window.agoraSyncURL = syncURL;

// Re-read the URL and bring app state + UI into agreement. Called from popstate
// so every back-navigation (filter change, parish focus, mode toggle, event open,
// etc.) lands on the expected prior view. Inverse of syncURL.
async function reconcileStateFromUrl() {
  _reconciling = true;
  try {
    // 1) Reset URL-driven state (preserve location, time range, sort — not in URL)
    state.filters.jurisdiction = null;
    state.filters.location = null;
    state.filters.service = null;
    state.filters.day = null;
    state.parishScheduleFocus = null;
    state.filters.parishIds = null;
    state.filters.multiParish = loadMultiParishPref();
    state.filters.socialOnly = false;
    state.filters.englishOnly = false;
    state.filters.englishStrict = false;
    state.filters.showAllParishes = null;
    state.parishFocus = null;
    const prevOpenId = state._openEventId || null;
    const prevMode = state.mode;
    delete state._openEventId;
    delete state._startMode;
    delete state._parishSlugs;
    delete state._fitLocation;
    delete state._serviceSlug;
    delete state._daySlug;
    delete state._pendingServiceFocus;
    delete state._pendingDayFocus;

    // 2) Re-parse URL into state
    detectUrlState();
    applyParishSlugs();
    if (state._pendingServiceFocus || state._pendingDayFocus != null) await ensureSchedulesLoaded();
    applyServiceFocus();
    const targetMode = state._startMode === 'services' ? 'services' : 'events';
    delete state._startMode;

    // 3) Sync mode (services ↔ events view + active class)
    const servicesBtn = document.getElementById('btn-services');
    if (targetMode !== prevMode) {
      state.mode = targetMode;
      if (targetMode === 'services') {
        servicesBtn.classList.add('active');
        showView('services');
      } else {
        servicesBtn.classList.remove('active');
        showView('events');
      }
    }

    // 4) Jurisdiction chips
    const chipContainer = document.getElementById('jurisdiction-chips');
    if (chipContainer) {
      chipContainer.querySelectorAll('.jurisdiction-chip').forEach(c => {
        c.classList.toggle('active', c.dataset.jurisdiction === state.filters.jurisdiction);
      });
      if (typeof applyChipColors === 'function') applyChipColors(chipContainer);
    }

    // 5) Parish row + pills
    if (typeof syncParishRowVisibility === 'function') syncParishRowVisibility();
    if (typeof renderParishPills === 'function') renderParishPills();

    // 5b) Parish sheet mirrors the URL: single-parish URL (parishFocus set)
    // opens the sheet; no-parish / multi-parish URL closes it. Skip when
    // already open for same parish so popstate doesn't replay the animation.
    const urlParish = state.parishFocus || null;
    if (urlParish && state.parishSheetFocus !== urlParish) {
      if (typeof openParishSheet === 'function') openParishSheet(urlParish);
    } else if (!urlParish && state.parishSheetFocus) {
      if (typeof closeParishSheet === 'function') closeParishSheet();
    }

    // 6) Filter menu items + derived UI
    const socialBtn = document.getElementById('btn-social');
    if (socialBtn) socialBtn.classList.toggle('active', !!state.filters.socialOnly);
    if (typeof syncEnglishButton === 'function') syncEnglishButton();
    if (typeof syncMultiParishButton === 'function') syncMultiParishButton();
    if (typeof syncFiltersButton === 'function') syncFiltersButton();
    if (typeof syncResetFab === 'function') syncResetFab();
    if (typeof updateArchdioceseEventsBanner === 'function') updateArchdioceseEventsBanner();

    // 7) Detail: open if URL has a new ID; close if URL dropped the ID.
    // "Open" now means either the inline card drawer is expanded, or (legacy)
    // the parish-detail modal is showing.
    const panelEl = document.getElementById('event-detail');
    const modalOpen = panelEl && !panelEl.classList.contains('hidden');
    const inlineOpen = !!document.querySelector('.event-card.expanded');
    const panelOpen = modalOpen || inlineOpen;
    const nextOpenId = state._openEventId || null;

    // 8) Refetch data (URL filter change → different result set). A URL that
    // carries a location re-frames the map on it, so stepping back to
    // /greek/qld puts Queensland in view again rather than leaving the map
    // wherever the forward navigation left it.
    const refit = !!state._fitLocation;
    delete state._fitLocation;
    if (state.mode === 'services') window.agoraFetchSchedules({ fit: refit });
    else window.agoraFetchEvents({ fit: refit });

    if (nextOpenId && nextOpenId !== prevOpenId) {
      // Show the requested event. showEventDetail will re-set state._openEventId
      // and call syncURL — guarded by _reconciling, which we keep true through
      // the await so the URL stays exactly what the user navigated back to.
      delete state._openEventId;
      await openEventFromUrl(nextOpenId);
    } else if (!nextOpenId && panelOpen) {
      // Three close cases. Priority order matters:
      //   1. Pinned event in parish sheet + URL still has the same parish →
      //      drop just the event, keep the sheet (re-render without focus).
      //   2. Any expanded card in parish sheet (incl. stream items, or URL
      //      no longer references the parish) → close the sheet entirely.
      //   3. Otherwise the expanded card is in the main list → collapse it.
      const pinnedOpen = !!document.querySelector('.ps-pinned-event .event-card.expanded');
      const parishSheetOpenCard = !!document.querySelector(
        '#parish-sheet-scroll .event-card.expanded'
      );
      const psfInUrl = state.parishSheetFocus && state.filters.parishIds
        && state.filters.parishIds.has(state.parishSheetFocus);
      if (pinnedOpen && psfInUrl && typeof renderParishSheetContent === 'function') {
        renderParishSheetContent(state.parishSheetFocus, {});
      } else if (parishSheetOpenCard && typeof closeParishSheet === 'function') {
        closeParishSheet();
      } else {
        closeDetailDOM();
      }
    }
  } finally {
    _reconciling = false;
  }
}

// Recenter map on user location — used by location FAB, Near pill, Nearby sort
function centerMapOnUser() {
  if (!window.agoraMap || state.userLat == null || state.userLng == null) return;
  const map = window.agoraMap;
  const currentZoom = map.getZoom();
  const targetZoom = Math.max(currentZoom, 13);
  // Place user at the visual centre of the visible map (above the SNAP_HALF sheet).
  const snapHalf = window.agoraSnapHalf ? window.agoraSnapHalf() : window.innerHeight * 0.5;
  const container = map.getContainer();
  const targetX = container.clientWidth / 2;
  const targetY = snapHalf / 2;
  // Project at current zoom, then scale offset by the zoom delta so the
  // post-fly position lands the user dot at (targetX, targetY).
  const userPx = map.project([state.userLng, state.userLat]);
  const scale = Math.pow(2, targetZoom - currentZoom);
  const dx = (container.clientWidth / 2 - targetX) / scale;
  const dy = (container.clientHeight / 2 - targetY) / scale;
  const newCentre = map.unproject([userPx.x + dx, userPx.y + dy]);
  map.flyTo({ center: [newCentre.lng, newCentre.lat], zoom: targetZoom, duration: 900 });
}

// Compute viewport parish set from a STABLE visible-rectangle cutoff.
//
// The cutoff is fixed at the bottom-sheet's HALF snap (or the parish-
// sheet's HALF when the parish card is open) regardless of where the
// sheet currently sits. Without this, sheet snap changes change the
// "visible" rect → recompute → events list refresh — the user sees the
// list rebuild every time they drag the sheet between PEEK/HALF/FULL.
//
// Pinning to HALF means the parish set only changes when the user
// actually pans the map, not when they resize the sheet.
function recomputeViewportSet() {
  if (!window.agoraMap) return;
  const m = window.agoraMap;
  const container = m.getContainer();
  const w = container.clientWidth;
  const h = container.clientHeight;
  const isDesktop = window.agoraIsDesktop?.() ?? false;
  const ids = new Set();

  if (isDesktop) {
    // Side-sheet covers the right 420px column. Map area = the rest.
    // Pixel-space test handles any map projection cleanly.
    const SHEET_W = 420;
    const xMax = Math.max(1, w - SHEET_W);
    for (const p of state.parishes) {
      if (!p || p.id === '_unassigned' || p.lat == null || p.lng == null) continue;
      const px = m.project([p.lng, p.lat]);
      if (px.x >= 0 && px.x <= xMax && px.y >= 0 && px.y <= h) ids.add(p.id);
    }
  } else {
    // Mobile: circle centred on the visible-map midpoint (above the
    // sheet at HALF), radius reaches just past the visible corners.
    // Pinning to HALF means snap drags between PEEK/HALF/FULL don't
    // change the parish set — only actual map pans do.
    let half;
    if (window.agoraParishSheetVisible) {
      half = Math.round(h * 0.5);
    } else if (typeof window.agoraSnapHalf === 'function') {
      half = window.agoraSnapHalf();
    } else {
      half = Math.round(h * 0.5);
    }
    if (half <= 0) half = Math.round(h * 0.5);
    const cx = w / 2;
    const cy = half / 2;
    const radiusPx = Math.hypot(w / 2, half / 2) * 1.15;
    const r2 = radiusPx * radiusPx;
    for (const p of state.parishes) {
      if (!p || p.id === '_unassigned' || p.lat == null || p.lng == null) continue;
      const px = m.project([p.lng, p.lat]);
      const dx = px.x - cx;
      const dy = px.y - cy;
      if (dx * dx + dy * dy <= r2) ids.add(p.id);
    }
  }

  state.viewportParishIds = ids;
}

// Map-phase: cheap-ish work that should track the map closely — viewport
// recompute, marker redraw (cluster), in-view chip, pill re-sort. Runs
// 200ms after gesture-end via map.js's debounce.
function onViewportMapPhase() {
  recomputeViewportSet();
  if (typeof updateMap === 'function') updateMap(state);
  renderParishPills();
  if (typeof renderInViewChip === 'function') renderInViewChip();
  if (typeof syncResetFab === 'function') syncResetFab();
}

// List-phase: events/services list innerHTML rebuild. Heavy. Runs 800ms
// after gesture-end so a quick follow-up pan preempts it via movestart.
// scheduleRenderEvents adds a second gate: the actual DOM work waits for
// a genuine idle window so an in-progress gesture can't be interrupted.
// Skip while a drawer is open: rebuilding the list tears down and recreates
// the expanded card, which the user perceives as a flash ~1s after the
// sheet snaps (sheet's map.resize fires moveend → 800ms list-phase).
function onViewportListPhase() {
  recomputeViewportSet();
  // Sheet snap → moveend → listPhase fires ~800ms later. The sheet
  // didn't change the parish set (stable cutoff), so neither render
  // nor applied-animation should fire. The flag is set on snap and
  // checked here with a generous 1100ms window.
  const recentSheetSnap = window.__agoraSheetSnapAt
    && (Date.now() - window.__agoraSheetSnapAt) < 1100;
  if (recentSheetSnap) return;
  // If a drawer is open we still need to release any pending state
  // markEventsPending fired on movestart — otherwise the list stays in
  // the dim/saturated state forever.
  if (document.querySelector('.event-card.expanded')) {
    if (typeof markEventsApplied === 'function') markEventsApplied();
    return;
  }
  // If the parish set didn't actually change, skip the heavy re-render
  // but still release pending so the list unfades.
  const sig = state.viewportParishIds
    ? [...state.viewportParishIds].sort((a, b) => a - b).join(',')
    : '';
  if (sig === state._lastViewportSig) {
    if (typeof markEventsApplied === 'function') markEventsApplied();
    return;
  }
  state._lastViewportSig = sig;
  if (state.mode === 'services') renderServices(); else scheduleRenderEvents();
}

window.agoraOnViewportMapPhase = onViewportMapPhase;
window.agoraOnViewportListPhase = onViewportListPhase;

// Centre of the *visible* map rectangle — i.e. the part above the bottom
// sheet. Distance-from-centre sort lives or dies on this number: when the
// sheet is at SNAP_HALF, map.getCenter() (full container centre) sits behind
// the sheet, well below where the user is actually looking. By measuring
// from the midpoint of [0, sheetTopY] we anchor on the visible epicentre.
function visibleCentreLatLng() {
  if (!window.agoraMap) return null;
  const m = window.agoraMap;
  const container = m.getContainer();
  const w = container.clientWidth;
  const h = container.clientHeight;
  // Stable centre — always anchored at the HALF cutoff, not the live
  // sheetY. Same reason as recomputeViewportSet: sheet snap changes
  // shouldn't trigger viewport-driven re-renders.
  let cutoffY;
  if (window.agoraParishSheetVisible) {
    cutoffY = Math.round(h * 0.5);
  } else if (typeof window.agoraSnapHalf === 'function') {
    cutoffY = window.agoraSnapHalf();
  } else {
    cutoffY = Math.round(h * 0.5);
  }
  return m.unproject([w / 2, cutoffY / 2]);
}
window.agoraVisibleCentre = visibleCentreLatLng;

// Find the nearest parish (to user or map centre) that satisfies a predicate.
// Used by the empty-state CTAs: "show nearest parish" = any parish;
// "find nearest matching" = one whose events survive the current filters.
function findNearestParishWhere(predicate) {
  const vc = !state.locationActive ? visibleCentreLatLng() : null;
  const originLat = state.locationActive ? state.userLat
    : (vc ? vc.lat : state.userLat);
  const originLng = state.locationActive ? state.userLng
    : (vc ? vc.lng : state.userLng);
  let best = null;
  let bestKm = Infinity;
  for (const p of state.parishes) {
    if (!p || p.id === '_unassigned' || p.lat == null || p.lng == null) continue;
    if (!predicate(p)) continue;
    const km = haversineKm(originLat, originLng, p.lat, p.lng);
    if (km < bestKm) { bestKm = km; best = p; }
  }
  return best;
}

// Handlers for empty-state CTA buttons. Widen the map to include the nearest
// (matching) parish and the origin; the moveend hook will re-compute the
// viewport set and the list will repopulate.
function handleEmptyStateCta(action) {
  const matchingPred = p => state.events.some(e =>
    (e.parish_id === p.id || (e.extra_parishes && e.extra_parishes.includes(p.id)))
  );
  const passesNonViewport = p => applyNonViewportFilters(
    state.events.filter(e => e.parish_id === p.id || (e.extra_parishes && e.extra_parishes.includes(p.id)))
  ).length > 0;

  let target = null;
  if (action === 'show-nearest-parish') target = findNearestParishWhere(matchingPred);
  else if (action === 'find-matching-parish') target = findNearestParishWhere(passesNonViewport);
  if (!target) return;

  const vc2 = !state.locationActive ? visibleCentreLatLng() : null;
  const originLat = state.locationActive ? state.userLat
    : (vc2 ? vc2.lat : state.userLat);
  const originLng = state.locationActive ? state.userLng
    : (vc2 ? vc2.lng : state.userLng);
  if (window.agoraMap) {
    const bounds = window.agoraPadBounds(
      window.agoraBoundsFromPoints([{ lat: originLat, lng: originLng }, { lat: target.lat, lng: target.lng }]),
      0.25
    );
    window.agoraMap.fitBounds(bounds, { maxZoom: 13, duration: 600 });
  }
}
window.agoraEmptyStateCta = handleEmptyStateCta;

// Build the empty-state block with a context-aware CTA. Three branches:
// - viewport holds no parishes → offer to jump to the nearest one
// - viewport holds parishes but social/english filter wipes all their events
//   → offer to jump to the nearest parish that satisfies those filters
// - neither (true empty / all-parish jurisdiction filter with no events)
//   → static ornament only, no CTA
function renderEmptyStateHTML() {
  const explicitParish = !!state.filters.parishIds;
  const viewportVisible = state.viewportParishIds instanceof Set;
  const viewportEmpty = viewportVisible && state.viewportParishIds.size === 0 && !explicitParish;

  let filtersExcluding = false;
  if (!viewportEmpty && viewportVisible && !explicitParish
      && (state.filters.socialOnly || state.filters.englishOnly)) {
    const vp = state.viewportParishIds;
    const eventsInViewport = state.events.filter(e =>
      vp.has(e.parish_id) || (e.extra_parishes && e.extra_parishes.some(pid => vp.has(pid)))
    );
    filtersExcluding = eventsInViewport.length > 0 && applyNonViewportFilters(eventsInViewport).length === 0;
  }

  let headline = 'Nothing upcoming';
  let cta = '';
  if (viewportEmpty) {
    headline = 'No parishes in this area';
    cta = `<button class="empty-state-cta" data-cta="show-nearest-parish" type="button">Show nearest parish</button>`;
  } else if (filtersExcluding) {
    const label = state.filters.socialOnly ? 'socials' : 'English-friendly services';
    headline = `No ${label} in this area`;
    cta = `<button class="empty-state-cta" data-cta="find-matching-parish" type="button">Find nearest match</button>`;
  }
  return `<div class="empty-state"><span class="empty-ornament">✦</span><h3>${esc(headline)}</h3>${cta}</div>`;
}

// Delegate empty-state CTA clicks — fires on either services-list or events
// container since both host the empty-state block.
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-cta]');
  if (!btn) return;
  handleEmptyStateCta(btn.dataset.cta);
});

// ── Geolocation ──
function loadCachedLocation() {
  const cached = localStorage.getItem('agora_location');
  if (cached) {
    const loc = JSON.parse(cached);
    state.userLat = loc.lat;
    state.userLng = loc.lng;
    state.locationActive = true;
  }
}

function requestGeolocation(callback) {
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(
    pos => {
      state.userLat = pos.coords.latitude;
      state.userLng = pos.coords.longitude;
      localStorage.setItem('agora_location', JSON.stringify({ lat: state.userLat, lng: state.userLng }));
      state.locationActive = true;
      if (window.agoraUpdateUserLocation) window.agoraUpdateUserLocation(state.userLat, state.userLng);
      // Always re-fetch events with fresh coords so distance_km is current
      fetchEvents().then(() => {
        if (callback) callback();
        else {
          renderParishPills();
          renderCurrentView();
        }
      });
    },
    () => { alert('Location access denied. Enable it in your browser settings.'); },
    { timeout: 8000, maximumAge: 300000 }
  );
}

// ── API ──
async function fetchEvents(opts = {}) {
  const params = new URLSearchParams();
  if (state.userLat != null) params.set('lat', state.userLat);
  if (state.userLng != null) params.set('lng', state.userLng);
  if (state.filters.type) params.set('type', state.filters.type);
  if (state.filters.jurisdiction) params.set('jurisdiction', state.filters.jurisdiction);

  const now = new Date();
  // Include events from start of today (Sydney local) through 60 days out by default,
  // 180 days when extended. Round `to` to end of UTC day so the URL is stable within
  // the day and browser cache can hit on repeat loads.
  const sydneyDate = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [d, m, y] = sydneyDate.split('/');
  const todayStr = `${y}-${m}-${d}`;
  const startLocal = new Date(`${todayStr}T00:00:00`);
  const testDate = new Date(`${todayStr}T12:00:00Z`);
  const sydneyStr = testDate.toLocaleString('en-US', { timeZone: TZ });
  const sydneyParsed = new Date(sydneyStr);
  const offsetMs = sydneyParsed.getTime() - testDate.getTime();
  params.set('from', new Date(startLocal.getTime() - offsetMs).toISOString());
  if (!opts.extended) { state._eventsExtended = false; state._eventsShowCount = 30; }
  const windowDays = opts.extended ? 180 : 60;
  const toDate = new Date(now.getTime() + windowDays * 86400000);
  toDate.setUTCHours(23, 59, 59, 0);
  params.set('to', toDate.toISOString());

  if (window.lsLog) window.lsLog(`GET /api/bundle (+${windowDays}d window, projected locally) …`);
  try {
    // The API returns RULES, not instances. agoraBundle projects them here with
    // the same /shared/ modules the Worker uses. state.events keeps its shape:
    // one flat array, ids stringified — schedule instances carry a synthetic
    // string id ("scheduleId:YYYY-MM-DD"), one-offs an integer — so DOM
    // data-id round-trips and find()/=== comparisons stay type-consistent.
    await window.agoraBundle.load({ fresh: opts.fresh });
    state.events = window.agoraBundle.feed(params.get('from'), params.get('to'), {
      lat: state.userLat, lng: state.userLng,
    });
    if (opts.extended) state._eventsExtended = true;
  } catch {
    state.events = [];
  }
  if (window.lsLog) window.lsLog('✓ events loaded (' + state.events.length + ')');
  if (window.lsProgress) window.lsProgress(0.75);

  // Initial load: empty 60-day window → fall through to Services mode.
  if (state._initialLoad) {
    const filteredNow = applyFilters(state.events).filter(e => {
      const end = e.end_utc ? new Date(e.end_utc) : new Date(new Date(e.start_utc).getTime() + 3600000);
      return end >= now || new Date(e.start_utc) > now;
    });
    state._initialLoad = false;
    if (!filteredNow.length) {
      document.getElementById('btn-services').click();
      return;
    }
  }

  scheduleRenderEvents(300);
  updateMap(state, { fit: !!opts.fit });
  if (state.parishSheetFocus) renderParishSheetContent(state.parishSheetFocus, {});
}

window.loadMoreEvents = async function() {
  const mainScroll = document.getElementById('sheet-scroll');
  const parishScroll = document.getElementById('parish-sheet-scroll');
  const mainTop = mainScroll ? mainScroll.scrollTop : 0;
  const parishTop = parishScroll ? parishScroll.scrollTop : 0;
  await fetchEvents({ extended: true });
  if (mainScroll) mainScroll.scrollTop = mainTop;
  if (parishScroll) parishScroll.scrollTop = parishTop;
};

// Reveal next 30 events from already-fetched state.events — no network request.
window.showMoreEvents = function() {
  const scroll = document.getElementById('sheet-scroll');
  const top = scroll ? scroll.scrollTop : 0;
  state._eventsShowCount += 30;
  scheduleRenderEvents(0);
  requestAnimationFrame(() => { if (scroll) scroll.scrollTop = top; });
};

window.showMoreParishEvents = function() {
  const scroll = document.getElementById('parish-sheet-scroll');
  const top = scroll ? scroll.scrollTop : 0;
  state._parishEventsShowCount += 30;
  if (state.parishSheetFocus) {
    renderParishSheetContent(state.parishSheetFocus, {});
    requestAnimationFrame(() => { if (scroll) scroll.scrollTop = top; });
  }
};

async function fetchSchedules(opts = {}) {
  const params = new URLSearchParams();
  if (state.filters.jurisdiction) params.set('jurisdiction', state.filters.jurisdiction);
  if (window.lsLog) window.lsLog('GET /api/schedules …');
  try {
    await window.agoraBundle.load();
    // The services view renders the RULES themselves, so the bundle's schedules
    // are exactly what it wants — no separate request.
    const juris = state.filters.jurisdiction;
    state.schedules = window.agoraBundle.schedules()
      .filter(s => !juris || s.parish_jurisdiction === juris || s.jurisdiction === juris);
  } catch {
    state.schedules = [];
  }
  if (window.lsLog) window.lsLog('✓ schedules loaded (' + state.schedules.length + ')');
  if (window.lsProgress) window.lsProgress(0.75);
  renderServices();
  updateMap(state, { fit: !!opts.fit });
}

async function fetchParishes() {
  if (window.lsLog) window.lsLog('GET /api/parishes …');
  try {
    await window.agoraBundle.load();
    state.parishes = window.agoraBundle.parishes();
  } catch {
    state.parishes = [];
  }
  if (window.lsLog) window.lsLog('✓ parishes loaded (' + state.parishes.length + ')');
  if (window.lsProgress) window.lsProgress(0.35);
  // Flash a few parish names through the log so it feels like it's doing work.
  if (window.lsLog && state.parishes.length) {
    const sample = state.parishes.filter(p => p.id !== '_unassigned').slice(0, 6);
    sample.forEach((p, i) => setTimeout(() => window.lsLog('  · ' + p.name), 40 * (i + 1)));
  }
}

async function checkAdmin() {
  // One source of truth. /api/admin/ping is the Worker verifying the Access JWT
  // Cloudflare injected, so its answer IS whether this browser can administer.
  //
  // The old code also called /auth/whoami and OR'd the two, because magic-link
  // phone auth could authenticate someone the Caddy gate had not seen yet. Both
  // that endpoint and the whole phone-auth subsystem went with the VM, and
  // /auth/* is not an API path — the Worker hands it to the SPA fallback, so it
  // answered 200 with index.html and the OR was quietly reading a parse failure.
  const ping = await fetch('/api/admin/ping').catch(() => null);
  state.isAdmin = !!(ping && ping.ok);

  if (state.isAdmin) {
    const adminBtn = document.getElementById('btn-admin');
    if (adminBtn) adminBtn.hidden = false;
    // .fm-admin-sep was the filter-menu divider before Admin. Admin is now
    // a mode-bar pill; selector may not exist anymore — guard.
    const adminSep = document.querySelector('.fm-admin-sep');
    if (adminSep) adminSep.hidden = false;
    // Signing in is a redirect Cloudflare owns, so the only session control
    // worth showing is the way out — and only to someone who is signed in.
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) logoutBtn.hidden = false;
  }
}

function toggleAdminControlsVisibility() {
  const hiding = localStorage.getItem('hideAdminControls') === 'true';
  localStorage.setItem('hideAdminControls', hiding ? 'false' : 'true');
  document.querySelectorAll('.admin-actions-group').forEach(el => {
    el.style.display = hiding ? '' : 'none';
  });
  document.querySelectorAll('.btn-admin-controls-pill').forEach(el => {
    // The pill carries a masked glyph alongside its label now, so relabel
    // the label span rather than assigning textContent over both.
    const label = el.querySelector('.btn-admin-controls-label');
    if (label) label.textContent = hiding ? 'Hide admin controls' : 'Show admin controls';
    else el.textContent = hiding ? 'Hide admin controls' : 'Show admin controls';
    const g = el.querySelector('.ps-btn-glyph');
    if (g) g.style.setProperty('--glyph', `url(https://api.iconify.design/ph:${hiding ? 'eye-slash' : 'eye'}.svg)`);
  });
}

function _initLogout() {
  const btn = document.getElementById('btn-logout');
  if (!btn) return;
  // Cloudflare serves /cdn-cgi/access/logout at the edge on any Access-protected
  // hostname; it clears the CF_Authorization cookie. This replaces POST
  // /auth/logout, which was Express session middleware that no longer exists.
  btn.addEventListener('click', () => {
    location.href = '/cdn-cgi/access/logout';
  });
}

// ── Mode bar ──
function initModeBar() {
  const eventsBtn = document.getElementById('btn-events');
  const servicesBtn = document.getElementById('btn-services');

  if (eventsBtn) {
    eventsBtn.addEventListener('click', () => {
      closeFiltersMenuAnim();
      if (window.agoraParishSheetVisible) {
        if (!state.parishFilters.socialOnly) return;
        state.parishFilters.socialOnly = false;
        syncFiltersButton();
        renderParishSheetContent(state.parishSheetFocus);
        return;
      }
      // Events is the default mode — clicking exits services and/or socialOnly.
      const wasServices = state.mode === 'services';
      const wasSocial = !!state.filters.socialOnly;
      state.mode = 'events';
      servicesBtn.classList.remove('active');
      if (wasSocial) {
        state.filters.socialOnly = false;
        document.getElementById('btn-social').classList.remove('active');
      }
      showView('events');
      if (wasServices || wasSocial || !state.events.length) fetchEvents();
      updateArchdioceseEventsBanner();
      if (typeof syncFiltersButton === 'function') syncFiltersButton();
      if (typeof syncResetFab === 'function') syncResetFab();
      syncURL();
    });
  }

  servicesBtn.addEventListener('click', () => {
    closeFiltersMenuAnim();
    // Entering services mode makes the currently-open event irrelevant —
    // close the drawer so the URL chip drops the event id on sync below.
    if (state.mode !== 'services' && state._openEventId) {
      closeDetailDOM();
    }
    if (state.mode === 'services') {
      state.mode = 'events';
      servicesBtn.classList.remove('active');
      showView('events');
      fetchEvents();
      updateArchdioceseEventsBanner();
    } else {
      state.mode = 'services';
      servicesBtn.classList.add('active');
      // Mutex: turning services on turns social off.
      if (state.filters.socialOnly) {
        state.filters.socialOnly = false;
        document.getElementById('btn-social').classList.remove('active');
      }
      showView('services');
      fetchSchedules();
      updateArchdioceseEventsBanner();
    }
    if (typeof syncFiltersButton === 'function') syncFiltersButton();
    if (typeof syncResetFab === 'function') syncResetFab();
    snapMainSheetToFull();
    syncURL();
  });
}

// Snap the main bottom-sheet to FULL if it's currently below FULL. Used by
// the mode-bar pill taps (Schedules / Socials) so a tap from PEEK/HALF
// auto-expands into the list view that the tap implies.
function snapMainSheetToFull() {
  if (typeof window.agoraSnapTo !== 'function' || typeof window.agoraSnapFull !== 'function') return;
  if (typeof window.agoraSheetY !== 'function') return;
  if (window.agoraParishSheetVisible) return;
  const y = window.agoraSheetY();
  const full = window.agoraSnapFull();
  if (y > full + 5) window.agoraSnapTo(full);
}

function showView(name) {
  document.querySelectorAll('.content-view').forEach(v => v.classList.remove('active'));
  document.getElementById(`${name}-view`).classList.add('active');
}

// ── Apply URL-driven start state (mode, EN filter) ──
async function applyStartMode() {
  const servicesBtn = document.getElementById('btn-services');

  if (state.filters.englishOnly) {
    syncEnglishButton();
  }

  if (state._startMode === 'services') {
    state.mode = 'services';
    servicesBtn.classList.add('active');
    showView('services');
    await fetchSchedules({ fit: true });
  } else {
    await fetchEvents({ fit: true });
  }
  delete state._startMode;
  // Frame the region explicitly rather than relying on the fetch above having
  // done it. The fit rides on the events path, and a region whose parishes
  // have no events in the window takes the services branch instead — which is
  // exactly the case where the user most needs to be shown where they are.
  if (state._fitLocation) {
    delete state._fitLocation;
    if (typeof updateMap === 'function') updateMap(state, { fit: true });
  }
  syncFiltersButton();

  if (state._openEventId) {
    // Split the history entry so the back button can close the detail:
    //   replace current entry with URL-minus-ID, then showEventDetail pushes
    //   URL-with-ID. Back → URL-minus-ID → reconciler closes detail.
    const pendingId = state._openEventId;
    delete state._openEventId;
    syncURL({ replace: true });
    await openEventFromUrl(pendingId);
  } else if (typeof syncURL === 'function') {
    syncURL({ replace: true });
  }
  // Last, because it needs the schedules and the projected occurrences the
  // fetch above brought in, and because it sets _openEventId of its own —
  // which the block above would otherwise have opened as a drawer instead of
  // pinning it in the parish sheet where it belongs.
  //
  // Schedules first: the events path does not load them (only the services
  // view and the parish sheet do, the latter lazily), and a rule focus that
  // asked before they arrived would find no rule and quietly downgrade itself
  // to the feed-wide filter.
  if (state._pendingServiceFocus || state._pendingDayFocus != null) {
    await ensureSchedulesLoaded();
    applyServiceFocus();
    syncURL({ replace: true });
  }
  state._initialLoad = false;
  if (window.lsLog) window.lsLog('✓ ready');
  if (window.lsHide) window.lsHide();
}

// Event permalink loader — opens the parish sheet for the event's parish and
// expands the event card inline within it. Does NOT change jurisdiction /
// parish filters — parish card and parish filter are separate concepts now.
// Falls back to a direct /api/events/:id fetch for events outside the
// currently-loaded window.
async function openEventFromUrl(id) {
  let evt = state.events.find(e => e.id === id);
  if (!evt) {
    try {
      // Outside the loaded window: project it from the rules we already hold.
      // A deep link no longer needs the server.
      await window.agoraBundle.load();
      evt = window.agoraBundle.resolveEvent(id);
    } catch {}
    if (evt && !state.events.some(e => e.id === evt.id)) {
      state.events = [...state.events, evt];
    }
  }
  if (!evt) return;

  if (evt.parish_id) {
    openParishSheet(evt.parish_id, { focusEventId: evt.id });
    // renderParishSheetContent already pins + expands the focused event on
    // its own requestAnimationFrame. No extra expandEventCard needed here.
  } else {
    // Event with no parish — fall back to main-list inline expand.
    showEventDetail(id);
  }
}

// ── Archdiocese events banner ──
function updateArchdioceseEventsBanner() {
  const banner = document.getElementById('archdiocese-events-banner');
  const j = state.filters.jurisdiction;
  const url = j && ARCHDIOCESE_EVENTS[j];
  const parishRowWrap = document.getElementById('parish-filter-row-wrap');
  const pillsVisible = parishRowWrap && parishRowWrap.classList.contains('visible');

  if (state.mode === 'services' && pillsVisible && url) {
    banner.href = url;
    banner.classList.add('visible');
  } else {
    banner.classList.remove('visible');
  }
}

// ── Parish filter ──
function initParishFilter() {
  syncParishRowVisibility();
  renderParishPills();
}

function renderParishPills() {
  const row = document.getElementById('parish-filter-row');
  // Pill list is now an inner container so the leading multi-toggle FAB
  // doesn't get wiped on re-render. Fall back to the row itself for
  // backwards-compat in case the inner host hasn't been added yet.
  const list = document.getElementById('parish-pills-list') || row;
  if (!list) return;
  let relevant = state.parishes.filter(p => {
    if (p.id === '_unassigned') return false;
    if (state.filters.jurisdiction && p.jurisdiction !== state.filters.jurisdiction) return false;
    if (!parishPassesLocation(p)) return false;
    return true;
  });

  // Distance origin: always use the visible-centre at SNAP_HALF (sheet at 50%
  // of screen height) — pills sort as if the user is in the standard browsing
  // position regardless of where they've dragged the sheet.
  let originLat = null, originLng = null;
  const vc = window.agoraMap ? (() => {
    const m = window.agoraMap;
    const w = m.getContainer().clientWidth;
    return m.unproject([w / 2, (window.innerHeight * 0.5) / 2]);
  })() : null;
  if (vc) {
    originLat = vc.lat; originLng = vc.lng;
  } else if (state.userLat != null && state.userLng != null) {
    originLat = state.userLat; originLng = state.userLng;
  }

  if (originLat != null && originLng != null) {
    relevant = relevant.map(p => ({
      ...p,
      _dist: (p.lat != null && p.lng != null) ? haversineKm(originLat, originLng, p.lat, p.lng) : Infinity
    })).sort((a, b) => a._dist - b._dist);
  } else {
    relevant = relevant.sort((a, b) => {
      const aName = a.acronym || a.name.split(',')[0];
      const bName = b.acronym || b.name.split(',')[0];
      return aName.localeCompare(bName);
    });
  }

  // Selected parishes always appear first, maintaining their relative distance/alpha order.
  if (state.filters.parishIds) {
    const sel = relevant.filter(p => state.filters.parishIds.has(p.id));
    const unsel = relevant.filter(p => !state.filters.parishIds.has(p.id));
    relevant = [...sel, ...unsel];
  }

  // After selected pinning, sort in-view ahead of out-of-view (within each
  // group). Keeps the user's spatial context — pills they can see on the
  // map sit nearest the row's start, dimmed pills follow.
  const vp = state.viewportParishIds;
  if (vp) {
    const inView = relevant.filter(p => vp.has(p.id));
    const outView = relevant.filter(p => !vp.has(p.id));
    relevant = [...inView, ...outView];
  }

  const allActive = state.filters.parishIds === null;

  let html = '';

  for (const p of relevant) {
    const acronym = p.acronym || p.name.split(',')[0].replace(/^(Sts?|Holy) /, '').substring(0, 8);
    const distLabel = (p._dist != null && isFinite(p._dist)) ? `·${Math.round(p._dist)}km` : '';
    const labelHtml = distLabel
      ? `${esc(acronym)}<span class="pill-dist">${esc(distLabel)}</span>`
      : esc(acronym);
    const isSelected = state.filters.parishIds && state.filters.parishIds.has(p.id);
    const color = getParishDisplayColor(p.color || '#000');
    let style;
    if (allActive) {
      const inView = !vp || vp.has(p.id);
      style = inView
        ? `color:${color};border-color:${color};background:var(--fab-bg);`
        : `color:var(--text-secondary);border-color:var(--border);background:var(--fab-bg);`;
    } else if (isSelected) {
      style = `background:${color};color:#fff;border-color:transparent;`;
    } else {
      style = `color:var(--text-secondary);border-color:var(--border);background:var(--fab-bg);`;
    }
    const activeClass = (allActive || isSelected) ? 'active' : '';
    // Selected pills get an inline × so the user can dismiss the focus
    // without re-tapping the pill (matches the filter-stack chip pattern).
    const xHtml = isSelected ? `<span class="parish-pill-x" data-clear-parish="${esc(p.id)}" aria-hidden="true">✕</span>` : '';
    html += `<button class="parish-pill ${activeClass}" data-parish="${esc(p.id)}" data-color="${color}" style="${style}">${labelHtml}${xHtml}</button>`;
  }
  list.innerHTML = html;
  if (row) row.classList.toggle('multi-parish', !!state.filters.multiParish);
  // Snap the pill list back to the start — when the user toggles a filter
  // or sort flips, the leading pill should be visible immediately rather
  // than leaving the user mid-scroll.
  if (list.scrollLeft) list.scrollLeft = 0;
}

// Use event delegation on the row (set up once)
document.addEventListener('DOMContentLoaded', () => {
  const row = document.getElementById('parish-filter-row');

  row.addEventListener('click', e => {
    // X on a selected pill → clear that parish from the selection. Doesn't
    // toggle the pill or open a parish card — just dismiss.
    const x = e.target.closest('.parish-pill-x');
    if (x) {
      e.stopPropagation();
      const pid = x.dataset.clearParish;
      if (state.filters.parishIds) {
        state.filters.parishIds.delete(pid);
        if (state.filters.parishIds.size === 0) state.filters.parishIds = null;
      }
      if (state.parishFocus === pid) state.parishFocus = null;
      if (typeof window.closeParishSheet === 'function' && state.parishSheetFocus === pid) {
        window.closeParishSheet();
      }
      renderParishPills();
      renderCurrentView({ fit: true });
      syncURL();
      return;
    }

    const pill = e.target.closest('.parish-pill');
    if (!pill) return;

    const pid = pill.dataset.parish;
    const multi = !!state.filters.multiParish;

    let justOpenedParishSheet = false;
    if (!multi) {
      // Single-parish default: tapping a pill is equivalent to tapping that
      // parish's marker — open the parish card and set the focus filter.
      // Tapping the same pill again (when it's the sole selection) clears.
      if (state.filters.parishIds && state.filters.parishIds.has(pid) && state.filters.parishIds.size === 1) {
        state.filters.parishIds = null;
        state.parishFocus = null;
        if (typeof window.closeParishSheet === 'function') window.closeParishSheet();
      } else {
        state.filters.parishIds = new Set([pid]);
        state.parishFocus = pid;
        if (typeof window.openParishSheet === 'function') window.openParishSheet(pid);
        justOpenedParishSheet = true;
      }
    } else {
      // Picker mode: pure toggle. No auto-collapse, no focus header — all
      // selections stay plural so the user can keep building the set.
      if (state.filters.parishIds === null) {
        state.filters.parishIds = new Set([pid]);
      } else if (state.filters.parishIds.has(pid)) {
        state.filters.parishIds.delete(pid);
        if (state.filters.parishIds.size === 0) state.filters.parishIds = null;
      } else {
        state.filters.parishIds.add(pid);
      }
      if (state.parishFocus) state.parishFocus = null;
    }

    renderParishPills();
    // When we just opened the parish sheet, its own flyTo math centres
    // the parish in the visible-above-sheet region. updateMap's fitBounds
    // would override that with a whole-viewport-centred fit, so suppress
    // the fit on this code path.
    renderCurrentView({ fit: !justOpenedParishSheet });
    syncURL();
  });
});

// ── Pill drawer (chip toggle) — drawer visibility only, doesn't reset filter ──
function setParishPicker(on) {
  state.filters.multiParish = !!on;
  saveMultiParishPref(state.filters.multiParish);
  syncParishRowVisibility();
  renderParishPills();
  renderInViewChip();
}

// ── Selection mode (map-tap to toggle parish in filter set) ──
function setSelectionMode(on) {
  state.selectionMode = !!on;
  // Selection mode implies soft multi (pill-row multi-toggle is visually
  // ON during map-tap-to-select, OFF after Done). selected parishIds
  // persist across this transition; the next single-pill tap replaces
  // the entire set, signalling "you've left selection mode".
  state.filters.multiParish = !!on;
  saveMultiParishPref(state.filters.multiParish);
  if (on) showMapSelectOverlay(); else hideMapSelectOverlay();
  syncMultiParishButton();
  syncParishMultiToggle();
  closeFiltersMenuAnim();
  renderParishPills();
  if (typeof window.updateMap === 'function') window.updateMap(state);
  if (!on) {
    renderCurrentView();
    syncURL();
    if (state.mode === 'services') window.agoraFetchSchedules();
    else window.agoraFetchEvents();
  }
}

// Visual sync for the parish-row multi-toggle FAB. Active when either the
// soft multi-toggle is on OR Selection Mode is on (since selection mode
// implies multi).
function syncParishMultiToggle() {
  const btn = document.getElementById('parish-multi-toggle');
  if (!btn) return;
  const active = !!state.filters.multiParish || !!state.selectionMode;
  btn.classList.toggle('active', active);
  btn.setAttribute('aria-pressed', active ? 'true' : 'false');
}
window.agoraSyncParishMultiToggle = syncParishMultiToggle;

// Toggle .scrolled-start / .scrolled-end on a horizontal-scroll container so
// CSS edge-fade overlays only paint when there's content beyond the visible
// edge. classTarget defaults to the scroll element — pass a separate target
// (e.g. wrap container) when fades live as ::before/::after on the wrap
// rather than on the scrolling element itself.
function initScrollFade(el, classTarget) {
  if (!el) return;
  const target = classTarget || el;
  const sync = () => {
    const max = el.scrollWidth - el.clientWidth;
    if (max <= 1) {
      target.classList.remove('scrolled-start', 'scrolled-end');
      return;
    }
    target.classList.toggle('scrolled-start', el.scrollLeft > 1);
    target.classList.toggle('scrolled-end', el.scrollLeft < max - 1);
  };
  el.addEventListener('scroll', sync, { passive: true });
  window.addEventListener('resize', sync);
  // Defer one frame so layout has settled (juris banner adds chips after
  // initFilters fires; pill row content varies with auth state).
  requestAnimationFrame(() => requestAnimationFrame(sync));
}

function initParishMultiToggle() {
  const btn = document.getElementById('parish-multi-toggle');
  if (!btn) return;
  btn.addEventListener('click', () => {
    // Single source of multi-select entry now: this FAB toggles the full
    // Selection Mode (with map-tap-to-select ring + Done confirm). The
    // old "Create filter" item in the filter menu has been removed; this
    // is the canonical entry point.
    setSelectionMode(!state.selectionMode);
  });
  syncParishMultiToggle();
}
window.agoraInitParishMultiToggle = initParishMultiToggle;

function initMultiParishToggle() {
  const btn = document.getElementById('btn-multi-parish');
  if (btn) {
    // Menu entry "Select parishes": toggles selection mode only.
    btn.addEventListener('click', () => {
      setSelectionMode(!state.selectionMode);
    });
  }
  syncMultiParishButton();

  // In-view chip toggles between FULL and HALF.
  //   FULL  → HALF (collapse)
  //   HALF  → FULL (expand)
  //   PEEK  → FULL (jump up two stops; the user is reaching for the
  //                 list, half-way feels like a non-commital stop).
  const chip = document.getElementById('in-view-chip');
  if (chip) {
    chip.addEventListener('click', () => {
      if (window.agoraIsDesktop?.()) return;
      if (!window.agoraSnapTo || !window.agoraSnapHalf) return;
      const y = window.agoraSheetY ? window.agoraSheetY() : null;
      const half = window.agoraSnapHalf();
      const full = window.agoraSnapFull ? window.agoraSnapFull() : 0;
      if (y !== null && y < half - 5) {
        window.agoraSnapTo(half);   // FULL → HALF
      } else {
        window.agoraSnapTo(full);   // HALF or PEEK → FULL
      }
    });
  }

  // Confirm-FAB exits selection mode and fits map to selection.
  const confirm = document.getElementById('map-select-confirm');
  if (confirm) {
    confirm.addEventListener('click', () => {
      setSelectionMode(false);
      if (state.filters.parishIds && window.agoraMap) {
        const sel = state.parishes.filter(p =>
          state.filters.parishIds.has(p.id) && p.lat != null && p.lng != null);
        if (sel.length) {
          const b = window.agoraPadBounds(window.agoraBoundsFromPoints(sel), 0.25);
          const sheetY = window.agoraSheetY ? window.agoraSheetY() : window.innerHeight;
          const snapHalf = window.agoraSnapHalf ? window.agoraSnapHalf() : window.innerHeight * 0.5;
          const bottomPad = sheetY <= snapHalf + 10 ? window.innerHeight - sheetY + 20 : 0;
          window.agoraMap.fitBounds(b, {
            maxZoom: 13, duration: 700,
            padding: { top: 30, right: 30, bottom: 30 + bottomPad, left: 30 }
          });
        }
      }
    });
  }
}

function syncJurisBottomVar() {
  // Push --juris-bottom to the bottom of whatever sits at the top stack —
  // jurisdiction banner alone, or banner + parish pill row when the row
  // is mounted. Selection mode's dotted ring uses this to start below
  // both, keeping the ring's bounds clean of the top UI.
  const bannerWrap = document.getElementById('jurisdiction-banner-wrap');
  const pillWrap = document.getElementById('parish-filter-row-wrap');
  const pillVisible = pillWrap && pillWrap.classList.contains('visible');
  let bottom = 48;
  if (pillVisible) {
    bottom = pillWrap.getBoundingClientRect().bottom;
  } else if (bannerWrap) {
    bottom = bannerWrap.getBoundingClientRect().bottom;
  }
  document.documentElement.style.setProperty('--juris-bottom', Math.round(bottom + 8) + 'px');
}
function showMapSelectOverlay() {
  const el = document.getElementById('map-select-overlay');
  if (!el) return;
  // Ensure both vars the ring depends on are fresh BEFORE we unhide it.
  // First-time activation otherwise renders the ring against a stale
  // --juris-bottom (zero) and --sheet-cover (defaults), which sized the
  // box wrong on initial show.
  syncJurisBottomVar();
  if (typeof window.agoraSheetY === 'function') {
    const cover = window.agoraIsDesktop?.() ? 0 : (window.innerHeight - window.agoraSheetY());
    document.documentElement.style.setProperty('--sheet-cover', cover + 'px');
  }
  el.classList.remove('hidden');
  el.setAttribute('aria-hidden', 'false');
  // One more pass after the unhide so transformed/painted layout has
  // measured itself fully (parish pill row may have just been mounted).
  requestAnimationFrame(syncJurisBottomVar);
}
function hideMapSelectOverlay() {
  const el = document.getElementById('map-select-overlay');
  if (!el) return;
  el.classList.add('hidden');
  el.setAttribute('aria-hidden', 'true');
}

function updateInViewChevron() {
  const chip = document.getElementById('in-view-chip');
  if (!chip) return;
  if (window.agoraIsDesktop?.()) {
    chip.classList.remove('chevron-down');
    return;
  }
  if (!window.agoraSheetY || !window.agoraSnapHalf) return;
  const y = window.agoraSheetY();
  const half = window.agoraSnapHalf();
  // At FULL (y < half): pressing collapses → point DOWN
  // At HALF or PEEK (y >= half): pressing expands → point UP
  chip.classList.toggle('chevron-down', y < half - 5);
}

function renderInViewChip() {
  const countEl = document.getElementById('in-view-count');
  if (!countEl) return;
  const todayKey = isoDateSyd(new Date().toISOString());
  const nowMs = Date.now();
  const j = state.filters.jurisdiction;
  const englishOnly = state.filters.englishOnly;
  const englishStrict = state.filters.englishStrict;

  let n = 0;
  if (state.viewportParishIds && state.events) {
    for (const e of state.events) {
      if (!e.parish_id) continue;
      const inView = state.viewportParishIds.has(e.parish_id)
        || (Array.isArray(e.extra_parishes) && e.extra_parishes.some(id => state.viewportParishIds.has(id)));
      if (!inView) continue;
      if (j) {
        const p = state.parishes.find(pa => pa.id === e.parish_id);
        if (!p || p.jurisdiction !== j) continue;
      }
      if (englishOnly) {
        const langs = parseLangs(e.languages) || parseLangs(e.parish_languages);
        if (!langs) continue;
        const ok = englishStrict ? langs.every(l => /english/i.test(l)) : langs.some(l => /english/i.test(l));
        if (!ok) continue;
      }
      if (isoDateSyd(e.start_utc) !== todayKey) continue;
      const endMs = e.end_utc ? new Date(e.end_utc).getTime() : new Date(e.start_utc).getTime() + 3600000;
      if (endMs <= nowMs) continue;
      n++;
    }
  }
  const hour = parseInt(new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date()));
  const when = hour >= 16 ? 'tonight' : 'today';
  const noun = n === 1 ? 'event' : 'events';
  countEl.textContent = `${n} ${noun} ${when}`;
  updateInViewChevron();
}
window.agoraRenderInViewChip = renderInViewChip;

function syncParishRowVisibility() {
  const wrap = document.getElementById('parish-filter-row-wrap');
  if (!wrap) return;
  wrap.classList.add('visible');
  // Pin the wrap directly below the jurisdiction banner. Banner height
  // varies with safe-area-inset-top, so measure live every visibility
  // change rather than using a static offset.
  positionParishFilterRow();
  // Sheet's SNAP_FULL is computed against the pill-row bottom edge, so
  // recompute now that the row has measurable layout. Defer one frame
  // so getBoundingClientRect() reflects the new position.
  if (typeof window.agoraRecomputeSnaps === 'function') {
    requestAnimationFrame(() => window.agoraRecomputeSnaps());
  }
}

function positionParishFilterRow() {
  const bannerWrap = document.getElementById('jurisdiction-banner-wrap');
  const wrap = document.getElementById('parish-filter-row-wrap');
  if (!bannerWrap || !wrap) return;
  const rect = bannerWrap.getBoundingClientRect();
  wrap.style.top = Math.max(0, rect.bottom) + 'px';
}
window.agoraPositionParishFilterRow = positionParishFilterRow;
window.addEventListener('resize', positionParishFilterRow);
// Banner height can change after fonts load / orientation change; refresh
// the row position in the next paint frame on init too.
requestAnimationFrame(positionParishFilterRow);
window.agoraSyncParishRowVisibility = syncParishRowVisibility;

function syncMultiParishButton() {
  const btn = document.getElementById('btn-multi-parish');
  if (!btn) return;
  // Menu item label is "Select parishes" — active state tracks selection mode,
  // not pill-drawer visibility (those are decoupled now).
  btn.classList.toggle('active', !!state.selectionMode);
}

function exitMultiParish() {
  state.filters.multiParish = false;
  saveMultiParishPref(false);
  if (state.filters.parishIds && state.filters.parishIds.size > 1) {
    const first = [...state.filters.parishIds][0];
    state.filters.parishIds = new Set([first]);
    state.parishFocus = first;
  }
  syncMultiParishButton();
  syncParishRowVisibility();
  renderParishPills();
  renderCurrentView();
  syncURL();
}

// ── Social filter ──
function initSocialFilter() {
  const btn = document.getElementById('btn-social');
  btn.addEventListener('click', () => {
    closeFiltersMenuAnim();
    if (window.agoraParishSheetVisible) {
      state.parishFilters.socialOnly = !state.parishFilters.socialOnly;
      syncFiltersButton();
      renderParishSheetContent(state.parishSheetFocus);
      return;
    }
    const willActivate = !state.filters.socialOnly;
    state.filters.socialOnly = willActivate;
    btn.classList.toggle('active', willActivate);
    if (state._openEventId) closeDetailDOM();
    if (willActivate && state.mode === 'services') {
      document.getElementById('btn-services').click();
      return;
    }
    renderCurrentView();
    syncFiltersButton();
    snapMainSheetToFull();
    if (typeof renderInViewChip === 'function') renderInViewChip();
    syncURL();
  });
}

// ── English filter (tri-state: off → any-english → strict → off) ──
function initEnglishFilter() {
  const btn = document.getElementById('btn-english');
  btn.addEventListener('click', () => {
    if (window.agoraParishSheetVisible) {
      const f = state.parishFilters;
      if (!f.englishOnly) { f.englishOnly = true; f.englishStrict = false; }
      else if (!f.englishStrict) { f.englishStrict = true; }
      else { f.englishOnly = false; f.englishStrict = false; }
      syncEnglishButton();
      syncFiltersButton();
      renderParishSheetContent(state.parishSheetFocus);
      return;
    }
    if (!state.filters.englishOnly) {
      state.filters.englishOnly = true;
      state.filters.englishStrict = false;
    } else if (!state.filters.englishStrict) {
      state.filters.englishStrict = true;
    } else {
      state.filters.englishOnly = false;
      state.filters.englishStrict = false;
    }
    syncEnglishButton();
    renderCurrentView();
    syncFiltersButton();
    // The in-view chip pre-filters by parish — when the English filter
    // toggles, parish set changes too; recount.
    if (typeof renderInViewChip === 'function') renderInViewChip();
    syncURL();
  });
  syncEnglishButton();
}

function syncEnglishButton() {
  const btn = document.getElementById('btn-english');
  if (!btn) return;
  const f = window.agoraParishSheetVisible ? state.parishFilters : state.filters;
  btn.classList.toggle('active', f.englishOnly);
  btn.classList.toggle('strict', f.englishStrict);
  // Three states baked into the EN badge text — the box itself carries the
  // mode label so the visual is one unit instead of badge + separate label.
  //   inactive: "EN"
  //   bilingual: "EN+BILINGUAL"
  //   strict:   "EN-ONLY"
  const badge = btn.querySelector('.fm-en-badge');
  if (badge) {
    if (f.englishStrict) badge.textContent = 'EN-ONLY';
    else if (f.englishOnly) badge.textContent = 'EN+BILINGUAL';
    else badge.textContent = 'EN';
  }
  // Drop any companion label — badge text carries everything now.
  const label = btn.querySelector('.mode-bar-en-label, .fm-label');
  if (label) label.style.display = 'none';
}

// ── Filters menu dropdown ──
function initFiltersMenu() {
  const btn = document.getElementById('btn-filters');
  const menu = document.getElementById('filters-menu');
  if (!btn || !menu) return;

  // Both open and close drive the same clip-path + opacity transition with
  // CONCRETE inline values — relying on the CSS .hidden ruleset with
  // var(--btn-inset-*) proved flaky when the button moved between peek and
  // half/full (stale computed custom-prop values made the first post-move
  // open animate from the wrong origin, and some browsers skip transitions
  // entirely when a property's resolved value flips via var() substitution).
  // With explicit inline inset(<px>…) start/end values, every transition is
  // deterministic regardless of sheet state changes between toggles.

  function openMenu() {
    clearTimeout(menu._closeTimer);
    const insets = positionFiltersMenu(btn, menu);
    const collapsed = `inset(${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px round 14px)`;
    const expanded = 'inset(0px 0px 0px 0px round 14px)';
    // 1) Suppress transition while we seed the start state (collapsed).
    menu.style.transition = 'none';
    menu.style.clipPath = collapsed;
    menu.style.opacity = '0';
    menu.classList.remove('hidden');
    void menu.offsetWidth;
    // 2) Restore transition and animate to expanded end state.
    menu.style.transition = '';
    menu.style.clipPath = expanded;
    menu.style.opacity = '1';
    btn.setAttribute('aria-expanded', 'true');
  }

  function closeMenu() {
    if (menu.classList.contains('hidden')) return;
    clearTimeout(menu._closeTimer);
    // Recompute insets from the button's current rect — accounts for sheet
    // having moved since the menu opened.
    const insets = positionFiltersMenu(btn, menu);
    const collapsed = `inset(${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px round 14px)`;
    const expanded = 'inset(0px 0px 0px 0px round 14px)';
    menu.style.transition = 'none';
    menu.style.clipPath = expanded;
    menu.style.opacity = '1';
    void menu.offsetWidth;
    menu.style.transition = '';
    menu.style.clipPath = collapsed;
    menu.style.opacity = '0';
    btn.setAttribute('aria-expanded', 'false');
    // Commit .hidden after the animation so pointer-events lockout and default
    // resting styles take over without stomping on the running transition.
    menu._closeTimer = setTimeout(() => {
      menu.classList.add('hidden');
      menu.style.transition = 'none';
      menu.style.clipPath = '';
      menu.style.opacity = '';
      void menu.offsetWidth;
      menu.style.transition = '';
    }, 240);
  }

  btn.addEventListener('click', () => {
    if (menu.classList.contains('hidden')) openMenu();
    else closeMenu();
  });

  // Pointerdown fires reliably on mobile taps (click sometimes doesn't on
  // non-interactive targets on iOS). Close whenever pointer lands outside
  // the menu and trigger button. Capture phase + stopPropagation + a short
  // click-swallow window so the outside tap dismisses the menu without also
  // firing the thing it landed on (marker, card, etc.).
  let swallowClickUntil = 0;
  document.addEventListener('pointerdown', e => {
    if (menu.classList.contains('hidden')) return;
    if (menu.contains(e.target) || btn.contains(e.target)) return;
    closeMenu();
    swallowClickUntil = performance.now() + 500;
    e.stopPropagation();
  }, true);
  document.addEventListener('click', e => {
    if (performance.now() > swallowClickUntil) return;
    swallowClickUntil = 0;
    e.preventDefault();
    e.stopPropagation();
  }, true);
  syncFiltersButton();

  // Expose for menu-item handlers that also dismiss.
  menu._closeMenu = closeMenu;
}

// Menu-item click handlers that trigger a mode change should close the filter
// menu with animation — using classList.add('hidden') skips the transition and
// feels jarring after the open animation. Safe before initFiltersMenu runs
// (falls back to instant hide).
function closeFiltersMenuAnim() {
  const menu = document.getElementById('filters-menu');
  if (!menu) return;
  if (typeof menu._closeMenu === 'function') menu._closeMenu();
  else menu.classList.add('hidden');
  const fb = document.getElementById('btn-filters');
  if (fb) fb.setAttribute('aria-expanded', 'false');
}

// Reorder menu so the active mode button lands first; everything else keeps
// DOM order. Default fallback order is Events → Schedules → Socials.
// In flip-up (peek) the menu flex-reverses, so the "first" item appears
// visually last — adjacent to the button below. Either way the active item
// sits next to the trigger.
function setFiltersMenuOrder(menu) {
  const activeModeId = ['btn-events', 'btn-services', 'btn-social']
    .find(id => document.getElementById(id)?.classList.contains('active'));
  let n = 1;
  for (const child of menu.children) {
    child.style.order = (child.id && child.id === activeModeId) ? '0' : String(n++);
  }
}

// Position the menu so the trigger button's edge abuts the menu (active
// item ends up adjacent to the button). Menu border-radius matches the
// button's, and --btn-inset-* defines the collapsed clip-path so the menu
// visually "grows" out of the button via clip-path interpolation.
function positionFiltersMenu(btn, menu) {
  const r = btn.getBoundingClientRect();
  const parent = menu.parentElement;
  const parentR = parent.getBoundingClientRect();

  const spaceBelow = window.innerHeight - r.bottom;
  const flipUp = spaceBelow < 280;
  menu.classList.toggle('flip-up', flipUp);

  setFiltersMenuOrder(menu);

  const menuLeft = r.left - parentR.left;
  menu.style.left = `${menuLeft}px`;
  menu.style.top = '0px';
  // Force layout so offsetHeight reflects the reordered menu.
  void menu.offsetWidth;
  const menuH = menu.offsetHeight;
  const menuW = menu.offsetWidth;

  // Active item is first (flip-up: last visually = bottom) → align the
  // relevant menu edge with the matching button edge.
  let menuTop = flipUp
    ? (r.bottom - parentR.top) - menuH
    : (r.top - parentR.top);

  // Clamp into viewport.
  const menuTopViewport = menuTop + parentR.top;
  if (menuTopViewport < 8) {
    menuTop += (8 - menuTopViewport);
  } else if (menuTopViewport + menuH > window.innerHeight - 8) {
    menuTop += (window.innerHeight - 8 - menuH - menuTopViewport);
  }
  menu.style.top = `${menuTop}px`;

  const btnTopInMenu = r.top - parentR.top - menuTop;
  const btnLeftInMenu = r.left - parentR.left - menuLeft;
  const btnBottomInMenu = menuH - btnTopInMenu - r.height;
  const btnRightInMenu = menuW - btnLeftInMenu - r.width;

  menu.style.setProperty('--btn-inset-top', `${btnTopInMenu}px`);
  menu.style.setProperty('--btn-inset-right', `${btnRightInMenu}px`);
  menu.style.setProperty('--btn-inset-bottom', `${btnBottomInMenu}px`);
  menu.style.setProperty('--btn-inset-left', `${btnLeftInMenu}px`);
  // Return so callers can drive the transition with concrete numbers instead
  // of round-tripping through computed custom properties.
  return { top: btnTopInMenu, right: btnRightInMenu, bottom: btnBottomInMenu, left: btnLeftInMenu };
}

function syncFiltersButton() {
  const btn = document.getElementById('btn-filters');
  if (!btn) return;
  btn.classList.add('has-active');
  const setActive = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', on);
  };
  if (window.agoraParishSheetVisible) {
    const f = state.parishFilters;
    setActive('btn-events', !f.socialOnly);
    setActive('btn-services', false);
    setActive('btn-social', !!f.socialOnly);
  } else {
    const isEvents = state.mode !== 'services' && !state.filters.socialOnly;
    const isServices = state.mode === 'services';
    const isSocial = state.mode !== 'services' && !!state.filters.socialOnly;
    setActive('btn-events', isEvents);
    setActive('btn-services', isServices);
    setActive('btn-social', isSocial);
  }
}

// ── Reset FAB (top center) ──
function hasActiveFilters() {
  return state.filters.jurisdiction || state.filters.location || state.filters.service ||
    state.filters.day != null || state.filters.parishIds || state.filters.socialOnly ||
    state.filters.englishOnly || state.parishFocus || state.filters.multiParish;
}

// "Show all" FAB clears two things only: jurisdiction chip + current parish
// selection (while staying in multi-parish mode). It's visible whenever either
// is set — social/English/focus toggles don't count.
function hasResettableScope() {
  return !!(state.filters.jurisdiction || state.filters.location
    || (state.filters.parishIds && state.filters.parishIds.size));
}

function syncResetFab() {
  const fab = document.getElementById('reset-fab');
  if (!fab) return;
  const vp = state.viewportParishIds;
  const viewportKnown = vp instanceof Set;
  const viewportEmpty = viewportKnown && vp.size === 0;

  let show;
  if (viewportEmpty) {
    show = true; // "no parishes in area" — show nearest parish CTA
  } else if (hasResettableScope()) {
    if (viewportKnown) {
      // Only show if at least one matching parish is outside the viewport
      const allInView = state.parishes
        .filter(p =>
          p.id !== '_unassigned' && p.lat != null && p.lng != null &&
          (!state.filters.jurisdiction || p.jurisdiction === state.filters.jurisdiction) &&
          parishPassesLocation(p) &&
          (!state.filters.parishIds || state.filters.parishIds.has(p.id))
        )
        .every(p => vp.has(p.id));
      show = !allInView;
    } else {
      show = true; // viewport not yet initialised — assume needed
    }
  } else {
    show = false;
  }

  fab.classList.toggle('visible', show);
  syncFilterActiveStack();
  renderInViewChip();
}

function clearAllFilters() {
  // Close parish sheet first — it owns the implicit single-parish pill
  // selection and its own parishFilters state. Without this, the user's
  // "Clear" tap leaves the parish card open and the parishFocus pin still
  // selected, contradicting the action.
  if (window.agoraParishSheetVisible && typeof closeParishSheet === 'function') {
    closeParishSheet();
  }
  const wasServices = state.mode === 'services';
  state.filters.jurisdiction = null;
  state.filters.location = null;
  state.filters.service = null;
  state.filters.day = null;
  state.parishScheduleFocus = null;
  state.filters.parishIds = null;
  state.filters.showAllParishes = null;
  state.filters.socialOnly = false;
  state.filters.englishOnly = false;
  state.filters.englishStrict = false;
  state.parishFocus = null;
  if (wasServices) {
    state.mode = 'events';
    const servicesBtn = document.getElementById('btn-services');
    if (servicesBtn) servicesBtn.classList.remove('active');
    showView('events');
  }
  document.querySelectorAll('.jurisdiction-chip').forEach(c => c.classList.remove('active'));
  document.getElementById('btn-social')?.classList.remove('active');
  if (typeof syncEnglishButton === 'function') syncEnglishButton();
  if (typeof applyChipColors === 'function') applyChipColors(document.getElementById('jurisdiction-chips'));
  syncParishRowVisibility();
  syncResetFab();
  renderParishPills();
  if (typeof updateArchdioceseEventsBanner === 'function') updateArchdioceseEventsBanner();
  if (typeof syncFiltersButton === 'function') syncFiltersButton();
  window.agoraFetchEvents();
  syncURL();
}

function initResetFab() {
  const fab = document.getElementById('reset-fab');
  if (!fab) return;
  // "Show all" zooms the map to fit all parishes matching current filters,
  // accounting for how much of the map is visible above the bottom sheet.
  fab.addEventListener('click', () => {
    // Close parish sheet first (no-op if already closed). closeParishSheet
    // also deselects the implicit single-parish pill — clearAllFilters then
    // wipes everything else.
    if (window.agoraParishSheetVisible && typeof window.closeParishSheet === 'function') {
      window.closeParishSheet();
    }
    clearAllFilters();
    const matching = state.parishes.filter(p =>
      p.id !== '_unassigned' && p.lat != null && p.lng != null
    );
    if (matching.length && window.agoraMap) {
      const b = window.agoraPadBounds(window.agoraBoundsFromPoints(matching), 0.2);
      const isDesktop = window.agoraIsDesktop?.() ?? false;
      let bottomPad = 0;
      let rightPad = 0;
      if (isDesktop) {
        rightPad = 440;
      } else {
        const sheetY = window.agoraSheetY ? window.agoraSheetY() : window.innerHeight;
        const snapHalf = window.agoraSnapHalf ? window.agoraSnapHalf() : window.innerHeight * 0.5;
        const snapPeek = window.agoraSnapPeek ? window.agoraSnapPeek() : window.innerHeight * 0.85;
        if (sheetY <= snapHalf + 10) {
          bottomPad = window.innerHeight - sheetY + 20;
        } else if (sheetY < snapPeek - 10) {
          const t = (sheetY - snapHalf) / (snapPeek - snapHalf);
          bottomPad = Math.round((window.innerHeight - sheetY + 20) * (1 - t));
        }
      }
      window.agoraMap.fitBounds(b, {
        maxZoom: 13, duration: 700,
        padding: { top: 0, right: rightPad, bottom: bottomPad, left: 0 }
      });
    }
  });

  // "Clear" button inside the filter active stack clears all filters.
  const clearBtn = document.getElementById('filter-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', e => { e.stopPropagation(); clearAllFilters(); });
  }

  syncResetFab();
}
let _lastFilterCount = null;      // null = not yet initialised; skip wave on first render
let _lastJurisdiction = undefined; // track jurisdiction changes (A→B same count, still wave)

function triggerFilterWave() {
  const elements = [];
  const clearBtn = document.getElementById('filter-clear-btn');
  if (clearBtn) elements.push(clearBtn);
  document.querySelectorAll('#filter-chip-list .filter-chip-label').forEach(el => elements.push(el));
  const filterFab = document.getElementById('btn-filters');
  if (filterFab) elements.push(filterFab);
  const sharePill = document.getElementById('mode-url');
  if (sharePill) elements.push(sharePill);

  elements.forEach((el, i) => {
    el.classList.remove('filter-wave-pop');
    void el.offsetWidth;
    el.style.animationDelay = `${i * 75}ms`;
    el.classList.add('filter-wave-pop');
    el.addEventListener('animationend', () => {
      el.classList.remove('filter-wave-pop');
      el.style.animationDelay = '';
    }, { once: true });
  });
}

// Per-filter clearers — each filter chip has its own × button that drops
// just that one filter and re-syncs the world. Mirrors clearAllFilters'
// post-clear cleanup but limited to the dropped key.
function clearOneFilter(kind) {
  if (kind === 'jurisdiction') {
    state.filters.jurisdiction = null;
    document.querySelectorAll('.jurisdiction-chip').forEach(c => c.classList.remove('active'));
    if (typeof applyChipColors === 'function') applyChipColors(document.getElementById('jurisdiction-chips'));
  } else if (kind === 'location') {
    state.filters.location = null;
    // Dropping the region should show what dropping it revealed, so re-frame
    // on whatever is now in scope rather than leaving the map over one state.
    if (typeof updateMap === 'function') updateMap(state, { fit: true });
  } else if (kind === 'service') {
    state.filters.service = null;
  } else if (kind === 'day') {
    state.filters.day = null;
  } else if (kind === 'social') {
    state.filters.socialOnly = false;
    document.getElementById('btn-social')?.classList.remove('active');
  } else if (kind === 'english') {
    state.filters.englishOnly = false;
    state.filters.englishStrict = false;
    if (typeof syncEnglishButton === 'function') syncEnglishButton();
  } else if (kind === 'schedules') {
    state.mode = 'events';
    const servicesBtn = document.getElementById('btn-services');
    if (servicesBtn) servicesBtn.classList.remove('active');
    showView('events');
  } else if (kind === 'parishes') {
    state.filters.parishIds = null;
    state.filters.showAllParishes = null;
    state.parishFocus = null;
    if (typeof window.closeParishSheet === 'function' && state.parishSheetFocus) window.closeParishSheet();
  }
  syncParishRowVisibility();
  syncResetFab();
  renderParishPills();
  if (typeof updateArchdioceseEventsBanner === 'function') updateArchdioceseEventsBanner();
  if (typeof syncFiltersButton === 'function') syncFiltersButton();
  if (state.mode === 'services') {
    window.agoraFetchSchedules?.();
  } else {
    window.agoraFetchEvents();
  }
  syncURL();
}

function syncFilterActiveStack() {
  const stack = document.getElementById('filter-active-stack');
  if (!stack) return;
  // Each filter is now { kind, label } so the rendered chip can carry the
  // clearer wired to its specific filter key.
  const chips = [];
  if (state.filters.jurisdiction) chips.push({ kind: 'jurisdiction', label: capitalize(state.filters.jurisdiction) });
  if (state.filters.location) chips.push({ kind: 'location', label: locationLabel() || state.filters.location });
  if (state.filters.day != null) chips.push({ kind: 'day', label: dayNameFor(state.filters.day) });
  if (state.filters.service) chips.push({ kind: 'service', label: serviceLabelFor(state.filters.service) });
  if (state.filters.socialOnly) chips.push({ kind: 'social', label: 'Socials' });
  if (state.filters.englishOnly) {
    // Mirror the English button's tri-state vocabulary: strict = "English",
    // loose (any-bilingual) = "Bilingual".
    chips.push({ kind: 'english', label: state.filters.englishStrict ? 'English' : 'Bilingual' });
  }
  if (state.mode === 'services') chips.push({ kind: 'schedules', label: 'Schedules' });
  const parishCount = state.filters.parishIds ? state.filters.parishIds.size : 0;
  if (parishCount > 0) chips.push({ kind: 'parishes', label: `${parishCount} parish${parishCount === 1 ? '' : 'es'}` });

  const totalCount = chips.length;
  const hasFilters = totalCount > 0;
  const juris = state.filters.jurisdiction || null;
  const wasAdded = _lastFilterCount !== null && (
    totalCount > _lastFilterCount ||
    (juris !== null && juris !== _lastJurisdiction)
  );
  _lastFilterCount = totalCount;
  _lastJurisdiction = juris;

  stack.classList.toggle('visible', hasFilters);
  // Body class toggles the Share FAB's "Share" label reveal — affordance
  // appears at the moment sharing is most useful (a filter view to share).
  document.body.classList.toggle('has-filters', hasFilters);
  const list = document.getElementById('filter-chip-list');
  if (list) {
    list.textContent = '';
    chips.forEach(c => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'filter-chip-label';
      btn.dataset.kind = c.kind;
      btn.appendChild(document.createTextNode(c.label));
      const x = document.createElement('span');
      x.className = 'filter-chip-x';
      x.setAttribute('aria-hidden', 'true');
      x.textContent = '✕';
      btn.appendChild(x);
      btn.addEventListener('click', e => { e.stopPropagation(); clearOneFilter(c.kind); });
      list.appendChild(btn);
    });
  }

  if (wasAdded && hasFilters) {
    requestAnimationFrame(() => triggerFilterWave());
  }
}


// ── Location FAB (bottom right) ──
// Single toggle: sorts events by distance + sorts parish pills by distance
// + centers map on user. Icon swaps outline ↔ filled with state.
function initLocationFab() {
  const fab = document.getElementById('location-fab');
  if (!fab) return;

  function syncLocationState() {
    fab.classList.toggle('active', state.locationActive);
  }

  fab.addEventListener('click', () => {
    if (state.locationActive) {
      state.locationActive = false;
      state.nearPillActive = false;
      state.eventsSort = 'time';
      syncLocationState();
      renderParishPills();
      renderCurrentView();
      return;
    }
    requestGeolocation(() => {
      state.nearPillActive = true;
      state.eventsSort = 'nearby';
      syncLocationState();
      renderParishPills();
      renderCurrentView();
      centerMapOnUser();
    });
  });

  syncLocationState();
}

// ── Fit parish title to 2-line clamp ──
// CSS sets the max font-size; we step down until the element stops overflowing
// its clamped height. Leaves font-size untouched when already fits.
function fitParishName(el) {
  el.style.fontSize = '';
  const style = getComputedStyle(el);
  let size = parseFloat(style.fontSize);
  const MIN = 12;
  // scrollHeight > clientHeight means the 2-line clamp is ellipsizing.
  let guard = 0;
  while (el.scrollHeight > el.clientHeight + 1 && size > MIN && guard++ < 20) {
    size -= 1;
    el.style.fontSize = size + 'px';
  }
}

// ── Haversine distance ──
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Render without server calls — purely client-side ──
function renderCurrentView(opts = {}) {
  if (state.mode === 'services') {
    // Services renders synchronously — orchestrate the pending→applied
    // animation around the call so a filter toggle / mode change feels
    // like the same flow the events list uses.
    if (typeof markEventsPending === 'function') markEventsPending();
    renderServices();
    if (typeof markEventsApplied === 'function') {
      requestAnimationFrame(() => markEventsApplied());
    }
  } else {
    scheduleRenderEvents(200);
  }
  updateMap(state, { fit: !!opts.fit });
  syncResetFab();
}

// ── Parish focus ──
// Clears the single-parish scope: drops parishFocus + parishIds and closes
// the parish sheet if it's open. Invoked from the map's empty-tap handler
// (see map.js) and from the reset FAB flow.
function clearParishFocus() {
  if (!state.parishFocus && !state.parishSheetFocus) return;
  state.parishFocus = null;
  state.filters.parishIds = null;
  state.filters.multiParish = false;
  if (state.parishSheetFocus && typeof closeParishSheet === 'function') {
    closeParishSheet();
  }
  renderParishPills();
  renderCurrentView();
  syncURL();
}
window.agoraClearParishFocus = clearParishFocus;

// ── Apply client-side filters ──
// Non-viewport filters — explicit parish pick + parish-scoped + social + english.
// Split out so empty-state CTAs can ask "would this event pass if the user
// zoomed out far enough?" without re-implementing every axis.
function applyNonViewportFilters(events) {
  let filtered = events;
  // Parish-scoped events: only visible when the user has filtered to exactly
  // one parish AND that parish is the event's parish. Operational entries
  // like "SETUP" live here so the parish can track them without cluttering
  // the public feed. Cancelled events follow the same rule implicitly —
  // they're still visible to parishioners viewing that parish, but don't
  // surface in the open feed / map.
  const singleParishFilter = state.filters.parishIds && state.filters.parishIds.size === 1
    ? [...state.filters.parishIds][0]
    : null;
  filtered = filtered.filter(e => {
    const scoped = e.parish_scoped || e.status === 'cancelled' || e.status === 'combined';
    return !scoped || e.parish_id === singleParishFilter;
  });
  if (state.filters.parishIds) {
    filtered = filtered.filter(e =>
      state.filters.parishIds.has(e.parish_id) ||
      (e.extra_parishes && e.extra_parishes.some(pid => state.filters.parishIds.has(pid)))
    );
  }
  if (state.filters.location) {
    // An event is in the location if any parish showing it is — a combined
    // service listed under a Sydney and a Wollongong parish belongs in both.
    filtered = filtered.filter(e =>
      parishIdPassesLocation(e.parish_id) ||
      (e.extra_parishes && e.extra_parishes.some(pid => parishIdPassesLocation(pid)))
    );
  }
  if (state.filters.service) {
    filtered = filtered.filter(e => rowIsService(state.filters.service, e));
  }
  if (state.filters.day != null) {
    filtered = filtered.filter(e => eventLocalDow(e) === state.filters.day);
  }
  if (state.filters.socialOnly) {
    // Social = youth, social, talk, other, festival, fundraiser (everything NOT liturgical)
    filtered = filtered.filter(e => !LITURGICAL_TYPES.includes(e.event_type));
  }
  if (state.filters.englishOnly) {
    filtered = filtered.filter(e => {
      const langs = parseLangs(e.languages) || parseLangs(e.parish_languages);
      if (!langs) return false;
      if (state.filters.englishStrict) return langs.every(l => /english/i.test(l));
      return langs.some(l => /english/i.test(l));
    });
  }
  return filtered;
}

function applyFilters(events) {
  let filtered = applyNonViewportFilters(events);
  // Viewport axis — only applies when the user has NOT made an explicit parish
  // pick. Keeps pill taps / URL-scoped views visible even when off-screen.
  if (!state.filters.parishIds && state.viewportParishIds) {
    const vp = state.viewportParishIds;
    filtered = filtered.filter(e =>
      vp.has(e.parish_id) || (e.extra_parishes && e.extra_parishes.some(pid => vp.has(pid)))
    );
  }
  return filtered;
}

// Parish-sheet event list respects session social + english filters so the
// in-card filter buttons feel connected to the rest of the app. parish_id
// filter is already applied by the caller; parish_scoped is deliberately NOT
// enforced here (the card is the authoritative view for this parish).
function filterParishEventsBySession(events) {
  const f = state.parishFilters;
  let out = events;
  // A rule focus narrows the sheet to that one rule, from now on. "Now on"
  // rather than the usual whole window: the focus is a standing answer to
  // "when is the next one and the ones after it", and last Sunday's is not
  // part of that. An occurrence still running counts as now.
  const focus = state.parishScheduleFocus;
  if (focus) {
    const now = Date.now();
    const ids = new Set(focus.ruleIds || []);
    out = out.filter(e => {
      if (Date.parse(e.end_utc || e.start_utc) < now) return false;
      if (e.schedule_id != null) return ids.has(e.schedule_id);
      // A stored one-off belongs under a KIND focus but not under a rule
      // one: "Showing Liturgies" should include a Vesperal Liturgy that no
      // rule produces, while "Sunday morning Liturgy" is about that rule.
      if (focus.scope !== 'kind') return false;
      if (focus.slug && !rowIsService(focus.slug, e)) return false;
      if (focus.dow != null && eventLocalDow(e) !== focus.dow) return false;
      return true;
    });
  }
  if (f.socialOnly) {
    out = out.filter(e => !LITURGICAL_TYPES.includes(e.event_type));
  }
  if (f.englishOnly) {
    out = out.filter(e => {
      const langs = parseLangs(e.languages) || parseLangs(e.parish_languages);
      if (!langs) return false;
      if (f.englishStrict) return langs.every(l => /english/i.test(l));
      return langs.some(l => /english/i.test(l));
    });
  }
  return out;
}

// Schedules counterpart for parishFilters EN filter — service-times card
// should hide entries that don't match the chosen English mode, mirroring
// the main schedules list's behaviour.
function filterParishSchedulesBySession(schedules) {
  const f = state.parishFilters;
  if (!f.englishOnly) return schedules;
  return schedules.filter(s => {
    const langs = parseLangs(s.languages) || parseLangs(s.parish_languages);
    if (!langs) return false;
    if (f.englishStrict) return langs.every(l => /english/i.test(l));
    return langs.some(l => /english/i.test(l));
  });
}

// ── Bottom sheet ──
function initBottomSheet() {
  const sheet = document.getElementById('bottom-sheet');
  const handle = document.querySelector('.map-grab-handle');
  const modeBar = document.getElementById('mode-bar');
  const scroll = document.getElementById('sheet-scroll');
  const fab = document.getElementById('location-fab');
  const resetFab = document.getElementById('reset-fab');
  const filterFab = document.getElementById('btn-filters');
  const shareFab = document.getElementById('mode-url');
  const isDesktop = () => window.agoraIsDesktop?.() ?? false;
  // All sheet-following FABs share the lifecycle — fade during drag, snap
  // to (currentY - 52) on settle. Keeping them in an array lets the drag /
  // snap handlers iterate once instead of duplicating every touchpoint.
  const trackedFabs = [fab, resetFab, filterFab, shareFab].filter(Boolean);
  const filterStack = document.getElementById('filter-active-stack');
  function positionFilterStack(y) {
    if (filterStack) filterStack.style.bottom = (window.innerHeight - y + 60) + 'px';
  }
  // Expose so the parish-sheet closure (separate scope at initParishSheet)
  // can keep the filter stack in sync without reaching across closures.
  window.agoraPositionFilterStack = positionFilterStack;

  // Snap points (translateY values — lower = sheet higher on screen)
  let SNAP_FULL, SNAP_HALF, SNAP_PEEK;
  let currentY;

  // Must match .sheet-spacer flex-basis in app.css. Sheet extends this many
  // pixels past the visible viewport bottom at rest; the extra space is the
  // .sheet-spacer child, which fills the gap exposed when rubber-band past
  // SNAP_FULL visually lifts the sheet.
  const SHEET_SPACER_PX = 200;

  function computeSnaps() {
    // FULL leaves the jurisdiction banner + parish pill row visible above
    // the sheet — sheet's top edge sits just below the pill row (or below
    // the banner if pill row is hidden).
    const bannerWrap = document.getElementById('jurisdiction-banner-wrap');
    const pillWrap = document.getElementById('parish-filter-row-wrap');
    const pillVisible = pillWrap && pillWrap.classList.contains('visible');
    const topReserved = pillVisible
      ? (pillWrap.getBoundingClientRect().bottom)
      : (bannerWrap ? bannerWrap.getBoundingClientRect().bottom : 0);
    document.documentElement.style.setProperty('--banner-h', Math.round(topReserved) + 'px');
    if (isDesktop()) {
      SNAP_FULL = SNAP_HALF = SNAP_PEEK = 0;
      sheet.style.height = '';
      return;
    }
    SNAP_FULL = Math.max(0, Math.round(topReserved + 6));

    // PEEK exposes grab handle + mode bar.
    const handleEl = sheet.querySelector('.map-grab-handle');
    const modeBarEl = document.getElementById('mode-bar');
    const peekHeight = (handleEl?.offsetHeight || 14) + (modeBarEl?.offsetHeight || 38);
    SNAP_PEEK = window.innerHeight - peekHeight;

    // HALF shows mode-bar + ~one event card + a bit of pad. Single event
    // card is ~84px (padding 18 14 + content). 30px pad nudges the next
    // row's silhouette into view as a hint.
    const halfRevealPx = peekHeight + 84 + 30;
    SNAP_HALF = Math.max(SNAP_FULL + 80, window.innerHeight - halfRevealPx);

    sheet.style.height = `${window.innerHeight - SNAP_FULL + SHEET_SPACER_PX}px`;
  }
  computeSnaps();
  currentY = isDesktop() ? 0 : SNAP_HALF;
  document.body.classList.add('map-expanded');
  if (!isDesktop()) {
    sheet.style.transform = `translateY(${currentY}px)`;
    trackedFabs.forEach(f => { f.style.top = (currentY - 52) + 'px'; });
    positionFilterStack(currentY);
  }

  // Expose for map.js padding calculation
  window.agoraSheetY = () => currentY;

  // Lock scroll initially (sheet starts at half, not full)
  scroll.style.overflowY = isDesktop() ? 'auto' : 'hidden';

  // Recalculate on resize/orientation change
  window.addEventListener('resize', () => {
    computeSnaps();
    if (isDesktop()) return;
    currentY = nearestSnap(currentY, 0);
    sheet.style.transform = `translateY(${currentY}px)`;
  });

  // ── Snap logic ──
  const SNAPS = () => [SNAP_FULL, SNAP_HALF, SNAP_PEEK];

  function nearestSnap(y, velocity) {
    const snaps = SNAPS();
    // Velocity-based flick: if fast enough, go one snap in that direction
    if (Math.abs(velocity) > 400) {
      // Sort snaps ascending (full is smallest Y)
      const sorted = [...snaps].sort((a, b) => a - b);
      const closestIdx = sorted.reduce((best, s, i) =>
        Math.abs(s - y) < Math.abs(sorted[best] - y) ? i : best, 0);
      if (velocity < 0) {
        // Swiping up → smaller Y → go up one snap
        return sorted[Math.max(0, closestIdx - 1)];
      } else {
        // Swiping down → larger Y → go down one snap
        return sorted[Math.min(sorted.length - 1, closestIdx + 1)];
      }
    }
    // Otherwise nearest by distance
    return snaps.reduce((best, s) => Math.abs(s - y) < Math.abs(best - y) ? s : best);
  }

  function isAtFull() {
    return Math.abs(currentY - SNAP_FULL) < 5;
  }

  function updateScrollLock() {
    if (isDesktop()) { scroll.style.overflowY = 'auto'; return; }
    scroll.style.overflowY = isAtFull() ? 'auto' : 'hidden';
  }

  function snapTo(y) {
    // Timestamp every sheet snap. Both the map's movestart handler
    // (markEventsPending gate) and onViewportListPhase (markEventsApplied
    // gate) check Date.now() - __agoraSheetSnapAt < window. listPhase
    // fires ~800ms after the snap-driven moveend, so we need a window
    // longer than that — use 1100ms for safety.
    window.__agoraSheetSnapAt = Date.now();
    window.__agoraSheetMoving = true;
    currentY = y;
    window.agoraSheetY = () => currentY;
    if (isDesktop()) {
      document.documentElement.style.setProperty('--sheet-cover', '0px');
      window.agoraMap?.resize?.();
      if (typeof renderParishPills === 'function') renderParishPills();
      if (typeof updateInViewChevron === 'function') updateInViewChevron();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.__agoraSheetMoving = false;
      }));
      return;
    }
    sheet.classList.remove('dragging');
    sheet.classList.add('snapping');
    sheet.style.transform = `translateY(${y}px)`;
    // Reset scroll position when leaving full snap
    if (!isAtFull()) scroll.scrollTop = 0;
    // Map is "expanded" (primary view) when sheet is not at full height.
    document.body.classList.toggle('map-expanded', y >= SNAP_HALF - 5);
    // PEEK styling — sheet bg disappears so the mode-bar floats as a row of
    // FABs. Threshold ~SNAP_PEEK (within 8px) so the class settles cleanly.
    sheet.classList.toggle('peeking', y >= SNAP_PEEK - 8);
    updateScrollLock();
    const onDone = () => {
      sheet.classList.remove('snapping');
      // Parish sheet takes ownership of the FABs while main sheet is hidden.
      if (!window.agoraParishSheetVisible) {
        trackedFabs.forEach(f => {
          f.style.top = (currentY - 52) + 'px';
          f.classList.remove('fading');
        });
        positionFilterStack(currentY);
        if (filterStack) filterStack.classList.remove('fading');
      }
      updateScrollLock();
      if (window.agoraMap) {
        window.agoraMap.resize();
      }
      // Visible-rect centre changed → re-rank pills (sort origin moved).
      // Also keep the map-select overlay's bottom inset in sync with sheet.
      if (typeof renderParishPills === 'function') renderParishPills();
      document.documentElement.style.setProperty('--sheet-cover', (window.innerHeight - currentY) + 'px');
      if (typeof updateInViewChevron === 'function') updateInViewChevron();
      // Release the live "moving" flag two rAFs after settle so user
      // movestarts immediately afterwards aren't mistaken for sheet
      // motion. The timestamp keeps the wider gate (~1100ms) for the
      // delayed listPhase.
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.__agoraSheetMoving = false;
      }));
    };
    sheet.addEventListener('transitionend', onDone, { once: true });
    // Fallback if transitionend doesn't fire
    setTimeout(onDone, 400);
  }

  // ── Velocity tracking ──
  let velSamples = [];  // [{y, t}]
  function trackVelocity(y) {
    const now = Date.now();
    velSamples.push({ y, t: now });
    // Keep last 5 samples
    if (velSamples.length > 5) velSamples.shift();
  }
  function getVelocity() {
    if (velSamples.length < 2) return 0;
    const first = velSamples[0];
    const last = velSamples[velSamples.length - 1];
    const dt = (last.t - first.t) / 1000;
    return dt > 0 ? (last.y - first.y) / dt : 0;
  }

  // ── Drag state ──
  let dragging = false, startY = 0, sheetStartY = 0;

  function engageDrag(y) {
    if (isDesktop()) return;
    dragging = true;
    startY = y;
    sheetStartY = currentY;
    velSamples = [];
    sheet.classList.add('dragging');
    sheet.classList.remove('snapping');
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
    trackedFabs.forEach(f => f.classList.add('fading'));
    if (filterStack) filterStack.classList.add('fading');
  }

  function moveDrag(y) {
    if (isDesktop()) return;
    const dy = y - startY;
    let newY = sheetStartY + dy;
    // Rubber-band past limits
    if (newY < SNAP_FULL) {
      const over = SNAP_FULL - newY;
      newY = SNAP_FULL - over * 0.3;
    } else if (newY > SNAP_PEEK) {
      const over = newY - SNAP_PEEK;
      newY = SNAP_PEEK + over * 0.3;
    }
    currentY = newY;
    sheet.style.transform = `translateY(${newY}px)`;
    trackVelocity(y);
  }

  function endDrag() {
    if (isDesktop()) return;
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';
    const velocity = getVelocity();
    const target = nearestSnap(currentY, velocity);
    snapTo(target);
  }

  // ── Handle + mode bar drag (always drags sheet) ──
  function onHandleStart(e) {
    if (isDesktop()) return;
    if (e.cancelable) e.preventDefault();
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    engageDrag(y);
  }

  // Mode bar: defer drag decision so taps on buttons still fire as clicks,
  // but vertical drags started on a button still drag the sheet.
  // Axis-lock gesture state shared by mode-bar + parish-filter-row (both are
  // horizontal trays that sit above #sheet-scroll). Defer commit until the
  // finger has moved past THRESHOLD: dominant axis wins. Horizontal wins →
  // native scroll inside the tray; vertical wins → sheet drag.
  let trayPending = false;
  let trayPendingX = 0;
  let trayPendingY = 0;
  let trayLockedHoriz = false;
  let modeBarSwallowClick = false;
  const TRAY_DRAG_THRESHOLD = 8;

  function onTrayStart(e) {
    if (isDesktop()) return;
    const onInteractive = e.target.closest('button, a, .pill');
    const t = e.touches ? e.touches[0] : e;
    // Empty mode-bar space (no button underneath): drag sheet immediately.
    // Anywhere else — over buttons, over the parish-filter-row pills, over
    // the URL chip — defer until the axis is decided.
    if (!onInteractive && e.currentTarget.id === 'mode-bar') {
      if (e.cancelable) e.preventDefault();
      engageDrag(t.clientY);
      return;
    }
    trayPending = true;
    trayLockedHoriz = false;
    trayPendingX = t.clientX;
    trayPendingY = t.clientY;
  }

  function onDocMove(e) {
    if (isDesktop()) return;
    if (trayPending) {
      const t = e.touches ? e.touches[0] : e;
      const dx = t.clientX - trayPendingX;
      const dy = t.clientY - trayPendingY;
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      if (adx > TRAY_DRAG_THRESHOLD || ady > TRAY_DRAG_THRESHOLD) {
        trayPending = false;
        if (ady > adx) {
          // Vertical dominates → sheet drag. Swallow the trailing click so the
          // underlying button doesn't fire on release.
          modeBarSwallowClick = true;
          engageDrag(t.clientY);
        } else {
          // Horizontal dominates → native tray scroll. Remember the lock so a
          // wobble back to vertical mid-gesture doesn't flip us into a drag.
          trayLockedHoriz = true;
        }
      }
    }
    if (!dragging) return;
    if (e.cancelable) e.preventDefault();
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    moveDrag(y);
  }

  function onDocEnd() {
    if (isDesktop()) return;
    trayPending = false;
    trayLockedHoriz = false;
    if (dragging) endDrag();
    // Browsers suppress the synthetic click when the touch moved far enough,
    // so modeBarSwallowClick would otherwise stay true and eat the user's
    // NEXT real tap on a mode-bar button. Clear it on a short timer so we
    // only ever swallow the one follow-up click.
    if (modeBarSwallowClick) {
      setTimeout(() => { modeBarSwallowClick = false; }, 400);
    }
  }

  // Cancel the synthetic click when a mode-bar drag was engaged from a button.
  modeBar.addEventListener('click', e => {
    if (modeBarSwallowClick) {
      e.preventDefault();
      e.stopPropagation();
      modeBarSwallowClick = false;
    }
  }, true);

  handle.addEventListener('mousedown', onHandleStart);
  handle.addEventListener('touchstart', onHandleStart, { passive: false });
  modeBar.addEventListener('mousedown', onTrayStart);
  modeBar.addEventListener('touchstart', onTrayStart, { passive: false });
  const parishRow = document.getElementById('parish-filter-row');
  if (parishRow) {
    parishRow.addEventListener('mousedown', onTrayStart);
    parishRow.addEventListener('touchstart', onTrayStart, { passive: false });
  }
  document.addEventListener('mousemove', onDocMove);
  document.addEventListener('touchmove', onDocMove, { passive: false });
  document.addEventListener('mouseup', onDocEnd);
  document.addEventListener('touchend', onDocEnd);
  // touchcancel fires when iOS's system gesture (e.g. home-indicator
  // swipe-up to multitask) intercepts a touch sequence. Without this
  // handler the sheet stays in dragging state and "finishes" the drag
  // when the user returns to the app.
  document.addEventListener('touchcancel', onDocEnd);
  // Same protection for app backgrounding via the home indicator —
  // visibilitychange fires before iOS suspends the page, giving us a
  // last frame to release any pending drag.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && dragging) {
      dragging = false;
      sheet.classList.remove('dragging');
    }
  });

  // ── Scroll area touch handling ──
  // When sheet is NOT at full: all vertical touches drag the sheet (scroll is locked)
  // When sheet IS at full: scroll normally, but at scrollTop===0 swiping down drags sheet
  const DEAD_ZONE = 8;
  let scrollState = 'idle'; // idle | deciding | scrolling | dragging | scrolling-active
  let scrollStartY = 0, scrollStartX = 0, scrollStartTop = 0;
  let scrollLastY = 0;

  scroll.addEventListener('touchstart', e => {
    if (isDesktop()) return;
    scrollStartY = e.touches[0].clientY;
    scrollStartX = e.touches[0].clientX;
    scrollStartTop = scroll.scrollTop;
    scrollLastY = e.touches[0].clientY;
    scrollState = 'deciding';
  }, { passive: true });

  scroll.addEventListener('touchmove', e => {
    if (isDesktop()) return;
    if (scrollState === 'idle') return;

    const y = e.touches[0].clientY;
    const x = e.touches[0].clientX;
    const dy = y - scrollStartY;
    const dx = x - scrollStartX;

    if (scrollState === 'scrolling') {
      // Mid-gesture handoff: native scroll hit the top of the list and the
      // finger is still pulling down → take over and drag the sheet.
      if (isAtFull() && scroll.scrollTop <= 0 && y > scrollLastY) {
        scrollState = 'dragging';
        engageDrag(y);
        if (e.cancelable) e.preventDefault();
        scrollLastY = y;
        return;
      }
      scrollLastY = y;
      return;
    }

    if (scrollState === 'deciding') {
      if (Math.abs(dy) < DEAD_ZONE && Math.abs(dx) < DEAD_ZONE) return;

      // Horizontal gesture — let it through (pill rows etc)
      if (Math.abs(dx) > Math.abs(dy)) {
        scrollState = 'scrolling';
        return;
      }

      // Not at full → always drag the sheet (scroll is locked via overflow:hidden)
      if (!isAtFull()) {
        scrollState = 'dragging';
        engageDrag(y);
        if (e.cancelable) e.preventDefault();
        return;
      }

      // At full but list isn't scrollable → any vertical drag goes to the
      // sheet so swiping up rubber-bands past full and swiping down drags
      // the sheet away from full.
      if (scroll.scrollHeight <= scroll.clientHeight) {
        scrollState = 'dragging';
        engageDrag(y);
        if (e.cancelable) e.preventDefault();
        return;
      }

      // At full: swiping down at scrollTop===0 → drag sheet down
      if (scrollStartTop <= 0 && dy > 0) {
        scrollState = 'dragging';
        engageDrag(y);
        if (e.cancelable) e.preventDefault();
        return;
      }

      // At full, scrolling content normally
      scrollState = 'scrolling';
      return;
    }

    if (scrollState === 'dragging') {
      if (e.cancelable) e.preventDefault();
      // Would this move push the sheet past SNAP_FULL? Hand off the same
      // gesture to list scroll — but only if the list is actually
      // scrollable. On short lists fall through to moveDrag so the sheet
      // rubber-bands past full and bounces back on release.
      const projectedY = sheetStartY + (y - startY);
      const listScrollable = scroll.scrollHeight > scroll.clientHeight;
      if (projectedY < SNAP_FULL && listScrollable) {
        currentY = SNAP_FULL;
        window.agoraSheetY = () => currentY;
        sheet.style.transform = `translateY(${SNAP_FULL}px)`;
        sheet.classList.remove('dragging');
        dragging = false;
        document.body.style.userSelect = '';
        document.body.style.webkitUserSelect = '';
        scroll.style.overflowY = 'auto';
        // yc = finger-y at which the sheet reached SNAP_FULL. From here on,
        // scrollStartY/scrollStartTop mean list-scroll baseline, not drag.
        const yc = startY - sheetStartY + SNAP_FULL;
        scrollStartY = yc;
        scrollStartTop = 0;
        scroll.scrollTop = yc - y;
        scrollState = 'scrolling-active';
        return;
      }
      moveDrag(y);
      return;
    }

    if (scrollState === 'scrolling-active') {
      if (e.cancelable) e.preventDefault();
      const newScrollTop = scrollStartTop - dy;
      if (newScrollTop < 0) {
        // Finger back below handoff point → resume dragging the sheet.
        scroll.scrollTop = 0;
        scrollState = 'dragging';
        engageDrag(y);
        return;
      }
      scroll.scrollTop = newScrollTop;
    }
  }, { passive: false });

  scroll.addEventListener('touchend', () => {
    if (isDesktop()) return;
    if (scrollState === 'dragging') {
      endDrag();
    }
    scrollState = 'idle';
  }, { passive: true });

  // Expose snapTo for external callers (map popup "All events" button)
  window.agoraSnapTo = snapTo;
  window.agoraSnapFull = () => SNAP_FULL;
  window.agoraSnapHalf = () => SNAP_HALF;
  window.agoraSnapPeek = () => SNAP_PEEK;
  // Expose recompute so syncParishRowVisibility can re-measure once the
  // Re-measurement hook for orientation / font-load changes. Parish pill
  // row is no longer in the sheet so this only re-figures grab handle +
  // mode-bar measurements.
  window.agoraRecomputeSnaps = () => { computeSnaps(); };

  // Hide/restore for parish sheet overlay — stash current Y and scrollTop,
  // snap offscreen, restore both when overlay closes. snapTo itself resets
  // scrollTop when leaving full, so capture + rewrite it around the snap.
  let _stashedY = null;
  let _stashedScroll = 0;
  window.agoraMainHide = () => {
    if (isDesktop()) {
      document.body.classList.add('main-sheet-hidden');
      return;
    }
    if (_stashedY != null) return;
    _stashedY = currentY;
    _stashedScroll = scroll.scrollTop;
    snapTo(window.innerHeight);
  };
  window.agoraMainRestore = () => {
    if (isDesktop()) {
      document.body.classList.remove('main-sheet-hidden');
      return;
    }
    if (_stashedY == null) return;
    const y = _stashedY;
    const s = _stashedScroll;
    _stashedY = null;
    snapTo(y);
    // snapTo zeroes scrollTop when not at full. Put the user back where they
    // were — after snapTo flips overflow to auto (at full) or keeps it
    // hidden (at half). Either way, writing scrollTop on the next frame
    // beats the snapTo reset.
    requestAnimationFrame(() => { scroll.scrollTop = s; });
  };

  // Breakpoint cross: end any in-flight drag, reset inline styles, reflow.
  // body[data-layout] flip already happened in the boot-level MQL handler.
  document.addEventListener('agora:layoutchange', () => {
    if (dragging) {
      dragging = false;
      sheet.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
      trackedFabs.forEach(f => f.classList.remove('fading'));
      if (filterStack) filterStack.classList.remove('fading');
    }
    computeSnaps();
    if (isDesktop()) {
      sheet.style.transform = '';
      sheet.style.height = '';
      sheet.classList.remove('peeking', 'snapping');
      document.body.classList.add('map-expanded');
      currentY = 0;
      document.documentElement.style.setProperty('--sheet-cover', '0px');
      scroll.style.overflowY = 'auto';
    } else {
      currentY = SNAP_HALF;
      sheet.style.transform = `translateY(${currentY}px)`;
      document.body.classList.add('map-expanded');
      trackedFabs.forEach(f => { f.style.top = (currentY - 52) + 'px'; });
      positionFilterStack(currentY);
      updateScrollLock();
      document.documentElement.style.setProperty('--sheet-cover', (window.innerHeight - currentY) + 'px');
    }
  });
}

// ── Parish sheet (secondary, opened from event drawer parish header) ──
let _parishSheetAPI = null;

function initParishSheet() {
  const sheet = document.getElementById('parish-sheet');
  const handle = sheet.querySelector('.parish-sheet-grab-handle');
  const closeBtn = document.getElementById('parish-sheet-close');
  const scroll = document.getElementById('parish-sheet-scroll');
  const fab = document.getElementById('location-fab');
  const filterFab = document.getElementById('btn-filters');
  const isDesktop = () => window.agoraIsDesktop?.() ?? false;
  // Share FAB (bottom-left) needs to track parish-sheet height too —
  // earlier rounds added it to the main sheet's trackedFabs but the
  // parish sheet had its own [fab, filterFab] iteration.
  const shareFab = document.getElementById('mode-url');
  const psTrackedFabs = [fab, filterFab, shareFab].filter(Boolean);

  let SNAP_FULL, SNAP_HALF, SNAP_PEEK, SNAP_HIDDEN;
  let currentY;
  let dragging = false, startY = 0, sheetStartY = 0;
  let velSamples = [];

  function computeSnaps() {
    if (isDesktop()) {
      SNAP_FULL = SNAP_HALF = SNAP_PEEK = SNAP_HIDDEN = 0;
      sheet.style.height = '';
      return;
    }
    SNAP_FULL = 0;
    SNAP_HALF = Math.round(window.innerHeight * 0.5);
    SNAP_PEEK = window.innerHeight - 180;
    SNAP_HIDDEN = window.innerHeight;
    sheet.style.height = `${window.innerHeight}px`;
  }
  computeSnaps();
  currentY = isDesktop() ? 0 : SNAP_HIDDEN;
  if (!isDesktop()) sheet.style.transform = `translateY(${currentY}px)`;

  window.addEventListener('resize', () => {
    computeSnaps();
    if (isDesktop()) return;
    if (currentY !== SNAP_HIDDEN && !sheet.classList.contains('hidden')) {
      currentY = nearestSnap(currentY, 0);
      sheet.style.transform = `translateY(${currentY}px)`;
    }
  });

  function nearestSnap(y, velocity) {
    const snaps = [SNAP_FULL, SNAP_HALF, SNAP_PEEK];
    if (Math.abs(velocity) > 400) {
      const sorted = [...snaps].sort((a, b) => a - b);
      const closestIdx = sorted.reduce((best, s, i) =>
        Math.abs(s - y) < Math.abs(sorted[best] - y) ? i : best, 0);
      if (velocity < 0) return sorted[Math.max(0, closestIdx - 1)];
      return sorted[Math.min(sorted.length - 1, closestIdx + 1)];
    }
    return snaps.reduce((best, s) => Math.abs(s - y) < Math.abs(best - y) ? s : best);
  }

  function isAtFull() { return Math.abs(currentY - SNAP_FULL) < 5; }

  function updateScrollLock() {
    if (isDesktop()) { scroll.style.overflowY = 'auto'; return; }
    scroll.style.overflowY = isAtFull() ? 'auto' : 'hidden';
  }

  function snapTo(y, onDone) {
    // Same flag + timestamp the main sheet uses — gate both the
    // immediate movestart (pending-mark) and the delayed listPhase
    // (applied-mark) so parish-sheet snaps don't make the events
    // fade/glimmer when nothing about which events to show is changing.
    window.__agoraSheetSnapAt = Date.now();
    window.__agoraSheetMoving = true;
    currentY = y;
    if (isDesktop()) {
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.__agoraSheetMoving = false;
        if (onDone) onDone();
      }));
      return;
    }
    sheet.classList.remove('dragging');
    sheet.classList.add('snapping');
    sheet.style.transform = `translateY(${y}px)`;
    if (!isAtFull()) scroll.scrollTop = 0;
    updateScrollLock();
    let settled = false;
    const handler = () => {
      if (settled) return;
      settled = true;
      sheet.classList.remove('snapping');
      updateScrollLock();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        window.__agoraSheetMoving = false;
      }));
      // Follow parish sheet with the location + filter + share FABs +
      // the filter-active stack. (onDone takes care of dismissal cleanup
      // separately.)
      if (window.agoraParishSheetVisible) {
        psTrackedFabs.forEach(f => {
          f.style.top = (currentY - 52) + 'px';
          f.classList.remove('fading');
        });
        const filterStack = document.getElementById('filter-active-stack');
        if (filterStack) {
          filterStack.style.bottom = (window.innerHeight - currentY + 60) + 'px';
          filterStack.classList.remove('fading');
        }
      }
      if (onDone) onDone();
    };
    sheet.addEventListener('transitionend', handler, { once: true });
    setTimeout(handler, 400);
  }

  function trackVelocity(y) {
    velSamples.push({ y, t: Date.now() });
    if (velSamples.length > 5) velSamples.shift();
  }
  function getVelocity() {
    if (velSamples.length < 2) return 0;
    const first = velSamples[0];
    const last = velSamples[velSamples.length - 1];
    const dt = (last.t - first.t) / 1000;
    return dt > 0 ? (last.y - first.y) / dt : 0;
  }

  function engageDrag(y) {
    if (isDesktop()) return;
    dragging = true;
    startY = y;
    sheetStartY = currentY;
    velSamples = [];
    sheet.classList.add('dragging');
    sheet.classList.remove('snapping');
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
    psTrackedFabs.forEach(f => f.classList.add('fading'));
    const filterStack = document.getElementById('filter-active-stack');
    if (filterStack) filterStack.classList.add('fading');
  }

  function moveDrag(y) {
    if (isDesktop()) return;
    const dy = y - startY;
    let newY = sheetStartY + dy;
    if (newY < SNAP_FULL) {
      const over = SNAP_FULL - newY;
      newY = SNAP_FULL - over * 0.3;
    }
    if (newY > SNAP_HIDDEN) newY = SNAP_HIDDEN;
    currentY = newY;
    sheet.style.transform = `translateY(${newY}px)`;
    trackVelocity(y);
  }

  function endDrag() {
    if (isDesktop()) return;
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';
    const velocity = getVelocity();
    // Dismiss if dragged well past peek, or fast-flicked down past half.
    // Route through closeParishSheet so the implicit single-pill filter
    // gets cleared on swipe-dismiss too (the inner close() bypasses it).
    const dismissThreshold = SNAP_PEEK + 60;
    if (currentY > dismissThreshold || (velocity > 600 && currentY > SNAP_HALF)) {
      if (typeof window.closeParishSheet === 'function') window.closeParishSheet();
      else close();
      return;
    }
    snapTo(nearestSnap(currentY, velocity));
  }

  function onHandleStart(e) {
    if (isDesktop()) return;
    if (e.cancelable) e.preventDefault();
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    engageDrag(y);
  }
  // Axis-locked drag from the parish header. Mirrors mode-bar behaviour on
  // the main sheet: empty header space starts drag immediately; touches on
  // buttons/links defer until the gesture's dominant axis is known so taps
  // still fire as clicks while vertical flicks drag the sheet.
  let headerPending = false;
  let headerPX = 0, headerPY = 0;
  let headerSwallowClick = false;
  const HEADER_THRESHOLD = 8;

  function onHeaderStart(e) {
    if (isDesktop()) return;
    const headerEl = e.target.closest('.ps-header');
    if (!headerEl) return;
    const t = e.touches ? e.touches[0] : e;
    const onInteractive = e.target.closest('button, a, .pill');
    // Stop the touchstart from bubbling to the scroll container so it
    // doesn't enter its own deciding-state machine while we own the gesture.
    e.stopPropagation();
    if (!onInteractive) {
      if (e.cancelable) e.preventDefault();
      engageDrag(t.clientY);
      return;
    }
    headerPending = true;
    headerPX = t.clientX;
    headerPY = t.clientY;
  }

  function onDocMove(e) {
    if (isDesktop()) return;
    if (headerPending) {
      const t = e.touches ? e.touches[0] : e;
      const dx = t.clientX - headerPX;
      const dy = t.clientY - headerPY;
      const adx = Math.abs(dx), ady = Math.abs(dy);
      if (adx > HEADER_THRESHOLD || ady > HEADER_THRESHOLD) {
        headerPending = false;
        if (ady > adx) {
          headerSwallowClick = true;
          engageDrag(t.clientY);
        }
      }
    }
    if (!dragging) return;
    if (e.cancelable) e.preventDefault();
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    moveDrag(y);
  }
  function onDocEnd() {
    if (isDesktop()) return;
    headerPending = false;
    if (dragging) endDrag();
    if (headerSwallowClick) setTimeout(() => { headerSwallowClick = false; }, 400);
  }

  handle.addEventListener('mousedown', onHandleStart);
  handle.addEventListener('touchstart', onHandleStart, { passive: false });
  // Delegate header drag via the stable #parish-sheet-content wrapper so it
  // survives the innerHTML swap that renderParishSheetContent performs each
  // time the card is rebuilt.
  const contentEl = document.getElementById('parish-sheet-content');
  if (contentEl) {
    contentEl.addEventListener('mousedown', onHeaderStart);
    contentEl.addEventListener('touchstart', onHeaderStart, { passive: false });
    // Eat the synthetic click emitted after a header-initiated drag so the
    // underlying button (filters, URL-copy) doesn't fire on release.
    contentEl.addEventListener('click', e => {
      if (!e.target.closest('.ps-header')) return;
      if (headerSwallowClick) {
        e.preventDefault();
        e.stopPropagation();
        headerSwallowClick = false;
      }
    }, true);
  }
  document.addEventListener('mousemove', onDocMove);
  document.addEventListener('touchmove', onDocMove, { passive: false });
  document.addEventListener('mouseup', onDocEnd);
  document.addEventListener('touchend', onDocEnd);
  // iPhone home-indicator gesture (swipe-up-to-multitask) fires
  // touchcancel mid-sequence — release any pending drag so the sheet
  // doesn't keep dragging state when the user returns.
  document.addEventListener('touchcancel', onDocEnd);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && dragging) {
      dragging = false;
      sheet.classList.remove('dragging');
    }
  });

  // Scroll-area drag handoff — mirror of main sheet.
  const DEAD_ZONE = 8;
  let scrollState = 'idle';
  let scrollStartY = 0, scrollStartX = 0, scrollStartTop = 0, scrollLastY = 0;

  scroll.addEventListener('touchstart', e => {
    if (isDesktop()) return;
    scrollStartY = e.touches[0].clientY;
    scrollStartX = e.touches[0].clientX;
    scrollStartTop = scroll.scrollTop;
    scrollLastY = e.touches[0].clientY;
    scrollState = 'deciding';
  }, { passive: true });

  scroll.addEventListener('touchmove', e => {
    if (isDesktop()) return;
    if (scrollState === 'idle') return;
    const y = e.touches[0].clientY;
    const x = e.touches[0].clientX;
    const dy = y - scrollStartY;
    const dx = x - scrollStartX;

    if (scrollState === 'scrolling') {
      if (isAtFull() && scroll.scrollTop <= 0 && y > scrollLastY) {
        scrollState = 'dragging';
        engageDrag(y);
        if (e.cancelable) e.preventDefault();
      }
      scrollLastY = y;
      return;
    }

    if (scrollState === 'deciding') {
      if (Math.abs(dy) < DEAD_ZONE && Math.abs(dx) < DEAD_ZONE) return;
      if (Math.abs(dx) > Math.abs(dy)) { scrollState = 'scrolling'; return; }
      if (!isAtFull() || scroll.scrollHeight <= scroll.clientHeight ||
          (scrollStartTop <= 0 && dy > 0)) {
        scrollState = 'dragging';
        engageDrag(y);
        if (e.cancelable) e.preventDefault();
        return;
      }
      scrollState = 'scrolling';
      return;
    }

    if (scrollState === 'dragging') {
      if (e.cancelable) e.preventDefault();
      // Mid-gesture handoff: drag hit SNAP_FULL with more finger-travel to
      // give, and the list is scrollable → hand off to native scroll so one
      // swipe can go half → full → deep into upcoming events.
      const projectedY = sheetStartY + (y - startY);
      const listScrollable = scroll.scrollHeight > scroll.clientHeight;
      if (projectedY < SNAP_FULL && listScrollable) {
        currentY = SNAP_FULL;
        sheet.style.transform = `translateY(${SNAP_FULL}px)`;
        sheet.classList.remove('dragging');
        dragging = false;
        document.body.style.userSelect = '';
        document.body.style.webkitUserSelect = '';
        scroll.style.overflowY = 'auto';
        if (fab && window.agoraParishSheetVisible) {
          fab.style.top = (SNAP_FULL - 52) + 'px';
          fab.classList.remove('fading');
        }
        const yc = startY - sheetStartY + SNAP_FULL;
        scrollStartY = yc;
        scrollStartTop = 0;
        scroll.scrollTop = yc - y;
        scrollState = 'scrolling-active';
        return;
      }
      moveDrag(y);
      return;
    }

    if (scrollState === 'scrolling-active') {
      if (e.cancelable) e.preventDefault();
      const newScrollTop = scrollStartTop - dy;
      if (newScrollTop < 0) {
        // Finger came back below the handoff point → resume dragging sheet.
        scroll.scrollTop = 0;
        scrollState = 'dragging';
        engageDrag(y);
        return;
      }
      scroll.scrollTop = newScrollTop;
    }
  }, { passive: false });

  scroll.addEventListener('touchend', () => {
    if (isDesktop()) return;
    if (scrollState === 'dragging') endDrag();
    scrollState = 'idle';
  }, { passive: true });

  // Close via the public closeParishSheet wrapper so the implicit
  // single-pill filter (set on open) gets cleared on dismiss too.
  closeBtn.addEventListener('click', () => {
    if (typeof window.closeParishSheet === 'function') window.closeParishSheet();
    else close();
  });

  function open(parishId, openOpts = {}) {
    const parish = state.parishes.find(p => p.id === parishId);
    if (!parish) return;
    // If a different parish is being opened and _openEventId belongs to a
    // different parish, drop the stale event id so URL + header agree.
    if (state._openEventId) {
      const evt = state.events.find(e => e.id === state._openEventId);
      if (evt && evt.parish_id !== parishId) {
        delete state._openEventId;
        syncURL();
      }
    }
    state._parishEventsShowCount = 30;
    renderParishSheetContent(parishId, openOpts);
    // Map highlight: dim other markers, enlarge focused dot + label.
    state.parishSheetFocus = parishId;
    // URL carries /<acronym> while the parish sheet is open so the address
    // bar reflects the current surface and tapping copy yields a deep link.
    // Deep-link / refresh opens the sheet on load: write via replaceState so
    // /services/<parish> → /<parish> canonicalization doesn't leave a dead
    // history entry the back button has to step over.
    syncURL(openOpts.replaceUrl ? { replace: true } : {});
    if (typeof updateMap === 'function') updateMap(state);
    sheet.classList.remove('hidden');
    sheet.setAttribute('aria-hidden', 'false');
    window.agoraParishSheetVisible = true;
    document.body.classList.add('parish-sheet-open');
    state.parishFilters = { socialOnly: false, englishOnly: false, englishStrict: false };
    syncFiltersButton();
    syncEnglishButton();
    // Ensure we start at SNAP_HIDDEN, then force layout so transition fires.
    currentY = SNAP_HIDDEN;
    sheet.classList.remove('snapping');
    sheet.style.transform = `translateY(${SNAP_HIDDEN}px)`;
    void sheet.offsetHeight; // force reflow
    // Open at half: map stays visible above, parish card + events below.
    snapTo(SNAP_HALF);
    if (window.agoraMainHide) window.agoraMainHide();
    // Reset-fab belongs to the main list scope — hide while parish sheet
    // owns the surface (main sheet's onDone won't touch the fabs while
    // parish sheet is visible, so do it explicitly here).
    const rFab = document.getElementById('reset-fab');
    if (rFab) rFab.classList.add('fading');
    // Seed filter FAB + stack position so they appear at the right spot when revealed.
    if (filterFab) filterFab.style.top = (SNAP_HALF - 52) + 'px';
    if (window.agoraPositionFilterStack) window.agoraPositionFilterStack(SNAP_HALF);

    // Centre the parish in the visible (upper) half of the map, zooming in
    // only if current viewing radius is wider than 30 km.
    if (window.agoraMap && parish.lat && parish.lng) {
      const map = window.agoraMap;
      const c = map.getCenter();
      const ne = map.getBounds().getNorthEast();
      const radiusKm = haversineKm(c.lat, c.lng, ne.lat, ne.lng);

      // Compute the target camera centre directly: project the parish at
      // current zoom, push the centre down by half the sheet-occluded height
      // (scaled to target zoom), unproject. Avoids relying on flyTo's
      // padding/offset options, which silently no-op'd in MapLibre 4.7.1
      // when combined with center+zoom.
      const currentZoom = map.getZoom();
      const targetZoom = radiusKm > 30 ? Math.max(currentZoom, 12) : currentZoom;
      const scale = Math.pow(2, targetZoom - currentZoom);
      const containerH = map.getContainer().clientHeight;
      const dxAtTargetZoom = isDesktop() ? 210 : 0;
      const dyAtTargetZoom = isDesktop() ? 0 : (containerH - SNAP_HALF) / 2;
      const parishPx = map.project([parish.lng, parish.lat]);
      const newCentre = map.unproject([
        parishPx.x + dxAtTargetZoom / scale,
        parishPx.y + dyAtTargetZoom / scale
      ]);

      map.flyTo({
        center: [newCentre.lng, newCentre.lat],
        zoom: targetZoom,
        duration: radiusKm > 30 ? 1200 : 900
      });
    }
  }

  function close() {
    // Release FAB ownership so main sheet's pending/next snapTo repositions it.
    window.agoraParishSheetVisible = false;
    document.body.classList.remove('parish-sheet-open');
    syncFiltersButton();
    syncEnglishButton();
    // Keep state._openEventId so the URL remains shareable for the event.
    // Drop parishSheetFocus (it drove the /<acronym> URL segment while the
    // sheet was open) and resync so the URL no longer advertises a view that
    // has been torn down.
    state.parishSheetFocus = null;
    syncURL();
    if (typeof updateMap === 'function') updateMap(state);
    snapTo(SNAP_HIDDEN, () => {
      sheet.classList.add('hidden');
      sheet.setAttribute('aria-hidden', 'true');
    });
    // Restore main list cards that renderParishSheetContent may have stolen via
    // diffCardsInto (card pool nodes move between containers; main hosts go empty).
    renderEvents();
    if (window.agoraMainRestore) window.agoraMainRestore();
  }

  _parishSheetAPI = { open, close };
  // Expose snap-to-full so expandEventCard can drive the parish sheet to
  // FULL when an event inside it is tapped (matches the main sheet's
  // tap-to-full behaviour).
  window.agoraParishSheetSnapFull = () => snapTo(SNAP_FULL);

  document.addEventListener('agora:layoutchange', () => {
    if (dragging) {
      dragging = false;
      sheet.classList.remove('dragging');
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
      psTrackedFabs.forEach(f => f.classList.remove('fading'));
    }
    computeSnaps();
    if (isDesktop()) {
      sheet.style.transform = '';
      sheet.style.height = '';
      sheet.classList.remove('snapping', 'dragging');
      currentY = 0;
      scroll.style.overflowY = 'auto';
    } else if (window.agoraParishSheetVisible) {
      currentY = SNAP_HALF;
      sheet.style.transform = `translateY(${currentY}px)`;
      updateScrollLock();
    } else {
      currentY = SNAP_HIDDEN;
      sheet.style.transform = `translateY(${currentY}px)`;
    }
  });
}

// The banner a schedule focus spawns, between the service times and the
// events list it has narrowed. It says what is being shown in words rather
// than as a pill, because the answer has three parts that a pill cannot hold
// — which day, which service, in which language — and because the list under
// it would otherwise look like the parish's whole feed with most of it
// missing.
function scheduleFocusBannerHtml(parish) {
  const focus = state.parishScheduleFocus;
  if (!focus) return '';
  const accent = getParishDisplayColor((parish && parish.color) || rawJurisColor(parish && parish.jurisdiction));
  return `<div class="ps-focus-banner" style="--parish-color:${esc(accent)}">
      <span class="ps-focus-banner-text">Showing ${esc(scheduleFocusLabel(focus))}</span>
      <button class="ps-focus-banner-x" type="button" data-schedule-focus-clear aria-label="Show everything at this parish">&times;</button>
    </div>`;
}

// "Sunday morning Liturgy in English" / "Tuesday evening Bible studies" /
// "Liturgies".
//
// One rule can be described exactly; a kind that covers several cannot, since
// they differ on the very things the sentence would name. So a multi-rule
// focus falls back to the plural alone and lets the list say the rest.
function scheduleFocusLabel(focus) {
  const rule = focus.scheduleId != null
    ? (state.schedules || []).find(s => s.id === focus.scheduleId)
    : null;
  if (!rule) {
    // Several rules: name the day if they share one, then the plural.
    const day = focus.dow != null ? dayNameFor(focus.dow) : '';
    const kind = focus.slug ? servicePluralFor(focus.slug) : 'services';
    return [day, kind].filter(Boolean).join(' ');
  }
  const day = womDescribeDay(rule);
  const part = partOfDay(rule.start_time);
  const title = rule.title || (focus.slug ? serviceLabelFor(focus.slug) : 'service');
  const langs = describeLanguages(rule.languages);
  return [day, part, title].filter(Boolean).join(' ') + (langs ? ` in ${langs}` : '');
}

/** "Sunday", or "1st and 3rd Saturday" when the rule is week-of-month. */
function womDescribeDay(rule) {
  const day = DAYS[rule.day_of_week] || '';
  if (!rule.week_of_month) return day;
  const map = { first: '1st', second: '2nd', third: '3rd', fourth: '4th', last: 'last' };
  const parts = String(rule.week_of_month).split(',').map(w => map[w.trim()] || w.trim());
  const joined = parts.length > 1
    ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]
    : parts[0];
  return `${joined} ${day}`;
}

// Evening rather than night for a 7pm service: it is what a vespers or a
// weeknight study is actually called. Night is kept for genuinely late ones
// — a Paschal liturgy at 11pm is not an evening service.
function partOfDay(startTime) {
  const h = Number(String(startTime || '').slice(0, 2));
  if (!Number.isFinite(h)) return '';
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  if (h < 21) return 'evening';
  return 'night';
}

/** "English", "Arabic and English", or '' when it adds nothing. */
function describeLanguages(raw) {
  const langs = parseLangs(raw);
  if (!langs || !langs.length) return '';
  if (langs.length === 1) return langs[0];
  return langs.slice(0, -1).join(', ') + ' and ' + langs[langs.length - 1];
}

function servicePluralFor(slug) {
  const S = window.AgoraServices;
  return S ? S.servicePlural(slug) : String(slug || '');
}

function resolveDaySlug(seg) {
  const S = window.AgoraServices;
  return S ? S.resolveDay(seg) : null;
}
function daySlugFor(dow) {
  const S = window.AgoraServices;
  return S ? S.daySlug(dow) : null;
}
function dayNameFor(dow) {
  const S = window.AgoraServices;
  return S ? S.dayName(dow) : (DAYS[dow] || '');
}

// A row's weekday in the PARISH's own time, which is the only reading that
// makes /wed mean what it says: a 7pm Wednesday service in Perth is Wednesday
// there whatever the clock says where it is being read. Projected instances
// already carry the local wall time; a stored one-off is converted through
// its own zone.
function eventLocalDow(e) {
  if (!e) return null;
  const local = e.start_local
    ? String(e.start_local).slice(0, 10)
    : (e.start_utc
      ? new Intl.DateTimeFormat('en-CA', { timeZone: e.timezone || TZ }).format(new Date(e.start_utc))
      : null);
  if (!local) return null;
  return new Date(local + 'T00:00:00Z').getUTCDay();
}

// Mirror parishFilters state onto the in-card pills. parishFilters is
// the parish-sheet's local scoped filter state (separate from the main
// mode-bar's state.filters). The EN badge text widens to "EN+BILINGUAL"
// or "EN-ONLY" to match the main button's badge vocabulary.
function syncParishFilterPills() {
  const row = document.getElementById('ps-filter-row');
  if (!row) return;
  const f = state.parishFilters || {};
  const social = !!f.socialOnly;
  const english = !!f.englishOnly;
  const strict = !!f.englishStrict;
  row.querySelectorAll('.ps-filter-pill').forEach(btn => {
    const kind = btn.dataset.psFilter;
    if (kind === 'social') btn.classList.toggle('active', social);
    else if (kind === 'english') {
      btn.classList.toggle('active', english);
      btn.classList.toggle('strict', strict);
      const badge = btn.querySelector('.fm-en-badge');
      if (badge) {
        if (strict) badge.textContent = 'EN-ONLY';
        else if (english) badge.textContent = 'EN+BILINGUAL';
        else badge.textContent = 'EN';
      }
    }
  });
}
window.agoraSyncParishFilterPills = syncParishFilterPills;

function openParishSheet(parishId, opts = {}) {
  if (_parishSheetAPI) _parishSheetAPI.open(parishId, opts);
  // Opening a parish while a service filter is on narrows to that parish's
  // own rule of that kind. Otherwise the URL and the view disagree: the path
  // reads /sgr/liturgy either way, and re-opening it would give the rule
  // focus while the live view still showed every liturgy at the parish.
  // filters.service survives, so closing the sheet returns to /liturgy.
  if ((state.filters.service || state.filters.day != null) && !state.parishScheduleFocus
      && !opts.noServiceFocus && state.parishSheetFocus === parishId) {
    // Schedules are only loaded by the services view and (lazily) by the
    // sheet itself, so the events view reaches here with none — hence the
    // wait, and the re-check afterwards in case the user moved on meanwhile.
    ensureSchedulesLoaded().then(() => {
      if (state.parishSheetFocus !== parishId || state.parishScheduleFocus) return;
      const rules = matchingRules(parishId, state.filters.service, state.filters.day);
      if (!rules.length) return;
      setParishScheduleFocus(parishId, {
        ruleIds: rules.map(r => r.id),
        slug: state.filters.service,
        dow: state.filters.day,
        scope: 'kind',
      });
    });
  }
  // Activate the matching parish pill (single-select) so the user gets a
  // consistent visual state regardless of how the card was opened (marker
  // tap, pill tap, deep link). Skip when in multi-parish picker mode —
  // there the user is curating a set, opening a card shouldn't reshape it.
  if (!state.filters.multiParish) {
    state.filters.parishIds = new Set([parishId]);
    state.parishFocus = parishId;
    if (typeof renderParishPills === 'function') renderParishPills();
    if (typeof syncResetFab === 'function') syncResetFab();
  }
}
function closeParishSheet() {
  // The schedule focus belongs to the sheet — it is "this rule at this
  // parish", and there is nowhere to show it once the parish is gone. The
  // pinned occurrence goes with it: it was the focus's, not the user's, and
  // leaving it behind writes an event id into a URL nobody asked for.
  if (state.parishScheduleFocus) {
    state.parishScheduleFocus = null;
    state._openEventId = null;
  }
  if (_parishSheetAPI) _parishSheetAPI.close();
  // Closing the parish card also clears the implicit single-parish pill
  // selection that opening it set. Multi-parish picker mode keeps its
  // set intact (user is curating, not browsing one parish).
  if (!state.filters.multiParish) {
    if (state.filters.parishIds && state.filters.parishIds.size === 1) {
      state.filters.parishIds = null;
    }
    state.parishFocus = null;
    if (typeof renderParishPills === 'function') renderParishPills();
    if (typeof syncFilterActiveStack === 'function') syncFilterActiveStack();
    if (typeof syncResetFab === 'function') syncResetFab();
    if (typeof syncURL === 'function') syncURL();
  }
}
window.openParishSheet = openParishSheet;
window.closeParishSheet = closeParishSheet;

// Partial refresh for parish-sheet content: re-renders only the events
// list and the schedule card (the bits that filter changes / async
// fetches actually affect). Keeps the parish header, actions row,
// pinned focused event, and ps-filter-row intact — so toggling a pill
// doesn't blow away the user's expanded card or scroll position, and
// async events/schedules fetch completions don't flash.
function refreshParishContentPortion(parishId, opts = {}) {
  const contentEl = document.getElementById('parish-sheet-content');
  if (!contentEl) return;
  const parish = state.parishes.find(p => p.id === parishId);
  if (!parish) return;

  // Mark pending → render → applied so parish-sheet filter toggles get
  // the same fade/glimmer flow as the main events list.
  if (typeof markEventsPending === 'function') markEventsPending();

  // FLIP snapshot — capture per-card positions BEFORE the renderStream
  // mutation. After the mutation we measure new positions, apply
  // inverse transforms, and animate them out so cards that are still
  // present glide to their new spot instead of popping in/out.
  const flipBefore = new Map();
  contentEl.querySelectorAll('.ps-events-list .event-card[data-id]').forEach(c => {
    flipBefore.set(c.dataset.id, c.getBoundingClientRect().top);
  });

  // Snapshot scroll position so renderStream's innerHTML write doesn't
  // jump the user's view.
  const scrollEl = document.getElementById('parish-sheet-scroll');
  const savedScroll = scrollEl ? scrollEl.scrollTop : 0;

  // Events list refresh
  let parishEvents;
  if (opts.parishEvents) {
    parishEvents = opts.parishEvents;
  } else {
    parishEvents = (state.events || [])
      .filter(e => e.parish_id === parishId || (e.extra_parishes && e.extra_parishes.includes(parishId)))
      .sort((a, b) => new Date(a.start_utc) - new Date(b.start_utc));
  }
  parishEvents = filterParishEventsBySession(parishEvents);
  const streamEl = contentEl.querySelector('.ps-events-list');
  if (streamEl) {
    if (parishEvents.length) {
      renderStream(streamEl, parishEvents, { parishMode: true, groupByParish: true, showCount: state._parishEventsShowCount || 30 });
    } else {
      streamEl.replaceChildren();
    }
  }

  // Schedule card refresh — recompute scheds + EN filter, replace inner.
  // Mount the section if it didn't exist; remove if no scheds left.
  const scheds = filterParishSchedulesBySession(
    (state.schedules || [])
      .filter(s => s.parish_id === parishId)
      .sort((a, b) => a.day_of_week - b.day_of_week)
  );
  const psJurisColor = getJurisdictionColor(parish.jurisdiction);
  const psJurisLabel = capitalize(parish.jurisdiction || '') + ' Orthodox';
  const existingSection = contentEl.querySelector('.ps-sched-section');
  if (scheds.length) {
    const innerHTML = `<div class="jurisdiction-box" style="--juris-color:${esc(psJurisColor)}">
      <div class="section-header jurisdiction-header">${esc(psJurisLabel)}</div>
      <div class="parish-schedule head-suppressed" data-parish-id="${esc(parishId)}">
        ${renderScheduleDaysHTML(scheds, { isAdmin: state.isAdmin })}
      </div>
    </div>`;
    if (existingSection) {
      existingSection.innerHTML = innerHTML;
    } else if (streamEl) {
      const sec = document.createElement('div');
      sec.className = 'ps-section ps-sched-section';
      sec.innerHTML = innerHTML;
      // Above the filter row, which sits between the service times and the
      // events list — mounting before the stream instead would drop it on the
      // wrong side of the pills.
      const anchor = contentEl.querySelector('.ps-filter-row') || streamEl;
      anchor.parentNode.insertBefore(sec, anchor);
    }
  } else if (existingSection) {
    existingSection.remove();
  }

  if (state.isAdmin) wireScheduleAdminHandlers(contentEl);

  if (scrollEl) {
    requestAnimationFrame(() => { scrollEl.scrollTop = savedScroll; });
  }

  // FLIP play — for every card that survived the diff, compute the
  // delta between old and new top, set an inverse transform, then
  // animate to identity. Cards new to the list don't have a "before"
  // position and skip — they'll fade in via the unfade stagger instead.
  const survivors = contentEl.querySelectorAll('.ps-events-list .event-card[data-id]');
  let flipped = 0;
  survivors.forEach(c => {
    const oldTop = flipBefore.get(c.dataset.id);
    if (oldTop == null) return;
    const newTop = c.getBoundingClientRect().top;
    const dy = oldTop - newTop;
    if (Math.abs(dy) < 2) return;
    flipped++;
    c.style.transform = `translateY(${dy}px)`;
    c.style.transition = 'none';
    requestAnimationFrame(() => {
      c.style.transition = 'transform 0.36s cubic-bezier(0.34, 1.15, 0.64, 1)';
      c.style.transform = '';
    });
    setTimeout(() => {
      c.style.transition = '';
    }, 420);
  });

  if (typeof markEventsApplied === 'function') {
    // Defer applied-mark until FLIP frame completes so the unfade
    // stagger doesn't fight FLIP's transform.
    requestAnimationFrame(() => requestAnimationFrame(() => markEventsApplied()));
  }
}
window.agoraRefreshParishContentPortion = refreshParishContentPortion;

function renderParishSheetContent(parishId, opts = {}) {
  const parish = state.parishes.find(p => p.id === parishId);
  if (!parish) return;

  const contentEl = document.getElementById('parish-sheet-content');
  // Fast-path: same parish, no full-rebuild requested. Run partial refresh
  // (events list + schedule card only) so async fetch completions and
  // pill toggles don't blow away the header / pinned event / actions —
  // which causes the focused-event flash and pill-click scroll-jump.
  if (contentEl && contentEl._psParishId === parishId && !opts.fullRender) {
    refreshParishContentPortion(parishId, opts);
    return;
  }
  if (contentEl) contentEl._psParishId = parishId;
  // Prefer full canonical title ("St. Kassiani Antiochian Orthodox Church")
  // over the short nickname used on pills/cards ("St. Kassiani"). Long names
  // are shrunk to fit two lines by fitParishName() after insertion.
  const displayName = parish.full_name || parish.name || '';
  const initial = (displayName || '?')[0].toUpperCase();
  const color = getParishDisplayColor(parish.color || '#666');
  const juris = capitalize(parish.jurisdiction || '');
  let distHtml = '';
  if (state.locationActive && parish.lat && parish.lng) {
    const km = haversineKm(state.userLat, state.userLng, parish.lat, parish.lng);
    distHtml = `<span class="ps-meta-sep">·</span>${km.toFixed(1)} km`;
  }

  // Address + website are presented as info-with-copy chips: tap copies the
  // value to clipboard (a brief 'Copied' confirmation swaps for the label).
  // Directions remains the explicit nav action below; the website is no longer
  // a separate action button since its URL is visible + copyable here.
  const addrHtml = parish.address
    ? `<button class="ps-info-copy" type="button" data-copy="${esc(parish.address)}" aria-label="Copy address">
        <span class="ps-info-copy-text">${esc(parish.address)}</span>
        <img class="ps-info-copy-icon" src="https://api.iconify.design/ph:copy.svg" alt="">
      </button>`
    : '';
  const webCopyHtml = parish.website
    ? `<button class="ps-info-copy" type="button" data-copy="${esc(parish.website)}" aria-label="Copy website URL">
        <span class="ps-info-copy-text">${esc(parish.website.replace(/^https?:\/\//, '').replace(/\/$/, ''))}</span>
        <img class="ps-info-copy-icon" src="https://api.iconify.design/ph:copy.svg" alt="">
      </button>`
    : '';

  // Where these details came from. The name is the readable half and the ref is
  // the checkable half, so the name links to the ref when the ref is a URL —
  // some are not ("seeds/parishes.js", a person's initials), and those render as
  // plain text rather than a dead link.
  //
  // "unverified" is shown rather than implied. A scraped pin and a pin somebody
  // has stood in front of should not look the same, and info_verified_at is the
  // only thing that tells them apart.
  const srcName = parish.info_source_name;
  const srcRef = parish.info_source_ref || '';
  const srcHtml = srcName
    ? `<div class="ps-source">Info from ${/^https?:/.test(srcRef)
      ? `<a href="${esc(srcRef)}" target="_blank" rel="noopener">${esc(srcName)}</a>`
      : esc(srcName)}${parish.info_verified_at
      ? ` · checked ${esc(String(parish.info_verified_at).slice(0, 10))}`
      : ' · unverified'}</div>`
    : '';

  const dirBtn = parish.lat && parish.lng
    ? `<a class="ps-btn ps-btn-primary" href="https://www.google.com/maps/dir/?api=1&destination=${parish.lat},${parish.lng}" target="_blank" rel="noopener">Directions</a>`
    : '';
  const webBtn = parish.website
    ? `<a class="ps-btn" href="${esc(parish.website)}" target="_blank" rel="noopener">Website</a>`
    : '';
  const phoneBtn = parish.phone
    ? `<a class="ps-btn" href="tel:${esc(parish.phone)}">Call</a>`
    : '';
  const watchBtn = parish.live_url
    ? `<a class="ps-btn" href="${esc(parish.live_url)}" target="_blank" rel="noopener">Watch Live</a>`
    : '';
  const donateBtn = parish.donation_url
    ? `<a class="ps-btn ps-donate-btn" href="${esc(parish.donation_url)}" target="_blank" rel="noopener"><img class="ps-btn-icon" src="https://api.iconify.design/ph:hand-heart.svg" alt=""><span>Donate</span></a>`
    : '';
  const shareParishBtn = `<button class="ps-btn ps-share-btn" type="button" data-share-parish="${esc(parishId)}"><img class="ps-btn-icon" src="https://api.iconify.design/ph:paper-plane-tilt.svg" alt=""><span>Share</span></button>`;

  // Admin controls + edit form (gated by state.isAdmin, respects hideAdminControls pref)
  let parishAdminHtml = '';
  let parishEditFormHtml = '';
  if (state.isAdmin) {
    const hiding = localStorage.getItem('hideAdminControls') === 'true';
    const pid = esc(parishId);
    // Admin row is its own .ps-actions so Edit / Delete / the visibility
    // toggle sit in the same pill geometry as Directions / Website / Call
    // directly above them. --parish-color is not set here on purpose: the
    // public actions carry the parish's hue, and the admin ones staying
    // neutral is what keeps the two rows telling apart at a glance.
    parishAdminHtml = `
      <div class="ps-actions ps-admin-actions">
        <div class="admin-actions-group" style="${hiding ? 'display:none' : ''}">
          <button class="ps-btn ps-btn-admin" type="button" onclick="toggleParishEdit('${pid}')">${glyph('ph:pencil-simple')}Edit</button>
          <button class="ps-btn ps-btn-danger" type="button" onclick="deleteParish('${pid}')">${glyph('ph:trash')}Delete</button>
        </div>
        ${adminVisibilityPill(hiding, 'ps-btn ps-btn-ghost')}
      </div>`;
    // Mirrors the jurisdiction CHECK in d1/schema.sql. It listed
    // 'ecumenical', which the constraint rejects, and omitted 'romanian',
    // which it allows — so one option could only ever fail the save and one
    // valid jurisdiction was unreachable from this form.
    const jurisdictionOpts = ['antiochian','greek','macedonian','romanian','russian','serbian','other']
      .map(j => `<option value="${j}"${parish.jurisdiction === j ? ' selected' : ''}>${capitalize(j)}</option>`)
      .join('');
    let langsVal = '';
    try { langsVal = parish.languages ? JSON.parse(parish.languages).join(', ') : ''; } catch { langsVal = parish.languages || ''; }
    parishEditFormHtml = `
      <div class="detail-edit-form" id="ps-edit-form-${pid}" style="display:none;">
        <div class="edit-row">
          <label>Logo</label>
          <button class="ps-btn ps-btn-admin" type="button" onclick="openParishLogoEditor('${pid}')">${glyph('ph:image-square')}${parish.logo_path ? 'Change logo' : 'Add logo'}</button>
          <div class="edit-row-hint">Or tap the pencil on the avatar above.</div>
        </div>
        <div class="edit-row"><label>Short name</label><input id="pse-name-${pid}" value="${esc(parish.name || '')}"></div>
        <div class="edit-row"><label>Full name</label><input id="pse-fullname-${pid}" value="${esc(parish.full_name || '')}"></div>
        <div class="edit-row"><label>Jurisdiction</label><select id="pse-jurisdiction-${pid}">${jurisdictionOpts}</select></div>
        <div class="edit-row"><label>Address</label><input id="pse-address-${pid}" value="${esc(parish.address || '')}"></div>
        <div class="edit-row"><label>Website</label><input type="url" id="pse-website-${pid}" value="${esc(parish.website || '')}"></div>
        <div class="edit-row"><label>Phone</label><input type="tel" id="pse-phone-${pid}" value="${esc(parish.phone || '')}"></div>
        <div class="edit-row"><label>Live URL</label><input type="url" id="pse-live-${pid}" value="${esc(parish.live_url || '')}"></div>
        <div class="edit-row"><label>Donation URL</label><input type="url" id="pse-donation-${pid}" value="${esc(parish.donation_url || '')}"></div>
        <div class="edit-row"><label>Raffle URL</label><input type="url" id="pse-raffle-${pid}" value="${esc(parish.raffle_url || '')}"></div>
        <div class="edit-row"><label>Payment URL</label><input type="url" id="pse-payment-${pid}" value="${esc(parish.payment_url || '')}"></div>
        <div class="edit-row"><label>Gala URL</label><input type="url" id="pse-gala-${pid}" value="${esc(parish.gala_url || '')}"></div>
        <div class="edit-row">
          <label>Color</label>
          <input type="color" id="pse-color-${pid}" value="${esc(parish.color || rawJurisColor(parish.jurisdiction))}">
          <div class="edit-row-hint">Cards, feed lines and event groups only — map dots and labels always draw the jurisdiction's colour.</div>
        </div>
        <div class="edit-row">
          <label>Acronym</label>
          <input id="pse-acro-${pid}" data-acronym-field value="${esc(parish.acronym || '')}">
          <div class="edit-row-hint" data-acronym-hint>The parish's short link: orthodoxy.au/<span data-acronym-preview>${esc((parish.acronym || 'acronym').toLowerCase().replace(/\s+/g, ''))}</span></div>
        </div>
        <div class="edit-row"><label>Languages</label><input id="pse-langs-${pid}" placeholder="English, Arabic" value="${esc(langsVal)}"></div>
        <div class="edit-row"><label>Source name</label><input id="pse-srcname-${pid}" placeholder="Parish website" value="${esc(parish.info_source_name || '')}"></div>
        <div class="edit-row"><label>Source URL</label><input id="pse-srcref-${pid}" value="${esc(parish.info_source_ref || '')}"></div>
        <div class="edit-form-actions">
          <button class="btn-save" type="button" onclick="saveParish('${pid}')">Save</button>
          <button class="ps-btn ps-btn-ghost" type="button" onclick="toggleParishEdit('${pid}')">Cancel</button>
        </div>
      </div>`;
  }

  // Service times — always shown when there are schedules (after the
  // parishFilters EN filter is applied). Wrapped in .jurisdiction-box so
  // it picks up the same outer card styling as the main schedules list.
  // Avatar/name head suppressed via .head-suppressed since the parish
  // identity is already carried by .ps-header above.
  const scheds = filterParishSchedulesBySession(
    (state.schedules || [])
      .filter(s => s.parish_id === parishId)
      .sort((a, b) => a.day_of_week - b.day_of_week)
  );
  const psJurisColor = getJurisdictionColor(parish.jurisdiction);
  const psJurisLabel = capitalize(parish.jurisdiction || '') + ' Orthodox';
  let schedSectionHtml = '';
  if (scheds.length) {
    schedSectionHtml = `
      <div class="ps-section ps-sched-section">
        <div class="jurisdiction-box" style="--juris-color:${esc(psJurisColor)}">
          <div class="section-header jurisdiction-header">${esc(psJurisLabel)}</div>
          <div class="parish-schedule head-suppressed" data-parish-id="${esc(parishId)}">
            ${renderScheduleDaysHTML(scheds, { isAdmin: state.isAdmin })}
          </div>
        </div>
      </div>`;
  }

  // Upcoming events across the main-list 28-day window. Prefer the
  // async-fetched list when available; otherwise fall back to state.events
  // so the sheet paints instantly. No start-after-now filter here — that
  // would drop "happening now" events (start < now, end > now).
  let parishEvents;
  if (opts.parishEvents) {
    parishEvents = opts.parishEvents;
  } else {
    parishEvents = (state.events || [])
      .filter(e => e.parish_id === parishId || (e.extra_parishes && e.extra_parishes.includes(parishId)))
      .sort((a, b) => new Date(a.start_utc) - new Date(b.start_utc));
  }
  parishEvents = filterParishEventsBySession(parishEvents);
  const archUrl = ARCHDIOCESE_EVENTS[parish.jurisdiction];
  const archBtnHtml = archUrl
    ? `<a class="ps-btn ps-arch-btn" href="${esc(archUrl)}" target="_blank" rel="noopener">${esc(capitalize(parish.jurisdiction))} Archdiocese Events</a>`
    : '';

  // Focused event hoist: when deep-linked via URL, pin the target event right
  // under the parish header so it's the first thing the user sees.
  const focusEventId = opts.focusEventId ?? state._openEventId ?? null;
  const focusedEvent = focusEventId
    ? parishEvents.find(e => e.id === focusEventId)
    : null;
  // Stream includes the focused event too so the user sees it in day-context.
  // Pinned copy is the expanded "highlight"; stream copy stays collapsed by
  // default. Tapping either expands that specific card and collapses the
  // other (handled in expandEventCard via opts.card + same-scope collapse).
  const streamEvents = parishEvents;

  contentEl.innerHTML = `
    <div class="ps-header">
      <${state.isAdmin ? 'button type="button" data-logo-edit' : 'div'} class="ps-avatar" style="${parish.logo_path ? '' : `background:${esc(color)};`}--parish-glow:${esc(hexToRgba(color, 0.45))}">${parish.logo_path ? `<img src="${esc(parish.logo_path)}" alt="">` : esc(initial)}${state.isAdmin ? `<span class="ps-avatar-edit">${glyph('ph:pencil-simple-fill')}</span>` : ''}</${state.isAdmin ? 'button' : 'div'}>
      <div class="ps-header-info">
        <div class="ps-name">${esc(displayName)}</div>
        <div class="ps-meta">${esc(juris)} Orthodox${distHtml}</div>
      </div>
      <button class="ps-url" id="ps-url" type="button" aria-label="Copy page URL">
        <span class="ps-url-text" id="ps-url-text"></span>
        <img class="ps-url-copy" src="https://api.iconify.design/ph:copy.svg" alt="">
      </button>
    </div>
    ${focusedEvent ? '<div class="ps-pinned-event" id="ps-pinned-event"></div>' : ''}
    <div class="ps-section">
      ${addrHtml}
      ${webCopyHtml}
      ${srcHtml}
      <div class="ps-actions" style="--parish-color:${esc(getParishDisplayColor(parish.color || '#333'))}">${dirBtn}${webBtn}${phoneBtn}${watchBtn}${donateBtn}${shareParishBtn}</div>
      ${parishAdminHtml}
    </div>
    ${parishEditFormHtml || ''}
    <!-- Sticky filter pill row above the events list. Operates on
         parishFilters (scoped local state, separate from main). It sits
         ABOVE the service times because the English pill prunes rows from
         that panel too — it is not only the events list it acts on.
         Schedules pill removed — service times always render below. -->
    <div class="ps-filter-row" id="ps-filter-row">
      <button class="ps-filter-pill" data-ps-filter="social" type="button">
        <img class="ps-filter-pill-icon" src="https://api.iconify.design/fluent:people-community-16-regular.svg" alt="">
        <span>Socials</span>
      </button>
      <button class="ps-filter-pill ps-filter-en" data-ps-filter="english" type="button">
        <span class="fm-en-badge">EN</span>
      </button>
    </div>
    ${schedSectionHtml}
    ${scheduleFocusBannerHtml(parish)}
    <div class="ps-events-list"></div>
    ${archBtnHtml ? `<div class="ps-arch-row">${archBtnHtml}</div>` : ''}`;

  // Render the pinned focused event (single card; expanded on next frame).
  if (focusedEvent) {
    const pinned = contentEl.querySelector('#ps-pinned-event');
    if (pinned) {
      pinned.innerHTML = renderEventCard(focusedEvent);
      const pinnedCard = pinned.querySelector('.event-card');
      if (pinnedCard) {
        pinnedCard.addEventListener('click', () => {
          const scope = document.getElementById('parish-sheet-scroll');
          const alreadyOpen = pinnedCard.classList.contains('expanded');
          if (alreadyOpen) {
            collapseEventCardDOM({ scope });
            delete state._openEventId;
            syncURL();
          } else {
            expandEventCard(focusedEvent.id, { scope, card: pinnedCard });
          }
        });
      }
      // Unfocus X — stays visible in both collapsed and expanded pinned
      // states. Drops the pinned slot without closing the parish sheet.
      const closeBtn = document.createElement('button');
      closeBtn.type = 'button';
      closeBtn.className = 'ps-pinned-close';
      closeBtn.setAttribute('aria-label', 'Close event');
      closeBtn.innerHTML = '&times;';
      closeBtn.addEventListener('click', e => {
        e.stopPropagation();
        const pid = state.parishSheetFocus;
        // Under a rule focus this X is the exit from the focus, not just from
        // the card: the card IS the focus, and closing it while the feed
        // stayed narrowed to one rule would leave no way back out except the
        // pill. clearParishScheduleFocus re-renders and rewrites the URL.
        if (state.parishScheduleFocus) {
          collapseEventCardDOM();
          clearParishScheduleFocus();
          return;
        }
        delete state._openEventId;
        collapseEventCardDOM();
        syncURL();
        if (pid) renderParishSheetContent(pid, {});
      });
      pinned.appendChild(closeBtn);
    }
  }

  // Spotify-style "physical squish": start at max font, shrink 1px at a time
  // until the title fits within its 2-line clamp (clientHeight). Line-clamp
  // keeps clientHeight fixed; scrollHeight reports true content height.
  const nameEl = contentEl.querySelector('.ps-name');
  if (nameEl) fitParishName(nameEl);

  // Avatar doubles as the logo control while the edit form is open. The
  // .editing class is owned by toggleParishEdit; re-apply it here because a
  // full re-render (a save, a scheme flip) rebuilds the header from HTML and
  // would otherwise drop the pencil while the form is still showing.
  const avatarBtn = contentEl.querySelector('.ps-avatar[data-logo-edit]');
  if (avatarBtn) {
    const form = contentEl.querySelector('.detail-edit-form');
    if (form && form.style.display !== 'none') avatarBtn.classList.add('editing');
    avatarBtn.addEventListener('click', () => {
      if (avatarBtn.classList.contains('editing')) openParishLogoEditor(parishId);
      else toggleParishEdit(parishId);
    });
  }

  // The "Showing …" banner's X drops the schedule focus and widens the feed
  // back to everything at this parish.
  const focusX = contentEl.querySelector('[data-schedule-focus-clear]');
  if (focusX) focusX.addEventListener('click', e => { e.stopPropagation(); clearParishScheduleFocus(); });

  // Acronym field says, as you type, whether the link it would make is
  // available. The Worker refuses a reserved or taken one on save either way
  // — this is so you find out before the round-trip rather than after it.
  wireAcronymHint(contentEl, parishId);

  // Address + website copy chips. Click copies the value to clipboard and
  // flashes a "Copied" label in place of the text for ~1.2s.
  contentEl.querySelectorAll('.ps-info-copy').forEach(chip => {
    chip.addEventListener('click', async () => {
      const value = chip.dataset.copy || '';
      if (!value) return;
      try {
        await navigator.clipboard.writeText(value);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = value;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch {}
        document.body.removeChild(ta);
      }
      const label = chip.querySelector('.ps-info-copy-text');
      if (!label) return;
      if (chip._copyTimer) clearTimeout(chip._copyTimer);
      const saved = label.textContent;
      label.textContent = 'Copied';
      chip.classList.add('copied');
      chip._copyTimer = setTimeout(() => {
        label.textContent = saved;
        chip.classList.remove('copied');
        chip._copyTimer = null;
      }, 1200);
    });
  });

  // Wire URL button (copy) + paint current location.
  const urlBtn = contentEl.querySelector('#ps-url');
  if (urlBtn) {
    urlBtn.addEventListener('click', async () => {
      // Copy the chip's share-form URL (no event-id), not location.href —
      // browser URL may carry /<id> for back-button support that shouldn't
      // leak into shared links.
      const shareUrl = location.origin + '/' + buildPathSegs().join('/');
      try {
        await navigator.clipboard.writeText(shareUrl);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = shareUrl;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch {}
        document.body.removeChild(ta);
      }
      showPsUrlCopied(urlBtn);
    });
    // Sheet header shrinks as content scrolls / device rotates — keep the
    // overflow fade + end-scroll in sync with actual chip width.
    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        const el = urlBtn.querySelector('.ps-url-text');
        if (el) syncUrlChipOverflow(el);
      });
      ro.observe(urlBtn);
    }
  }
  if (typeof updateParishSheetUrl === 'function') updateParishSheetUrl();

  contentEl.querySelectorAll('.ps-share-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const url = location.origin + '/' + (parish.acronym || '').toLowerCase().replace(/\s+/g, '');
      await shareUrl(url, parish.full_name || parish.name || '', btn);
    });
  });

  // Schedule section shares the services-list markup — wire admin edit
  // handlers if the admin is viewing.
  if (state.isAdmin) wireScheduleAdminHandlers(contentEl);

  // Wire the in-card filter pill row. Pills operate on parishFilters
  // (the parish-sheet's own filter state) — separate from the main
  // mode-bar's state.filters. User wants parish-card filters to act
  // like a scoped local copy: toggling Social inside a parish only
  // affects that parish's view, doesn't change the main filter.
  contentEl.querySelectorAll('.ps-filter-pill').forEach(btn => {
    const kind = btn.dataset.psFilter;
    btn.addEventListener('click', () => {
      const f = state.parishFilters;
      if (kind === 'social') {
        f.socialOnly = !f.socialOnly;
      } else if (kind === 'english') {
        // Tri-state: off → bilingual → strict → off
        if (!f.englishOnly) { f.englishOnly = true; f.englishStrict = false; }
        else if (!f.englishStrict) { f.englishStrict = true; }
        else { f.englishOnly = false; f.englishStrict = false; }
      }
      syncParishFilterPills();
      // Partial refresh only — events list + schedule card. Header,
      // pinned event, ps-filter-row stay in place; refresh handles its
      // own scroll preservation.
      if (state.parishSheetFocus) refreshParishContentPortion(state.parishSheetFocus);
    });
  });
  syncParishFilterPills();
  // After the parish-sheet content paints, write the measured heights
  // into CSS vars so sticky descendants land at the right offsets:
  //   --ps-header-h: just below .ps-header (used by .ps-filter-row)
  //   --ps-stack-h:  just below header + filter row (used by .day-hdr)
  // Sticky time-card-head adds 37px to --ps-stack-h.
  requestAnimationFrame(() => {
    const header = contentEl.querySelector('.ps-header');
    const filterRow = contentEl.querySelector('.ps-filter-row');
    const sheet = document.getElementById('parish-sheet');
    if (header && sheet) {
      const headerH = Math.round(header.getBoundingClientRect().height);
      const filterH = filterRow ? Math.round(filterRow.getBoundingClientRect().height) : 0;
      sheet.style.setProperty('--ps-header-h', headerH + 'px');
      sheet.style.setProperty('--ps-stack-h', (headerH + filterH) + 'px');
    }
  });

  // Upcoming events: use the main-sheet stream renderer (day headers, Sunday
  // clusters, month seam) against the parish-filtered slice minus any pinned
  // focused event. Card taps expand inline within the parish sheet —
  // parish "holds" its events.
  const streamEl = contentEl.querySelector('.ps-events-list');
  if (streamEl) {
    if (streamEvents.length) {
      // Use the same day-grouping structure as the main list (day-section/
      // day-hdr) so visuals stay aligned. parishMode kept just for the
      // show-more pagination handler swap.
      renderStream(streamEl, streamEvents, { parishMode: true, groupByParish: true, showCount: state._parishEventsShowCount || 30 });
    } else {
      streamEl.replaceChildren();
    }
    // Parish now "holds" its events — tapping a card expands inline within
    // the parish sheet (toggle if tapping the already-open card).
    // Delegated so pooled card reuse across renders doesn't double-bind.
    if (!streamEl._cardsBound) {
      streamEl._cardsBound = true;
      streamEl.addEventListener('click', (e) => {
        if (e.target.closest('.event-card-drawer')) return;
        if (e.target.closest('.event-card-close')) return;
        const card = e.target.closest('.event-card');
        if (!card || !streamEl.contains(card)) return;
        const id = card.dataset.id;
        const scope = document.getElementById('parish-sheet-scroll');
        const alreadyOpen = card.classList.contains('expanded');
        if (alreadyOpen) {
          collapseEventCardDOM({ scope });
          delete state._openEventId;
          syncURL();
        } else {
          expandEventCard(id, { scope, card });
        }
      });
    }

    // Re-expand the open event when parish sheet re-renders (async schedule /
    // events fetches trigger a full rebuild). Cover both the pinned hoist
    // slot and the unpinned stream. A fresh deep-link via opts.focusEventId
    // also seeds _openEventId so the initial render expands the pinned card.
    // Only re-expand if _openEventId matches — respects user collapse between
    // renders (don't re-open what they just closed).
    const scopeEl = document.getElementById('parish-sheet-scroll');
    if (opts.focusEventId && !state._openEventId) {
      state._openEventId = opts.focusEventId;
    }
    if (state._openEventId && scopeEl) {
      const inPinned = focusedEvent && focusedEvent.id === state._openEventId;
      const inStream = (streamEvents || []).some(e => e.id === state._openEventId);
      if (inPinned || inStream) {
        // Prefer the pinned copy when re-expanding; the stream copy (same id)
        // stays collapsed in day-context, matching the deep-link render.
        const preferred = scopeEl.querySelector(
          '.ps-pinned-event .event-card[data-id="' + state._openEventId + '"]'
        );
        // Synchronous expand on first render — no rAF — so the user
        // doesn't see the collapsed-card frame before the expand.
        // Subsequent re-renders are routed through refreshParishContentPortion
        // which keeps the pinned event intact (no destroy → re-expand cycle).
        expandEventCard(state._openEventId, { scope: scopeEl, card: preferred || undefined });
      }
    }
  }

  // Lazy-fetch schedules when they haven't been loaded yet
  if (!state.schedules || !state.schedules.length) {
    ensureSchedulesLoaded().then(() => {
      const sheetEl = document.getElementById('parish-sheet');
      if (sheetEl && !sheetEl.classList.contains('hidden')) {
        renderParishSheetContent(parishId, opts);
      }
    });
  }

  // Async: fetch the same 28-day window as the main list so the parish
  // sheet doesn't fall short of future events mid-week. Lower bound is
  // start-of-today-Sydney (matches fetchEvents) so currently-underway
  // events still come back. Skip if caller already provided parishEvents.
  if (!opts.parishEvents) {
    const now = new Date();
    const sydneyDate = new Intl.DateTimeFormat('en-AU', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(now);
    const [d, m, y] = sydneyDate.split('/');
    const startLocal = new Date(`${y}-${m}-${d}T00:00:00`);
    const testDate = new Date(`${y}-${m}-${d}T12:00:00Z`);
    const sydneyStr = testDate.toLocaleString('en-US', { timeZone: TZ });
    const offsetMs = new Date(sydneyStr).getTime() - testDate.getTime();
    const from = new Date(startLocal.getTime() - offsetMs).toISOString();
    const to = new Date(now.getTime() + 28 * 86400000).toISOString();
    window.agoraBundle.load()
      .then(() => window.agoraBundle.feed(from, to))
      .then(events => {
        const data = events || [];
        // Merge into state.events so expandEventCard (which looks up events
        // by id in state.events) can find the card when the user tapped
        // straight from the services list into the parish card — otherwise
        // state.events is empty and taps fall through silently.
        if (data.length) {
          const existingIds = new Set(state.events.map(e => e.id));
          const additions = data.filter(e => !existingIds.has(e.id));
          if (additions.length) state.events = [...state.events, ...additions];
        }
        const filtered = data
          // Include cross-parish (Combined) events — events authored at
          // another parish but absorbed here via event_parishes. Without
          // this, the second render (with parishEvents: filtered) would
          // override the initial render's correct filter and silently
          // drop the combined event.
          .filter(e => e.parish_id === parishId || (e.extra_parishes && e.extra_parishes.includes(parishId)))
          .sort((a, b) => new Date(a.start_utc) - new Date(b.start_utc));
        const sheetEl = document.getElementById('parish-sheet');
        if (sheetEl && !sheetEl.classList.contains('hidden')) {
          renderParishSheetContent(parishId, { ...opts, parishEvents: filtered });
        }
      })
      .catch(() => {});
  }
}

// ── Event card pool ──
// Card DOM nodes are reused across re-renders. Full-list innerHTML on a
// 60+ card list reflows the whole subtree on the gesture-end frame;
// pooling lets renderStream rebuild only the section structure (cheap,
// ~10 nodes) and reuse card nodes via insertBefore — most cards don't
// move on a viewport pan, so reflow cost drops to the few that did.
//
// Pool keyed by event.id. Entry holds node + source event ref. Same
// reference (within a fetch cycle) → reuse; different reference (after
// refetch) → rebuild but migrate expanded drawer state so the open
// card doesn't blink.
const cardPool = new Map();
const _cardRange = document.createRange();

function buildCardNode(evt) {
  return _cardRange.createContextualFragment(renderEventCard(evt)).firstElementChild;
}

function getPooledCardNode(evt) {
  const cached = cardPool.get(evt.id);
  if (cached && cached.evt === evt) return cached.node;
  const node = buildCardNode(evt);
  if (cached && cached.node.classList.contains('expanded')) {
    node.classList.add('expanded');
    const drawer = cached.node.querySelector('.event-card-drawer');
    const closeBtn = cached.node.querySelector('.event-card-close');
    if (drawer) node.appendChild(drawer);
    if (closeBtn) node.appendChild(closeBtn);
    const glow = cached.node.style.getPropertyValue('--accent-glow');
    if (glow) node.style.setProperty('--accent-glow', glow);
  }
  cardPool.set(evt.id, { node, evt });
  return node;
}

function diffCardsInto(host, events) {
  const desired = events.map(getPooledCardNode);
  let prev = null;
  for (const node of desired) {
    const expected = prev ? prev.nextElementSibling : host.firstElementChild;
    if (node !== expected) host.insertBefore(node, expected);
    prev = node;
  }
  let n = prev ? prev.nextElementSibling : host.firstElementChild;
  while (n) {
    const next = n.nextElementSibling;
    host.removeChild(n);
    n = next;
  }
}

function pruneCardPool() {
  const live = new Set(state.events.map(e => e.id));
  for (const id of cardPool.keys()) {
    if (!live.has(id)) cardPool.delete(id);
  }
}

// ── Render Events ──
// Animation orchestrator for the events list. Two states stitched together:
//   pending: events list dimmed + saturated-down, in-view chip prominent —
//            "filter is about to commit, list will mutate". Triggered by
//            map movestart, filter button clicks, mode toggles.
//   applied: pending released, glimmer sweep top-to-bottom, chip relaxes.
//            Fires after the renderEvents/renderServices commit.
// Same animation applies to .ps-events-list inside the parish-sheet so
// filter changes there feel connected to the same flow.
let _glimmerTimer = null;
let _eventsPendingActive = false;
function markEventsPending() {
  _eventsPendingActive = true;
  document.querySelectorAll('.events-list, .services-list, .ps-events-list').forEach(l => {
    l.classList.add('pending');
    l.classList.remove('glimmer');
  });
  const chip = document.getElementById('in-view-chip');
  if (chip) chip.classList.add('prominent');
}
// Iterate every rendered .event-card and refresh just its LIVE badge
// (class + label text) to match the current time. Replaces the old
// minute-tick full re-render — same accuracy, no animation cost.
function updateLiveBadgesInPlace() {
  if (!state.events) return;
  if (state.mode === 'services') return;
  const now = Date.now();
  const TODAY = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  document.querySelectorAll('.event-card[data-id]').forEach(cardEl => {
    const id = cardEl.dataset.id;
    const evt = state.events.find(e => e.id === id);
    if (!evt || !evt.parish_live_url || evt.hide_live) return;
    const evtStart = new Date(evt.start_utc).getTime();
    const evtEnd = evt.end_utc ? new Date(evt.end_utc).getTime() : evtStart + 3600000;
    const sameDay = TODAY === new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(evt.start_utc));
    let cls, label, hasDot;
    if (sameDay && now >= evtStart - 900000 && now <= evtEnd + 3600000) {
      cls = 'badge-live'; label = 'LIVE'; hasDot = true;
    } else if (sameDay && now < evtStart - 900000) {
      cls = 'badge-live-soon';
      const mins = Math.round((evtStart - now) / 60000);
      label = mins >= 60 ? `LIVE IN ${Math.round(mins / 60)}H` : `LIVE IN ${mins}M`;
      hasDot = false;
    } else {
      cls = 'badge-live-soon'; label = 'LIVE AVAIL'; hasDot = false;
    }
    const badgeEl = cardEl.querySelector('.badge-live, .badge-live-soon');
    if (!badgeEl) return;
    if (!badgeEl.classList.contains(cls)) {
      badgeEl.classList.remove('badge-live', 'badge-live-soon');
      badgeEl.classList.add(cls);
    }
    // Reconcile contents: badge-live has a leading .live-dot + label;
    // badge-live-soon is plain text.
    const dotEl = badgeEl.querySelector('.live-dot');
    if (hasDot) {
      if (!dotEl) {
        const dot = document.createElement('span');
        dot.className = 'live-dot';
        badgeEl.textContent = '';
        badgeEl.appendChild(dot);
        badgeEl.appendChild(document.createTextNode(label));
      } else if (badgeEl.lastChild && badgeEl.lastChild.nodeType === 3 && badgeEl.lastChild.textContent !== label) {
        badgeEl.lastChild.textContent = label;
      }
    } else {
      if (dotEl) dotEl.remove();
      if (badgeEl.textContent !== label) badgeEl.textContent = label;
    }
  });
}

function markEventsApplied() {
  // No-op when pending was never set. Sheet snaps and drawer expands
  // shouldn't trigger a glimmer animation just because the listPhase
  // happens to fire afterwards — without this guard we were repainting
  // the .glimmer/.unfading sweep every time onViewportListPhase ran,
  // even though the parish set hadn't changed.
  if (!_eventsPendingActive) return;
  _eventsPendingActive = false;
  const lists = document.querySelectorAll('.events-list, .services-list, .ps-events-list');
  lists.forEach(l => {
    // Stagger the per-card unfade — each card animates from the pending
    // dim back to full with a small delay derived from index. Top-to-
    // bottom flow.
    l.querySelectorAll('.event-card, .parish-schedule').forEach((c, i) => {
      c.style.setProperty('--card-i', i);
    });
    l.classList.remove('pending');
    // Restart the glimmer + unfading animations by removing → reflow → re-adding.
    l.classList.remove('glimmer', 'unfading');
    void l.offsetWidth;
    l.classList.add('glimmer', 'unfading');
  });
  if (_glimmerTimer) clearTimeout(_glimmerTimer);
  _glimmerTimer = setTimeout(() => {
    lists.forEach(l => l.classList.remove('glimmer', 'unfading'));
    _glimmerTimer = null;
  }, 1200);
  const chip = document.getElementById('in-view-chip');
  if (chip) chip.classList.remove('prominent');
}
window.agoraMarkEventsPending = markEventsPending;
window.agoraMarkEventsApplied = markEventsApplied;

let _renderEventsIdleCancel = null;
function scheduleRenderEvents(timeout = 500) {
  if (_renderEventsIdleCancel) { _renderEventsIdleCancel(); _renderEventsIdleCancel = null; }
  markEventsPending();
  const commit = () => { _renderEventsIdleCancel = null; renderEvents(); markEventsApplied(); };
  if (window.requestIdleCallback) {
    const id = requestIdleCallback(commit, { timeout });
    _renderEventsIdleCancel = () => cancelIdleCallback(id);
  } else {
    const id = setTimeout(commit, 16);
    _renderEventsIdleCancel = () => clearTimeout(id);
  }
}

function renderEvents() {
  // Skip the main events render entirely while the parish-sheet is
  // visible. The card pool is shared — running renderEvents would
  // diff-move the parish-sheet's currently-mounted cards into the
  // main list's hosts (which is hidden behind the parish sheet anyway),
  // emptying the parish-sheet's day-section frames. User sees event
  // groups + headers with no cards inside.
  if (window.agoraParishSheetVisible) return;
  const container = document.getElementById('events-list');
  pruneCardPool();
  const filtered = applyFilters(state.events);
  renderStream(container, filtered, { groupByParish: true, showCount: state._eventsShowCount || 30 });
  bindEventCards(container);

  // Only re-expand in the main list when the parish sheet isn't showing the
  // event. Without the guard, expandEventCard's document-scoped "collapse all
  // other expanded cards" pass tramples the pinned card in the parish sheet.
  if (state._openEventId && !state.parishSheetFocus) {
    expandEventCard(state._openEventId);
  }
}

// Split events into Morning (<14:00 local) and Evening (>=14:00 local) sub-groups
function splitMorningEvening(events) {
  const morning = [], evening = [];
  for (const e of events) {
    const h = parseInt(new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', hour12: false }).format(new Date(e.start_utc)));
    (h < 14 ? morning : evening).push(e);
  }
  return { morning, evening };
}

function sortEvents(arr) {
  if (state.eventsSort === 'nearby' && state.locationActive) {
    return [...arr].sort((a, b) => (a.distance_km || 999) - (b.distance_km || 999));
  }
  return [...arr].sort((a, b) => new Date(a.start_utc) - new Date(b.start_utc));
}

// ── Mode-bar URL display + copy ──
// Share a URL via native share sheet, falling back to clipboard copy.
// feedbackEl: optional button/element whose text is briefly replaced with 'Copied!'
async function shareUrl(url, title = '', feedbackEl = null) {
  if (navigator.share) {
    try { await navigator.share({ title, text: '', url }); return; } catch (e) {
      if (e.name === 'AbortError') return;
      console.warn('[share] navigator.share failed:', e);
    }
  }
  let copied = false;
  try {
    await navigator.clipboard.writeText(url);
    copied = true;
  } catch(e) {
    console.warn('[share] clipboard.writeText failed:', e);
    const ta = document.createElement('textarea');
    ta.value = url; document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); copied = true; } catch(e2) { console.warn('[share] execCommand copy failed:', e2); }
    document.body.removeChild(ta);
  }
  if (copied && feedbackEl) {
    const saved = feedbackEl.textContent;
    feedbackEl.textContent = 'Copied!';
    setTimeout(() => { feedbackEl.textContent = saved; }, 1500);
  }
}

function initModeUrl() {
  const btn = document.getElementById('mode-url');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    const url = location.origin + '/' + buildPathSegs().join('/');
    await shareUrl(url, document.title);
  });
  updateModeUrl();
}

// Briefly swaps the URL text with a glowing 'COPIED' message, then restores.
function showCopiedFeedback(btn) {
  const el = btn.querySelector('.mode-url-text');
  if (!el) return;
  if (el._copiedTimer) { clearTimeout(el._copiedTimer); }
  const saved = el.innerHTML;
  el.innerHTML = `<span class="mode-url-copied-msg">COPIED</span>`;
  el._copiedTimer = setTimeout(() => {
    el.innerHTML = saved;
    el._copiedTimer = null;
    updateModeUrl();
  }, 900);
}

function updateModeUrl() {
  const el = document.getElementById('mode-url-text');
  if (!el) return;
  // Skip while COPIED feedback is on screen — it'll re-render when timer fires.
  if (el._copiedTimer) return;
  const host = location.host.replace(/^www\./, '');
  // Chip shows the shareable form (no event-id), even though the browser URL
  // may carry one for back-button navigation.
  const segs = buildPathSegs();
  const hasPrev = !!el.dataset.prevSegs;
  const prevKey = hasPrev ? el.dataset.prevSegs : '';
  const nextKey = JSON.stringify(segs);
  const urlChanged = hasPrev && prevKey !== nextKey;
  el.dataset.prevSegs = nextKey;

  // Pick the glow tint from the rightmost parish segment if any, else a
  // neutral accent. The whole URL hot-glows in this color on change.
  let tint = '#1565c0';
  for (let i = segs.length - 1; i >= 0; i--) {
    const p = findParishByAcronym(decodeURIComponent(segs[i]));
    if (p && p.color) { tint = getParishDisplayColor(p.color); break; }
  }

  let html = `<span class="mode-url-host">${esc(host)}</span>`;
  for (const seg of segs) {
    const decoded = decodeURIComponent(seg);
    const parish = findParishByAcronym(decoded);
    if (parish) {
      const color = getParishDisplayColor(parish.color || '#888');
      html += `<span class="mode-url-sep">/</span><span class="mode-url-seg mode-url-parish" style="color:${esc(color)}">${esc(decoded.toLowerCase())}</span>`;
    } else {
      html += `<span class="mode-url-sep">/</span><span class="mode-url-seg">${esc(decoded)}</span>`;
    }
  }
  el.innerHTML = html;

  // Hot-glow the whole URL (not just a single segment) whenever the URL
  // changes. Restarts the CSS animation by yanking and re-adding the class.
  if (urlChanged) {
    el.style.setProperty('--url-glow', hexToRgba(tint, 0.55));
    el.classList.remove('mode-url-flash');
    // Force reflow so the animation restarts even on rapid updates.
    void el.offsetWidth;
    el.classList.add('mode-url-flash');
  }

  syncUrlChipOverflow(el);
}

// Long URLs extend to the left under a fade; end stays visible by default.
// Call after innerHTML changes and on resize so the directional fade + scroll
// position stay in sync with the available chip width. Fade sides are live
// — the scroll handler (wired once per element) repaints them on drag.
function syncUrlChipOverflow(el) {
  if (!el) return;
  requestAnimationFrame(() => {
    const overflows = el.scrollWidth > el.clientWidth + 1;
    if (overflows) el.scrollLeft = el.scrollWidth;
    updateUrlChipFade(el);
    if (!el._fadeWired) {
      el._fadeWired = true;
      el.addEventListener('scroll', () => updateUrlChipFade(el), { passive: true });
    }
  });
}

function updateUrlChipFade(el) {
  const max = el.scrollWidth - el.clientWidth;
  const sl = el.scrollLeft;
  el.classList.toggle('fade-left', sl > 1);
  el.classList.toggle('fade-right', sl < max - 1);
}

function findParishByAcronym(seg) {
  if (!seg || !state || !state.parishes) return null;
  const key = seg.toLowerCase().replace(/\s+/g, '');
  return state.parishes.find(p => p.acronym && p.acronym.toLowerCase().replace(/\s+/g, '') === key) || null;
}
window.agoraUpdateModeUrl = updateModeUrl;

// Mirror of updateModeUrl for the parish-sheet header URL chip. Same
// vocabulary: per-segment render, parish-colored bold acronym, whole-URL
// hot-glow on change. Kept as a separate function so the sheet can repaint
// without the mode-bar in scope.
function updateParishSheetUrl() {
  const el = document.getElementById('ps-url-text');
  if (!el) return;
  if (el._copiedTimer) return;
  const host = location.host.replace(/^www\./, '');
  const segs = buildPathSegs();
  const hasPrev = !!el.dataset.prevSegs;
  const prevKey = hasPrev ? el.dataset.prevSegs : '';
  const nextKey = JSON.stringify(segs);
  const urlChanged = hasPrev && prevKey !== nextKey;
  el.dataset.prevSegs = nextKey;

  let tint = '#1565c0';
  for (let i = segs.length - 1; i >= 0; i--) {
    const p = findParishByAcronym(decodeURIComponent(segs[i]));
    if (p && p.color) { tint = getParishDisplayColor(p.color); break; }
  }

  let html = `<span class="ps-url-host">${esc(host)}</span>`;
  for (const seg of segs) {
    const decoded = decodeURIComponent(seg);
    const parish = findParishByAcronym(decoded);
    if (parish) {
      const color = getParishDisplayColor(parish.color || '#888');
      html += `<span class="ps-url-sep">/</span><span class="ps-url-seg ps-url-parish" style="color:${esc(color)}">${esc(decoded.toLowerCase())}</span>`;
    } else {
      html += `<span class="ps-url-sep">/</span><span class="ps-url-seg">${esc(decoded)}</span>`;
    }
  }
  el.innerHTML = html;

  if (urlChanged) {
    el.style.setProperty('--url-glow', hexToRgba(tint, 0.55));
    el.classList.remove('ps-url-flash');
    void el.offsetWidth;
    el.classList.add('ps-url-flash');
  }

  syncUrlChipOverflow(el);
}

function showPsUrlCopied(btn) {
  const el = btn.querySelector('.ps-url-text');
  if (!el) return;
  if (el._copiedTimer) clearTimeout(el._copiedTimer);
  const saved = el.innerHTML;
  el.innerHTML = `<span class="ps-url-copied-msg">COPIED</span>`;
  el._copiedTimer = setTimeout(() => {
    el.innerHTML = saved;
    el._copiedTimer = null;
    updateParishSheetUrl();
  }, 900);
}

// Banded liturgy tint: Sun filled, Mon/Wed/Fri (fasting days) tinted, Tue/Thu/Sat plain.
function liturgyDepth(dow) {
  return [0.12, 0.05, 0, 0.05, 0, 0.05, 0][dow] || 0;
}

// Group sorted events by parish; each parish gets a bordered group box with
// a footer showing acronym + name. Used only in the main (grouped) events list.
function renderParishGroupsHTML(events, reserveHost) {
  const byParish = new Map();
  const order = [];
  for (const e of events) {
    if (!byParish.has(e.parish_id)) { byParish.set(e.parish_id, []); order.push(e.parish_id); }
    byParish.get(e.parish_id).push(e);
  }
  let html = '';
  for (let i = 0; i < order.length; i++) {
    if (i > 0) html += `<div class="parish-group-sep" aria-hidden="true"></div>`;
    const pid = order[i];
    const evts = byParish.get(pid);
    const first = evts[0];
    const color = getParishDisplayColor(first.parish_color || '#888888');
    html += `<div class="parish-group" style="--parish-color:${esc(color)}">`;
    html += reserveHost(evts);
    html += `<div class="parish-group-footer">`;
    if (first.parish_acronym) html += `<span class="parish-group-acro" style="color:${esc(color)}">${esc(first.parish_acronym)}</span>`;
    html += `<span class="parish-group-name">${esc(first.parish_name || '')}</span>`;
    html += `</div></div>`;
  }
  return html;
}

function renderSubDaySections(events, html, reserveHost, opts = {}) {
  const { groupByParish = false } = opts;
  const { morning, evening } = splitMorningEvening(events);
  if (morning.length) {
    if (groupByParish) {
      html += `<div class="time-card time-card-morning">`;
      html += `<div class="time-card-head"><svg class="tc-icon" width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="1.8" fill="currentColor" stroke="none"/><line x1="5" y1="0.5" x2="5" y2="1.9"/><line x1="5" y1="8.1" x2="5" y2="9.5"/><line x1="0.5" y1="5" x2="1.9" y2="5"/><line x1="8.1" y1="5" x2="9.5" y2="5"/><line x1="1.5" y1="1.5" x2="2.4" y2="2.4"/><line x1="7.6" y1="7.6" x2="8.5" y2="8.5"/><line x1="8.5" y1="1.5" x2="7.6" y2="2.4"/><line x1="2.4" y1="7.6" x2="1.5" y2="8.5"/></svg><span class="tc-label">Morning</span></div>`;
      html += renderParishGroupsHTML(sortEvents(morning), reserveHost);
      html += `</div>`;
    } else {
      html += `<div class="sub-day-header">Morning</div>`;
      html += reserveHost(sortEvents(morning));
    }
  }
  if (evening.length) {
    if (groupByParish) {
      html += `<div class="time-card time-card-evening">`;
      html += `<div class="time-card-head"><svg class="tc-icon" width="10" height="10" viewBox="0 0 10 10" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="M8.5,5 A3.5,3.5 0 1,0 1.5,5 A3.5,3.5 0 1,0 8.5,5Z M9.1,4.5 A2.9,2.9 0 1,0 3.3,4.5 A2.9,2.9 0 1,0 9.1,4.5Z"/></svg><span class="tc-label">Evening</span></div>`;
      html += renderParishGroupsHTML(sortEvents(evening), reserveHost);
      html += `</div>`;
    } else {
      if (morning.length) html += `<hr class="sub-day-divider">`;
      html += `<div class="sub-day-header">Evening</div>`;
      html += reserveHost(sortEvents(evening));
    }
  }
  return html;
}

// Single continuous stream: optional Earlier-today chip, then Today phase
// buckets (Happening now / Later today), then day-grouped events through the
// rest of the 28-day window. Sort toggle reorders within morning/evening
// sub-groups across the whole stream.
function renderStream(container, events, opts = {}) {
  const { parishMode = false, showCount = 30 } = opts;
  const dateFocus = !parishMode ? (state._dateFocus || null) : null;
  const now = new Date();
  const TZ_LOCAL = TZ;
  const todayKey = new Intl.DateTimeFormat('en-AU', { timeZone: TZ_LOCAL, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const dayKey = (iso) => new Intl.DateTimeFormat('en-AU', { timeZone: TZ_LOCAL, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

  const happeningNow = [], laterToday = [], earlierToday = [], future = [];
  for (const e of events) {
    const start = new Date(e.start_utc);
    const end = e.end_utc ? new Date(e.end_utc) : new Date(start.getTime() + 3600000);
    const isToday = dayKey(e.start_utc) === todayKey;
    if (isToday && !dateFocus) {
      if (start <= now && end >= now) happeningNow.push(e);
      else if (start > now) laterToday.push(e);
      else earlierToday.push(e);
    } else {
      future.push(e);
    }
  }

  // When a date is focused, filter to events on or after that date and skip the cap.
  const activeFuture = dateFocus
    ? future.filter(e => isoDateSyd(e.start_utc) >= dateFocus)
    : future;

  // Cap future events at showCount items + complete the day the cap falls on.
  // Today events (happening now, later today) are always shown in full.
  const { visible: visibleFuture, deferredCount } = capFutureAtCount(activeFuture, dateFocus ? Infinity : showCount);
  const hasDeferredFuture = deferredCount > 0;

  const hasToday = happeningNow.length || laterToday.length;
  let html = '';

  // Section structure renders as HTML (cheap, ~10 nodes); cards are
  // populated post-swap from the pool so unchanged cards don't reflow.
  const hosts = [];
  let nextHostId = 0;
  function reserveHost(evts) {
    const id = `h${nextHostId++}`;
    hosts.push({ id, events: evts });
    return `<div data-card-host="${id}"></div>`;
  }

  // Earlier-today chip — collapsed by default; expands inline on tap.
  if (earlierToday.length) {
    html += `<button class="earlier-today-chip" id="earlier-today-chip" type="button" aria-expanded="false">`;
    html += `<span class="earlier-today-chip-label">${earlierToday.length} earlier today</span>`;
    html += `<span class="earlier-today-chip-chevron">▾</span>`;
    html += `</button>`;
    html += `<div class="earlier-today-list" id="earlier-today-list" hidden>`;
    html += reserveHost(sortEvents(earlierToday));
    html += `</div>`;
  }

  if (happeningNow.length) {
    html += `<div class="happening-now-section">`;
    html += `<div class="section-header"><span class="now-dot"></span>Happening now</div>`;
    html += reserveHost(sortEvents(happeningNow));
    html += `</div>`;
  }
  if (laterToday.length) {
    if (opts.groupByParish) {
      html += `<div class="day-section">`;
      html += `<div class="day-hdr">Later today</div>`;
    } else {
      html += `<div class="day-box">`;
      html += `<div class="section-header">Later today</div>`;
    }
    html = renderSubDaySections(laterToday, html, reserveHost, opts);
    html += `</div>`;
  }

  // Month seam + day groups. Always emit the seam when future events exist so
  // later async updates slot into a stable position (no scroll jump).
  if (visibleFuture.length) {
    html += renderFutureDays(visibleFuture, reserveHost, opts);
  } else if (!hasToday) {
    html += renderEmptyStateHTML();
  }

  const lastEvt = events.length ? events[events.length - 1] : null;
  const horizonNote = lastEvt
    ? `<div class="list-footer-note">Events scheduled to ${new Date(lastEvt.start_utc).toLocaleDateString('en-AU', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' })}</div>`
    : '';

  if (parishMode) {
    if (hasDeferredFuture) {
      html += `<div class="list-footer"><button class="list-footer-btn" onclick="showMoreParishEvents()">Show more</button><div class="list-footer-ornament">· · ·</div></div>`;
    } else {
      html += `<div class="list-footer">${horizonNote}<div class="list-footer-ornament">· · ·</div></div>`;
    }
  } else if (dateFocus) {
    html += `<div class="list-footer">${horizonNote}<div class="list-footer-ornament">· · ·</div></div>`;
  } else if (hasDeferredFuture) {
    // Events beyond count cap are already in state.events — reveal with no fetch.
    html += `<div class="list-footer"><button class="list-footer-btn" onclick="showMoreEvents()">Show more</button><div class="list-footer-ornament">· · ·</div></div>`;
  } else {
    html += `<div class="list-footer">${horizonNote}<div class="list-footer-ornament">· · ·</div></div>`;
  }

  container.innerHTML = html;

  // Populate hosts with pooled card nodes. Cards that already lived in
  // a previous host get moved (no reflow of their subtree); cards new
  // to the viewport are constructed once and pooled for next render.
  for (const { id, events: hostEvts } of hosts) {
    const host = container.querySelector(`[data-card-host="${id}"]`);
    if (host) diffCardsInto(host, hostEvts);
  }

  const chip = container.querySelector('#earlier-today-chip');
  if (chip) {
    chip.addEventListener('click', () => {
      const list = container.querySelector('#earlier-today-list');
      const open = chip.getAttribute('aria-expanded') === 'true';
      chip.setAttribute('aria-expanded', open ? 'false' : 'true');
      chip.classList.toggle('expanded', !open);
      list.hidden = open;
    });
  }
}

// Day-grouped render for future events (tomorrow → end of window).
function renderFutureDays(events, reserveHost, opts = {}) {
  const { groupByParish = false, parishMode = false } = opts;
  const showDateNav = !parishMode;
  const groups = groupByDay(events);
  const now = new Date();
  const sevenDaysOut = new Date(now.getTime() + 7 * 86400000);

  let html = '';
  let prevMonthKey = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(now);
  for (const [, evts] of groups) {
    const d = parseLocalDate(evts[0].start_utc);
    const weekdayStyle = d < sevenDaysOut ? 'long' : 'short';
    const dayFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: weekdayStyle, day: 'numeric', month: 'short' }).format(d);
    const dayOfWeek = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'long' }).format(d);
    const isSunday = dayOfWeek === 'Sunday';
    const dateStr = isoDateSyd(evts[0].start_utc);
    const isFocused = showDateNav && state._dateFocus === dateStr;

    const monthKey = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(d);
    if (monthKey !== prevMonthKey) {
      const monthLabel = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, month: 'long', year: 'numeric' }).format(d);
      html += `<div class="month-header">${monthLabel}</div>`;
      prevMonthKey = monthKey;
    }

    const dateNavBtn = showDateNav
      ? (isFocused
          ? `<button class="day-date-clear" type="button" onclick="clearDateFocus()" title="Back to stream">&times;</button>`
          : `<button class="day-date-pick" type="button" onclick="openDatePicker(this)" title="Jump to date"><img src="https://api.iconify.design/ph:calendar.svg" alt=""></button>`)
      : '';

    if (groupByParish) {
      html += `<div class="day-section${isSunday ? ' day-section-sunday' : ''}" data-date="${dateStr}">`;
      html += `<div class="day-hdr">${dayFmt}${dateNavBtn}</div>`;
    } else {
      html += `<div class="day-box${isSunday ? ' day-box-sunday' : ''}" data-date="${dateStr}">`;
      html += `<div class="section-header">${dayFmt}${dateNavBtn}</div>`;
    }
    html = renderSubDaySections(evts, html, reserveHost, opts);
    html += `</div>`;
  }
  return html;
}

function formatEventTime(date) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true
  }).formatToParts(date);
  let hour = '', minute = '', mer = '';
  for (const p of parts) {
    if (p.type === 'hour') hour = p.value;
    else if (p.type === 'minute') minute = p.value;
    else if (p.type === 'dayPeriod') mer = p.value;
  }
  const minHtml = minute === '00' ? '' : `<span class="t-min">:${minute}</span>`;
  const merHtml = mer ? `<span class="t-mer">${mer.replace(/\s/g, '').toLowerCase()}</span>` : '';
  return `${hour}${minHtml}${merHtml}`;
}

// Jurisdiction hex values come from /shared/jurisdiction-colors.js, which
// index.html loads before this file — the table is also read by the seed, and
// the two copies it used to have disagreed about Greek. Used both for direct
// juris rendering (via getJurisdictionColor below, no substitution) and as the
// override target when a juris filter is active (in getParishDisplayColor).
function rawJurisColor(j) { return window.agoraJurisdictionColor(j); }
window.rawJurisColor = rawJurisColor;

function getJurisdictionColor(j) {
  const key = j || state.filters.jurisdiction;
  // Use the no-substitution path so passing a non-active juris (e.g. when
  // colouring a parish-group header for a juris that isn't the filter)
  // still returns that specific juris's colour.
  return _liftIfDark(rawJurisColor(key));
}

// Convert a #RRGGBB / #RGB hex to an rgba() string. Used to build the
// parish-colored glow on an expanded event card (injected as a CSS var so the
// ::after pseudo can pick it up).
// Single funnel for every inline-styled parish-colour site (acronym, pill,
// avatar, glow, --parish-color CSS var, etc). Pass-through in light mode;
// in dark, defers to window.liftParishColor (defined in map.js, so it
// loads first per index.html script order). The matchMedia check means
// inline HTML re-renders pick up scheme changes — see __agoraSchemeRerender
// below.
// Dark-mode perceptual lift only. No juris-filter substitution.
// Used by getJurisdictionColor (drawing a specific juris's tone) and as
// the inner step of getParishDisplayColor (which adds the substitution).
function _liftIfDark(hex) {
  if (!hex) return hex;
  return (matchMedia('(prefers-color-scheme: dark)').matches && window.liftParishColor)
    ? window.liftParishColor(hex)
    : hex;
}

function getParishDisplayColor(hex) {
  if (!hex) return hex;
  // When a jurisdiction filter is active, every parish reads as that one
  // juris's colour — the per-parish hue identity is intentionally hidden
  // under the juris-wide selection. Cascades into dot/label/acronym/pill/
  // avatar/glow because they all flow through this funnel.
  const j = state && state.filters && state.filters.jurisdiction;
  const effective = j ? rawJurisColor(j) : hex;
  return _liftIfDark(effective);
}
// Exposed so filters.js (jurisdiction chips) and any other module can route
// colour through the same dark-mode lift funnel.
window.getParishDisplayColor = getParishDisplayColor;

// On scheme flip, re-render the events list so all the inline `style="..."`
// strings re-stamp through getParishDisplayColor. CSS @media block flips
// vars automatically; inline styles are frozen at render time and need this.
if (!window.__agoraSchemeRerender) {
  window.__agoraSchemeRerender = true;
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (typeof scheduleRenderEvents === 'function') scheduleRenderEvents(0);
    if (typeof renderParishPills === 'function') renderParishPills();
    if (typeof renderServices === 'function' && state && state.mode === 'services') renderServices();
    // Parish-sheet shares the event-card pool with the main list. Main's
    // re-render moves pooled cards into its hosts, leaving the parish-
    // sheet's hosts empty (the day-section frames remain because they're
    // built from HTML, but the cards inside live in the pool). Refresh
    // the parish-sheet's events list to repopulate its hosts.
    if (window.agoraParishSheetVisible && state && state.parishSheetFocus
        && typeof refreshParishContentPortion === 'function') {
      refreshParishContentPortion(state.parishSheetFocus);
    }
    // Re-style jurisdiction chips so the lifted colours stamp into inline
    // styles. applyChipColors lives in filters.js and reads from chip
    // dataset; we wrap the value at read-time below.
    const chips = document.getElementById('jurisdiction-chips');
    if (chips && typeof window.applyChipColors === 'function') window.applyChipColors(chips);
  });
}

function hexToRgba(hex, alpha) {
  if (!hex || typeof hex !== 'string') return `rgba(136, 136, 136, ${alpha})`;
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  if (h.length !== 6) return `rgba(136, 136, 136, ${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// Returns the fill color for the event-type dot (Google Calendar style).
// Light/dark palettes mirror the .badge-* CSS rules so the small circle
// badge in collapsed cards matches the rectangular LITURGY/PRAYER/etc.
// badge in the expanded drawer.
function eventTypeDotColor(type) {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const light = { liturgy: '#e8d5e8', feast: '#f5ecd0', prayer: '#d5e0f0', talk: '#f0e8d5', youth: '#d0e8f5', social: '#d5ead5', other: '#e8e8e8' };
  const dk    = { liturgy: '#3a2840', feast: '#3a3220', prayer: '#1f2a3a', talk: '#3a2f1c', youth: '#1c303d', social: '#1f2e1f', other: '#26272c' };
  return (dark ? dk : light)[type] || (dark ? '#26272c' : '#e8e8e8');
}
function eventTypeDotTextColor(type) {
  const dark = matchMedia('(prefers-color-scheme: dark)').matches;
  const light = { liturgy: '#6b2d6b', feast: '#7a6520', prayer: '#2d4a7a', talk: '#7a5a20', youth: '#2d5a8a', social: '#2d6a2d', other: '#555' };
  const dk    = { liturgy: '#d4a3d4', feast: '#d4c082', prayer: '#9bb8e0', talk: '#d4b682', youth: '#a8c8de', social: '#a3c8a3', other: '#aaaaaa' };
  return (dark ? dk : light)[type] || (dark ? '#aaaaaa' : '#555');
}

function renderEventCard(evt) {
  const start = new Date(evt.start_utc);
  const time = formatEventTime(start);
  const acronymColor = getParishDisplayColor(evt.parish_color || '#000');
  const acronym = evt.parish_acronym ? `<span class="event-parish-acronym" style="color:${esc(acronymColor)}">${esc(evt.parish_acronym)}</span>` : '';

  // Normalise to display type so vespers→prayer, matins→prayer etc. map correctly.
  const displayType = TYPE_DISPLAY[evt.event_type] || evt.event_type || 'other';
  const dotColor = eventTypeDotColor(displayType);
  const dotTextColor = eventTypeDotTextColor(displayType);
  const typeInitial = displayType[0].toUpperCase();
  const typeDot = `<span class="event-type-dot" style="--dot-color:${esc(dotColor)};--dot-text:${esc(dotTextColor)}">${typeInitial}</span>`;

  const langs = evt.languages ? JSON.parse(evt.languages) : [];
  const bilingualBadge = langs.length >= 2 ? `<span class="event-badge badge-bilingual">BILINGUAL</span>` : '';
  const combinedBadge = (evt.extra_parishes && evt.extra_parishes.length) ? `<span class="event-badge badge-combined">COMBINED</span>` : '';

  // LIVE badge — in-progress / imminent today gets live/countdown, future days
  // get the generic LIVE AVAIL tag (no per-minute countdown).
  let liveBadge = '';
  if (evt.parish_live_url && !evt.hide_live) {
    const now = Date.now();
    const evtStart = new Date(evt.start_utc).getTime();
    const evtEnd = evt.end_utc ? new Date(evt.end_utc).getTime() : evtStart + 3600000;
    const sameDay = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()) ===
                    new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(evt.start_utc));
    if (sameDay && now >= evtStart - 900000 && now <= evtEnd + 3600000) {
      liveBadge = `<span class="event-badge badge-live"><span class="live-dot"></span>LIVE</span>`;
    } else if (sameDay && now < evtStart - 900000) {
      const mins = Math.round((evtStart - now) / 60000);
      const label = mins >= 60 ? `LIVE IN ${Math.round(mins / 60)}H` : `LIVE IN ${mins}M`;
      liveBadge = `<span class="event-badge badge-live-soon">${label}</span>`;
    } else {
      liveBadge = `<span class="event-badge badge-live-soon">LIVE AVAIL</span>`;
    }
  }

  // Distance with blue colouring when location active
  let distHtml = '';
  if (evt.distance_km != null) {
    const km = parseFloat(evt.distance_km);
    let distClass = '';
    if (state.locationActive) {
      distClass = km <= 5 ? 'distance-near' : km <= 15 ? 'distance-mid' : 'distance-far';
    }
    distHtml = ` · <span class="${distClass}">${evt.distance_km} km</span>`;
  }

  const isCancelled = evt.status === 'cancelled';
  const cancelledBadge = isCancelled ? `<span class="event-badge badge-cancelled">CANCELLED</span>` : '';
  // Combined tombstone: this parish's slot is folded into another event (deanery/
  // feast). Shown struck-through, parish-page only (see app.js scoped filter).
  const isCombined = evt.status === 'combined';
  const combinedTombBadge = isCombined ? `<span class="event-badge badge-combined">COMBINED</span>` : '';
  // Feast override surfaced for this occurrence (e.g. a normal Sunday that is a feast).
  const feastHtml = evt.feast ? `<div class="event-feast-row" style="font-size:12px;opacity:.75;margin-top:2px;">✛ ${esc(evt.feast)}</div>` : '';

  // Posters always render for feasts, talks, socials, and youth events. Other
  // event types keep the compact text-only card.
  const hasPoster = !!(evt.poster_path && (evt.event_type === 'feast' || evt.event_type === 'talk' || evt.event_type === 'social' || evt.event_type === 'youth'));
  const posterImg = hasPoster
    ? `<img class="event-card-poster" src="${esc(evt.poster_path)}" alt="" loading="lazy">`
    : '';

  const inlineBadges = [liveBadge, bilingualBadge, combinedBadge, combinedTombBadge, cancelledBadge].filter(Boolean).join('');

  // Show event address only when it differs from the parish's own address.
  const altAddr = (evt.address && evt.address !== evt.parish_address) ? evt.address : null;
  const altAddrHtml = altAddr ? `<div class="event-address-row">${esc(altAddr)}</div>` : '';

  return `
    <div class="event-card${(isCancelled || isCombined) ? ' event-cancelled' : ''}${hasPoster ? ' has-poster' : ''}" data-id="${evt.id}" data-event-type="${esc(evt.event_type || '')}">
      <div class="event-content">
        <div class="event-title-row">
          <span class="event-time">${time}</span>
          ${typeDot}
          <div class="event-title-block">
            <span class="event-title">${esc(evt.title)}${inlineBadges ? `<span class="event-inline-badges">${inlineBadges}</span>` : ''}<span class="event-card-chev"></span></span>
          </div>
        </div>
        <div class="event-parish-row">${acronym}${esc(evt.parish_name)}${distHtml}</div>
        ${feastHtml}
        ${altAddrHtml}
      </div>
      ${posterImg}
    </div>`;
}

function bindEventCards(container) {
  // Delegated — cards are pooled and reused across renders, so per-card
  // listeners would accumulate. One listener on the stable container
  // dispatches by .event-card ancestry.
  if (container._cardsBound) return;
  container._cardsBound = true;
  container.addEventListener('click', (e) => {
    if (e.target.closest('.event-card-drawer')) return;
    if (e.target.closest('.event-card-close')) return;
    const card = e.target.closest('.event-card');
    if (!card || !container.contains(card)) return;
    showEventDetail(card.dataset.id);
  });
}

// ── Render Services ──
// Render a parish's schedule as day-grouped items. Used by the main services
// list AND the parish-sheet Schedule section so both surfaces look identical,
// including language chips, WOM labels, and admin edit affordances.
function renderScheduleDaysHTML(items, opts = {}) {
  const isAdmin = !!opts.isAdmin;
  const byDay = new Map();
  for (const item of items) {
    if (!byDay.has(item.day_of_week)) byDay.set(item.day_of_week, []);
    byDay.get(item.day_of_week).push(item);
  }
  const types = ['liturgy','prayer','feast','talk','youth','social','other'];
  let html = '';
  for (const [day, scheds] of byDay) {
    html += `<div class="schedule-day">${DAYS[day]}</div>`;
    for (const s of scheds) {
      const t = formatTime12(s.start_time);
      const langs = (() => { try { return JSON.parse(s.languages || '[]'); } catch { return []; } })();
      const langLabel = langs.length ? `<span class="schedule-item-lang">${esc(langs.join(', '))}</span>` : '';
      const womLabel = womDisplayLabel(s.week_of_month, DAYS[day]);
      const editBtn = isAdmin ? `<button class="schedule-edit-btn" data-sid="${s.id}" title="Edit schedule">✎</button>` : '';
      const scopeLabel = s.parish_scoped ? `<span class="schedule-item-scope">parish only</span>` : '';
      // The row is the way into the rule: tapping it focuses that rule's next
      // occurrence at that parish. data-sched-focus carries both halves
      // because the main services panel renders rows for every parish at once.
      const focused = state.parishScheduleFocus
        && (state.parishScheduleFocus.ruleIds || []).includes(s.id);
      html += `<div class="schedule-item${focused ? ' focused' : ''}" data-sched-focus="${s.id}" data-sched-parish="${esc(s.parish_id)}" role="button" tabindex="0">`;
      html += `<div class="si-main"><span class="schedule-item-title">${esc(s.title)}</span><span class="schedule-item-time">${t}</span>${langLabel}${scopeLabel}${editBtn}<img class="si-chev" src="https://api.iconify.design/ph:caret-right-bold.svg" alt=""></div>`;
      if (womLabel) html += `<div class="si-wom">${womLabel}</div>`;
      html += `</div>`;
      if (isAdmin) {
        const womChecked = s.week_of_month ? s.week_of_month.split(',').map(w => w.trim()) : [];
        html += `<div class="schedule-edit-form" id="sef-${s.id}" style="display:none;" onclick="event.stopPropagation()">
          <div class="schedule-edit-grid">
            <input data-f="title" class="sef-full" value="${esc(s.title)}" placeholder="Title">
            <select data-f="day_of_week">${[0,1,2,3,4,5,6].map(d => `<option value="${d}" ${s.day_of_week===d?'selected':''}>${DAYS[d]}</option>`).join('')}</select>
            <select data-f="event_type">${types.map(t => `<option value="${t}" ${s.event_type===t?'selected':''}>${t}</option>`).join('')}</select>
            <input data-f="start_time" type="time" value="${esc(s.start_time)}">
            <input data-f="end_time" type="time" value="${esc(s.end_time || '')}">
            <input data-f="languages" class="sef-full" value="${esc(langs.join(', '))}" placeholder="Languages (comma-separated)">
          </div>
          <div class="wom-checkboxes" data-f="week_of_month">
            <span class="wom-label">Weeks:</span>
            ${['first','second','third','fourth','last'].map(w =>
              `<label class="wom-check"><input type="checkbox" value="${w}" ${womChecked.includes(w)?'checked':''}> ${w}</label>`
            ).join('')}
          </div>
          <div class="sef-toggles">
            <label class="wom-check"><input type="checkbox" data-f="hide_live" ${s.hide_live?'checked':''}> No live badge</label>
            <label class="wom-check"><input type="checkbox" data-f="parish_scoped" ${s.parish_scoped?'checked':''}> Parish only</label>
          </div>
          <div class="sef-actions">
            <button class="schedule-save-btn" data-sid="${s.id}">Save</button>
            <button class="schedule-del-btn" data-sid="${s.id}">Delete</button>
          </div>
        </div>`;
      }
    }
  }
  // Under the timetable, not above it: it describes the whole block, and a
  // reader wants the times first and the provenance second.
  html += scheduleSourceHTML(items);
  return html;
}

// Bind toggle/save/delete handlers for every admin schedule-edit affordance
// under `container`. Idempotent: tied to elements, not global state.
function wireScheduleAdminHandlers(container) {
  container.querySelectorAll('.schedule-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const form = document.getElementById('sef-' + btn.dataset.sid);
      if (form) form.style.display = form.style.display === 'none' ? 'block' : 'none';
    });
  });
  container.querySelectorAll('.schedule-save-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.sid;
      const form = document.getElementById('sef-' + id);
      if (!form) return;
      const data = {};
      form.querySelectorAll('[data-f]').forEach(input => {
        const field = input.dataset.f;
        if (field === 'week_of_month') {
          const checked = [...input.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value);
          data[field] = checked.length ? checked.join(',') : null;
        } else if (field === 'hide_live' || field === 'parish_scoped') {
          data[field] = input.checked ? 1 : 0;
        } else {
          const val = input.tagName === 'SELECT' ? input.value : input.value.trim();
          if (field === 'languages') data[field] = val ? JSON.stringify(val.split(',').map(s => s.trim()).filter(Boolean)) : null;
          else if (field === 'day_of_week') data[field] = parseInt(val);
          else data[field] = val || null;
        }
      });
      fetch(`/api/admin/schedules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        .then(r => { if (r.ok) { form.style.display = 'none'; fetchSchedules(); } });
    });
  });
  container.querySelectorAll('.schedule-del-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm('Delete this schedule?')) return;
      fetch(`/api/admin/schedules/${btn.dataset.sid}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } })
        .then(r => { if (r.ok) fetchSchedules(); });
    });
  });
}

function renderServices() {
  const container = document.getElementById('services-list');
  let schedules = state.schedules;
  if (state.filters.location) {
    schedules = schedules.filter(s => parishIdPassesLocation(s.parish_id));
  }
  if (state.filters.service) {
    schedules = schedules.filter(s => rowIsService(state.filters.service, s));
  }
  if (state.filters.day != null) {
    schedules = schedules.filter(s => s.day_of_week === state.filters.day);
  }
  if (state.filters.parishIds) {
    schedules = schedules.filter(s => state.filters.parishIds.has(s.parish_id));
  } else if (state.viewportParishIds) {
    schedules = schedules.filter(s => state.viewportParishIds.has(s.parish_id));
  }
  if (state.filters.englishOnly) {
    schedules = schedules.filter(s => {
      const langs = parseLangs(s.languages) || parseLangs(s.parish_languages);
      if (!langs) return false;
      if (state.filters.englishStrict) return langs.every(l => /english/i.test(l));
      return langs.some(l => /english/i.test(l));
    });
  }

  let html = '';
  if (!schedules.length) {
    html = renderEmptyStateHTML();
  }

  const byParish = new Map();
  for (const s of schedules) {
    if (!byParish.has(s.parish_id)) byParish.set(s.parish_id, { info: s, items: [] });
    byParish.get(s.parish_id).items.push(s);
  }

  // Sort parish groups: distance when Nearby sort active, else alpha by name.
  const nearby = state.eventsSort === 'nearby' && state.locationActive;
  const parishGroups = [...byParish.entries()].map(([pid, grp]) => {
    const parish = state.parishes.find(p => p.id === pid);
    const dist = nearby && parish && parish.lat && parish.lng
      ? haversineKm(state.userLat, state.userLng, parish.lat, parish.lng)
      : Infinity;
    return { pid, grp, dist, name: grp.info.parish_name || '' };
  });
  if (nearby) {
    parishGroups.sort((a, b) => a.dist - b.dist);
  } else {
    parishGroups.sort((a, b) => a.name.localeCompare(b.name));
  }

  // Group parish schedules into jurisdiction boxes so each jurisdiction
  // gets its own framed section (matching the day-box treatment in the
  // events view). Jurisdictions are sorted by their first parish's position
  // in the already-sorted parishGroups list — preserves nearby/alpha order.
  const byJuris = new Map();
  for (const pg of parishGroups) {
    const j = (pg.grp.info.jurisdiction || 'other').toLowerCase();
    if (!byJuris.has(j)) byJuris.set(j, []);
    byJuris.get(j).push(pg);
  }
  for (const [juris, pgs] of byJuris) {
    const jColor = getJurisdictionColor(juris);
    const jLabel = capitalize(juris) + ' Orthodox';
    html += `<div class="jurisdiction-box" style="--juris-color:${esc(jColor)}">`;
    html += `<div class="section-header jurisdiction-header">${esc(jLabel)}</div>`;
    for (const { pid, grp: { info, items } } of pgs) {
      const pColor = getParishDisplayColor(info.parish_color || jColor);
      const initial = (info.parish_name || '?')[0].toUpperCase();
      const parish = state.parishes.find(p => p.id === pid);
      // Distance chip: same intensity tiers as event list (near ≤5, mid ≤15, far).
      let distHtml = '';
      if (state.locationActive && parish && parish.lat && parish.lng) {
        const km = haversineKm(state.userLat, state.userLng, parish.lat, parish.lng);
        const cls = km <= 5 ? 'distance-near' : km <= 15 ? 'distance-mid' : 'distance-far';
        distHtml = `<span class="parish-schedule-dist ${cls}">${km.toFixed(1)} km</span>`;
      }
      const hasLogo = !!(parish && parish.logo_path);
      const avatarInner = hasLogo ? `<img src="${esc(parish.logo_path)}" alt="">` : esc(initial);
      const avatarStyle = hasLogo ? '' : ` style="background:${esc(pColor)}"`;
      html += `<div class="parish-schedule" data-parish-id="${esc(pid)}">`;
      html += `<div class="parish-schedule-head">`;
      html += `<div class="parish-schedule-avatar"${avatarStyle}>${avatarInner}</div>`;
      html += `<div class="parish-schedule-name">${esc(info.parish_name)}</div>`;
      html += distHtml;
      html += `</div>`;
      html += renderScheduleDaysHTML(items, { isAdmin: state.isAdmin });
      html += '</div>';
    }
    html += '</div>';
  }

  const singleParishId = state.filters.parishIds && state.filters.parishIds.size === 1
    ? [...state.filters.parishIds][0] : null;
  const singleParish = singleParishId ? state.parishes.find(p => p.id === singleParishId) : null;
  if (singleParish && singleParish.website) {
    html += `<div class="list-footer"><a class="list-footer-btn" href="${esc(singleParish.website)}" target="_blank" rel="noopener">View Parish Website</a></div>`;
  }

  const archUrl = ARCHDIOCESE_EVENTS[state.filters.jurisdiction];
  const archFooter = archUrl
    ? `<div class="list-footer"><div class="list-footer-ornament">· · ·</div><a class="list-footer-arch-link" href="${esc(archUrl)}" target="_blank" rel="noopener">${esc(capitalize(state.filters.jurisdiction || ''))} Archdiocese</a></div>`
    : `<div class="list-footer"><div class="list-footer-ornament">· · ·</div></div>`;
  html += archFooter;
  container.innerHTML = html;

  // Tap a parish's schedule block → open the parish sheet overlay (now that
  // the sheet is a first-class surface, schedule taps should land there
  // directly rather than just setting a header focus on the main list).
  container.querySelectorAll('.parish-schedule').forEach(card => {
    card.addEventListener('click', e => {
      // Don't hijack admin edit buttons inside the card
      if (e.target.closest('.schedule-edit-btn, .schedule-save-btn, .schedule-del-btn, .schedule-edit-form')) return;
      const pid = card.dataset.parishId;
      if (typeof window.openParishSheet === 'function') window.openParishSheet(pid);
    });
  });

  wireScheduleAdminHandlers(container);
}

// ── Event detail ──
// Tap from event list (or permalink). Toggles expansion — clicking the already-
// open card's summary collapses it; any other id switches.
function showEventDetail(id) {
  const curr = document.querySelector('.event-card.expanded');
  if (curr && curr.dataset.id === String(id)) {
    closeDetail();
    return;
  }
  expandEventCard(id);
}

function expandEventCard(id, opts = {}) {
  const root = opts.scope || document;
  const evt = state.events.find(e => e.id === id);
  if (!evt) return;

  // Caller can hand us the specific card element to expand (e.g. stream copy
  // vs pinned copy of the same focused event). Fall back to the first match.
  const card = opts.card || root.querySelector(`.event-card[data-id="${id}"]`);
  if (!card) return;

  // Collapse every other expanded card in scope. Covers both different-id
  // cards AND same-id copies in another slot (pinned ↔ stream), which is
  // how tapping one copy minimises the other.
  root.querySelectorAll('.event-card.expanded').forEach(c => {
    if (c === card) return;
    c.classList.remove('expanded');
    c.style.removeProperty('--accent-glow');
    const d = c.querySelector('.event-card-drawer');
    if (d) d.remove();
    const cb = c.querySelector('.event-card-close');
    if (cb) cb.remove();
  });

  if (!card.classList.contains('expanded')) {
    const inParishSheet = !!(root && root.id === 'parish-sheet-scroll');
    const drawer = document.createElement('div');
    drawer.className = 'event-card-drawer';
    drawer.innerHTML = renderEventDrawerHTML(evt, { suppressParishHeader: inParishSheet });
    card.appendChild(drawer);
    // Close button lives at card level (not drawer) so it aligns with the
    // event title row's Y axis rather than floating above the drawer.
    const closeBtn = drawer.querySelector('.event-card-close');
    if (closeBtn) {
      card.appendChild(closeBtn);
      closeBtn.addEventListener('click', (e) => { e.stopPropagation(); closeDetail(); });
    }
    card.classList.add('expanded');
    const accent = getParishDisplayColor(evt.parish_color || '#888888');
    card.style.setProperty('--accent-glow', hexToRgba(accent, 0.28));
    wireEventDrawer(drawer, evt);
  }

  state._openEventId = id;
  syncURL();

  // Always snap the host sheet to FULL when an event expands. Whether the
  // tap originated in the main bottom-sheet or the parish-sheet, the user
  // expects the drawer to occupy maximum space.
  const inParishSheetScroll = card.closest('#parish-sheet-scroll');
  if (inParishSheetScroll && typeof window.agoraParishSheetSnapFull === 'function') {
    window.agoraParishSheetSnapFull();
  } else if (typeof window.agoraSnapTo === 'function' && typeof window.agoraSnapFull === 'function') {
    window.agoraSnapTo(window.agoraSnapFull());
  }

  requestAnimationFrame(() => {
    // Bring the top of the just-expanded drawer into view. The drawer
    // sits at the top of the .expanded card; we want the drawer hero
    // (which carries the type badge — liturgy/prayer/etc.) to land
    // just below ALL sticky elements above the card, not just the
    // parish-sheet's header stack.
    const scroller = card.closest('#parish-sheet-scroll, #sheet-scroll');
    if (!scroller) return;
    // Sticky stack heights:
    //   --ps-stack-h: parish-sheet's .ps-header + .ps-filter-row
    //   .day-hdr: the closest day section's header (sticky to scroll top)
    //   .time-card-head: the morning/evening label, if the card is
    //                    inside a .time-card group
    let stickyOffset = 0;
    const sheetEl = scroller.closest('.parish-sheet, #bottom-sheet');
    if (sheetEl) {
      stickyOffset += parseFloat(getComputedStyle(sheetEl).getPropertyValue('--ps-stack-h')) || 0;
    }
    const daySection = card.closest('.day-section, .day-box');
    const dayHdr = daySection ? daySection.querySelector(':scope > .day-hdr, :scope > .section-header') : null;
    if (dayHdr) stickyOffset += dayHdr.offsetHeight;
    const timeCard = card.closest('.time-card');
    const timeCardHead = timeCard ? timeCard.querySelector(':scope > .time-card-head') : null;
    if (timeCardHead) stickyOffset += timeCardHead.offsetHeight;

    const cardRect = card.getBoundingClientRect();
    const scrollRect = scroller.getBoundingClientRect();
    const targetTop = scrollRect.top + stickyOffset + 8;
    const delta = cardRect.top - targetTop;
    if (Math.abs(delta) > 4) {
      scroller.scrollTo({
        top: scroller.scrollTop + delta,
        behavior: 'smooth'
      });
    }
  });
}

function collapseEventCardDOM(opts = {}) {
  const root = opts.scope || document;
  // querySelectorAll because the same event id can be expanded in multiple
  // scopes at once (main-list and parish-sheet), e.g. after tap-in-list ->
  // tap-parish-header. A single-scope querySelector would leave a zombie
  // drawer in the hidden main list that re-appears when the parish sheet
  // closes.
  root.querySelectorAll('.event-card.expanded').forEach(card => {
    const drawer = card.querySelector('.event-card-drawer');
    const closeBtn = card.querySelector('.event-card-close');
    const finalize = () => {
      card.classList.remove('expanded');
      card.style.removeProperty('--accent-glow');
      if (drawer && drawer.parentNode) drawer.remove();
      if (closeBtn && closeBtn.parentNode) closeBtn.remove();
    };
    if (drawer && !opts.instant) {
      // Animate the drawer's collapse via the @keyframes drawer-close
      // CSS animation (mirror of drawer-open's curve), then tear down
      // the DOM. animationend is the cleanup signal; setTimeout is the
      // fallback if the event is missed.
      drawer.classList.add('collapsing');
      let done = false;
      const onAnim = () => { if (done) return; done = true; finalize(); };
      drawer.addEventListener('animationend', onAnim, { once: true });
      setTimeout(onAnim, 280);
    } else {
      finalize();
    }
  });
}

function renderEventDrawerHTML(evt, opts = {}) {
  const start = new Date(evt.start_utc);

  const dateFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(start);
  const timeFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(start);

  let endStr = '';
  if (evt.end_utc) {
    endStr = ` — ${new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(evt.end_utc))}`;
  }

  const addr = evt.location_override || evt.parish_address || '';
  // If event has a location override, use event's own coords (custom venue).
  // Otherwise use parish coords (always current — event coords may be stale).
  const parish = state.parishes.find(p => p.id === evt.parish_id);
  const lat = evt.location_override ? (evt.lat || (parish && parish.lat) || 0) : ((parish && parish.lat) || evt.lat || 0);
  const lng = evt.location_override ? (evt.lng || (parish && parish.lng) || 0) : ((parish && parish.lng) || evt.lng || 0);

  const watchLiveCta = (evt.parish_live_url && !evt.hide_live)
    ? `<a class="btn-watch-live" href="${esc(evt.parish_live_url)}" target="_blank" rel="noopener"><span class="live-dot"></span>Watch Live</a>`
    : '';

  // Service book button: Antiochian events only, Holy Week through end of Sunday (Agape Vespers)
  const holyWeekEnd = new Date('2026-04-13T14:00:00Z'); // midnight Monday AEST
  const serviceBookCta = (evt.jurisdiction === 'antiochian' && new Date() <= holyWeekEnd)
    ? `<a class="btn-service-book" href="https://www.antiochian.org.au/holy-week-service-books" target="_blank" rel="noopener"><img src="https://api.iconify.design/ph:book-open.svg" alt="" class="btn-service-book-icon">Service Book</a>`
    : '';

  let adminActions = '';
  if (state.isAdmin) {
    const isCancelled = evt.status === 'cancelled';
    const isHidden = evt.status === 'hidden';
    const hiding = localStorage.getItem('hideAdminControls') === 'true';
    const isHeadless = evt.mutation_type === 'headless';
    const isScheduleOrigin = evt.source_adapter === 'schedule' || evt.mutation_type === 'scheduled' || evt.mutation_type === 'adapted';
    // ids are JSON-quoted so synthetic schedule instance ids ("13:2026-07-04")
    // round-trip as JS string literals. &quot; lets the embedded double quotes
    // survive the outer onclick="..." attribute (HTML parser would otherwise
    // terminate the attribute at the first inner ").
    const eid = JSON.stringify(String(evt.id)).replace(/"/g, '&quot;');
    adminActions = `
      <div class="admin-actions-group" style="${hiding ? 'display:none' : ''}">
        <button class="btn-outline btn-cancel-event" onclick="setEventStatus(${eid},'${isCancelled ? 'approved' : 'cancelled'}')">${isCancelled ? 'Uncancel' : 'Cancel'}</button>
        ${isScheduleOrigin ? `<button class="btn-outline btn-hide-event" onclick="setEventStatus(${eid},'${isHidden ? 'approved' : 'hidden'}')">${isHidden ? 'Unhide' : 'Hide'}</button>` : ''}
        ${isHeadless ? `<button class="btn-danger" onclick="deleteEvent(${eid})">Delete</button>` : ''}
        <button class="btn-outline" onclick="toggleEditEvent(${eid})">Edit</button>
        ${isScheduleOrigin ? '' : `<button class="btn-outline" onclick="openPublicEscalateModal(${eid})">Combine…</button>`}
      </div>
      ${adminVisibilityPill(hiding, '')}`;
  }

  let editForm = '';
  if (state.isAdmin) {
    const parishOpts = state.parishes.filter(p => p.id !== '_unassigned').map(p =>
      `<option value="${esc(p.id)}" ${p.id === evt.parish_id ? 'selected' : ''}>${esc(p.name)}</option>`
    ).join('');
    const eid = JSON.stringify(String(evt.id)).replace(/"/g, '&quot;');
    editForm = `
      <div class="detail-edit-form" id="edit-form-${evt.id}" style="display:none;">
        <div class="edit-row"><label>Title</label><input id="edit-title-${evt.id}" value="${esc(evt.title)}"></div>
        <div class="edit-row"><label>Description</label><textarea id="edit-desc-${evt.id}">${esc(evt.description || '')}</textarea></div>
        <div class="edit-row"><label>Type</label>
          <select id="edit-type-${evt.id}">
            ${['liturgy','prayer','feast','talk','youth','social','other'].map(t =>
              `<option value="${t}" ${evt.event_type === t ? 'selected' : ''}>${t}</option>`
            ).join('')}
          </select>
        </div>
        <div class="edit-row"><label>Parish</label>
          <select id="edit-parish-${evt.id}">${parishOpts}</select>
        </div>
        <div class="edit-row"><label>Languages</label><input id="edit-langs-${evt.id}" placeholder="English, Arabic" value="${esc(evt.languages ? JSON.parse(evt.languages).join(', ') : '')}"></div>
        <div class="edit-row"><label>Start (Sydney)</label><input type="datetime-local" id="edit-start-${evt.id}" value="${utcToLocalInput(evt.start_utc)}"></div>
        <div class="edit-row"><label>End (Sydney)</label><input type="datetime-local" id="edit-end-${evt.id}" value="${utcToLocalInput(evt.end_utc)}"></div>
        <div class="edit-row"><label>Address (override)</label><input id="edit-location-${evt.id}" placeholder="Leave blank to use parish address" value="${esc(evt.location_override || '')}"></div>
        ${evt.parish_live_url ? `<div class="edit-row"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="edit-hide-live-${evt.id}" ${evt.hide_live ? 'checked' : ''}> Hide live badge</label></div>` : ''}
        <div class="edit-row"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="edit-parish-scoped-${evt.id}" ${evt.parish_scoped ? 'checked' : ''}> Parish-only (hidden unless filtered to parish)</label></div>
        <div style="margin-top:8px;display:flex;gap:8px;">
          <button class="btn-save" onclick="saveEvent(${eid})">Save</button>
        </div>
      </div>`;
  }

  const posterHtml = evt.poster_path
    ? `<div class="detail-poster"><img src="${esc(evt.poster_path)}" alt="Event poster"></div>`
    : '';

  // Promoted hero: type label above, then time + title inline, then parish.
  // Suppressed inside the parish sheet itself — the user is already on that parish.
  const displayType = TYPE_DISPLAY[evt.event_type] || evt.event_type;
  const badgeCss = `badge-${evt.event_type}`;
  let heroHtml = '';
  if (parish) {
    const initial = (parish.name || '?')[0].toUpperCase();
    const color = getParishDisplayColor(parish.color || '#666');
    const juris = capitalize(parish.jurisdiction || '');
    const heroTime = formatEventTime(start);
    const hasLogo = !!parish.logo_path;
    const avatarInner = hasLogo ? `<img src="${esc(parish.logo_path)}" alt="">` : esc(initial);
    const avatarStyle = hasLogo ? '' : ` style="background:${esc(color)}"`;
    const parishRow = opts.suppressParishHeader ? '' : `
      <button type="button" class="event-drawer-parish-btn" data-parish-id="${esc(parish.id)}">
        <span class="event-drawer-avatar"${avatarStyle}>${avatarInner}</span>
        <span class="edp-text">
          <span class="edp-name">${esc(parish.name)}</span>
          <span class="edp-juris">${esc(juris)} Orthodox</span>
        </span>
        <img class="edp-chev" src="https://api.iconify.design/ph:caret-right-bold.svg" alt="">
      </button>`;
    heroHtml = `
      <div class="event-drawer-hero">
        <div class="edp-type-label"><span class="event-badge ${badgeCss}">${displayType}</span></div>
        <div class="event-drawer-hero-title">
          <span class="edp-time">${heroTime}</span><span class="edp-title">${esc(evt.title)}</span>
        </div>
        ${parishRow}
      </div>`;
  }

  const addrHtml = addr
    ? `<button type="button" class="event-drawer-address" data-address="${esc(addr)}">
         <span class="event-drawer-address-text">${esc(addr)}</span>
         <img class="event-drawer-address-copy" src="https://api.iconify.design/ph:copy.svg" alt="">
       </button>`
    : '';

  return `
    <button class="event-card-close" type="button" aria-label="Close">&times;</button>
    ${heroHtml}
    <div class="event-drawer-meta">
      <div>${dateFmt}</div>
      <div>${timeFmt}${endStr}</div>
      ${addrHtml}
      ${evt.distance_km != null ? `<div>${evt.distance_km} km away</div>` : ''}
      ${evt.languages ? `<div>${(() => { try { return JSON.parse(evt.languages).join(', '); } catch { return evt.languages; } })()}</div>` : ''}
    </div>
    ${evt.description ? `<div class="detail-description">${esc(evt.description)}</div>` : ''}
    <div class="detail-actions">
      <a class="btn-action btn-primary" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}" target="_blank" rel="noopener">
        <img class="btn-action-icon" src="https://api.iconify.design/ph:map-trifold-fill.svg" alt="">Directions
      </a>
      <button class="btn-action btn-share-event" type="button" data-share-id="${evt.id}">
        <img class="btn-action-icon" src="https://api.iconify.design/ph:paper-plane-tilt.svg" alt="">Share
      </button>
      ${watchLiveCta}
      ${serviceBookCta}
      ${adminActions}
    </div>
    ${posterHtml}
    ${editForm}`;
}

function wireEventDrawer(drawer, evt) {
  // Drawer click handling has two responsibilities:
  // 1. Stop bubbling for taps on interactive children, so the .event-card
  //    click handler doesn't treat them as a "toggle the card" request.
  // 2. Tap on bare drawer surface (not on a button/link/input/text input
  //    or a known interactive class) collapses the drawer — gives the
  //    user a generous tap-to-close target instead of needing the close
  //    button or hero-title specifically.
  // Pinned events in the parish-sheet are an exception: they're the
  // hoisted "highlight" card and shouldn't collapse on bare-tap.
  const isPinned = !!drawer.closest('.ps-pinned-event');
  drawer.addEventListener('click', e => {
    const interactive = e.target.closest(
      'button, a, input, textarea, select, .event-drawer-hero-title, .event-drawer-address, .event-drawer-poster'
    );
    if (interactive) {
      e.stopPropagation();
      return;
    }
    if (isPinned) {
      // Pinned card stays expanded — bare-tap is a no-op here so the user
      // can scroll/read without accidentally collapsing the highlight.
      e.stopPropagation();
      return;
    }
    closeDetail();
  });

  const heroTitle = drawer.querySelector('.event-drawer-hero-title');
  if (heroTitle) {
    heroTitle.addEventListener('click', e => {
      e.stopPropagation();
      closeDetail();
    });
  }

  const parishBtn = drawer.querySelector('.event-drawer-parish-btn');
  if (parishBtn) {
    parishBtn.addEventListener('click', () => {
      const pid = parishBtn.dataset.parishId;
      if (pid) openParishSheet(pid);
    });
  }

  const addrBtn = drawer.querySelector('.event-drawer-address');
  if (addrBtn) {
    addrBtn.addEventListener('click', async () => {
      const text = addrBtn.dataset.address || '';
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch {}
        document.body.removeChild(ta);
      }
      const label = addrBtn.querySelector('.event-drawer-address-text');
      if (!label) return;
      if (addrBtn._copyTimer) clearTimeout(addrBtn._copyTimer);
      const saved = label.textContent;
      label.textContent = 'Copied';
      addrBtn.classList.add('copied');
      addrBtn._copyTimer = setTimeout(() => {
        label.textContent = saved;
        addrBtn.classList.remove('copied');
        addrBtn._copyTimer = null;
      }, 1200);
    });
  }

  const shareEvtBtn = drawer.querySelector('.btn-share-event');
  if (shareEvtBtn) {
    shareEvtBtn.addEventListener('click', async () => {
      const id = shareEvtBtn.dataset.shareId;
      const url = `${location.origin}/${id}`;
      await shareUrl(url, evt.title, shareEvtBtn);
    });
  }

  const posterContainer = drawer.querySelector('.detail-poster');
  const posterEl = drawer.querySelector('.detail-poster img');
  if (posterEl) {
    posterContainer.addEventListener('click', () => openPosterFullscreen(posterEl.src));
  }
}

// ── Parish detail (from services view) ──
function showParishDetail(parishId) {
  const parish = state.parishes.find(p => p.id === parishId);
  if (!parish) return;

  const panel = document.getElementById('event-detail');
  const content = document.getElementById('detail-content');

  // Gather schedules for this parish
  const scheds = state.schedules.filter(s => s.parish_id === parishId);
  const byDay = new Map();
  for (const s of scheds) {
    if (!byDay.has(s.day_of_week)) byDay.set(s.day_of_week, []);
    byDay.get(s.day_of_week).push(s);
  }

  let schedHtml = '';
  for (const [day, items] of byDay) {
    schedHtml += `<div class="schedule-day">${DAYS[day]}</div>`;
    for (const s of items) {
      // "any schedule panel" includes this one — the legacy desktop detail
      // panel. Same attributes, so initScheduleRowTaps picks it up too.
      schedHtml += `<div class="schedule-item" data-sched-focus="${s.id}" data-sched-parish="${esc(s.parish_id)}" role="button" tabindex="0">${esc(s.title)} <span class="schedule-item-time">— ${formatTime12(s.start_time)}</span></div>`;
    }
  }

  const addr = parish.address || '';
  const websiteCta = parish.website ? `<a class="btn-outline" href="${esc(parish.website)}" target="_blank" rel="noopener">Visit Website</a>` : '';

  content.innerHTML = `
    <h2 class="detail-title">${esc(parish.name)}</h2>
    <div class="detail-meta">
      <div>${esc(capitalize(parish.jurisdiction))} Orthodox</div>
      ${addr ? `<div>${esc(addr)}</div>` : ''}
      ${parish.phone ? `<div>${esc(parish.phone)}</div>` : ''}
      ${parish.email ? `<div>${esc(parish.email)}</div>` : ''}
    </div>
    ${schedHtml ? `<div style="margin-bottom:16px;">${schedHtml}</div>` : ''}
    <div class="detail-actions">
      <a class="btn-primary" href="https://www.google.com/maps/dir/?api=1&destination=${parish.lat},${parish.lng}" target="_blank" rel="noopener">Directions</a>
      ${websiteCta}
    </div>`;

  panel.style.borderLeftColor = getParishDisplayColor(parish.color || '#cccccc');
  history.pushState({ detail: true }, '');
  detailHistoryPushed = true;
  panel.classList.remove('hidden');
  if (!document.querySelector('.detail-backdrop')) {
    const backdrop = document.createElement('div');
    backdrop.className = 'detail-backdrop';
    backdrop.addEventListener('click', closeDetail);
    document.body.appendChild(backdrop);
  }
}

window.toggleEditEvent = function(id) {
  const form = document.getElementById(`edit-form-${id}`);
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
};

window.saveEvent = async function(id) {
  const startVal = document.getElementById(`edit-start-${id}`).value;
  const endVal = document.getElementById(`edit-end-${id}`).value;
  const langsRaw = document.getElementById(`edit-langs-${id}`).value;
  const langsArr = langsRaw ? langsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const hideLiveEl = document.getElementById(`edit-hide-live-${id}`);
  const data = {
    title: document.getElementById(`edit-title-${id}`).value,
    description: document.getElementById(`edit-desc-${id}`).value || null,
    event_type: document.getElementById(`edit-type-${id}`).value,
    parish_id: document.getElementById(`edit-parish-${id}`).value,
    languages: langsArr.length ? JSON.stringify(langsArr) : null,
    start_utc: startVal ? localInputToUtc(startVal) : undefined,
    end_utc: endVal ? localInputToUtc(endVal) : null
  };
  if (hideLiveEl) data.hide_live = hideLiveEl.checked;
  const parishScopedEl = document.getElementById(`edit-parish-scoped-${id}`);
  if (parishScopedEl) data.parish_scoped = parishScopedEl.checked;
  const locationEl = document.getElementById(`edit-location-${id}`);
  if (locationEl) data.location_override = locationEl.value;
  const res = await fetch(`/api/admin/events/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (res.ok) {
    // Refresh state.events, then rebuild the open drawer in place so the
    // user sees the new values immediately without closing the detail.
    // collapseEventCardDOM only tears down the DOM; state._openEventId is
    // preserved so renderEvents re-expands the same card with fresh data.
    // { fresh: true } bypasses the 60s browser cache on /api/events so the
    // just-written change is actually visible (otherwise stale read wins).
    await fetchEvents({ fresh: true });
    if (state._openEventId) {
      collapseEventCardDOM({ instant: true });
      scheduleRenderEvents(0);
    }
  }
};

window.setEventStatus = async function(id, status) {
  const res = await fetch(`/api/admin/events/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status })
  });
  if (res.ok) {
    closeDetail();
    fetchEvents({ fresh: true });
  }
};

window.deleteEvent = async function(id) {
  if (!confirm('Permanently delete this event?')) return;
  const res = await fetch(`/api/admin/events/${id}`, { method: 'DELETE' });
  if (res.ok) {
    closeDetail();
    fetchEvents({ fresh: true });
  }
};

window.toggleParishEdit = function(id) {
  const form = document.getElementById(`ps-edit-form-${id}`);
  if (!form) return;
  const opening = form.style.display === 'none';
  form.style.display = opening ? '' : 'none';
  // The avatar is only a logo control while the form is open — see the
  // .ps-avatar-edit note in app.css.
  const avatar = document.querySelector('#parish-sheet-content .ps-avatar[data-logo-edit]');
  if (avatar) avatar.classList.toggle('editing', opening);
  if (opening) form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

window.saveParish = async function(id) {
  const pid = id;
  const langsRaw = document.getElementById(`pse-langs-${pid}`).value;
  const langsArr = langsRaw ? langsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const data = {
    name: document.getElementById(`pse-name-${pid}`).value,
    full_name: document.getElementById(`pse-fullname-${pid}`).value || null,
    jurisdiction: document.getElementById(`pse-jurisdiction-${pid}`).value,
    address: document.getElementById(`pse-address-${pid}`).value || null,
    website: document.getElementById(`pse-website-${pid}`).value || null,
    phone: document.getElementById(`pse-phone-${pid}`).value || null,
    live_url: document.getElementById(`pse-live-${pid}`).value || null,
    donation_url: document.getElementById(`pse-donation-${pid}`).value || null,
    raffle_url: document.getElementById(`pse-raffle-${pid}`).value || null,
    payment_url: document.getElementById(`pse-payment-${pid}`).value || null,
    gala_url: document.getElementById(`pse-gala-${pid}`).value || null,
    color: document.getElementById(`pse-color-${pid}`).value,
    acronym: document.getElementById(`pse-acro-${pid}`).value || null,
    languages: langsArr.length ? JSON.stringify(langsArr) : null,
    info_source_name: document.getElementById(`pse-srcname-${pid}`).value || null,
    info_source_ref: document.getElementById(`pse-srcref-${pid}`).value || null,
  };
  const res = await fetch(`/api/admin/parishes/${encodeURIComponent(pid)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (res.ok) {
    const updated = await res.json();
    const idx = state.parishes.findIndex(p => p.id === pid);
    if (idx !== -1) state.parishes[idx] = { ...state.parishes[idx], ...updated };
    renderParishSheetContent(pid, {});
    if (typeof updateMap === 'function') updateMap(state);
  } else {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Save failed');
  }
};

window.deleteParish = async function(id) {
  const parish = state.parishes.find(p => p.id === id);
  if (!confirm(`Delete "${parish ? parish.name : id}"?`)) return;
  const tryDelete = async (qs = '') => fetch(`/api/admin/parishes/${encodeURIComponent(id)}${qs}`, { method: 'DELETE' });
  let res = await tryDelete();
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (err.event_count && confirm(`${err.event_count} events belong to this parish. Delete them too?`)) {
      res = await tryDelete('?delete_events=1');
      if (res.ok) state.events = state.events.filter(e => e.parish_id !== id);
    } else { return; }
  }
  if (res.ok) {
    state.parishes = state.parishes.filter(p => p.id !== id);
    if (typeof closeParishSheet === 'function') closeParishSheet();
    if (typeof updateMap === 'function') updateMap(state);
    scheduleRenderEvents();
  }
};

// ── Parish logo editor (admin) ────────────────────────────────────────
//
// One dialog, two panes. The chooser offers upload / crop / clear against
// the logo as it stands; picking a file or hitting Crop moves to the
// cropper, which is a canvas the source image is drawn into under a
// circular mask, pannable by drag and zoomable by slider.
//
// Cropping is client-side because there is nowhere else for it to happen:
// a Worker has no image pipeline, and adding one for this would be a
// dependency and a CPU bill for something a canvas already does. The
// export is a square 512px PNG, which also means a 4 MB photograph off a
// phone reaches R2 as ~100 KB — the avatar it becomes is 44px wide.
const LOGO_EXPORT_SIZE = 512;

const _logo = {
  parishId: null,
  img: null,          // HTMLImageElement of the source
  scale: 1,           // fitted scale × zoom
  fitScale: 1,        // scale at which the image just covers the stage
  offsetX: 0,         // top-left of the drawn image, in stage px
  offsetY: 0,
  stage: 0,           // stage side length in CSS px
  dragging: false,
  lastX: 0,
  lastY: 0,
  wired: false,
};

window.openParishLogoEditor = function(parishId) {
  const parish = state.parishes.find(p => p.id === parishId);
  if (!parish) return;
  _logo.parishId = parishId;
  _wireLogoEditor();

  document.getElementById('logo-modal-sub').textContent = parish.name || parishId;
  _showLogoPane('choose');

  const preview = document.getElementById('logo-preview');
  if (parish.logo_path) {
    preview.innerHTML = `<img src="${esc(parish.logo_path)}" alt="">`;
  } else {
    const color = getParishDisplayColor(parish.color || rawJurisColor(parish.jurisdiction));
    preview.innerHTML = `<span class="logo-preview-initial" style="background:${esc(color)}">${esc((parish.full_name || parish.name || '?')[0].toUpperCase())}</span>`;
  }

  // Crop only offers itself when there is something to crop, and clear only
  // when there is something to clear — a dialog whose buttons are all live
  // says less about the current state than one whose buttons are not.
  const actions = document.getElementById('logo-choose-actions');
  actions.innerHTML =
    `<button class="ps-btn ps-btn-admin" type="button" id="logo-act-upload">${glyph('ph:upload-simple')}${parish.logo_path ? 'Upload new' : 'Upload'}</button>`
    + (parish.logo_path ? `<button class="ps-btn ps-btn-admin" type="button" id="logo-act-crop">${glyph('ph:crop')}Crop</button>` : '')
    + (parish.logo_path ? `<button class="ps-btn ps-btn-danger" type="button" id="logo-act-clear">${glyph('ph:trash')}Clear</button>` : '');
  actions.querySelector('#logo-act-upload').onclick = () => document.getElementById('logo-file-input').click();
  const cropBtn = actions.querySelector('#logo-act-crop');
  if (cropBtn) cropBtn.onclick = () => _startLogoCrop(parish.logo_path);
  const clearBtn = actions.querySelector('#logo-act-clear');
  if (clearBtn) clearBtn.onclick = _clearParishLogo;

  document.getElementById('logo-backdrop').classList.add('open');
};

window.closeParishLogoEditor = function() {
  document.getElementById('logo-backdrop').classList.remove('open');
  const input = document.getElementById('logo-file-input');
  if (input) input.value = '';
  _logo.img = null;
};

function _showLogoPane(which) {
  document.getElementById('logo-pane-choose').hidden = which !== 'choose';
  document.getElementById('logo-pane-crop').hidden = which !== 'crop';
}

function _wireLogoEditor() {
  if (_logo.wired) return;
  _logo.wired = true;

  document.getElementById('logo-file-input').addEventListener('change', e => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    // An SVG is already the right thing: resolution-independent, tiny, and
    // rasterising it into a 512px PNG to crop would be a downgrade. Send it
    // as-is and skip the cropper.
    if (file.type === 'image/svg+xml') { _uploadParishLogo(file, file.type); return; }
    _startLogoCrop(URL.createObjectURL(file));
  });

  document.getElementById('logo-zoom').addEventListener('input', e => {
    _setLogoZoom(Number(e.target.value) / 100);
  });

  const stage = document.getElementById('logo-crop-stage');
  const down = (x, y) => { _logo.dragging = true; _logo.lastX = x; _logo.lastY = y; };
  const move = (x, y) => {
    if (!_logo.dragging) return;
    _logo.offsetX += x - _logo.lastX;
    _logo.offsetY += y - _logo.lastY;
    _logo.lastX = x;
    _logo.lastY = y;
    _clampLogoOffset();
    _drawLogoCrop();
  };
  const up = () => { _logo.dragging = false; };

  stage.addEventListener('pointerdown', e => { stage.setPointerCapture(e.pointerId); down(e.clientX, e.clientY); });
  stage.addEventListener('pointermove', e => { if (_logo.dragging) { e.preventDefault(); move(e.clientX, e.clientY); } });
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
}

function _startLogoCrop(src) {
  const img = new Image();
  // Same-origin for a stored /logos/... path and a blob: URL alike, so the
  // canvas stays untainted and toBlob works. crossOrigin is set anyway so a
  // logo ever served from another host fails loudly here rather than at
  // export time with a SecurityError.
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    _logo.img = img;
    _showLogoPane('crop');
    // Stage size is only knowable once the pane is visible.
    const stage = document.getElementById('logo-crop-stage');
    const side = Math.round(stage.getBoundingClientRect().width);
    _logo.stage = side;
    const canvas = document.getElementById('logo-crop-canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = side * dpr;
    canvas.height = side * dpr;
    canvas.style.width = side + 'px';
    canvas.style.height = side + 'px';
    // Cover, not contain: the crop circle should never open onto empty
    // canvas, so the smaller dimension is the one that fills the stage.
    _logo.fitScale = Math.max(side / img.naturalWidth, side / img.naturalHeight);
    document.getElementById('logo-zoom').value = 100;
    _setLogoZoom(1, { centre: true });
  };
  img.onerror = () => alert('Could not load that image.');
  img.src = src;
}

function _setLogoZoom(zoom, opts = {}) {
  if (!_logo.img) return;
  const side = _logo.stage;
  const prev = _logo.scale || _logo.fitScale;
  const next = _logo.fitScale * zoom;
  if (opts.centre) {
    _logo.scale = next;
    _logo.offsetX = (side - _logo.img.naturalWidth * next) / 2;
    _logo.offsetY = (side - _logo.img.naturalHeight * next) / 2;
  } else {
    // Zoom about the stage centre, so the part of the image the user is
    // looking at is the part that stays put.
    const cx = (side / 2 - _logo.offsetX) / prev;
    const cy = (side / 2 - _logo.offsetY) / prev;
    _logo.scale = next;
    _logo.offsetX = side / 2 - cx * next;
    _logo.offsetY = side / 2 - cy * next;
  }
  _clampLogoOffset();
  _drawLogoCrop();
}

// Keep the image covering the stage on both axes — panning should never be
// able to drag a transparent edge into the crop circle.
function _clampLogoOffset() {
  if (!_logo.img) return;
  const side = _logo.stage;
  const w = _logo.img.naturalWidth * _logo.scale;
  const h = _logo.img.naturalHeight * _logo.scale;
  _logo.offsetX = Math.min(0, Math.max(side - w, _logo.offsetX));
  _logo.offsetY = Math.min(0, Math.max(side - h, _logo.offsetY));
}

function _drawLogoCrop() {
  const canvas = document.getElementById('logo-crop-canvas');
  const ctx = canvas.getContext('2d');
  const dpr = canvas.width / _logo.stage;
  ctx.save();
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, _logo.stage, _logo.stage);
  ctx.drawImage(
    _logo.img,
    _logo.offsetX, _logo.offsetY,
    _logo.img.naturalWidth * _logo.scale,
    _logo.img.naturalHeight * _logo.scale
  );
  ctx.restore();
}

window.saveParishLogoCrop = async function() {
  if (!_logo.img) return;
  const out = document.createElement('canvas');
  out.width = LOGO_EXPORT_SIZE;
  out.height = LOGO_EXPORT_SIZE;
  const ctx = out.getContext('2d');
  // The stage is the crop: same framing, scaled up to the export size.
  const k = LOGO_EXPORT_SIZE / _logo.stage;
  ctx.drawImage(
    _logo.img,
    _logo.offsetX * k, _logo.offsetY * k,
    _logo.img.naturalWidth * _logo.scale * k,
    _logo.img.naturalHeight * _logo.scale * k
  );
  // Square, not circular: every surface that shows a logo already rounds it
  // (border-radius in the sheet, an arc clip on the map sprite). Baking the
  // circle in would only lose the corners for whatever renders it flat.
  const blob = await new Promise(r => out.toBlob(r, 'image/png'));
  if (!blob) { alert('Could not render the crop.'); return; }
  await _uploadParishLogo(blob, 'image/png');
};

async function _uploadParishLogo(body, contentType) {
  const id = _logo.parishId;
  const btn = document.getElementById('logo-crop-save');
  if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
  const res = await fetch(`/api/admin/parishes/${encodeURIComponent(id)}/logo`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body,
  });
  if (btn) { btn.disabled = false; btn.textContent = 'Save logo'; }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Logo upload failed');
    return;
  }
  const { logo_path } = await res.json();
  _applyParishLogo(id, logo_path);
}

async function _clearParishLogo() {
  const id = _logo.parishId;
  if (!confirm('Remove this parish’s logo?')) return;
  const res = await fetch(`/api/admin/parishes/${encodeURIComponent(id)}/logo`, { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Could not clear the logo');
    return;
  }
  _applyParishLogo(id, null);
}

// One place to land a logo change: state, the map's baked sprite, and the
// open sheet. The sheet re-render is a full one because the avatar lives in
// the header, which the partial refresh deliberately leaves alone.
function _applyParishLogo(id, logoPath) {
  const idx = state.parishes.findIndex(p => p.id === id);
  if (idx !== -1) state.parishes[idx] = { ...state.parishes[idx], logo_path: logoPath };
  if (typeof window.agoraRefreshParishLogo === 'function') window.agoraRefreshParishLogo(id);
  closeParishLogoEditor();
  if (state.parishSheetFocus === id) {
    renderParishSheetContent(id, { fullRender: true });
    // The header rebuild dropped the pencil; put it back if the form the
    // user opened it from is still showing.
    const form = document.getElementById(`ps-edit-form-${id}`);
    const avatar = document.querySelector('#parish-sheet-content .ps-avatar[data-logo-edit]');
    if (form && avatar && form.style.display !== 'none') avatar.classList.add('editing');
  }
  scheduleRenderEvents();
}

let _escalatePubEventId = null;
let _escalatePubCandidates = [];
let _escalatePubCurrentReplacedIds = new Set();

function _renderPubEscalateEventList() {
  const checked = new Set([...document.querySelectorAll('#escalate-pub-parishes input:checked')].map(cb => cb.value));
  const evtList = document.getElementById('escalate-pub-events');
  const visible = _escalatePubCandidates.filter(e => checked.has(e.parish_id));
  if (!checked.size) {
    evtList.innerHTML = '<div class="escalate-empty">Select parishes above to see replaceable events</div>';
    return;
  }
  if (!visible.length) {
    evtList.innerHTML = '<div class="escalate-empty">No events at selected parishes on this date</div>';
    return;
  }
  const fmt = dt => new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(dt));
  evtList.innerHTML = visible.map(e => {
    const pre = _escalatePubCurrentReplacedIds.has(e.id);
    const label = document.createElement('label');
    label.className = 'escalate-item';
    label.innerHTML = `<input type="checkbox" value="${e.id}"${pre ? ' checked' : ''}><span class="escalate-item-label">${esc(e.title)}<small>${fmt(e.start_utc)} \xb7 ${esc(e.parish_name)}</small></span>`;
    return label.outerHTML;
  }).join('');
}

window.openPublicEscalateModal = function(id) {
  const evt = state.events.find(e => e.id === id);
  if (!evt) return;
  _escalatePubEventId = id;
  _escalatePubCandidates = [];
  _escalatePubCurrentReplacedIds = new Set();
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(evt.start_utc));

  document.getElementById('escalate-pub-sub').textContent = `"${evt.title}" — ${date}`;

  const parishList = document.getElementById('escalate-pub-parishes');
  const homeJurisdiction = evt.jurisdiction || '';
  const ownParish = state.parishes.find(p => p.id === evt.parish_id);
  const others = state.parishes.filter(p => p.id !== evt.parish_id && p.id !== '_unassigned').sort((a, b) => {
    const ah = a.jurisdiction === homeJurisdiction ? 0 : 1;
    const bh = b.jurisdiction === homeJurisdiction ? 0 : 1;
    return ah - bh || a.jurisdiction.localeCompare(b.jurisdiction) || a.name.localeCompare(b.name);
  });
  const allParishes = ownParish ? [{ ...ownParish, _isOwn: true }, ...others] : others;
  parishList.innerHTML = allParishes.length
    ? allParishes.map(p => {
        const label = document.createElement('label');
        label.className = 'escalate-item';
        const ownAttr = p._isOwn ? ' checked data-own="1"' : '';
        const ownTag = p._isOwn ? '<em class="own-tag">own</em>' : '';
        label.innerHTML = `<input type="checkbox" value="${esc(p.id)}"${ownAttr} onchange="_renderPubEscalateEventList()"><span class="escalate-item-label">${esc(p.name)}${ownTag}<small>${esc(p.jurisdiction)}</small></span>`;
        return label.outerHTML;
      }).join('')
    : '<div class="escalate-empty">No parishes</div>';

  document.getElementById('escalate-pub-events').innerHTML = '<div class="escalate-empty">Loading…</div>';

  Promise.all([
    fetch(`/api/admin/events/candidates?date=${encodeURIComponent(date)}&exclude_id=${id}`).then(r => r.json()),
    fetch(`/api/admin/events/${id}/escalation`).then(r => r.json()),
  ]).then(([candidates, current]) => {
    // Merge currently-replaced events into candidates so they remain visible
    const candidateIds = new Set(candidates.map(e => e.id));
    const merged = [...candidates, ...current.replaced_events.filter(e => !candidateIds.has(e.id))];
    _escalatePubCandidates = merged;
    _escalatePubCurrentReplacedIds = new Set(current.replaced_events.map(e => e.id));

    // Pre-check parishes from current escalation state
    for (const pid of current.additive_parish_ids) {
      const cb = parishList.querySelector(`input[value="${CSS.escape(pid)}"]`);
      if (cb) cb.checked = true;
    }
    _renderPubEscalateEventList();
  }).catch(() => {
    document.getElementById('escalate-pub-events').innerHTML = '<div class="escalate-empty">Failed to load</div>';
  });

  document.getElementById('escalate-backdrop').classList.add('open');
};

window.closePublicEscalateModal = function() {
  document.getElementById('escalate-backdrop').classList.remove('open');
  _escalatePubEventId = null;
};

// ── Donate parish-picker dialog ──
// Opened by the /donate and /<juris>/donate deep links (and as a fallback when a
// /<acronym>/donate slug reaches the SPA because no link is on file). Lists every
// parish that has a donation_url; each row links straight out to that page.
let _donateJurisFilter = '';

function _renderDonateList() {
  const listEl = document.getElementById('donate-list');
  if (!listEl) return;
  let donors = (state.parishes || []).filter(p => p.id !== '_unassigned' && p.donation_url);
  if (_donateJurisFilter) donors = donors.filter(p => p.jurisdiction === _donateJurisFilter);
  donors.sort((a, b) => a.jurisdiction.localeCompare(b.jurisdiction) || a.name.localeCompare(b.name));
  listEl.innerHTML = donors.length
    ? donors.map(p => `
        <a class="donate-item" href="${esc(p.donation_url)}" target="_blank" rel="noopener">
          <span class="donate-item-dot" style="background:${esc(getParishDisplayColor(p.color || '#666'))}"></span>
          <span class="donate-item-label">${esc(p.name)}<small>${esc(capitalize(p.jurisdiction))} Orthodox</small></span>
          <img class="donate-item-arrow" src="https://api.iconify.design/ph:arrow-up-right.svg" alt="">
        </a>`).join('')
    : `<div class="escalate-empty">No parishes with donation links yet${_donateJurisFilter ? ' in this jurisdiction' : ''}.</div>`;
}

window._onDonateJurisChange = function(v) {
  _donateJurisFilter = v || '';
  _renderDonateList();
};

function _donateEsc(e) { if (e.key === 'Escape') closeDonateDialog(); }

window.openDonateDialog = function(preselectJuris = null) {
  const backdrop = document.getElementById('donate-backdrop');
  if (!backdrop) return;
  const donors = (state.parishes || []).filter(p => p.id !== '_unassigned' && p.donation_url);
  const jurisSet = [...new Set(donors.map(p => p.jurisdiction))].sort();
  // Only honour the preselected jurisdiction if a donor parish actually has it,
  // otherwise the filtered list would render empty for no obvious reason.
  _donateJurisFilter = (preselectJuris && jurisSet.includes(preselectJuris)) ? preselectJuris : '';
  const sel = document.getElementById('donate-juris-filter');
  if (sel) {
    sel.innerHTML = `<option value="">All jurisdictions</option>` +
      jurisSet.map(j => `<option value="${esc(j)}"${j === _donateJurisFilter ? ' selected' : ''}>${esc(capitalize(j))} Orthodox</option>`).join('');
    sel.style.display = jurisSet.length > 1 ? '' : 'none';
  }
  _renderDonateList();
  backdrop.classList.add('open');
  document.addEventListener('keydown', _donateEsc);
};

window.closeDonateDialog = function() {
  const backdrop = document.getElementById('donate-backdrop');
  if (backdrop) backdrop.classList.remove('open');
  document.removeEventListener('keydown', _donateEsc);
};

window.confirmPublicEscalate = async function() {
  if (!_escalatePubEventId) return;
  const additive_parish_ids = [...document.querySelectorAll('#escalate-pub-parishes input:checked:not([data-own])')].map(cb => cb.value);
  // Keep ids as strings: a candidate may be a one-off (integer) or a schedule
  // instance (synthetic "sid:date"). The backend classifies each.
  const replaced_event_ids = [...document.querySelectorAll('#escalate-pub-events input:checked')].map(cb => cb.value);
  const btn = document.getElementById('escalate-pub-confirm');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/admin/events/${_escalatePubEventId}/escalate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ additive_parish_ids, replaced_event_ids })
    });
    if (res.ok) {
      closePublicEscalateModal();
      closeDetail();
      fetchEvents();
    }
  } finally {
    btn.disabled = false;
  }
};

function initPosterZoom(img) {
  let scale = 1;
  let tx = 0, ty = 0;          // current translate
  let zooming = false;          // two-finger pinch active
  let panning = false;          // one-finger pan active
  let startDist = 0, startScale = 1, startTx = 0, startTy = 0;
  let focalX = 0, focalY = 0;
  let panStartX = 0, panStartY = 0, panStartTx = 0, panStartTy = 0;
  const EXIT_THRESHOLD = 1.25;

  function dist(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.hypot(dx, dy);
  }

  function clamp(val, max) { return Math.min(max, Math.max(-max, val)); }

  function maxTranslate() {
    // How far the image can move before an edge comes into view
    const w = img.offsetWidth, h = img.offsetHeight;
    return { x: w * (scale - 1) / 2, y: h * (scale - 1) / 2 };
  }

  function applyTransform(transition = false) {
    img.style.transition = transition ? 'transform 0.25s ease' : 'none';
    img.style.transform = `scale(${scale}) translate(${tx / scale}px, ${ty / scale}px)`;
  }

  function snapBack() {
    scale = 1; tx = 0; ty = 0;
    applyTransform(true);
  }

  img.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      zooming = true;
      panning = false;
      startDist = dist(e.touches);
      startScale = scale;
      startTx = tx;
      startTy = ty;
      // Focal point: pinch midpoint relative to the image's *layout* centre.
      // getBoundingClientRect() reflects the current transform (including tx/ty),
      // so we subtract startTx/startTy to recover the untransformed centre.
      const rect = img.getBoundingClientRect();
      const layoutCx = rect.left + rect.width / 2 - tx;
      const layoutCy = rect.top + rect.height / 2 - ty;
      focalX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - layoutCx;
      focalY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - layoutCy;
      e.preventDefault();
    } else if (e.touches.length === 1 && scale > 1) {
      panning = true;
      panStartX = e.touches[0].clientX;
      panStartY = e.touches[0].clientY;
      panStartTx = tx;
      panStartTy = ty;
      e.preventDefault();
    }
  }, { passive: false });

  img.addEventListener('touchmove', e => {
    if (zooming && e.touches.length === 2) {
      e.preventDefault();
      const newScale = Math.max(1, Math.min(5, startScale * (dist(e.touches) / startDist)));
      const ratio = newScale / startScale;
      // Shift translate so the focal point stays pinned on screen
      const rawTx = focalX + (startTx - focalX) * ratio;
      const rawTy = focalY + (startTy - focalY) * ratio;
      scale = newScale;
      const m = maxTranslate();
      tx = clamp(rawTx, m.x);
      ty = clamp(rawTy, m.y);
      applyTransform();
    } else if (panning && e.touches.length === 1) {
      e.preventDefault();
      const m = maxTranslate();
      tx = clamp(panStartTx + (e.touches[0].clientX - panStartX), m.x);
      ty = clamp(panStartTy + (e.touches[0].clientY - panStartY), m.y);
      applyTransform();
    }
  }, { passive: false });

  img.addEventListener('touchend', e => {
    if (zooming && e.touches.length < 2) {
      zooming = false;
      if (scale < EXIT_THRESHOLD) snapBack();
    }
    if (panning && e.touches.length === 0) {
      panning = false;
    }
  });
}

function closeDetailDOM() {
  // Legacy modal path (parish detail still uses #event-detail + backdrop).
  const panel = document.getElementById('event-detail');
  if (panel && !panel.classList.contains('hidden')) {
    panel.classList.add('hidden');
    const backdrop = document.querySelector('.detail-backdrop');
    if (backdrop) backdrop.remove();
  }
  // Inline drawer path (event detail lives inside the expanded card).
  collapseEventCardDOM();
  delete state._openEventId;
}

// Close from UI — clears state._openEventId and pushes the URL without the ID.
// Filters/mode are untouched so nothing else needs to re-sync. Browser back
// while detail is open still goes through the popstate reconciler (URL already
// reverted by the browser), which detects the missing ID and closes the panel.
function closeDetail() {
  if (detailHistoryPushed) {
    // Legacy parish-detail modal path
    detailHistoryPushed = false;
    history.back();
    return;
  }
  // Pinned parish-sheet drawer: tearing down the event should leave the
  // parish sheet on its default state — no pinned slot, event back in
  // the events stream below, URL at /<acronym>. Also collapse any copy
  // of the same card expanded in the main list (hidden behind the sheet)
  // so it doesn't re-appear when the sheet closes.
  const pinned = document.querySelector('.ps-pinned-event .event-card.expanded');
  if (pinned && state.parishSheetFocus && typeof renderParishSheetContent === 'function') {
    const pid = state.parishSheetFocus;
    delete state._openEventId;
    collapseEventCardDOM();
    syncURL();
    renderParishSheetContent(pid, {});
    return;
  }
  closeDetailDOM();
  syncURL();
}

document.getElementById('close-detail').addEventListener('click', closeDetail);

// ── Detail panel swipe-to-dismiss ──
(function initDetailSwipeDismiss() {
  const panel = document.getElementById('event-detail');
  let startX = 0, startY = 0, dx = 0, swiping = false, decided = false;

  panel.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    dx = 0;
    swiping = false;
    decided = false;
  }, { passive: true });

  panel.addEventListener('touchmove', e => {
    if (e.touches.length !== 1) return;
    const cx = e.touches[0].clientX;
    const cy = e.touches[0].clientY;
    const rawDx = cx - startX;
    const rawDy = cy - startY;

    if (!decided) {
      if (Math.abs(rawDx) < 8 && Math.abs(rawDy) < 8) return;
      // Vertical gesture → scroll, don't swipe
      if (Math.abs(rawDy) > Math.abs(rawDx)) { decided = true; return; }
      // Only right swipe dismisses
      if (rawDx < 0) { decided = true; return; }
      swiping = true;
      decided = true;
      panel.classList.add('dragging');
    }

    if (!swiping) return;
    if (e.cancelable) e.preventDefault();
    dx = Math.max(0, rawDx);
    panel.style.transform = `translateX(${dx}px)`;
    const backdrop = document.querySelector('.detail-backdrop');
    if (backdrop) backdrop.style.opacity = Math.max(0, 1 - dx / 300);
  }, { passive: false });

  panel.addEventListener('touchend', () => {
    if (!swiping) return;
    swiping = false;
    decided = false;
    panel.classList.remove('dragging');

    if (dx > 80) {
      // Dismiss
      panel.style.transition = 'transform 0.25s cubic-bezier(0.4,0,1,1)';
      panel.style.transform = 'translateX(100%)';
      const backdrop = document.querySelector('.detail-backdrop');
      if (backdrop) backdrop.style.transition = 'opacity 0.25s ease';
      if (backdrop) backdrop.style.opacity = '0';
      setTimeout(() => {
        panel.style.transition = '';
        panel.style.transform = '';
        if (backdrop) { backdrop.style.transition = ''; backdrop.style.opacity = ''; }
        closeDetail();
      }, 250);
    } else {
      // Spring back
      panel.style.transition = 'transform 0.3s cubic-bezier(0.2,0,0,1)';
      panel.style.transform = 'translateX(0)';
      const backdrop = document.querySelector('.detail-backdrop');
      if (backdrop) { backdrop.style.transition = 'opacity 0.3s ease'; backdrop.style.opacity = ''; }
      setTimeout(() => { panel.style.transition = ''; }, 300);
    }
  }, { passive: true });
})();

// ── Fullscreen poster lightbox ──
function openPosterFullscreen(src) {
  const el = document.getElementById('poster-fullscreen');
  const img = document.getElementById('poster-fullscreen-img');
  const dlBtn = document.getElementById('poster-download');
  img.src = src;
  dlBtn.href = src;
  dlBtn.download = src.split('/').pop();
  el.classList.toggle('poster-fullscreen--light', /\.pdf$/i.test(src));
  el.classList.remove('hidden');
  // Trigger open animation on next frame
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add('open'));
  });
  history.pushState({ poster: true }, '');
  posterHistoryPushed = true;
  initPosterZoom(img);
  initPosterSwipeDismiss(el, img);
}

function closePosterFullscreenDOM() {
  const el = document.getElementById('poster-fullscreen');
  el.classList.remove('open');
  // Wait for transition then hide
  el.addEventListener('transitionend', () => el.classList.add('hidden'), { once: true });
}

function closePosterFullscreen() {
  closePosterFullscreenDOM();
  if (posterHistoryPushed) {
    posterHistoryPushed = false;
    history.back();
  }
}

function initPosterSwipeDismiss(overlay, img) {
  let startY = 0, currentDY = 0, dragging = false;

  // Only handle swipe when not zoomed in
  overlay.addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    // Check if img is zoomed (has a non-identity transform)
    const t = img.style.transform;
    if (t && t !== 'none' && !t.includes('scale(1)') && t !== '') {
      const m = t.match(/scale\(([^)]+)\)/);
      if (m && parseFloat(m[1]) > 1.05) return; // zoomed in — don't drag dismiss
    }
    startY = e.touches[0].clientY;
    currentDY = 0;
    dragging = true;
  }, { passive: true });

  overlay.addEventListener('touchmove', e => {
    if (!dragging || e.touches.length !== 1) return;
    const dy = e.touches[0].clientY - startY;
    if (dy < 0) return; // don't allow upward drag
    currentDY = dy;
    overlay.style.transition = 'none';
    overlay.style.transform = `translateY(${dy}px) scale(${1 - dy * 0.0003})`;
    const alpha = Math.max(0, 0.96 * (1 - dy / 280));
    overlay.style.background = `rgba(0,0,0,${alpha})`;
  }, { passive: true });

  overlay.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    if (currentDY > 80) {
      // Dismiss
      overlay.style.transition = 'transform 0.28s cubic-bezier(0.4,0,1,1), opacity 0.28s ease, background 0.28s ease';
      overlay.style.transform = `translateY(100vh)`;
      overlay.style.opacity = '0';
      setTimeout(() => {
        overlay.style.transform = '';
        overlay.style.opacity = '';
        overlay.style.background = '';
        overlay.style.transition = '';
        closePosterFullscreen();
      }, 280);
    } else {
      // Spring back
      overlay.style.transition = 'transform 0.35s cubic-bezier(0.2,0,0,1), background 0.35s ease';
      overlay.style.transform = '';
      overlay.style.background = '';
    }
  });
}

// ── Helpers ──

function capFutureAtCount(future, cap) {
  if (cap <= 0) return { visible: [], deferredCount: future.length };
  if (future.length <= cap) return { visible: future, deferredCount: 0 };
  const groups = groupByDay(future);
  let count = 0;
  let cutoffKey = null;
  for (const [dk, evts] of groups) {
    count += evts.length;
    if (count >= cap && cutoffKey === null) cutoffKey = dk;
  }
  const visible = [], deferred = [];
  let pastCutoff = false;
  for (const [dk, evts] of groups) {
    if (pastCutoff) deferred.push(...evts);
    else visible.push(...evts);
    if (dk === cutoffKey) pastCutoff = true;
  }
  return { visible, deferredCount: deferred.length };
}
function groupByDay(events) {
  const groups = new Map();
  for (const evt of events) {
    const d = new Date(evt.start_utc);
    const key = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(evt);
  }
  return groups;
}

function parseLocalDate(utcStr) { return new Date(utcStr); }

/**
 * "3 months ago" — how old a published claim is, in words.
 *
 * Coarse on purpose. The question a reader is asking is "might this have
 * changed since?", and to that question "3 months ago" and "94 days ago" are
 * the same answer while the second one pretends to a precision the source does
 * not have. Intl does the pluralising, so "1 month ago" never reads "1 months".
 */
function relativeAge(iso, now = Date.now()) {
  const then = Date.parse(iso || '');
  if (!Number.isFinite(then)) return null;
  const days = Math.floor((now - then) / 86400000);
  if (days < 0) return 'just now';          // a source dated in the future
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  const [value, unit] = days < 30 ? [days, 'day']
    : days < 365 ? [Math.round(days / 30.44), 'month']
      : [Math.round(days / 365.25), 'year'];
  try {
    return new Intl.RelativeTimeFormat('en', { numeric: 'always' }).format(-value, unit);
  } catch {
    return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
  }
}

/**
 * Where a parish's service times came from, and how old that is.
 *
 * Renders "Updated 3 months ago • Antiochian Archdiocese ↗" under the
 * timetable. A recurrence rule is a claim about the FUTURE and never expires on
 * its own — "Sundays 9am" keeps projecting cards forever and looks exactly as
 * current on the day the parish changes its times as it did the day it was
 * entered. This line is the only thing on the page that says how old it is.
 *
 * The age is how long since WE READ the source, not since the source changed.
 * It is the weaker claim and the honest one: it speaks to freshness, not to
 * whether the times are still right.
 *
 * Grouped by source rather than printed per rule: they almost always share one,
 * and twenty identical lines would say less than one does. Rules with no source
 * contribute nothing, which is honest — Ryde's Saturday Vespers and Good
 * Shepherd's Confession were entered by hand and nobody recorded from where.
 */
function scheduleSourceHTML(items) {
  const bySource = new Map();
  for (const s of items) {
    if (!s.source_name) continue;
    const key = `${s.source_name}|${s.source_ref || ''}|${s.source_checked_at || ''}`;
    if (!bySource.has(key)) {
      bySource.set(key, { name: s.source_name, ref: s.source_ref || '', checked: s.source_checked_at || '' });
    }
  }
  if (!bySource.size) return '';
  // A span, not an img: the icon is painted by a CSS mask over `currentColor`
  // so it follows the line's muted colour and its hover state. An <img> would
  // paint its own black pixels over the mask and stay black in dark mode.
  const icon = '<span class="sched-source-icon" aria-hidden="true"></span>';
  return [...bySource.values()].map(({ name, ref, checked }) => {
    const age = relativeAge(checked);
    // The name is the readable half and the ref the checkable half, so the name
    // is what links — and only when the ref is actually a URL, since a source
    // can be a person or a file path and those must not render as dead links.
    const label = /^https?:/.test(ref)
      ? `<a href="${esc(ref)}" target="_blank" rel="noopener">${esc(name)}${icon}</a>`
      : esc(name);
    return `<div class="sched-source">${age ? `Updated ${esc(age)} &middot; ` : ''}${label}</div>`;
  }).join('');
}

function formatTime12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  const mm = String(m).padStart(2, '0');
  // Always :00 minutes + small-caps AM/PM marker consumed by CSS.
  return `${h12}:${mm}<span class="ampm">${ampm}</span>`;
}

function utcToLocalInput(utcStr) {
  if (!utcStr) return '';
  const d = new Date(utcStr);
  const local = new Date(d.toLocaleString('en-US', { timeZone: TZ }));
  const pad = n => String(n).padStart(2, '0');
  return `${local.getFullYear()}-${pad(local.getMonth()+1)}-${pad(local.getDate())}T${pad(local.getHours())}:${pad(local.getMinutes())}`;
}

function localInputToUtc(localStr) {
  if (!localStr) return null;
  const d = new Date(localStr + 'Z');
  const year = d.getUTCFullYear();
  function firstSunday(y, m) { const dt = new Date(Date.UTC(y, m, 1)); return 1 + (7 - dt.getUTCDay()) % 7; }
  const dstStart = new Date(Date.UTC(year, 9, firstSunday(year, 9), 2, 0, 0));
  const dstEnd = new Date(Date.UTC(year, 3, firstSunday(year, 3), 3, 0, 0));
  const offset = (d >= dstEnd && d < dstStart) ? 10 : 11;
  return new Date(d.getTime() - offset * 3600000).toISOString();
}

function parseLangs(val) {
  if (!val) return null;
  try { const arr = JSON.parse(val); return arr.length ? arr : null; } catch { return null; }
}

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// Live availability hint under the acronym field. Two ways an acronym fails:
// it spells a reserved link (/greek, /qld, /services), or another parish
// already answers to it. Both are checked again in the Worker on save — see
// acronymConflict there; this only shortens the feedback loop.
// Schedule rows, wherever they are rendered — the parish sheet, the main
// services panel, the parish-schedule blocks inside it. One delegated
// listener rather than a wiring pass per render, since every one of those
// panels rebuilds its HTML on any filter change.
function initScheduleRowTaps() {
  const activate = (e) => {
    const row = e.target.closest('[data-sched-focus]');
    if (!row) return;
    // The admin ✎ and its form live inside the row and own their own taps.
    if (e.target.closest('.schedule-edit-btn, .schedule-edit-form')) return;
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    const sid = Number(row.dataset.schedFocus);
    const pid = row.dataset.schedParish
      || row.closest('[data-parish-id]')?.dataset.parishId
      || state.parishSheetFocus;
    if (!pid || !Number.isFinite(sid)) return;
    // Tapping the focused row again is the third way out, alongside the
    // banner's X and the pinned card's.
    if (state.parishScheduleFocus && state.parishScheduleFocus.scheduleId === sid) {
      clearParishScheduleFocus();
      return;
    }
    focusScheduleRule(pid, sid);
  };
  document.addEventListener('click', activate);
  document.addEventListener('keydown', activate);
}

function wireAcronymHint(root, parishId) {
  const input = root.querySelector('[data-acronym-field]');
  const hint = root.querySelector('[data-acronym-hint]');
  if (!input || !hint || !window.AgoraSlugs) return;
  const { normaliseSlug, reservedSlugReason } = window.AgoraSlugs;
  const paint = () => {
    const slug = normaliseSlug(input.value);
    let problem = reservedSlugReason(slug);
    if (!problem && slug) {
      const clash = state.parishes.find(p =>
        p.id !== parishId && p.id !== '_unassigned' && normaliseSlug(p.acronym) === slug);
      if (clash) problem = `"${slug}" is already the acronym for ${clash.name}.`;
    }
    hint.classList.toggle('edit-row-hint-bad', !!problem);
    hint.textContent = problem
      || (slug ? `The parish's short link: orthodoxy.au/${slug}` : "The parish's short link.");
  };
  input.addEventListener('input', paint);
  paint();
}

// An Iconify glyph that follows its button's text colour. The <img>+invert
// pattern the public action pills use is fine while a glyph is only ever
// black or white; it cannot follow a pill that is red at rest and white on
// hover, which the admin row needs. .ps-btn-glyph masks currentColor, so
// one element covers every state in both schemes. See app.css.
function glyph(name) {
  return `<span class="ps-btn-glyph" style="--glyph:url(https://api.iconify.design/${esc(name)}.svg)" aria-hidden="true"></span>`;
}

// The show/hide toggle is rendered in two places (parish sheet, event
// drawer) and relabelled in a third (toggleAdminControlsVisibility), so the
// label and glyph live here rather than in three literals that can drift.
// The label is its own span because the button now has a glyph child that a
// textContent assignment would wipe out.
function adminVisibilityPill(hiding, extraClass) {
  return `<button class="${extraClass} btn-admin-controls-pill" type="button" onclick="toggleAdminControlsVisibility()">`
    + glyph(hiding ? 'ph:eye' : 'ph:eye-slash')
    + `<span class="btn-admin-controls-label">${hiding ? 'Show admin controls' : 'Hide admin controls'}</span></button>`;
}

// Returns a readable schedule-item label for week_of_month, e.g. "1st, 3rd Sunday"
function womDisplayLabel(qualifier, dayName) {
  if (!qualifier) return '';
  const map = { first: '1st', second: '2nd', third: '3rd', fourth: '4th', last: 'last' };
  const parts = qualifier.split(',').map(q => map[q.trim()] || q.trim()).join(', ');
  return `<span class="schedule-item-wom">${esc(parts)} ${esc(dayName)}</span>`;
}

// Expose for filters/map
window.agoraState = state;
window.agoraFetchEvents = fetchEvents;
window.agoraFetchSchedules = fetchSchedules;
window.showParishDetail = showParishDetail;
