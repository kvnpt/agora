const TZ = 'Australia/Sydney';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const state = {
  events: [],
  schedules: [],
  parishes: [],
  user: null,
  isAdmin: false,
  userLat: -33.8688,
  userLng: 151.2093,
  mode: 'events', // 'events' | 'services'
  timeRange: 'today',
  filters: { jurisdiction: null, type: '', distance: 50 },
  subdomainJurisdiction: null
};

// ── Init ──
document.addEventListener('DOMContentLoaded', async () => {
  detectSubdomain();
  requestGeolocation();
  await Promise.all([fetchParishes(), checkAdmin()]);
  initFilters(state);
  initModeBar();
  initTimePills();
  initMapToggle();
  await fetchEvents();
  initMap(state);
  updateMap(state);
});

// ── Subdomain detection ──
function detectSubdomain() {
  const host = window.location.hostname;
  const match = host.match(/^(antiochian|greek|serbian|russian|romanian|coptic)\.orthodoxy\.au$/);
  if (match) {
    state.subdomainJurisdiction = match[1];
    state.filters.jurisdiction = match[1];
  }
}

// ── Geolocation ──
function requestGeolocation() {
  const cached = localStorage.getItem('agora_location');
  if (cached) {
    const loc = JSON.parse(cached);
    state.userLat = loc.lat;
    state.userLng = loc.lng;
  }
  if ('geolocation' in navigator) {
    navigator.geolocation.getCurrentPosition(
      pos => {
        state.userLat = pos.coords.latitude;
        state.userLng = pos.coords.longitude;
        localStorage.setItem('agora_location', JSON.stringify({ lat: state.userLat, lng: state.userLng }));
        if (state.mode === 'events') fetchEvents();
      },
      () => {},
      { timeout: 5000, maximumAge: 300000 }
    );
  }
}

// ── API ──
async function fetchEvents() {
  const params = new URLSearchParams({
    lat: state.userLat,
    lng: state.userLng,
    radius: state.filters.distance
  });
  if (state.filters.type) params.set('type', state.filters.type);
  if (state.filters.jurisdiction) params.set('jurisdiction', state.filters.jurisdiction);

  // Time range
  const now = new Date();
  const sydneyDate = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const [d, m, y] = sydneyDate.split('/');
  const todayStr = `${y}-${m}-${d}`;

  if (state.timeRange === 'today') {
    params.set('from', `${todayStr}T00:00:00+10:00`);
    params.set('to', `${todayStr}T23:59:59+10:00`);
  } else if (state.timeRange === 'week') {
    // Next 7 days
    const end = new Date(now.getTime() + 7 * 86400000);
    params.set('from', now.toISOString());
    params.set('to', end.toISOString());
  } else {
    // Rest of month
    const endMonth = new Date(Date.UTC(parseInt(y), parseInt(m), 0, 23, 59, 59));
    params.set('from', now.toISOString());
    params.set('to', endMonth.toISOString());
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

// ── Mode bar (Services button + Events pills) ──
function initModeBar() {
  const servicesBtn = document.getElementById('btn-services');
  servicesBtn.addEventListener('click', () => {
    if (state.mode === 'services') {
      // Toggle back to events
      state.mode = 'events';
      servicesBtn.classList.remove('active');
      document.getElementById('time-pills').style.display = '';
      showView('events');
      fetchEvents();
    } else {
      state.mode = 'services';
      servicesBtn.classList.add('active');
      document.getElementById('time-pills').style.display = 'none';
      showView('services');
      fetchSchedules();
    }
    updateFilterControls();
  });
}

function showView(name) {
  document.querySelectorAll('.content-view').forEach(v => v.classList.remove('active'));
  document.getElementById(`${name}-view`).classList.add('active');
}

function updateFilterControls() {
  const fc = document.querySelector('.filter-controls');
  if (fc) fc.classList.toggle('hidden', state.mode === 'services');
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
  const toggle = document.getElementById('map-toggle');
  toggle.addEventListener('click', () => {
    container.classList.toggle('expanded');
    setTimeout(() => { if (window.agoraMap) window.agoraMap.invalidateSize(); }, 350);
  });
}

// ── Render Events ──
function renderEvents() {
  const container = document.getElementById('events-list');
  if (!state.events.length) {
    container.innerHTML = '<div class="empty-state"><h3>No events found</h3><p>Try a different time range or adjust filters.</p></div>';
    return;
  }

  if (state.timeRange === 'today') {
    renderToday(container);
  } else if (state.timeRange === 'week') {
    renderWeek(container);
  } else {
    renderMonth(container);
  }

  bindEventCards(container);
}

function renderToday(container) {
  const now = new Date();
  const happeningNow = state.events.filter(e => {
    const start = new Date(e.start_utc);
    const end = e.end_utc ? new Date(e.end_utc) : new Date(start.getTime() + 3600000);
    return start <= now && end >= now;
  });
  const later = state.events.filter(e => new Date(e.start_utc) > now);

  let html = '';
  if (happeningNow.length) {
    html += '<div class="section-header"><span class="now-dot"></span>Happening now</div>';
    html += happeningNow.map(renderEventCard).join('');
  }
  if (later.length) {
    html += '<div class="section-header">Later today</div>';
    html += later.map(renderEventCard).join('');
  }
  if (!happeningNow.length && !later.length) {
    html = '<div class="empty-state"><h3>Nothing on today</h3></div>';
  }
  container.innerHTML = html;
}

function renderWeek(container) {
  const groups = groupByDay(state.events);
  let html = '';
  for (const [dateKey, events] of groups) {
    const d = parseLocalDate(events[0].start_utc);
    const dayFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'long', day: 'numeric', month: 'short' }).format(d);
    html += `<div class="day-header">${dayFmt}</div>`;
    html += events.map(renderEventCard).join('');
  }
  container.innerHTML = html;
}

function renderMonth(container) {
  // Same as week but potentially longer range
  const groups = groupByDay(state.events);
  let html = '';
  for (const [dateKey, events] of groups) {
    const d = parseLocalDate(events[0].start_utc);
    const dayFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(d);
    html += `<div class="day-header">${dayFmt}</div>`;
    html += events.map(renderEventCard).join('');
  }
  container.innerHTML = html;
}

function renderEventCard(evt) {
  const start = new Date(evt.start_utc);
  const time = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(start);
  const distStr = evt.distance_km != null ? `<span class="event-distance">${evt.distance_km} km</span>` : '';

  return `
    <div class="event-card" data-id="${evt.id}">
      <div class="event-content">
        <div class="event-title-row">
          <span class="event-title">${esc(evt.title)}</span>
          <span class="event-time">${time}</span>
          <span class="event-badge badge-${evt.event_type}">${evt.event_type}</span>
        </div>
        <div class="event-parish-row">${esc(evt.parish_name)} — ${esc(capitalize(evt.jurisdiction))}</div>
      </div>
      ${distStr}
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
  if (!state.schedules.length) {
    container.innerHTML = '<div class="empty-state"><h3>No services listed</h3></div>';
    return;
  }

  // Group by parish
  const byParish = new Map();
  for (const s of state.schedules) {
    if (!byParish.has(s.parish_id)) byParish.set(s.parish_id, { info: s, items: [] });
    byParish.get(s.parish_id).items.push(s);
  }

  let html = '';
  for (const [pid, { info, items }] of byParish) {
    html += `<div class="parish-schedule">`;
    html += `<div class="parish-schedule-name">${esc(info.parish_name)}</div>`;
    html += `<div class="parish-schedule-jurisdiction">${esc(capitalize(info.jurisdiction))} Orthodox</div>`;

    // Group by day
    const byDay = new Map();
    for (const item of items) {
      if (!byDay.has(item.day_of_week)) byDay.set(item.day_of_week, []);
      byDay.get(item.day_of_week).push(item);
    }

    for (const [day, schedules] of byDay) {
      html += `<div class="schedule-day">${DAYS[day]}</div>`;
      for (const s of schedules) {
        const t = formatTime12(s.start_time);
        html += `<div class="schedule-item">${esc(s.title)} <span class="schedule-item-time">— ${t}</span></div>`;
      }
    }
    html += '</div>';
  }

  container.innerHTML = html;
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

  content.innerHTML = `
    <h2 class="detail-title">${esc(evt.title)}</h2>
    <div class="detail-meta">
      <div>${dateFmt}</div>
      <div>${timeFmt}${endStr}</div>
      <div>${esc(evt.parish_name)} — ${esc(capitalize(evt.jurisdiction))}</div>
      ${addr ? `<div>${esc(addr)}</div>` : ''}
      ${evt.distance_km != null ? `<div>${evt.distance_km} km away</div>` : ''}
    </div>
    ${evt.description ? `<div class="detail-description">${esc(evt.description)}</div>` : ''}
    <div class="detail-actions">
      <a class="btn-primary" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}" target="_blank" rel="noopener">Directions</a>
      ${websiteCta}
    </div>`;

  // Show panel + backdrop
  panel.classList.remove('hidden');
  if (!document.querySelector('.detail-backdrop')) {
    const backdrop = document.createElement('div');
    backdrop.className = 'detail-backdrop';
    backdrop.addEventListener('click', closeDetail);
    document.body.appendChild(backdrop);
  }
}

function closeDetail() {
  document.getElementById('event-detail').classList.add('hidden');
  const backdrop = document.querySelector('.detail-backdrop');
  if (backdrop) backdrop.remove();
}

document.getElementById('close-detail').addEventListener('click', closeDetail);

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

function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// Expose for filters/map
window.agoraState = state;
window.agoraFetchEvents = fetchEvents;
window.agoraFetchSchedules = fetchSchedules;
