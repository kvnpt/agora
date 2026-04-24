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
  userLat: -33.8688,
  userLng: 151.2093,
  mode: 'events',
  filters: { jurisdiction: null, type: '', parishIds: null, socialOnly: false, englishOnly: false, englishStrict: false, showAllParishes: null, multiParish: false },
  subdomainJurisdiction: null,
  locationActive: false,  // true once we have coords (set by either Near pill or Nearby sort)
  nearPillActive: false,  // true when Near pill is toggled on (sorts parish pills)
  eventsSort: 'time',  // 'time' | 'nearby'
  parishFocus: null,  // parish ID when focused, null when browsing
  viewportParishIds: null  // Set of parish IDs inside current map bounds; null until first moveend
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
  state.filters.multiParish = loadMultiParishPref();
  detectUrlState();
  disablePageZoom();
  disablePullToRefresh();
  loadCachedLocation();
  if (window.lsProgress) window.lsProgress(0.15);
  await Promise.all([fetchParishes(), checkAdmin()]);
  _initLogout();
  applyParishSlugs();
  initFilters(state);
  initModeBar();
  initBottomSheet();
  initParishSheet();
  initParishFilter();
  initSocialFilter();
  initEnglishFilter();
  initFiltersMenu();
  initMultiParishToggle();
  initResetFab();
  initLocationFab();
  initModeUrl();
  state._initialLoad = true;
  applyStartMode();
  updateArchdioceseEventsBanner();
  if (window.lsLog) window.lsLog('Initialising Leaflet map…');
  initMap(state);
  updateMap(state);
  if (window.lsLog) window.lsLog('✓ map ready');
  if (window.lsProgress) window.lsProgress(0.9);

  // If the URL named a single parish (e.g. /gosr), open the parish sheet so
  // deep links and refreshes land on the parish card instead of just
  // filtering the main list. Defer past initMap's invalidateSize (100ms) so
  // the pan/zoom inside openParishSheet reads a real container size.
  if (state.parishFocus && state.parishSheetFocus !== state.parishFocus) {
    const focusPid = state.parishFocus;
    setTimeout(() => {
      if (window.agoraMap) window.agoraMap.invalidateSize();
      openParishSheet(focusPid, { replaceUrl: true });
    }, 150);
  }

  // Re-render event cards every minute to keep LIVE countdowns current.
  // Skip when a drawer is open: re-render rebuilds the list HTML and would
  // wipe the user's in-drawer state (e.g. schedule toggled open).
  setInterval(() => {
    if (state.mode !== 'events') return;
    if (!state.events.some(e => e.parish_live_url)) return;
    if (document.querySelector('.event-card.expanded')) return;
    renderEvents();
  }, 60000);

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
    } else if (/^\d+$/.test(seg)) {
      state._openEventId = parseInt(seg, 10);
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
}

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
  if (state.mode === 'services' && !state.parishSheetFocus) segs.push('services');
  else if (state.filters.socialOnly) segs.push('social');
  const psfId = state.parishSheetFocus;
  const psfParish = psfId ? state.parishes.find(x => x.id === psfId) : null;
  if (psfParish && psfParish.acronym) {
    segs.push(psfParish.acronym.toLowerCase().replace(/\s+/g, ''));
  } else if (state.filters.parishIds && state.filters.parishIds.size) {
    const acrs = [...state.filters.parishIds].map(pid => {
      const p = state.parishes.find(x => x.id === pid);
      return p && p.acronym ? p.acronym.toLowerCase().replace(/\s+/g, '') : null;
    }).filter(Boolean);
    if (acrs.length === 1) segs.push(acrs[0]);
    else if (acrs.length > 1) segs.push(acrs.join('+'));
  }
  if (state.filters.englishOnly) {
    segs.push(state.filters.englishStrict ? 'en' : 'bilingual');
  }
  if (opts.includeEventId && state._openEventId) {
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

    // 2) Re-parse URL into state
    detectUrlState();
    applyParishSlugs();
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

    // 8) Refetch data (URL filter change → different result set)
    if (state.mode === 'services') window.agoraFetchSchedules();
    else window.agoraFetchEvents();

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
  window.agoraMap.setView([state.userLat, state.userLng], 13, { animate: true, duration: 0.9 });
}

// Recompute the set of parishes inside the current map bounds. Fired by
// map.js's debounced moveend hook; also seeded once at startup.
function recomputeViewportParishIds() {
  if (!window.agoraMap) return;
  const b = window.agoraMap.getBounds();
  const ids = new Set();
  for (const p of state.parishes) {
    if (!p || p.id === '_unassigned' || p.lat == null || p.lng == null) continue;
    if (b.contains([p.lat, p.lng])) ids.add(p.id);
  }
  state.viewportParishIds = ids;
  // Don't fit — the user just moved the map, we don't want to fight them.
  renderCurrentView();
  // Pills sort by viewport-centre distance; re-render so order tracks pan/zoom.
  renderParishPills();
}
window.agoraOnViewportChange = recomputeViewportParishIds;

// Find the nearest parish (to user or map centre) that satisfies a predicate.
// Used by the empty-state CTAs: "show nearest parish" = any parish;
// "find nearest matching" = one whose events survive the current filters.
function findNearestParishWhere(predicate) {
  const originLat = state.locationActive ? state.userLat
    : (window.agoraMap ? window.agoraMap.getCenter().lat : state.userLat);
  const originLng = state.locationActive ? state.userLng
    : (window.agoraMap ? window.agoraMap.getCenter().lng : state.userLng);
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

  const originLat = state.locationActive ? state.userLat
    : (window.agoraMap ? window.agoraMap.getCenter().lat : state.userLat);
  const originLng = state.locationActive ? state.userLng
    : (window.agoraMap ? window.agoraMap.getCenter().lng : state.userLng);
  if (window.agoraMap) {
    const bounds = L.latLngBounds([[originLat, originLng], [target.lat, target.lng]]).pad(0.25);
    window.agoraMap.fitBounds(bounds, { maxZoom: 13, animate: true, duration: 0.6 });
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
  const params = new URLSearchParams({
    lat: state.userLat,
    lng: state.userLng
  });
  if (state.filters.type) params.set('type', state.filters.type);
  if (state.filters.jurisdiction) params.set('jurisdiction', state.filters.jurisdiction);

  const now = new Date();
  // Include events from start of today (Sydney local) through 28 days out —
  // stream renders Today phase buckets at top, followed by day-grouped future.
  const sydneyDate = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [d, m, y] = sydneyDate.split('/');
  const todayStr = `${y}-${m}-${d}`;
  const startLocal = new Date(`${todayStr}T00:00:00`);
  const testDate = new Date(`${todayStr}T12:00:00Z`);
  const sydneyStr = testDate.toLocaleString('en-US', { timeZone: TZ });
  const sydneyParsed = new Date(sydneyStr);
  const offsetMs = sydneyParsed.getTime() - testDate.getTime();
  params.set('from', new Date(startLocal.getTime() - offsetMs).toISOString());
  params.set('to', new Date(now.getTime() + 28 * 86400000).toISOString());

  if (window.lsLog) window.lsLog('GET /api/events?from=…&to=+28d …');
  try {
    const res = await fetch(`/api/events?${params}`);
    state.events = await res.json();
  } catch {
    state.events = [];
  }
  if (window.lsLog) window.lsLog('✓ events loaded (' + state.events.length + ')');
  if (window.lsProgress) window.lsProgress(0.75);

  // Initial load: empty 28-day window → fall through to Services mode.
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

  renderEvents();
  updateMap(state, { fit: !!opts.fit });
}

async function fetchSchedules(opts = {}) {
  const params = new URLSearchParams();
  if (state.filters.jurisdiction) params.set('jurisdiction', state.filters.jurisdiction);
  if (window.lsLog) window.lsLog('GET /api/schedules …');
  try {
    const res = await fetch(`/api/schedules?${params}`);
    state.schedules = await res.json();
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
    const res = await fetch('/api/parishes');
    state.parishes = await res.json();
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
  // Ping the admin gate and also call whoami so phone-auth (magic link)
  // users get the Admin button + Logout even before the Caddyfile gate flips.
  const [pingRes, whoami] = await Promise.all([
    fetch('/api/admin/ping').catch(() => ({ ok: false })),
    fetch('/auth/whoami').then(r => r.json()).catch(() => ({ method: 'none' }))
  ]);
  state.isAdmin = pingRes.ok || whoami.method === 'phone';
  state.authMethod = whoami.method;

  if (state.isAdmin) {
    document.getElementById('btn-admin').hidden = false;
    document.querySelector('.fm-admin-sep').hidden = false;
  }
  if (whoami.method === 'phone') {
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
    el.textContent = hiding ? 'Hide admin controls' : 'Show admin controls';
  });
}

function _initLogout() {
  const btn = document.getElementById('btn-logout');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    await fetch('/auth/logout', { method: 'POST' });
    location.reload();
  });
}

// ── Mode bar ──
function initModeBar() {
  const eventsBtn = document.getElementById('btn-events');
  const servicesBtn = document.getElementById('btn-services');

  if (eventsBtn) {
    eventsBtn.addEventListener('click', () => {
      closeFiltersMenuAnim();
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
    syncURL();
  });
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
      const res = await fetch(`/api/events/${id}`);
      if (res.ok) evt = await res.json();
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
  const parishRow = document.getElementById('parish-filter-row');
  const pillsVisible = parishRow.classList.contains('visible');

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
  let relevant = state.parishes.filter(p => {
    if (p.id === '_unassigned') return false;
    if (state.filters.jurisdiction && p.jurisdiction !== state.filters.jurisdiction) return false;
    return true;
  });

  // Distance origin: viewport centre when map is ready, else user location.
  // Pill sort is viewport-driven, not FAB-driven — when the user centres on
  // their location the two coincide, but panning the map should re-sort pills.
  let originLat = null, originLng = null;
  if (window.agoraMap) {
    const c = window.agoraMap.getCenter();
    originLat = c.lat; originLng = c.lng;
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

  const allActive = state.filters.parishIds === null;

  let html = '';

  for (const p of relevant) {
    const acronym = p.acronym || p.name.split(',')[0].replace(/^(Sts?|Holy) /, '').substring(0, 8);
    const distLabel = (p._dist != null && isFinite(p._dist)) ? `\u00B7${Math.round(p._dist)}km` : '';
    const label = distLabel ? `${acronym}${distLabel}` : acronym;
    const isSelected = state.filters.parishIds && state.filters.parishIds.has(p.id);
    const isUnselected = state.filters.parishIds && !state.filters.parishIds.has(p.id);
    const color = p.color || '#000';
    let style;
    if (allActive) {
      // All active: colored outline, no fill
      style = `color:${color};border-color:${color};background:none;`;
    } else if (isSelected) {
      // Individually selected: full color fill
      style = `background:${color};color:#fff;border-color:transparent;`;
    } else {
      // Unselected: faded
      style = `color:var(--text-muted);border-color:var(--border-light);background:none;opacity:0.4;`;
    }
    const activeClass = (allActive || isSelected) ? 'active' : '';
    html += `<button class="parish-pill ${activeClass}" data-parish="${esc(p.id)}" data-color="${color}" style="${style}">${esc(label)}</button>`;
  }
  row.innerHTML = html;
  row.classList.toggle('multi-parish', !!state.filters.multiParish);
}

// Use event delegation on the row (set up once)
document.addEventListener('DOMContentLoaded', () => {
  const row = document.getElementById('parish-filter-row');

  row.addEventListener('click', e => {
    const pill = e.target.closest('.parish-pill');
    if (!pill) return;

    const pid = pill.dataset.parish;
    const multi = !!state.filters.multiParish;

    if (!multi) {
      // Single-parish default: tapping focused pill clears focus,
      // tapping any other pill replaces focus with that parish.
      if (state.filters.parishIds && state.filters.parishIds.has(pid) && state.filters.parishIds.size === 1) {
        state.filters.parishIds = null;
      } else {
        state.filters.parishIds = new Set([pid]);
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
    }

    if (!multi) {
      // Sync parish focus with single-pill selection (non-picker only)
      if (state.filters.parishIds && state.filters.parishIds.size === 1) {
        state.parishFocus = [...state.filters.parishIds][0];
      } else if (state.parishFocus) {
        state.parishFocus = null;
      }
    } else if (state.parishFocus) {
      state.parishFocus = null;
    }

    renderParishPills();
    renderCurrentView({ fit: true });
    syncURL();
  });
});

// ── Multi-parish toggle ──
function initMultiParishToggle() {
  const btn = document.getElementById('btn-multi-parish');
  if (!btn) return;
  btn.addEventListener('click', () => {
    state.filters.multiParish = !state.filters.multiParish;
    saveMultiParishPref(state.filters.multiParish);
    if (state.filters.multiParish) {
      // Entering picker mode: drop any single-parish focus so pills start clean.
      state.filters.parishIds = null;
      state.parishFocus = null;
    }
    // Dismiss the filters dropdown — the parish picker is a mode switch,
    // not an in-menu toggle, so keeping the menu open hides the pills that
    // just appeared below it.
    closeFiltersMenuAnim();
    syncMultiParishButton();
    syncParishRowVisibility();
    renderParishPills();
    renderCurrentView();
    syncURL();
    if (state.mode === 'services') window.agoraFetchSchedules();
    else window.agoraFetchEvents();
  });
  syncMultiParishButton();
}

function syncParishRowVisibility() {
  const row = document.getElementById('parish-filter-row');
  if (!row) return;
  // Parish picker is an explicit mode now — no auto-open on jurisdiction chip.
  row.classList.toggle('visible', !!state.filters.multiParish);
}
window.agoraSyncParishRowVisibility = syncParishRowVisibility;

function syncMultiParishButton() {
  const btn = document.getElementById('btn-multi-parish');
  if (!btn) return;
  btn.classList.toggle('active', !!state.filters.multiParish);
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
    const willActivate = !state.filters.socialOnly;
    state.filters.socialOnly = willActivate;
    btn.classList.toggle('active', willActivate);
    // Toggling social (in or out) makes the currently-open event likely irrelevant.
    if (state._openEventId) {
      closeDetailDOM();
    }
    // Mutex: turning social on while in services mode exits services mode.
    if (willActivate && state.mode === 'services') {
      document.getElementById('btn-services').click();
      return; // services-click handles render + syncFiltersButton + syncURL
    }
    renderCurrentView();
    syncFiltersButton();
    syncURL();
  });
}

// ── English filter (tri-state: off → any-english → strict → off) ──
function initEnglishFilter() {
  const btn = document.getElementById('btn-english');
  btn.addEventListener('click', () => {
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
    syncURL();
  });
  syncEnglishButton();
}

function syncEnglishButton() {
  const btn = document.getElementById('btn-english');
  if (!btn) return;
  btn.classList.toggle('active', state.filters.englishOnly);
  btn.classList.toggle('strict', state.filters.englishStrict);
  const label = btn.querySelector('.fm-label');
  if (label) {
    if (state.filters.englishStrict) label.textContent = 'English-only';
    else if (state.filters.englishOnly) label.textContent = 'English with bilingual';
    else label.textContent = 'English';
  }
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
  const content = btn.querySelector('.filters-btn-content');
  const parts = [];
  let label;
  if (state.mode === 'services') {
    parts.push(`<img src="https://api.iconify.design/ph:church.svg" alt="">`);
    label = 'Schedules';
  } else if (state.filters.socialOnly) {
    parts.push(`<img src="https://api.iconify.design/fluent:people-community-16-regular.svg" alt="">`);
    label = 'Socials';
  } else {
    parts.push(`<img src="https://api.iconify.design/ph:list.svg" alt="">`);
    label = 'Events';
  }
  parts.push(`<span class="filters-btn-label">${label}</span>`);
  if (state.filters.englishOnly) {
    const strict = state.filters.englishStrict ? ' strict' : '';
    parts.push(`<span class="fm-en-badge${strict}">EN</span>`);
  }
  // Always prominent — the button is a mode indicator, not just a menu toggle.
  btn.classList.add('has-active');
  content.innerHTML = parts.join('');

  // Mirror the radio state on the dropdown's mode items so the menu reflects
  // which view is live without tick marks. Style carries the signal.
  const isEvents = state.mode !== 'services' && !state.filters.socialOnly;
  const isServices = state.mode === 'services';
  const isSocial = state.mode !== 'services' && !!state.filters.socialOnly;
  const setActive = (id, on) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', on);
  };
  setActive('btn-events', isEvents);
  setActive('btn-services', isServices);
  setActive('btn-social', isSocial);
}

// ── Reset FAB (top center) ──
function hasActiveFilters() {
  return state.filters.jurisdiction || state.filters.parishIds ||
    state.filters.socialOnly || state.filters.englishOnly || state.parishFocus ||
    state.filters.multiParish;
}

// "Show all" FAB clears two things only: jurisdiction chip + current parish
// selection (while staying in multi-parish mode). It's visible whenever either
// is set — social/English/focus toggles don't count.
function hasResettableScope() {
  return !!(state.filters.jurisdiction || (state.filters.parishIds && state.filters.parishIds.size));
}

function syncResetFab() {
  const fab = document.getElementById('reset-fab');
  if (fab) fab.classList.toggle('visible', hasResettableScope());
}

function initResetFab() {
  const fab = document.getElementById('reset-fab');
  if (!fab) return;
  fab.addEventListener('click', () => {
    state.filters.jurisdiction = null;
    state.filters.parishIds = null;
    state.filters.showAllParishes = null;
    state.parishFocus = null;
    document.querySelectorAll('.jurisdiction-chip').forEach(c => c.classList.remove('active'));
    if (typeof applyChipColors === 'function') applyChipColors(document.getElementById('jurisdiction-chips'));
    syncParishRowVisibility();
    syncResetFab();
    renderParishPills();
    if (typeof updateArchdioceseEventsBanner === 'function') updateArchdioceseEventsBanner();
    if (typeof syncFiltersButton === 'function') syncFiltersButton();
    if (state.mode === 'services') window.agoraFetchSchedules();
    else window.agoraFetchEvents();
    syncURL();
  });
  syncResetFab();
}

// ── Location FAB (bottom right) ──
// Single toggle: sorts events by distance + sorts parish pills by distance
// + centers map on user. Icon swaps outline ↔ filled with state.
function initLocationFab() {
  const fab = document.getElementById('location-fab');
  if (!fab) return;

  function syncLocationState() {
    fab.classList.toggle('active', state.locationActive);
    const img = fab.querySelector('img');
    if (img) img.src = state.locationActive ? '/tabler-location-filled.svg' : '/tabler-location.svg';
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
    renderServices();
  } else {
    renderEvents();
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
    const scoped = e.parish_scoped || e.status === 'cancelled';
    return !scoped || e.parish_id === singleParishFilter;
  });
  if (state.filters.parishIds) {
    filtered = filtered.filter(e =>
      state.filters.parishIds.has(e.parish_id) ||
      (e.extra_parishes && e.extra_parishes.some(pid => state.filters.parishIds.has(pid)))
    );
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
  let out = events;
  if (state.filters.socialOnly) {
    out = out.filter(e => !LITURGICAL_TYPES.includes(e.event_type));
  }
  if (state.filters.englishOnly) {
    out = out.filter(e => {
      const langs = parseLangs(e.languages) || parseLangs(e.parish_languages);
      if (!langs) return false;
      if (state.filters.englishStrict) return langs.every(l => /english/i.test(l));
      return langs.some(l => /english/i.test(l));
    });
  }
  return out;
}

// ── Bottom sheet ──
function initBottomSheet() {
  const sheet = document.getElementById('bottom-sheet');
  const handle = document.querySelector('.map-grab-handle');
  const modeBar = document.getElementById('mode-bar');
  const scroll = document.getElementById('sheet-scroll');
  const fab = document.getElementById('location-fab');
  const resetFab = document.getElementById('reset-fab');
  // Both FABs share the sheet-following lifecycle — fade during drag, snap
  // to (currentY - 52) on settle. Keeping them in an array lets the drag /
  // snap handlers iterate once instead of duplicating every touchpoint.
  const trackedFabs = [fab, resetFab].filter(Boolean);

  // Snap points (translateY values — lower = sheet higher on screen)
  let SNAP_FULL, SNAP_HALF, SNAP_PEEK;
  let currentY;

  // Must match .sheet-spacer flex-basis in app.css. Sheet extends this many
  // pixels past the visible viewport bottom at rest; the extra space is the
  // .sheet-spacer child, which fills the gap exposed when rubber-band past
  // SNAP_FULL visually lifts the sheet.
  const SHEET_SPACER_PX = 200;

  function computeSnaps() {
    // Full covers entire viewport (including jurisdiction banner).
    // Sheet z-index > banner z-index so it overlays cleanly.
    SNAP_FULL = 0;
    SNAP_HALF = Math.round(window.innerHeight * 0.5);
    SNAP_PEEK = window.innerHeight - 140;
    // Sheet total height = visible list area (innerHeight - SNAP_FULL) plus
    // the offscreen spacer. At SNAP_FULL, sheet bottom sits SHEET_SPACER_PX
    // below the visible viewport bottom. sheet-scroll keeps its original
    // clientHeight because the spacer takes a fixed flex-basis, so the
    // iOS address-bar overflow fix stays intact.
    sheet.style.height = `${window.innerHeight - SNAP_FULL + SHEET_SPACER_PX}px`;
  }
  computeSnaps();
  currentY = SNAP_HALF;
  sheet.style.transform = `translateY(${currentY}px)`;
  document.body.classList.add('map-expanded');
  trackedFabs.forEach(f => { f.style.top = (currentY - 52) + 'px'; });

  // Expose for map.js padding calculation
  window.agoraSheetY = () => currentY;

  // Lock scroll initially (sheet starts at half, not full)
  scroll.style.overflowY = 'hidden';

  // Recalculate on resize/orientation change
  window.addEventListener('resize', () => {
    computeSnaps();
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
    // Only allow list scrolling when sheet is fully expanded
    scroll.style.overflowY = isAtFull() ? 'auto' : 'hidden';
  }

  function snapTo(y) {
    currentY = y;
    window.agoraSheetY = () => currentY;
    sheet.classList.remove('dragging');
    sheet.classList.add('snapping');
    sheet.style.transform = `translateY(${y}px)`;
    // Reset scroll position when leaving full snap
    if (!isAtFull()) scroll.scrollTop = 0;
    // Map is "expanded" (primary view) when sheet is not at full height.
    document.body.classList.toggle('map-expanded', y >= SNAP_HALF - 5);
    updateScrollLock();
    const onDone = () => {
      sheet.classList.remove('snapping');
      // Parish sheet takes ownership of the FABs while main sheet is hidden.
      if (!window.agoraParishSheetVisible) {
        trackedFabs.forEach(f => {
          f.style.top = (currentY - 52) + 'px';
          f.classList.remove('fading');
        });
      }
      updateScrollLock();
      if (window.agoraMap) {
        window.agoraMap.invalidateSize();
      }
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
    dragging = true;
    startY = y;
    sheetStartY = currentY;
    velSamples = [];
    sheet.classList.add('dragging');
    sheet.classList.remove('snapping');
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
    trackedFabs.forEach(f => f.classList.add('fading'));
  }

  function moveDrag(y) {
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
          engageDrag(trayPendingY);
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

  // ── Scroll area touch handling ──
  // When sheet is NOT at full: all vertical touches drag the sheet (scroll is locked)
  // When sheet IS at full: scroll normally, but at scrollTop===0 swiping down drags sheet
  const DEAD_ZONE = 8;
  let scrollState = 'idle'; // idle | deciding | scrolling | dragging | scrolling-active
  let scrollStartY = 0, scrollStartX = 0, scrollStartTop = 0;
  let scrollLastY = 0;

  scroll.addEventListener('touchstart', e => {
    scrollStartY = e.touches[0].clientY;
    scrollStartX = e.touches[0].clientX;
    scrollStartTop = scroll.scrollTop;
    scrollLastY = e.touches[0].clientY;
    scrollState = 'deciding';
  }, { passive: true });

  scroll.addEventListener('touchmove', e => {
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
    if (scrollState === 'dragging') {
      endDrag();
    }
    scrollState = 'idle';
  }, { passive: true });

  // Expose snapTo for external callers (map popup "All events" button)
  window.agoraSnapTo = snapTo;
  window.agoraSnapHalf = () => SNAP_HALF;

  // Hide/restore for parish sheet overlay — stash current Y and scrollTop,
  // snap offscreen, restore both when overlay closes. snapTo itself resets
  // scrollTop when leaving full, so capture + rewrite it around the snap.
  let _stashedY = null;
  let _stashedScroll = 0;
  window.agoraMainHide = () => {
    if (_stashedY != null) return;
    _stashedY = currentY;
    _stashedScroll = scroll.scrollTop;
    snapTo(window.innerHeight);
  };
  window.agoraMainRestore = () => {
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
}

// ── Parish sheet (secondary, opened from event drawer parish header) ──
let _parishSheetAPI = null;

function initParishSheet() {
  const sheet = document.getElementById('parish-sheet');
  const handle = sheet.querySelector('.parish-sheet-grab-handle');
  const closeBtn = document.getElementById('parish-sheet-close');
  const scroll = document.getElementById('parish-sheet-scroll');
  const fab = document.getElementById('location-fab');

  let SNAP_FULL, SNAP_HALF, SNAP_PEEK, SNAP_HIDDEN;
  let currentY;
  let dragging = false, startY = 0, sheetStartY = 0;
  let velSamples = [];

  function computeSnaps() {
    SNAP_FULL = 0;
    SNAP_HALF = Math.round(window.innerHeight * 0.5);
    SNAP_PEEK = window.innerHeight - 180;
    SNAP_HIDDEN = window.innerHeight;
    sheet.style.height = `${window.innerHeight}px`;
  }
  computeSnaps();
  currentY = SNAP_HIDDEN;
  sheet.style.transform = `translateY(${currentY}px)`;

  window.addEventListener('resize', () => {
    computeSnaps();
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
    scroll.style.overflowY = isAtFull() ? 'auto' : 'hidden';
  }

  function snapTo(y, onDone) {
    currentY = y;
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
      // Follow parish sheet with the location FAB — except while dismissed
      // (onDone takes care of those cleanup cases).
      if (fab && window.agoraParishSheetVisible) {
        fab.style.top = (currentY - 52) + 'px';
        fab.classList.remove('fading');
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
    dragging = true;
    startY = y;
    sheetStartY = currentY;
    velSamples = [];
    sheet.classList.add('dragging');
    sheet.classList.remove('snapping');
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
    if (fab) fab.classList.add('fading');
  }

  function moveDrag(y) {
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
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';
    const velocity = getVelocity();
    // Dismiss if dragged well past peek, or fast-flicked down past half
    const dismissThreshold = SNAP_PEEK + 60;
    if (currentY > dismissThreshold || (velocity > 600 && currentY > SNAP_HALF)) {
      close();
      return;
    }
    snapTo(nearestSnap(currentY, velocity));
  }

  function onHandleStart(e) {
    if (e.cancelable) e.preventDefault();
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    engageDrag(y);
  }
  function onDocMove(e) {
    if (!dragging) return;
    if (e.cancelable) e.preventDefault();
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    moveDrag(y);
  }
  function onDocEnd() { if (dragging) endDrag(); }

  handle.addEventListener('mousedown', onHandleStart);
  handle.addEventListener('touchstart', onHandleStart, { passive: false });
  document.addEventListener('mousemove', onDocMove);
  document.addEventListener('touchmove', onDocMove, { passive: false });
  document.addEventListener('mouseup', onDocEnd);
  document.addEventListener('touchend', onDocEnd);

  // Scroll-area drag handoff — mirror of main sheet.
  const DEAD_ZONE = 8;
  let scrollState = 'idle';
  let scrollStartY = 0, scrollStartX = 0, scrollStartTop = 0, scrollLastY = 0;

  scroll.addEventListener('touchstart', e => {
    scrollStartY = e.touches[0].clientY;
    scrollStartX = e.touches[0].clientX;
    scrollStartTop = scroll.scrollTop;
    scrollLastY = e.touches[0].clientY;
    scrollState = 'deciding';
  }, { passive: true });

  scroll.addEventListener('touchmove', e => {
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
    if (scrollState === 'dragging') endDrag();
    scrollState = 'idle';
  }, { passive: true });

  closeBtn.addEventListener('click', () => close());

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

    // Centre the parish in the visible (upper) half of the map, zooming in
    // only if current viewing radius is wider than 30 km.
    if (window.agoraMap && parish.lat && parish.lng) {
      const map = window.agoraMap;
      const mapEl = map.getContainer();
      const targetX = mapEl.clientWidth / 2;
      const targetY = SNAP_HALF / 2; // middle of the visible (upper) half

      // Current radius = great-circle distance from centre to NE corner.
      const c = map.getCenter();
      const ne = map.getBounds().getNorthEast();
      const radiusKm = haversineKm(c.lat, c.lng, ne.lat, ne.lng);

      if (radiusKm > 30) {
        // Find the zoom that frames a 30 km box around the parish, then fly
        // to a centre that places the parish at (targetX, targetY) at that
        // zoom. Projecting in target-zoom pixel space is the standard way to
        // express a pan-with-offset under Leaflet's flyTo.
        const latDeg = 30 / 111;
        const lngDeg = 30 / (111 * Math.cos(parish.lat * Math.PI / 180));
        const box = L.latLngBounds(
          [parish.lat - latDeg, parish.lng - lngDeg],
          [parish.lat + latDeg, parish.lng + lngDeg]
        );
        const targetZoom = map.getBoundsZoom(box);
        const parishPx = map.project([parish.lat, parish.lng], targetZoom);
        const size = map.getSize();
        const newCentrePx = parishPx.add([size.x / 2 - targetX, size.y / 2 - targetY]);
        const newCentre = map.unproject(newCentrePx, targetZoom);
        map.flyTo(newCentre, targetZoom, { duration: 1.2 });
      } else {
        const point = map.latLngToContainerPoint([parish.lat, parish.lng]);
        map.panBy([point.x - targetX, point.y - targetY], { animate: true, duration: 0.9 });
      }
    }
  }

  function close() {
    // Release FAB ownership so main sheet's pending/next snapTo repositions it.
    window.agoraParishSheetVisible = false;
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
    if (window.agoraMainRestore) window.agoraMainRestore();
  }

  _parishSheetAPI = { open, close };
}

function openParishSheet(parishId, opts = {}) {
  if (_parishSheetAPI) _parishSheetAPI.open(parishId, opts);
}
function closeParishSheet() {
  if (_parishSheetAPI) _parishSheetAPI.close();
}
window.openParishSheet = openParishSheet;
window.closeParishSheet = closeParishSheet;

function renderParishSheetContent(parishId, opts = {}) {
  const parish = state.parishes.find(p => p.id === parishId);
  if (!parish) return;

  const contentEl = document.getElementById('parish-sheet-content');
  // Prefer full canonical title ("St. Kassiani Antiochian Orthodox Church")
  // over the short nickname used on pills/cards ("St. Kassiani"). Long names
  // are shrunk to fit two lines by fitParishName() after insertion.
  const displayName = parish.full_name || parish.name || '';
  const initial = (displayName || '?')[0].toUpperCase();
  const color = parish.color || '#666';
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

  // Schedule section — drop entirely when there's nothing to show. Uses the
  // same renderer as the main services list so the two views stay visually
  // identical and share admin edit affordances.
  const scheds = (state.schedules || [])
    .filter(s => s.parish_id === parishId)
    .sort((a, b) => a.day_of_week - b.day_of_week);
  let schedSectionHtml = '';
  if (scheds.length) {
    schedSectionHtml = `
      <div class="ps-section">
        <div class="ps-section-title">Service times</div>
        <div class="ps-sched-card">
          ${renderScheduleDaysHTML(scheds, { isAdmin: state.isAdmin })}
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

  const socialActive = !!state.filters.socialOnly;
  const englishActive = !!state.filters.englishOnly;
  const englishStrict = !!state.filters.englishStrict;
  // Filters-button label + icon mirrors the main mode-bar button: either the
  // current mode (Events / Socials) with an EN badge suffix when the English
  // filter is on. Events is the "off" state when socialOnly is false.
  const psFilterIcon = socialActive
    ? 'https://api.iconify.design/fluent:people-community-16-regular.svg'
    : 'https://api.iconify.design/ph:list.svg';
  const psFilterLabel = socialActive ? 'Socials' : 'Events';
  const psEnBadge = englishActive
    ? `<span class="fm-en-badge${englishStrict ? ' strict' : ''}">EN</span>`
    : '';
  contentEl.innerHTML = `
    <div class="ps-header">
      <div class="ps-avatar" style="${parish.logo_path ? '' : `background:${esc(color)};`}--parish-glow:${esc(hexToRgba(color, 0.45))}">${parish.logo_path ? `<img src="${esc(parish.logo_path)}" alt="">` : esc(initial)}</div>
      <div class="ps-header-info">
        <div class="ps-name">${esc(displayName)}</div>
        <div class="ps-meta">${esc(juris)} Orthodox${distHtml}</div>
      </div>
      <div class="ps-filters-wrap">
        <button class="filters-btn ps-filters-btn has-active" id="ps-filters-btn" type="button" aria-haspopup="menu" aria-expanded="${opts.filtersMenuOpen ? 'true' : 'false'}">
          <span class="filters-btn-content">
            <img src="${psFilterIcon}" alt="">
            <span class="filters-btn-label">${psFilterLabel}</span>
            ${psEnBadge}
          </span>
        </button>
        <div class="filters-menu ps-filters-menu${opts.filtersMenuOpen ? '' : ' hidden'}" id="ps-filters-menu" role="menu">
          <button class="filters-menu-item${!socialActive ? ' active' : ''}" id="ps-fm-events" type="button" role="menuitemradio">
            <img class="fm-icon" src="https://api.iconify.design/ph:list.svg" alt="">
            <span class="fm-label">Events</span>
          </button>
          <button class="filters-menu-item${socialActive ? ' active' : ''}" id="ps-fm-social" type="button" role="menuitemradio">
            <img class="fm-icon" src="https://api.iconify.design/fluent:people-community-16-regular.svg" alt="">
            <span class="fm-label">Socials</span>
          </button>
          <div class="filters-menu-sep" aria-hidden="true"></div>
          <button class="filters-menu-item fm-english${englishActive ? ' active' : ''}${englishStrict ? ' strict' : ''}" id="ps-fm-english" type="button" role="menuitemcheckbox">
            <span class="fm-icon fm-en-badge${englishStrict ? ' strict' : ''}">EN</span>
            <span class="fm-label">${englishStrict ? 'English-only' : englishActive ? 'Any English' : 'English'}</span>
          </button>
        </div>
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
      <div class="ps-actions" style="--parish-color:${esc(parish.color || '#333')}">${dirBtn}${webBtn}${phoneBtn}${watchBtn}</div>
    </div>
    ${schedSectionHtml}
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

  // Parish-card Filters button + dropdown. Mirrors the main mode-bar Filters
  // button visually; items scope to what makes sense inside a single-parish
  // view (no Schedules/Parish picker/Admin). Shared session flags get flipped,
  // main mode-bar syncs via syncFiltersButton so the two views stay aligned.
  const psFiltersBtn = contentEl.querySelector('#ps-filters-btn');
  const psFiltersMenu = contentEl.querySelector('#ps-filters-menu');
  if (psFiltersBtn && psFiltersMenu) {
    const closeMenu = () => {
      psFiltersMenu.classList.add('hidden');
      psFiltersBtn.setAttribute('aria-expanded', 'false');
    };
    const openMenu = () => {
      psFiltersMenu.classList.remove('hidden');
      psFiltersBtn.setAttribute('aria-expanded', 'true');
    };
    psFiltersBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (psFiltersMenu.classList.contains('hidden')) openMenu();
      else closeMenu();
    });
    document.addEventListener('pointerdown', e => {
      if (psFiltersMenu.classList.contains('hidden')) return;
      if (psFiltersMenu.contains(e.target) || psFiltersBtn.contains(e.target)) return;
      closeMenu();
    }, true);
  }

  const psFmEvents = contentEl.querySelector('#ps-fm-events');
  if (psFmEvents) {
    psFmEvents.addEventListener('click', () => {
      if (!state.filters.socialOnly) return; // already in Events scope
      state.filters.socialOnly = false;
      const mainSocial = document.getElementById('btn-social');
      if (mainSocial) mainSocial.classList.remove('active');
      if (typeof syncFiltersButton === 'function') syncFiltersButton();
      // Mode switch closes the menu; drop filtersMenuOpen explicitly so a
      // prior EN cycle's flag doesn't carry over through opts.
      renderParishSheetContent(parishId, { ...opts, filtersMenuOpen: false });
      syncURL();
    });
  }
  const psFmSocial = contentEl.querySelector('#ps-fm-social');
  if (psFmSocial) {
    psFmSocial.addEventListener('click', () => {
      if (state.filters.socialOnly) return;
      state.filters.socialOnly = true;
      const mainSocial = document.getElementById('btn-social');
      if (mainSocial) mainSocial.classList.add('active');
      if (typeof syncFiltersButton === 'function') syncFiltersButton();
      renderParishSheetContent(parishId, { ...opts, filtersMenuOpen: false });
      syncURL();
    });
  }
  const psFmEnglish = contentEl.querySelector('#ps-fm-english');
  if (psFmEnglish) {
    psFmEnglish.addEventListener('click', e => {
      // Tri-state mirror of initEnglishFilter: off → any-english → strict → off.
      // Keep the menu open so the user can cycle through states without having
      // to reopen it between taps. stopPropagation prevents the outside-click
      // handler from closing on the same gesture.
      e.stopPropagation();
      if (!state.filters.englishOnly) {
        state.filters.englishOnly = true;
        state.filters.englishStrict = false;
      } else if (!state.filters.englishStrict) {
        state.filters.englishStrict = true;
      } else {
        state.filters.englishOnly = false;
        state.filters.englishStrict = false;
      }
      if (typeof syncEnglishButton === 'function') syncEnglishButton();
      if (typeof syncFiltersButton === 'function') syncFiltersButton();
      renderParishSheetContent(parishId, { ...opts, filtersMenuOpen: true });
      syncURL();
    });
  }

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

  // Schedule section shares the services-list markup — wire admin edit
  // handlers if the admin is viewing.
  if (state.isAdmin) wireScheduleAdminHandlers(contentEl);

  // Upcoming events: use the main-sheet stream renderer (day headers, Sunday
  // clusters, month seam) against the parish-filtered slice minus any pinned
  // focused event. Card taps expand inline within the parish sheet —
  // parish "holds" its events.
  const streamEl = contentEl.querySelector('.ps-events-list');
  if (streamEl) {
    if (streamEvents.length) {
      renderStream(streamEl, streamEvents);
    } else {
      streamEl.replaceChildren();
    }
    // Parish now "holds" its events — tapping a card expands inline within
    // the parish sheet (toggle if tapping the already-open card).
    streamEl.querySelectorAll('.event-card').forEach(card => {
      card.addEventListener('click', () => {
        const id = parseInt(card.dataset.id);
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
    });

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
        requestAnimationFrame(() =>
          expandEventCard(state._openEventId, { scope: scopeEl, card: preferred || undefined })
        );
      }
    }
  }

  // Lazy-fetch schedules when they haven't been loaded yet
  if (!state.schedules || !state.schedules.length) {
    fetch('/api/schedules')
      .then(r => r.ok ? r.json() : [])
      .then(data => {
        state.schedules = data || [];
        const sheetEl = document.getElementById('parish-sheet');
        if (sheetEl && !sheetEl.classList.contains('hidden')) {
          renderParishSheetContent(parishId, opts);
        }
      })
      .catch(() => {});
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
    fetch(`/api/events?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`)
      .then(r => r.ok ? r.json() : [])
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
          .filter(e => e.parish_id === parishId)
          .sort((a, b) => new Date(a.start_utc) - new Date(b.start_utc));
        const sheetEl = document.getElementById('parish-sheet');
        if (sheetEl && !sheetEl.classList.contains('hidden')) {
          renderParishSheetContent(parishId, { ...opts, parishEvents: filtered });
        }
      })
      .catch(() => {});
  }
}

// ── Render Events ──
function renderEvents() {
  const container = document.getElementById('events-list');
  const filtered = applyFilters(state.events);
  renderStream(container, filtered);
  bindEventCards(container);

  // Re-expand the open event (list HTML was rebuilt — drawer must be re-injected).
  if (state._openEventId) {
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
function initModeUrl() {
  const btn = document.getElementById('mode-url');
  if (!btn) return;
  btn.addEventListener('click', async () => {
    // Copy the share-form URL (no event-id) rather than location.href, since
    // the browser URL may carry /<id> purely for back-button navigation.
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
    showCopiedFeedback(btn);
  });
  updateModeUrl();

  // Filters-button label swaps (Events ↔ Schedules ↔ Socials) resize the
  // URL chip; re-evaluate overflow on any mode-bar size change.
  if (window.ResizeObserver) {
    const ro = new ResizeObserver(() => {
      const el = document.getElementById('mode-url-text');
      if (el) syncUrlChipOverflow(el);
    });
    ro.observe(btn);
  }
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
    if (p && p.color) { tint = p.color; break; }
  }

  let html = `<span class="mode-url-host">${esc(host)}</span>`;
  for (const seg of segs) {
    const decoded = decodeURIComponent(seg);
    const parish = findParishByAcronym(decoded);
    if (parish) {
      const color = parish.color || '#888';
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
    if (p && p.color) { tint = p.color; break; }
  }

  let html = `<span class="ps-url-host">${esc(host)}</span>`;
  for (const seg of segs) {
    const decoded = decodeURIComponent(seg);
    const parish = findParishByAcronym(decoded);
    if (parish) {
      const color = parish.color || '#888';
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

function renderSubDaySections(events, html) {
  const { morning, evening } = splitMorningEvening(events);
  if (morning.length) {
    html += `<div class="sub-day-header">Morning</div>`;
    html += sortEvents(morning).map(renderEventCard).join('');
  }
  if (evening.length) {
    if (morning.length) html += `<hr class="sub-day-divider">`;
    html += `<div class="sub-day-header">Evening</div>`;
    html += sortEvents(evening).map(renderEventCard).join('');
  }
  return html;
}

// Single continuous stream: optional Earlier-today chip, then Today phase
// buckets (Happening now / Later today), then day-grouped events through the
// rest of the 28-day window. Sort toggle reorders within morning/evening
// sub-groups across the whole stream.
function renderStream(container, events) {
  const now = new Date();
  const TZ_LOCAL = TZ;
  const todayKey = new Intl.DateTimeFormat('en-AU', { timeZone: TZ_LOCAL, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const dayKey = (iso) => new Intl.DateTimeFormat('en-AU', { timeZone: TZ_LOCAL, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

  const happeningNow = [], laterToday = [], earlierToday = [], future = [];
  for (const e of events) {
    const start = new Date(e.start_utc);
    const end = e.end_utc ? new Date(e.end_utc) : new Date(start.getTime() + 3600000);
    const isToday = dayKey(e.start_utc) === todayKey;
    if (isToday) {
      if (start <= now && end >= now) happeningNow.push(e);
      else if (start > now) laterToday.push(e);
      else earlierToday.push(e);
    } else {
      future.push(e);
    }
  }

  const hasToday = happeningNow.length || laterToday.length;
  let html = '';

  // Earlier-today chip — collapsed by default; expands inline on tap.
  if (earlierToday.length) {
    html += `<button class="earlier-today-chip" id="earlier-today-chip" type="button" aria-expanded="false">`;
    html += `<span class="earlier-today-chip-label">${earlierToday.length} earlier today</span>`;
    html += `<span class="earlier-today-chip-chevron">▾</span>`;
    html += `</button>`;
    html += `<div class="earlier-today-list" id="earlier-today-list" hidden>`;
    html += sortEvents(earlierToday).map(renderEventCard).join('');
    html += `</div>`;
  }

  if (happeningNow.length) {
    html += `<div class="happening-now-section">`;
    html += `<div class="section-header"><span class="now-dot"></span>Happening now</div>`;
    html += sortEvents(happeningNow).map(renderEventCard).join('');
    html += `</div>`;
  }
  if (laterToday.length) {
    html += `<div class="day-box">`;
    html += `<div class="section-header">Later today</div>`;
    html = renderSubDaySections(laterToday, html);
    html += `</div>`;
  }

  // Month seam + day groups. Always emit the seam when future events exist so
  // later async updates slot into a stable position (no scroll jump).
  if (future.length) {
    html += renderFutureDays(future);
  } else if (!hasToday) {
    html += renderEmptyStateHTML();
  }

  html += `<div class="list-footer"><div class="list-footer-ornament">· · ·</div></div>`;

  container.innerHTML = html;

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

// Day-grouped render for future events (tomorrow → end of 28-day window).
function renderFutureDays(events) {
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

    const monthKey = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(d);
    if (monthKey !== prevMonthKey) {
      const monthLabel = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, month: 'long', year: 'numeric' }).format(d);
      html += `<div class="month-header">${monthLabel}</div>`;
      prevMonthKey = monthKey;
    }

    html += `<div class="day-box${isSunday ? ' day-box-sunday' : ''}">`;
    html += `<div class="section-header">${dayFmt}</div>`;
    html = renderSubDaySections(evts, html);
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

function getJurisdictionColor(j) {
  const key = j || state.filters.jurisdiction;
  const map = { antiochian: '#1e3a5f', greek: '#00508f', serbian: '#b22234', russian: '#c8a951', romanian: '#002b7f', macedonian: '#d20000' };
  return map[key] || '#888888';
}

// Convert a #RRGGBB / #RGB hex to an rgba() string. Used to build the
// parish-colored glow on an expanded event card (injected as a CSS var so the
// ::after pseudo can pick it up).
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

function renderEventCard(evt) {
  const start = new Date(evt.start_utc);
  const time = formatEventTime(start);
  const acronymColor = evt.parish_color || '#000';
  const acronym = evt.parish_acronym ? `<span class="event-parish-acronym" style="color:${esc(acronymColor)}">${esc(evt.parish_acronym)}</span>` : '';

  // Display-time type mapping
  const displayType = TYPE_DISPLAY[evt.event_type] || evt.event_type;
  const badgeCss = `badge-${evt.event_type}`; // keep original CSS class for colors
  const langs = evt.languages ? JSON.parse(evt.languages) : [];
  const bilingualBadge = langs.length >= 2 ? `<span class="event-badge badge-bilingual">BILINGUAL</span>` : '';
  const combinedBadge = (evt.extra_parishes && evt.extra_parishes.length) ? `<span class="event-badge badge-combined">COMBINED</span>` : '';
  const badge = `<span class="event-badge ${badgeCss}">${displayType}</span>`;

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

  // Posters always render for feasts and talks (calendar anchors, visual
  // emphasis) and for socials whenever the user is in social view. Other
  // event types keep the compact text-only card.
  const hasPoster = !!(evt.poster_path && (evt.event_type === 'feast' || evt.event_type === 'talk' || state.filters.socialOnly));
  const posterImg = hasPoster
    ? `<img class="event-card-poster" src="${esc(evt.poster_path)}" alt="" loading="lazy">`
    : '';

  return `
    <div class="event-card${isCancelled ? ' event-cancelled' : ''}${hasPoster ? ' has-poster' : ''}" data-id="${evt.id}">
      <div class="event-content">
        <div class="event-title-row">
          <span class="event-time">${time}</span>
          <span class="event-title">${esc(evt.title)}</span>
        </div>
        <div class="event-parish-row">${acronym}${esc(evt.parish_name)}${distHtml} ${badge}${bilingualBadge}${combinedBadge}${liveBadge}${cancelledBadge}</div>
      </div>
      ${posterImg}
    </div>`;
}

function bindEventCards(container) {
  container.querySelectorAll('.event-card').forEach(card => {
    card.addEventListener('click', () => {
      showEventDetail(parseInt(card.dataset.id));
    });
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
      html += `<div class="schedule-item"><span class="schedule-item-title">${esc(s.title)}</span> <span class="schedule-item-time">${t}</span> ${langLabel}${womLabel}${editBtn}</div>`;
      if (isAdmin) {
        const womChecked = s.week_of_month ? s.week_of_month.split(',').map(w => w.trim()) : [];
        html += `<div class="schedule-edit-form" id="sef-${s.id}" style="display:none;" onclick="event.stopPropagation()">
          <div class="schedule-edit-grid">
            <input data-f="title" value="${esc(s.title)}" placeholder="Title">
            <select data-f="day_of_week">${[0,1,2,3,4,5,6].map(d => `<option value="${d}" ${s.day_of_week===d?'selected':''}>${DAYS[d]}</option>`).join('')}</select>
            <input data-f="start_time" type="time" value="${esc(s.start_time)}">
            <input data-f="end_time" type="time" value="${esc(s.end_time || '')}">
            <select data-f="event_type">${types.map(t => `<option value="${t}" ${s.event_type===t?'selected':''}>${t}</option>`).join('')}</select>
            <input data-f="languages" value="${esc(langs.join(', '))}" placeholder="Languages">
          </div>
          <div class="wom-checkboxes" data-f="week_of_month">
            <span class="wom-label">Weeks:</span>
            ${['first','second','third','fourth','last'].map(w =>
              `<label class="wom-check"><input type="checkbox" value="${w}" ${womChecked.includes(w)?'checked':''}> ${w}</label>`
            ).join('')}
          </div>
          <label class="wom-check" style="margin-top:4px;display:inline-flex;"><input type="checkbox" data-f="hide_live" ${s.hide_live?'checked':''}> Never show live badge</label>
          <div style="display:flex;gap:4px;margin-top:4px;">
            <button class="schedule-save-btn" data-sid="${s.id}">Save</button>
            <button class="schedule-del-btn" data-sid="${s.id}">Delete</button>
          </div>
        </div>`;
      }
    }
  }
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
        } else if (field === 'hide_live') {
          data[field] = input.checked ? 1 : 0;
        } else {
          const val = input.tagName === 'SELECT' ? input.value : input.value.trim();
          if (field === 'languages') data[field] = val ? JSON.stringify(val.split(',').map(s => s.trim()).filter(Boolean)) : null;
          else if (field === 'day_of_week') data[field] = parseInt(val);
          else data[field] = val || null;
        }
      });
      fetch(`/api/admin/schedules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        .then(r => { if (r.ok) fetchSchedules(); });
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
      const pColor = info.parish_color || jColor;
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
  if (curr && parseInt(curr.dataset.id) === id) {
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
    const accent = evt.parish_color || '#888888';
    card.style.setProperty('--accent-glow', hexToRgba(accent, 0.28));
    wireEventDrawer(drawer, evt);
  }

  state._openEventId = id;
  syncURL();

  requestAnimationFrame(() => {
    // Scroll the containing scroller so the expanded card is in view.
    const scroller = card.closest('#parish-sheet-scroll, #sheet-scroll');
    if (!scroller) return;
    const cardRect = card.getBoundingClientRect();
    const scrollRect = scroller.getBoundingClientRect();
    if (cardRect.top < scrollRect.top) {
      scroller.scrollTop += (cardRect.top - scrollRect.top);
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
    card.classList.remove('expanded');
    card.style.removeProperty('--accent-glow');
    const drawer = card.querySelector('.event-card-drawer');
    if (drawer) drawer.remove();
    const closeBtn = card.querySelector('.event-card-close');
    if (closeBtn) closeBtn.remove();
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
    adminActions = `
      <div class="admin-actions-group" style="${hiding ? 'display:none' : ''}">
        <button class="btn-outline btn-cancel-event" onclick="setEventStatus(${evt.id},'${isCancelled ? 'approved' : 'cancelled'}')">${isCancelled ? 'Uncancel' : 'Cancel'}</button>
        ${isScheduleOrigin ? `<button class="btn-outline btn-hide-event" onclick="setEventStatus(${evt.id},'${isHidden ? 'approved' : 'hidden'}')">${isHidden ? 'Unhide' : 'Hide'}</button>` : ''}
        ${isHeadless ? `<button class="btn-danger" onclick="deleteEvent(${evt.id})">Delete</button>` : ''}
        <button class="btn-outline" onclick="toggleEditEvent(${evt.id})">Edit</button>
        <button class="btn-outline" onclick="openPublicEscalateModal(${evt.id})">Absorb…</button>
      </div>
      <button class="btn-admin-controls-pill" onclick="toggleAdminControlsVisibility()">${hiding ? 'Show admin controls' : 'Hide admin controls'}</button>`;
  }

  let editForm = '';
  if (state.isAdmin) {
    const parishOpts = state.parishes.filter(p => p.id !== '_unassigned').map(p =>
      `<option value="${esc(p.id)}" ${p.id === evt.parish_id ? 'selected' : ''}>${esc(p.name)}</option>`
    ).join('');
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
        ${evt.parish_live_url ? `<div class="edit-row"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="edit-hide-live-${evt.id}" ${evt.hide_live ? 'checked' : ''}> Hide live badge</label></div>` : ''}
        <div class="edit-row"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="edit-parish-scoped-${evt.id}" ${evt.parish_scoped ? 'checked' : ''}> Parish-only (hidden unless filtered to parish)</label></div>
        <div style="margin-top:8px;display:flex;gap:8px;">
          <button class="btn-save" onclick="saveEvent(${evt.id})">Save</button>
        </div>
      </div>`;
  }

  const posterHtml = evt.poster_path
    ? `<div class="detail-poster"><img src="${esc(evt.poster_path)}" alt="Event poster"></div>`
    : '';

  // Promoted hero: time + title inline (same size/weight, modern-title
   // feel), followed by a card-shaped parish button with avatar. Suppressed
   // inside the parish sheet itself — the user is already on that parish.
  let heroHtml = '';
  if (parish) {
    const initial = (parish.name || '?')[0].toUpperCase();
    const color = parish.color || '#666';
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
      ${watchLiveCta}
      ${serviceBookCta}
      ${adminActions}
    </div>
    ${posterHtml}
    ${editForm}
    <button class="detail-url" type="button" data-share-id="${evt.id}" aria-label="Copy event link">
      <span class="detail-url-text">orthodoxy.au/${evt.id}</span>
      <img class="detail-url-copy" src="https://api.iconify.design/ph:copy.svg" alt="">
    </button>`;
}

function wireEventDrawer(drawer, evt) {
  // Stop clicks inside the drawer from bubbling up to the .event-card click
  // handler (which would otherwise treat them as a toggle request).
  drawer.addEventListener('click', e => e.stopPropagation());

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

  const urlChip = drawer.querySelector('.detail-url');
  if (urlChip) {
    urlChip.addEventListener('click', async () => {
      const id = urlChip.dataset.shareId;
      const url = `${location.origin}/${id}`;
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        const ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch {}
        document.body.removeChild(ta);
      }
      if (urlChip._copiedTimer) clearTimeout(urlChip._copiedTimer);
      urlChip.classList.add('copied');
      urlChip._copiedTimer = setTimeout(() => {
        urlChip.classList.remove('copied');
        urlChip._copiedTimer = null;
      }, 900);
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
      schedHtml += `<div class="schedule-item">${esc(s.title)} <span class="schedule-item-time">— ${formatTime12(s.start_time)}</span></div>`;
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

  panel.style.borderLeftColor = parish.color || 'var(--border)';
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
  const res = await fetch(`/api/admin/events/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (res.ok) {
    closeDetail();
    fetchEvents();
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
    fetchEvents();
  }
};

window.deleteEvent = async function(id) {
  if (!confirm('Permanently delete this event?')) return;
  const res = await fetch(`/api/admin/events/${id}`, { method: 'DELETE' });
  if (res.ok) {
    closeDetail();
    fetchEvents();
  }
};

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

window.confirmPublicEscalate = async function() {
  if (!_escalatePubEventId) return;
  const additive_parish_ids = [...document.querySelectorAll('#escalate-pub-parishes input:checked:not([data-own])')].map(cb => cb.value);
  const replaced_event_ids = [...document.querySelectorAll('#escalate-pub-events input:checked')].map(cb => Number(cb.value));
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
