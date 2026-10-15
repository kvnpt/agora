const TZ = 'Australia/Sydney';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LITURGICAL_TYPES = ['liturgy', 'prayer', 'feast', 'vespers', 'matins'];
// What an event or a rule may BE, in the order every picker offers it. Written
// down once: this was the same literal in three places in this file, which is
// how one list becomes three that disagree — see jurisdiction-colors.js for the
// table that already had to be rescued from exactly that.
const EVENT_TYPES = window.AgoraEventTypes.EVENT_TYPES;   // public/shared/event-types.js
// Which weeks of the month a rule runs on, in the order every picker offers
// them. Mirrors VALID_WEEKS in worker/routes/admin.mjs, which refuses anything
// else — a picker offering a sixth value could only ever produce a 400.
const WEEKS_OF_MONTH = ['first', 'second', 'third', 'fourth', 'last'];

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

// How far forward the feed reaches, in days, and how much Load more adds.
//
// There is no ceiling. The rules are in the browser already, so projecting
// another two months costs a projection and not a request for the occurrences
// — only the overrides and stored one-offs inside the new stretch have to be
// fetched. The step is a step rather than a doubling so the horizon note under
// the button stays a date somebody can reason about.
const HORIZON_START_DAYS = 60;
const HORIZON_STEP_DAYS = 60;
// Events revealed per Load more press, before the day the cap lands on is
// completed. Distinct from the horizon: a quiet week costs no presses.
const SHOW_COUNT_STEP = 30;

const state = {
  events: [],
  schedules: [],
  parishes: [],
  user: null,
  isAdmin: false,

  // Which account this is, as /api/admin/ping answers it: `role`, the parishes
  // a parish-scoped contact is confined to, and the capability map the guards
  // themselves consult. The app has always kept `isAdmin` and thrown the rest
  // of that response away, which was fine while every control it gated was
  // "signed in or not" — it stops being fine the moment a control belongs to
  // one parish's contact and not to another's.
  //
  // Convenience only, exactly as in /admin: every route re-checks server-side,
  // and a button this leaves on screen still gets a 403.
  adminWho: { role: null, parishIds: [], can: {}, openAsks: 0, parishNotices: 0, suggestions: 0 },

  // Which parish is being EDITED, or null. Signing in and editing are two
  // states, not one: before this, every admin control was on screen the whole
  // time a signed-in person looked at a parish, so the sheet an owner saw was
  // never the sheet a visitor saw. `hideAdminControls` was the plaster — a
  // preference to make the tools go away, remembered forever, and easy to
  // leave on and then wonder where the buttons went. It is gone; the drawer
  // has `eventEditMode` below and the two modes cover everything it did.
  //
  // One parish at a time, deliberately. Edit mode is entered from a parish's
  // own sheet and covers everything on it, its service times included, so
  // "which parish" is never a question.
  parishEditMode: null,
  // The timetable's own edit mode, separate from the details': one parish id
  // or null. See parishTimetableHTML.

  // Which EVENT is being edited, or null. The drawer's twin of
  // parishEditMode, and for the same reason: every admin control on an event
  // card used to be on screen the whole time somebody was signed in, so the
  // drawer an owner saw was never the drawer a visitor saw. `hideAdminControls`
  // was the plaster — a preference to make the tools go away, remembered
  // forever, and easy to leave on and then wonder where the buttons went.
  //
  // One event at a time, deliberately: the mode is entered from a drawer and
  // covers that drawer, so "which event" is never a question.
  eventEditMode: null,

  userLat: null,
  userLng: null,
  mode: 'events',
  // How far past today the feed has been asked to reach, in days. The fetch
  // window, NOT the render cap — that is the two ShowCounts below. It only ever
  // grows: Load more adds a step, a date focus stretches it far enough to reach
  // the date asked for, and nothing shrinks it back, because a filter change
  // that quietly undid "show me March" would be indistinguishable from a bug.
  _horizonDays: HORIZON_START_DAYS,
  // What the last fetch actually covered, which is what a date focus has to be
  // measured against — see ensureHorizonReaches.
  _loadedHorizonDays: 0,
  _eventsShowCount: SHOW_COUNT_STEP,
  _parishEventsShowCount: SHOW_COUNT_STEP,
  // `location` is a region slug from /shared/locations.js ('qld', 'syd', 'nz'),
  // not the viewer's own position — that is locationActive/userLat below.
  // kind / kindSub / lang / langStrict / bookmarked: the toolbar's filters
  // (blankFilterFlags). The parish card keeps its own copy.
  filters: { jurisdiction: null, location: null, service: null, day: null, part: null, type: '', parishIds: null, kind: null, kindSub: null, lang: null, langStrict: false, bookmarked: false, showAllParishes: null, multiParish: false },
  parishFilters: { kind: null, kindSub: null, lang: null, langStrict: false, bookmarked: false },
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
  // Where the stream starts, when the user has wound it forward. One focus, not
  // one per surface: the main feed and a parish card are two views of the same
  // date lens, and /smg/2026-07 has to mean the same thing whichever is open.
  _dateFocus: null,         // 'YYYY-MM-DD'
  _dateFocusPrecision: 'day'  // 'month' when the URL named a month, so it reads back as one
};
// Expose so map.js's 'move' rAF-throttled handler can re-cluster without
// passing state through window-scoped callbacks.
window.agoraStateRef = state;

// Convert a UTC event timestamp to a Sydney-local ISO date string (YYYY-MM-DD)
const isoDateSyd = (utcStr) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(utcStr));

// Today, in the zone the feed's day headers are written in.
const todayIso = () => isoDateSyd(new Date().toISOString());

/**
 * Midnight at the start of today, Sydney local, as a UTC instant.
 *
 * The feed's lower bound, and it is deliberately not "now": a service that
 * started an hour ago and runs for two is still happening, and the "Happening
 * now" section exists to say so.
 */
function startOfTodayUtcIso() {
  const today = todayIso();
  const startLocal = new Date(`${today}T00:00:00`);          // in the VIEWER's zone
  const probe = new Date(`${today}T12:00:00Z`);
  const offsetMs = new Date(probe.toLocaleString('en-US', { timeZone: TZ })).getTime() - probe.getTime();
  return new Date(startLocal.getTime() - offsetMs).toISOString();
}

// ── The date focus ──
//
// "Showing from 3/7/2027". One focus shared by the main feed and the parish
// card, because they are two renderings of the same stream — and because the
// URL carries exactly one date segment, so two would immediately disagree.
//
// Setting one has to REACH the date first. The feed only holds the rows inside
// its horizon, and a focus on a date past that would otherwise render an empty
// stream and give no clue why, so the horizon is stretched and the bundle
// re-fetched before anything is drawn.

/** Days from today to `date`, floored at 0. */
function daysUntil(date) {
  const t = Date.parse(String(date || '') + 'T00:00:00Z');
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.round((t - Date.parse(todayIso() + 'T00:00:00Z')) / 86400000));
}

/**
 * How far the fetch window has to reach.
 *
 * Past the focused date rather than up to it — landing on a date with nothing
 * after it is the same empty page as not reaching it at all — so a focus buys
 * itself a step's worth of feed to scroll through.
 */
function eventsHorizonDays() {
  const base = state._horizonDays || HORIZON_START_DAYS;
  if (!state._dateFocus) return base;
  return Math.max(base, daysUntil(state._dateFocus) + HORIZON_STEP_DAYS);
}

/**
 * Widen the window if `date` is past it, and re-fetch when it moved.
 *
 * Compared against what the last fetch actually COVERED, not against
 * eventsHorizonDays() — the focus is already set by the time this runs, so the
 * wanted horizon has moved with it and comparing the two would always agree
 * with itself and never fetch.
 */
async function ensureHorizonReaches(date) {
  const needed = daysUntil(date) + HORIZON_STEP_DAYS;
  if (needed <= (state._loadedHorizonDays || 0)) return false;
  await fetchEvents({ keepCount: true });
  return true;
}

window.setDateFocus = async function (dateStr, opts = {}) {
  if (!dateStr) return window.clearDateFocus();
  const month = opts.precision === 'month';
  // A month focus IS the first of that month. Without the snap the URL would
  // write "2027-06" for a focus on the 6th and read it back as the 1st — a link
  // that shows a different feed from the one it was copied out of.
  state._dateFocus = month ? `${String(dateStr).slice(0, 7)}-01` : dateStr;
  state._dateFocusPrecision = month ? 'month' : 'day';
  // A date takes This week's place in the When control (whenControlHTML).
  state._week = false;
  const refetched = await ensureHorizonReaches(dateStr);
  renderDateFocus({ rerender: !refetched });
  if (opts.silent !== true) syncURL();
  // Scroll to the day itself when one is rendered. A focus that lands on a
  // quiet date has no day box of its own, and the stream already starts at the
  // next thing on — so there is nothing to scroll to and nothing is wrong.
  requestAnimationFrame(() => {
    const scope = window.agoraParishSheetVisible
      ? document.getElementById('parish-sheet-scroll')
      : document.getElementById('sheet-scroll');
    const el = scope && scope.querySelector(
      `.day-box[data-date="${dateStr}"], .day-section[data-date="${dateStr}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    else if (scope) scope.scrollTo({ top: 0, behavior: 'smooth' });
  });
};

window.clearDateFocus = function (opts = {}) {
  if (!state._dateFocus) return;
  state._dateFocus = null;
  state._dateFocusPrecision = 'day';
  renderDateFocus({ rerender: true });
  if (opts.silent !== true) syncURL();
};

/** Repaint everything the focus shows through: both feeds and both chips. */
function renderDateFocus({ rerender = true } = {}) {
  // The date's pin belongs to the date. Moving the focus picks the new date's
  // first event; clearing it takes the pin away.
  const pin = state._dateFocusPin;
  const pinMoved = !!(pin && pin.date !== state._dateFocus);
  if (pinMoved) {
    if (isSameId(state._openEventId, pin.id)) delete state._openEventId;
    state._dateFocusPin = null;
  }
  if (rerender || pinMoved) {
    if (window.agoraParishSheetVisible && state.parishSheetFocus) {
      renderParishSheetContent(state.parishSheetFocus, pinMoved || state._dateFocus ? { fullRender: true } : {});
    } else {
      renderEvents();
    }
  }
  renderInViewChip();
  syncParishDateBanner();
  syncClearFilters();
  renderFilterSlots();
}

/** "3/7/2027" / "July 2026" — what both chips say. */
function dateFocusLabel() {
  const D = window.AgoraDates;
  if (!state._dateFocus || !D) return '';
  return D.dateFocusLabel(state._dateFocus, state._dateFocusPrecision);
}

// ── The date picker ──
//
// A month grid of our own rather than <input type="date">. Three reasons, in
// order of how much they cost: the native picker cannot carry the X that
// cancels the focus (the brief asks for one INSIDE the picker), showPicker()
// is not available everywhere and the fallback is a 1px input the user has to
// find, and the native control caps at whatever max we set — which is the
// horizon, and the horizon is the thing this button exists to move past.
//
// So: any month, forwards forever, and picking a day in one we have not
// fetched yet is what stretches the window.
const DOW_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
let _datePopMonth = null;     // 'YYYY-MM' currently drawn

// What the last render of each stream held back. Load more reads these to tell
// a reveal from a fetch — see loadMore().
let _mainDeferredCount = 0;
let _parishDeferredCount = 0;

/**
 * The round calendar button, wherever it appears: the feed's footer beside
 * Load more. The toolbars' calendar is the When control's (whenControlHTML).
 */
function calendarButtonHTML(cls) {
  const on = !!state._dateFocus;
  return `<button class="agora-cal-btn ${cls}${on ? ' active' : ''}" type="button"
      onclick="openDatePicker(this)" aria-haspopup="dialog"
      aria-label="Jump to a date" title="Jump to a date">
      <img src="https://api.iconify.design/ph:calendar-blank.svg" alt="">
    </button>`;
}

function datePopEl() { return document.getElementById('date-pop'); }

/**
 * Open the picker under `btn`. With `field` it picks a date for a form (a
 * rule's Starts and Ends) instead of the feed's focus: `field.value` is what
 * it holds, `field.onPick(iso)` is told the choice, null when the × clears it.
 * Any day can be picked then, past ones included, and the dots of the feed's
 * events are not drawn — they say nothing about a form.
 */
window.openDatePicker = function (btn, field = null) {
  const pop = datePopEl();
  if (!pop) return;
  if (!pop.classList.contains('hidden') && pop._anchor === btn) return closeDatePicker();
  pop._anchor = btn;
  pop._field = field;
  pop.classList.toggle('date-pop-field', !!field);
  _datePopMonth = ((field ? field.value : state._dateFocus) || todayIso()).slice(0, 7);
  renderDatePicker();
  pop.classList.remove('hidden');
  positionDatePicker(btn);
};

window.closeDatePicker = function () {
  const pop = datePopEl();
  if (!pop) return;
  pop.classList.add('hidden');
  pop._anchor = null;
  pop._field = null;
};

/** Pin the popover to its trigger, clamped inside the viewport. */
function positionDatePicker(btn) {
  const pop = datePopEl();
  if (!pop || !btn) return;
  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  let left = Math.round(r.left + r.width / 2 - w / 2);
  left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
  // Below the trigger by default; above it when the trigger is near the
  // bottom of the screen, which is where the footer button always is.
  let top = r.bottom + 8;
  if (top + h > window.innerHeight - 8) top = Math.max(8, r.top - h - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

function shiftDatePopMonth(delta) {
  const [y, m] = _datePopMonth.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  _datePopMonth = `${Math.floor(total / 12)}-${String((total % 12) + 1).padStart(2, '0')}`;
  renderDatePicker();
  const pop = datePopEl();
  if (pop && pop._anchor) positionDatePicker(pop._anchor);
}

function renderDatePicker() {
  const pop = datePopEl();
  const grid = document.getElementById('date-pop-grid');
  const title = document.getElementById('date-pop-title');
  if (!pop || !grid || !title) return;
  const D = window.AgoraDates;
  const [y, m] = _datePopMonth.split('-').map(Number);
  title.textContent = D ? `${D.MONTH_LABELS[m - 1]} ${y}` : _datePopMonth;

  const today = todayIso();
  const first = new Date(Date.UTC(y, m - 1, 1));
  const lead = first.getUTCDay();
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  // Which days have something on, from the rows already in hand. Absence of a
  // dot past the horizon means "not fetched", not "nothing on", so the dots
  // stop where the loaded window does rather than claiming a quiet future.
  const field = pop._field;
  const selected = field ? field.value : state._dateFocus;
  const has = field ? new Set() : new Set((state.events || []).map(e => isoDateSyd(e.start_utc)));

  let html = '';
  for (let i = 0; i < lead; i++) html += '<span class="date-pop-cell date-pop-pad"></span>';
  for (let d = 1; d <= days; d++) {
    const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const cls = ['date-pop-cell', 'date-pop-day'];
    const shut = !field && iso < today;
    if (shut) cls.push('past');
    if (iso === today) cls.push('today');
    if (iso === selected) cls.push('selected');
    if (has.has(iso)) cls.push('has-events');
    html += `<button type="button" class="${cls.join(' ')}" data-date="${iso}"${shut ? ' disabled' : ''}>${d}</button>`;
  }
  grid.innerHTML = html;

  const clearBtn = pop.querySelector('[data-date-pop-clear]');
  if (clearBtn) {
    clearBtn.hidden = !selected;
    clearBtn.setAttribute('aria-label', field ? 'Clear the date' : 'Cancel the date filter');
  }
}

function initDatePicker() {
  const pop = datePopEl();
  if (!pop) return;
  const dows = document.getElementById('date-pop-dows');
  if (dows) {
    dows.innerHTML = DOW_INITIALS
      .map(l => `<span class="date-pop-dow">${l}</span>`).join('');
  }
  pop.addEventListener('click', (e) => {
    if (e.target.closest('[data-date-pop-prev]')) return shiftDatePopMonth(-1);
    if (e.target.closest('[data-date-pop-next]')) return shiftDatePopMonth(1);
    // Jumps the GRID back to this month, and does not set a focus: focusing
    // today would push today's services out of "Happening now" and into a day
    // group, which is a worse view of today than the one the feed already has.
    // The × is what cancels a focus.
    if (e.target.closest('[data-date-pop-today]')) {
      _datePopMonth = todayIso().slice(0, 7);
      return renderDatePicker();
    }
    // A form's date: the choice goes to the form, and the × empties it.
    const field = pop._field;
    if (field) {
      const day = e.target.closest('.date-pop-day');
      if (e.target.closest('[data-date-pop-clear]')) { closeDatePicker(); field.onPick(null); }
      else if (day && day.dataset.date) { closeDatePicker(); field.onPick(day.dataset.date); }
      return;
    }
    // The X inside the picker: cancel the date filter, not just the popover.
    if (e.target.closest('[data-date-pop-clear]')) {
      closeDatePicker();
      return window.clearDateFocus();
    }
    const day = e.target.closest('.date-pop-day');
    if (day && day.dataset.date) {
      closeDatePicker();
      window.setDateFocus(day.dataset.date);
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (pop.classList.contains('hidden')) return;
    if (pop.contains(e.target)) return;
    if (pop._anchor && pop._anchor.contains(e.target)) return;
    closeDatePicker();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.classList.contains('hidden')) closeDatePicker();
  });
  window.addEventListener('resize', () => {
    if (!pop.classList.contains('hidden') && pop._anchor) positionDatePicker(pop._anchor);
  });
  // The popover is fixed and its trigger is not: a scroll would leave it
  // floating over an unrelated part of the list. Capture phase, because the
  // scroll happens inside the sheet rather than on the document.
  // A form's picker follows its field instead: the dialog it sits in scrolls
  // as the field is brought into view, and a picker that shut on that would
  // never be seen.
  document.addEventListener('scroll', () => {
    if (pop.classList.contains('hidden')) return;
    if (pop._field && pop._anchor) positionDatePicker(pop._anchor);
    else closeDatePicker();
  }, true);
}

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
  // Before anything paints: a page-mode load must never flash the map.
  decidePageMode();
  detectUrlState();
  disablePageZoom();
  disablePullToRefresh();
  loadCachedLocation();
  if (window.lsProgress) window.lsProgress(0.15);
  // The map starts before the data, not after it. The basemap — style, tiles,
  // glyphs, sprites — needs nothing from /api/bundle, and waiting for the
  // bundle first put a full server round trip in front of every tile. The
  // dots join it when updateMap runs below; until then map.js queues.
  if (window.lsLog) window.lsLog('Initialising MapLibre…');
  initMap(state);
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
  initFilterControls();
  initTopBar();
  initScheduleRowTaps();
  initFiltersMenu();
  initMultiParishToggle();
  initParishMultiToggle();
  initDatePicker();
  initAccountMenu();
  // The pill row no longer scrolls — two labelled pills and a round Admin fit
  // any phone — so there are no edges left to fade.

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
  initFeedFilterBanner();
  initLocationFab();
  initModeUrl();
  state._initialLoad = true;
  applyStartMode();
  updateArchdioceseEventsBanner();
  // The layout has settled around the map since it was created (the sheet,
  // the chips), so measure again before the first real draw.
  if (window.agoraMap) window.agoraMap.resize();
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

  // "Add parish" in /admin comes here next, with the parish it made in
  // sessionStorage: open that parish's editor, which has what its form did not
  // ask (the logo, the buttons, the links). Once, and only for somebody who
  // may edit it.
  let editPid = null;
  try {
    editPid = sessionStorage.getItem('agora-edit-parish');
    sessionStorage.removeItem('agora-edit-parish');
  } catch { /* no storage: the card opens as any link's would */ }
  if (editPid && (state.parishes || []).some(p => p.id === editPid) && adminMay('parish.edit', editPid)) {
    setTimeout(() => {
      if (state.parishSheetFocus !== editPid) openParishSheet(editPid, { replaceUrl: true });
      window.setParishEditMode(editPid, true);
    }, 300);
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
//
// A pull down — the finger moving down, which scrolls UP — is cancelled only
// when whatever is scrolling under the finger is already at its top: then the
// pull has nothing left to scroll and would reload the page.
//
// "Whatever is scrolling" is found by walking up from the touch, once per
// gesture. It used to be three named containers (the two sheets and the
// drawer), with anything else falling back to the main sheet — so inside a
// dialog (Add an event, Combine) the guard asked the sheet BEHIND it, found
// it at its top, and cancelled every scroll upward. The dialog scrolled down
// and could never come back up.
function scrollerUnder(el) {
  for (let n = el && el.nodeType === 1 ? el : el && el.parentElement; n && n !== document.body; n = n.parentElement) {
    if (n.scrollHeight > n.clientHeight + 1) {
      const oy = getComputedStyle(n).overflowY;
      if (oy === 'auto' || oy === 'scroll') return n;
    }
  }
  return null;
}

function disablePullToRefresh() {
  let touchStartY = 0;
  let touchStartX = 0;
  let scroller = null;
  document.addEventListener('touchstart', e => {
    touchStartY = e.touches[0].clientY;
    touchStartX = e.touches[0].clientX;
    scroller = scrollerUnder(e.target);
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    const y = e.touches[0].clientY;
    const x = e.touches[0].clientX;
    const dy = y - touchStartY;
    const dx = x - touchStartX;

    // Only vertical pull-down gestures.
    if (Math.abs(dx) > Math.abs(dy)) return;
    if (dy <= 0) return;
    // Something under the finger still has room to scroll up: let it.
    if (scroller && scroller.scrollTop > 0) return;
    // Nothing scrollable under the finger (the map, a bar): the page itself
    // does not scroll in this layout, so the main sheet is what would move.
    if (!scroller) {
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

// ── Jurisdiction filter ──
// The chip row at the top of the app. It is a CONTENT filter like the ones
// above and below it — it decides which events are in the feed, not what
// colour the feed is painted in (see getParishDisplayColor for the repaint
// this used to also do).
//
// It lives on the client because the feed does. /api/events took a
// `jurisdiction` param and filtered in SQL; /api/bundle ships the rules for
// every parish and leaves every axis to applyNonViewportFilters, which is
// where this one goes.
/** Is this parish id inside the active jurisdiction filter? True when none is set. */
function parishIdPassesJurisdiction(parishId) {
  if (!state.filters.jurisdiction) return true;
  const p = state.parishes.find(x => x.id === parishId);
  return !!p && p.jurisdiction === state.filters.jurisdiction;
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
// Morning or evening, on the parish's own clock. The line is the one the
// feed's Morning and Evening cards are drawn on — services.js says why.
function partOfDayOfRow(row) {
  const S = window.AgoraServices;
  return S ? S.partOfDayOf(row, TZ) : null;
}
function partLabelFor(slug) {
  const S = window.AgoraServices;
  return S ? S.partOfDayLabel(slug) : String(slug || '');
}

// ── Date filter ──
// Registry is /shared/dates.js. Same guarded-wrapper shape again, and the
// "today" it resolves against is the feed's own zone rather than the viewer's,
// so /next-thursday means the same Thursday the day headers will show.
function resolveDateSlug(seg) {
  const D = window.AgoraDates;
  return D ? D.resolveDateSlug(seg, todayIso()) : null;
}
function dateSlugFor(date, precision) {
  const D = window.AgoraDates;
  return D ? D.dateSlugFor(date, precision) : null;
}

// ── Page mode ──
//
// A parish or event link answers a visitor with its server-rendered page
// (worker/routes/pages.mjs) and an admin with this app, because the editors
// are here. So that an admin sees the page a visitor sees, with the controls
// on it, the app lays that card out as the page: the parish sheet full-screen
// and still, the map put away behind it, the same bar and X across the top.
// The X puts the card away and the map comes forward — the app as everyone
// knows it. Only on ARRIVING at such a link: a parish opened from the map is
// still the sheet over the map, which is what that sheet is good at.
//
// Which links are pages is url-state.js's pageKind, the Worker's own answer.
function decidePageMode() {
  // "Open in the app" (?app) asked for the app, not the page.
  if (/[?&]app(=|&|$)/.test(window.location.search)) return;
  const U = window.AgoraUrlState.classifyPath(window.location.pathname, { today: todayIso() });
  const kind = window.AgoraUrlState.pageKind(U);
  if (kind === 'parish' || kind === 'event') {
    document.body.classList.add('page-mode');
    placePageChrome(true);
  }
}

// The hero over the page — worker/lib/lite-page.mjs heroHTML, copied as the
// lite markup is until the renderers move into public/shared/ (roadmap).
function pageHeroHTML(mapHref) {
  return `<a class="lite-hero-brand" href="/" aria-label="orthodoxy.au — to the map">orthodoxy.au</a><a class="lite-hero-map" href="${esc(mapHref)}">View map</a>`;
}

/**
 * Page mode wears the visitor's page: the hero at the top of the sheet's
 * scroll, and the X on the card under it, scrolling with the card — so the X
 * moves into the scroll, and back out to the sheet when the page is put away.
 * The hero stays in the scroll, hidden outside page mode (app.css).
 *
 * The hero does here what it does on the visitor's page (lite.js): VIEW MAP
 * is this card on the map — the page put away with the sheet left open over
 * its pin — and anywhere else on it is the app with no link.
 */
function placePageChrome(onPage) {
  const sheet = document.getElementById('parish-sheet');
  const scroll = document.getElementById('parish-sheet-scroll');
  const close = document.getElementById('parish-sheet-close');
  if (!sheet || !scroll || !close) return;
  if (onPage) {
    if (!scroll.querySelector('.pm-hero')) {
      const hero = document.createElement('header');
      hero.className = 'lite-hero pm-hero';
      hero.innerHTML = pageHeroHTML(`${window.location.pathname}?app`);
      hero.style.cursor = 'pointer';
      hero.addEventListener('click', (e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        if (e.target.closest('.lite-hero-map')) {
          e.preventDefault();
          // Opened again as a sheet: up from the foot to half, the map
          // centred on the parish above it, as a parish opened from the map.
          const pid = state.parishSheetFocus;
          exitPageMode();
          if (pid) openParishSheet(pid, { replaceUrl: true });
        } else if (!e.target.closest('a')) {
          window.location.assign('/');
        }
      });
      scroll.insertBefore(hero, scroll.firstChild);
    }
    scroll.insertBefore(close, scroll.querySelector('#parish-sheet-content'));
  } else if (close.parentNode !== sheet) {
    sheet.insertBefore(close, scroll);
  }
}

function exitPageMode() {
  if (!document.body.classList.contains('page-mode')) return;
  document.body.classList.remove('page-mode');
  placePageChrome(false);
  // The sheet's snaps and the map's canvas were measured for a page.
  window.dispatchEvent(new Event('resize'));
  if (window.agoraMap) window.agoraMap.resize();
}
window.agoraExitPageMode = exitPageMode;

function detectUrlState() {
  // Subdomain fallback — honoured while <juris>.orthodoxy.au redirects roll out
  const host = window.location.hostname;
  const subMatch = host.match(/^(antiochian|greek|serbian|russian|romanian|macedonian)\.orthodoxy\.au$/);
  if (subMatch) {
    state.subdomainJurisdiction = subMatch[1];
    state.filters.jurisdiction = subMatch[1];
  }

  // The grammar is shared with the Worker (public/shared/url-state.js), which
  // reads the same links to answer them with a lite card. This only maps what
  // it found onto state.
  // ?app is the lite card's "Open this in the app" — the Worker's cue to serve
  // the app rather than the card. Its job is done once the app is loading.
  if (/[?&]app(=|&|$)/.test(window.location.search) && window.history.replaceState) {
    const q = new URLSearchParams(window.location.search);
    q.delete('app');
    window.history.replaceState(window.history.state, '',
      window.location.pathname + (q.toString() ? `?${q}` : '') + window.location.hash);
  }
  const U = window.AgoraUrlState.classifyPath(window.location.pathname, { today: todayIso() });
  if (U.jurisdiction) state.filters.jurisdiction = U.jurisdiction;
  if (U.kind) { state.filters.kind = U.kind; state.filters.kindSub = U.kindSub || null; }
  if (U.timetable) state._startMode = 'services';
  if (U.lang) {
    state.filters.lang = U.lang;
    state.filters.langStrict = !!U.langStrict;
  }
  if (U.week) state._week = true;
  // /donate, /<juris>/donate, or /<acronym>/donate that fell through the server
  // redirect (parish has no link on file) → open the picker dialog.
  if (U.donate) state._donateIntent = true;
  if (U.eventId) state._openEventId = U.eventId;
  if (U.dateFocus) {
    state._dateFocus = U.dateFocus;
    state._dateFocusPrecision = U.precision;
  }
  if (U.day !== null) state._daySlug = U.day;
  if (U.part) state._partSlug = U.part;
  if (U.service) state._serviceSlug = U.service;
  if (U.location) {
    state.filters.location = U.location;
    state._fitLocation = true;
  }
  if (U.parishSlugs) state._parishSlugs = U.parishSlugs;

  // social + services are mutex — services wins
  if (state._startMode === 'services') {
    state.filters.kind = null;
    state.filters.kindSub = null;
  }

  // A day, a part of the day or a service beside a parish is a schedule
  // focus, not a feed filter. The parish is still a slug at this point (ids
  // arrive with the parish list), so all three are parked and
  // applyServiceFocus finishes the job.
  const atOneParish = state._parishSlugs && state._parishSlugs.length === 1;
  if (state._serviceSlug || state._daySlug != null || state._partSlug) {
    if (atOneParish) {
      state._pendingServiceFocus = state._serviceSlug || null;
      state._pendingDayFocus = state._daySlug != null ? state._daySlug : null;
      state._pendingPartFocus = state._partSlug || null;
    } else {
      if (state._serviceSlug) state.filters.service = state._serviceSlug;
      if (state._daySlug != null) state.filters.day = state._daySlug;
      if (state._partSlug) state.filters.part = state._partSlug;
    }
  }
  delete state._serviceSlug;
  delete state._daySlug;
  delete state._partSlug;
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
  const part = state._pendingPartFocus || null;
  delete state._pendingServiceFocus;
  delete state._pendingDayFocus;
  delete state._pendingPartFocus;
  if (!slug && dow == null && !part) return;

  const parishId = state.parishFocus || state.parishSheetFocus;
  const rules = parishId ? matchingRules(parishId, slug, dow, part) : [];
  if (!rules.length) {
    // Nothing of that kind here, or no parish at all. Fall back to the
    // feed-wide reading rather than dropping the segments silently —
    // /sgr/vespers at a parish with no vespers rule should still say what it
    // was asked for.
    if (slug) state.filters.service = slug;
    if (dow != null) state.filters.day = dow;
    if (part) state.filters.part = part;
    return;
  }
  setParishScheduleFocus(parishId, {
    ruleIds: rules.map(r => r.id), slug, dow, part, scope: 'kind',
  }, { silent: true });
}

/** Did the URL park a focus for applyServiceFocus to finish? */
function hasPendingServiceFocus() {
  return !!(state._pendingServiceFocus || state._pendingDayFocus != null || state._pendingPartFocus);
}

/** This parish's rules of this kind, on this day, at this part of it. Any filter may be absent. */
function matchingRules(parishId, slug, dow, part) {
  return (state.schedules || []).filter(s =>
    s.parish_id === parishId
    && (!slug || rowIsService(slug, s))
    && (dow == null || s.day_of_week === dow)
    && (!part || partOfDayOfRow(s) === part));
}

/**
 * Projected instances from now on, in time order — narrowed by a date focus
 * when there is one. A DAY in the URL means that day and no other:
 * /sgr/liturgy/next-tue pins next Tuesday's Liturgy, and pins nothing when
 * there is no Liturgy that Tuesday rather than reaching on to Wednesday's. A
 * month is not a day, so under a month focus it is the first from that month.
 */
function upcomingOccurrences() {
  const now = Date.now();
  const from = state._dateFocus || null;
  const oneDay = from && state._dateFocusPrecision !== 'month';
  return (state.events || [])
    .filter(e => e.schedule_id != null && Date.parse(e.end_utc || e.start_utc) >= now
      && (!from || (oneDay ? eventLocalDate(e) === from : eventLocalDate(e) >= from)))
    .sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
}

function isSameId(a, b) { return a != null && b != null && String(a) === String(b); }

/** The date an event falls on where it happens, as 'YYYY-MM-DD'. */
function eventLocalDate(e) {
  return (e.start_local && String(e.start_local).slice(0, 10)) || isoDateSyd(e.start_utc);
}

/**
 * The event a date focus pins on a parish sheet: the first one ON the focused
 * day, from the list the sheet is showing (so its filters apply).
 *
 * A date in the URL — /sgr/next-tue, /smg/2026-10-06 — is a question about a
 * day at that parish, and the answer is what is on then, so it is pinned at the
 * top and opened, exactly as a deep link to that event would be. That day
 * only: a quiet Tuesday pins nothing, because pinning Wednesday's service would
 * answer a question nobody asked — the stream below still starts at the next
 * thing on, which is where the focus-as-a-FROM (dates.js) already lives. A
 * month focus is not a day and pins nothing.
 *
 * Remembered per date in state._dateFocusPin, so the pin does not jump around
 * while the list fills in, and so closing it with its X keeps it closed until
 * the date changes. Not under a rule focus, which pins its own next occurrence.
 */
function dateFocusPinFor(events) {
  const date = state._dateFocus;
  if (!date || state.parishScheduleFocus || state._dateFocusPrecision === 'month') return null;
  const held = state._dateFocusPin;
  if (held && held.date === date && held.parish === state.parishSheetFocus) {
    if (held.dismissed) return null;
    const same = (events || []).find(e => e.id === held.id);
    if (same) return same;
  }
  // Shared with the Worker's lite card, so a link pins the same event in both.
  const first = window.AgoraUrlState.firstEventOnDay(
    events, date, state._dateFocusPrecision, eventLocalDate);
  if (!first) return null;
  const isNew = !(held && held.date === date && held.parish === state.parishSheetFocus && held.id === first.id);
  state._dateFocusPin = { date, parish: state.parishSheetFocus, id: first.id, dismissed: false };
  // Opened the first time it is chosen, like a deep link; after that the reader
  // may collapse it and it stays collapsed.
  if (isNew) state._openEventId = first.id;
  return first;
}

/** Is this open event just the date focus's pin? Then the URL already names it. */
function isDateFocusPin(id) {
  const pin = state._dateFocusPin;
  return !!(pin && id != null && String(pin.id) === String(id) && pin.date === state._dateFocus);
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
    // Only ever what was asked. A tapped row is already named by its day and
    // kind, and writing its part as well would make the link narrower than
    // the row.
    part: spec.part || null,
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
    // The pinned occurrence still goes to the top, where a shared link puts it,
    // but the reader is taken DOWN to the feed rather than back up to it: they
    // tapped a row in the timetable, and what they asked for is the list of
    // that service's dates, which starts under the filter row.
    renderParishSheetContent(parishId, { fullRender: true, focusEventId: state._openEventId, scrollToFeed: true });
    scrollParishSheetToFeed();
  }
  if (!opts.silent && typeof syncURL === 'function') syncURL();
}

/** Bring the parish sheet's feed — the focus banner, then the events — up under the sticky header and filter row. */
function scrollParishSheetToFeed() {
  const scroller = document.getElementById('parish-sheet-scroll');
  const content = document.getElementById('parish-sheet-content');
  if (!scroller || !content) return;
  if (typeof window.agoraParishSheetSnapFull === 'function') window.agoraParishSheetSnapFull();
  requestAnimationFrame(() => {
    const target = content.querySelector('.ps-focus-banner') || content.querySelector('.ps-events-list');
    if (!target) return;
    const sheet = document.getElementById('parish-sheet');
    const stack = sheet ? parseFloat(getComputedStyle(sheet).getPropertyValue('--ps-stack-h')) || 0 : 0;
    const top = scroller.scrollTop + target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - stack - 6;
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  });
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
    // The acronym is the public link. The parish id is the fallback, so a
    // parish nobody has given an acronym yet is still addressable — /admin's
    // "View in app" needs a door into every parish card, not most of them.
    const match = state.parishes.find(p => {
      if (p.id === '_unassigned') return false;
      return p.acronym && norm(p.acronym) === norm(slug);
    }) || state.parishes.find(p => p.id !== '_unassigned' && norm(p.id) === norm(slug));
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
  // Day, then part, then service: /wed/evening/vespers reads as it is said.
  if (state.filters.part && !state.parishScheduleFocus) segs.push(state.filters.part);
  if (state.filters.service && !state.parishScheduleFocus) segs.push(state.filters.service);
  if (state.mode === 'services' && !state.parishSheetFocus) segs.push('timetables');
  else if (state.filters.kind) {
    const k = window.AgoraUrlState.kindSegment(state.filters.kind, state.filters.kindSub);
    if (k) segs.push(k);
  }
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
    if (f.part) segs.push(f.part);
    if (f.slug) segs.push(f.slug);
  }
  // Where the stream starts, after whatever narrowed it: /smg/2026-07 and
  // /wed/liturgy/march both read as "that, from then". A month keeps its month
  // shape; a relative spelling has already resolved to the day it meant.
  if (state._dateFocus) {
    const dateSeg = dateSlugFor(state._dateFocus, state._dateFocusPrecision);
    if (dateSeg) segs.push(dateSeg);
  } else if (state._week) {
    segs.push('this-week');
  }
  const langSeg = window.AgoraUrlState.englishSegment(state.filters);
  if (langSeg) segs.push(langSeg);
  // The focused occurrence is already named by the parish + service pair, and
  // appending its id as well would make the shared link point at one date
  // rather than at "the next one" — which is the thing being linked to.
  if (opts.includeEventId && state._openEventId && !state.parishScheduleFocus
      && !isDateFocusPin(state._openEventId)) {
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
    state.filters.part = null;
    state.parishScheduleFocus = null;
    state.filters.parishIds = null;
    state.filters.multiParish = loadMultiParishPref();
    Object.assign(state.filters, blankFilterFlags(), { bookmarked: state.filters.bookmarked });
    state._week = false;
    state.filters.showAllParishes = null;
    state.parishFocus = null;
    state._dateFocus = null;
    state._dateFocusPrecision = 'day';
    const prevOpenId = state._openEventId || null;
    const prevMode = state.mode;
    delete state._openEventId;
    delete state._startMode;
    delete state._parishSlugs;
    delete state._fitLocation;
    delete state._serviceSlug;
    delete state._daySlug;
    delete state._partSlug;
    delete state._pendingServiceFocus;
    delete state._pendingDayFocus;
    delete state._pendingPartFocus;

    // 2) Re-parse URL into state
    detectUrlState();
    applyParishSlugs();
    if (hasPendingServiceFocus()) await ensureSchedulesLoaded();
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
    renderFilterSlots();
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
    // The link under Save filter is the URL's, and the URL just changed
    // without syncURL (the back button, a saved filter opened).
    updateModeUrl();
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
  // Unless a real move marked the list pending before the snap — a deep
  // link's fit, then #no-times snapping the sheet to full: that move is owed
  // its list phase, or the list stays dim until the next one.
  const recentSheetSnap = window.__agoraSheetSnapAt
    && (Date.now() - window.__agoraSheetSnapAt) < 1100;
  if (recentSheetSnap && !_eventsPendingActive) return;
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
  // renderServices is synchronous and releases nothing itself, so release the
  // pending the move put on the list here — scheduleRenderEvents' commit does
  // the same for the feed.
  if (state.mode === 'services') {
    renderServices();
    if (typeof markEventsApplied === 'function') markEventsApplied();
  } else {
    scheduleRenderEvents();
  }
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
      && (state.filters.kind || state.filters.lang)) {
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
    const f = state.filters;
    const kind = f.kindSub ? `${window.AgoraEventTypes.eventTypeLabel(f.kindSub).toLowerCase()} events`
      : f.kind ? KIND_NAMES[f.kind].toLowerCase() : 'services';
    const label = !f.lang ? kind
      : f.langStrict ? `${f.lang}-only ${kind}` : `${kind} in ${f.lang}`;
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
  // No jurisdiction param. /api/bundle answers with every parish's rules on
  // purpose — that is what lets the chip narrow the feed without a refetch —
  // so the filter is applied in applyNonViewportFilters instead. A line
  // setting it here stayed behind after the bundle stopped reading it, and a
  // dead param on a request is indistinguishable from a live filter.

  const now = new Date();
  // From the start of today (Sydney local) out to the current horizon. Round
  // `to` to the end of a UTC day so the URL is stable within the day and the
  // browser cache can hit on repeat loads.
  params.set('from', startOfTodayUtcIso());
  // A plain fetch — a filter change, a mode toggle — starts the list at the top
  // again. It does NOT pull the horizon back in: what has been loaded stays
  // loaded, so toggling English does not undo a Load more.
  if (!opts.keepCount) state._eventsShowCount = SHOW_COUNT_STEP;
  const windowDays = eventsHorizonDays();
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
    //
    // The window goes to load() as well as to feed(): the rules project any
    // distance from rows we already hold, but the overrides and stored one-offs
    // inside a newly-reached stretch have to be asked for.
    await window.agoraBundle.load({
      fresh: opts.fresh, from: params.get('from'), to: params.get('to'),
    });
    state.events = window.agoraBundle.feed(params.get('from'), params.get('to'), {
      lat: state.userLat, lng: state.userLng,
    });
    // Only once it landed. A failed fetch that claimed the window would stop
    // the next date focus from retrying it.
    state._loadedHorizonDays = windowDays;
  } catch {
    state.events = [];
  }
  if (window.lsLog) window.lsLog('✓ events loaded (' + state.events.length + ')');
  if (window.lsProgress) window.lsProgress(0.75);

  // Initial load: nothing in the window at all → fall through to Services mode.
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
  // The count of what is on is the events', and is due as soon as they are.
  renderInViewChip();
  if (state.parishSheetFocus) renderParishSheetContent(state.parishSheetFocus, {});
}

// ── Load more ──
//
// One button, and it never runs out. It reveals the next batch of what is
// already in hand, and when there is no next batch it pushes the horizon out
// and fetches — so the user presses the same control whether the next month is
// a render away or a request away, and the feed has no last page.
//
// The press is deliberately not two buttons ("Show more" then "Load more"),
// which is what it was: the second only appeared once the first had run out,
// and the wording asked the user to care which side of the window they were on.
let _loadingMore = false;
async function loadMore({ parishMode = false }) {
  // An impatient second press while the first is fetching would ask for a
  // window 60 days past the one in flight — a request that cannot be deduped,
  // for rows the first one is already bringing back.
  if (_loadingMore) return;
  const scroll = document.getElementById(parishMode ? 'parish-sheet-scroll' : 'sheet-scroll');
  const top = scroll ? scroll.scrollTop : 0;
  const key = parishMode ? '_parishEventsShowCount' : '_eventsShowCount';
  const deferred = parishMode ? _parishDeferredCount : _mainDeferredCount;

  state[key] = (state[key] || SHOW_COUNT_STEP) + SHOW_COUNT_STEP;
  // Reveal and fetch in one press when the reveal would exhaust the window —
  // otherwise the last press before the horizon does nothing visible.
  if (deferred <= SHOW_COUNT_STEP) {
    state._horizonDays = eventsHorizonDays() + HORIZON_STEP_DAYS;
    _loadingMore = true;
    try { await fetchEvents({ keepCount: true }); } finally { _loadingMore = false; }
  } else if (parishMode) {
    if (state.parishSheetFocus) renderParishSheetContent(state.parishSheetFocus, {});
  } else {
    scheduleRenderEvents(0);
  }
  requestAnimationFrame(() => { if (scroll) scroll.scrollTop = top; });
}

window.loadMoreEvents = () => loadMore({ parishMode: false });
window.loadMoreParishEvents = () => loadMore({ parishMode: true });

async function fetchSchedules(opts = {}) {
  if (window.lsLog) window.lsLog('GET /api/schedules …');
  try {
    // `fresh` has to reach the bundle. It caches for 60 seconds, which is
    // right for a reader and wrong for the person who just changed a rule:
    // the parish sheet can now add, edit and delete services, and without
    // this the rule they deleted stayed on screen until the cache expired.
    await window.agoraBundle.load(opts.fresh ? { fresh: true } : {});
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
  // The parish sheet draws the SAME rules from the same state, and every write
  // that gets here came from a control ON that sheet — the inline add, a
  // schedule pencil, a delete. Refreshing `state` and repainting only the
  // services panel left the sheet the admin was looking at showing the list as
  // it was before their write, which reads exactly like the save failing.
  //
  // Only on `fresh`, which is only ever set by those writes. A routine reload —
  // a mode switch, a filter — must not redraw a sheet somebody is reading.
  //
  // The partial path, not fullRender: it repaints the events and the timetable
  // and deliberately leaves the header, the actions row and the edit form
  // alone, so this cannot throw away a half-typed form beside the one control
  // that was just used.
  if (opts.fresh && state.parishSheetFocus) renderParishSheetContent(state.parishSheetFocus, {});
  updateMap(state, { fit: !!opts.fit });
}

async function fetchParishes() {
  if (window.lsLog) window.lsLog('GET /api/parishes …');
  try {
    await window.agoraBundle.load();
    state.parishes = window.agoraBundle.parishes();
    // A parish's own short links ride along in the same bundle.
    state.parishLinks = (window.agoraBundle.raw && window.agoraBundle.raw.parish_links) || [];
  } catch {
    state.parishes = [];
    state.parishLinks = [];
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

  // The rest of the same answer. `can` is the capability map from
  // worker/lib/roles.mjs, so a control hidden here and a route that refuses
  // consult one list rather than two that can disagree.
  let who = null;
  if (state.isAdmin) who = await ping.json().catch(() => null);
  state.adminWho = who
    ? {
        role: who.role || null,
        parishIds: who.parishIds || [],
        can: who.can || {},
        // Asks waiting on THIS person. The Worker already answers zero for
        // anybody who cannot decide one, so the dot below needs no second
        // opinion about who it is for.
        openAsks: who.openAsks || 0,
        // …and what another parish's event is doing at theirs that they have
        // not looked at. An owner decides asks; a parish contact decides
        // nothing and gets this half instead. Most accounts have neither.
        parishNotices: who.parishNotices || 0,
        // "Suggest edits" waiting at the parishes they may edit — the one
        // count an owner, an editor and a contact can all act on.
        suggestions: who.suggestions || 0,
      }
    : { role: null, parishIds: [], can: {}, openAsks: 0, parishNotices: 0, suggestions: 0 };

  // Tell the Worker who is looking, for one purpose only: a shared parish or
  // event link is answered with a lite card (worker/routes/pages.mjs), and
  // somebody who administers wants the app there — the card has no edit mode.
  // It grants nothing; the API checks the Access token on every request.
  try {
    document.cookie = state.adminWho.role
      ? 'agora_admin=1; path=/; max-age=2592000; samesite=lax; secure'
      : 'agora_admin=; path=/; max-age=0; samesite=lax; secure';
  } catch { /* a browser refusing cookies only means admins see the card too */ }

  // The button itself is always there. What the answer decides is what is
  // BEHIND it: the panel and the way out, or the way in.
  syncAccountMenu();
  // A sheet opened from a deep link is painted before this answer exists, so
  // the add button has to be reconsidered once the role is known.
  syncParishAddEventFab();
  // .fm-admin-sep was the filter-menu divider before Admin. Admin is now a
  // menu item; the selector may not exist anymore — guard.
  const adminSep = document.querySelector('.fm-admin-sep');
  if (adminSep) adminSep.hidden = !state.isAdmin;
}

/**
 * May this account do `capability`, and to this particular parish?
 *
 * The same two questions the Worker asks in that order — `can(role, cap)` then
 * `mayTouchParish` — so a control this hides is a control the route refuses.
 * Only the `parish` role is scoped; an owner and an editor act across the
 * table, which is why the parish id is checked second and not first.
 *
 * `state.isAdmin` alone is not an answer to either. It says Cloudflare Access
 * let this browser through, and since roles landed that is the door rather than
 * the desk.
 */
function adminMay(capability, parishId = null) {
  if (!state.isAdmin) return false;
  const who = state.adminWho || {};
  // The bootstrap case (an empty admin_roles) comes back as an owner with the
  // whole map true, so there is no separate branch for "before roles existed".
  if (!who.can || !who.can[capability]) return false;
  if (who.role !== 'parish') return true;
  return !!parishId && (who.parishIds || []).includes(parishId);
}
window.agoraAdminMay = adminMay;

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

// ── Account menu ──
//
// The person icon is always on the bar, and what it does depends on whether
// this browser has an Access session. Signed out it is a way IN — there was
// none before, because the only control was an Admin pill hidden from everyone
// who was not already signed in. Signed in it is a menu, because there are two
// things to do (the panel, and leaving) and a single button can only be one.
//
// Signing in is a redirect Cloudflare owns: navigating to /admin is what makes
// Access show its login page, so the menu item is a plain link to it and there
// is no login flow of ours to get wrong.
function initAccountMenu() {
  const btn = document.getElementById('btn-account');
  const menu = document.getElementById('account-menu');
  if (!btn || !menu) return;

  const close = () => {
    menu.classList.add('hidden');
    btn.setAttribute('aria-expanded', 'false');
  };
  // The button is the banner's first chip now, at the top left: the menu
  // drops from under it, fixed, since the banner clips what overflows it.
  const open = () => {
    const r = btn.getBoundingClientRect();
    menu.style.left = `${Math.max(8, r.left)}px`;
    menu.style.top = `${r.bottom + 6}px`;
    menu.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
  };
  btn.addEventListener('click', () => {
    if (menu.classList.contains('hidden')) open(); else close();
  });
  // Same dismissal shape the filters menu uses: pointerdown in the capture
  // phase, because a plain click does not always reach a non-interactive
  // target on iOS.
  document.addEventListener('pointerdown', (e) => {
    if (menu.classList.contains('hidden')) return;
    if (menu.contains(e.target) || btn.contains(e.target)) return;
    close();
  }, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  menu.addEventListener('click', () => close());
  // Signing in from a parish's card, with nothing to edit yet, is somebody
  // who wants to help with THAT parish: they get the suggest dialog — what
  // should change, and the editor request — before Cloudflare's sign-in,
  // with a plain sign-in still a tap away for whoever already keeps it.
  const signIn = document.getElementById('btn-signin');
  if (signIn) signIn.addEventListener('click', (e) => {
    const pid = state.parishSheetFocus;
    if (!pid || state.isAdmin || !window.AgoraSuggest) return;
    const parish = (state.parishes || []).find(p => p.id === pid);
    if (!parish) return;
    e.preventDefault();
    close();
    window.AgoraSuggest.open({
      parishId: pid,
      parishName: parish.full_name || parish.name,
      services: window.AgoraSuggest.servicesFor ? window.AgoraSuggest.servicesFor(pid) : [],
      signInHref: signIn.getAttribute('href') || '/admin',
    });
  });
  syncAccountMenu();
}

/** Show the half of the menu that applies. Called again once the ping lands. */
function syncAccountMenu() {
  const signIn = document.getElementById('btn-signin');
  const admin = document.getElementById('btn-admin');
  const logout = document.getElementById('btn-logout');
  if (signIn) signIn.hidden = !!state.isAdmin;
  if (admin) admin.hidden = !state.isAdmin;
  if (logout) logout.hidden = !state.isAdmin;
  const btn = document.getElementById('btn-account');
  // Something is waiting for this person. Two halves that never both apply:
  // `openAsks` is an owner's queue and is zero for anybody who cannot decide
  // one; `parishNotices` is what was done to a contact's own parishes and is
  // zero for anybody who is not one. `suggestions` is anybody's, scoped to the
  // parishes they may edit. The Worker answers all three, so this asks how
  // many rather than who.
  const who = state.adminWho || {};
  const asks = who.openAsks || 0;
  const notices = who.parishNotices || 0;
  const suggested = who.suggestions || 0;
  const dot = document.getElementById('account-dot');
  if (dot) dot.hidden = !(state.isAdmin && (asks + notices + suggested) > 0);
  if (btn) {
    btn.classList.toggle('signed-in', !!state.isAdmin);
    // The count goes in the label, not in the dot: nine pixels cannot carry a
    // number, and a screen reader hears nothing at all from a coloured circle.
    const parts = [];
    if (asks) parts.push(`${asks} ${asks === 1 ? 'ask' : 'asks'} waiting`);
    if (notices) parts.push(`${notices} new at your ${notices === 1 ? 'parish' : 'parishes'}`);
    if (suggested) parts.push(`${suggested} ${suggested === 1 ? 'suggestion' : 'suggestions'}`);
    const label = !state.isAdmin ? 'Sign in'
      : parts.length ? `Account — ${parts.join(', ')}`
      : 'Account';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  }
}

/**
 * Re-read how many asks are waiting, without a page load.
 *
 * The count rides on /api/admin/ping because that is the one request already
 * answering "who am I and what does this browser need to know". Filing an ask
 * from the parish sheet changes it, and a dot that only appeared on the next
 * load would miss the one moment the person is looking at it.
 */
async function refreshOpenAsks() {
  if (!state.isAdmin) return;
  try {
    const res = await fetch('/api/admin/ping', { cache: 'no-store' });
    if (!res.ok) return;
    const who = await res.json();
    state.adminWho = {
      ...state.adminWho,
      openAsks: who.openAsks || 0,
      parishNotices: who.parishNotices || 0,
      suggestions: who.suggestions || 0,
    };
    syncAccountMenu();
  } catch { /* offline — the dot keeps whatever it last knew */ }
}

// ── Mode bar ──
// The Schedules button: the timetable of every parish in view, in place of the
// feed. The kind and the language narrow both (timetable.js), so turning it on
// keeps them.
function initModeBar() {
  const servicesBtn = document.getElementById('btn-services');
  servicesBtn.addEventListener('click', () => {
    closeFiltersMenuAnim();
    // Entering services mode makes the currently-open event irrelevant —
    // close the drawer so the URL chip drops the event id on sync below.
    if (state.mode !== 'services' && state._openEventId) {
      closeDetailDOM();
    }
    if (state.mode === 'services') {
      state.mode = 'events';
      showView('events');
      fetchEvents();
    } else {
      state.mode = 'services';
      showView('services');
      fetchSchedules();
    }
    updateArchdioceseEventsBanner();
    renderFilterSlots();
    if (typeof syncFiltersButton === 'function') syncFiltersButton();
    if (typeof syncResetFab === 'function') syncResetFab();
    snapMainSheetToFull();
    syncURL();
    pulseSaveFilter();
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
  // The banner's noun is the view's: "evening services" over the schedules,
  // "evening events" over the feed.
  syncFeedFilterBanner();
}

// ── Apply URL-driven start state (mode, EN filter) ──
async function applyStartMode() {
  const servicesBtn = document.getElementById('btn-services');

  renderFilterSlots();

  if (state._startMode === 'services') {
    state.mode = 'services';
    servicesBtn.classList.add('active');
    showView('services');
    await fetchSchedules();
  } else {
    await fetchEvents();
  }
  // No `fit` on these two. The first frame of a fresh session is every parish
  // (map.js, fitToAllParishes), and it always was: these asked for a fit, but
  // they ran before the map existed and updateMap dropped the request. Now
  // that the map is created before the bundle arrives the request would land
  // and frame the week's events instead — a change nobody decided on. A place
  // in the URL still frames that place, just below.
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
  if (hasPendingServiceFocus()) {
    await ensureSchedulesLoaded();
    applyServiceFocus();
    syncURL({ replace: true });
  }
  state._initialLoad = false;
  // A page-mode link whose parish or event is not on file opens no card, and
  // a page with nothing on it is worse than the map. The card opens 150ms
  // after load (see above), so look a little after that.
  setTimeout(() => {
    if (document.body.classList.contains('page-mode') && !window.agoraParishSheetVisible) exitPageMode();
  }, 600);
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

  // Sort origin: the person, when their location is on, so the row reads
  // nearest-first by the distances it shows. Otherwise the visible-centre at
  // SNAP_HALF (sheet at 50% of screen height) — pills sort as if the user is
  // in the standard browsing position regardless of where they've dragged it.
  let originLat = null, originLng = null;
  const vc = state.locationActive ? null : window.agoraMap ? (() => {
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
    const isSelected = state.filters.parishIds && state.filters.parishIds.has(p.id);
    const color = getParishDisplayColor(p.color || '#000');
    // The pill is the parish's logo (its acronym avatar when it has none),
    // ringed in its colour. In view and unfiltered: a thin ring. Selected:
    // a thick one. Out of view or not chosen: faded, a grey ring.
    let tone;
    if (allActive) tone = (!vp || vp.has(p.id)) ? 'on' : 'off';
    else tone = isSelected ? 'selected' : 'off';
    const a = parishAvatarParts(p);
    // A favourite wears a small star, as its marker does.
    const star = isFavourite(p.id) ? '<span class="pill-fav" aria-hidden="true">★</span>' : '';
    // Distance only from where the person is, and only when they have said
    // so — tiered in the same blues as every other current-location distance.
    let dist = '';
    let distLabel = '';
    if (state.locationActive && state.userLat != null && p.lat != null && p.lng != null) {
      const km = haversineKm(state.userLat, state.userLng, p.lat, p.lng);
      const cls = km <= 5 ? 'distance-near' : km <= 15 ? 'distance-mid' : 'distance-far';
      distLabel = km < 10 ? km.toFixed(1) : String(Math.round(km));
      dist = `<span class="pill-dist ${cls}">${esc(distLabel)}km</span>`;
    }
    const label = (p.name || p.acronym || '') + (distLabel ? `, ${distLabel} km away` : '');
    const activeClass = (allActive || isSelected) ? ' active' : '';
    html += `<button class="parish-pill pill-${tone}${activeClass}${dist ? ' has-dist' : ''}" type="button" data-parish="${esc(p.id)}" data-color="${color}"
        style="--pill-ring:${color};" aria-label="${esc(label)}" aria-pressed="${isSelected ? 'true' : 'false'}" title="${esc(p.name || '')}">
        <span class="pill-logo${a.cls}"${a.style ? ` style="${a.style}"` : ''}>${a.inner}</span>${star}${dist}</button>`;
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
  renderParishCounter();
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
  // "3 events": what is on in the period the When control names — what is
  // left of today, the next seven days, or the date the stream starts from —
  // among the events the feed would show here. The parishes in view are the
  // parish counter's to count now (renderParishCounter), not this chip's.
  const n = eventsInPeriodCount();
  countEl.textContent = `${n} ${n === 1 ? 'event' : 'events'}`;
  const chip = document.getElementById('in-view-chip');
  if (chip) {
    const when = state._dateFocus ? `on ${dateFocusLabel()}` : state._week ? 'this week' : 'today';
    chip.title = `${n} ${n === 1 ? 'event' : 'events'} ${when}`;
  }
  updateInViewChevron();
  renderParishCounter();
}

/** 'YYYY-MM-DD' `n` days after `iso`. */
function addDaysIso(iso, n) {
  return new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}
/** Midnight, in Sydney, at the start of the day `n` days from today. */
function sydneyMidnightMs(daysFromToday) {
  return Date.parse(localInputToUtc(`${addDaysIso(todayIso(), daysFromToday)}T00:00`));
}
/** Where This week ends: the start of the eighth day. */
function weekEndMs() { return sydneyMidnightMs(7); }

/** How many events the feed shows in the When control's period. */
function eventsInPeriodCount() {
  const now = Date.now();
  let from = now, to;
  if (state._dateFocus) {
    const d = state._dateFocus;
    from = Date.parse(localInputToUtc(`${d.length === 7 ? `${d}-01` : d}T00:00`));
    if (state._dateFocusPrecision === 'month' || d.length === 7) {
      const [y, m] = d.split('-').map(Number);
      to = Date.parse(localInputToUtc(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01T00:00`));
    } else {
      to = Date.parse(localInputToUtc(`${addDaysIso(d, 1)}T00:00`));
    }
  } else {
    to = state._week ? weekEndMs() : sydneyMidnightMs(1);
  }
  let n = 0;
  for (const e of applyFilters(state.events || [])) {
    if (e.is_tombstone || (e.status && e.status !== 'approved')) continue;
    const start = Date.parse(e.start_utc);
    const end = e.end_utc ? Date.parse(e.end_utc) : start + 3600000;
    if (end > from && start < to) n++;
  }
  return n;
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
// iOS reports the old size for a moment after the phone turns, so whatever
// measured on the first resize measured the wrong screen. Once it has
// settled, everything that listens for a resize hears one more.
window.addEventListener('orientationchange', () => {
  setTimeout(() => window.dispatchEvent(new Event('resize')), 350);
});
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

// ── What this browser keeps: favourite parishes, bookmarks, saved filters ──
//
// Nobody signs in to read the app, so these live in localStorage, per browser:
// a person's own short list of parishes, the events they mean to go to, and
// the views they come back to. Every read and write survives storage being
// refused (a private window) — the controls simply come back empty.

const STORE = { fav: 'agora-favourites', bm: 'agora-bookmarks', saved: 'agora-saved-filters' };
const _storeCache = {};
function readStore(key) {
  if (_storeCache[key]) return _storeCache[key];
  let v = [];
  try { v = JSON.parse(localStorage.getItem(key) || '[]'); } catch { v = []; }
  return (_storeCache[key] = Array.isArray(v) ? v : []);
}
function writeStore(key, v) {
  _storeCache[key] = v;
  try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* kept for this page only */ }
}

// Favourites: [{ id, at }], newest first.
function favourites() {
  const ids = new Set((state.parishes || []).map(p => p.id));
  return [...readStore(STORE.fav)].filter(f => ids.has(f.id)).sort((a, b) => b.at - a.at);
}
function isFavourite(pid) { return readStore(STORE.fav).some(f => f.id === pid); }
window.agoraIsFavourite = isFavourite;
function toggleFavourite(pid) {
  const list = readStore(STORE.fav);
  writeStore(STORE.fav, isFavourite(pid) ? list.filter(f => f.id !== pid) : [{ id: pid, at: Date.now() }, ...list]);
  document.querySelectorAll(`[data-fav-parish="${CSS.escape(pid)}"]`).forEach(b => paintFavouriteButton(b, pid));
  renderParishPills();
  renderFavouritesList();
  if (typeof window.updateMap === 'function') window.updateMap(state);
}
function favouriteButtonHTML(pid) {
  const on = isFavourite(pid);
  return `<button class="ps-btn ps-fav-btn${on ? ' on' : ''}" type="button" data-fav-parish="${esc(pid)}" aria-pressed="${on}"
      aria-label="Favourite" title="Favourite">
      <img class="ps-btn-icon" src="https://api.iconify.design/ph:star${on ? '-fill' : ''}.svg" alt=""></button>`;
}
function paintFavouriteButton(btn, pid) {
  const on = isFavourite(pid);
  btn.classList.toggle('on', on);
  btn.setAttribute('aria-pressed', String(on));
  const img = btn.querySelector('img');
  if (img) img.src = `https://api.iconify.design/ph:star${on ? '-fill' : ''}.svg`;
}
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-fav-parish]');
  if (b) { e.preventDefault(); toggleFavourite(b.dataset.favParish); }
});

/** The star fab's column: the favourites as fabs, logo and name, newest first. */
function renderFavouritesList() {
  const list = document.getElementById('fav-list');
  if (!list) return;
  const favs = favourites();
  const byId = new Map((state.parishes || []).map(p => [p.id, p]));
  list.innerHTML = favs.length
    ? favs.map(f => {
        const p = byId.get(f.id);
        return `<button class="fav-item" type="button" data-fav-open="${esc(p.id)}">
            ${parishAvatarHTML(p, 'fav-item-avatar', 'span')}<span class="fav-item-name">${esc(p.name)}</span></button>`;
      }).join('')
    : '<div class="fav-empty">Tap the star on a parish’s card and it is kept here.</div>';
  const btn = document.getElementById('btn-favourites');
  if (btn) btn.classList.toggle('has-favs', favs.length > 0);
}
function toggleFavouritesList(open) {
  let list = document.getElementById('fav-list');
  if (!list) {
    list = document.createElement('div');
    list.id = 'fav-list';
    list.className = 'fav-list hidden';
    document.body.appendChild(list);
    list.addEventListener('click', (e) => {
      const item = e.target.closest('[data-fav-open]');
      if (!item) return;
      toggleFavouritesList(false);
      openParishSheet(item.dataset.favOpen);
    });
    document.addEventListener('pointerdown', (e) => {
      if (list.classList.contains('hidden')) return;
      if (list.contains(e.target) || e.target.closest('#btn-favourites')) return;
      toggleFavouritesList(false);
    }, true);
  }
  const btn = document.getElementById('btn-favourites');
  const show = open == null ? list.classList.contains('hidden') : open;
  if (show) {
    renderFavouritesList();
    const r = btn.getBoundingClientRect();
    list.style.left = `${Math.max(8, r.left)}px`;
    list.style.top = `${r.bottom + 6}px`;
  }
  list.classList.toggle('hidden', !show);
  if (btn) btn.setAttribute('aria-expanded', String(show));
}

// Bookmarks: [{ id, kind: 'event' | 'rule', at }] — an event (a stored one,
// or one occurrence of a rule by its "<rule>:<date>" id), or a whole rule.
function bookmarks() { return readStore(STORE.bm); }
function bookmarkCount() { return bookmarks().length; }
function isBookmarkedEvent(id) { return bookmarks().some(b => b.kind === 'event' && String(b.id) === String(id)); }
function isBookmarkedRule(sid) { return sid != null && bookmarks().some(b => b.kind === 'rule' && String(b.id) === String(sid)); }
/** Is this event bookmarked, itself or as one of its rule's? */
function isBookmarked(e) {
  return isBookmarkedEvent(e.id) || isBookmarkedRule(e.schedule_id != null ? e.schedule_id : ruleIdOf(e.id));
}
/** The rule an occurrence's synthetic id names, or null for a stored one-off. */
function ruleIdOf(id) {
  const m = String(id || '').match(/^(\d+):\d{4}-\d{2}-\d{2}$/);
  return m ? Number(m[1]) : null;
}
function toggleBookmark(kind, id) {
  const list = bookmarks();
  const has = list.some(b => b.kind === kind && String(b.id) === String(id));
  writeStore(STORE.bm, has ? list.filter(b => !(b.kind === kind && String(b.id) === String(id)))
    : [{ id: String(id), kind, at: Date.now() }, ...list]);
}
/** The drawer's bookmark, and — for one occurrence of a rule — the rule's. */
function bookmarkButtonsHTML(evt) {
  const on = isBookmarkedEvent(evt.id);
  const sid = evt.schedule_id != null ? evt.schedule_id : ruleIdOf(evt.id);
  const ruleOn = isBookmarkedRule(sid);
  const eid = esc(String(evt.id));
  let html = `<button class="btn-action btn-bookmark${on || ruleOn ? ' on' : ''}" type="button" data-bookmark-event="${eid}" aria-pressed="${on}">
      <img class="btn-action-icon" src="https://api.iconify.design/ph:bookmark-simple${on || ruleOn ? '-fill' : ''}.svg" alt="">${on || ruleOn ? 'Bookmarked' : 'Bookmark'}
    </button>`;
  // Bookmarking one date of a weekly service offers the service itself: the
  // cycle arrows keep every date of it.
  if (sid != null && (on || ruleOn)) {
    html += `<button class="btn-action btn-bookmark-rule${ruleOn ? ' on' : ''}" type="button" data-bookmark-rule="${esc(String(sid))}" data-for-event="${eid}"
        aria-pressed="${ruleOn}" aria-label="${ruleOn ? 'Every date is bookmarked' : 'Bookmark every date of this service'}" title="Every date of this service">
        <img class="btn-action-icon" src="https://api.iconify.design/ph:arrows-clockwise${ruleOn ? '-bold' : ''}.svg" alt="">${ruleOn ? 'Every date' : 'Every date?'}
      </button>`;
  }
  return html;
}
document.addEventListener('click', (e) => {
  const ev = e.target.closest('[data-bookmark-event]');
  const rule = e.target.closest('[data-bookmark-rule]');
  if (!ev && !rule) return;
  e.preventDefault();
  e.stopPropagation();
  const id = ev ? ev.dataset.bookmarkEvent : rule.dataset.forEvent;
  if (ev) {
    // Un-bookmarking a date the rule's bookmark covers takes the rule's too:
    // the button reads Bookmarked for either, and pressing it should leave
    // nothing behind.
    const evt = (state.events || []).find(x => String(x.id) === String(id));
    const sid = evt && (evt.schedule_id != null ? evt.schedule_id : ruleIdOf(evt.id));
    if (!isBookmarkedEvent(id) && isBookmarkedRule(sid)) toggleBookmark('rule', sid);
    else toggleBookmark('event', id);
  } else {
    toggleBookmark('rule', rule.dataset.bookmarkRule);
  }
  // Repaint the buttons wherever this event is open, and the toolbar's count.
  const evt = (state.events || []).find(x => String(x.id) === String(id));
  if (evt) {
    document.querySelectorAll(`.event-card[data-id="${CSS.escape(String(id))}"] .bookmark-slot`)
      .forEach(slot => { slot.innerHTML = bookmarkButtonsHTML(evt); });
  }
  renderFilterSlots();
  if (state.filters.bookmarked || state.parishFilters.bookmarked) {
    if (!bookmarkCount()) { state.filters.bookmarked = false; state.parishFilters.bookmarked = false; }
  }
}, true);   // capture: an expanded card's own handlers stop the click bubbling

// Saved filters: [{ url, path, at }], newest first — the views this browser
// came back to, as links (Save Filter, and the monocle beside it).
function savedFilters() { return [...readStore(STORE.saved)].sort((a, b) => b.at - a.at); }
function currentFilterLink() {
  const path = '/' + buildPathSegs().join('/');
  return { path, url: `${location.origin}${path === '/' ? '/' : path}` };
}
function saveCurrentFilter() {
  const { path, url } = currentFilterLink();
  writeStore(STORE.saved, [{ url, path, at: Date.now() }, ...readStore(STORE.saved).filter(x => x.path !== path)]);
  syncSavedFiltersFab();
  return { path, url };
}
function syncSavedFiltersFab() {
  const b = document.getElementById('btn-saved-filters');
  if (b) b.hidden = !savedFilters().length;
}
/** "Saved": in the middle of the screen, the link to copy, and Share. */
function openSavedFilterDialog() {
  const { url } = saveCurrentFilter();
  const sentence = feedFilterSentence && feedFilterSentence();
  const body = openFormDialog({
    kind: 'saved',
    title: 'Saved',
    sub: sentence || 'This view, as a link — kept under the monocle beside Save filter.',
    html: `<div class="saved-filter">
        <button type="button" class="saved-url" data-copy-url="${esc(url)}" title="Copy">
          <span class="saved-url-text">${esc(url.replace(/^https?:\/\//, ''))}</span>
          <img class="saved-url-copy" src="https://api.iconify.design/ph:copy.svg" alt="">
        </button>
        <div class="form-actions">
          <button type="button" class="btn-save" data-share-saved="${esc(url)}">
            <img class="btn-action-icon" src="https://api.iconify.design/ph:paper-plane-tilt.svg" alt="">Share this filter
          </button>
          <button type="button" class="btn-outline" onclick="closeFormDialog()">Done</button>
        </div>
      </div>`,
  });
  return body;
}
/** The monocle: every saved filter, to open or to forget. */
function openSavedFiltersList() {
  const list = savedFilters();
  const host = location.host.replace(/^www\./, '');
  openFormDialog({
    kind: 'saved-list',
    title: 'Saved filters',
    sub: list.length ? 'Tap one to open it.' : 'Nothing saved yet.',
    html: `<div class="saved-list">${list.map(x => `
        <div class="saved-row">
          <a class="saved-row-link" href="${esc(x.path)}" data-open-saved="${esc(x.path)}">${esc(host)}<b>${esc(x.path === '/' ? '' : x.path)}</b></a>
          <button type="button" class="saved-row-del" data-forget-saved="${esc(x.path)}" aria-label="Forget this filter">&times;</button>
        </div>`).join('')}</div>`,
  });
}
document.addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy-url]');
  const share = e.target.closest('[data-share-saved]');
  const open = e.target.closest('[data-open-saved]');
  const forget = e.target.closest('[data-forget-saved]');
  if (copy) {
    e.preventDefault();
    try { await navigator.clipboard.writeText(copy.dataset.copyUrl); } catch { /* the text is there to select */ }
    copy.classList.add('copied');
    setTimeout(() => copy.classList.remove('copied'), 1100);
  } else if (share) {
    e.preventDefault();
    await shareUrl(share.dataset.shareSaved, document.title, share);
  } else if (open) {
    e.preventDefault();
    closeFormDialog();
    history.pushState({}, '', open.dataset.openSaved);
    reconcileStateFromUrl();
  } else if (forget) {
    e.preventDefault();
    writeStore(STORE.saved, readStore(STORE.saved).filter(x => x.path !== forget.dataset.forgetSaved));
    syncSavedFiltersFab();
    openSavedFiltersList();
  }
});

/** The toolbar's Save button, pulsing: something about the view just changed. */
function pulseSaveFilter() {
  const b = document.getElementById('btn-save-filter-bar');
  if (!b) return;
  b.classList.remove('pulse');
  void b.offsetWidth;
  b.classList.add('pulse');
}

/**
 * "⛪ 3": the parishes the map is showing — the viewport, by the jurisdiction
 * and region the map filters its markers by. A tap chooses them: multi-select
 * with those already ticked; with none in view, multi-select and the map out
 * to the nearest parish.
 */
function viewportParishes() {
  const vp = state.viewportParishIds;
  if (!(vp instanceof Set)) return [];
  const j = state.filters.jurisdiction;
  return (state.parishes || []).filter(p => p.id !== '_unassigned' && vp.has(p.id)
    && (!j || p.jurisdiction === j) && parishPassesLocation(p));
}
function renderParishCounter() {
  const n = document.getElementById('parish-counter-n');
  if (!n) return;
  const count = viewportParishes().length;
  n.textContent = String(count);
  const btn = document.getElementById('btn-parish-counter');
  if (btn) {
    btn.setAttribute('aria-label', `${count} ${count === 1 ? 'parish' : 'parishes'} in view — choose them`);
    btn.classList.toggle('active', !!state.selectionMode);
  }
}
function initTopBar() {
  const counter = document.getElementById('btn-parish-counter');
  if (counter) counter.addEventListener('click', () => {
    if (state.selectionMode) { setSelectionMode(false); return; }
    const visible = viewportParishes();
    if (visible.length) {
      state.filters.parishIds = new Set(visible.map(p => p.id));
      setSelectionMode(true);
    } else {
      setSelectionMode(true);
      const j = state.filters.jurisdiction;
      const target = findNearestParishWhere(p => !j || p.jurisdiction === j);
      if (target && window.agoraMap) {
        const c = visibleCentreLatLng() || { lat: state.userLat, lng: state.userLng };
        window.agoraMap.fitBounds(window.agoraPadBounds(window.agoraBoundsFromPoints([c, { lat: target.lat, lng: target.lng }]), 0.25),
          { maxZoom: 13, duration: 600 });
      }
    }
  });
  const fav = document.getElementById('btn-favourites');
  if (fav) fav.addEventListener('click', () => toggleFavouritesList());
  const saveFab = document.getElementById('btn-save-filter');
  if (saveFab) saveFab.addEventListener('click', () => openSavedFilterDialog());
  const saveBar = document.getElementById('btn-save-filter-bar');
  if (saveBar) saveBar.addEventListener('click', () => openSavedFilterDialog());
  const savedFab = document.getElementById('btn-saved-filters');
  if (savedFab) savedFab.addEventListener('click', () => openSavedFiltersList());
  syncSavedFiltersFab();
  renderFavouritesList();
  renderParishCounter();
}

// ── The filter controls ─────────────────────────────────────────────────
//
// One set of builders for both toolbars — the main sheet's and the parish
// card's — so the two read and behave as one thing, each over its own filter
// set: state.filters for the feed, state.parishFilters for the open card
// (which is also what narrows the card's timetable). The When control is the
// one they share, because the date the stream starts from is shared.
//
//   Language  "Any language", then a language with an up-and-down segment
//             that opens our own list of the languages on file, and "only".
//   Kind      a cycle — Any event, Services, Studies, Socials — where
//             Services spawns three roundels (L, P, F) and Socials two (S, Y);
//             one roundel at a time narrows it, and spells its name out.
//   When      Today, then This week (the next seven days) with a calendar
//             beside it, and any date from that calendar in its place.
//   Bookmarks the events this browser bookmarked, once there are any.

const KIND_CYCLE = [null, 'services', 'studies', 'socials'];
const KIND_NAMES = { services: 'Services', studies: 'Studies', socials: 'Socials' };
const KIND_SUBS = { services: ['liturgy', 'prayer', 'feast'], socials: ['social', 'youth'] };

/** The filter set a toolbar edits. */
function filterSetFor(scope) {
  return scope === 'parish' ? state.parishFilters : state.filters;
}
/** A filter set with nothing in it: any event, any language, everything. */
function blankFilterFlags() {
  return { kind: null, kindSub: null, lang: null, langStrict: false, bookmarked: false };
}

/** Does an event pass a set's kind, language and bookmarks? */
function eventPassesFlags(e, f) {
  const T = window.AgoraTimetable;
  if (!T.kindMatches(e, f)) return false;
  const lf = T.langFilterOf(f);
  if (lf && !T.langsMatch(parseLangs(e.languages) || parseLangs(e.parish_languages), lf)) return false;
  if (f.bookmarked && !isBookmarked(e)) return false;
  return true;
}

/**
 * The languages on file — parishes', rules', events' — most used first, and
 * English first of all. What the language picker offers.
 */
function languagesInUse() {
  const count = new Map();
  const add = (v) => {
    for (const l of parseLangs(v) || []) {
      const name = String(l || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const had = count.get(key);
      count.set(key, { name: had ? had.name : name, n: (had ? had.n : 0) + 1 });
    }
  };
  for (const p of state.parishes || []) add(p.languages);
  for (const r of state.schedules || []) add(r.languages);
  for (const e of state.events || []) add(e.languages);
  return [...count.values()]
    .sort((a, b) => (b.name === 'English') - (a.name === 'English') || b.n - a.n || a.name.localeCompare(b.name))
    .map(x => x.name);
}

function langControlHTML(f) {
  const on = !!f.lang;
  return `<div class="lang-filter${on ? ' on' : ''}">
      <button class="mode-bar-en lang-main${on ? ' active' : ''}" type="button" data-lang-toggle role="checkbox" aria-checked="${on}">${esc(on ? f.lang : 'Any language')}</button>${on ? `
      <button class="lang-pick" type="button" data-lang-pick aria-haspopup="listbox" aria-label="Choose the language" title="Choose the language">
        <svg viewBox="0 0 12 16" width="10" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 6 6 2.5 9.5 6M2.5 10 6 13.5 9.5 10"/></svg>
      </button>
      <button class="mode-bar-en mode-bar-en-only${f.langStrict ? ' active' : ''}" type="button" data-lang-only role="checkbox" aria-checked="${!!f.langStrict}">only</button>` : ''}
    </div>`;
}

/** A roundel's colours: the kind's own, from public/shared/event-types.js. */
function kindRoundelStyle(id) {
  const c = window.AgoraEventTypes.kindColors(id, matchMedia('(prefers-color-scheme: dark)').matches);
  return `--k-bg:${c.bg};--k-fg:${c.fg}`;
}

function kindControlHTML(f) {
  const kind = f.kind || null;
  const subs = (KIND_SUBS[kind] || []).map(id => {
    const on = f.kindSub === id;
    const label = window.AgoraEventTypes.eventTypeLabel(id);
    return `<button class="kind-sub${on ? ' on' : ''}" type="button" data-kind-sub="${id}" style="${kindRoundelStyle(id)}"
        aria-pressed="${on}" aria-label="${esc(label)}" title="${esc(label)}">${on ? esc(label) : esc(label[0])}</button>`;
  }).join('');
  return `<div class="kind-filter">
      <button class="mode-bar-pill kind-cycle${kind ? ' active' : ''}" type="button" data-kind-cycle
        aria-label="${esc(kind ? `${KIND_NAMES[kind]} — tap for the next kind` : 'Any event — tap to narrow by kind')}">
        <span class="mode-bar-pill-label">${esc(kind ? KIND_NAMES[kind] : 'Any event')}</span>
      </button>${subs ? `<span class="kind-subs">${subs}</span>` : ''}
    </div>`;
}

/** "Today", "This week", or the date the stream starts from. */
function whenLabel() {
  if (state._dateFocus) return dateFocusLabel();
  return state._week ? 'This week' : 'Today';
}
function whenControlHTML() {
  const on = !!(state._week || state._dateFocus);
  return `<div class="when-filter">
      <button class="mode-bar-pill when-btn${on ? ' active' : ''}" type="button" data-when-cycle
        aria-label="${esc(state._dateFocus ? `From ${whenLabel()} — tap for today` : state._week ? 'This week — tap for today' : 'Today — tap for this week')}">
        <span class="mode-bar-pill-label">${esc(whenLabel())}</span>
      </button>${on ? `
      <button class="agora-cal-btn when-cal${state._dateFocus ? ' active' : ''}" type="button" data-when-cal
        aria-haspopup="dialog" aria-label="Choose a date" title="Choose a date">
        <img src="https://api.iconify.design/ph:calendar-blank.svg" alt="">
      </button>` : ''}
    </div>`;
}

function bookmarksControlHTML(f) {
  const n = bookmarkCount();
  if (!n && !f.bookmarked) return '';
  return `<button class="mode-bar-pill bookmarks-btn${f.bookmarked ? ' active' : ''}" type="button" data-bookmarks
      aria-pressed="${!!f.bookmarked}" aria-label="Bookmarked events (${n})" title="Bookmarked events">
      <img class="mode-bar-pill-icon" src="https://api.iconify.design/ph:bookmark-simple${f.bookmarked ? '-fill' : ''}.svg" alt="">
      <span class="bookmarks-count">${n}</span>
    </button>`;
}

/** Paint every filter control on the page from the state. */
function renderFilterSlots(root = document) {
  root.querySelectorAll('[data-filter-slot]').forEach(slot => {
    const f = filterSetFor(slot.dataset.filterScope);
    const what = slot.dataset.filterSlot;
    const html = what === 'lang' ? langControlHTML(f)
      : what === 'kind' ? kindControlHTML(f)
      : what === 'when' ? whenControlHTML()
      : bookmarksControlHTML(f);
    if (slot.innerHTML !== html) slot.innerHTML = html;
  });
  const sched = document.getElementById('btn-services');
  if (sched) {
    sched.classList.toggle('active', state.mode === 'services');
    sched.setAttribute('aria-checked', String(state.mode === 'services'));
  }
}
// The names the rest of the app already calls them by.
function syncEnglishButton() { renderFilterSlots(); }
function syncParishFilterPills() { renderFilterSlots(); }
window.agoraSyncParishFilterPills = syncParishFilterPills;

/** Something in a toolbar changed: show it, in the feed or the card it narrows. */
function onFiltersChanged(scope) {
  renderFilterSlots();
  if (scope === 'parish') {
    if (state.parishSheetFocus) refreshParishContentPortion(state.parishSheetFocus);
    return;
  }
  if (state._openEventId && !state.eventSheetId) closeDetailDOM();
  renderCurrentView();
  syncFiltersButton();
  if (typeof renderInViewChip === 'function') renderInViewChip();
  syncURL();
  pulseSaveFilter();
}

/** This week, on or off — shared by the feed and the card, as the date is. */
function setWeek(on) {
  state._week = !!on;
  if (on && state._dateFocus) {
    state._dateFocus = null;
    state._dateFocusPrecision = 'day';
  }
  renderFilterSlots();
  renderDateFocus();
  syncURL();
  pulseSaveFilter();
}

function initFilterControls() {
  document.addEventListener('click', (e) => {
    const slot = e.target.closest('[data-filter-scope]');
    if (!slot) return;
    const scope = slot.dataset.filterScope;
    const f = filterSetFor(scope);
    const hit = (sel) => e.target.closest(sel);
    if (hit('[data-lang-toggle]')) {
      if (f.lang) { f.lang = null; f.langStrict = false; }
      else f.lang = state._lastLang || 'English';
      onFiltersChanged(scope);
    } else if (hit('[data-lang-only]')) {
      f.langStrict = !f.langStrict;
      onFiltersChanged(scope);
    } else if (hit('[data-lang-pick]')) {
      openLangPicker(hit('[data-lang-pick]'), scope);
    } else if (hit('[data-kind-cycle]')) {
      f.kind = KIND_CYCLE[(KIND_CYCLE.indexOf(f.kind || null) + 1) % KIND_CYCLE.length];
      f.kindSub = null;
      onFiltersChanged(scope);
    } else if (hit('[data-kind-sub]')) {
      const id = hit('[data-kind-sub]').dataset.kindSub;
      f.kindSub = f.kindSub === id ? null : id;
      onFiltersChanged(scope);
    } else if (hit('[data-when-cycle]')) {
      if (state._dateFocus) window.clearDateFocus();
      else setWeek(!state._week);
    } else if (hit('[data-when-cal]')) {
      openDatePicker(hit('[data-when-cal]'));
    } else if (hit('[data-bookmarks]')) {
      f.bookmarked = !f.bookmarked;
      onFiltersChanged(scope);
    }
  });
  renderFilterSlots();
}

// The language list: our own, under the button that opened it.
function langPopEl() {
  let pop = document.getElementById('lang-pop');
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'lang-pop';
    pop.className = 'lang-pop hidden';
    pop.setAttribute('role', 'listbox');
    document.body.appendChild(pop);
    pop.addEventListener('click', (e) => {
      const item = e.target.closest('[data-lang-value]');
      if (!item) return;
      const f = filterSetFor(pop._scope);
      const v = item.dataset.langValue;
      if (v) { f.lang = v; state._lastLang = v; }
      else { f.lang = null; f.langStrict = false; }
      closeLangPicker();
      onFiltersChanged(pop._scope);
    });
    document.addEventListener('pointerdown', (e) => {
      if (pop.classList.contains('hidden') || pop.contains(e.target) || e.target.closest('[data-lang-pick]')) return;
      closeLangPicker();
    }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLangPicker(); });
    document.addEventListener('scroll', () => closeLangPicker(), true);
  }
  return pop;
}
function openLangPicker(btn, scope) {
  const pop = langPopEl();
  if (!pop.classList.contains('hidden') && pop._anchor === btn) { closeLangPicker(); return; }
  const f = filterSetFor(scope);
  pop._scope = scope;
  pop._anchor = btn;
  const langs = languagesInUse();
  if (f.lang && !langs.some(l => l.toLowerCase() === f.lang.toLowerCase())) langs.unshift(f.lang);
  pop.innerHTML = `<button type="button" class="lang-item" data-lang-value="">Any language</button>`
    + langs.map(l => `<button type="button" class="lang-item${f.lang && l.toLowerCase() === f.lang.toLowerCase() ? ' on' : ''}" role="option" data-lang-value="${esc(l)}">${esc(l)}</button>`).join('');
  pop.classList.remove('hidden');
  const r = btn.getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = `${Math.max(8, Math.min(r.left - 40, innerWidth - w - 8))}px`;
  pop.style.top = `${r.bottom + h + 8 > innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6}px`;
}
function closeLangPicker() {
  const pop = document.getElementById('lang-pop');
  if (pop && !pop.classList.contains('hidden')) { pop.classList.add('hidden'); pop._anchor = null; }
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
    setActive('btn-services', false);
  } else {
    setActive('btn-services', state.mode === 'services');
  }
  syncClearFilters();
}

// ── Reset FAB (top center) ──
function hasActiveFilters() {
  return state.filters.jurisdiction || state.filters.location || state.filters.service ||
    state.filters.day != null || state.filters.part || state.filters.parishIds || state.filters.kind ||
    state.filters.lang || state.filters.bookmarked || state.parishFocus || state.filters.multiParish;
}

/**
 * The top filter bar's "Clear all": there whenever the feed is narrowed by
 * anything clearAllFilters takes away — a jurisdiction, a region, parishes,
 * a service, a day, a part of it, Socials or Services, a language, a date.
 * Not for the parish an open card picked: closing the card is how that goes.
 */
function anyFilterToClear() {
  const f = state.filters;
  const picked = f.parishIds && f.parishIds.size
    && !(state.parishFocus && f.parishIds.size === 1 && f.parishIds.has(state.parishFocus));
  return !!(f.jurisdiction || f.location || f.service || f.day != null || f.part || picked
    || f.kind || f.lang || f.bookmarked || state._dateFocus || state._week || state.mode === 'services');
}
function syncClearFilters() {
  const btn = document.getElementById('btn-clear-filters');
  if (btn) btn.hidden = !anyFilterToClear();
}

// "Show all" FAB clears two things only: jurisdiction chip + current parish
// selection (while staying in multi-parish mode). It's visible whenever either
// is set — social/English/focus toggles don't count.
function hasResettableScope() {
  return !!(state.filters.jurisdiction || state.filters.location
    || (state.filters.parishIds && state.filters.parishIds.size));
}

// The "Show all" fab is gone — Clear all in the toolbar is the way back to
// everything, and the parish counter is the way to the parishes in view — so
// this keeps the name its many callers use and syncs what is left.
function syncResetFab() {
  syncFilterActiveStack();
  renderInViewChip();
  syncClearFilters();
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
  state.filters.part = null;
  state.parishScheduleFocus = null;
  state.filters.parishIds = null;
  state.filters.showAllParishes = null;
  Object.assign(state.filters, blankFilterFlags());
  state._week = false;
  state.parishFocus = null;
  // "Clear all" means the whole feed from today. Leaving the stream wound on to
  // March while every chip said the filters were gone would read as a bug.
  state._dateFocus = null;
  state._dateFocusPrecision = 'day';
  if (wasServices) {
    state.mode = 'events';
    const servicesBtn = document.getElementById('btn-services');
    if (servicesBtn) servicesBtn.classList.remove('active');
    showView('events');
  }
  document.querySelectorAll('.jurisdiction-chip').forEach(c => c.classList.remove('active'));
  renderFilterSlots();
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
  // Clear all (the toolbar's, and the one in the filter stack over the map),
  // whether or not the old Show all fab is in the page.
  const clearBtn = document.getElementById('filter-clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', e => { e.stopPropagation(); clearAllFilters(); });
  }
  const barClear = document.getElementById('btn-clear-filters');
  if (barClear) {
    barClear.addEventListener('click', e => { e.stopPropagation(); clearAllFilters(); syncClearFilters(); });
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
  } else if (kind === 'part') {
    state.filters.part = null;
  } else if (kind === 'kind') {
    // The feed banner's ×. It takes away what the banner alone stands for —
    // which service, which day, which part of it — and leaves the
    // jurisdiction and the region, which have controls of their own and which
    // the sentence only names so it reads whole.
    state.filters.service = null;
    state.filters.day = null;
    state.filters.part = null;
  } else if (kind === 'eventkind') {
    state.filters.kind = null;
    state.filters.kindSub = null;
    renderFilterSlots();
  } else if (kind === 'bookmarks') {
    state.filters.bookmarked = false;
    renderFilterSlots();
  } else if (kind === 'english') {
    state.filters.lang = null;
    state.filters.langStrict = false;
    renderFilterSlots();
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

// ── Feed banner ──
//
// "Showing Antiochian evening Liturgies in Queensland" — the main feed's
// counterpart of the banner a parish card shows under /sgr/liturgy, for the
// filters only a link can set: a service, a day, a part of the day. Each has
// a chip in the stack over the map, but the chips sit beside the map and the
// list does not, so a feed narrowed to one kind of service read as the whole
// feed with most of it missing — the reason the parish card grew its banner.
//
// The jurisdiction and the region are named so the sentence reads whole, and
// are not what its × takes away (clearOneFilter('kind')): they have controls
// of their own, and the parish card's × likewise leaves you at the parish.
function feedFilterSentence() {
  const f = state.filters;
  if (!f.service && f.day == null && !f.part) return '';
  const juris = f.jurisdiction ? capitalize(f.jurisdiction) : '';
  const day = f.day != null ? dayNameFor(f.day) : '';
  // A service names the noun; without one the schedules view lists services
  // and the events view lists everything, socials included.
  const kind = f.service ? servicePluralFor(f.service)
    : (state.mode === 'services' ? 'services' : 'events');
  const where = f.location ? ` in ${locationLabel() || f.location}` : '';
  return [juris, day, f.part || '', kind].filter(Boolean).join(' ') + where;
}

function syncFeedFilterBanner() {
  const el = document.getElementById('feed-filter-banner');
  if (!el) return;
  const sentence = feedFilterSentence();
  el.hidden = !sentence;
  if (!sentence) {
    el.replaceChildren();
    return;
  }
  // Jurisdiction-coloured when there is one, as the parish card's is
  // parish-coloured: it is what the feed is scoped to. The accent otherwise.
  const j = state.filters.jurisdiction;
  if (j) el.style.setProperty('--parish-color', getParishDisplayColor(rawJurisColor(j)));
  else el.style.removeProperty('--parish-color');
  el.innerHTML = `<span class="ps-focus-banner-text">Showing ${esc(sentence)}</span>
    <button class="ps-focus-banner-x" type="button" data-feed-filter-clear aria-label="Show every service">&times;</button>`;
}

function initFeedFilterBanner() {
  const el = document.getElementById('feed-filter-banner');
  if (!el) return;
  el.addEventListener('click', (e) => {
    if (!e.target.closest('[data-feed-filter-clear]')) return;
    e.stopPropagation();
    clearOneFilter('kind');
  });
  syncFeedFilterBanner();
}

function syncFilterActiveStack() {
  syncFeedFilterBanner();
  const stack = document.getElementById('filter-active-stack');
  if (!stack) return;
  // Each filter is now { kind, label } so the rendered chip can carry the
  // clearer wired to its specific filter key.
  const chips = [];
  if (state.filters.jurisdiction) chips.push({ kind: 'jurisdiction', label: capitalize(state.filters.jurisdiction) });
  if (state.filters.location) chips.push({ kind: 'location', label: locationLabel() || state.filters.location });
  if (state.filters.day != null) chips.push({ kind: 'day', label: dayNameFor(state.filters.day) });
  if (state.filters.part) chips.push({ kind: 'part', label: partLabelFor(state.filters.part) });
  if (state.filters.service) chips.push({ kind: 'service', label: serviceLabelFor(state.filters.service) });
  if (state.filters.kind) {
    chips.push({ kind: 'eventkind', label: state.filters.kindSub
      ? window.AgoraEventTypes.eventTypeLabel(state.filters.kindSub) : KIND_NAMES[state.filters.kind] });
  }
  if (state.filters.bookmarked) chips.push({ kind: 'bookmarks', label: 'Bookmarked' });
  if (state.filters.lang) {
    // The language button's own words: "English", and "English only" once
    // its "only" is on.
    chips.push({ kind: 'english', label: state.filters.langStrict ? `${state.filters.lang} only` : state.filters.lang });
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
  if (state.filters.jurisdiction) {
    // The chips filtered in SQL until the lens moved the feed into the browser,
    // and then nothing filtered at all: /api/bundle has no jurisdiction param,
    // so the whole country kept arriving and this function never learned the
    // axis. The map and the parish pills read state.filters.jurisdiction
    // directly and carried on working, which is what made the feed look like
    // the only thing ignoring the chip.
    //
    // An event is in the jurisdiction if any parish showing it is, for the same
    // reason the location filter below says so: a combined service listed under
    // a Greek and an Antiochian parish is genuinely both parishes' service, and
    // belongs under either chip.
    filtered = filtered.filter(e =>
      e.jurisdiction === state.filters.jurisdiction ||
      (e.extra_parishes && e.extra_parishes.some(pid => parishIdPassesJurisdiction(pid)))
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
  if (state.filters.part) {
    filtered = filtered.filter(e => partOfDayOfRow(e) === state.filters.part);
  }
  // The toolbar's kind, language and bookmarks (eventPassesFlags), and This
  // week: the next seven days and no further.
  filtered = filtered.filter(e => eventPassesFlags(e, state.filters));
  if (state._week) {
    const end = weekEndMs();
    filtered = filtered.filter(e => Date.parse(e.start_utc) < end);
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
      if (focus.part && partOfDayOfRow(e) !== focus.part) return false;
      return true;
    });
  }
  out = out.filter(e => eventPassesFlags(e, f));
  if (state._week) {
    const end = weekEndMs();
    out = out.filter(e => Date.parse(e.start_utc) < end);
  }
  return out;
}

// The card's timetable answers the card's toolbar too: its kind and its
// language, as the main Schedules view answers the main one (timetable.js).
// Bookmarks are of events, so a rule is never left out for them.
function filterParishSchedulesBySession(schedules) {
  const f = state.parishFilters;
  const T = window.AgoraTimetable;
  const lf = T.langFilterOf(f);
  if (!f.kind && !lf) return schedules;
  return schedules.filter(s => T.kindMatches(s, f)
    && (!lf || T.langsMatch(parseLangs(s.languages) || parseLangs(s.parish_languages), lf)));
}

// ── Bottom sheet ──
function initBottomSheet() {
  const sheet = document.getElementById('bottom-sheet');
  const handle = document.querySelector('.map-grab-handle');
  const modeBar = document.getElementById('mode-bar');
  const scroll = document.getElementById('sheet-scroll');
  const fab = document.getElementById('location-fab');
  const filterFab = document.getElementById('btn-filters');
  const shareFab = document.getElementById('mode-url');
  const isDesktop = () => window.agoraIsDesktop?.() ?? false;
  // All sheet-following FABs share the lifecycle — fade during drag, snap
  // to (currentY - 52) on settle. Keeping them in an array lets the drag /
  // snap handlers iterate once instead of duplicating every touchpoint.
  const trackedFabs = [fab, filterFab, shareFab].filter(Boolean);
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

  // Recalculate on resize/orientation change — at the SAME snap. The old
  // nearest-y guess measured a landscape offset against portrait snaps, so a
  // phone turned and turned back could leave the sheet at full or peek, with
  // the buttons that follow it still where landscape put them.
  window.addEventListener('resize', () => {
    // Under an open parish card the sheet is parked off the bottom, and the
    // snap it goes back to is the stashed one: that is what moves to the new
    // geometry, and the sheet stays parked.
    const parked = _stashedY != null;
    const name = isDesktop() ? null : snapNameOf(parked ? _stashedY : currentY);
    computeSnaps();
    if (isDesktop()) return;
    const at = { full: SNAP_FULL, half: SNAP_HALF, peek: SNAP_PEEK }[name];
    if (parked) {
      _stashedY = at;
      currentY = window.innerHeight;
      sheet.style.transform = `translateY(${currentY}px)`;
      return;
    }
    currentY = at;
    sheet.style.transform = `translateY(${currentY}px)`;
    document.body.classList.toggle('map-expanded', currentY >= SNAP_HALF - 5);
    sheet.classList.toggle('peeking', currentY >= SNAP_PEEK - 8);
    if (!window.agoraParishSheetVisible) {
      trackedFabs.forEach(f => { f.style.top = (currentY - 52) + 'px'; });
      positionFilterStack(currentY);
    }
    document.documentElement.style.setProperty('--sheet-cover', (window.innerHeight - currentY) + 'px');
    updateScrollLock();
  });

  /** 'full', 'half' or 'peek': where the sheet rests, by name. */
  function snapNameOf(y) {
    return [['full', SNAP_FULL], ['half', SNAP_HALF], ['peek', SNAP_PEEK]]
      .reduce((best, s) => (Math.abs(s[1] - y) < Math.abs(best[1] - y) ? s : best))[0];
  }

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
  // Page mode is a still panel too: no snaps, no drag, no transform — the
  // same path the desktop layout already takes.
  const isDesktop = () => (window.agoraIsDesktop?.() ?? false)
    || document.body.classList.contains('page-mode');
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

  // A rotation keeps the sheet at the snap it was at, as the main sheet's
  // does, and brings along what follows it; the parish's name is fitted again
  // to the new width (fitParishName shrinks it to two lines, and a size
  // chosen for landscape overflows portrait).
  window.addEventListener('resize', () => {
    const open = !sheet.classList.contains('hidden') && currentY !== SNAP_HIDDEN;
    const name = open && !isDesktop()
      ? [['full', SNAP_FULL], ['half', SNAP_HALF], ['peek', SNAP_PEEK]]
        .reduce((best, s) => (Math.abs(s[1] - currentY) < Math.abs(best[1] - currentY) ? s : best))[0]
      : null;
    computeSnaps();
    const nameEl = document.querySelector('#parish-sheet-content .ps-name');
    if (nameEl) fitParishName(nameEl);
    if (isDesktop()) return;
    if (!open) {
      currentY = SNAP_HIDDEN;
      sheet.style.transform = `translateY(${currentY}px)`;
      return;
    }
    currentY = { full: SNAP_FULL, half: SNAP_HALF, peek: SNAP_PEEK }[name];
    sheet.style.transform = `translateY(${currentY}px)`;
    updateScrollLock();
    if (window.agoraParishSheetVisible) {
      psTrackedFabs.forEach(f => { f.style.top = (currentY - 52) + 'px'; });
      const filterStack = document.getElementById('filter-active-stack');
      if (filterStack) filterStack.style.bottom = (window.innerHeight - currentY + 60) + 'px';
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

  // The add-an-event button. Bound once here rather than re-bound on every
  // render, and it reads the parish off its own dataset — syncParishAddEventFab
  // is the one place that decides which parish it belongs to and whether it is
  // there at all.
  const addFab = document.getElementById('parish-add-event-fab');
  if (addFab) {
    addFab.addEventListener('click', () => {
      const pid = addFab.dataset.parishId;
      if (pid) window.openNewEventDialog(pid);
    });
  }

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
    state._parishEventsShowCount = SHOW_COUNT_STEP;
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
    syncParishAddEventFab();
    state.parishFilters = blankFilterFlags();
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
    syncParishAddEventFab();
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

/**
 * "Showing from 4/10/2026" — the same banner shape the schedule focus uses,
 * because it is the same kind of statement: this list is narrower than the
 * parish, and here is the one thing narrowing it, with the way out beside it.
 * Two banners can stand together — a rule focus wound forward to March is both.
 */
function dateFocusBannerHtml(parish) {
  if (!state._dateFocus) return '';
  const accent = getParishDisplayColor((parish && parish.color) || rawJurisColor(parish && parish.jurisdiction));
  return `<div class="ps-focus-banner ps-date-banner" style="--parish-color:${esc(accent)}">
      <span class="ps-focus-banner-text">Showing from ${esc(dateFocusLabel())}</span>
      <button class="ps-focus-banner-x" type="button" data-date-focus-clear aria-label="Back to the whole feed">&times;</button>
    </div>`;
}

/**
 * Keep the parish sheet's banner and calendar button in step with a focus set
 * from somewhere else — the mode bar, a deep link, the picker in the footer.
 * A full re-render would do it too, and would throw away the user's expanded
 * card and scroll position to say one sentence.
 */
function syncParishDateBanner() {
  const contentEl = document.getElementById('parish-sheet-content');
  if (!contentEl || !contentEl._psParishId) return;
  const parish = state.parishes.find(p => p.id === contentEl._psParishId);
  const existing = contentEl.querySelector('.ps-date-banner');
  if (!state._dateFocus) {
    if (existing) existing.remove();
  } else {
    const html = dateFocusBannerHtml(parish);
    if (existing) {
      existing.outerHTML = html;
    } else {
      const list = contentEl.querySelector('.ps-events-list');
      if (list) list.insertAdjacentHTML('beforebegin', html);
    }
    const x = contentEl.querySelector('[data-date-focus-clear]');
    if (x) x.addEventListener('click', e => { e.stopPropagation(); window.clearDateFocus(); });
  }
  contentEl.querySelectorAll('.agora-cal-btn').forEach(b => {
    b.classList.toggle('active', !!state._dateFocus);
    const label = b.querySelector('.cal-btn-label');
    if (label) label.textContent = state._dateFocus ? `From ${dateFocusLabel()}` : '';
  });
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
    const part = focus.part || '';
    const kind = focus.slug ? servicePluralFor(focus.slug) : 'services';
    return [day, part, kind].filter(Boolean).join(' ');
  }
  const day = womDescribeDay(rule);
  const part = partOfDay(rule.start_time);
  const title = rule.title || (focus.slug ? serviceLabelFor(focus.slug) : 'service');
  const langs = describeLanguages(rule.languages);
  return [day, part, title].filter(Boolean).join(' ') + (langs ? ` in ${langs}` : '');
}

/** "Sunday", "1st and 3rd Saturday", or "alternate Sundays". */
function womDescribeDay(rule) {
  const day = DAYS[rule.day_of_week] || '';
  // "Alternate Sundays" is how a parish writes it, and it is what the
  // ingestion notes found on the pages this exists for.
  if (rule.week_parity) return `alternate ${day}s`;
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


function openParishSheet(parishId, opts = {}) {
  if (_parishSheetAPI) _parishSheetAPI.open(parishId, opts);
  // Opening a parish while a service filter is on narrows to that parish's
  // own rule of that kind. Otherwise the URL and the view disagree: the path
  // reads /sgr/liturgy either way, and re-opening it would give the rule
  // focus while the live view still showed every liturgy at the parish.
  // filters.service survives, so closing the sheet returns to /liturgy.
  if ((state.filters.service || state.filters.day != null || state.filters.part) && !state.parishScheduleFocus
      && !opts.noServiceFocus && state.parishSheetFocus === parishId) {
    // Schedules are only loaded by the services view and (lazily) by the
    // sheet itself, so the events view reaches here with none — hence the
    // wait, and the re-check afterwards in case the user moved on meanwhile.
    ensureSchedulesLoaded().then(() => {
      if (state.parishSheetFocus !== parishId || state.parishScheduleFocus) return;
      const rules = matchingRules(parishId, state.filters.service, state.filters.day, state.filters.part);
      if (!rules.length) return;
      setParishScheduleFocus(parishId, {
        ruleIds: rules.map(r => r.id),
        slug: state.filters.service,
        dow: state.filters.day,
        part: state.filters.part,
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
  // Out of page mode first, so the sheet is measured as a sheet again and
  // slides away over the map like any other.
  exitPageMode();
  // Editing belongs to the sheet. Leaving it with the mode still set would
  // mean the next parish opened — or the same one re-opened — came up with a
  // form already spread open, which is the surprise this mode exists to end.
  //
  // Clearing the flag is not enough on its own. Re-opening the SAME parish
  // takes renderParishSheetContent's fast path, which refreshes the events and
  // the timetable and deliberately leaves the header and the actions row as
  // they were — so the sheet came back reading "Done" with the mode already
  // off. Dropping the cached id makes that one re-open a full render.
  if (state.parishEditMode) {
    state.parishEditMode = null;
    // A staged pin is part of the unsaved form and goes with it. Left behind,
    // it would be offered again the next time this parish is edited, as if it
    // had been decided rather than abandoned.
    clearPinDraft();
    const contentEl = document.getElementById('parish-sheet-content');
    if (contentEl) contentEl._psParishId = null;
  }
  // The schedule focus belongs to the sheet — it is "this rule at this
  // parish", and there is nowhere to show it once the parish is gone. The
  // pinned occurrence goes with it: it was the focus's, not the user's, and
  // leaving it behind writes an event id into a URL nobody asked for.
  if (state.parishScheduleFocus) {
    state.parishScheduleFocus = null;
    state._openEventId = null;
  }
  // An event open when the card closes closes with it — the one in the card,
  // and its copy in the feed behind, which close() would otherwise re-open.
  // Not when the URL is doing the closing: Back from /sgr to /42:2026-10-18
  // means the event stays open where the URL now says.
  if (!_reconciling && state._openEventId) {
    clearEventEditMode();
    delete state._openEventId;
    collapseEventCardDOM({ instant: true });
  }
  state._pinnedEventId = null;
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
      renderStream(streamEl, parishEvents, { parishMode: true, groupByParish: true, omitNow: true, showCount: state._parishEventsShowCount || 30 });
      renderParishNow(contentEl, parishEvents);
    } else {
      streamEl.replaceChildren();
    }
  }

  // Schedule card refresh — recompute scheds + EN filter, replace inner.
  // Mount the section if it didn't exist. Always present, even with no rules:
  // a parish with no times on file is the one somebody opens to fix.
  const scheds = filterParishSchedulesBySession(
    (state.schedules || [])
      .filter(s => s.parish_id === parishId)
      .sort((a, b) => a.day_of_week - b.day_of_week)
  );
  const existingSection = contentEl.querySelector('.ps-sched-section');
  const innerHTML = parishTimetableHTML(parish, scheds);
  if (existingSection) {
    existingSection.innerHTML = innerHTML;
  } else if (streamEl) {
    const sec = document.createElement('div');
    sec.className = 'ps-section ps-sched-section';
    sec.innerHTML = innerHTML;
    // Under the card's toolbar, which narrows it, and above the events list.
    const row = contentEl.querySelector('.ps-filter-row');
    const anchor = row ? row.nextSibling : streamEl;
    (row || streamEl).parentNode.insertBefore(sec, anchor);
  }

  if (state.isAdmin) wireScheduleAdminHandlers(contentEl);

  // The banner and the calendar button live outside .ps-events-list, so the
  // partial refresh above leaves them as they were — including after a focus
  // set from the mode bar, a deep link, or the back button.
  syncParishDateBanner();

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

/**
 * Paint the parish sheet, keeping the reader where they were.
 *
 * A full rebuild replaces the sheet's whole content, and a scroller whose
 * content is replaced lands at the top — so every save that re-renders (a rule,
 * an occurrence, edit mode on or off, a focus set or cleared) threw somebody
 * back to the parish's name from wherever they were working. The partial path
 * already kept its place; this makes the full one keep it too.
 *
 * Only for the SAME parish. Opening a different one starts at its top, which
 * is where a new sheet should start. Restored synchronously and not in a frame:
 * a caller that deliberately scrolls afterwards (entering edit mode brings the
 * form into view) must win over the restore, not be undone by it a frame later.
 */
function renderParishSheetContent(parishId, opts = {}) {
  const scrollEl = document.getElementById('parish-sheet-scroll');
  const contentEl = document.getElementById('parish-sheet-content');
  const sameParish = !!(contentEl && contentEl._psParishId === parishId);
  const top = scrollEl ? scrollEl.scrollTop : 0;
  // Whatever somebody was typing survives the rebuild too — see snapshotTyped.
  const typed = sameParish ? snapshotTyped(contentEl) : null;
  paintParishSheetContent(parishId, opts);
  if (typed) restoreTyped(contentEl, typed);
  if (sameParish && scrollEl && scrollEl.scrollTop !== top) scrollEl.scrollTop = top;
}

/**
 * What somebody has typed and not saved, so a rebuild can put it back.
 *
 * Uploading a logo or a poster lands mid-edit, and both re-render what they
 * belong to — the sheet's header, the event's drawer — which rebuilt every form
 * around them from the stored row and threw away the title, the times, the
 * address somebody was halfway through. Only fields that DIFFER from what was
 * rendered are kept, so a value the save just changed underneath is not
 * overwritten with the stale copy the user never touched.
 *
 * Keyed by id, which both the parish form and the event form carry, and for a
 * rule's form by its rule id plus field — those have no ids, because the same
 * rule renders in two places at once.
 */
function snapshotTyped(root) {
  const out = new Map();
  if (!root) return out;
  root.querySelectorAll('input, textarea, select').forEach(el => {
    if (el.type === 'file' || el.type === 'hidden') return;
    const key = typedKey(el);
    if (!key) return;
    let dirty;
    if (el.type === 'checkbox' || el.type === 'radio') dirty = el.checked !== el.defaultChecked;
    else if (el.tagName === 'SELECT') dirty = [...el.options].some(o => o.selected !== o.defaultSelected);
    else dirty = el.value !== el.defaultValue;
    if (dirty) out.set(key, (el.type === 'checkbox' || el.type === 'radio') ? { checked: el.checked } : { value: el.value });
  });
  // Which rule forms were open, so the one being typed into stays open.
  root.querySelectorAll('.schedule-edit-form[data-sid]').forEach(f => {
    if (f.style.display !== 'none') out.set(`open:${f.dataset.sid}`, true);
  });
  return out;
}

function typedKey(el) {
  if (el.id) return `#${el.id}`;
  const form = el.closest('.schedule-edit-form[data-sid]');
  const f = el.dataset.f || el.dataset.af;
  if (form && f) return `sid:${form.dataset.sid}:${f}:${el.value && el.type === 'radio' ? el.value : ''}`;
  const add = el.closest('.schedule-add');
  if (add && el.dataset.af) return `add:${add.dataset.parishId}:${el.dataset.af}`;
  return null;
}

function restoreTyped(root, snap) {
  if (!root || !snap || !snap.size) return;
  root.querySelectorAll('input, textarea, select').forEach(el => {
    const v = snap.get(typedKey(el));
    if (!v) return;
    if ('checked' in v) el.checked = v.checked;
    else el.value = v.value;
  });
  root.querySelectorAll('.schedule-edit-form[data-sid]').forEach(f => {
    if (!snap.get(`open:${f.dataset.sid}`)) return;
    f.style.display = '';
    const row = f.previousElementSibling;
    if (row) { row.classList.add('editing-open'); row.setAttribute('aria-expanded', 'true'); }
  });
}

function paintParishSheetContent(parishId, opts = {}) {
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

  // Where these details came from and how old they are, in the same words the
  // service-times line below uses — one source line, rendered once, so the two
  // halves of a parish sheet stop describing their provenance differently.
  const srcHtml = sourceLineHTML(
    parish.info_source_name, parish.info_source_ref, parish.info_checked_at, 'ps-source');

  // Opens the PLACE, not a route. Starting navigation from a tap was a
  // commitment most readers were not making — they wanted to see where it is —
  // and Google's own page has Directions one tap further on. The parish's own
  // Maps entry when somebody has picked one (its name, photos, the entrance
  // Google routes to); the pin otherwise.
  const mapsHref = parishMapsHref(parish);
  const dirBtn = mapsHref
    ? `<a class="ps-btn ps-btn-primary" href="${esc(mapsHref)}" target="_blank" rel="noopener">${glyph(PARISH_BTN_GLYPH.maps)}<span>Google Maps</span></a>`
    : '';
  const webBtn = parish.website
    ? `<a class="ps-btn" href="${esc(parish.website)}" target="_blank" rel="noopener">${glyph(PARISH_BTN_GLYPH.website)}<span>Website</span></a>`
    : '';
  const phoneBtn = parish.phone
    ? `<a class="ps-btn" href="tel:${esc(parish.phone)}">${glyph(PARISH_BTN_GLYPH.phone)}<span>Call</span></a>`
    : '';
  const watchBtn = parish.live_url
    ? `<a class="ps-btn" href="${esc(parish.live_url)}" target="_blank" rel="noopener">Watch Live</a>`
    : '';
  const donateBtn = parish.donation_url
    ? `<a class="ps-btn ps-donate-btn" href="${esc(parish.donation_url)}" target="_blank" rel="noopener"><img class="ps-btn-icon" src="https://api.iconify.design/ph:hand-heart.svg" alt=""><span>Donate</span></a>`
    : '';
  const shareParishBtn = `<button class="ps-btn ps-share-btn" type="button" data-share-parish="${esc(parishId)}"><img class="ps-btn-icon" src="https://api.iconify.design/ph:paper-plane-tilt.svg" alt=""><span>Share</span></button>`
    + favouriteButtonHTML(parishId);
  // A parish's own links, beside the buttons the four columns produce. Named
  // by their label and not by their slug: the slug is a URL and a URL is not a
  // name, which is the same reasoning info_source_name carries.
  const customLinkBtns = (state.parishLinks || [])
    .filter(l => l.parish_id === parishId && l.url)
    .map(l => `<a class="ps-btn" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label || l.slug)}</a>`)
    .join('');

  // Is this sheet being edited? Read once, high up, because it decides three
  // separate things further down — the admin row, the timetable's pencils and
  // whether the avatar is a logo control — and a second copy taken later is
  // how one of them ends up disagreeing.
  //
  // The avatar was a logo button whenever somebody was signed in, which put a
  // pencil on a parish's face on every sheet an admin ever opened.
  // The sheet itself is never edited in place any more: "Edit details" opens
  // the edit dialog (openParishDetailsDialog), and the sheet stays the sheet
  // a visitor reads, behind it. The branches below that build the in-place
  // controls are what the dialog is built from.
  const psEditing = false;

  // Admin controls. Both follow the MODE, not a local toggle.
  //
  // Edit mode no longer opens a form under the sheet. Each thing the sheet
  // shows turns into the control that edits it, where it already is — the name
  // into a name field, the address into an address field, each action pill
  // gains a pencil for the link behind it — so the sheet being edited is
  // recognisably the sheet being read. The service times are a separate mode
  // with their own pencil (parishTimetableHTML): editing a phone number and
  // editing a timetable are different jobs, usually by different people.
  let parishAdminHtml = '';
  if (state.isAdmin && adminMay('parish.edit', parishId)) {
    const pid = esc(parishId);
    parishAdminHtml = `
      <div class="ps-actions ps-admin-actions${psEditing ? ' ps-edit-in' : ''}"${psEditing ? ' style="--i:8"' : ''}>
        <button class="ps-btn ${psEditing ? 'ps-btn-admin ps-editing' : 'ps-btn-ghost'}" type="button"
                aria-pressed="${psEditing}"
                ${psEditing ? 'data-parish-save' : ''}
                onclick="${psEditing ? `finishParishEdit('${pid}', this)` : `setParishEditMode('${pid}', true)`}">
          ${glyph(psEditing ? 'ph:check' : 'ph:pencil-simple')}${psEditing ? 'Save' : 'Edit details'}
        </button>
        ${psEditing ? `<button class="ps-btn ps-btn-ghost" type="button" onclick="setParishEditMode('${pid}', false)">Cancel</button>` : ''}
        ${psEditing && adminMay('parish.delete', parishId) ? `<button class="ps-btn ps-btn-danger ps-delete-parish" type="button" onclick="deleteParish('${pid}')">${glyph('ph:trash')}Delete parish</button>` : ''}
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
  // Shown even with no rules: a parish whose times have never been entered is
  // exactly the one somebody opens this to fix — with the pencil, or with
  // "Suggest edits" under the source line for somebody who cannot.
  const schedSectionHtml = `
      <div class="ps-section ps-sched-section">${parishTimetableHTML(parish, scheds)}</div>`;

  // Upcoming events across the same window as the main list. Prefer the
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
  // …or one handed over from an expanded event's parish button, pinned
  // collapsed (openParishFromEvent): it stays pinned across re-renders.
  const focusEventId = opts.focusEventId ?? state._openEventId ?? state._pinnedEventId ?? null;
  const focusedEvent = (focusEventId
    ? parishEvents.find(e => e.id === focusEventId)
    : null) || (focusEventId ? null : dateFocusPinFor(parishEvents));
  // Stream includes the focused event too so the user sees it in day-context.
  // Pinned copy is the expanded "highlight"; stream copy stays collapsed by
  // default. Tapping either expands that specific card and collapses the
  // other (handled in expandEventCard via opts.card + same-scope collapse).
  const streamEvents = parishEvents;

  const avatar = parishAvatarParts(parish);
  contentEl.innerHTML = `
    <div class="ps-header${psEditing ? ' ps-header-editing' : ''}">
      <${psEditing ? 'button type="button" data-logo-edit' : 'div'} class="ps-avatar${psEditing ? ' editing' : ''}${avatar.cls}" style="${avatar.style}--parish-glow:${esc(hexToRgba(color, 0.45))}">${avatar.inner}${psEditing ? `<span class="ps-avatar-edit">${glyph('ph:pencil-simple-fill')}</span>` : ''}</${psEditing ? 'button' : 'div'}>
      ${psEditing ? parishHeaderEditHTML(parish) : `
      <div class="ps-header-info">
        <div class="ps-name">${esc(displayName)}</div>
        <div class="ps-meta">${esc(juris)} Orthodox${distHtml}</div>
      </div>
      <button class="ps-url" id="ps-url" type="button" aria-label="Copy page URL">
        <span class="ps-url-text" id="ps-url-text"></span>
        <img class="ps-url-copy" src="https://api.iconify.design/ph:copy.svg" alt="">
      </button>`}
    </div>
    ${contactGuideHTML(parish)}
    ${focusedEvent ? '<div class="ps-pinned-event" id="ps-pinned-event"></div>' : ''}
    ${psEditing ? parishDetailsEditHTML(parish, { srcHtml, parishAdminHtml }) : `
    <div class="ps-section">
      ${addrHtml}
      ${webCopyHtml}
      ${srcHtml}
      ${contributeButtonHTML(parish)}
      <div class="ps-actions" style="--parish-color:${esc(color)}">${dirBtn}${webBtn}${phoneBtn}${watchBtn}${donateBtn}${customLinkBtns}${shareParishBtn}</div>
      ${parishAdminHtml}
    </div>`}
    <div class="ps-now"></div>
    <!-- The card's toolbar: the main sheet's controls, built by the same
         builders (filterControlsHTML), over the card's own filter set
         (state.parishFilters). Above the service times, because the kind and
         the language narrow the timetable too; the When control is shared. -->
    <div class="ps-filter-row" id="ps-filter-row">
      <div class="ps-filter-line">
        <div class="filter-slot" data-filter-slot="lang" data-filter-scope="parish"></div>
      </div>
      <div class="ps-filter-line">
        <div class="filter-slot" data-filter-slot="kind" data-filter-scope="parish"></div>
        <div class="filter-slot" data-filter-slot="bookmarks" data-filter-scope="parish"></div>
        <div class="filter-slot" data-filter-slot="when" data-filter-scope="parish"></div>
      </div>
    </div>
    ${schedSectionHtml}
    ${feedHeaderHTML(parish)}
    ${scheduleFocusBannerHtml(parish)}
    ${dateFocusBannerHtml(parish)}
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
            // The pinned card opens the event itself, in its own sheet, and
            // the parish card goes: the person came here from the event and
            // is going back to it.
            const id = focusedEvent.id;
            closeParishSheet();
            openEventSheet(id);
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
        const wasDatePin = isDateFocusPin(focusedEvent.id);
        if (wasDatePin) state._dateFocusPin.dismissed = true;
        delete state._openEventId;
        const wasHanded = state._pinnedEventId != null;
        state._pinnedEventId = null;
        collapseEventCardDOM();
        syncURL();
        // Full, so the pinned slot itself goes; the partial refresh leaves it.
        if (pid) renderParishSheetContent(pid, (wasDatePin || wasHanded) ? { fullRender: true } : {});
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

  // Same for "Showing from 4/10/2026" — the feed widens back to today.
  const dateX = contentEl.querySelector('[data-date-focus-clear]');
  if (dateX) dateX.addEventListener('click', e => { e.stopPropagation(); window.clearDateFocus(); });

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

  if (psEditing) wireParishDetailsEdit(contentEl, parishId);

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

  // The card's toolbar (filter slots): the delegated listener in
  // initFilterControls answers it; this paints it.
  renderFilterSlots(contentEl);
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
      renderStream(streamEl, streamEvents, { parishMode: true, groupByParish: true, omitNow: true, showCount: state._parishEventsShowCount || 30 });
      renderParishNow(contentEl, streamEvents);
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
    // Open before this paint, and not a fresh focus asked for by the caller:
    // the re-expand below is restoring state, not answering a tap.
    const restoring = (!!state._openEventId && !opts.focusEventId) || !!opts.scrollToFeed;
    if (opts.focusEventId && !state._openEventId && !opts.pinCollapsed) {
      state._openEventId = opts.focusEventId;
    }
    if (state._openEventId && scopeEl) {
      const inPinned = focusedEvent && focusedEvent.id === state._openEventId;
      const inStream = (streamEvents || []).some(e => e.id === state._openEventId);
      if (inPinned || inStream) {
        // The copy that was open before this paint, so a re-render — entering
        // edit mode is one — brings the drawer back where it was tapped. The
        // pinned copy otherwise, which is where a deep link opens it.
        const preferred = cardInSlot(scopeEl, state._openEventId, state._openEventSlot)
          || scopeEl.querySelector(
            '.ps-pinned-event .event-card[data-id="' + state._openEventId + '"]'
          );
        // Synchronous expand on first render — no rAF — so the user
        // doesn't see the collapsed-card frame before the expand.
        // Subsequent re-renders are routed through refreshParishContentPortion
        // which keeps the pinned event intact (no destroy → re-expand cycle).
        expandEventCard(state._openEventId, { scope: scopeEl, card: preferred || undefined, keepScroll: restoring });
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

  // Async: fetch the SAME window as the main list, so a parish card reaches as
  // far as the feed behind it — it used to ask for 28 days flat, which is why
  // its Load more ran out weeks before the main feed's did. Lower bound is
  // start-of-today-Sydney (matches fetchEvents) so currently-underway events
  // still come back. Skip if the caller already provided parishEvents.
  if (!opts.parishEvents) {
    const from = startOfTodayUtcIso();
    const to = new Date(Date.now() + eventsHorizonDays() * 86400000).toISOString();
    window.agoraBundle.load({ from, to })
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
          // A date focus whose first event only arrived with this fetch has no
          // pinned slot yet, and the partial refresh does not build one.
          const pinPending = !!state._dateFocus && !state.parishScheduleFocus
            && !contentEl.querySelector('.ps-pinned-event');
          renderParishSheetContent(parishId, { ...opts, parishEvents: filtered, fullRender: pinPending || opts.fullRender });
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
  // A later day of an event over several is a card of its own (renderStream).
  const key = evt._poolKey || evt.id;
  const cached = cardPool.get(key);
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
  cardPool.set(key, { node, evt });
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

// Split events into Morning (before 2pm) and Evening (2pm on) sub-groups.
//
// The same line, read off the same clock, as /morning and /evening
// (partOfDayOfRow): the parish's. It was Sydney's, which put a 1pm liturgy in
// Perth under Evening — and would have put it there under /morning too.
function splitMorningEvening(events) {
  const morning = [], evening = [];
  for (const e of events) {
    // A later day of an event over several opens the day, on any clock.
    (!e._cont && partOfDayOfRow(e) === 'evening' ? evening : morning).push(e);
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
  // The link under the toolbar's Save button, building as the filters change.
  const el = document.getElementById('mode-url-text');
  if (el) el.addEventListener('click', () => openSavedFilterDialog());
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
    pulseSaveFilter();
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
    // How far, when we know where the reader is — on the parish's line, as the
    // ungrouped card has it, in the location blue.
    if (first.distance_km != null) html += `<span class="parish-group-dist distance-blue">· ${esc(String(first.distance_km))} km</span>`;
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

/**
 * "Happening now" at the top of a parish sheet.
 *
 * The stream already had the bucket, but on a parish sheet the stream starts
 * below the whole service-times timetable, so a Vigil running right now sat a
 * full screen down, under the rules for next Sunday. Somebody opening a
 * parish's card while something is on there wants that first.
 *
 * Tombstones stay out: a cancelled service is not happening now, and it still
 * shows in the stream as the tombstone it is. Recomputed on every paint of the
 * sheet, full or partial, so it follows the same data as the stream beneath.
 */
function renderParishNow(contentEl, events) {
  const slot = contentEl && contentEl.querySelector('.ps-now');
  if (!slot) return;
  const now = Date.now();
  const live = (events || []).filter(e => {
    if (e.is_tombstone || (e.status && e.status !== 'approved')) return false;
    const start = Date.parse(e.start_utc);
    const end = e.end_utc ? Date.parse(e.end_utc) : start + 3600000;
    return start <= now && end >= now;
  });
  if (!live.length) { slot.replaceChildren(); return; }
  const openId = state._openEventId;
  slot.innerHTML = `<div class="happening-now-section">
      <div class="section-header"><span class="now-dot"></span>Happening now</div>
      ${sortEvents(live).map(e => renderEventCard(e)).join('')}
    </div>`;
  if (!slot._cardsBound) {
    slot._cardsBound = true;
    slot.addEventListener('click', (ev) => {
      if (ev.target.closest('.event-card-drawer') || ev.target.closest('.event-card-close')) return;
      const card = ev.target.closest('.event-card');
      if (!card || !slot.contains(card)) return;
      const scope = document.getElementById('parish-sheet-scroll');
      if (card.classList.contains('expanded')) {
        collapseEventCardDOM({ scope });
        delete state._openEventId;
        syncURL();
      } else {
        expandEventCard(card.dataset.id, { scope, card });
      }
    });
  }
  // A re-paint while one of these was open keeps it open — this copy, only if
  // this copy is the one that was open.
  if (openId && (!state._openEventSlot || state._openEventSlot === 'now')) {
    const card = slot.querySelector(`.event-card[data-id="${CSS.escape(openId)}"]`);
    if (card && !card.classList.contains('expanded')) {
      expandEventCard(openId, { scope: document.getElementById('parish-sheet-scroll'), card, keepScroll: true });
    }
  }
}

// Single continuous stream: optional Earlier-today chip, then Today phase
// buckets (Happening now / Later today), then day-grouped events through the
// rest of the loaded window. Sort toggle reorders within morning/evening
// sub-groups across the whole stream. A date focus moves where the stream
// starts; Load more moves where it ends, and there is no ceiling on that.
/**
 * "@ St George, Redfern" on a combined event, wherever the surface is showing
 * a parish other than the event's host: the parish sheet of one of its other
 * parishes, or the feed filtered to one. One style rule, rewritten — the cards
 * are pooled between the feed and the sheet, so the label sits in every
 * combined card and the surface decides whether it shows.
 */
function setCombinedContext() {
  let el = document.getElementById('combined-context-style');
  if (!el) {
    el = document.createElement('style');
    el.id = 'combined-context-style';
    document.head.appendChild(el);
  }
  const q = (pid) => String(pid).replace(/["\\]/g, '');
  // …and framed, in the Combined badge's colour, so a service brought here
  // from another parish stands apart from this parish's own. Not where it is
  // held: at its venue it is simply on.
  const at = (scope, pid) => `${scope} .event-card:not([data-host="${q(pid)}"]) .event-at{display:inline}\n`
    + `${scope} .event-card-combined:not([data-host="${q(pid)}"]):not([data-venue="${q(pid)}"]){box-shadow:inset 0 0 0 1.5px var(--combined-fg);border-radius:12px;background:color-mix(in srgb,var(--combined-bg) 40%,transparent);padding-left:10px;margin:4px 0}\n`
    // …and the host's line under the frame takes the same colour.
    + `${scope} .parish-group:has(.event-card-combined:not([data-host="${q(pid)}"]):not([data-venue="${q(pid)}"])) .parish-group-footer>*{color:var(--combined-fg)!important}`;
  const rules = [];
  if (state.parishSheetFocus) {
    rules.push(at('#parish-sheet-content', state.parishSheetFocus));
    // An event held here, run from elsewhere, is home on this sheet.
    rules.push(`#parish-sheet-content .event-card[data-venue="${String(state.parishSheetFocus).replace(/["\\]/g, '')}"] .event-venue{display:none}`);
  }
  const only = state.filters && state.filters.parishIds && state.filters.parishIds.size === 1
    ? [...state.filters.parishIds][0] : null;
  if (only) rules.push(at('#events-list', only));
  el.textContent = rules.join('\n');
}

function renderStream(container, events, opts = {}) {
  setCombinedContext();
  const { parishMode = false, showCount = SHOW_COUNT_STEP } = opts;
  // The focus is shared, so the parish card winds forward with the main feed.
  const dateFocus = state._dateFocus || null;
  const now = new Date();
  const TZ_LOCAL = TZ;
  const todayKey = new Intl.DateTimeFormat('en-AU', { timeZone: TZ_LOCAL, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const dayKey = (iso) => new Intl.DateTimeFormat('en-AU', { timeZone: TZ_LOCAL, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso));

  const happeningNow = [], laterToday = [], earlierToday = [], future = [];
  for (const e of multiDayContinuations(events)) {
    const start = new Date(e.start_utc);
    const end = e.end_utc ? new Date(e.end_utc) : new Date(start.getTime() + 3600000);
    const isToday = dayKey(e.start_utc) === todayKey;
    // An event that began on an earlier day and is still running — a festival
    // over a weekend — is happening now, not a card under yesterday's header.
    if (!isToday && !dateFocus && start < now && end >= now) {
      if (!opts.omitNow) happeningNow.push(e);
      continue;
    }
    if (isToday && !dateFocus) {
      // The parish sheet shows these at its top instead (renderParishNow), so
      // they are left out here rather than drawn twice.
      if (start <= now && end >= now) { if (!opts.omitNow) happeningNow.push(e); }
      else if (start > now) laterToday.push(e);
      else earlierToday.push(e);
    } else {
      future.push(e);
    }
  }

  // A focused date is where the stream starts, so everything before it drops.
  const activeFuture = dateFocus
    ? future.filter(e => isoDateSyd(e.start_utc) >= dateFocus)
    : future;

  // Cap future events at showCount items + complete the day the cap falls on.
  // Today events (happening now, later today) are always shown in full. The cap
  // applies under a date focus too — a focus a year out can have a year of feed
  // behind it, and Load more is how you walk through it either way.
  const { visible: visibleFuture, deferredCount } = capFutureAtCount(activeFuture, showCount);
  // What Load more would reveal without a fetch. Read by loadMore() to decide
  // whether this press is a render or a request.
  if (parishMode) _parishDeferredCount = deferredCount;
  else _mainDeferredCount = deferredCount;

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

  // How far the window currently reaches, which is a different claim from how
  // far the parish has published: the note says what has been LOADED, and Load
  // more is right beside it saying that is not the end.
  const lastEvt = events.length ? events[events.length - 1] : null;
  const horizonNote = lastEvt
    ? `<div class="list-footer-note">Loaded to ${new Date(lastEvt.start_utc).toLocaleDateString('en-AU', { timeZone: TZ, day: 'numeric', month: 'long', year: 'numeric' })}</div>`
    : '';

  // The footer never runs out of button. Load more either reveals or fetches
  // (see loadMore), and the calendar beside it skips straight to a date rather
  // than pressing forward one window at a time.
  html += `<div class="list-footer">
      <div class="list-footer-actions">
        <button class="list-footer-btn" type="button" onclick="${parishMode ? 'loadMoreParishEvents()' : 'loadMoreEvents()'}">Load more</button>
        ${calendarButtonHTML('list-footer-cal')}
      </div>
      ${horizonNote}
      <div class="list-footer-ornament">· · ·</div>
    </div>`;

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
  let inMonthBlock = false;
  let prevMonthKey = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(now);
  for (const [, evts] of groups) {
    const d = parseLocalDate(evts[0].start_utc);
    const weekdayStyle = d < sevenDaysOut ? 'long' : 'short';
    const dayFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: weekdayStyle, day: 'numeric', month: 'short' }).format(d);
    const dayOfWeek = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'long' }).format(d);
    const isSunday = dayOfWeek === 'Sunday';
    const dateStr = isoDateSyd(evts[0].start_utc);
    const isFocused = showDateNav && state._dateFocus === dateStr;

    // Each month after this one is a block of its own, its header sticking
    // while its days scroll under it and giving way to the next month's. The
    // current month has no header: it is the one the feed opens on.
    const monthKey = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit' }).format(d);
    if (monthKey !== prevMonthKey) {
      const month = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, month: 'long' }).format(d);
      const year = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric' }).format(d);
      if (inMonthBlock) html += `</div>`;
      html += `<div class="month-block"><div class="month-header"><span class="month-name">${month}</span><span class="month-year">${year}</span>`
        + (showDateNav ? headerLinkBtn(`${dateStr.slice(0, 7)}-01`, 'month', `${month} ${year}`) : '')
        + `</div>`;
      inMonthBlock = true;
      prevMonthKey = monthKey;
    }

    const dateNavBtn = showDateNav
      ? (isFocused
          ? `<button class="day-date-clear" type="button" onclick="clearDateFocus()" title="Back to stream">&times;</button>`
          : `<button class="day-date-pick" type="button" onclick="openDatePicker(this)" title="Jump to date"><img src="https://api.iconify.design/ph:calendar.svg" alt=""></button>`)
        + headerLinkBtn(dateStr, 'day', dayFmt)
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
  if (inMonthBlock) html += `</div>`;
  return html;
}

// ── A day's or a month's link ──
// Each header in the main feed copies the link to the feed from that day (or
// month) on, with whatever else narrows it now: /smg/2026-11 is "St Mary's,
// from November". The date segment is a FROM, as it is everywhere.
function headerLinkBtn(date, precision, label) {
  return `<button class="hdr-link" type="button" data-copy-date="${date}" data-precision="${precision}"
      aria-label="Copy the link to ${esc(label)}" title="Copy the link from ${esc(label)}">
      <img src="https://api.iconify.design/ph:link-simple.svg" alt=""></button>`;
}
function linkFromDate(date, precision) {
  const keep = [state._dateFocus, state._dateFocusPrecision, state._week];
  state._dateFocus = date;
  state._dateFocusPrecision = precision;
  state._week = false;
  try { return `${location.origin}/${buildPathSegs().join('/')}`; }
  finally { [state._dateFocus, state._dateFocusPrecision, state._week] = keep; }
}
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy-date]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const url = linkFromDate(btn.dataset.copyDate, btn.dataset.precision);
  let copied = false;
  try { await navigator.clipboard.writeText(url); copied = true; } catch { /* below */ }
  if (!copied) { await shareUrl(url, document.title); return; }
  btn.classList.add('copied');
  clearTimeout(btn._copiedTimer);
  btn._copiedTimer = setTimeout(() => btn.classList.remove('copied'), 1200);
});

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
// the two copies it used to have disagreed about Greek. Read wherever a
// JURISDICTION is the subject: the chip row, a parish-group header, the map's
// dots, and as the fallback for a parish that has set no colour of its own.
function rawJurisColor(j) { return window.agoraJurisdictionColor(j); }
window.rawJurisColor = rawJurisColor;

// A named jurisdiction's own tone, lifted for dark mode. Exposed for
// filters.js, which paints the chip row.
function getJurisdictionColor(j) {
  // The fallback is for a caller with no jurisdiction in hand at all. Every
  // current one passes an explicit key — a chip's own, a group header's own —
  // and gets that jurisdiction's colour whether or not it is the active filter.
  const key = j || state.filters.jurisdiction;
  return _liftIfDark(rawJurisColor(key));
}

window.getJurisdictionColor = getJurisdictionColor;

// Convert a #RRGGBB / #RGB hex to an rgba() string. Used to build the
// parish-colored glow on an expanded event card (injected as a CSS var so the
// ::after pseudo can pick it up).
// Single funnel for every inline-styled parish-colour site (acronym, pill,
// avatar, glow, --parish-color CSS var, etc). Pass-through in light mode;
// in dark, defers to window.liftParishColor (defined in map.js, so it
// loads first per index.html script order). The matchMedia check means
// inline HTML re-renders pick up scheme changes — see __agoraSchemeRerender
// below.
// Dark-mode perceptual lift only. The shared inner step of both colour
// funnels: getJurisdictionColor (a jurisdiction's tone) and
// getParishDisplayColor (a parish's own).
function _liftIfDark(hex) {
  if (!hex) return hex;
  return (matchMedia('(prefers-color-scheme: dark)').matches && window.liftParishColor)
    ? window.liftParishColor(hex)
    : hex;
}

function getParishDisplayColor(hex) {
  if (!hex) return hex;
  // The dark-mode lift, and nothing else.
  //
  // A jurisdiction filter used to substitute that jurisdiction's own colour
  // here, so picking Greek repainted every acronym, pill, avatar, feed line
  // and card glow in the view at once. That was worth something while parish
  // colours were arbitrary and the repaint was the only thing in the list
  // saying "these are the Greek ones". Parish colours now mostly follow their
  // jurisdiction already, so the substitution was restating what the reader
  // could see — and flattening the parishes that deliberately don't follow it
  // to make the point. It also made a chip whose job is filtering behave like
  // a theme switch, which read as the filter having done something other than
  // filter. The chips filter; a colour stays the parish's.
  return _liftIfDark(hex);
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
// A kind's colours live in public/shared/event-types.js, with the kinds.
function eventTypeDotColor(type) {
  return window.AgoraEventTypes.kindColors(type, matchMedia('(prefers-color-scheme: dark)').matches).bg;
}
function eventTypeDotTextColor(type) {
  return window.AgoraEventTypes.kindColors(type, matchMedia('(prefers-color-scheme: dark)').matches).fg;
}

/**
 * One event over several days — a festival from Friday to Sunday, a retreat —
 * as opposed to a vigil that runs past midnight: it ends on a later day of the
 * parish's calendar, and lasts at least half a day.
 */
function isMultiDay(evt) {
  if (!evt || !evt.end_utc) return false;
  const s = Date.parse(evt.start_utc), e = Date.parse(evt.end_utc);
  const zone = evt.timezone || TZ;
  const day = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date(t));
  return e - s >= 12 * 3600000 && day(e) > day(s);
}

/** "Fri 16 – Sun 18 Oct, until 4 pm" — a multi-day event's span, for its card. */
function multiDaySpan(evt) {
  const zone = evt.timezone || TZ;
  const s = new Date(evt.start_utc), e = new Date(evt.end_utc);
  const wd = (d) => new Intl.DateTimeFormat('en-AU', { timeZone: zone, weekday: 'short', day: 'numeric' }).format(d);
  const mon = (d) => new Intl.DateTimeFormat('en-AU', { timeZone: zone, month: 'short' }).format(d);
  const until = new Intl.DateTimeFormat('en-AU', { timeZone: zone, hour: 'numeric', minute: '2-digit' })
    .format(e).replace(':00', '').replace(/\s/g, ' ');
  const first = mon(s) === mon(e) ? wd(s) : `${wd(s)} ${mon(s)}`;
  return `${first} – ${wd(e)} ${mon(e)}, until ${until}`;
}

/**
 * "for St Luke the Evangelist": the saint or feast an occurrence keeps, the
 * way a service book heads it. One line, for the card and its drawer alike.
 */
function feastLineHTML(feast, cls) {
  return `<span class="${cls} feast-line"><span class="feast-of">for</span> ${esc(feast)}</span>`;
}

/**
 * The later days of an event over several, as cards of their own, so a
 * weekend festival is under Saturday and Sunday as well as Friday.
 *
 * A copy per day after the first, carrying `_cont` and starting at that day's
 * midnight so it sorts first and reads as Morning. Never for today or earlier:
 * a running event is already under "Happening now". The card keeps the event's
 * id, so a tap opens the event itself; `_poolKey` keeps each copy its own node
 * in the card pool.
 */
function multiDayContinuations(events) {
  const out = [];
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ });
  const today = dayFmt.format(new Date());
  for (const e of events) {
    out.push(e);
    if (!isMultiDay(e) || e._cont) continue;
    const startDay = dayFmt.format(new Date(e.start_utc));
    // An end at midnight finishes the day before; a millisecond back says so.
    const endDay = dayFmt.format(new Date(Date.parse(e.end_utc) - 1));
    const days = [];
    for (let t = Date.parse(startDay + 'T12:00:00Z') + 86400000; ; t += 86400000) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (d > endDay || days.length > 60) break;
      days.push(d);
    }
    const total = days.length + 1;
    const until = new Intl.DateTimeFormat('en-AU', { timeZone: e.timezone || TZ, hour: 'numeric', minute: '2-digit' })
      .format(new Date(e.end_utc)).replace(':00', '').replace(/\s/g, '');
    days.forEach((d, i) => {
      if (d <= today) return;
      const midnight = localInputToUtc(`${d}T00:00`);
      out.push({ ...e, start_utc: midnight, _poolKey: `${e.id}@${d}`,
        _cont: { of: e, day: d, index: i + 2, total, last: i === days.length - 1, until } });
    });
  }
  return out;
}

function renderEventCard(evt) {
  const start = new Date(evt.start_utc);
  // A later day of an event over several (multiDayContinuations) says how
  // much of that day it holds rather than repeating when it began.
  const time = evt._cont
    ? `<span class="event-time-cont">${evt._cont.last ? `until ${esc(evt._cont.until)}` : 'all day'}</span>`
    : formatEventTime(start);
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
  const combinedBadge = (evt.combined_parishes && evt.combined_parishes.length) ? `<span class="event-badge badge-combined">COMBINED</span>` : '';

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
    distHtml = ` · <span class="${distClass || 'distance-blue'}">${evt.distance_km} km</span>`;
  }

  const isCancelled = evt.status === 'cancelled';
  const cancelledBadge = isCancelled ? `<span class="event-badge badge-cancelled">CANCELLED</span>` : '';
  // Combined tombstone: this parish's slot is folded into another event (deanery/
  // feast). Shown struck-through, parish-page only (see app.js scoped filter).
  const isCombined = evt.status === 'combined';
  const combinedTombBadge = isCombined ? `<span class="event-badge badge-combined">COMBINED</span>` : '';
  // A break is the third tombstone. It renders for the same reason the other
  // two do — somebody who would otherwise turn up at church is told — and it
  // carries its reason on the card, because "BREAK" alone leaves a reader
  // wondering whether the site is broken.
  const isBreak = evt.status === 'break';
  const breakBadge = isBreak ? `<span class="event-badge badge-break">BREAK</span>` : '';
  const breakNoteHtml = (isBreak && evt.break_note)
    ? `<div class="event-break-row">${esc(evt.break_note)}</div>` : '';
  // The saint or feast this occurrence keeps — "of St Luke the Evangelist" —
  // under the title it qualifies, not under the time.
  const feastHtml = evt.feast ? feastLineHTML(evt.feast, 'event-feast-row') : '';

  // The poster, small, at the row's right edge — the row a little taller for
  // it. Everything but the liturgical services, whose poster is a month's
  // bulletin on every Sunday and would put the same thumbnail down the feed;
  // a feast is the exception, its poster is its own.
  const hasPoster = !!(evt.poster_path && (!LITURGICAL_TYPES.includes(evt.event_type) || evt.event_type === 'feast'));
  const posterImg = hasPoster
    ? `<img class="event-card-poster" src="${esc(evt.poster_path)}" alt="" loading="lazy">`
    : '';
  // A combined event at a parish other than its host says where it is. The
  // card is pooled across the feed and the parish sheet, so the label is
  // always in the markup and shown by the surface (setCombinedContext).
  const atHost = (evt.combined_parishes && evt.combined_parishes.length)
    ? `<span class="event-at"> @ ${esc(evt.parish_name || '')}</span>` : '';
  // Held somewhere else: "@ St Nicholas, Bankstown", "@ Antiochian Village".
  // Always shown but at the venue parish's own sheet, where it is home.
  const venue = venueOf(evt);
  const atVenue = venue && venue.short
    ? `<span class="event-venue"> @ ${esc(venue.short)}</span>` : '';
  // A later day's copy starts at its own midnight; the span is the event's.
  const whole = evt._cont ? evt._cont.of : evt;
  const spanHtml = isMultiDay(whole)
    ? `<div class="event-span-row">${evt._cont ? `Day ${evt._cont.index} of ${evt._cont.total} · ` : ''}${esc(multiDaySpan(whole))}</div>` : '';

  const inlineBadges = [liveBadge, bilingualBadge, combinedBadge, combinedTombBadge, cancelledBadge, breakBadge].filter(Boolean).join('');

  // Show event address only when it differs from the parish's own address.
  const altAddr = (evt.address && evt.address !== evt.parish_address) ? evt.address : null;
  const altAddrHtml = altAddr ? `<div class="event-address-row">${esc(altAddr)}</div>` : '';

  return `
    <div class="event-card${(isCancelled || isCombined || isBreak) ? ' event-cancelled' : ''}${hasPoster ? ' has-poster' : ''}${evt._cont ? ' event-card-cont' : ''}${(evt.combined_parishes && evt.combined_parishes.length) ? ' event-card-combined' : ''}" data-id="${evt.id}"${evt._cont ? ` data-cont-day="${esc(evt._cont.day)}"` : ''} data-host="${esc(evt.parish_id || '')}"${venue && venue.parishId ? ` data-venue="${esc(venue.parishId)}"` : ''} data-event-type="${esc(evt.event_type || '')}">
      <div class="event-content">
        <div class="event-title-row">
          <span class="event-time">${time}</span>
          ${typeDot}
          <div class="event-title-block">
            <span class="event-title">${esc(evt.title)}${atHost}${atVenue}${inlineBadges ? `<span class="event-inline-badges">${inlineBadges}</span>` : ''}<span class="event-card-chev"></span></span>
            ${feastHtml}
          </div>
        </div>
        <div class="event-parish-row">${acronym}${esc(evt.parish_name)}${distHtml}</div>
        ${spanHtml}
        ${breakNoteHtml}
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
    showEventDetail(card.dataset.id, card);
  });
}

// The poster on a collapsed card opens the poster, full size, rather than the
// card: somebody tapping a picture wants the picture. Capture phase, so it
// goes before every list's own card handler (the feed, the parish card,
// "Happening now") and none of them has to know.
document.addEventListener('click', (e) => {
  const img = e.target.closest('.event-card:not(.expanded) .event-card-poster');
  if (!img) return;
  e.preventDefault();
  e.stopPropagation();
  openPosterFullscreen(img.currentSrc || img.src);
}, true);

// ── Render Services ──
// Render a parish's schedule as day-grouped items. Used by the main services
// list AND the parish-sheet Schedule section so both surfaces look identical,
// including language chips, WOM labels, and admin edit affordances.
function renderScheduleDaysHTML(items) {
  // Editability is read per ROW rather than taken as an argument, because this
  // renders three surfaces — the parish sheet, its partial refresh, and the
  // main services panel, which mixes parishes — and three call sites passing
  // the same flag is three chances for one to forget. It is the capability,
  // per parish: a contact sees pencils on their own parish's rules only.
  const canEdit = (s) => mayEditTimetable(s.parish_id);
  // A rule whose last day has passed is history, not timetable. The bundle
  // already leaves out a rule that ended before its window opened; this
  // catches one that ended inside it.
  items = items.filter(s => !s.effective_to || s.effective_to >= parishToday(s.timezone || s.p_timezone));
  // Day, then time: a day's services read down in the order they happen.
  // Grouping by day alone kept whatever order the rules were stored in, so a
  // Sunday read 9:00, 8:00, 10:30. The week starts TODAY, in the parish's own
  // zone: somebody looking at a timetable on a Wednesday wants Wednesday's
  // Vespers first, and Sunday after it, as the week comes.
  const zone = items[0] && (items[0].timezone || items[0].p_timezone);
  const today = new Date(parishToday(zone) + 'T00:00:00Z').getUTCDay();
  const fromToday = (d) => (d - today + 7) % 7;
  items = [...items].sort((a, b) => fromToday(a.day_of_week) - fromToday(b.day_of_week)
    || String(a.start_time || '').localeCompare(String(b.start_time || '')));
  const byDay = new Map();
  for (const item of items) {
    if (!byDay.has(item.day_of_week)) byDay.set(item.day_of_week, []);
    byDay.get(item.day_of_week).push(item);
  }
  let html = '';
  for (const [day, scheds] of byDay) {
    html += `<div class="schedule-day">${DAYS[day]}${day === today ? '<span class="schedule-day-today">today</span>' : ''}</div>`;
    // Where the day turns to evening, the line the feed's Evening card is
    // drawn on (2pm, partOfDayOf). Morning needs no mark: it is where a day starts.
    let evening = false;
    for (const s of scheds) {
      if (!evening && partOfDayOfRow(s) === 'evening') {
        evening = true;
        html += SCHEDULE_EVENING_HTML;
      }
      const t = formatTime12(s.start_time);
      const langs = (() => { try { return JSON.parse(s.languages || '[]'); } catch { return []; } })();
      const langLabel = langs.length ? `<span class="schedule-item-lang">${esc(langs.join(', '))}</span>` : '';
      const womLabel = womDisplayLabel(s, DAYS[day]);
      const editable = canEdit(s);
      const scopeLabel = s.parish_scoped ? `<span class="schedule-item-scope">parish only</span>` : '';
      // The row focuses that rule's next occurrence at that parish, for
      // everybody. Whoever may change the rule also gets a pencil at the
      // row's right edge, always there: it opens the rule's form in the edit
      // dialog. There is no edit mode to enter first — the pencil is the way
      // in, and the green + in the timetable's head adds one.
      //
      // data-sched-parish carries the parish because the main services panel
      // renders rows for every parish at once.
      const focused = state.parishScheduleFocus
        && (state.parishScheduleFocus.ruleIds || []).includes(s.id);
      const pencil = editable
        ? `<button class="si-edit" type="button" data-sched-edit="${s.id}" aria-haspopup="dialog" aria-label="Edit ${esc(s.title)}" title="Edit">${glyph('ph:pencil-simple')}</button>`
        : '';
      const posterChip = s.poster_path ? `<span class="schedule-item-poster">${glyph('ph:image')}poster</span>` : '';
      html += `<div class="schedule-item${focused ? ' focused' : ''}${editable ? ' has-edit' : ''}" data-sched-focus="${s.id}" data-sched-parish="${esc(s.parish_id)}" role="button" tabindex="0">`;
      const onBreak = scheduleBreakNow(s);
      const breakChip = onBreak ? `<span class="schedule-item-break">on break</span>` : '';
      // Time first, in a column of its own, so a day's services read down as a
      // timetable does; the title follows at once, two lines at most, with the
      // chevron at its end rather than out at the panel's edge. Everything that
      // qualifies the row goes underneath, quieter.
      // The languages sit on the title's own line, before the chevron: they
      // are part of what the service IS ("Liturgy · Arabic, English"), and on
      // the line underneath they cost every bilingual parish a row per service.
      html += `<div class="si-main"><span class="schedule-item-time">${t}</span><span class="si-title"><span class="schedule-item-title" title="${esc(s.title)}">${esc(s.title)}</span>${langLabel}<img class="si-chev" src="https://api.iconify.design/ph:caret-right-bold.svg" alt=""></span>${pencil}</div>`;
      const rangeLabel = ruleRangeLabel(s);
      const meta = `${womLabel}${rangeLabel}${scopeLabel}${posterChip}${breakChip}`;
      if (meta) html += `<div class="si-meta">${meta}</div>`;
      // While a rule is on a break the timetable still shows its time — the
      // rule has not changed — but the honest reading of the row is "not this
      // week", and the one thing a reader wants next is when it comes back.
      if (onBreak) html += `<div class="si-break">${scheduleBreakLine(s, onBreak)}</div>`;
      // Only when the rule meets somewhere other than the parish's own address.
      // Silence means the parish address, which the sheet has already shown —
      // repeating it under every row would bury the one line that differs.
      const where = venueOf(s);
      if (where) html += `<div class="si-where">${esc(where.parishId ? `At ${where.name}` : where.words)}</div>`;
      html += `</div>`;
    }
  }
  // Under the timetable, not above it: it describes the whole block, and a
  // reader wants the times first and the provenance second.
  html += scheduleSourceHTML(items);
  return html;
}

/** The timetable's Evening divider: the feed's moon and word, on a hairline. */
const SCHEDULE_EVENING_HTML = '<div class="schedule-evening"><svg class="tc-icon" width="10" height="10" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M8.5,5 A3.5,3.5 0 1,0 1.5,5 A3.5,3.5 0 1,0 8.5,5Z M9.1,4.5 A2.9,2.9 0 1,0 3.3,4.5 A2.9,2.9 0 1,0 9.1,4.5Z"/></svg><span>Evening</span></div>';

// ── Where it is held: the venue picker (public/shared/venue-picker.js) ──

const VENUE_FIELDS = ['location_override', 'location_parish_id', 'location_lat', 'location_lng'];

/**
 * The picker's place in a form, and the four hidden fields it keeps — named by
 * `attr` (data-f for a rule's form, data-af for Add schedule, data-ev-loc for
 * an event), so each form's own save reads them like its other fields.
 */
function venueFieldsHTML(attr, row = null) {
  const v = row || {};
  return `
      <div class="sef-venue">
        <div class="vp-mount" data-venue-mount data-venue-attr="${attr}"></div>
        ${VENUE_FIELDS.map(f => `<input type="hidden" ${attr}="${f}" value="${esc(v[f] == null ? '' : v[f])}">`).join('')}
      </div>`;
}

/** The four fields as a request sends them; empty is null. */
function venueFrom(scope, attr) {
  const out = {};
  for (const f of VENUE_FIELDS) {
    const el = scope.querySelector(`[${attr}="${f}"]`);
    const v = el ? el.value.trim() : '';
    out[f] = v === '' ? null : (f === 'location_lat' || f === 'location_lng' ? Number(v) : v);
  }
  return out;
}

/** Mount the picker in `scope`, writing what is chosen into its hidden fields. */
function mountVenuePicker(scope, hostId, row) {
  const el = scope.querySelector('[data-venue-mount]');
  if (!el || !window.AgoraVenuePicker) return null;
  const attr = el.dataset.venueAttr;
  const host = (state.parishes || []).find(p => p.id === hostId) || { id: hostId };
  const write = (v) => {
    for (const f of VENUE_FIELDS) {
      const input = scope.querySelector(`[${attr}="${f}"]`);
      if (input) input.value = v[f] == null ? '' : v[f];
    }
  };
  const value = {};
  for (const f of VENUE_FIELDS) value[f] = row && row[f] != null && row[f] !== '' ? row[f] : null;
  return window.AgoraVenuePicker.mount(el, {
    value,
    host,
    parishes: state.parishes || [],
    geocode: geocodeAddress,
    pickPin: (start, done) => openPinPicker({ ...start, sub: start.title }, done),
    onChange: write,
  });
}

/** POST /api/admin/geocode — the parish form's own lookup. {lat, lng} or null. */
async function geocodeAddress(address) {
  const res = await fetch('/api/admin/geocode', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }),
  }).catch(() => null);
  if (!res || !res.ok) return null;
  const c = await res.json().catch(() => null);
  return c && Number.isFinite(c.lat) ? { lat: c.lat, lng: c.lng } : null;
}

/**
 * Every field of a rule, in the order a person thinks of a service: what it
 * is, when, how often, in what language, where, between which dates, its
 * poster. ONE form for adding a rule and for editing one, so a service can be
 * written whole the first time — it used to be four fields to add, and the
 * languages, the end time, the description, the poster and the two ticks only
 * once it existed, on its pencil.
 *
 * `attr` names the fields for the form's reader: data-f on an edit, data-af
 * on an add. Times and dates are our own pickers (time-field.js, the feed's
 * month grid), never the system's: quarter-hours with a typed time for the
 * rest, and a calendar that does not clip to "09/22/2" in a narrow column.
 */
function ruleFieldsHTML(attr, s = {}, { adding = false } = {}) {
  const langs = (() => { try { return JSON.parse(s.languages || '[]'); } catch { return []; } })();
  const dow = Number.isInteger(s.day_of_week) ? s.day_of_week : 0;
  const kind = s.event_type || 'liturgy';
  const poster = adding
    ? `<div class="rule-poster" data-new-rule-poster>
        <div class="rule-poster-row">
          <img class="poster-edit-thumb" data-new-poster-thumb alt="" hidden>
          <div class="poster-edit-actions">
            <button class="ps-btn ps-btn-admin" type="button" data-new-poster-pick>${glyph('ph:image-square')}<span data-new-poster-label>Add a poster</span></button>
            <button class="ps-btn ps-btn-danger" type="button" data-new-poster-clear hidden>${glyph('ph:trash')}Remove</button>
          </div>
        </div>
        <div class="edit-row-hint">On every date, for something held every week. It is saved with the service.</div>
      </div>`
    : rulePosterHTML(s);
  return `
      <div class="edit-row"><label>Title</label><input ${attr}="title" value="${esc(s.title || '')}" placeholder="Divine Liturgy" autocomplete="off"></div>
      <div class="edit-row edit-pair">
        <div><label>Day</label>
          <select ${attr}="day_of_week">${DAYS.map((d, i) => `<option value="${i}"${dow === i ? ' selected' : ''}>${d}</option>`).join('')}</select></div>
        <div><label>Kind</label>
          <select ${attr}="event_type" data-kind-picker>${EVENT_TYPES.map(t => `<option value="${t}"${kind === t ? ' selected' : ''}>${t}</option>`).join('')}</select></div>
      </div>
      <div class="edit-row edit-pair">
        <div><label>Starts</label>${timeFieldHTML(attr, 'start_time', s.start_time || (adding ? '09:00' : ''), { label: 'Starts' })}</div>
        <div><label>Ends</label>${timeFieldHTML(attr, 'end_time', s.end_time || '', { label: 'Ends', optional: true, none: 'No end time', near: 'start_time' })}</div>
      </div>
      <div class="edit-row"><label>Runs</label>${cadencePickerHTML(`${attr}="cadence"`, s)}</div>
      <div class="edit-row"><label>Languages</label><input ${attr}="languages" value="${esc(langs.join(', '))}" placeholder="English, Arabic" autocomplete="off"></div>
      <div class="edit-row"><label>Description</label><textarea ${attr}="description" rows="2" placeholder="Shown on every date (optional)">${esc(s.description || '')}</textarea></div>
      <div class="edit-row edit-venue"><label>Where</label>${venueFieldsHTML(attr, s)}</div>
      ${ruleDatesHTML(attr, s)}
      <div class="edit-row"><label>Poster</label>${poster}</div>
      <div class="edit-row edit-checks">
        <label class="edit-check"><input type="checkbox" ${attr}="hide_live"${s.hide_live ? ' checked' : ''}> No live badge</label>
        <label class="edit-check"><input type="checkbox" ${attr}="parish_scoped"${s.parish_scoped ? ' checked' : ''}> Parish only</label>
      </div>`;
}

// Picking "Other" for a rule or an event ticks Parish only on the same form:
// an Other is the parish's own business (a council meeting, a working bee)
// until somebody says otherwise. Only on the change TO Other — unticking it
// afterwards is the person's to do, and sticks.
document.addEventListener('change', (e) => {
  const sel = e.target;
  if (!sel.matches || !sel.matches('select[data-kind-picker]') || sel.value !== 'other') return;
  const form = sel.closest('.schedule-edit-form, .schedule-add, .detail-edit-form');
  const box = form && form.querySelector('[data-f="parish_scoped"], [data-af="parish_scoped"], input[id^="edit-parish-scoped-"]');
  if (box) box.checked = true;
});

/** A time of day for a rule's form: the hidden 'HH:MM' its reader reads, dressed by time-field.js. */
function timeFieldHTML(attr, name, value, { label = '', optional = false, none = '', near = '' } = {}) {
  return `<input type="hidden" ${attr}="${name}" value="${esc(value || '')}" data-time-field data-tf-name="${name}"`
    + `${label ? ` data-tf-label="${esc(label)}"` : ''}${optional ? ' data-tf-optional' : ''}`
    + `${none ? ` data-tf-none="${esc(none)}"` : ''}${near ? ` data-tf-near="${esc(near)}"` : ''}>`;
}

/**
 * A date for a rule's form: the hidden 'YYYY-MM-DD' its reader reads, and a
 * button that opens the feed's own month grid (openDatePicker, field mode).
 */
function dateFieldHTML(attr, name, value, empty) {
  return `<div class="df" data-date-field>
      <input type="hidden" ${attr}="${name}" value="${esc(value || '')}">
      <button type="button" class="df-btn" data-df-open data-df-empty="${esc(empty)}">${value ? esc(dateFieldLabel(value)) : `<span class="df-empty">${esc(empty)}</span>`}</button>
      <button type="button" class="df-clear" data-df-clear aria-label="Clear the date"${value ? '' : ' hidden'}>&times;</button>
    </div>`;
}

/** "Sun 1 Nov 2026". */
function dateFieldLabel(iso) {
  return new Intl.DateTimeFormat('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(iso + 'T00:00:00Z'));
}

function setDateField(df, iso) {
  const input = df.querySelector('input[type=hidden]');
  const btn = df.querySelector('[data-df-open]');
  input.value = iso || '';
  btn.innerHTML = iso ? esc(dateFieldLabel(iso)) : `<span class="df-empty">${esc(btn.dataset.dfEmpty || '')}</span>`;
  df.querySelector('[data-df-clear]').hidden = !iso;
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-df-open]');
  const clear = e.target.closest('[data-df-clear]');
  const df = (open || clear) && (open || clear).closest('[data-date-field]');
  if (!df) return;
  e.preventDefault();
  if (clear) { setDateField(df, ''); return; }
  window.openDatePicker(open, {
    value: df.querySelector('input[type=hidden]').value || null,
    onPick: (iso) => setDateField(df, iso),
  });
});

/**
 * One rule's form, for the edit dialog — built when its pencil is pressed,
 * never painted into the timetable and hidden.
 */
function ruleEditFormHTML(s) {
  return `<div class="schedule-edit-form detail-edit-form rule-form" data-sid="${s.id}">
      ${ruleFieldsHTML('data-f', s)}
      <div class="form-actions">
        <button class="btn-save schedule-save-btn" type="button" data-sid="${s.id}">Save</button>
        <button class="btn-outline" type="button" onclick="closeFormDialog()">Cancel</button>
        <button class="btn-danger schedule-del-btn" type="button" data-sid="${s.id}">Delete</button>
      </div>
    </div>`;
}

/**
 * A rule's own poster: the flyer of something held every week, on every date
 * that has none of its own (schedules.poster_path, migration 021). Uploads as
 * it is picked, like the event poster and the logo — outside Save.
 */
function rulePosterHTML(s) {
  const has = !!s.poster_path;
  return `
    <div class="rule-poster" data-rule-poster="${s.id}">
      <div class="rule-poster-label">Poster <span>— on every date, for something held every week</span></div>
      <div class="rule-poster-row">
        ${has ? `<img class="poster-edit-thumb" src="${esc(s.poster_path)}" alt="" data-rule-poster-view>` : ''}
        <div class="poster-edit-actions">
          <button class="ps-btn ps-btn-admin" type="button" data-rule-poster-pick="${s.id}">${glyph('ph:image-square')}${has ? 'Replace' : 'Add a poster'}</button>
          ${has ? `<button class="ps-btn ps-btn-danger" type="button" data-rule-poster-clear="${s.id}">${glyph('ph:trash')}Remove</button>` : ''}
        </div>
      </div>
      <div class="edit-row-hint" data-rule-poster-status></div>
    </div>`;
}

/** Open a rule's form in the edit dialog. */
function openRuleEditDialog(sid) {
  const rule = ruleById(sid);
  if (!rule) return;
  const parish = (state.parishes || []).find(p => p.id === rule.parish_id);
  const body = openFormDialog({
    kind: 'rule',
    title: 'Edit service',
    // The subtitle is text, and formatTime12 is markup (its AM/PM is a span).
    sub: [rule.title, `${DAYS[rule.day_of_week]}s ${formatTime12(rule.start_time).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}`, parish && parish.name]
      .filter(Boolean).join(' · '),
    html: ruleEditFormHTML(rule),
  });
  body.dataset.sid = String(rule.id);
  mountVenuePicker(body, rule.parish_id, rule);
  wireScheduleAdminHandlers(body);
}
window.openRuleEditDialog = openRuleEditDialog;

/** Redraw the open rule dialog's poster control from the rule as it now is. */
function _repaintRulePoster(sid, msg, bad) {
  const box = document.querySelector(`#form-body [data-rule-poster="${CSS.escape(String(sid))}"]`);
  const rule = ruleById(sid);
  if (box && rule) {
    box.outerHTML = rulePosterHTML(rule);
  }
  const status = document.querySelector(`#form-body [data-rule-poster="${CSS.escape(String(sid))}"] [data-rule-poster-status]`);
  if (status) { status.textContent = msg || ''; status.classList.toggle('edit-row-hint-bad', !!bad); }
}

/** After a rule's poster changes: the rule and every date it shows on. */
async function _afterRulePosterChange(sid, msg) {
  await fetchSchedules({ fresh: true });
  await fetchEvents({ fresh: true, keepCount: true });
  _repaintRulePoster(sid, msg);
  repaintOpenEventDrawer();
  if (state.parishSheetFocus && !state._openEventId) {
    renderParishSheetContent(state.parishSheetFocus, { fullRender: true });
  }
}

/** Upload `file` as rule `sid`'s own poster. */
async function uploadRulePoster(sid, file) {
  if (!file) return { error: 'No file chosen.' };
  if (file.size > 8 * 1024 * 1024) return { error: 'That poster is over 8 MB — the limit the Worker takes.' };
  try {
    const res = await fetch(`/api/admin/schedules/${encodeURIComponent(sid)}/poster`, {
      method: 'POST', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { error: (body && body.error) || `The poster was refused (${res.status}).` };
    return body;
  } catch {
    return { error: 'The poster could not be uploaded — check the connection.' };
  }
}

document.addEventListener('click', async (e) => {
  const pick = e.target.closest('[data-rule-poster-pick]');
  const clear = e.target.closest('[data-rule-poster-clear]');
  const view = e.target.closest('[data-rule-poster-view]');
  if (view) { openPosterFullscreen(view.src); return; }
  if (!pick && !clear) return;
  e.preventDefault();
  e.stopPropagation();
  if (pick) {
    const sid = pick.dataset.rulePosterPick;
    const input = _posterInput();
    input.value = '';
    input.onchange = async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      _repaintRulePoster(sid, 'Uploading…');
      const r = await uploadRulePoster(sid, file);
      if (r.error) return _repaintRulePoster(sid, r.error, true);
      await _afterRulePosterChange(sid, 'Poster saved — it shows on every date.');
    };
    input.click();
    return;
  }
  const sid = clear.dataset.rulePosterClear;
  if (!confirm('Take this poster off the service? Dates with a poster of their own keep theirs.')) return;
  const res = await fetch(`/api/admin/schedules/${encodeURIComponent(sid)}/poster`, { method: 'DELETE' }).catch(() => null);
  if (!res || !res.ok) return _repaintRulePoster(sid, 'That failed — check the connection.', true);
  await _afterRulePosterChange(sid, 'Poster removed.');
});

/**
 * "until 5 Oct", "from 1 Nov", "2 Mar – 20 Apr": a rule's dates, said only
 * when they say something. A start already past is not news, and a rule with
 * neither is the ordinary open-ended timetable row.
 */
function ruleRangeLabel(rule) {
  const today = parishToday(rule.timezone || rule.p_timezone);
  const fmt = (d) => new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short' })
    .format(new Date(d + 'T00:00:00Z'));
  const from = rule.effective_from && rule.effective_from > today ? rule.effective_from : null;
  const to = rule.effective_to || null;
  let text = '';
  if (from && to) text = `${fmt(from)} – ${fmt(to)}`;
  else if (from) text = `from ${fmt(from)}`;
  else if (to) text = `until ${fmt(to)}`;
  return text ? `<span class="schedule-item-range">${esc(text)}</span>` : '';
}

/**
 * Starts / Ends on a rule's form. Both optional and inclusive, in the
 * parish's own dates. A service that has stopped ENDS; one that is off for a
 * while and coming back is a Break, which keeps its dates on the feed with the
 * reason — the hint says so because the two are easy to reach for wrongly.
 */
function ruleDatesHTML(attr, rule = {}) {
  return `
    <div class="edit-row edit-pair rule-dates">
      <div><label>First date</label>${dateFieldHTML(attr, 'effective_from', rule.effective_from, 'From now')}</div>
      <div><label>Last date</label>${dateFieldHTML(attr, 'effective_to', rule.effective_to, 'No end')}</div>
    </div>
    <div class="edit-row-hint rule-dates-hint">After its last date a service leaves the timetable — for a pause, use Break on one of its dates.</div>`;
}

/** The break covering this rule TODAY, or null. */
function scheduleBreakNow(rule) {
  const breaks = (window.agoraBundle && window.agoraBundle.breaks && window.agoraBundle.breaks()) || [];
  if (!breaks.length) return null;
  // Today in the PARISH's zone, not the viewer's — the same rule the rest of
  // the app follows, and the reason a parish in Perth is not on a break three
  // hours early because somebody is reading in Auckland.
  const today = parishToday(rule.timezone || rule.p_timezone);
  return breaks.find(b =>
    (b.schedule_id != null
      ? String(b.schedule_id) === String(rule.id)
      : b.parish_id === rule.parish_id)
    && today >= b.from_date && today <= b.to_date) || null;
}

/** 'YYYY-MM-DD' where this parish is now. */
function parishToday(zone) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: zone || TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

/** "On a break until 6 Jan — back Sunday 10 Jan. Christmas break" */
function scheduleBreakLine(rule, brk) {
  const fmt = (d) => new Intl.DateTimeFormat('en-AU',
    { weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(d + 'T00:00:00Z'));
  const resume = nextRunAfterBreaks(rule);
  const back = resume ? `back ${fmt(resume)}` : 'no return date set';
  const why = brk.note ? ` · ${esc(brk.note)}` : '';
  return `${esc(back)}${why}`;
}

/**
 * The first date this rule runs again, skipping every break in its way.
 *
 * The day after the break ends is the wrong answer and the tempting one: a
 * break that ends on a Wednesday does not bring a Sunday service back on
 * Thursday, and a fortnightly rule may not return for another two weeks. So
 * this walks the rule's OWN occurrences, through the same shared projection
 * the feed uses rather than a second copy of the maths here.
 */
function nextRunAfterBreaks(rule) {
  const b = window.agoraBundle;
  if (!b || !b.nextOccurrenceAfterBreak) return null;
  return b.nextOccurrenceAfterBreak(rule, parishToday(rule.timezone || rule.p_timezone), b.breaks());
}

/**
 * How often a rule runs, read back in the shape the two columns take.
 *
 * Returns both, always, because they are mutually exclusive and the Worker
 * refuses a row holding both: a save that set one without clearing the other
 * would be rejected, or worse accepted into a rule matching a quarter of the
 * days it names. Answering for both every time is what makes switching between
 * them a single move.
 */
function readCadencePicker(el) {
  if (!el) return { week_of_month: null, week_parity: null };
  const mode = (el.querySelector('input[type=radio][data-cad-mode]:checked') || {}).value || 'weekly';
  if (mode === 'wom') {
    const checked = [...el.querySelectorAll('[data-cad-body=\"wom\"] input[type=checkbox]:checked')]
      .map(cb => cb.value);
    // Every box cleared is the same statement as "every week", and writing an
    // empty string would fail the route's check.
    return { week_of_month: checked.length ? checked.join(',') : null, week_parity: null };
  }
  if (mode === 'fortnight') {
    const p = el.querySelector('[data-cad-body=\"fortnight\"] input[type=radio]:checked');
    return { week_of_month: null, week_parity: p ? p.value : 'a' };
  }
  return { week_of_month: null, week_parity: null };
}

/** The next `n` dates a rule on `dow` and fortnight `parity` would run. */
function fortnightDates(dow, parity, n = 3) {
  const ab = window.agoraBundle && window.agoraBundle.weekAbOf;
  if (!ab) return [];
  const out = [];
  // Counted from TODAY'S DATE, as a date. It used to start from local midnight
  // run through toISOString, which east of Greenwich is yesterday in UTC — so
  // in Sydney the first "next" date could be one that had already passed.
  const today = Date.parse(localTodayIso() + 'T00:00:00Z');
  for (let i = 0; i < 400 && out.length < n; i++) {
    const iso = new Date(today + i * 86400000).toISOString().slice(0, 10);
    if (new Date(iso + 'T00:00:00Z').getUTCDay() !== dow) continue;
    if (ab(iso) !== parity) continue;
    out.push(iso);
  }
  return out;
}

/** Today's date where the viewer is, as 'YYYY-MM-DD'. */
function localTodayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * The first date of a fortnight, said the way a person would say it.
 *
 * The two choices are always one this week and one next, so the words are what
 * tell them apart: "This Sunday, 27 Sep" against "Next Sunday, 4 Oct". The date
 * stays beside the words because "next Sunday" means the coming one to half of
 * Australia and the one after that to the other half — the date settles it.
 */
function naturalFirstDate(iso) {
  const days = Math.round((Date.parse(iso + 'T00:00:00Z')
    - Date.parse(localTodayIso() + 'T00:00:00Z')) / 86400000);
  const date = new Date(iso + 'T00:00:00Z');
  const short = new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(date);
  const day = DAYS[date.getUTCDay()];
  if (days === 0) return `Today, ${short}`;
  if (days === 1) return `Tomorrow, ${short}`;
  if (days < 7) return `This ${day}, ${short}`;
  if (days < 14) return `Next ${day}, ${short}`;
  return `${day} ${short}`;
}

/** "This Sunday, 27 Sep · then 11 Oct, 25 Oct" — where a fortnight lands. */
function fortnightPreview(dow, parity) {
  const dates = fortnightDates(dow, parity);
  if (!dates.length) return '';
  const rest = dates.slice(1).map(d => new Intl.DateTimeFormat('en-AU',
    { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(d + 'T00:00:00Z')));
  return naturalFirstDate(dates[0]) + (rest.length ? ` · then ${rest.join(', ')}` : '');
}

/** Which fortnight comes round first, so it can be offered first. */
function parityOrder(dow) {
  const a = fortnightDates(dow, 'a', 1)[0] || '';
  const b = fortnightDates(dow, 'b', 1)[0] || '';
  return b && (!a || b < a) ? ['b', 'a'] : ['a', 'b'];
}

/**
 * How often a rule runs — one control, three answers, on the form that creates
 * a rule and the form that edits one.
 *
 * ONE control rather than two, because week_of_month and week_parity cannot
 * both be set. Offered as two independent pickers they would look combinable,
 * and "1st and 3rd Saturday" AND "week B" is a rule that matches about a
 * quarter of the Saturdays it names — which reads as a broken projection
 * rather than as the contradiction it is. The Worker refuses the pair; this
 * makes it unaskable.
 *
 * The fortnight is offered as DATES, never as "week A" or an ISO week number.
 * Nobody thinks in those, and the only thing a person needs to know is which
 * of the two alternating weeks is theirs — which the next three dates answer
 * and no label can. They re-render when the weekday changes, because picking
 * Saturday after picking a fortnight would otherwise leave Sundays on screen.
 */
function cadencePickerHTML(attr, rule = {}) {
  const uid = `cad${Math.random().toString(36).slice(2, 8)}`;
  const wom = rule.week_of_month
    ? String(rule.week_of_month).split(',').map(w => w.trim()) : [];
  const parity = rule.week_parity ? String(rule.week_parity).toLowerCase() : null;
  const mode = parity ? 'fortnight' : (wom.length ? 'wom' : 'weekly');
  const dow = Number.isInteger(rule.day_of_week) ? rule.day_of_week : 0;
  const radio = (value, label) =>
    `<label class="cad-mode"><input type="radio" name="${uid}" data-cad-mode value="${value}"${
      mode === value ? ' checked' : ''}> ${label}</label>`;
  const parityChoice = (value) =>
    `<label class="cad-week"><input type="radio" name="${uid}p" value="${value}"${
      (parity || 'a') === value ? ' checked' : ''}><span class="cad-week-dates" data-cad-dates="${value}">${
      esc(fortnightPreview(dow, value)) || '…'}</span></label>`;

  return `<div class="cadence" ${attr}>
      <div class="cad-modes">
        ${radio('weekly', 'every week')}
        ${radio('wom', 'some weeks of the month')}
        ${radio('fortnight', 'fortnightly')}
      </div>
      <div class="cad-body" data-cad-body="wom"${mode === 'wom' ? '' : ' hidden'}>
        ${WEEKS_OF_MONTH.map(w =>
          `<label class="wom-check"><input type="checkbox" value="${w}"${
            wom.includes(w) ? ' checked' : ''}> ${w}</label>`).join('')}
      </div>
      <div class="cad-body cad-fortnight" data-cad-body="fortnight"${mode === 'fortnight' ? '' : ' hidden'}>
        <span class="wom-label">starting</span>
        ${parityOrder(dow).map(parityChoice).join('')}
      </div>
    </div>`;
}

/**
 * Make one cadence picker live: show the body its mode names, and keep the
 * fortnight's dates honest when the weekday changes underneath it.
 */
function wireCadencePickers(container) {
  container.querySelectorAll('.cadence').forEach(cad => {
    if (cad._cadBound) return;
    cad._cadBound = true;

    const paint = () => {
      const mode = (cad.querySelector('input[data-cad-mode]:checked') || {}).value || 'weekly';
      cad.querySelectorAll('[data-cad-body]').forEach(b => {
        b.hidden = b.dataset.cadBody !== mode;
      });
    };
    // The weekday lives in the form around this control, under data-f on an
    // edit form and data-af on the add form.
    const daySelect = () => {
      const form = cad.closest('.schedule-edit-form, .schedule-add');
      return form && form.querySelector('[data-f="day_of_week"], [data-af="day_of_week"]');
    };
    const repaintDates = () => {
      const sel = daySelect();
      const dow = sel ? parseInt(sel.value, 10) : 0;
      cad.querySelectorAll('[data-cad-dates]').forEach(span => {
        span.textContent = fortnightPreview(dow, span.dataset.cadDates) || '…';
      });
      // Soonest first, whichever weekday it is now.
      const body = cad.querySelector('[data-cad-body="fortnight"]');
      if (body) {
        for (const p of parityOrder(dow)) {
          const label = body.querySelector(`[data-cad-dates="${p}"]`)?.closest('label');
          if (label) body.appendChild(label);
        }
      }
    };

    cad.addEventListener('change', () => { paint(); repaintDates(); });
    const sel = daySelect();
    if (sel && !sel._cadDayBound) {
      sel._cadDayBound = true;
      sel.addEventListener('change', repaintDates);
    }
    paint();
    repaintDates();
  });
}


/**
 * "Add schedule": a new rule, from a photo of the sign or typed in.
 *
 * On the parish's own sheet rather than only in /admin, because the moment
 * somebody notices a missing service is while they are looking at the parish
 * that is missing it. Every field the edit form has (ruleFieldsHTML): it was
 * four, and the rest only once the rule existed — so a service was added and
 * then edited, and one added and left showed for days with no languages and
 * no end. The weeks above all: a rule with no weeks is a WEEKLY rule, and a
 * 1st-Saturday Liturgy entered without them publishes services nobody holds.
 */
function addServiceHTML(parishId) {
  const pid = esc(parishId);
  return `
    <div class="schedule-add detail-edit-form rule-form" data-parish-id="${pid}">
      <div class="schedule-add-photo">
        <button type="button" class="sap-drop" data-sched-photo="${pid}">
          <span class="sap-title">From a photo of the sign</span>
          <span class="sap-sub">The board out the front, or a printed timetable: its services are read for you to check against it, and nothing is added until you say so.</span>
        </button>
        <input type="file" accept="image/*" hidden data-sched-photo-input="${pid}">
      </div>
      <div class="schedule-add-or">or type it in</div>
      ${ruleFieldsHTML('data-af', {}, { adding: true })}
      <div class="form-actions">
        <button class="btn-save schedule-add-btn" type="button" data-parish-id="${pid}">Add service</button>
        <button class="btn-outline" type="button" onclick="closeFormDialog()">Cancel</button>
      </div>
    </div>`;
}

// Bind toggle/save/delete handlers for every admin schedule-edit affordance
// under `container`. Idempotent: tied to elements, not global state.
function wireScheduleAdminHandlers(container) {
  // No binding for opening a form: the row opens it, and the row is bound once
  // for the whole document in initScheduleRowTaps. See renderScheduleDaysHTML.
  wireCadencePickers(container);
  container.querySelectorAll('.schedule-save-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = btn.dataset.sid;
      const form = btn.closest('.schedule-edit-form');
      if (!form) return;
      if (!ruleTimesReadable(form, 'data-f')) return;
      const data = {};
      form.querySelectorAll('[data-f]').forEach(input => {
        const field = input.dataset.f;
        if (field === 'cadence') {
          // Both columns, every time — see readCadencePicker. Sending only the
          // one that changed is how a rule ends up holding a qualifier the
          // person thought they had swapped away from.
          Object.assign(data, readCadencePicker(input));
        } else if (field === 'hide_live' || field === 'parish_scoped') {
          data[field] = input.checked ? 1 : 0;
        } else {
          const val = input.tagName === 'SELECT' ? input.value : input.value.trim();
          if (field === 'languages') data[field] = val ? JSON.stringify(val.split(',').map(s => s.trim()).filter(Boolean)) : null;
          else if (field === 'day_of_week') data[field] = parseInt(val);
          else data[field] = val || null;
        }
      });
      const rule = (state.schedules || []).find(x => String(x.id) === String(id));
      if (rule && !(await ensureKeptByHand(rule.parish_id))) return;
      fetch(`/api/admin/schedules/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
        .then(async r => {
          if (r.ok) { closeFormDialog(); fetchSchedules({ fresh: true }); fetchEvents({ fresh: true, keepCount: true }); }
          else alert(await adminErrorText(r));
        });
    });
  });
  // Deleting a rule. At a parish still read from a source, the first hand
  // edit asks whether to stop reading it (ensureKeptByHand) — otherwise the
  // next import would simply put the rule back.
  container.querySelectorAll('.schedule-del-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const id = btn.dataset.sid;
      const rule = (state.schedules || []).find(x => String(x.id) === String(id));
      if (!confirm('Delete this service?')) return;
      if (rule && !(await ensureKeptByHand(rule.parish_id))) return;
      const res = await fetch(`/api/admin/schedules/${id}`, { method: 'DELETE' });
      if (res.ok) { closeFormDialog(); fetchSchedules({ fresh: true }); }
      else alert(await adminErrorText(res));
    });
  });

  container.querySelectorAll('.schedule-add-btn').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      // One request at a time. A second tap while the first is in flight made
      // two identical rules; the Worker now answers a duplicate with the rule
      // already there, and this stops the second request being sent at all.
      if (btn.disabled) return;
      btn.disabled = true;
      try { await addServiceFrom(btn); } finally { btn.disabled = false; }
    });
  });
  // A poster picked on the add form waits for the rule to exist: the upload
  // is to the rule's own address, and there is none until Add.
  container.querySelectorAll('[data-new-rule-poster]').forEach(box => {
    const thumb = box.querySelector('[data-new-poster-thumb]');
    const pick = box.querySelector('[data-new-poster-pick]');
    const clear = box.querySelector('[data-new-poster-clear]');
    const paint = () => {
      const file = box._file || null;
      if (thumb._url) { URL.revokeObjectURL(thumb._url); thumb._url = null; }
      if (file) { thumb._url = URL.createObjectURL(file); thumb.src = thumb._url; }
      thumb.hidden = !file;
      clear.hidden = !file;
      pick.querySelector('[data-new-poster-label]').textContent = file ? 'Replace' : 'Add a poster';
    };
    pick.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const input = _posterInput();
      input.value = '';
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) return;
        if (file.size > 8 * 1024 * 1024) { alert('That poster is over 8 MB — the limit the Worker takes.'); return; }
        box._file = file;
        paint();
      };
      input.click();
    });
    clear.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); box._file = null; paint(); });
    thumb.addEventListener('click', () => { if (thumb.src) openPosterFullscreen(thumb.src); });
  });

  async function addServiceFrom(btn) {
    {
      const wrap = btn.closest('.schedule-add');
      const read = (f) => wrap.querySelector(`[data-af="${f}"]`).value;
      const checked = (f) => wrap.querySelector(`[data-af="${f}"]`).checked ? 1 : 0;
      const title = read('title').trim();
      if (!title) { alert('Give the service a name.'); return; }
      if (!ruleTimesReadable(wrap, 'data-af')) return;
      if (!(await ensureKeptByHand(btn.dataset.parishId))) return;
      // Every week is NULL in both columns — not an empty string, which would
      // fail the route's check.
      const cadence = readCadencePicker(wrap.querySelector('[data-af="cadence"]'));
      const langs = read('languages').split(',').map(x => x.trim()).filter(Boolean);
      const res = await fetch('/api/admin/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parish_id: btn.dataset.parishId,
          title,
          day_of_week: parseInt(read('day_of_week'), 10),
          start_time: read('start_time'),
          end_time: read('end_time') || null,
          event_type: read('event_type'),
          languages: langs.length ? JSON.stringify(langs) : null,
          description: read('description').trim() || null,
          hide_live: checked('hide_live'),
          parish_scoped: checked('parish_scoped'),
          effective_from: read('effective_from') || null,
          effective_to: read('effective_to') || null,
          ...venueFrom(wrap, 'data-af'),
          ...cadence,
        }),
      });
      if (res.ok) {
        // The poster goes on once the rule is there to take it. If it fails
        // the service is still added — say so, and it can go on from the
        // row's pencil.
        const made = await res.json().catch(() => null);
        const posterBox = wrap.querySelector('[data-new-rule-poster]');
        const file = posterBox && posterBox._file;
        if (file && made && made.id) {
          btn.textContent = 'Adding the poster…';
          const up = await uploadRulePoster(made.id, file);
          if (up.error) alert(`The service was added, but its poster was not: ${up.error}`);
        }
        // Added: the dialog goes, and the timetable shows the new row. The
        // next one starts from a fresh form, so nothing — the cadence above
        // all — carries over from this one.
        closeFormDialog();
        await fetchSchedules({ fresh: true });
        if (file) fetchEvents({ fresh: true, keepCount: true });
        return;
      }
      // 409 means a ruling refuses this slot — somebody deleted this service
      // on purpose and said why. The message carries their reason, which is the
      // whole point of having asked for one.
      alert(await adminErrorText(res));
    }
  }
}

/**
 * Are the times on a rule's form times? A box left holding "9:3o" is red
 * (time-field.js) and the save waits; a rule with no start cannot be saved at
 * all, and an end before its start is a typo far more often than a service
 * that runs past midnight — so that is asked rather than refused.
 */
function ruleTimesReadable(form, attr) {
  const TF = window.AgoraTimeField;
  if (TF && TF.commitAll && !TF.commitAll(form)) {
    alert('One of the times is not a time. Pick one from the list, or type it like 6:30 pm.');
    return false;
  }
  const at = (f) => { const el = form.querySelector(`[${attr}="${f}"]`); return el ? el.value : ''; };
  if (!at('start_time')) { alert('When does it start?'); return false; }
  const end = at('end_time');
  if (end && end <= at('start_time')
      && !confirm('It ends before it starts — does it run past midnight? OK to keep it, Cancel to fix it.')) return false;
  return true;
}

/**
 * The first hand edit at a parish still read from a source asks, once: keep it
 * by hand from now on, or keep reading it? (public/shared/read-from.js)
 *
 * The question is the point of the change. A parish nobody looks after is read
 * from its directory or its website as a stopgap; the moment a person corrects
 * it, the next import would quietly undo the correction. Rather than refereeing
 * between them field by field — the rulings this replaced — the person decides
 * once, for the whole parish. "Keep reading" is remembered per browser, so it
 * is not asked on every save after.
 *
 * Resolves true to go ahead with the save, false if they backed out.
 */
async function ensureKeptByHand(parishId) {
  const RF = window.AgoraReadFrom;
  const parish = (state.parishes || []).find(p => p.id === parishId);
  if (!RF || !parish) return true;
  const rf = RF.readFrom(parish);
  if (rf === 'hand') return true;
  try { if (localStorage.getItem(`agora-keep-reading:${parishId}`)) return true; } catch { /* ask */ }
  const pick = await askChoice({
    title: `${parish.name} is ${RF.LABELS[rf].charAt(0).toLowerCase()}${RF.LABELS[rf].slice(1)}`,
    body: `<p style="margin:0">${esc(RF.HINTS[rf])}</p>`,
    choices: [
      { value: 'hand', label: 'Keep it by hand from now on',
        hint: 'Stop reading it. Your change, and every change after it, stays.' },
      { value: 'read', label: 'Keep reading it',
        hint: 'The next import may overwrite this change. You will not be asked again in this browser.' },
    ],
  });
  if (!pick) return false;
  if (pick === 'read') {
    try { localStorage.setItem(`agora-keep-reading:${parishId}`, '1'); } catch { /* fine */ }
    return true;
  }
  const res = await fetch(`/api/admin/parishes/${encodeURIComponent(parishId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ read_from: 'hand' }),
  });
  if (!res.ok) { alert(await adminErrorText(res)); return false; }
  parish.read_from = 'hand';
  return true;
}

/** The server's own words, when it has any. */
async function adminErrorText(res) {
  try {
    const body = await res.json();
    if (body && body.error) return body.error;
  } catch { /* not json */ }
  return `Could not save (${res.status})`;
}

function renderServices() {
  const container = document.getElementById('services-list');
  // Which rules the filters mean is public/shared/timetable.js — the Worker's
  // timetable page for /greek/qld asks the same question, so the lite page and
  // this view cannot list different services for one link. Jurisdiction was
  // applied when the rules were fetched; the viewport is this view's own.
  const T = window.AgoraTimetable;
  let schedules = state.schedules.filter(s =>
    T.ruleMatches(s, state.filters)
    && (!state.filters.location || parishIdPassesLocation(s.parish_id)));
  if (state.filters.parishIds) {
    schedules = schedules.filter(s => state.filters.parishIds.has(s.parish_id));
  } else if (state.viewportParishIds) {
    schedules = schedules.filter(s => state.viewportParishIds.has(s.parish_id));
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
    const jLabel = timetableLabel(juris);
    html += `<div class="jurisdiction-box" style="--juris-color:${esc(jColor)}">`;
    html += `<div class="section-header jurisdiction-header">${esc(jLabel)}</div>`;
    for (const { pid, grp: { info, items } } of pgs) {
      const parish = state.parishes.find(p => p.id === pid);
      // Distance chip: same intensity tiers as event list (near ≤5, mid ≤15, far).
      let distHtml = '';
      if (state.locationActive && parish && parish.lat && parish.lng) {
        const km = haversineKm(state.userLat, state.userLng, parish.lat, parish.lng);
        const cls = km <= 5 ? 'distance-near' : km <= 15 ? 'distance-mid' : 'distance-far';
        distHtml = `<span class="parish-schedule-dist ${cls}">${km.toFixed(1)} km</span>`;
      }
      html += `<div class="parish-schedule" data-parish-id="${esc(pid)}">`;
      html += `<div class="parish-schedule-head">`;
      html += parishAvatarHTML(parish || { name: info.parish_name, jurisdiction: juris }, 'parish-schedule-avatar');
      html += `<div class="parish-schedule-name">${esc(info.parish_name)}</div>`;
      html += distHtml;
      html += `</div>`;
      html += renderScheduleDaysHTML(items);
      html += '</div>';
    }
    html += '</div>';
  }

  html += noTimesHTML();

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
      // Don't hijack the admin controls inside the card: a row's pencil opens
      // its form in the edit dialog, and the + adds one.
      if (e.target.closest('[data-sched-edit], [data-sched-add]')) return;
      const pid = card.dataset.parishId;
      if (typeof window.openParishSheet === 'function') window.openParishSheet(pid);
    });
  });

  wireScheduleAdminHandlers(container);

  // The timetable page's "N parishes without service times on file" lands
  // here with #no-times. Once: the fragment is spent as soon as it is used, so
  // the next render (a map move) does not pull the list back up.
  // Under a filter that lists none (noTimesHTML) there is nothing to land on —
  // an older page's link — so it is spent too, or clearing the filter later
  // would pull the list up.
  if (location.hash === '#no-times') {
    const box = document.getElementById('no-times');
    if (box || T.narrowsRules(state.filters)) {
      try { history.replaceState(history.state, '', location.pathname + location.search); } catch {}
    }
    if (box) {
      if (typeof snapMainSheetToFull === 'function') snapMainSheetToFull();
      requestAnimationFrame(() => box.scrollIntoView({ block: 'start' }));
    }
  }
}

// The parishes in view that have no times on file at all — most of them, for
// now (253 of 293 in October 2026). Listed by name under the timetables so the
// view is the whole of the parishes it covers, not only the ones with times;
// each opens its parish sheet, where "Suggest edits" asks for them.
//
// No rules at all, not "none matching": a parish whose only rule is Vespers
// has times, it just has no Liturgy. Same scope as the rules above — the
// link's jurisdiction, region and parishes, then the viewport — and the same
// count the timetable page links here with. Not under a filter that asks
// something of the rules (a service, a day, a part, a language): nothing on
// file is not "no Bible study", so it would stand alone under one.
function noTimesHTML() {
  const T = window.AgoraTimetable;
  if (T.narrowsRules(state.filters)) return '';
  const withTimes = new Set((state.schedules || []).map(s => s.parish_id));
  const vp = state.viewportParishIds;
  const none = (state.parishes || [])
    .filter(p => T.parishInScope(p, state.filters)
      && (state.filters.parishIds || !vp || vp.has(p.id))
      && !withTimes.has(p.id))
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  if (!none.length) return '';
  let html = `<div class="jurisdiction-box no-times-box" id="no-times">`;
  html += `<div class="section-header jurisdiction-header">No times on file yet · ${none.length}</div>`;
  for (const p of none) {
    html += `<div class="parish-schedule" data-parish-id="${esc(p.id)}">`;
    html += `<div class="parish-schedule-head">`;
    html += parishAvatarHTML(p, 'parish-schedule-avatar');
    html += `<div class="parish-schedule-name">${esc(p.name)}`;
    if (p.address) html += `<span class="no-times-addr">${esc(p.address)}</span>`;
    html += `</div></div></div>`;
  }
  return html + '</div>';
}

// ── Event detail ──
// Tap from event list (or permalink). Toggles expansion — clicking the already-
// open card's summary collapses it; any other id switches.
function showEventDetail(id, card = null) {
  const curr = document.querySelector('.event-card.expanded');
  // With the card that was tapped: the same event can be on the feed more than
  // once (each day of one held over several), and the copy tapped is the one
  // that opens.
  if (curr && curr.dataset.id === String(id) && (!card || curr === card)) {
    closeDetail();
    return;
  }
  expandEventCard(id, card ? { card } : {});
}

/** Where on a parish sheet a card sits: the pinned slot, "Happening now", or the list. */
function cardSlot(card) {
  if (!card) return null;
  if (card.closest('.ps-pinned-event, #ps-pinned-event')) return 'pinned';
  if (card.closest('.happening-now-section')) return 'now';
  return 'list';
}

/** The copy of event `id` in `slot`, if that slot has one. */
function cardInSlot(scope, id, slot) {
  if (!scope || !slot) return null;
  return [...scope.querySelectorAll(`.event-card[data-id="${CSS.escape(String(id))}"]`)]
    .find(c => cardSlot(c) === slot) || null;
}

function expandEventCard(id, opts = {}) {
  const root = opts.scope || document;
  const evt = state.events.find(e => e.id === id);
  if (!evt) return;

  // Editing belongs to the drawer it was entered from. Opening a different
  // event with the mode still set would bring up somebody else's card already
  // spread open, which is the surprise the mode exists to end.
  if (state.eventEditMode && state.eventEditMode !== String(id)) clearEventEditMode();

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
  // Which copy was opened. One occurrence can be on a parish sheet twice —
  // pinned at the top and in the list below, or under "Happening now" — and a
  // re-render (entering edit mode is one) has to bring the drawer back on the
  // copy the person tapped, not on whichever the markup puts first.
  state._openEventSlot = cardSlot(card);
  syncURL();

  // A card being put back the way it already was — the sheet re-rendered
  // around an event somebody had open — is not a tap, and must not move the
  // reader. Without this every save made with an event open slid the parish
  // sheet from wherever they were to that card, which from a rule further
  // down the sheet read as "it scrolled back to the top".
  if (opts.keepScroll) return;

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

/** A description's links as links (public/shared/linkify.js), escaped either way. */
/**
 * Where an event or a rule is held when it is not its parish's church, or
 * null at home — worker/lib/venues.mjs's three answers, for display:
 *   short   for a title: the venue parish's name, or the place's first words
 *   line    for the drawer: a name and its address
 *   words   the place as written (custom places)
 *   lat/lng where Directions goes; parishId when it is a parish
 */
function venueOf(row) {
  if (!row) return null;
  if (row.location_parish_id && row.location_parish_id !== row.parish_id) {
    const p = (state.parishes || []).find(x => x.id === row.location_parish_id);
    if (p) {
      return { parishId: p.id, name: p.name, short: p.name, words: '',
        line: p.address ? `${p.name} — ${p.address}` : p.name, lat: p.lat, lng: p.lng };
    }
  }
  const words = (row.location_override || '').trim();
  const hasPin = row.location_lat != null && row.location_lng != null;
  if (!words && !hasPin) return null;
  return { parishId: null, name: words, words, line: words || 'A place of its own (see the map)',
    short: words ? words.split(',')[0].trim() : '',
    lat: hasPin ? Number(row.location_lat) : null, lng: hasPin ? Number(row.location_lng) : null };
}

function linkifyText(text) {
  return window.AgoraLinkify ? window.AgoraLinkify.linkify(text) : esc(text);
}

/**
 * "2½ hours", "45 min", "1 hr 10 min" — how long something runs, which is
 * what a reader wants once the card has already said when it starts.
 */
function formatDuration(ms) {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60), m = mins % 60;
  const frac = { 0: '', 15: '¼', 30: '½', 45: '¾' }[m];
  if (frac !== undefined) return `${h}${frac} ${h === 1 && !frac ? 'hour' : 'hours'}`;
  return `${h} ${h === 1 ? 'hr' : 'hrs'} ${m} min`;
}

/** Longer than this, a duration is harder to read than the clock times it spans. */
const DURATION_MAX_MS = 8 * 3600000;

function renderEventDrawerHTML(evt, opts = {}) {
  const start = new Date(evt.start_utc);

  // No date: the card sits under its day, and its time is in the hero. What
  // the meta adds is how long it runs — or, past eight hours (a vigil through
  // the night), the clock it ends on, and over several days where it starts
  // and where it ends.
  const clock = (d) => new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(d);
  const lines = [];
  if (isMultiDay(evt)) {
    const at = (d) => new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' }).format(d);
    lines.push(`From ${at(start)}`, `Until ${at(new Date(evt.end_utc))}`);
  } else if (evt.end_utc) {
    const ms = Date.parse(evt.end_utc) - start.getTime();
    if (ms > DURATION_MAX_MS) lines.push(`${clock(start)} — ${clock(new Date(evt.end_utc))}`);
    else if (ms > 0) lines.push(formatDuration(ms));
  }

  const venue = venueOf(evt);
  const addr = venue ? venue.line : (evt.parish_address || '');
  const parish = state.parishes.find(p => p.id === evt.parish_id);

  // Where the Google Maps button goes: the PLACE, not a route — the parish
  // sheet's rule (parishMapsHref), for its reason: a reader wants to see where
  // it is, and Google's page has Directions one tap further on. It has to be
  // the place this drawer names, not the parish it belongs to.
  //
  // A rule's override is TEXT (d1/schema.sql says why), so a projected
  // occurrence carries the PARISH's coordinates in evt.lat/evt.lng; only a
  // stored one-off has a pin of its own there, and only then is a coordinate
  // more precise than the words. A venue (worker/lib/venues.mjs) is exact: the
  // other parish's own Maps entry or pin, or the place's own pin.
  const hasOwnPin = evt.lat != null && evt.lng != null
    && !(parish && evt.lat === parish.lat && evt.lng === parish.lng);
  const mapsAt = (query) => `https://www.google.com/maps/search/?api=1&query=${query}`;
  let mapsHref = '';
  if (venue && venue.parishId) {
    mapsHref = parishMapsHref(state.parishes.find(p => p.id === venue.parishId));
  } else if (venue && venue.lat != null && venue.lng != null) {
    mapsHref = mapsAt(`${venue.lat},${venue.lng}`);
  } else if (venue) {
    mapsHref = hasOwnPin ? mapsAt(`${evt.lat},${evt.lng}`) : mapsAt(encodeURIComponent(venue.words || venue.line));
  } else if (parishMapsHref(parish)) {
    // At home: the parish's own Maps entry, or its pin — always current where a
    // copy on the event row may be stale.
    mapsHref = parishMapsHref(parish);
  } else if (hasOwnPin) {
    mapsHref = mapsAt(`${evt.lat},${evt.lng}`);
  } else if (addr) {
    mapsHref = mapsAt(encodeURIComponent(addr));
  }

  const watchLiveCta = (evt.parish_live_url && !evt.hide_live)
    ? `<a class="btn-watch-live" href="${esc(evt.parish_live_url)}" target="_blank" rel="noopener"><span class="live-dot"></span>Watch Live</a>`
    : '';

  // Service book button: Antiochian events only, Holy Week through end of Sunday (Agape Vespers)
  const holyWeekEnd = new Date('2026-04-13T14:00:00Z'); // midnight Monday AEST
  const serviceBookCta = (evt.jurisdiction === 'antiochian' && new Date() <= holyWeekEnd)
    ? `<a class="btn-service-book" href="https://www.antiochian.org.au/holy-week-service-books" target="_blank" rel="noopener"><img src="https://api.iconify.design/ph:book-open.svg" alt="" class="btn-service-book-icon">Service Book</a>`
    : '';

  // The drawer carries one pencil for an admin, and nothing else: the form and
  // the toolkit (Cancel, Break, Suppress, Delete, Combine…) open in the edit
  // dialog, over the card, the way Add event does — see openEventEditDialog.
  // Nothing is painted and hidden, so a visitor's drawer carries no form.
  let adminActions = '';
  if (state.isAdmin) {
    const eid = JSON.stringify(String(evt.id)).replace(/"/g, '&quot;');
    adminActions = `
      <div class="admin-actions-group">
        <button class="btn-outline btn-event-edit" onclick="setEventEditMode(${eid})" aria-haspopup="dialog">${glyph('ph:pencil-simple')}Edit</button>
      </div>`;
  }

  const posterHtml = evt.poster_path
    ? `<div class="detail-poster"><img src="${esc(evt.poster_path)}" alt="Event poster"></div>`
    : '';

  // A combined event's parishes, as their logos — "+ ◯◯◯", up to eight and
  // then an ellipsis — on a button only as wide as they are, opening the list.
  const participating = participatingParishes(evt);
  const participatingHtml = (evt.combined_parishes && evt.combined_parishes.length && participating.length > 1)
    ? `<button type="button" class="event-drawer-participating" data-participating="${esc(String(evt.id))}"
         aria-label="Participating parishes: ${participating.length}" title="Participating parishes">
         <span class="edp-part-plus" aria-hidden="true">+</span>
         <span class="edp-part-logos">${participating.slice(0, 8).map(({ parish: p }) => parishAvatarHTML(p, 'edp-part-logo', 'span')).join('')}</span>
         ${participating.length > 8 ? '<span class="edp-part-more" aria-hidden="true">…</span>' : ''}
       </button>`
    : '';

  // Promoted hero: type label above, then time + title inline, then parish.
  // Suppressed inside the parish sheet itself — the user is already on that parish.
  const displayType = TYPE_DISPLAY[evt.event_type] || evt.event_type;
  const badgeCss = `badge-${evt.event_type}`;
  let heroHtml = '';
  if (parish) {
    const juris = capitalize(parish.jurisdiction || '');
    const heroTime = formatEventTime(start);
    const parishRow = opts.suppressParishHeader ? '' : `
      <button type="button" class="event-drawer-parish-btn" data-parish-id="${esc(parish.id)}">
        ${parishAvatarHTML(parish, 'event-drawer-avatar', 'span')}
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
          <span class="edp-time">${heroTime}</span><span class="edp-title-wrap"><span class="edp-title">${esc(evt.title)}</span>${evt.feast ? feastLineHTML(evt.feast, 'edp-feast') : ''}</span>
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

  // The poster floats at the right, from just under the parish, and what the
  // drawer says flows beside it and on underneath it.
  return `
    <button class="event-card-close" type="button" aria-label="Close">&times;</button>
    ${heroHtml}
    <div class="event-drawer-body${posterHtml ? ' has-poster' : ''}">
      ${posterHtml}
      ${participatingHtml}
      <div class="event-drawer-meta">
        ${lines.map(l => `<div>${esc(l)}</div>`).join('')}
        ${addrHtml}
        ${evt.distance_km != null ? `<div class="distance-blue">${esc(String(evt.distance_km))} km away</div>` : ''}
        ${evt.languages ? `<div>${esc((() => { try { return JSON.parse(evt.languages).join(', '); } catch { return evt.languages; } })())}</div>` : ''}
      </div>
      ${evt.description && evt.description.trim() ? `<div class="detail-description">${linkifyText(evt.description.trim())}</div>` : ''}
    </div>
    <div class="detail-actions">
      ${mapsHref ? `<a class="btn-action btn-primary btn-google-maps" href="${esc(mapsHref)}" target="_blank" rel="noopener">
        <img class="btn-action-icon" src="https://api.iconify.design/ph:map-pin-fill.svg" alt="">Google Maps
      </a>` : ''}
      <button class="btn-action btn-share-event" type="button" data-share-id="${evt.id}">
        <img class="btn-action-icon" src="https://api.iconify.design/ph:paper-plane-tilt.svg" alt="">Share
      </button>
      <span class="bookmark-slot">${bookmarkButtonsHTML(evt)}</span>
      ${watchLiveCta}
      ${serviceBookCta}
      ${adminActions}
    </div>`;
}

/**
 * Every parish taking part in a combined event, once each, with its part in
 * it: the host first, then where it is held when that is another parish
 * (the venue), then the parishes the combine added.
 */
function participatingParishes(evt) {
  const venue = venueOf(evt);
  const venueId = venue && venue.parishId;
  const ids = [evt.parish_id, venueId, ...(evt.combined_parishes || [])];
  const seen = new Set();
  const out = [];
  for (const id of ids) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const p = (state.parishes || []).find(x => x.id === id);
    if (!p) continue;
    // The venue is the parish whose church it is held in: another parish's
    // when it is held there, the host's own when it is held at home. A host
    // whose event is somewhere else is only the host.
    const atHome = !venue && id === evt.parish_id;
    out.push({ parish: p, role: id === venueId || atHome ? 'venue' : id === evt.parish_id ? 'host' : 'participant' });
  }
  return out;
}

/** "Participating parishes • 3", opened: the parishes, each a way to its card. */
function openParticipatingDialog(id) {
  const evt = (state.events || []).find(e => String(e.id) === String(id));
  if (!evt) return;
  const parishes = participatingParishes(evt);
  const body = openFormDialog({
    kind: 'participating',
    title: `Participating parishes · ${parishes.length}`,
    sub: evt.title,
    html: `<div class="participating-list">${parishes.map(({ parish: p, role }) => `
        <button type="button" class="event-drawer-parish-btn participating-${role}" data-parish-id="${esc(p.id)}">
          ${parishAvatarHTML(p, 'event-drawer-avatar', 'span')}
          <span class="edp-text">
            <span class="edp-name">${esc(p.name)}</span>
            <span class="edp-juris">${role === 'host' ? '<span class="participating-role">Host</span>'
              : role === 'venue' ? '<span class="participating-role">Venue</span>'
              : esc(`${capitalize(p.jurisdiction || '')} Orthodox`)}</span>
          </span>
          <img class="edp-chev" src="https://api.iconify.design/ph:caret-right-bold.svg" alt="">
        </button>`).join('')}</div>`,
  });
  body.querySelectorAll('[data-parish-id]').forEach(b => b.addEventListener('click', () => {
    closeFormDialog();
    openParishSheet(b.dataset.parishId);
  }));
}

/**
 * What the edit dialog holds for one event: the toolkit, then the form.
 *
 * ids are JSON-quoted so synthetic schedule instance ids ("13:2026-07-04")
 * round-trip as JS string literals. &quot; lets the embedded double quotes
 * survive the outer onclick="..." attribute (HTML parser would otherwise
 * terminate the attribute at the first inner ").
 */
function eventEditFormHTML(evt) {
  const isCancelled = evt.status === 'cancelled';
  const isHidden = evt.status === 'hidden';
  const isHeadless = evt.mutation_type === 'headless';
  const isScheduleOrigin = evt.source_adapter === 'schedule' || evt.mutation_type === 'scheduled' || evt.mutation_type === 'adapted';
  const eid = JSON.stringify(String(evt.id)).replace(/"/g, '&quot;');
  // Break sits with Cancel and Suppress because it is the third answer to the
  // same question, and the one people actually reach for most: this service
  // is off for a while. Only on a projected occurrence — a break is a
  // statement about a RULE over a stretch of dates, and a stored one-off has
  // no rule to make it about.
  const onBreak = evt.status === 'break';
  const breakBtn = isScheduleOrigin
    ? `<button class="btn-outline btn-break-event" onclick="openBreakEditor(${eid})">${onBreak ? 'On break — edit' : 'Break…'}</button>`
    : '';
  const parishOpts = state.parishes.filter(p => p.id !== '_unassigned').map(p =>
    `<option value="${esc(p.id)}" ${p.id === evt.parish_id ? 'selected' : ''}>${esc(p.name)}</option>`
  ).join('');
  return `
    <div class="admin-actions-group event-edit-actions">
      <button class="btn-outline btn-cancel-event" onclick="setEventStatus(${eid},'${isCancelled ? 'approved' : 'cancelled'}')">${isCancelled ? 'Uncancel' : 'Cancel'}</button>
      ${breakBtn}
      ${isScheduleOrigin ? `<button class="btn-outline btn-hide-event" onclick="setEventStatus(${eid},'${isHidden ? 'approved' : 'hidden'}')">${isHidden ? 'Unsuppress' : 'Suppress'}</button>` : ''}
      ${isHeadless ? `<button class="btn-danger" onclick="deleteEvent(${eid})">Delete</button>` : ''}
      ${isScheduleOrigin ? '' : `<button class="btn-outline" onclick="openPublicEscalateModal(${eid})">Include other parishes…</button>`}
    </div>
    <div class="detail-edit-form" id="edit-form-${evt.id}">
      ${seriesLineHTML(evt)}
      <div class="edit-row"><label>Title</label><input id="edit-title-${evt.id}" value="${esc(evt.title)}"></div>
      <div class="edit-row"><label>Description</label><textarea id="edit-desc-${evt.id}">${esc(evt.description || '')}</textarea></div>
      <div class="edit-row"><label>Type</label>
        <select id="edit-type-${evt.id}" data-kind-picker>
          ${EVENT_TYPES.map(t =>
            `<option value="${t}" ${evt.event_type === t ? 'selected' : ''}>${t}</option>`
          ).join('')}
        </select>
      </div>
      <div class="edit-row"><label>Parish</label>
        <select id="edit-parish-${evt.id}">${parishOpts}</select>
      </div>
      <div class="edit-row"><label>Languages</label><input id="edit-langs-${evt.id}" placeholder="English, Arabic" value="${esc(evt.languages ? JSON.parse(evt.languages).join(', ') : '')}"></div>
      ${eventWhenHTML(evt)}
      <div class="edit-row edit-venue"><label>Where</label>${venueFieldsHTML('data-ev-loc', evt)}</div>
      ${evt.parish_live_url ? `<div class="edit-row"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="edit-hide-live-${evt.id}" ${evt.hide_live ? 'checked' : ''}> Hide live badge</label></div>` : ''}
      <div class="edit-row"><label style="display:flex;align-items:center;gap:6px;cursor:pointer;"><input type="checkbox" id="edit-parish-scoped-${evt.id}" ${evt.parish_scoped ? 'checked' : ''}> Parish-only (hidden unless filtered to parish)</label></div>
      <!-- The poster. Outside Save deliberately: it is a file going to R2
           rather than a field going to the row, it has its own endpoint, and
           a picture that uploads when you pick it is what everybody expects
           a picture to do. The same reasoning the logo editor already uses. -->
      <div class="edit-row">
        <label>Poster</label>
        ${posterEditorHTML(evt)}
      </div>
      <div class="form-actions">
        <button class="btn-save" onclick="saveEvent(${eid})">Save</button>
        <button class="btn-outline" type="button" onclick="closeFormDialog()">Close</button>
      </div>
    </div>`;
}

/**
 * Date, Starts, Ends — and for a one-off, a Multi-day tick that brings out
 * its last day, the end time being the time it ends on that day. A rule's
 * date is one day of a weekly service, so it has no tick.
 */
function eventWhenHTML(evt) {
  const id = evt.id;
  const s = utcToLocalInput(evt.start_utc), e = utcToLocalInput(evt.end_utc);
  const multi = isMultiDay(evt);
  const oneOff = !String(id).includes(':');
  const eid = JSON.stringify(String(id)).replace(/"/g, '&quot;');
  return `
      <div class="edit-row"><label>Date (Sydney)</label><input type="date" id="edit-date-${id}" value="${esc(s.slice(0, 10))}"></div>
      <div class="edit-row edit-pair">
        <div><label>Starts</label><input type="time" id="edit-starttime-${id}" value="${esc(s.slice(11, 16))}"></div>
        <div><label id="edit-endlabel-${id}">${multi ? 'Ends, last day' : 'Ends'}</label><input type="time" id="edit-endtime-${id}" value="${esc(e.slice(11, 16))}"></div>
      </div>
      ${oneOff ? `
      <label class="edit-check"><input type="checkbox" id="edit-multi-${id}" ${multi ? 'checked' : ''} onchange="agoraEditMultiday(${eid})"> Multi-day</label>
      <div class="edit-row" id="edit-lastday-${id}"${multi ? '' : ' hidden'}><label>Last day</label><input type="date" id="edit-enddate-${id}" value="${multi ? esc(e.slice(0, 10)) : ''}"></div>` : ''}`;
}

window.agoraEditMultiday = function (id) {
  const on = document.getElementById(`edit-multi-${id}`).checked;
  document.getElementById(`edit-lastday-${id}`).hidden = !on;
  document.getElementById(`edit-endlabel-${id}`).textContent = on ? 'Ends, last day' : 'Ends';
  if (on) document.getElementById(`edit-enddate-${id}`).focus({ preventScroll: true });
};

/** The edit form's Date / Starts / Ends / Last day as instants, or an error to say. */
function readEventWhen(id) {
  const val = (k) => { const el = document.getElementById(`edit-${k}-${id}`); return el ? el.value : ''; };
  const date = val('date'), st = val('starttime'), et = val('endtime');
  const multiEl = document.getElementById(`edit-multi-${id}`);
  const multi = !!(multiEl && multiEl.checked);
  const last = multi ? val('enddate') : '';
  if (multi && (!last || !date || last <= date)) return { error: 'The last day must be after the first.' };
  if (multi && !et) return { error: 'Give the time it ends on its last day.' };
  const start_utc = date && st ? localInputToUtc(`${date}T${st}`) : undefined;
  let end_utc = null;
  if (et && date) {
    end_utc = localInputToUtc(`${multi ? last : date}T${et}`);
    // One day, and it ends earlier on the clock than it starts: after midnight.
    if (!multi && start_utc && Date.parse(end_utc) <= Date.parse(start_utc)) {
      end_utc = new Date(Date.parse(end_utc) + 86400000).toISOString();
    }
  }
  return { start_utc, end_utc };
}

/** The line under the dialog's title: what, when, where. */
function eventEditSub(evt) {
  const when = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
    .format(new Date(evt.start_utc));
  return [evt.title, when, evt.parish_name].filter(Boolean).join(' · ');
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
      'button, a, input, textarea, select, .event-drawer-hero-title, .event-drawer-address, .event-drawer-poster, .detail-poster'
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
      if (pid) openParishFromEvent(pid, evt.id);
    });
  }

  const partBtn = drawer.querySelector('[data-participating]');
  if (partBtn) partBtn.addEventListener('click', () => openParticipatingDialog(partBtn.dataset.participating));

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
      ${parishMapsHref(parish) ? `<a class="btn-primary" href="${esc(parishMapsHref(parish))}" target="_blank" rel="noopener">Google Maps</a>` : ''}
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

/**
 * The poster control, for a stored event or a projected occurrence alike.
 *
 * A rule has no poster — a weekly liturgy has no flyer — so on an occurrence
 * this writes `patch_poster_path` on that one date's override and the weeks
 * either side are untouched. The Worker routes on the shape of the id; nothing
 * here has to know which it is holding.
 *
 * What a parish sends is usually a bulletin for a PERIOD, though, so "Put it
 * on" can widen the upload to every occurrence of this service, or everything
 * at the parish, between two dates — one object, pointed at by each service in
 * the range (worker/lib/poster-range.mjs). The dates default to this service's
 * month, which is the shape a monthly bulletin has.
 */
function posterEditorHTML(evt) {
  const eid = esc(String(evt.id));
  const has = !!evt.poster_path;
  const isRule = String(evt.id).includes(':');
  const day = eventLocalDate(evt) || '';
  const [y, m] = day.split('-').map(Number);
  const monthStart = day ? `${day.slice(0, 7)}-01` : '';
  const monthEnd = day ? `${day.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}` : '';
  // Shared = not the object this one service's own upload would have written,
  // so taking it off here leaves it on the others.
  const own = `/posters/${String(evt.id).replace(':', '-')}.`;
  // The rule's own poster (migration 021) is the rule's to change: this date
  // shows it because it has none of its own, and taking it off here would
  // take it off nothing.
  const ruleOwn = has && !!evt.rule_poster;
  const shared = has && !ruleOwn && !String(evt.poster_path).startsWith(own);
  const parish = evt.parish_name || 'this parish';
  const sid = isRule ? String(evt.id).split(':')[0] : '';
  return `
    <div class="poster-edit" data-event-id="${eid}">
      ${has ? `<img class="poster-edit-thumb" src="${esc(evt.poster_path)}" alt="">` : ''}
      ${ruleOwn ? `<div class="edit-row-hint">On every ${esc(evt.title || 'date of this service')} — the service’s own poster.
        <button type="button" class="series-edit" onclick="agoraEditSeries(${esc(sid)})">${glyph('ph:repeat')}Change it on the series</button></div>` : ''}
      <label class="poster-scope">Put ${ruleOwn ? 'a different one' : 'it'} on
        <select data-poster-scope onchange="agoraPosterScope('${eid}')">
          <option value="">this service only</option>
          ${isRule ? `<option value="series">every ${esc(evt.title || 'service like this')} — the service’s own</option>` : ''}
          ${isRule ? `<option value="rule">every ${esc(evt.title || 'service like this')} from…</option>` : ''}
          <option value="parish">everything at ${esc(parish)} from…</option>
        </select>
      </label>
      <div class="poster-range" data-poster-range hidden>
        <input type="date" data-poster-from value="${esc(monthStart)}" aria-label="From">
        <span>to</span>
        <input type="date" data-poster-until value="${esc(monthEnd)}" aria-label="Until">
      </div>
      <div class="poster-edit-actions">
        <button class="ps-btn ps-btn-admin" type="button"
                onclick="agoraPickEventPoster('${eid}')">${glyph('ph:image-square')}${has && !ruleOwn ? 'Replace' : 'Add a poster'}</button>
        ${has && !ruleOwn ? `<button class="ps-btn ps-btn-danger" type="button"
                onclick="agoraClearEventPoster('${eid}')">${glyph('ph:trash')}${shared ? 'Remove from this one' : 'Remove'}</button>` : ''}
        ${shared ? `<button class="ps-btn ps-btn-danger" type="button"
                onclick="agoraClearEventPoster('${eid}', true)">${glyph('ph:trash')}Remove everywhere</button>` : ''}
      </div>
      <div class="edit-row-hint poster-edit-status" data-poster-status></div>
    </div>`;
}

const _posterBox = (id) => document.querySelector(`.poster-edit[data-event-id="${CSS.escape(String(id))}"]`);

/** Show the dates only once a range is chosen. */
window.agoraPosterScope = function (id) {
  const box = _posterBox(id);
  if (!box) return;
  const scope = box.querySelector('[data-poster-scope]').value;
  // The service's own poster has no dates: it is on every one.
  box.querySelector('[data-poster-range]').hidden = !scope || scope === 'series';
};

/** The range the control asks for, as a query string, or '' for one service. */
function _posterRangeQuery(id) {
  const box = _posterBox(id);
  const scope = box && box.querySelector('[data-poster-scope]').value;
  if (!scope) return { query: '' };
  if (scope === 'series') return { series: String(id).split(':')[0] };
  const from = box.querySelector('[data-poster-from]').value;
  const until = box.querySelector('[data-poster-until]').value;
  if (!from || !until) return { error: 'Pick the first and last day the poster covers.' };
  if (from > until) return { error: 'The last day is before the first.' };
  return { query: `?scope=${scope}&from=${from}&until=${until}` };
}

/** The one hidden file input, reused — a fresh one per render leaks listeners. */
function _posterInput() {
  let el = document.getElementById('agora-poster-input');
  if (!el) {
    el = document.createElement('input');
    el.type = 'file';
    el.id = 'agora-poster-input';
    el.accept = 'image/png,image/jpeg,image/webp,image/gif';
    el.hidden = true;
    document.body.appendChild(el);
  }
  return el;
}

const _posterStatus = (id, msg, bad) => {
  const box = document.querySelector(`.poster-edit[data-event-id="${CSS.escape(String(id))}"] [data-poster-status]`);
  if (box) {
    box.textContent = msg || '';
    box.classList.toggle('edit-row-hint-bad', !!bad);
  }
};

/**
 * Send one image to an event's poster endpoint.
 *
 * Raw body rather than multipart, matching the logo upload: the Worker reads
 * `arrayBuffer()` and takes the extension off the content type, so there is
 * nothing to parse and no boundary to get wrong.
 */
async function uploadEventPoster(id, file, query = '') {
  if (!file) return { error: 'No file chosen.' };
  // Refused here as well as at the Worker so an 8 MB phone photo does not go up
  // the wire only to be turned away at the other end.
  if (file.size > 8 * 1024 * 1024) return { error: 'That poster is over 8 MB — the limit the Worker takes.' };
  try {
    const res = await fetch(`/api/admin/events/${encodeURIComponent(id)}/poster${query}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'image/jpeg' },
      body: file,
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) return { error: (body && body.error) || `The poster was refused (${res.status}).` };
    return body;
  } catch {
    return { error: 'The poster could not be uploaded — check the connection.' };
  }
}

window.agoraPickEventPoster = function (id) {
  // Checked before the file picker opens, so a bad range is said at once
  // rather than after somebody has gone looking for the file.
  const range = _posterRangeQuery(id);
  if (range.error) return _posterStatus(id, range.error, true);
  const input = _posterInput();
  input.value = '';
  input.onchange = async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    _posterStatus(id, 'Uploading…');
    if (range.series) {
      const rr = await uploadRulePoster(range.series, file);
      if (rr.error) return _posterStatus(id, rr.error, true);
      _posterStatus(id, 'Poster saved on the service — it shows on every date.');
      return _afterRulePosterChange(range.series);
    }
    const r = await uploadEventPoster(id, file, range.query);
    if (r.error) return _posterStatus(id, r.error, true);
    const n = r.count || 1;
    _posterStatus(id, n > 1 ? `Poster saved on ${n} services.` : 'Poster saved.');
    await _afterPosterChange();
  };
  input.click();
};

window.agoraClearEventPoster = async function (id, everywhere = false) {
  const ask = everywhere
    ? 'Take this poster off every service at this parish that shows it?'
    : 'Take this poster off this service?';
  if (!confirm(ask)) return;
  _posterStatus(id, 'Removing…');
  try {
    const res = await fetch(
      `/api/admin/events/${encodeURIComponent(id)}/poster${everywhere ? '?everywhere' : ''}`,
      { method: 'DELETE' });
    const body = await res.json().catch(() => null);
    if (!res.ok) return _posterStatus(id, (body && body.error) || `That failed (${res.status}).`, true);
  } catch {
    return _posterStatus(id, 'That failed — check the connection.', true);
  }
  await _afterPosterChange();
};

/** Re-read so the card, the drawer and the parish sheet all show it. */
async function _afterPosterChange() {
  // Taken before the refetch, which repaints the drawer the person may still
  // be typing in. See snapshotTyped.
  const typed = snapshotTyped(document);
  await fetchEvents({ fresh: true, keepCount: true });
  repaintOpenEventDrawer();
  // Also with no drawer open: the poster shows on the collapsed card too.
  if (state.parishSheetFocus && !state._openEventId) {
    renderParishSheetContent(state.parishSheetFocus, { fullRender: true });
  }
  restoreTyped(document, typed);
}

/**
 * Turn editing on for ONE event, or off entirely.
 *
 * Re-renders rather than toggling a `display`, because the point of the mode is
 * that the controls are not in the document at all until somebody asks for
 * them — see `state.eventEditMode`.
 */
/** Editing belongs to the open drawer; closing it closes the dialog too. */
function clearEventEditMode() {
  if (state.eventEditMode) state.eventEditMode = null;
  if (formDialogKind() === 'event') closeFormDialog();
}

/**
 * Tear the open drawer down and let it be built again with what changed.
 *
 * There are TWO renderers that can put it back, and which one owns the card
 * depends on where it was tapped: `renderEvents` for the main feed, and the
 * parish sheet's own render for a card inside the sheet. `renderEvents`
 * returns immediately while the sheet is up — it has to, the card pool is
 * shared and it would otherwise move the sheet's mounted cards into the
 * hidden list behind it — so a collapse followed by `scheduleRenderEvents`
 * alone left the sheet holding nothing.
 *
 * That is what "Edit" did to a pinned occurrence: the details vanished and no
 * form arrived, because the only thing that could have drawn the form was the
 * render that had just declined to run. Both are called here; the one that is
 * not showing does nothing.
 */
function repaintOpenEventDrawer() {
  refreshEventEditDialog();
  if (!state._openEventId) return;
  collapseEventCardDOM({ instant: true });
  scheduleRenderEvents(0);
  if (state.parishSheetFocus) {
    // fullRender, because the partial refresh leaves the pinned slot alone
    // — and under a schedule focus the pinned slot is the card in question.
    renderParishSheetContent(state.parishSheetFocus, { fullRender: true });
  }
}

window.setEventEditMode = function (id) {
  if (id == null) { clearEventEditMode(); return; }
  openEventEditDialog(String(id));
};

/**
 * Editing an event: the form and the toolkit in the edit dialog, over the card.
 *
 * The drawer stays as a visitor reads it underneath, and the dialog is the
 * mode — `state.eventEditMode` is set while it is open and cleared by closing
 * it, so nothing else has to remember to leave the mode. Combine, Break and the
 * "which dates" question open above it (later in the document, same z-index).
 */
function openEventEditDialog(id) {
  const evt = state.events.find(e => String(e.id) === id);
  if (!evt) return;
  state.eventEditMode = id;
  const body = openFormDialog({
    kind: 'event',
    title: String(id).includes(':') ? 'Edit service' : 'Edit event',
    sub: eventEditSub(evt),
    html: eventEditFormHTML(evt),
    onClose: () => { state.eventEditMode = null; },
  });
  mountVenuePicker(body, evt.parish_id, evt);
  const first = body.querySelector(`#edit-title-${CSS.escape(id)}`);
  if (first) first.focus({ preventScroll: true });
}

/** After a poster or a break: the dialog redrawn with what changed, where it was scrolled. */
function refreshEventEditDialog() {
  if (formDialogKind() !== 'event' || !state.eventEditMode) return;
  const evt = state.events.find(e => String(e.id) === state.eventEditMode);
  if (!evt) { closeFormDialog(); return; }
  const modal = document.querySelector('#form-backdrop .form-modal');
  const top = modal ? modal.scrollTop : 0;
  const form = document.getElementById('form-body');
  // What the picker holds was not saved yet; keep it across the redraw.
  const held = form.querySelector('[data-ev-loc]') ? venueFrom(form, 'data-ev-loc') : null;
  form.innerHTML = eventEditFormHTML(evt);
  mountVenuePicker(form, evt.parish_id, held || evt);
  document.getElementById('form-sub').textContent = eventEditSub(evt);
  if (modal) modal.scrollTop = top;
}

window.saveEvent = async function(id) {
  const when = readEventWhen(id);
  if (when.error) { alert(when.error); return; }
  const langsRaw = document.getElementById(`edit-langs-${id}`).value;
  const langsArr = langsRaw ? langsRaw.split(',').map(s => s.trim()).filter(Boolean) : [];
  const hideLiveEl = document.getElementById(`edit-hide-live-${id}`);
  const data = {
    title: document.getElementById(`edit-title-${id}`).value,
    description: document.getElementById(`edit-desc-${id}`).value || null,
    event_type: document.getElementById(`edit-type-${id}`).value,
    parish_id: document.getElementById(`edit-parish-${id}`).value,
    languages: langsArr.length ? JSON.stringify(langsArr) : null,
    start_utc: when.start_utc,
    end_utc: when.end_utc
  };
  if (hideLiveEl) data.hide_live = hideLiveEl.checked;
  const parishScopedEl = document.getElementById(`edit-parish-scoped-${id}`);
  if (parishScopedEl) data.parish_scoped = parishScopedEl.checked;
  // Where: the four fields the picker keeps (venueFieldsHTML), sent whole.
  const form = document.getElementById(`edit-form-${id}`);
  if (form && form.querySelector('[data-ev-loc]')) Object.assign(data, venueFrom(form, 'data-ev-loc'));
  // A repeating service asks which dates the change is for. "This and every
  // following" changes the rule from this date on — the earlier dates keep
  // what they were — and the drawer reopens on the same date of the new rule.
  const series = seriesOf(id);
  if (series) {
    const pick = await askChoice({
      title: 'Save the change for…',
      choices: [
        { value: 'one', label: `Only ${series.dateLabel}` },
        { value: 'following', label: `This and every following ${series.day}`,
          hint: 'Earlier dates keep what they were.' },
      ],
    });
    if (!pick) return;
    if (pick === 'following') {
      if (!(await ensureKeptByHand(series.rule.parish_id))) return;
      const { parish_id, ...fields } = data;   // eslint-disable-line no-unused-vars
      const r = await postFollowing(id, { action: 'edit', ...fields });
      if (r) await _afterSeriesChange(r.schedule_id ? `${r.schedule_id}:${series.date}` : null);
      return;
    }
  }
  const res = await fetch(`/api/admin/events/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  if (res.ok) {
    closeFormDialog();
    // Refresh state.events, then rebuild the open drawer in place so the
    // user sees the new values immediately without closing the detail.
    // collapseEventCardDOM only tears down the DOM; state._openEventId is
    // preserved so renderEvents re-expands the same card with fresh data.
    // { fresh: true } bypasses the 60s browser cache on /api/events so the
    // just-written change is actually visible (otherwise stale read wins).
    await fetchEvents({ fresh: true });
    repaintOpenEventDrawer();
  }
};

// What each of these actually does, in the words somebody needs before doing it.
//
// Cancel and Suppress look like neighbours and behave nothing alike, which is
// the whole reason they are confirmed: a cancellation STAYS on the feed as a
// tombstone so a person who would have turned up sees it is off, and a
// suppression takes the service off the site with no notice at all. Reaching
// for the wrong one sends somebody to a locked church.
const EVENT_STATUS_CONFIRM = {
  cancelled: 'Mark this as CANCELLED?\n\nIt stays on the feed, struck through, so anyone who '
    + 'would have turned up sees that it is off.',
  hidden: 'SUPPRESS this?\n\nIt disappears from the site with no notice — nobody is told it is '
    + 'off. Use Cancel instead for a service that is simply not running this week.',
  approved: null,
};

/**
 * Ask one question with a few labelled answers; resolves to the chosen value,
 * or null for Back / Escape / a tap outside.
 *
 * For the questions confirm() cannot ask: "this Sunday, or this and every
 * following Sunday" has two right answers and a way out, and OK/Cancel would
 * have to stand for one of the answers. Built on the same frame as the other
 * dialogs (.escalate-backdrop) and torn down after, so nothing sits in the
 * document between questions.
 */
function askChoice({ title, body = '', choices }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'escalate-backdrop open choice-backdrop';
    back.innerHTML = `
      <div class="escalate-modal choice-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <h2>${esc(title)}</h2>
        ${body ? `<div class="choice-body">${body}</div>` : ''}
        <div class="choice-list">
          ${choices.map((c, i) => `
            <button type="button" class="choice-opt${c.danger ? ' danger' : ''}" data-i="${i}">
              <span class="choice-label">${esc(c.label)}</span>
              ${c.hint ? `<span class="choice-hint">${esc(c.hint)}</span>` : ''}
            </button>`).join('')}
        </div>
        <div class="escalate-btn-row"><button type="button" class="ps-btn ps-btn-ghost" data-back>Back</button></div>
      </div>`;
    const done = (v) => {
      document.removeEventListener('keydown', onKey, true);
      back.remove();
      resolve(v);
    };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
    back.addEventListener('click', (e) => {
      if (e.target === back || e.target.closest('[data-back]')) return done(null);
      const opt = e.target.closest('.choice-opt');
      if (opt) done(choices[Number(opt.dataset.i)].value);
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(back);
    const first = back.querySelector('.choice-opt');
    if (first) first.focus({ preventScroll: true });
  });
}

/**
 * At the head of an occurrence's form: which repeating service this date
 * belongs to, and the way to the rule itself.
 *
 * The pilot's admins opened one Sunday and looked for the whole series there,
 * the way a calendar works. The timetable row IS the series, but nothing said
 * so — this line does, from the place people actually look.
 */
function seriesLineHTML(evt) {
  const series = seriesOf(evt.id);
  if (!series) return '';
  const r = series.rule;
  const wom = womDisplayLabel(r, series.day).replace(/<[^>]+>/g, '').trim();
  const when = wom || (r.week_parity ? `every other ${series.day}` : `every ${series.day}`);
  const range = ruleRangeLabel(r).replace(/<[^>]+>/g, '').trim();
  const sid = esc(String(r.id));
  const button = mayEditTimetable(r.parish_id)
    ? `<button type="button" class="series-edit" onclick="agoraEditSeries(${sid})">${glyph('ph:repeat')}Edit the series</button>`
    : '';
  return `
    <div class="series-line">
      <span class="series-what">Repeats ${esc(when)} at ${formatTime12(r.start_time)}${range ? ` · ${esc(range)}` : ''}</span>
      ${button}
    </div>`;
}

/** From an occurrence to its rule: the rule's own form, in the edit dialog. */
window.agoraEditSeries = function (sid) {
  if (!ruleById(sid)) return;
  clearEventEditMode();
  openRuleEditDialog(sid);
};

/**
 * A rule by id, wherever it is loaded. `state.schedules` is filled for the
 * services view and the sheets; the main feed may not have asked for it yet,
 * but the bundle every occurrence was projected from always holds the rule.
 */
function ruleById(sid) {
  return (state.schedules || []).find(s => String(s.id) === String(sid))
    || ((window.agoraBundle && window.agoraBundle.schedules && window.agoraBundle.schedules()) || [])
      .find(s => String(s.id) === String(sid))
    || null;
}

/** The rule behind a projected occurrence, and the date, or null for a one-off. */
function seriesOf(id) {
  const m = /^(\d+):(\d{4}-\d{2}-\d{2})$/.exec(String(id));
  if (!m) return null;
  const rule = ruleById(m[1]);
  if (!rule) return null;
  const day = DAYS[rule.day_of_week];
  const dateLabel = new Intl.DateTimeFormat('en-AU', { weekday: 'long', day: 'numeric', month: 'short' })
    .format(new Date(m[2] + 'T00:00:00Z'));
  return { rule, date: m[2], day, dateLabel };
}

/** POST a following-dates change; asks about later decisions if the server says there are any. */
async function postFollowing(id, body) {
  const send = (extra = {}) => fetch(`/api/admin/events/${encodeURIComponent(id)}/following`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, ...extra }),
  });
  let res = await send();
  if (res.status === 409) {
    const q = await res.clone().json().catch(() => null);
    if (q && q.needs_choice) {
      const fmt = (d) => new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short' })
        .format(new Date(d + 'T00:00:00Z'));
      const items = [
        ...q.movable.map(o => `<li>${esc(fmt(o.date))} — ${esc(o.what)}</li>`),
        ...q.stranded.map(o => `<li>${esc(fmt(o.date))} — ${esc(o.what)} <em>(cannot move: no service that day any more)</em></li>`),
        ...q.breaks.map(b => `<li>Break ${esc(fmt(b.from))} – ${esc(fmt(b.to))}${b.note ? ` — ${esc(b.note)}` : ''}</li>`),
      ];
      const keep = await askChoice({
        title: 'Later dates already have their own changes',
        body: `<ul class="choice-items">${items.join('')}</ul>`,
        choices: [
          { value: 'carry', label: 'Keep them', hint: 'They apply to the changed service too.' },
          { value: 'discard', label: 'Discard them', hint: 'The changed service starts clean.', danger: true },
        ],
      });
      if (!keep) return null;
      res = await send({ keep });
    }
  }
  if (!res.ok) { alert(await adminErrorText(res)); return null; }
  return res.json().catch(() => ({}));
}

/** After a series write: rules and occurrences both moved, so re-read both. */
async function _afterSeriesChange(openId) {
  clearEventEditMode();
  await fetchSchedules({ fresh: true });
  await fetchEvents({ fresh: true, keepCount: true });
  if (openId && state.events.some(e => e.id === openId)) {
    state._openEventId = openId;
    repaintOpenEventDrawer();
  } else {
    closeDetail();
  }
}

window.setEventStatus = async function(id, status) {
  // Cancelling a service that repeats asks the calendar question first: this
  // date, or this and every one after it. The second ends the rule, which is
  // not a cancellation at all — so it says what it does instead.
  const series = status === 'cancelled' ? seriesOf(id) : null;
  if (series) {
    const pick = await askChoice({
      title: `Cancel ${series.rule.title}?`,
      choices: [
        { value: 'one', label: `Only ${series.dateLabel}`,
          hint: 'It stays on the feed, struck through, so anyone who would have turned up sees it is off.' },
        { value: 'following', label: `This and every following ${series.day}`, danger: true,
          hint: 'The service ends. Later dates leave the site and the timetable — they are not shown as cancelled. If it is coming back, use Break instead.' },
      ],
    });
    if (!pick) return;
    if (pick === 'following') {
      if (!(await ensureKeptByHand(series.rule.parish_id))) return;
      const r = await postFollowing(id, { action: 'end' });
      if (r) await _afterSeriesChange(null);
      return;
    }
  }
  const ask = series ? null : EVENT_STATUS_CONFIRM[status];
  if (ask && !confirm(ask)) return;
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

// The parish sheet's three way-to-reach-them buttons, iconed the same in the
// sheet and in its edit view (and on the lite card, worker/lib/lite-page.mjs).
const PARISH_BTN_GLYPH = { maps: 'ph:map-pin-fill', website: 'ph:globe', phone: 'ph:phone' };

/** Where the sheet's Google Maps button goes: the parish's own entry, or its pin. */
function parishMapsHref(parish) {
  if (!parish) return '';
  if (parish.maps_url) return parish.maps_url;
  if (parish.lat && parish.lng) return `https://www.google.com/maps/search/?api=1&query=${parish.lat},${parish.lng}`;
  return '';
}

/**
 * A parish's round avatar: its logo, or — where it has none — its acronym in
 * its jurisdiction's colour on white, with a slight gradient. It was the
 * first letter of its name on a disc of the colour, which made every "St …"
 * an S. The pieces, for the avatars that carry more (the sheet's glow, the
 * edit pencil): an extra class, an inline style, and what goes inside.
 */
function parishAvatarParts(parish) {
  if (parish && parish.logo_path) return { cls: '', style: '', inner: `<img src="${esc(parish.logo_path)}" alt="">` };
  const ink = getParishDisplayColor((parish && parish.color) || rawJurisColor(parish && parish.jurisdiction));
  const text = String((parish && parish.acronym) || ((parish && parish.name) || '?')[0]).toUpperCase();
  return {
    cls: ' avatar-acronym',
    style: `--avatar-ink:${esc(ink)};`,
    inner: `<span class="avatar-acronym-text" data-len="${Math.min(text.length, 5)}">${esc(text)}</span>`,
  };
}
function parishAvatarHTML(parish, cls, tag = 'div') {
  const a = parishAvatarParts(parish);
  return `<${tag} class="${cls}${a.cls}"${a.style ? ` style="${a.style}"` : ''}>${a.inner}</${tag}>`;
}

/** May the signed-in person change this parish's service times? The Worker asks the same. */
function mayEditTimetable(parishId) {
  return !!(state.isAdmin && adminMay('schedule.edit', parishId));
}

/**
 * The service-times panel on a parish sheet.
 *
 * It carries the parish's logo and short name at its head, the way the same
 * panel does on the main services list — the timetable is often screenshotted
 * and sent on its own, and a block of times with no parish on it says nothing.
 *
 * Its own edit mode, entered from the pencil in that head. Editing the
 * timetable used to be part of editing the parish, which meant correcting a
 * phone number spread every rule's form and an "add a service" row across the
 * sheet. Now the rows become editable only when somebody says they are editing
 * the TIMES, and adding a service sits behind a + until it is asked for.
 */
function parishTimetableHTML(parish, scheds) {
  const pid = parish.id;
  const jColor = getJurisdictionColor(parish.jurisdiction);
  // The card is one parish's already; its jurisdiction is in its header.
  const jLabel = 'Timetable';
  const avatar = parishAvatarHTML(parish, 'parish-schedule-avatar');
  // The green + adds a service; each row carries its own pencil. Both for
  // whoever may change this timetable, and always there — no mode to enter.
  const add = mayEditTimetable(pid)
    ? `<button class="ps-sched-add" type="button" data-sched-add="${esc(pid)}" aria-haspopup="dialog"
               aria-label="Add schedule" title="Add schedule">${glyph('ph:plus-bold')}</button>`
    : '';
  return `<div class="jurisdiction-box" style="--juris-color:${esc(jColor)}">
      <div class="section-header jurisdiction-header">${esc(jLabel)}</div>
      <div class="parish-schedule ps-timetable" data-parish-id="${esc(pid)}">
        <div class="parish-schedule-head">
          ${avatar}
          <div class="parish-schedule-name">${esc(parish.name || parish.full_name || '')}</div>
          ${add}
        </div>
        ${scheds.length ? renderScheduleDaysHTML(scheds) : '<div class="ps-sched-empty">No service times on file.</div>'}
      </div>
    </div>`;
}

/**
 * "Russian Archdiocese" over a jurisdiction's box of parishes in the Schedules
 * list, where the boxes are what tell one church from another. On a parish's
 * own card the box is just "Timetable" (parishTimetableHTML): the parish, and
 * so its jurisdiction, is already the card's header, and under it the sheet
 * goes on to the dated services — not the timetable but what it projects
 * ("Coming up", feedHeaderHTML). A parish of no listed jurisdiction gets
 * "Other parishes". The lite pages say the same (worker/lib/lite-page.mjs).
 */
function timetableLabel(juris) {
  const j = String(juris || '').toLowerCase();
  return j && j !== 'other' ? `${capitalize(j)} Archdiocese` : 'Other parishes';
}

/**
 * "Coming up": where the timetable — what happens every week — gives way to
 * the dated services and events it projects, the date lens made visible. Drawn
 * like the timetable's own header so the sheet's two halves read as a pair.
 * A focus banner heads the list instead when there is one, saying what it is
 * narrowed to (CSS hides this beside it); the lite card does the same.
 */
function feedHeaderHTML(parish) {
  const jColor = getJurisdictionColor(parish && parish.jurisdiction);
  return `<div class="section-header feed-header" style="--juris-color:${esc(jColor)}">Coming up</div>`;
}

/**
 * "Suggest edits" — the way in for somebody who has spotted something wrong.
 *
 * Shown to anyone who cannot already edit this parish, visitors included: most
 * parishes have nobody looking after their page, and the person who could is
 * most likely to be reading it. It sits under the parish's source line, which
 * says where the page came from and how old it is — the natural place to offer
 * to put it right — rather than under the timetable, where it read as a note
 * about the service times alone. The lite card puts it in the same place
 * (worker/lib/lite-page.mjs).
 *
 * It was "Become a contributor", which asked for a role before anybody could
 * say what was wrong. Now it opens a form for the thing they came with — a
 * change, or an event the page does not show (worker/lib/suggestions.mjs) —
 * and becoming a parish contact is a box on it, unticked, which makes the claim
 * (worker/lib/claims.mjs). /admin?suggest= is behind Cloudflare Access, so the
 * address on either is one Access verified.
 */
function contributeButtonHTML(parish) {
  if (mayEditTimetable(parish.id)) return '';
  // The link opens public/shared/suggest-dialog.js first: what should change,
  // and the parish-editor request, asked before the sign-in rather than after.
  return `<a class="ps-btn ps-btn-ghost ps-contribute" href="/admin?suggest=${encodeURIComponent(parish.id)}" data-parish-name="${esc(parish.full_name || parish.name || '')}">${glyph('ph:note-pencil')}Suggest edits</a>`;
}

// The parish's service times for the dialog's "What is it about?", written as
// the suggest page writes them so the choice is the one selected there.
if (window.AgoraSuggest) {
  window.AgoraSuggest.servicesFor = (pid) => {
    const clock = (t) => {
      const [h, m] = String(t || '').split(':').map(Number);
      if (!Number.isFinite(h)) return t || '';
      return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`;
    };
    const parish = (state.parishes || []).find(p => p.id === pid);
    const today = parishToday(parish && parish.timezone);
    return [...new Set((state.schedules || [])
      .filter(r => r.parish_id === pid && !(r.effective_to && r.effective_to < today))
      .sort((a, b) => a.day_of_week - b.day_of_week || String(a.start_time).localeCompare(b.start_time))
      .map(r => `${DAYS[r.day_of_week]} ${clock(r.start_time)} · ${r.title}`))];
  };
}

/**
 * Rules that have ended, at the foot of the Add schedule dialog.
 *
 * An ended rule leaves the timetable, which is right for a reader and was a
 * dead end for an admin: "clear the end date to bring it back" had nowhere to
 * be done. Adding a service is when somebody wants it — the one they are
 * about to type may be the one that ended. The bundle does not carry them (it
 * drops a rule that ended before its window), so they are fetched when the
 * dialog opens.
 */
function endedServicesHTML(pid) {
  const ended = (state.endedRules && state.endedRules.pid === pid) ? state.endedRules.rows : [];
  if (!ended.length) return '';
  const fmt = (d) => new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(d + 'T00:00:00Z'));
  return `
    <details class="ps-ended">
      <summary>Ended services (${ended.length})</summary>
      ${ended.map(r => `
        <div class="ps-ended-row">
          <span>${esc(DAYS[r.day_of_week])} ${formatTime12(r.start_time)} · ${esc(r.title)} <em>ended ${esc(fmt(r.effective_to))}</em></span>
          <button type="button" class="ps-ended-reopen" data-reopen-rule="${esc(String(r.id))}">Bring back</button>
        </div>`).join('')}
    </details>`;
}

/** Fetch this parish's ended rules into the open Add schedule dialog. */
function loadEndedRules(pid) {
  fetch(`/api/admin/schedules?parish=${encodeURIComponent(pid)}`)
    .then(r => (r.ok ? r.json() : []))
    .then(rows => {
      const today = parishToday((rows[0] && rows[0].timezone) || TZ);
      state.endedRules = { pid, rows: rows.filter(r => r.active && r.effective_to && r.effective_to < today) };
      const slot = formDialogKind() === 'add-rule' && document.querySelector(`#form-body [data-ended-slot="${CSS.escape(pid)}"]`);
      if (slot) slot.innerHTML = endedServicesHTML(pid);
    })
    .catch(() => { /* a service is still added without them */ });
}

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-reopen-rule]');
  if (!btn) return;
  e.stopPropagation();
  const id = btn.dataset.reopenRule;
  const rule = state.endedRules && state.endedRules.rows.find(r => String(r.id) === id);
  if (!rule) return;
  if (!confirm(`Bring back ${rule.title}, ${DAYS[rule.day_of_week]} ${rule.start_time}?\n\n`
    + 'It runs again from its next date, with any changes it still holds. If another service replaced it '
    + '(a time change), bring it back only if both really run.')) return;
  if (!(await ensureKeptByHand(rule.parish_id))) return;
  const res = await fetch(`/api/admin/schedules/${encodeURIComponent(id)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ effective_to: null }),
  });
  if (!res.ok) { alert(await adminErrorText(res)); return; }
  await fetchSchedules({ fresh: true });
  fetchEvents({ fresh: true, keepCount: true });
  loadEndedRules(rule.parish_id);
});

/**
 * A first look at their own parish, for somebody just made its contact.
 *
 * Once per parish per browser — a convenience, so localStorage is the right
 * place and it fails safe (shown again) when storage is blocked.
 */
function contactGuideHTML(parish) {
  const who = state.adminWho || {};
  if (!state.isAdmin || who.role !== 'parish' || !(who.parishIds || []).includes(parish.id)) return '';
  try { if (localStorage.getItem(`agora-guide:${parish.id}`)) return ''; } catch { /* show it */ }
  return `
    <div class="ps-guide" data-guide="${esc(parish.id)}">
      <div class="ps-guide-title">You can now keep ${esc(parish.name)} up to date</div>
      <ul>
        <li><b>Its details</b> — the pencil by the parish name: address, phone, website, logo.</li>
        <li><b>Service times</b> — the green + on the timetable adds one; the pencil on a service changes or ends it, and a service can start or end on a date. A flyer for something held every week can go on its service as its poster.</li>
        <li><b>One week is different</b> — open that service, tap <b>Edit</b>: change, cancel, or set a break. It asks whether you mean that date or every one after it.</li>
        <li><b>A one-off event</b> — the round + button.</li>
        <li><b>A monthly bulletin</b> — open any service in the month, <b>Edit → Poster → Put it on</b> everything from the 1st to the last day.</li>
      </ul>
      <button type="button" class="ps-guide-done" data-guide-done="${esc(parish.id)}">Got it</button>
    </div>`;
}

document.addEventListener('click', (e) => {
  const done = e.target.closest('[data-guide-done]');
  if (!done) return;
  try { localStorage.setItem(`agora-guide:${done.dataset.guideDone}`, '1'); } catch { /* fine */ }
  const card = done.closest('.ps-guide');
  if (card) card.remove();
});

// The timetable's own controls, bound once for the document: the panel is
// rebuilt by both the full render and the partial refresh, and a listener on
// the element would have to be re-bound after each. Capture phase, so a row's
// pencil is the pencil's and never also a tap on the row it sits in.
document.addEventListener('click', (e) => {
  const edit = e.target.closest('[data-sched-edit]');
  if (edit) {
    e.stopPropagation();
    e.preventDefault();
    openRuleEditDialog(edit.dataset.schedEdit);
    return;
  }
  const add = e.target.closest('[data-sched-add]');
  if (add) {
    e.stopPropagation();
    openAddScheduleDialog(add.dataset.schedAdd);
  }
}, true);

// "From a photo of the sign", in the timetable's add form. The photo is read by
// the add-event editor — the one reader, the one review — opened expecting a
// timetable: a sign's services are offered there one by one, and a poster for
// a one-off that lands here by mistake is caught there and kept as events,
// never put on the timetable (public/shared/event-editor.js, `intent`).
function openSchedulePhoto(pid, file) {
  if (!file || !/^image\//.test(file.type || '')) return;
  // The photo is read in the add-event editor; the add dialog it came from goes.
  closeFormDialog();
  window.openNewEventDialog(pid, { file, intent: 'timetable' });
}
document.addEventListener('click', (e) => {
  const drop = e.target.closest('[data-sched-photo]');
  if (!drop) return;
  e.stopPropagation();
  const input = drop.parentElement.querySelector('[data-sched-photo-input]');
  if (input) input.click();
});
document.addEventListener('change', (e) => {
  const input = e.target.closest('[data-sched-photo-input]');
  if (!input) return;
  const file = input.files && input.files[0];
  input.value = '';
  openSchedulePhoto(input.dataset.schedPhotoInput, file);
});
document.addEventListener('dragover', (e) => {
  const drop = e.target.closest && e.target.closest('[data-sched-photo]');
  if (!drop || !e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  drop.classList.add('is-dragging');
});
document.addEventListener('dragleave', (e) => {
  const drop = e.target.closest && e.target.closest('[data-sched-photo]');
  if (drop && !drop.contains(e.relatedTarget)) drop.classList.remove('is-dragging');
});
document.addEventListener('drop', (e) => {
  const drop = e.target.closest && e.target.closest('[data-sched-photo]');
  if (!drop) return;
  e.preventDefault();
  drop.classList.remove('is-dragging');
  const file = e.dataTransfer && [...(e.dataTransfer.files || [])].find(f => /^image\//.test(f.type));
  openSchedulePhoto(drop.dataset.schedPhoto, file);
});

/** The header's fields in edit mode: the name, the short name, the jurisdiction. */
function parishHeaderEditHTML(parish) {
  const pid = esc(parish.id);
  // Mirrors the jurisdiction CHECK in d1/schema.sql.
  const jurisdictionOpts = ['antiochian', 'greek', 'macedonian', 'romanian', 'russian', 'serbian', 'other']
    .map(j => `<option value="${j}"${parish.jurisdiction === j ? ' selected' : ''}>${capitalize(j)} Orthodox</option>`)
    .join('');
  return `<div class="ps-header-info ps-edit-fields">
      <input class="ps-name-input ps-edit-in" style="--i:0" id="pse-fullname-${pid}" aria-label="Full name"
             placeholder="Full name" value="${esc(parish.full_name || parish.name || '')}">
      <div class="ps-edit-row2 ps-edit-in" style="--i:1">
        <input id="pse-name-${pid}" aria-label="Short name" placeholder="Short name" value="${esc(parish.name || '')}">
        <select id="pse-jurisdiction-${pid}" aria-label="Jurisdiction">${jurisdictionOpts}</select>
      </div>
    </div>`;
}

/**
 * The details section in edit mode: every line the reader sees, as the field
 * that edits it, in the order it is read. The action pills stay pills and
 * gain a pencil; a pill with nothing behind it yet appears dashed, so the way
 * to add a phone number is where the Call button would be.
 */
/**
 * Where this parish's details and times come from — public/shared/read-from.js.
 * In the details edit mode, because it is a fact about the parish, and a
 * parish contact may change it: whether anything is scraped at their parish is
 * theirs to decide.
 */
function readFromFieldHTML(parish) {
  const RF = window.AgoraReadFrom;
  if (!RF) return '';
  const pid = esc(parish.id);
  const cur = RF.readFrom(parish);
  return `
      <label class="ps-field ps-edit-in" style="--i:6">
        <span>Details and service times</span>
        <select id="pse-readfrom-${pid}" onchange="document.getElementById('pse-readfrom-hint-${pid}').textContent = window.AgoraReadFrom.HINTS[this.value]">
          ${RF.READ_FROM.map(v => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(RF.LABELS[v])}</option>`).join('')}
        </select>
        <span class="edit-row-hint" id="pse-readfrom-hint-${pid}">${esc(RF.HINTS[cur])}</span>
      </label>`;
}

function parishDetailsEditHTML(parish, { srcHtml, parishAdminHtml }) {
  const pid = esc(parish.id);
  let langsVal = '';
  try { langsVal = parish.languages ? JSON.parse(parish.languages).join(', ') : ''; } catch { langsVal = parish.languages || ''; }
  const acro = (parish.acronym || '').toLowerCase().replace(/\s+/g, '');
  const pencil = `<span class="ps-btn-pencil" aria-hidden="true">${glyph('ph:pencil-simple-fill')}</span>`;
  const linkBtn = (kind, label, has) =>
    `<button type="button" class="ps-btn ps-btn-editable${has ? '' : ' ps-btn-empty'}${kind === 'maps' ? ' ps-btn-primary' : ''}" data-link-edit="${kind}">${PARISH_BTN_GLYPH[kind] ? glyph(PARISH_BTN_GLYPH[kind]) : ''}<span>${esc(label)}</span>${pencil}</button>`;
  const hasLinks = !!(parish.donation_url || parish.raffle_url || parish.payment_url || parish.gala_url
    || (state.parishLinks || []).some(l => l.parish_id === parish.id));
  const suburb = String(parish.address || '').split(',').slice(-2, -1)[0] || '';
  const mapsQuery = `${parish.full_name || parish.name || ''} ${suburb}`.trim();
  return `
    <div class="ps-section ps-details-editing" id="ps-edit-form-${pid}">
      <label class="ps-field ps-edit-in" style="--i:2"><span>Address</span>
        <input id="pse-address-${pid}" value="${esc(parish.address || '')}" oninput="parishAddressTyped('${pid}')" placeholder="Where the service is — the door somebody walks through">
      </label>
      <div class="pin-actions ps-edit-in" style="--i:3">
        <button class="ps-btn ps-btn-admin" type="button" id="pse-locate-${pid}"
                onclick="geolocateParishPin('${pid}')">${glyph('ph:map-pin')}Locate pin</button>
        <button class="ps-btn ps-btn-admin" type="button"
                onclick="openParishPinMover('${pid}')">${glyph('ph:crosshair-simple')}Move pin</button>
      </div>
      <div class="pin-status" id="pse-pin-status-${pid}">${pinStatusHTML(parish.id)}</div>
      <label class="ps-field ps-edit-in" style="--i:4"><span>Website</span>
        <input type="url" id="pse-website-${pid}" value="${esc(parish.website || '')}" placeholder="https://">
      </label>
      <div class="ps-field-pair ps-edit-in" style="--i:5">
        <label class="ps-field"><span>Short link</span>
          <input id="pse-acro-${pid}" data-acronym-field value="${esc(parish.acronym || '')}" placeholder="acronym">
          <span class="edit-row-hint" data-acronym-hint>orthodoxy.au/<span data-acronym-preview>${esc(acro || 'acronym')}</span></span>
          <span class="edit-row-hint" data-acronym-suggested hidden>Suggested from the names — keep it, change it, or clear it.</span>
        </label>
        <label class="ps-field"><span>Languages</span>
          <input id="pse-langs-${pid}" placeholder="English, Greek" value="${esc(langsVal)}">
        </label>
      </div>
      <div class="ps-edit-in" style="--i:6">${srcHtml}</div>
      ${readFromFieldHTML(parish)}
      <div class="ps-actions ps-edit-in" style="--i:7;--parish-color:${esc(getJurisdictionColor(parish.jurisdiction))}">
        ${linkBtn('maps', 'Google Maps', true)}
        ${linkBtn('website', 'Website', !!parish.website)}
        ${linkBtn('phone', parish.phone ? 'Call' : 'Add phone', !!parish.phone)}
        ${linkBtn('live', parish.live_url ? 'Watch Live' : 'Add live stream', !!parish.live_url)}
        ${linkBtn('links', hasLinks ? 'Donate & links' : 'Add donate & links', hasLinks)}
      </div>
      <div class="ps-link-editor">
        <div class="ps-link-field" data-link-field="phone" hidden>
          <label class="ps-field"><span>Phone — what Call dials</span>
            <input type="tel" id="pse-phone-${pid}" value="${esc(parish.phone || '')}" placeholder="02 9000 0000">
          </label>
        </div>
        <div class="ps-link-field" data-link-field="live" hidden>
          <label class="ps-field"><span>Live stream — what Watch Live opens</span>
            <input type="url" id="pse-live-${pid}" value="${esc(parish.live_url || '')}" placeholder="https://youtube.com/…">
          </label>
        </div>
        <div class="ps-link-field" data-link-field="maps" hidden>
          <div class="ps-field"><span>Google Maps entry</span>
            <div class="maps-current" id="pse-maps-current-${pid}">${parish.maps_url
              ? 'A place is chosen — the button opens it.'
              : 'None chosen — the button opens the pin from the address.'}</div>
          </div>
          <div class="maps-search">
            <input id="pse-maps-q-${pid}" value="${esc(mapsQuery)}" aria-label="Search Google Maps"
                   onkeydown="if(event.key==='Enter'){event.preventDefault();searchParishPlaces('${pid}')}">
            <button class="ps-btn ps-btn-admin" type="button" onclick="searchParishPlaces('${pid}')">${glyph('ph:magnifying-glass')}Find</button>
          </div>
          <div class="maps-results" id="pse-maps-results-${pid}"></div>
          <label class="ps-field"><span>Or paste its Google Maps link</span>
            <input id="pse-maps-${pid}" value="${esc(parish.maps_url || '')}" placeholder="https://maps.app.goo.gl/…"
                   oninput="document.getElementById('pse-maps-current-${pid}').textContent = this.value ? 'This link is chosen.' : 'None chosen — the button opens the pin from the address.'">
          </label>
          <button class="ps-btn ps-btn-ghost" type="button" onclick="clearParishMaps('${pid}')">Use the pin instead</button>
        </div>
      </div>
      ${parishAdminHtml}
    </div>`;
}

/** The pencils on the action pills: each opens the field behind its button. */
function wireParishDetailsEdit(contentEl, parishId) {
  contentEl.querySelectorAll('[data-link-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const kind = btn.dataset.linkEdit;
      if (kind === 'links') { window.openParishLinks(parishId); return; }
      if (kind === 'website') {
        const el = document.getElementById(`pse-website-${parishId}`);
        if (el) { el.focus(); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
        return;
      }
      const field = contentEl.querySelector(`[data-link-field="${kind}"]`);
      if (!field) return;
      const opening = field.hidden;
      contentEl.querySelectorAll('[data-link-field]').forEach(f => { f.hidden = true; });
      contentEl.querySelectorAll('[data-link-edit]').forEach(b => b.classList.remove('open'));
      field.hidden = !opening;
      btn.classList.toggle('open', opening);
      if (opening) {
        const first = field.querySelector('input');
        if (first) first.focus({ preventScroll: true });
        field.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    });
  });
}

/**
 * Look the parish up on Google Maps and offer what comes back.
 *
 * Through the Worker (POST /api/admin/places), which holds the key. A
 * deployment whose key cannot search Places says so, and the paste field and
 * "use the pin" are right there — the button works either way.
 */
window.searchParishPlaces = async function(pid) {
  const parish = state.parishes.find(p => p.id === pid) || {};
  const q = (document.getElementById(`pse-maps-q-${pid}`) || {}).value || '';
  const box = document.getElementById(`pse-maps-results-${pid}`);
  if (!box || !q.trim()) return;
  box.innerHTML = '<div class="maps-note">Searching…</div>';
  let body = null;
  try {
    const res = await fetch('/api/admin/places', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: q, lat: parish.lat, lng: parish.lng }),
    });
    body = await res.json().catch(() => null);
  } catch { /* shown below */ }
  const places = (body && body.places) || [];
  if (!places.length) {
    box.innerHTML = `<div class="maps-note">${esc((body && body.error) || 'Nothing found. Try the church’s name and suburb, or paste its link below.')}</div>`;
    return;
  }
  box.innerHTML = places.map((pl, i) => `
    <button type="button" class="maps-result" data-i="${i}">
      <span class="maps-result-name">${esc(pl.name || '')}</span>
      <span class="maps-result-addr">${esc(pl.address || '')}</span>
    </button>`).join('');
  box.querySelectorAll('.maps-result').forEach(b => b.addEventListener('click', () => {
    const pl = places[Number(b.dataset.i)];
    const input = document.getElementById(`pse-maps-${pid}`);
    if (input) input.value = pl.url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(pl.name || '')}&query_place_id=${encodeURIComponent(pl.id)}`;
    const cur = document.getElementById(`pse-maps-current-${pid}`);
    if (cur) cur.textContent = `Chosen: ${pl.name}${pl.address ? ' — ' + pl.address : ''}. Save to keep it.`;
    box.querySelectorAll('.maps-result').forEach(x => x.classList.toggle('chosen', x === b));
  }));
};

window.clearParishMaps = function(pid) {
  const input = document.getElementById(`pse-maps-${pid}`);
  if (input) input.value = '';
  const cur = document.getElementById(`pse-maps-current-${pid}`);
  if (cur) cur.textContent = 'None chosen — the button opens the pin from the address. Save to keep it.';
};

/**
 * Enter or leave edit mode for one parish.
 *
 * A full re-render rather than a class flip, because edit mode changes what
 * EXISTS and not only what is shown: the schedule rows grow pencils and
 * forms, the avatar becomes a button, and an "add a service" row appears.
 * Painting those on load and hiding them is how the sheet ended up carrying
 * an admin's whole toolkit on every view.
 *
 * Only one parish is ever in edit mode, so opening another parish's sheet
 * leaves this one — which is also the reason nothing here has to be undone
 * on close.
 */
window.setParishEditMode = function(id, on) {
  const next = on ? id : null;
  if (state.parishEditMode === next) return;
  state.parishEditMode = next;
  // Same reasoning as closing the sheet: a pin staged against one parish must
  // not still be staged when the mode moves to another, or to nothing.
  if (_pinDraft.parishId && _pinDraft.parishId !== next) clearPinDraft();
  // The mode is the edit dialog now: open it, or close it.
  if (next) openParishDetailsDialog(next);
  else if (formDialogKind() === 'parish') closeFormDialog();
  // fullRender, because the partial refresh deliberately leaves the header
  // and the actions row alone — a save changed what they show.
  const open = state.parishSheetFocus;
  if (open && !next) renderParishSheetContent(open, { fullRender: true });
};

/**
 * A parish's details in the edit dialog: the name fields, the logo, the
 * address and its pin, the links behind each button, where it is read from —
 * the controls the sheet used to turn into, in the order the sheet reads.
 * saveParish reads them by id wherever they are; the pin mover, the logo
 * editor and the links editor are dialogs of their own, above this one.
 */
function openParishDetailsDialog(pid) {
  const parish = (state.parishes || []).find(p => p.id === pid);
  if (!parish) return;
  const color = getParishDisplayColor(parish.color || getJurisdictionColor(parish.jurisdiction));
  const avatar = parishAvatarParts(parish);
  const epid = esc(pid);
  const srcHtml = sourceLineHTML(parish.info_source_name, parish.info_source_ref, parish.info_checked_at, 'ps-source');
  const actions = `
      <div class="ps-actions ps-admin-actions form-actions">
        <button class="ps-btn ps-btn-admin ps-editing" type="button" data-parish-save
                onclick="finishParishEdit('${epid}', this)">${glyph('ph:check')}Save</button>
        <button class="ps-btn ps-btn-ghost" type="button" onclick="setParishEditMode('${epid}', false)">Cancel</button>
        ${adminMay('parish.delete', pid) ? `<button class="ps-btn ps-btn-danger ps-delete-parish" type="button" onclick="deleteParish('${epid}')">${glyph('ph:trash')}Delete parish</button>` : ''}
      </div>`;
  const body = openFormDialog({
    kind: 'parish',
    title: 'Edit details',
    sub: parish.full_name || parish.name,
    html: `
      <div class="ps-header ps-header-editing">
        <button type="button" data-logo-edit class="ps-avatar editing${avatar.cls}" aria-label="Change the logo"
                style="${avatar.style}--parish-glow:${esc(hexToRgba(color, 0.45))}">${avatar.inner}<span class="ps-avatar-edit">${glyph('ph:pencil-simple-fill')}</span></button>
        ${parishHeaderEditHTML(parish)}
      </div>
      ${parishDetailsEditHTML(parish, { srcHtml, parishAdminHtml: actions })}`,
    // Closing it any way at all — the X, outside, Escape, Cancel — leaves the
    // mode, and a pin staged in it with it.
    onClose: () => {
      if (state.parishEditMode !== pid) return;
      state.parishEditMode = null;
      if (_pinDraft.parishId === pid) clearPinDraft();
    },
  });
  body.querySelector('[data-logo-edit]').addEventListener('click', () => openParishLogoEditor(pid));
  wireParishDetailsEdit(body, pid);
  wireAcronymHint(body, pid);
  wireAcronymSuggestion(body, parish);
}

/**
 * A parish with no short link gets one suggested from its names
 * (public/shared/acronym-suggest.js) — for whoever may set it, since a save
 * carrying an acronym from anybody else is refused. It fills the field and
 * says so; nothing is kept until Save, and clearing the field keeps none.
 */
function wireAcronymSuggestion(root, parish) {
  const pid = parish.id;
  const input = root.querySelector('[data-acronym-field]');
  const note = root.querySelector('[data-acronym-suggested]');
  if (!input || !window.AgoraAcronymSuggest || (parish.acronym || '').trim()
      || !adminMay('parish.acronym', pid)) return;
  input.addEventListener('input', (e) => { if (e.isTrusted && note) note.hidden = true; });
  const field = (name) => document.getElementById(`pse-${name}-${pid}`);
  window.AgoraAcronymSuggest.wire({
    input,
    parishId: pid,
    names: () => ({
      name: (field('name') || {}).value || '',
      full_name: (field('fullname') || {}).value || '',
      jurisdiction: (field('jurisdiction') || {}).value || '',
    }),
    watch: [field('name'), field('fullname')],
    onFill: () => { if (note) note.hidden = false; },
    now: true,
  });
}

// Kept so an old inline handler, a bookmarklet or a half-updated cached copy
// of this file does not throw. It is the mode now, not a form toggle.
window.toggleParishEdit = function(id) {
  window.setParishEditMode(id, state.parishEditMode !== id);
};

/**
 * Leave edit mode, keeping the work. What the header's Done does.
 *
 * The sheet used to offer three ways out — a green Save, a ghost Done beside
 * it, and this one in the header — and the difference between them was that
 * two of the three silently discarded everything typed. A control labelled
 * Done, sitting where you finish, is read as "I am finished", not as "throw
 * that away": the tick glyph says the same thing again. So Done saves, Save
 * closes, and the pair in the form has collapsed to one button.
 *
 * On a failed save `saveParish` returns false and stays open, deliberately —
 * closing there would take the unsaved values with it.
 */
window.finishParishEdit = async function(id, btn) {
  // The form exists only while the mode is on, and the mode can be on with the
  // sheet showing something else — a schedule pencil, mid-render. Nothing to
  // save then, so just leave.
  if (document.getElementById(`ps-edit-form-${id}`)) {
    // One save at a time. A second press while the first is in flight sent the
    // same PATCH twice; the button now says it is working and ignores presses
    // until the save answers. A successful save re-renders the sheet, which
    // replaces the button; a failed or abandoned one gives it back.
    if (_parishSaving.has(id)) return;
    _parishSaving.add(id);
    const label = btn ? btn.innerHTML : null;
    if (btn) {
      btn.disabled = true;
      btn.classList.add('is-busy');
      btn.setAttribute('aria-busy', 'true');
      btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span>Saving…';
    }
    try {
      await window.saveParish(id);
    } finally {
      _parishSaving.delete(id);
      if (btn && btn.isConnected) {
        btn.disabled = false;
        btn.classList.remove('is-busy');
        btn.removeAttribute('aria-busy');
        btn.innerHTML = label;
      }
    }
    return;
  }
  window.setParishEditMode(id, false);
};
const _parishSaving = new Set();

// ── Where a parish's pin goes (admin) ──────────────────────────────────
//
// Two controls, because the data has two cases and one of them is not the
// geocoder's fault.
//
// "Locate pin" asks what the address CURRENTLY IN THE BOX resolves to. It
// goes through the Worker, which runs the same `geocode()` the save runs, so
// the dot previewed and the dot saved cannot disagree — a preview against a
// second geocoder would be a different answer wearing the same button.
//
// It is a button press and not an oninput, deliberately. Nominatim asks for
// one request a second; geocoding on every keystroke would send one per
// character and most of them for half an address. So typing CLEARS the last
// answer instead of replacing it, and the button re-asks when the address is
// finished.
//
// "Move pin location" is the override, and it earns its place because the
// geocoder genuinely cannot always win. Nominatim answers a street it knows
// carrying a house number it does not — "27 Saints Road" — with the middle of
// the street, and no amount of retyping moves that dot onto the church. A
// hand-placed pin is sent as an explicit lat/lng, which the PATCH route reads
// as its reason NOT to re-geocode, and it carries an `info_overrides` pin on
// the address group so the next jurisdiction re-import cannot put it back.
//
// Nothing here writes. A staged pin lives in memory until Save, which is what
// lets it be abandoned by leaving edit mode.
const _pinDraft = { parishId: null, lat: null, lng: null, manual: false };

function clearPinDraft() {
  _pinDraft.parishId = null;
  _pinDraft.lat = null;
  _pinDraft.lng = null;
  _pinDraft.manual = false;
}

function pinDraftFor(pid) {
  return _pinDraft.parishId === pid && _pinDraft.lat != null ? _pinDraft : null;
}

/** Six decimals is ~11cm. Past that the digits are noise, and they are read by a person. */
function fmtCoord(n) {
  return Number(n).toFixed(6);
}

/**
 * The line under the two pin buttons.
 *
 * It answers one question — where will the dot be after I press Save — and it
 * has to answer it differently in the three states, because "staged" is the
 * only one where what is on screen is not what is in the database.
 */
function pinStatusHTML(pid, error) {
  if (error) return `<span class="pin-status-error">${esc(error)}</span>`;
  const draft = pinDraftFor(pid);
  if (draft) {
    const how = draft.manual
      ? 'placed by hand'
      : 'from the address above';
    return `<span class="pin-status-staged">Pin staged: ${fmtCoord(draft.lat)}, ${fmtCoord(draft.lng)}</span>`
      + ` — ${esc(how)}. Not saved yet.`;
  }
  const parish = (state.parishes || []).find(p => p.id === pid);
  if (!parish || parish.lat == null || parish.lng == null) {
    return 'No pin yet. Locate it from the address, or place it by hand.';
  }
  return `Pin: ${fmtCoord(parish.lat)}, ${fmtCoord(parish.lng)}`;
}
window.pinStatusHTML = pinStatusHTML;

function renderPinStatus(pid, error) {
  const el = document.getElementById(`pse-pin-status-${pid}`);
  if (el) el.innerHTML = pinStatusHTML(pid, error);
}

/**
 * The address changed, so a pin derived FROM that address no longer describes
 * it. A hand-placed one survives — somebody who put the dot on the door and
 * then tidied the wording of the street has not moved the church.
 */
window.parishAddressTyped = function(pid) {
  const draft = pinDraftFor(pid);
  if (draft && !draft.manual) clearPinDraft();
  renderPinStatus(pid);
};

window.geolocateParishPin = async function(pid) {
  const input = document.getElementById(`pse-address-${pid}`);
  const address = input ? input.value.trim() : '';
  if (!address) { renderPinStatus(pid, 'Type an address first.'); return; }
  const btn = document.getElementById(`pse-locate-${pid}`);
  if (btn) btn.disabled = true;
  const el = document.getElementById(`pse-pin-status-${pid}`);
  if (el) el.textContent = 'Looking that address up…';
  try {
    const res = await fetch('/api/admin/geocode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      // The commonest failure by far, and the one with an actual next step.
      renderPinStatus(pid, res.status === 404
        ? 'No match for that address. Place the pin by hand instead.'
        : (err.error || 'Lookup failed.'));
      return;
    }
    const coords = await res.json();
    _pinDraft.parishId = pid;
    _pinDraft.lat = coords.lat;
    _pinDraft.lng = coords.lng;
    _pinDraft.manual = false;
    renderPinStatus(pid);
  } catch {
    renderPinStatus(pid, 'Lookup failed.');
  } finally {
    if (btn) btn.disabled = false;
  }
};

// ── The by-hand pin, on a map of its own ───────────────────────────────
//
// A second MapLibre instance rather than borrowing the main one, so the sheet
// behind it keeps its unsaved form fields and its scroll position. The style
// is the live map's, stripped to the basemap: cloning it whole would drag in
// the parish layers, whose sprites and logo images are registered against the
// OTHER map and would render as missing-image warnings on this one.
const _pinMap = { map: null, parishId: null, onPick: null };

function basemapStyleOnly() {
  if (!window.agoraMap || typeof window.agoraMap.getStyle !== 'function') return null;
  let style;
  try { style = window.agoraMap.getStyle(); } catch { return null; }
  if (!style || !style.sources || !style.sources.protomaps) return null;
  return {
    ...style,
    sources: { protomaps: style.sources.protomaps },
    layers: (style.layers || []).filter(l => l.type === 'background' || l.source === 'protomaps'),
  };
}

window.openParishPinMover = function(parishId) {
  const parish = (state.parishes || []).find(p => p.id === parishId);
  if (!parish) return;
  _pinMap.onPick = null;
  const draft = pinDraftFor(parishId);
  // Start from whatever the pin would be if you saved right now, so opening
  // this and pressing Cancel is genuinely a no-op.
  const lat = draft ? draft.lat : parish.lat;
  const lng = draft ? draft.lng : parish.lng;
  if (lat == null || lng == null) {
    renderPinStatus(parishId, 'Locate the pin from the address first, so the map has somewhere to open.');
    return;
  }
  _pinMap.parishId = parishId;
  document.getElementById('pin-modal-sub').textContent = parish.name || parishId;
  document.getElementById('pin-backdrop').classList.add('open');

  const style = basemapStyleOnly();
  if (!style) {
    document.getElementById('pin-readout').textContent = 'The map is still loading — close this and try again.';
    return;
  }
  if (!_pinMap.map) {
    _pinMap.map = new maplibregl.Map({
      container: 'pin-map',
      style,
      center: [lng, lat],
      zoom: 18,
      attributionControl: false,
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      boxZoom: false,
    });
    _pinMap.map.touchZoomRotate.disableRotation();
    // Live, because the readout is the only exact statement of what Confirm
    // will save — the crosshair is a picture of it and a picture is not a
    // coordinate.
    _pinMap.map.on('move', syncPinReadout);
  } else {
    _pinMap.map.jumpTo({ center: [lng, lat], zoom: 18 });
  }
  // The container had no size while the modal was display:none, so the map
  // measured itself as 0×0. Without this it paints a sliver.
  requestAnimationFrame(() => { if (_pinMap.map) _pinMap.map.resize(); syncPinReadout(); });
};

function syncPinReadout() {
  const el = document.getElementById('pin-readout');
  if (!el || !_pinMap.map) return;
  const c = _pinMap.map.getCenter();
  el.textContent = `${fmtCoord(c.lat)}, ${fmtCoord(c.lng)}`;
}

window.closeParishPinMover = function() {
  document.getElementById('pin-backdrop').classList.remove('open');
  _pinMap.parishId = null;
  _pinMap.onPick = null;
};

/**
 * The same map, for any pin that is not a parish's: the place an event or a
 * service is held (the venue picker's "Move the pin"). Opens on `lat`/`lng`
 * and hands the crosshair's spot to `done` on "Use this spot".
 */
function openPinPicker({ lat, lng, sub = '' }, done) {
  const at = lat != null ? { lat, lng } : { lat: -33.87, lng: 151.21 };
  _pinMap.parishId = null;
  _pinMap.onPick = done;
  document.getElementById('pin-modal-sub').textContent = sub;
  document.getElementById('pin-backdrop').classList.add('open');
  const style = basemapStyleOnly();
  if (!style) {
    document.getElementById('pin-readout').textContent = 'The map is still loading — close this and try again.';
    return;
  }
  if (!_pinMap.map) {
    _pinMap.map = new maplibregl.Map({
      container: 'pin-map', style, center: [at.lng, at.lat], zoom: lat != null ? 18 : 12,
      attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false, boxZoom: false,
    });
    _pinMap.map.touchZoomRotate.disableRotation();
    _pinMap.map.on('move', syncPinReadout);
  } else {
    _pinMap.map.jumpTo({ center: [at.lng, at.lat], zoom: lat != null ? 18 : 12 });
  }
  requestAnimationFrame(() => { if (_pinMap.map) _pinMap.map.resize(); syncPinReadout(); });
}
window.openPinPicker = openPinPicker;

window.confirmParishPin = function() {
  if (_pinMap.onPick && _pinMap.map) {
    const c = _pinMap.map.getCenter();
    const done = _pinMap.onPick;
    window.closeParishPinMover();
    done({ lat: c.lat, lng: c.lng });
    return;
  }
  const pid = _pinMap.parishId;
  if (!pid || !_pinMap.map) { window.closeParishPinMover(); return; }
  const c = _pinMap.map.getCenter();
  _pinDraft.parishId = pid;
  _pinDraft.lat = c.lat;
  _pinDraft.lng = c.lng;
  _pinDraft.manual = true;
  window.closeParishPinMover();
  renderPinStatus(pid);
};

/**
 * The parish row a PATCH answers with, into state as the bundle would have
 * given it: with its jurisdiction's colour, which bundle.js sets on load. The
 * row came straight from D1 carrying the stored `parishes.color` until that
 * column was dropped (migration 026), and merged as it came it painted the
 * sheet's logo and buttons grey for a parish added since. The row has no
 * colour now, so this is what keeps one — and keeps it right when the save
 * changed the jurisdiction.
 */
function mergeSavedParish(pid, row) {
  const idx = state.parishes.findIndex(p => p.id === pid);
  if (idx === -1 || !row) return;
  const merged = { ...state.parishes[idx], ...row };
  if (window.agoraJurisdictionColor) merged.color = window.agoraJurisdictionColor(merged.jurisdiction);
  state.parishes[idx] = merged;
}

window.saveParish = async function(id) {
  const pid = id;
  const val = (name) => {
    const el = document.getElementById(`pse-${name}-${pid}`);
    return el ? el.value.trim() : undefined;
  };
  const data = {};
  const put = (col, v, { nullable = true } = {}) => {
    if (v === undefined) return;
    data[col] = nullable ? (v || null) : v;
  };
  // Only what the sheet shows. The source and the checked date are not here:
  // they are stamped by the Worker from who saved and when (adminEditProvenance),
  // and the colour is the jurisdiction's.
  put('name', val('name'), { nullable: false });
  put('full_name', val('fullname'));
  put('jurisdiction', val('jurisdiction'), { nullable: false });
  put('address', val('address'));
  put('website', val('website'));
  put('phone', val('phone'));
  put('live_url', val('live'));
  put('acronym', val('acro'));
  put('maps_url', val('maps'));
  const readFromSel = document.getElementById(`pse-readfrom-${pid}`);
  const parishNow = (state.parishes || []).find(p => p.id === pid);
  if (readFromSel && parishNow && readFromSel.value !== window.AgoraReadFrom.readFrom(parishNow)) {
    data.read_from = readFromSel.value;
  }
  const langsRaw = val('langs');
  if (langsRaw !== undefined) {
    const langsArr = langsRaw ? langsRaw.split(',').map(x => x.trim()).filter(Boolean) : [];
    data.languages = langsArr.length ? JSON.stringify(langsArr) : null;
  }

  // A staged pin goes as an explicit lat/lng, for both kinds.
  //
  // For a hand-placed one that is the whole point — the PATCH route re-geocodes
  // only when an address arrives WITHOUT coordinates, so sending them is how
  // the by-hand dot survives its own save.
  //
  // For a located one it is not redundant either: it makes the saved dot the
  // dot that was previewed, rather than a second lookup that might answer
  // differently, and it spares Nominatim the duplicate request.
  const draft = pinDraftFor(pid);
  if (draft) {
    data.lat = draft.lat;
    data.lng = draft.lng;
  }

  // Choosing the source in this same save IS the answer to the question.
  if (data.read_from === undefined && !(await ensureKeptByHand(pid))) return;
  const res = await fetch(`/api/admin/parishes/${encodeURIComponent(pid)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(err.error || 'Save failed');
    // Deliberately stays in edit mode. A failed save that tidied the form away
    // would take the unsaved values with it.
    return false;
  }
  const updated = await res.json();
  mergeSavedParish(pid, updated);
  if (draft) clearPinDraft();
  // A ruling is attempted after the write and reported rather than thrown, so
  // the save can succeed while the pin that was meant to protect it did not.
  // Silence there would be the worst of both.
  if (updated.pin_errors && updated.pin_errors.length) {
    alert('Saved, but the pin could not be held: '
      + updated.pin_errors.map(e => e.error).join(' '));
  }
  // Saving IS finishing. This is the whole reason Save and Done are not two
  // buttons any more — see the actions row above.
  window.setParishEditMode(pid, false);
  if (typeof updateMap === 'function') updateMap(state);
  return true;
};

/**
 * A date the admin picked, back into the ISO instant the column stores.
 *
 * The stored value is a full timestamp — a scrape knows the second it read a
 * page — while a person editing the row knows a day. So an untouched field
 * keeps the timestamp it came from rather than rounding it to midnight and
 * throwing away what the scrape recorded; only a day the admin actually
 * changed is written, and it is written as UTC midnight because a provenance
 * date has no time of day to be wrong about.
 */
function checkedAtFromInput(dayValue, current) {
  if (!dayValue) return null;
  if (current && String(current).slice(0, 10) === dayValue) return current;
  return `${dayValue}T00:00:00Z`;
}
window.checkedAtFromInput = checkedAtFromInput;

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
    closeFormDialog();
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
// dependency and a CPU bill for something a canvas already does. The export
// is square and AgoraLogo.LOGO_SIZE on a side, encoded as WebP where the
// browser can — public/shared/logo-image.js, shared with /admin's upload.
// It was a 512px PNG, which put crests of up to 480 KB on every first load
// for an avatar 44px wide.
const LOGO_EXPORT_SIZE = (window.AgoraLogo && window.AgoraLogo.LOGO_SIZE) || 192;

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
    preview.innerHTML = parishAvatarHTML(parish, 'logo-preview-initial', 'span');
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

// ── a parish's short links ───────────────────────────────────────────────
//
// The four payment kinds are columns on `parishes`; anything else is a row in
// `parish_links`. They are edited together because that is how they are
// thought about — "the links we hand out" — and split on save because that is
// how they are stored. A reader of this file should not have to know which is
// which to change one, which is the whole reason this dialog exists rather
// than five more rows in the parish form.
const PARISH_PAY_LINKS = [
  ['donate', 'donation_url', 'Donate'],
  ['payment', 'payment_url', 'Payment'],
  ['raffle', 'raffle_url', 'Raffle'],
  ['gala', 'gala_url', 'Gala'],
];

let _links = { parishId: null, custom: [] };

function _linksAcronym(parish) {
  return (parish.acronym || '').toLowerCase().replace(/\s+/g, '') || parish.id;
}

function _renderLinkRows() {
  const parish = state.parishes.find(p => p.id === _links.parishId);
  if (!parish) return;
  const base = `orthodoxy.au/${_linksAcronym(parish)}/`;
  const fixed = PARISH_PAY_LINKS.map(([slug, column, label]) => `
    <div class="link-row">
      <div class="link-row-head"><span class="link-row-name">${esc(label)}</span><span class="link-row-slug">${esc(base + slug)}</span></div>
      <input type="url" data-link-col="${column}" placeholder="https://…" value="${esc(parish[column] || '')}">
    </div>`).join('');
  const custom = _links.custom.map((l, i) => `
    <div class="link-row" data-link-i="${i}">
      <div class="link-row-head">
        <input class="link-row-slug-input" data-link-slug="${i}" value="${esc(l.slug || '')}" placeholder="name" spellcheck="false">
        <button class="link-row-del" type="button" data-link-del="${i}" aria-label="Remove">&times;</button>
      </div>
      <div class="link-row-preview">${esc(base)}<b>${esc(l.slug || 'name')}</b></div>
      <input type="url" data-link-url="${i}" placeholder="https://…" value="${esc(l.url || '')}">
      <input data-link-label="${i}" placeholder="Label (what to call it)" value="${esc(l.label || '')}">
    </div>`).join('');
  const rows = document.getElementById('links-rows');
  rows.innerHTML = fixed + custom;
  rows.querySelectorAll('[data-link-del]').forEach(b => {
    b.onclick = () => { _links.custom.splice(+b.dataset.linkDel, 1); _renderLinkRows(); };
  });
  // Kept in the model on every keystroke, because a re-render (adding or
  // removing a row) would otherwise throw away what is typed in the others.
  rows.querySelectorAll('[data-link-slug]').forEach(input => {
    input.oninput = () => {
      const i = +input.dataset.linkSlug;
      _links.custom[i].slug = input.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
      const preview = input.closest('.link-row').querySelector('.link-row-preview b');
      if (preview) preview.textContent = _links.custom[i].slug || 'name';
    };
  });
  rows.querySelectorAll('[data-link-url]').forEach(input => {
    input.oninput = () => { _links.custom[+input.dataset.linkUrl].url = input.value.trim(); };
  });
  rows.querySelectorAll('[data-link-label]').forEach(input => {
    input.oninput = () => { _links.custom[+input.dataset.linkLabel].label = input.value; };
  });
}

window.openParishLinks = async function(parishId) {
  const parish = state.parishes.find(p => p.id === parishId);
  if (!parish) return;
  _links.parishId = parishId;
  _links.custom = (state.parishLinks || []).filter(l => l.parish_id === parishId)
    .map(l => ({ slug: l.slug, url: l.url, label: l.label || '' }));
  document.getElementById('links-modal-sub').textContent = parish.name || parishId;
  _renderLinkRows();
  document.getElementById('links-backdrop').classList.add('open');

  document.getElementById('links-add').onclick = () => {
    _links.custom.push({ slug: '', url: '', label: '' });
    _renderLinkRows();
  };
  document.getElementById('links-save').onclick = () => _saveParishLinks();
};

// ── Breaks ───────────────────────────────────────────────────────────────
//
// A stretch of dates a service is not running: a parish shut between Christmas
// and Theophany, a hall closed for works, a priest away.
//
// It is the third answer beside Cancel and Suppress and behaves like neither.
// A cancellation is one date. A suppression takes a service off the site with
// no notice at all. A break is a RANGE that still renders — every occurrence
// inside it comes back as a BREAK tombstone carrying the reason, and the
// parish's timetable says when the service is back. That is the same bargain
// cancellation makes, held for longer: somebody who would otherwise turn up at
// church is told.

const _breakDraft = { scheduleId: null, parishId: null, editingId: null };

/** Whether this occurrence's rule can carry a break, and for which parish. */
function _breakTargetOf(id) {
  const parsed = window.agoraBundle && window.agoraBundle.raw
    ? (id.includes(':') ? { scheduleId: Number(String(id).split(':')[0]) } : null)
    : null;
  if (!parsed) return null;
  const rule = (state.schedules || []).find(s => String(s.id) === String(parsed.scheduleId));
  return rule ? { scheduleId: rule.id, parishId: rule.parish_id, rule } : null;
}

window.openBreakEditor = function (id) {
  const target = _breakTargetOf(String(id));
  if (!target) { alert('A break belongs to a recurring service.'); return; }
  const parish = state.parishes.find(p => p.id === target.parishId);
  _breakDraft.scheduleId = target.scheduleId;
  _breakDraft.parishId = target.parishId;
  _breakDraft.editingId = null;

  document.getElementById('break-modal-sub').textContent =
    `${target.rule.title} · ${(parish && parish.name) || target.parishId}`;

  // Default the window to the occurrence that was open, because that is the
  // service the person was looking at when they reached for this.
  const date = String(id).split(':')[1] || parishToday(parish && parish.timezone);
  document.getElementById('break-from').value = date;
  document.getElementById('break-to').value = date;
  document.getElementById('break-note').value = '';

  _renderBreakScope();
  _renderExistingBreaks();
  _paintBreakHint();
  ['break-from', 'break-to'].forEach(f => {
    document.getElementById(f).oninput = _paintBreakHint;
  });
  document.getElementById('break-scope').onchange = _paintBreakHint;
  document.getElementById('break-save').onclick = _saveBreak;
  document.getElementById('break-backdrop').classList.add('open');
};

window.closeBreakEditor = function () {
  document.getElementById('break-backdrop').classList.remove('open');
  _breakDraft.editingId = null;
};

/** One rule, or every rule at the parish — the choice the table's NULL encodes. */
function _renderBreakScope() {
  const rule = (state.schedules || []).find(s => String(s.id) === String(_breakDraft.scheduleId));
  const parish = state.parishes.find(p => p.id === _breakDraft.parishId);
  document.getElementById('break-scope').innerHTML = `
    <label class="break-scope-opt"><input type="radio" name="break-scope" value="rule" checked>
      just ${esc(rule ? rule.title : 'this service')}</label>
    <label class="break-scope-opt"><input type="radio" name="break-scope" value="parish">
      everything at ${esc((parish && parish.name) || 'this parish')}</label>`;
}

const _breakScope = () =>
  (document.querySelector('input[name="break-scope"]:checked') || {}).value || 'rule';

/** Say what the window will actually do, in dates rather than in counts. */
function _paintBreakHint() {
  const hint = document.getElementById('break-hint');
  const from = document.getElementById('break-from').value;
  const to = document.getElementById('break-to').value;
  if (!from || !to) { hint.textContent = ''; return; }
  if (to < from) { hint.textContent = 'The break ends before it starts.'; return; }
  const rule = (state.schedules || []).find(s => String(s.id) === String(_breakDraft.scheduleId));
  if (!rule) { hint.textContent = ''; return; }
  // Count this rule's own occurrences inside the window, which is the number
  // that means something — "18 days" does not say whether a service is affected.
  let n = 0;
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (new Date(d + 'T00:00:00Z').getUTCDay() !== rule.day_of_week) continue;
    if (rule.week_of_month && !_matchesWom(d, rule.week_of_month)) continue;
    if (rule.week_parity && window.agoraBundle.weekAbOf
        && window.agoraBundle.weekAbOf(d) !== String(rule.week_parity).toLowerCase()) continue;
    n++;
  }
  const scope = _breakScope() === 'parish' ? 'every service at this parish' : 'this service';
  hint.textContent = n
    ? `${n} occurrence${n === 1 ? '' : 's'} of this rule marked BREAK, and ${scope} with it. They still show, struck through, with your reason.`
    : 'No occurrence of this rule falls in that window.';
}

/** week_of_month, for the hint only — the projection's own copy is the real one. */
function _matchesWom(dateStr, qualifier) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dom = d.getUTCDate();
  const next = new Date(d); next.setUTCDate(dom + 7);
  const hasNext = next.getUTCMonth() === d.getUTCMonth();
  return String(qualifier).split(',').some(q => {
    switch (q.trim()) {
      case 'first': return dom <= 7;
      case 'second': return dom >= 8 && dom <= 14;
      case 'third': return dom >= 15 && dom <= 21;
      case 'fourth': return dom >= 22 && dom <= 28 && hasNext;
      case 'last': return !hasNext;
      default: return false;
    }
  });
}

/** Breaks already covering this rule, each liftable in one press. */
function _renderExistingBreaks() {
  const host = document.getElementById('break-existing');
  const rule = (state.schedules || []).find(s => String(s.id) === String(_breakDraft.scheduleId));
  const rows = ((window.agoraBundle && window.agoraBundle.breaks()) || []).filter(b =>
    b.schedule_id != null
      ? String(b.schedule_id) === String(_breakDraft.scheduleId)
      : b.parish_id === _breakDraft.parishId);
  if (!rows.length) { host.innerHTML = ''; return; }
  const fmt = (d) => new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short', year: 'numeric' })
    .format(new Date(d + 'T00:00:00Z'));
  host.innerHTML = `
    <div class="break-existing-head">Already on file</div>
    ${rows.map(b => `
      <div class="break-existing-row">
        <div class="break-existing-top">
          <span class="break-existing-when">${esc(fmt(b.from_date))} – ${esc(fmt(b.to_date))}</span>
          <span class="break-existing-scope">${b.schedule_id == null ? 'whole parish' : esc(rule ? rule.title : 'this service')}</span>
          <button class="break-lift" type="button" data-lift="${b.id}">Lift</button>
        </div>
        ${b.note ? `<div class="break-existing-note">${esc(b.note)}</div>` : ''}
      </div>`).join('')}`;
  host.querySelectorAll('[data-lift]').forEach(btn => {
    btn.addEventListener('click', () => _liftBreak(btn.dataset.lift, btn));
  });
}

async function _saveBreak() {
  const btn = document.getElementById('break-save');
  const from = document.getElementById('break-from').value;
  const to = document.getElementById('break-to').value;
  const note = document.getElementById('break-note').value.trim();
  if (!from || !to) { alert('A break needs a start and an end.'); return; }
  if (to < from) { alert('The break ends before it starts.'); return; }
  // Refused rather than defaulted: the note is the whole of what a visitor is
  // told in place of the service, and "" would tell them nothing.
  if (!note) { alert('Say why — it is what the card shows in place of the service.'); return; }

  btn.disabled = true;
  try {
    const res = await fetch('/api/admin/breaks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        schedule_id: _breakScope() === 'parish' ? null : _breakDraft.scheduleId,
        parish_id: _breakDraft.parishId,
        from_date: from,
        to_date: to,
        note,
      }),
    });
    if (!res.ok) { alert(await adminErrorText(res)); return; }
    await _afterBreakChange();
    window.closeBreakEditor();
  } finally {
    btn.disabled = false;
  }
}

async function _liftBreak(id, btn) {
  if (!confirm('Lift this break?\n\nThe services it covers go back to running as the rule says.')) return;
  btn.disabled = true;
  const res = await fetch(`/api/admin/breaks/${id}`, { method: 'DELETE' });
  if (!res.ok) { btn.disabled = false; alert(await adminErrorText(res)); return; }
  await _afterBreakChange();
  _renderExistingBreaks();
  _paintBreakHint();
}

/**
 * Re-read and repaint everything a break touches.
 *
 * `fresh` because /api/bundle is served stale-while-revalidate for ten
 * minutes, and a break you just set would otherwise look like it never
 * happened — docs/browser-checks.md calls this the trap that wastes an hour.
 */
async function _afterBreakChange() {
  await window.agoraBundle.load({ fresh: true });
  await fetchSchedules({ fresh: true });
  await fetchEvents({ fresh: true, keepCount: true });
  repaintOpenEventDrawer();
  if (state.parishSheetFocus && !state._openEventId) {
    renderParishSheetContent(state.parishSheetFocus, { fullRender: true });
  }
}

window.closeParishLinks = function() {
  document.getElementById('links-backdrop').classList.remove('open');
};

async function _saveParishLinks() {
  const pid = _links.parishId;
  const btn = document.getElementById('links-save');
  const patch = {};
  document.querySelectorAll('#links-rows [data-link-col]').forEach(input => {
    patch[input.dataset.linkCol] = input.value.trim() || null;
  });
  const links = _links.custom.filter(l => l.slug && l.url);

  btn.disabled = true;
  try {
    // Two writes, because they are two stores. The columns first: if the link
    // list is refused (a slug that spells a route), the parish still keeps the
    // four the admin just edited rather than losing both halves to one 409.
    const res = await fetch(`/api/admin/parishes/${encodeURIComponent(pid)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
    });
    if (!res.ok) { alert((await res.json().catch(() => ({}))).error || 'Save failed'); return; }
    mergeSavedParish(pid, await res.json());

    const res2 = await fetch(`/api/admin/parishes/${encodeURIComponent(pid)}/links`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ links }),
    });
    if (!res2.ok) { alert((await res2.json().catch(() => ({}))).error || 'Links not saved'); return; }
    const saved = await res2.json();
    state.parishLinks = [
      ...(state.parishLinks || []).filter(l => l.parish_id !== pid),
      ...saved.map(l => ({ ...l, parish_id: pid })),
    ];
    closeParishLinks();
    renderParishSheetContent(pid, {});
  } finally {
    btn.disabled = false;
  }
}

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
  const blob = window.AgoraLogo
    ? await window.AgoraLogo.encodeCanvas(out)
    : await new Promise(r => out.toBlob(r, 'image/png'));
  if (!blob) { alert('Could not render the crop.'); return; }
  await _uploadParishLogo(blob, blob.type || 'image/png');
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
  // The edit dialog it was opened from shows the new logo too.
  const dlgAvatar = formDialogKind() === 'parish' && document.querySelector('#form-body .ps-avatar[data-logo-edit]');
  const saved = (state.parishes || []).find(p => p.id === id);
  if (dlgAvatar && saved) {
    const a = parishAvatarParts(saved);
    dlgAvatar.innerHTML = a.inner + `<span class="ps-avatar-edit">${glyph('ph:pencil-simple-fill')}</span>`;
    dlgAvatar.classList.toggle('avatar-acronym', !!a.cls);
    if (a.cls) dlgAvatar.style.setProperty('--avatar-ink', a.style.replace(/^--avatar-ink:|;$/g, ''));
  }
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

// ── Adding an event at a parish ───────────────────────────────────────────
//
// The parish sheet's add button, and the dialog behind it. The dialog's body
// is the add-event editor (public/shared/event-editor.js) — the same editor
// /admin's Events section mounts, so the two ways of adding an event are one
// piece of code. It starts from a poster or from nothing, keeps every card as
// a draft while it is typed, and writes `events` only on Publish; closing the
// dialog loses nothing. docs/editing.md has the why.
//
// WHY THE FAB IS NOT BEHIND EDIT MODE. Edit mode exists so a signed-in person
// reads the sheet a visitor reads — no pencils down the timetable, no logo
// button on the avatar, no form sitting in the DOM behind display:none. This is
// not one of those. It does not alter anything the sheet is showing; it makes
// something that is not on the sheet at all yet, and it floats clear of the
// content rather than living in it. What it IS gated on is the capability, per
// parish: an owner and an editor see it on every sheet, a parish contact sees it
// on their own parishes only, and nobody else ever does.
//
// WHY THE COMBINE IS IN THE SAME EDITOR. The reason for the event is often the
// combine: a deanery liturgy at the cathedral exists BECAUSE four parishes are
// not holding their own that morning. Asking about it afterwards would publish
// the new card beside the service it stands in for and leave the pair up for as
// long as the second step took. So every card carries "also appears at" and
// "replaces", and publishing it sends all three answers at once.

let _newEventEditor = null;

/**
 * Show the add button when this account may write an event at the parish on
 * screen, and hide it otherwise.
 *
 * Called from the sheet's open and close, from a full re-render, and from
 * checkAdmin — the ping resolves after the first paint, so the very first sheet
 * of a session is rendered before the answer exists.
 */
function syncParishAddEventFab() {
  const fab = document.getElementById('parish-add-event-fab');
  if (!fab) return;
  const pid = window.agoraParishSheetVisible ? state.parishSheetFocus : null;
  const show = !!pid && adminMay('event.edit', pid);
  fab.hidden = !show;
  if (show) fab.dataset.parishId = pid;
  else delete fab.dataset.parishId;
  // The list's last card would otherwise sit permanently under the button.
  document.body.classList.toggle('parish-add-fab', show);
}
window.agoraSyncParishAddEventFab = syncParishAddEventFab;

/**
 * Widen the window far enough to hold what was just published, re-read, and
 * pin the earliest of it under the parish header — the answer to "did that
 * work" is the event itself. Pinned through opts rather than
 * state._openEventId: this is feedback on a press, not a surface worth
 * rewriting the URL for.
 */
async function _afterNewEvents(events) {
  if (!events || !events.length) return;
  const byStart = events.slice().sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
  const last = String(byStart[byStart.length - 1].start_utc || '').slice(0, 10);
  const needed = daysUntil(last) + HORIZON_STEP_DAYS;
  if (needed > (state._horizonDays || 0)) state._horizonDays = needed;
  await fetchEvents({ fresh: true, keepCount: true });
  if (state.parishSheetFocus) {
    renderParishSheetContent(state.parishSheetFocus, { fullRender: true, focusEventId: String(byStart[0].id) });
  }
}

// ── The edit dialog ──
//
// Editing a parish's details, a rule of its timetable, a new rule or an event
// happens in a dialog over the sheet — the same frame as Add an event — rather
// than inside the sheet. In the sheet, a form was a dozen controls opening
// under a row of a scrolling panel that was itself a sheet over a map: on a
// phone it pushed the thing being edited off the screen, and the sheet's own
// drag handling fought the form for every scroll. Each kind fills the one
// dialog (#form-backdrop) with the controls it always had; their handlers are
// the ones they always had, because they find their fields by id.
let _formDialog = null;   // { onClose, kind }

/**
 * Open the edit dialog. `html` is markup or a node (a node is moved in, so
 * the handlers bound to it come with it). Whatever was open is closed first,
 * with its own onClose. Returns the body to wire.
 */
function openFormDialog({ title, sub = '', html = '', onClose = null, kind = '' }) {
  closeFormDialog();
  const back = document.getElementById('form-backdrop');
  document.getElementById('form-title').textContent = title;
  const subEl = document.getElementById('form-sub');
  subEl.textContent = sub;
  subEl.hidden = !sub;
  const body = document.getElementById('form-body');
  body.innerHTML = '';
  if (typeof html === 'string') body.innerHTML = html;
  else if (html) body.appendChild(html);
  back.dataset.kind = kind;
  back.classList.add('open');
  back.querySelector('.form-modal').scrollTop = 0;
  _formDialog = { onClose, kind };
  document.addEventListener('keydown', _formEsc);
  return body;
}
window.openFormDialog = openFormDialog;

/** Close it. `onClose` runs first, so a node moved in can be moved back out. */
function closeFormDialog() {
  const back = document.getElementById('form-backdrop');
  if (!back || !back.classList.contains('open')) return;
  const d = _formDialog;
  _formDialog = null;
  back.classList.remove('open');
  document.removeEventListener('keydown', _formEsc);
  if (d && d.onClose) d.onClose();
  document.getElementById('form-body').innerHTML = '';
}
window.closeFormDialog = closeFormDialog;

/** Which kind of edit is open, if any: 'rule', 'add-rule', 'parish', 'event'. */
const formDialogKind = () => (_formDialog ? _formDialog.kind : null);

// Escape closes it only when it is the dialog on top: the ones it opens sit
// later in the document, and Escape there belongs to them.
function _formEsc(e) {
  if (e.key !== 'Escape') return;
  const open = [...document.querySelectorAll('.escalate-backdrop.open')];
  if (open[open.length - 1] !== document.getElementById('form-backdrop')) return;
  closeFormDialog();
}

function _newEventEsc(e) {
  if (e.key !== 'Escape') return;
  // The poster opened full size from the editor sits on top; Escape is its.
  const viewer = document.getElementById('poster-fullscreen');
  if (viewer && viewer.classList.contains('open')) return;
  window.closeNewEventDialog();
}

/**
 * The dialog's heading: what the read says the image announces, or what the
 * dialog was opened for. One of 'event', 'sign' (the board out the front),
 * 'regular' (a poster for something held regularly, which goes on the
 * timetable with the poster on it), or 'both' (a poster with both).
 */
function _newEventHeading(what) {
  const [title, sub] = {
    sign: ['Add to the timetable', 'Each service on the sign is set beside what is on file, and added only when you say so.'],
    regular: ['Add to the timetable', 'This poster is for something held regularly, so it goes on the timetable — with the poster on every date.'],
    both: ['Add from the poster', 'What is held regularly goes on the timetable; what happens once goes in the feed — each when you say so.'],
  }[what] || ['Add an event', 'One date each — a service that runs every week is a rule, not an event.'];
  document.getElementById('new-event-title').textContent = title;
  document.getElementById('new-event-sub').textContent = sub;
}

/**
 * Open the editor for a parish — blank, or on a saved draft. `file` drops a
 * photo straight in; `intent: 'timetable'` is the timetable's own "From a
 * photo of the sign", which expects a sign and says so when the photo is not
 * one.
 */
window.openNewEventDialog = function (parishId, { draftId = null, file = null, intent = 'event' } = {}) {
  const parish = (state.parishes || []).find(p => p.id === parishId);
  const backdrop = document.getElementById('new-event-backdrop');
  const mount = document.getElementById('new-event-editor');
  if (!parish || !backdrop || !mount || !window.AgoraEventEditor) return;
  // Re-checked on open as well as on render: the sheet may have been painted
  // before the ping answered, and a dialog is a worse place to find out.
  if (!adminMay('event.edit', parishId)) return;
  if (_newEventEditor) _newEventEditor.close();

  // The editor's own picker says which parish: it starts at this sheet's, and
  // moves the draft when the poster turns out to be somebody else's.
  _newEventHeading(intent === 'timetable' ? 'sign' : 'event');
  _newEventEditor = window.AgoraEventEditor.open(mount, {
    parish,
    parishes: state.parishes || [],
    may: adminMay,
    draftId,
    intent,
    // A sign is the timetable's, whichever door it came in by, and events are
    // events; a photo given to the timetable that read as nothing stays there.
    onRead: (draft) => {
      const services = (draft.read_services || []).length > 0;
      const events = (draft.cards || []).some(c => c.title || c.date);
      _newEventHeading(draft.read_kind === 'timetable' ? 'sign'
        : services && events ? 'both'
          : services ? 'regular'
            : intent === 'timetable' && !events ? 'sign' : 'event');
    },
    openPoster: (url) => openPosterFullscreen(url),
    // "Move the pin" for a place an event is held: the parish pin's own map.
    pickPin: (start, done) => openPinPicker({ ...start, sub: start.title }, done),
    // A church sign writes to the parish itself — its timetable, its details —
    // and asks first, like any hand edit, whether to keep it by hand.
    keepByHand: (pid) => ensureKeptByHand(pid),
    onChanged: async ({ parishId, what }) => {
      // A new rule is in the bundle, which fetchSchedules reloads (and repaints
      // the sheet from), and its dates are in the feed, which is projected
      // from it; a detail is on the parish the editor shares with state.
      if (what === 'timetable') {
        await fetchSchedules({ fresh: true });
        await fetchEvents({ fresh: true, keepCount: true });
      } else if (state.parishSheetFocus === parishId) renderParishSheetContent(parishId, { fullRender: true });
    },
    onPublished: async ({ events, proposals }) => {
      window.closeNewEventDialog();
      // Published at the parish it was moved to: show that parish's sheet,
      // where the event is, rather than re-render the one it started from.
      const at = events && events[0] && events[0].parish_id;
      if (at && at !== state.parishSheetFocus) openParishSheet(at);
      await _afterNewEvents(events);
      // The dot, in case the person who asked can also decide.
      if (proposals && proposals.length) refreshOpenAsks();
    },
    onClose: () => window.closeNewEventDialog(),
  });
  backdrop.classList.add('open');
  document.addEventListener('keydown', _newEventEsc);
  if (file) _newEventEditor.dropFile(file);
};

window.closeNewEventDialog = function () {
  const backdrop = document.getElementById('new-event-backdrop');
  if (backdrop) backdrop.classList.remove('open');
  document.removeEventListener('keydown', _newEventEsc);
  // Saves whatever was still waiting to save; the draft is there next time.
  if (_newEventEditor) { _newEventEditor.close(); _newEventEditor = null; }
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
  // The event sheet holds one event; with the event gone, so is it.
  if (state.eventSheetId) closeEventSheetDOM();
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
  clearEventEditMode();
  if (state.eventSheetId) { closeEventSheet(); return; }
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

// ── The event sheet: one event, expanded, on its own ──────────────────────
//
// For an event opened from somewhere that is not a list it sits in: a place's
// square on the map (a fair at the showground, not at the church), or the
// pinned card a parish's sheet shows for the event somebody came from. It
// never moves the map — the square is already where the reader is looking —
// and its parish button hands over to that parish's card with the event
// pinned there, collapsed (openParishFromEvent). One sheet, one event; closing
// the event closes it.

function openEventSheet(id) {
  const evt = (state.events || []).find(e => String(e.id) === String(id));
  const sheet = document.getElementById('event-sheet');
  const content = document.getElementById('event-sheet-content');
  if (!evt || !sheet || !content) return;
  clearEventEditMode();
  collapseEventCardDOM({ instant: true });
  delete state._openEventId;
  content.innerHTML = renderEventCard(evt);
  const card = content.querySelector('.event-card');
  state.eventSheetId = String(evt.id);
  sheet.classList.remove('hidden');
  sheet.setAttribute('aria-hidden', 'false');
  document.body.classList.add('event-sheet-open');
  expandEventCard(card.dataset.id, { scope: content, card, keepScroll: true });
  document.getElementById('event-sheet-scroll').scrollTop = 0;
  requestAnimationFrame(() => requestAnimationFrame(() => sheet.classList.add('open')));
}
window.agoraOpenEventSheet = openEventSheet;

function closeEventSheetDOM() {
  const sheet = document.getElementById('event-sheet');
  state.eventSheetId = null;
  document.body.classList.remove('event-sheet-open');
  if (!sheet) return;
  sheet.classList.remove('open');
  sheet.setAttribute('aria-hidden', 'true');
  sheet.style.transform = '';
  setTimeout(() => {
    if (state.eventSheetId) return;
    sheet.classList.add('hidden');
    document.getElementById('event-sheet-content').replaceChildren();
  }, 260);
}

function closeEventSheet() {
  clearEventEditMode();
  closeEventSheetDOM();
  delete state._openEventId;
  syncURL();
}

/**
 * An expanded event's parish button: that parish's card, with the event
 * pinned at its head and collapsed, and its feed collapsed too. Tapping the
 * pinned card opens the event again, in the event sheet, and the parish card
 * goes away.
 */
function openParishFromEvent(pid, eventId) {
  clearEventEditMode();
  if (state.eventSheetId) closeEventSheetDOM();
  delete state._openEventId;
  collapseEventCardDOM({ instant: true });
  state._pinnedEventId = eventId;
  const contentEl = document.getElementById('parish-sheet-content');
  // A full paint: the pinned slot is part of the head, which the partial
  // refresh of an already-open card leaves as it was.
  if (state.parishSheetFocus === pid && contentEl) {
    renderParishSheetContent(pid, { fullRender: true, focusEventId: eventId, pinCollapsed: true });
    syncURL();
    return;
  }
  openParishSheet(pid, { focusEventId: eventId, pinCollapsed: true });
}

(function initEventSheet() {
  const sheet = document.getElementById('event-sheet');
  if (!sheet) return;
  // Down off the handle, or off the top of the sheet's scroll, dismisses it.
  let startY = 0, dy = 0, dragging = false;
  const scroll = document.getElementById('event-sheet-scroll');
  sheet.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) return;
    const onHandle = !!e.target.closest('.event-sheet-handle');
    if (!onHandle && scroll.scrollTop > 0) return;
    startY = e.touches[0].clientY;
    dy = 0;
    dragging = true;
  }, { passive: true });
  sheet.addEventListener('touchmove', (e) => {
    if (!dragging) return;
    dy = Math.max(0, e.touches[0].clientY - startY);
    if (dy > 4) {
      sheet.classList.add('dragging');
      sheet.style.transform = `translateY(${dy}px)`;
    }
  }, { passive: true });
  sheet.addEventListener('touchend', () => {
    if (!dragging) return;
    dragging = false;
    sheet.classList.remove('dragging');
    if (dy > 90) closeEventSheet();
    else sheet.style.transform = '';
  });
  const x = document.getElementById('event-sheet-close');
  if (x) x.addEventListener('click', () => closeEventSheet());
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !state.eventSheetId) return;
    if (document.querySelector('.escalate-backdrop.open, .poster-fullscreen.open')) return;
    closeEventSheet();
  });
})();

// ── Fullscreen poster lightbox ──
function openPosterFullscreen(src) {
  const el = document.getElementById('poster-fullscreen');
  const img = document.getElementById('poster-fullscreen-img');
  const dlBtn = document.getElementById('poster-download');
  img.style.transform = '';
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
  // Once: the overlay is one element for the life of the page, and wiring it
  // on every open stacked a set of touch handlers per poster ever viewed.
  if (!el._posterWired) {
    el._posterWired = true;
    initPosterZoom(img);
    initPosterSwipeDismiss(el, img);
    // Two ways out besides a swipe: the X, and a tap anywhere that is not
    // the poster or its Download button.
    const x = document.getElementById('poster-close');
    if (x) x.addEventListener('click', (e) => { e.stopPropagation(); closePosterFullscreen(); });
    el.addEventListener('click', (e) => {
      if (e.target.closest('#poster-fullscreen-img, #poster-download, #poster-close')) return;
      closePosterFullscreen();
    });
  }
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
  // ONE line: a timetable has one source, and it is whoever changed it last —
  // an edit in /admin restamps every rule of the parish (stampTimetable in
  // worker/routes/admin.mjs), and an import that re-reads one rule is then the
  // latest change, which is also true. Rules with no source say nothing.
  let latest = null;
  for (const s of items) {
    if (!s.source_name) continue;
    if (!latest || String(s.source_checked_at || '') > String(latest.source_checked_at || '')) latest = s;
  }
  return latest
    ? sourceLineHTML(latest.source_name, latest.source_ref || '', latest.source_checked_at || '', 'sched-source')
    : '';
}

/**
 * "Updated 3 months ago · Antiochian Archdiocese ↗" — one provenance line.
 *
 * Shared, because a parish's details and its service times are the same kind
 * of claim and were being rendered as two different kinds. The service times
 * said how old they were; the details said "unverified", which reads as a
 * warning about the data and was in fact a statement about a column no scrape
 * ever writes (see parishes.info_verified_at in d1/schema.sql). Both lines now
 * answer the one question a reader is asking — when did anyone last look —
 * in the one form of words.
 *
 * No date renders no date: the name alone, never "unverified". We do not know
 * when the source was read, and saying so as a verdict on the parish would be
 * the same mistake in quieter language.
 */
function sourceLineHTML(name, ref, checked, cls) {
  if (!name) return '';
  const age = relativeAge(checked);
  // A span, not an img: the icon is painted by a CSS mask over `currentColor`
  // so it follows the line's muted colour and its hover state. An <img> would
  // paint its own black pixels over the mask and stay black in dark mode.
  const icon = '<span class="source-link-icon" aria-hidden="true"></span>';
  // The name is the readable half and the ref the checkable half, so the name
  // is what links — and only when the ref is actually a URL, since a source
  // can be a person or a file path and those must not render as dead links.
  // A photo of a church sign is the one path that does link: it is ours, in
  // R2 under /posters/ ("Church signage", public/shared/signs.js).
  const label = /^(https?:|\/posters\/)/.test(ref || '')
    ? `<a href="${esc(ref)}" target="_blank" rel="noopener">${esc(name)}${icon}</a>`
    : esc(name);
  return `<div class="${cls}">${age ? `Updated ${esc(age)} &middot; ` : ''}${label}</div>`;
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
    // The row's pencil is its own button (handled in the capture phase above).
    if (e.target.closest('[data-sched-edit]')) return;
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

/** "Add schedule": a new rule's form in the edit dialog — the photo of the sign first. */
function openAddScheduleDialog(pid) {
  const parish = (state.parishes || []).find(p => p.id === pid);
  state.endedRules = null;
  const body = openFormDialog({
    kind: 'add-rule',
    title: 'Add schedule',
    sub: parish ? parish.name : '',
    html: `${addServiceHTML(pid)}<div data-ended-slot="${esc(pid)}"></div>`,
  });
  mountVenuePicker(body, pid, null);
  wireScheduleAdminHandlers(body);
  loadEndedRules(pid);
  const first = body.querySelector('[data-af="title"]');
  if (first) first.focus({ preventScroll: true });
}
window.openAddScheduleDialog = openAddScheduleDialog;

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

// The line under a timetable row saying which weeks it runs: "1st, 3rd Sunday",
// or "fortnightly · next 5 Oct". A weekly rule says nothing, because every
// week is what a row already means.
function womDisplayLabel(rule, dayName) {
  if (rule && rule.week_parity) {
    const next = fortnightDates(rule.day_of_week, String(rule.week_parity).toLowerCase(), 1)[0];
    const when = next
      ? ` · next ${new Intl.DateTimeFormat('en-AU', { day: 'numeric', month: 'short' })
          .format(new Date(next + 'T00:00:00Z'))}`
      : '';
    // The date matters more than the word: "fortnightly" alone leaves a reader
    // to work out which fortnight, which is the one thing they cannot.
    return `<span class="schedule-item-wom">fortnightly${esc(when)}</span>`;
  }
  const qualifier = rule && rule.week_of_month;
  if (!qualifier) return '';
  const map = { first: '1st', second: '2nd', third: '3rd', fourth: '4th', last: 'last' };
  const parts = String(qualifier).split(',').map(q => map[q.trim()] || q.trim()).join(', ');
  return `<span class="schedule-item-wom">${esc(parts)} ${esc(dayName)}</span>`;
}

// Expose for filters/map
window.agoraState = state;
window.agoraFetchEvents = fetchEvents;
window.agoraFetchSchedules = fetchSchedules;
window.showParishDetail = showParishDetail;
