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
  timeRange: 'today',
  filters: { jurisdiction: null, type: '', distance: 50, parishIds: null, socialOnly: false, englishOnly: false },
  subdomainJurisdiction: null,
  locationActive: false,  // true once we have coords (set by either Near pill or Nearby sort)
  nearPillActive: false,  // true when Near pill is toggled on (sorts parish pills)
  eventsSort: 'time'  // 'time' | 'nearby'
};

// History flags — track whether we pushed a state entry so we know whether to call history.back()
let detailHistoryPushed = false;
let posterHistoryPushed = false;

// ── Init ──
document.addEventListener('DOMContentLoaded', async () => {
  detectSubdomain();
  disablePageZoom();
  disablePullToRefresh();
  loadCachedLocation();
  await Promise.all([fetchParishes(), checkAdmin()]);
  applyParishSlug();
  initFilters(state);
  initModeBar();
  initTimePills();
  initMapToggle();
  initParishFilter();
  initSocialFilter();
  initEnglishFilter();
  applyStartMode();
  updateArchdioceseEventsBanner();
  initMap(state);
  updateMap(state);

  // Re-render event cards every minute to keep LIVE countdowns current
  setInterval(() => {
    if (state.timeRange === 'today' && state.events.some(e => e.parish_live_url)) {
      renderEvents();
    }
  }, 60000);

  // Browser back button closes detail panel or fullscreen poster
  window.addEventListener('popstate', () => {
    const fsEl = document.getElementById('poster-fullscreen');
    const panelEl = document.getElementById('event-detail');
    if (fsEl && !fsEl.classList.contains('hidden')) {
      posterHistoryPushed = false;
      closePosterFullscreenDOM();
    } else if (panelEl && !panelEl.classList.contains('hidden')) {
      detailHistoryPushed = false;
      closeDetailDOM();
    }
  });
});

// ── Disable pinch/double-tap zoom on everything except the map ──
function disablePageZoom() {
  document.addEventListener('touchstart', e => {
    if (e.touches.length > 1 && !e.target.closest('#map')) {
      e.preventDefault();
    }
  }, { passive: false });

  let lastTap = 0;
  document.addEventListener('touchend', e => {
    if (e.target.closest('#map')) return;
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

    // Only block vertical pull-down gestures. If the gesture is primarily
    // horizontal (pill row swipe etc.) leave it alone entirely.
    if (Math.abs(dx) > Math.abs(dy)) return;

    const pullingDown = dy > 0;
    if (pullingDown && document.scrollingElement.scrollTop <= 0) {
      // Don't block if inside a scrollable panel that still has scroll room
      const scrollable = e.target.closest('.detail-panel, .events-view, .month-view');
      if (scrollable && scrollable.scrollTop > 0) return;
      if (e.cancelable) e.preventDefault();
    }
  }, { passive: false });
}

// ── Subdomain + path detection ──
function detectSubdomain() {
  const host = window.location.hostname;
  const match = host.match(/^(antiochian|greek|serbian|russian|romanian|macedonian)\.orthodoxy\.au$/);
  if (match) {
    state.subdomainJurisdiction = match[1];
    state.filters.jurisdiction = match[1];
  }

  // Parse path segments: /services, /en, /services/en, /services/<acronym>, /<acronym>
  const parts = decodeURIComponent(window.location.pathname)
    .toLowerCase().split('/').map(s => s.trim()).filter(Boolean);

  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (seg === 'services') {
      state._startMode = 'services';
    } else if (seg === 'en') {
      state.filters.englishOnly = true;
    } else {
      // Treat as parish acronym (applied after parishes load)
      state._parishSlug = seg;
    }
  }
}

// Apply parish slug filter after parishes are loaded
function applyParishSlug() {
  if (!state._parishSlug) return;
  const slug = state._parishSlug;
  const match = state.parishes.find(p => {
    if (p.id === '_unassigned') return false;
    const acronym = (p.acronym || '').toLowerCase();
    return acronym && acronym.replace(/\s+/g, '') === slug.replace(/\s+/g, '');
  });
  if (match) {
    state.filters.parishIds = new Set([match.id]);
    // Also set jurisdiction if not already set
    if (!state.filters.jurisdiction) {
      state.filters.jurisdiction = match.jurisdiction;
    }
  }
  delete state._parishSlug;
}

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
async function fetchEvents() {
  const params = new URLSearchParams({
    lat: state.userLat,
    lng: state.userLng
  });
  if (state.locationActive) params.set('radius', state.filters.distance);
  if (state.filters.type) params.set('type', state.filters.type);
  if (state.filters.jurisdiction) params.set('jurisdiction', state.filters.jurisdiction);

  const now = new Date();
  const sydneyDate = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [d, m, y] = sydneyDate.split('/');
  const todayStr = `${y}-${m}-${d}`;

  if (state.timeRange === 'today') {
    const startLocal = new Date(`${todayStr}T00:00:00`);
    const endLocal = new Date(`${todayStr}T23:59:59`);
    const testDate = new Date(`${todayStr}T12:00:00Z`);
    const sydneyStr = testDate.toLocaleString('en-US', { timeZone: TZ });
    const sydneyParsed = new Date(sydneyStr);
    const offsetMs = sydneyParsed.getTime() - testDate.getTime();
    params.set('from', new Date(startLocal.getTime() - offsetMs).toISOString());
    params.set('to', new Date(endLocal.getTime() - offsetMs).toISOString());
  } else {
    params.set('from', now.toISOString());
    params.set('to', new Date(Date.UTC(parseInt(y), parseInt(m), 0, 23, 59, 59)).toISOString());
  }

  try {
    const res = await fetch(`/api/events?${params}`);
    state.events = await res.json();
  } catch {
    state.events = [];
  }
  renderEvents();
  updateMap(state);
}

async function fetchSchedules() {
  const params = new URLSearchParams();
  if (state.filters.jurisdiction) params.set('jurisdiction', state.filters.jurisdiction);
  try {
    const res = await fetch(`/api/schedules?${params}`);
    state.schedules = await res.json();
  } catch {
    state.schedules = [];
  }
  renderServices();
  updateMap(state);
}

async function fetchParishes() {
  try {
    const res = await fetch('/api/parishes');
    state.parishes = await res.json();
  } catch {
    state.parishes = [];
  }
}

async function checkAdmin() {
  try {
    const res = await fetch('/api/admin/ping');
    state.isAdmin = res.ok;
  } catch {
    state.isAdmin = false;
  }
  if (state.isAdmin) {
    document.getElementById('admin-float').style.display = '';
  }
}

// ── Mode bar ──
function initModeBar() {
  const servicesBtn = document.getElementById('btn-services');
  const socialBtn = document.getElementById('btn-social');
  const timePills = document.getElementById('time-pills');

  servicesBtn.addEventListener('click', () => {
    if (state.mode === 'services') {
      state.mode = 'events';
      servicesBtn.classList.remove('active');
      socialBtn.style.display = '';
      if (state.timeRange === 'week') state.timeRange = 'today';
      timePills.innerHTML = `
        <button class="pill ${state.timeRange === 'today' ? 'active' : ''}" data-range="today">Today</button>
        <button class="pill ${state.timeRange === 'month' ? 'active' : ''}" data-range="month">This month</button>`;
      initTimePills();
      showView('events');
      fetchEvents();
      updateArchdioceseEventsBanner();
    } else {
      state.mode = 'services';
      servicesBtn.classList.add('active');
      socialBtn.style.display = 'none';
      timePills.innerHTML = '<span class="services-title">Service Times</span>';
      showView('services');
      fetchSchedules();
      updateArchdioceseEventsBanner();
    }
  });
}

function showView(name) {
  document.querySelectorAll('.content-view').forEach(v => v.classList.remove('active'));
  document.getElementById(`${name}-view`).classList.add('active');
}

// ── Apply URL-driven start state (mode, EN filter) ──
function applyStartMode() {
  const servicesBtn = document.getElementById('btn-services');
  const socialBtn = document.getElementById('btn-social');
  const timePills = document.getElementById('time-pills');
  const englishBtn = document.getElementById('btn-english');

  if (state.filters.englishOnly) {
    englishBtn.classList.add('active');
  }

  if (state._startMode === 'services') {
    state.mode = 'services';
    servicesBtn.classList.add('active');
    socialBtn.style.display = 'none';
    timePills.innerHTML = '<span class="services-title">Service Times</span>';
    showView('services');
    fetchSchedules();
  } else {
    fetchEvents();
  }
  delete state._startMode;
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
  const parishRow = document.getElementById('parish-filter-row');
  if (state.filters.jurisdiction) {
    parishRow.classList.add('visible');
  }
  renderParishPills();
}

function renderParishPills() {
  const row = document.getElementById('parish-filter-row');
  let relevant = state.parishes.filter(p => {
    if (p.id === '_unassigned') return false;
    if (state.filters.jurisdiction && p.jurisdiction !== state.filters.jurisdiction) return false;
    return true;
  });

  if (state.nearPillActive) {
    // Sort by distance when Near pill is active
    relevant = relevant.map(p => ({
      ...p,
      _dist: haversineKm(state.userLat, state.userLng, p.lat, p.lng)
    })).sort((a, b) => a._dist - b._dist);
  } else {
    // Sort alphabetically by acronym/name
    relevant = relevant.sort((a, b) => {
      const aName = a.acronym || a.name.split(',')[0];
      const bName = b.acronym || b.name.split(',')[0];
      return aName.localeCompare(bName);
    });
  }

  const allActive = state.filters.parishIds === null;

  // Location pill as leftmost item
  let html = `<button class="location-pill ${state.nearPillActive ? 'active' : ''}" id="btn-location-pill">` +
    `<img src="https://api.iconify.design/typcn:location-arrow.svg" alt="Location">` +
    `${state.nearPillActive ? 'On' : 'Near'}</button>`;

  for (const p of relevant) {
    const acronym = p.acronym || p.name.split(',')[0].replace(/^(Sts?|Holy) /, '').substring(0, 8);
    const distLabel = state.nearPillActive && p._dist != null ? `\u00B7${Math.round(p._dist)}km` : '';
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

  // Bind location pill — toggles parish sort independently from Nearby events sort
  document.getElementById('btn-location-pill').addEventListener('click', () => {
    if (state.nearPillActive) {
      state.nearPillActive = false;
      renderParishPills();
    } else if (state.locationActive) {
      // Already have coords, just activate pill sort
      state.nearPillActive = true;
      renderParishPills();
    } else {
      // Need to fetch location first
      requestGeolocation(() => {
        state.nearPillActive = true;
        renderParishPills();
      });
    }
  });
}

// Use event delegation on the row (set up once)
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('parish-filter-row').addEventListener('click', e => {
    const pill = e.target.closest('.parish-pill');
    if (!pill) return;

    const pid = pill.dataset.parish;

    if (state.filters.parishIds === null) {
      // All were active, selecting one turns off all others
      state.filters.parishIds = new Set([pid]);
    } else if (state.filters.parishIds.has(pid)) {
      // Deselecting
      state.filters.parishIds.delete(pid);
      if (state.filters.parishIds.size === 0) {
        // Last one deselected — re-activate all
        state.filters.parishIds = null;
      }
    } else {
      // Adding another parish
      state.filters.parishIds.add(pid);
    }

    renderParishPills();
    renderCurrentView();
  });
});

// ── Social filter ──
function initSocialFilter() {
  const btn = document.getElementById('btn-social');
  btn.addEventListener('click', () => {
    state.filters.socialOnly = !state.filters.socialOnly;
    btn.classList.toggle('active', state.filters.socialOnly);
    renderCurrentView();
  });
}

// ── English filter ──
function initEnglishFilter() {
  const btn = document.getElementById('btn-english');
  btn.addEventListener('click', () => {
    state.filters.englishOnly = !state.filters.englishOnly;
    btn.classList.toggle('active', state.filters.englishOnly);
    renderCurrentView();
  });
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
function renderCurrentView() {
  if (state.mode === 'services') {
    renderServices();
  } else {
    renderEvents();
  }
  updateMap(state);
}

// ── Apply client-side filters ──
function applyFilters(events) {
  let filtered = events;
  if (state.filters.parishIds) {
    filtered = filtered.filter(e => state.filters.parishIds.has(e.parish_id));
  }
  if (state.filters.socialOnly) {
    // Social = youth, social, talk, other, festival, fundraiser (everything NOT liturgical)
    filtered = filtered.filter(e => !LITURGICAL_TYPES.includes(e.event_type));
  }
  if (state.filters.englishOnly) {
    filtered = filtered.filter(e => {
      const langs = parseLangs(e.languages) || parseLangs(e.parish_languages);
      return langs && langs.some(l => /english/i.test(l));
    });
  }
  return filtered;
}

// ── Time pills ──
function initTimePills() {
  document.querySelectorAll('.pill').forEach(btn => {
    btn.addEventListener('click', () => {
      state.timeRange = btn.dataset.range;
      document.querySelectorAll('.pill').forEach(b => b.classList.toggle('active', b === btn));
      fetchEvents();
    });
  });
}

// ── Map toggle ──
function initMapToggle() {
  const container = document.getElementById('map-container');
  const handle = document.querySelector('.map-grab-handle');
  const modeBar = document.getElementById('mode-bar');
  const MIN_H = 120, MAX_H = window.innerHeight * 0.65;
  let dragging = false, startY = 0, startH = 0;

  function engage(y) {
    dragging = true;
    pending = false;
    startY = y;
    startH = container.offsetHeight;
    container.style.transition = 'none';
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
  }

  // Grab handle: engage immediately
  function onHandleStart(e) {
    if (e.cancelable) e.preventDefault();
    engage(e.touches ? e.touches[0].clientY : e.clientY);
  }

  // Mode bar: only drag from empty space, not buttons
  function onModeBarStart(e) {
    if (e.target.closest('button, a, .pill')) return;
    if (e.cancelable) e.preventDefault();
    engage(e.touches ? e.touches[0].clientY : e.clientY);
  }

  function onMove(e) {
    const y = e.touches ? e.touches[0].clientY : e.clientY;

    if (!dragging) return;
    if (e.cancelable) e.preventDefault();
    const newH = Math.min(MAX_H, Math.max(MIN_H, startH + (y - startY)));
    container.style.height = newH + 'px';
  }

  function onEnd() {
    if (!dragging) return;
    dragging = false;
    container.style.transition = '';
    document.body.style.userSelect = '';
    document.body.style.webkitUserSelect = '';
    const h = container.offsetHeight;
    const mid = (MIN_H + MAX_H) / 2;
    if (h < mid) {
      container.style.height = MIN_H + 'px';
      container.classList.remove('expanded');
    } else {
      container.style.height = '';
      container.classList.add('expanded');
    }
    setTimeout(() => {
      if (window.agoraMap) {
        window.agoraMap.invalidateSize();
        updateMap(state);
      }
    }, 350);
  }

  handle.addEventListener('mousedown', onHandleStart);
  handle.addEventListener('touchstart', onHandleStart, { passive: false });
  modeBar.addEventListener('mousedown', onModeBarStart);
  modeBar.addEventListener('touchstart', onModeBarStart, { passive: false });
  document.addEventListener('mousemove', onMove);
  document.addEventListener('touchmove', onMove, { passive: false });
  document.addEventListener('mouseup', onEnd);
  document.addEventListener('touchend', onEnd);
}

// ── Render Events ──
function renderEvents() {
  const container = document.getElementById('events-list');
  const filtered = applyFilters(state.events);

  if (!filtered.length) {
    container.innerHTML = '<div class="empty-state"><h3>No events found</h3><p>Try a different time range or adjust filters.</p></div>';
    return;
  }

  if (state.timeRange === 'today') {
    renderToday(container, filtered);
  } else {
    renderMonth(container, filtered);
  }

  bindEventCards(container);
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

function buildSortToggle() {
  const locIcon = `<img class="sort-icon" src="https://api.iconify.design/typcn:location-arrow.svg" alt="">`;
  return `<span class="sort-toggle">` +
    `<button class="sort-nearby ${state.eventsSort === 'nearby' ? 'active' : ''}" data-sort="nearby">${locIcon}Nearby</button>` +
    `<span class="sort-sep">|</span>` +
    `<button class="sort-time ${state.eventsSort === 'time' ? 'active' : ''}" data-sort="time">Time</button>` +
    `</span>`;
}

function renderSubDaySections(events, html) {
  const { morning, evening } = splitMorningEvening(events);
  if (morning.length) {
    html += `<div class="sub-day-header">Morning</div>`;
    html += sortEvents(morning).map(renderEventCard).join('');
  }
  if (evening.length) {
    html += `<div class="sub-day-header">Evening</div>`;
    html += sortEvents(evening).map(renderEventCard).join('');
  }
  return html;
}

function renderToday(container, events) {
  const now = new Date();
  const happeningNow = events.filter(e => {
    const start = new Date(e.start_utc);
    const end = e.end_utc ? new Date(e.end_utc) : new Date(start.getTime() + 3600000);
    return start <= now && end >= now;
  });
  const later = events.filter(e => new Date(e.start_utc) > now);

  const sortToggle = buildSortToggle();

  let html = '';
  if (happeningNow.length) {
    html += `<div class="section-header"><span class="now-dot"></span>Happening now${sortToggle}</div>`;
    html += sortEvents(happeningNow).map(renderEventCard).join('');
  }
  if (later.length) {
    const laterToggle = happeningNow.length ? '' : sortToggle;
    html += `<div class="section-header">Later today${laterToggle}</div>`;
    html = renderSubDaySections(later, html);
  }
  if (!happeningNow.length && !later.length) {
    html = '<div class="empty-state"><span class="empty-ornament">✦</span><h3>Nothing on today</h3></div>';
  }
  html += `<div class="list-footer"><div class="list-footer-ornament">· · ·</div><button class="list-footer-btn" id="cta-month">View more</button></div>`;
  container.innerHTML = html;

  container.querySelector('#cta-month').addEventListener('click', () => {
    state.timeRange = 'month';
    document.querySelectorAll('.pill').forEach(b => b.classList.toggle('active', b.dataset.range === 'month'));
    fetchEvents();
  });

  bindSortToggle(container);
}

function bindSortToggle(container) {
  container.querySelectorAll('.sort-toggle button').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const sort = btn.dataset.sort;
      if (sort === 'nearby' && !state.locationActive) {
        requestGeolocation(() => {
          state.eventsSort = 'nearby';
          renderEvents();
        });
        return;
      }
      state.eventsSort = sort;
      renderEvents();
    });
  });
}

function renderMonth(container, events) {
  const groups = groupByDay(events);
  const now = new Date();
  const sevenDaysOut = new Date(now.getTime() + 7 * 86400000);

  // Get jurisdiction color for Sunday styling
  const jColor = getJurisdictionColor();
  const sortToggle = buildSortToggle();

  let html = '';
  let first = true;
  for (const [dateKey, evts] of groups) {
    const d = parseLocalDate(evts[0].start_utc);
    const weekdayStyle = d < sevenDaysOut ? 'long' : 'short';
    const dayFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: weekdayStyle, day: 'numeric', month: 'short' }).format(d);

    const dayOfWeek = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'long' }).format(d);
    const isSunday = dayOfWeek === 'Sunday';

    if (!first) html += `<hr class="day-divider">`;

    if (isSunday) {
      html += `<div class="sunday-cluster" style="border-left-color:${jColor}; background: ${jColor}08;">`;
    }
    const toggle = first ? sortToggle : '';
    html += `<div class="section-header">${dayFmt}${toggle}</div>`;
    first = false;
    html = renderSubDaySections(evts, html);
    if (isSunday) {
      html += `</div>`;
    }
  }
  html += `<div class="list-footer"><div class="list-footer-ornament">· · ·</div><button class="list-footer-btn" id="cta-services">View regular schedules</button></div>`;
  container.innerHTML = html;

  container.querySelector('#cta-services').addEventListener('click', () => {
    document.getElementById('btn-services').click();
  });

  bindSortToggle(container);
}

function getJurisdictionColor() {
  const j = state.filters.jurisdiction;
  const map = { antiochian: '#1e3a5f', greek: '#00508f', serbian: '#b22234', russian: '#c8a951', romanian: '#002b7f', macedonian: '#d20000' };
  return map[j] || '#888888';
}

function renderEventCard(evt) {
  const start = new Date(evt.start_utc);
  const time = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(start);
  const acronymColor = evt.parish_color || '#000';
  const acronym = evt.parish_acronym ? `<span class="event-parish-acronym" style="color:${esc(acronymColor)}">${esc(evt.parish_acronym)}</span>` : '';

  // Display-time type mapping
  const displayType = TYPE_DISPLAY[evt.event_type] || evt.event_type;
  const badgeCss = `badge-${evt.event_type}`; // keep original CSS class for colors
  const langs = evt.languages ? JSON.parse(evt.languages) : [];
  const bilingualBadge = langs.length >= 2 ? `<span class="event-badge badge-bilingual">BILINGUAL</span>` : '';
  const badge = `<span class="event-badge ${badgeCss}">${displayType}</span>`;

  // LIVE badge
  let liveBadge = '';
  if (evt.parish_live_url) {
    if (state.timeRange === 'today') {
      const now = Date.now();
      const evtStart = new Date(evt.start_utc).getTime();
      const evtEnd = evt.end_utc ? new Date(evt.end_utc).getTime() : evtStart + 3600000;
      if (now >= evtStart - 900000 && now <= evtEnd + 3600000) {
        liveBadge = `<span class="event-badge badge-live"><span class="live-dot"></span>LIVE</span>`;
      } else if (now < evtStart - 900000) {
        const mins = Math.round((evtStart - now) / 60000);
        const label = mins >= 60 ? `LIVE IN ${Math.round(mins / 60)}H` : `LIVE IN ${mins}M`;
        liveBadge = `<span class="event-badge badge-live-soon">${label}</span>`;
      }
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

  return `
    <div class="event-card${isCancelled ? ' event-cancelled' : ''}" data-id="${evt.id}">
      <div class="event-content">
        <div class="event-title-row">
          <span class="event-title">${esc(evt.title)}</span>
          <span class="event-time">${time}</span>
        </div>
        <div class="event-parish-row">${acronym}${esc(evt.parish_name)}${distHtml} ${badge}${bilingualBadge}${liveBadge}${cancelledBadge}</div>
      </div>
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
function renderServices() {
  const container = document.getElementById('services-list');
  let schedules = state.schedules;
  if (state.filters.parishIds) {
    schedules = schedules.filter(s => state.filters.parishIds.has(s.parish_id));
  }
  if (state.filters.englishOnly) {
    schedules = schedules.filter(s => {
      const langs = parseLangs(s.languages) || parseLangs(s.parish_languages);
      return langs && langs.some(l => /english/i.test(l));
    });
  }

  if (!schedules.length) {
    container.innerHTML = '<div class="empty-state"><h3>No services listed</h3></div>';
    return;
  }

  const byParish = new Map();
  for (const s of schedules) {
    if (!byParish.has(s.parish_id)) byParish.set(s.parish_id, { info: s, items: [] });
    byParish.get(s.parish_id).items.push(s);
  }

  let html = '';
  for (const [pid, { info, items }] of byParish) {
    const pColor = info.parish_color || '#000';
    html += `<div class="parish-schedule" data-parish-id="${esc(pid)}" style="border-left: 3px solid ${pColor};">`;
    html += `<div class="parish-schedule-name">${esc(info.parish_name)}</div>`;
    html += `<div class="parish-schedule-jurisdiction">${esc(capitalize(info.jurisdiction))} Orthodox</div>`;

    const byDay = new Map();
    for (const item of items) {
      if (!byDay.has(item.day_of_week)) byDay.set(item.day_of_week, []);
      byDay.get(item.day_of_week).push(item);
    }

    const types = ['liturgy','prayer','feast','talk','youth','social','other'];
    for (const [day, scheds] of byDay) {
      html += `<div class="schedule-day">${DAYS[day]}</div>`;
      for (const s of scheds) {
        const t = formatTime12(s.start_time);
        const langs = (() => { try { return JSON.parse(s.languages || '[]'); } catch { return []; } })();
        const langLabel = langs.length ? `<span class="schedule-item-lang">${esc(langs.join(', '))}</span>` : '';
        const womLabel = womDisplayLabel(s.week_of_month, DAYS[day]);
        const editBtn = state.isAdmin ? `<button class="schedule-edit-btn" data-sid="${s.id}" title="Edit schedule">✎</button>` : '';
        html += `<div class="schedule-item">${esc(s.title)} <span class="schedule-item-time">— ${t}</span> ${langLabel}${womLabel}${editBtn}</div>`;
        if (state.isAdmin) {
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
            <div style="display:flex;gap:4px;margin-top:4px;">
              <button class="schedule-save-btn" data-sid="${s.id}">Save</button>
              <button class="schedule-del-btn" data-sid="${s.id}">Delete</button>
            </div>
          </div>`;
        }
      }
    }
    html += '</div>';
  }

  const archUrl = ARCHDIOCESE_EVENTS[state.filters.jurisdiction];
  const archFooter = archUrl
    ? `<div class="list-footer"><div class="list-footer-ornament">· · ·</div><a class="list-footer-arch-link" href="${esc(archUrl)}" target="_blank" rel="noopener">${esc(capitalize(state.filters.jurisdiction || ''))} Archdiocese</a></div>`
    : `<div class="list-footer"><div class="list-footer-ornament">· · ·</div></div>`;
  html += archFooter;
  container.innerHTML = html;

  // Make service cards clickable
  container.querySelectorAll('.parish-schedule').forEach(card => {
    card.addEventListener('click', () => {
      showParishDetail(card.dataset.parishId);
    });
  });

  // Admin: toggle edit form
  container.querySelectorAll('.schedule-edit-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const form = document.getElementById('sef-' + btn.dataset.sid);
      form.style.display = form.style.display === 'none' ? 'block' : 'none';
    });
  });

  // Admin: save schedule
  container.querySelectorAll('.schedule-save-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.sid;
      const form = document.getElementById('sef-' + id);
      const data = {};
      form.querySelectorAll('[data-f]').forEach(input => {
        const field = input.dataset.f;
        if (field === 'week_of_month') {
          const checked = [...input.querySelectorAll('input[type=checkbox]:checked')].map(cb => cb.value);
          data[field] = checked.length ? checked.join(',') : null;
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

  // Admin: delete schedule
  container.querySelectorAll('.schedule-del-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm('Delete this schedule?')) return;
      fetch(`/api/admin/schedules/${btn.dataset.sid}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } })
        .then(r => { if (r.ok) fetchSchedules(); });
    });
  });
}

// ── Event detail ──
function showEventDetail(id) {
  const evt = state.events.find(e => e.id === id);
  if (!evt) return;

  const panel = document.getElementById('event-detail');
  const content = document.getElementById('detail-content');
  const start = new Date(evt.start_utc);

  const dateFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(start);
  const timeFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(start);

  let endStr = '';
  if (evt.end_utc) {
    endStr = ` — ${new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(new Date(evt.end_utc))}`;
  }

  const addr = evt.location_override || evt.parish_address || '';
  const lat = evt.lat || 0;
  const lng = evt.lng || 0;
  const websiteCta = evt.parish_website ? `<a class="btn-outline" href="${esc(evt.parish_website)}" target="_blank" rel="noopener">Visit Parish</a>` : '';

  const watchLiveCta = evt.parish_live_url
    ? `<a class="btn-watch-live" href="${esc(evt.parish_live_url)}" target="_blank" rel="noopener"><span class="live-dot"></span>Watch Live</a>`
    : '';

  let adminActions = '';
  if (state.isAdmin) {
    const isCancelled = evt.status === 'cancelled';
    const isHidden = evt.status === 'hidden';
    adminActions = `
      <button class="btn-outline btn-cancel-event" onclick="setEventStatus(${evt.id},'${isCancelled ? 'approved' : 'cancelled'}')">${isCancelled ? 'Uncancel' : 'Cancel'}</button>
      <button class="btn-outline btn-hide-event" onclick="setEventStatus(${evt.id},'${isHidden ? 'approved' : 'hidden'}')">${isHidden ? 'Unhide' : 'Hide'}</button>
      <button class="btn-danger" onclick="deleteEvent(${evt.id})">Delete</button>
      <button class="btn-outline" onclick="toggleEditEvent(${evt.id})">Edit</button>`;
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
        <div style="margin-top:8px;display:flex;gap:8px;">
          <button class="btn-save" onclick="saveEvent(${evt.id})">Save</button>
        </div>
      </div>`;
  }

  const posterHtml = evt.poster_path
    ? `<div class="detail-poster"><img src="${esc(evt.poster_path)}" alt="Event poster"></div>`
    : '';

  content.innerHTML = `
    <h2 class="detail-title">${esc(evt.title)}</h2>
    <div class="detail-meta">
      <div>${dateFmt}</div>
      <div>${timeFmt}${endStr}</div>
      <div>${esc(evt.parish_name)}</div>
      ${addr ? `<div>${esc(addr)}</div>` : ''}
      ${evt.distance_km != null ? `<div>${evt.distance_km} km away</div>` : ''}
    </div>
    ${evt.description ? `<div class="detail-description">${esc(evt.description)}</div>` : ''}
    <div class="detail-actions">
      <a class="btn-primary" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}" target="_blank" rel="noopener">Directions</a>
      ${watchLiveCta}
      ${websiteCta}
      ${adminActions}
    </div>
    ${posterHtml}
    ${editForm}`;

  // Set parish color accent on the panel
  panel.style.borderLeftColor = evt.parish_color || 'var(--border)';

  // Attach pinch-to-zoom on poster if present
  // Tap poster to open fullscreen; pinch also triggers fullscreen via initPosterZoom
  const posterContainer = content.querySelector('.detail-poster');
  const posterEl = content.querySelector('.detail-poster img');
  if (posterEl) {
    initPosterZoom(posterEl);
    posterContainer.addEventListener('click', () => openPosterFullscreen(posterEl.src));
  }

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
  const data = {
    title: document.getElementById(`edit-title-${id}`).value,
    description: document.getElementById(`edit-desc-${id}`).value || null,
    event_type: document.getElementById(`edit-type-${id}`).value,
    parish_id: document.getElementById(`edit-parish-${id}`).value,
    languages: langsArr.length ? JSON.stringify(langsArr) : null,
    start_utc: startVal ? localInputToUtc(startVal) : undefined,
    end_utc: endVal ? localInputToUtc(endVal) : null
  };
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
  document.getElementById('event-detail').classList.add('hidden');
  const backdrop = document.querySelector('.detail-backdrop');
  if (backdrop) backdrop.remove();
}

function closeDetail() {
  closeDetailDOM();
  if (detailHistoryPushed) {
    detailHistoryPushed = false;
    history.back();
  }
}

document.getElementById('close-detail').addEventListener('click', closeDetail);

// ── Fullscreen poster lightbox ──
function openPosterFullscreen(src) {
  const el = document.getElementById('poster-fullscreen');
  const img = document.getElementById('poster-fullscreen-img');
  img.src = src;
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
  const ampm = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return m === 0 ? `${h12} ${ampm}` : `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
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
