const TZ = 'Australia/Sydney';
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const LITURGICAL_TYPES = ['liturgy', 'prayer', 'feast', 'vespers', 'matins'];

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
  filters: { jurisdiction: null, type: '', distance: 50, parishIds: null, socialOnly: false },
  subdomainJurisdiction: null,
  locationActive: false,
  todaySort: 'time'  // 'time' | 'nearby'
};

// ── Init ──
document.addEventListener('DOMContentLoaded', async () => {
  detectSubdomain();
  disablePageZoom();
  loadCachedLocation();
  await Promise.all([fetchParishes(), checkAdmin()]);
  initFilters(state);
  initModeBar();
  initTimePills();
  initMapToggle();
  initParishFilter();
  initSocialFilter();
  await fetchEvents();
  initMap(state);
  updateMap(state);
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

// ── Subdomain detection ──
function detectSubdomain() {
  const host = window.location.hostname;
  const match = host.match(/^(antiochian|greek|serbian|russian|romanian|macedonian)\.orthodoxy\.au$/);
  if (match) {
    state.subdomainJurisdiction = match[1];
    state.filters.jurisdiction = match[1];
  }
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
      if (callback) callback();
      else {
        renderParishPills();
        renderCurrentView();
      }
    },
    () => { alert('Location access denied. Enable it in your browser settings.'); },
    { timeout: 8000, maximumAge: 300000 }
  );
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
    } else {
      state.mode = 'services';
      servicesBtn.classList.add('active');
      socialBtn.style.display = 'none';
      timePills.innerHTML = '<span class="services-title">Service Times</span>';
      showView('services');
      fetchSchedules();
    }
  });
}

function showView(name) {
  document.querySelectorAll('.content-view').forEach(v => v.classList.remove('active'));
  document.getElementById(`${name}-view`).classList.add('active');
}

// ── Parish filter ──
function initParishFilter() {
  renderParishPills();
}

function renderParishPills() {
  const row = document.getElementById('parish-filter-row');
  let relevant = state.parishes.filter(p => {
    if (p.id === '_unassigned') return false;
    if (state.filters.jurisdiction && p.jurisdiction !== state.filters.jurisdiction) return false;
    return true;
  });

  // Sort by distance when location is active
  if (state.locationActive) {
    relevant = relevant.map(p => ({
      ...p,
      _dist: haversineKm(state.userLat, state.userLng, p.lat, p.lng)
    })).sort((a, b) => a._dist - b._dist);
  }

  const allActive = state.filters.parishIds === null;

  // Location pill as leftmost item
  let html = `<button class="location-pill ${state.locationActive ? 'active' : ''}" id="btn-location-pill">` +
    `<img src="https://api.iconify.design/typcn:location-arrow.svg" alt="Location">` +
    `${state.locationActive ? 'On' : 'Near'}</button>`;

  for (const p of relevant) {
    const acronym = p.acronym || p.name.split(',')[0].replace(/^(Sts?|Holy) /, '').substring(0, 8);
    const distLabel = state.locationActive && p._dist != null ? `\u00B7${Math.round(p._dist)}km` : '';
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

  // Bind location pill
  document.getElementById('btn-location-pill').addEventListener('click', () => {
    if (state.locationActive) {
      state.locationActive = false;
      renderParishPills();
      renderCurrentView();
    } else {
      requestGeolocation();
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
  const toggle = document.getElementById('map-toggle');
  toggle.addEventListener('click', () => {
    container.classList.toggle('expanded');
    setTimeout(() => {
      if (window.agoraMap) {
        window.agoraMap.invalidateSize();
        updateMap(state);
      }
    }, 350);
  });
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

function renderToday(container, events) {
  const now = new Date();
  let happeningNow = events.filter(e => {
    const start = new Date(e.start_utc);
    const end = e.end_utc ? new Date(e.end_utc) : new Date(start.getTime() + 3600000);
    return start <= now && end >= now;
  });
  let later = events.filter(e => new Date(e.start_utc) > now);

  // Sort by distance if nearby mode is active
  if (state.todaySort === 'nearby' && state.locationActive) {
    const sortByDist = arr => arr.sort((a, b) => (a.distance_km || 999) - (b.distance_km || 999));
    happeningNow = sortByDist([...happeningNow]);
    later = sortByDist([...later]);
  }

  const locIcon = `<img class="sort-icon" src="https://api.iconify.design/typcn:location-arrow.svg" alt="">`;
  const sortToggle = `<span class="sort-toggle">` +
    `<button class="sort-nearby ${state.todaySort === 'nearby' ? 'active' : ''}" data-sort="nearby">${locIcon}Nearby</button>` +
    `<span class="sort-sep">|</span>` +
    `<button class="sort-time ${state.todaySort === 'time' ? 'active' : ''}" data-sort="time">Time</button>` +
    `</span>`;

  let html = '';
  if (happeningNow.length) {
    html += `<div class="section-header"><span class="now-dot"></span>Happening now${sortToggle}</div>`;
    html += happeningNow.map(renderEventCard).join('');
  }
  if (later.length) {
    const laterToggle = happeningNow.length ? '' : sortToggle;
    html += `<div class="section-header">Later today${laterToggle}</div>`;
    html += later.map(renderEventCard).join('');
  }
  if (!happeningNow.length && !later.length) {
    html = '<div class="empty-state"><h3>Nothing on today</h3><p><button class="cta-link" id="cta-month">See upcoming days &rarr;</button></p></div>';
  }
  container.innerHTML = html;

  // Bind CTA to switch to month view
  const ctaMonth = container.querySelector('#cta-month');
  if (ctaMonth) {
    ctaMonth.addEventListener('click', () => {
      state.timeRange = 'month';
      document.querySelectorAll('.pill').forEach(b => b.classList.toggle('active', b.dataset.range === 'month'));
      fetchEvents();
    });
  }

  // Bind sort toggle clicks
  container.querySelectorAll('.sort-toggle button').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const sort = btn.dataset.sort;
      if (sort === 'nearby' && !state.locationActive) {
        requestGeolocation(() => {
          state.todaySort = 'nearby';
          renderEvents();
        });
        return;
      }
      state.todaySort = sort;
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

  let html = '';
  for (const [dateKey, evts] of groups) {
    const d = parseLocalDate(evts[0].start_utc);
    // Full day name for next 7 days, abbreviated after
    const weekdayStyle = d < sevenDaysOut ? 'long' : 'short';
    const dayFmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: weekdayStyle, day: 'numeric', month: 'short' }).format(d);

    // Check if this is a Sunday
    const dayOfWeek = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'long' }).format(d);
    const isSunday = dayOfWeek === 'Sunday';

    if (isSunday) {
      html += `<div class="sunday-cluster" style="border-left-color:${jColor}; background: ${jColor}08;">`;
    }
    html += `<div class="section-header">${dayFmt}</div>`;
    html += evts.map(renderEventCard).join('');
    if (isSunday) {
      html += `</div>`;
    }
  }
  container.innerHTML = html;
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
  const badge = `<span class="event-badge ${badgeCss}">${displayType}</span>`;

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

  return `
    <div class="event-card" data-id="${evt.id}">
      <div class="event-content">
        <div class="event-title-row">
          <span class="event-title">${esc(evt.title)}</span>
          <span class="event-time">${time}</span>
        </div>
        <div class="event-parish-row">${acronym}${esc(evt.parish_name)}${distHtml} ${badge}</div>
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

    for (const [day, scheds] of byDay) {
      html += `<div class="schedule-day">${DAYS[day]}</div>`;
      for (const s of scheds) {
        const t = formatTime12(s.start_time);
        html += `<div class="schedule-item">${esc(s.title)} <span class="schedule-item-time">— ${t}</span></div>`;
      }
    }
    html += '</div>';
  }

  container.innerHTML = html;

  // Make service cards clickable
  container.querySelectorAll('.parish-schedule').forEach(card => {
    card.addEventListener('click', () => {
      showParishDetail(card.dataset.parishId);
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

  let adminActions = '';
  if (state.isAdmin) {
    adminActions = `
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
        <div class="edit-row"><label>Start (Sydney)</label><input type="datetime-local" id="edit-start-${evt.id}" value="${utcToLocalInput(evt.start_utc)}"></div>
        <div class="edit-row"><label>End (Sydney)</label><input type="datetime-local" id="edit-end-${evt.id}" value="${utcToLocalInput(evt.end_utc)}"></div>
        <div style="margin-top:8px;display:flex;gap:8px;">
          <button class="btn-save" onclick="saveEvent(${evt.id})">Save</button>
        </div>
      </div>`;
  }

  const posterHtml = evt.poster_path
    ? `<div class="detail-poster" id="detail-poster"><img src="${esc(evt.poster_path)}" alt="Event poster"></div>`
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
    ${posterHtml}
    <div class="detail-actions">
      <a class="btn-primary" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}" target="_blank" rel="noopener">Directions</a>
      ${websiteCta}
      ${adminActions}
    </div>
    ${editForm}`;

  // Poster lightbox
  const posterEl = content.querySelector('#detail-poster');
  if (posterEl) {
    posterEl.addEventListener('click', () => {
      const lb = document.getElementById('poster-lightbox');
      document.getElementById('poster-lightbox-img').src = evt.poster_path;
      lb.classList.remove('hidden');
    });
  }

  // Set parish color accent on the panel
  panel.style.borderLeftColor = evt.parish_color || 'var(--border)';

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
  const data = {
    title: document.getElementById(`edit-title-${id}`).value,
    description: document.getElementById(`edit-desc-${id}`).value || null,
    event_type: document.getElementById(`edit-type-${id}`).value,
    parish_id: document.getElementById(`edit-parish-${id}`).value,
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

window.deleteEvent = async function(id) {
  if (!confirm('Permanently delete this event?')) return;
  const res = await fetch(`/api/admin/events/${id}`, { method: 'DELETE' });
  if (res.ok) {
    closeDetail();
    fetchEvents();
  }
};

function closeDetail() {
  document.getElementById('event-detail').classList.add('hidden');
  const backdrop = document.querySelector('.detail-backdrop');
  if (backdrop) backdrop.remove();
}

document.getElementById('close-detail').addEventListener('click', closeDetail);

// Poster lightbox close
document.getElementById('poster-lightbox-close').addEventListener('click', () => {
  document.getElementById('poster-lightbox').classList.add('hidden');
});
document.getElementById('poster-lightbox').addEventListener('click', e => {
  if (e.target === e.currentTarget) document.getElementById('poster-lightbox').classList.add('hidden');
});

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
window.showParishDetail = showParishDetail;
