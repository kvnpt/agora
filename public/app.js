// State
const state = {
  events: [],
  parishes: [],
  user: null,
  userLat: -33.8688,
  userLng: 151.2093,
  filters: {
    jurisdiction: null,
    type: '',
    distance: 50
  },
  view: 'list'
};

const TZ = 'Australia/Sydney';

// Init
document.addEventListener('DOMContentLoaded', async () => {
  requestGeolocation();
  await Promise.all([fetchUser(), fetchParishes()]);
  await fetchEvents();
  initFilters(state);
  renderUserArea();
});

// Geolocation
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
        localStorage.setItem('agora_location', JSON.stringify({
          lat: state.userLat, lng: state.userLng
        }));
        fetchEvents();
      },
      () => {}, // silently fall back to default/cached
      { timeout: 5000, maximumAge: 300000 }
    );
  }
}

// API calls
async function fetchEvents() {
  const params = new URLSearchParams({
    lat: state.userLat,
    lng: state.userLng,
    radius: state.filters.distance
  });
  if (state.filters.type) params.set('type', state.filters.type);
  if (state.filters.jurisdiction) params.set('jurisdiction', state.filters.jurisdiction);

  try {
    const res = await fetch(`/api/events?${params}`);
    state.events = await res.json();
  } catch (err) {
    console.error('Failed to fetch events:', err);
    state.events = [];
  }
  renderEvents();
  if (state.view === 'map') updateMap(state);
}

async function fetchParishes() {
  try {
    const res = await fetch('/api/parishes');
    state.parishes = await res.json();
  } catch (err) {
    console.error('Failed to fetch parishes:', err);
  }
}

async function fetchUser() {
  try {
    const res = await fetch('/auth/me');
    state.user = await res.json();
  } catch {
    state.user = null;
  }
}

// Render events list
function renderEvents() {
  const container = document.getElementById('events-list');
  if (!state.events.length) {
    container.innerHTML = `
      <div class="empty-state">
        <h3>No upcoming events found</h3>
        <p>Try adjusting your filters or increasing the distance range.</p>
      </div>`;
    return;
  }

  container.innerHTML = state.events.map(evt => {
    const start = new Date(evt.start_utc);
    const fmt = new Intl.DateTimeFormat('en-AU', { timeZone: TZ });
    const parts = fmt.formatToParts(start);
    const day = parts.find(p => p.type === 'day')?.value;
    const month = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, month: 'short' }).format(start);
    const weekday = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short' }).format(start);
    const time = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(start);

    const distStr = evt.distance_km != null ? `${evt.distance_km} km` : '';
    const lat = evt.lat || 0;
    const lng = evt.lng || 0;

    const logoHtml = evt.parish_logo ? `<img src="${esc(evt.parish_logo)}" class="event-parish-logo" alt="">` : '';
    const sourceTag = evt.source_adapter && evt.source_adapter !== 'schedule' ? `<span class="event-source">via ${esc(evt.source_adapter)}</span>` : '';

    return `
      <div class="event-card" data-id="${evt.id}">
        <div class="event-date-col">
          <div class="event-day">${day}</div>
          <div class="event-month">${month}</div>
          <div class="event-weekday">${weekday}</div>
        </div>
        <div class="event-info">
          <div class="event-title">${esc(evt.title)}</div>
          <div class="event-meta">
            <span>${time}</span>
            <span>${logoHtml}${esc(evt.parish_name || '')}</span>
            <span class="event-badge badge-${evt.event_type}">${evt.event_type}</span>
            ${sourceTag}
          </div>
        </div>
        <div class="event-actions">
          ${distStr ? `<span class="event-distance">${distStr}</span>` : ''}
          <a class="directions-link" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}" target="_blank" rel="noopener">Directions</a>
        </div>
      </div>`;
  }).join('');

  // Click handlers
  container.querySelectorAll('.event-card').forEach(card => {
    card.addEventListener('click', e => {
      if (e.target.closest('a')) return;
      const id = parseInt(card.dataset.id);
      showEventDetail(id);
    });
  });
}

// Event detail panel
function showEventDetail(id) {
  const evt = state.events.find(e => e.id === id);
  if (!evt) return;

  const panel = document.getElementById('event-detail');
  const content = document.getElementById('detail-content');

  const start = new Date(evt.start_utc);
  const dateFmt = new Intl.DateTimeFormat('en-AU', {
    timeZone: TZ, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  }).format(start);
  const timeFmt = new Intl.DateTimeFormat('en-AU', {
    timeZone: TZ, hour: 'numeric', minute: '2-digit'
  }).format(start);

  let endStr = '';
  if (evt.end_utc) {
    const end = new Date(evt.end_utc);
    endStr = ` — ${new Intl.DateTimeFormat('en-AU', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(end)}`;
  }

  const addr = evt.location_override || evt.parish_address || '';
  const lat = evt.lat || 0;
  const lng = evt.lng || 0;

  const parishLogo = evt.parish_logo ? `<img src="${esc(evt.parish_logo)}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;margin-right:0.5rem;vertical-align:middle;">` : '';
  const websiteCta = evt.parish_website ? `<a class="btn btn-outline" href="${esc(evt.parish_website)}" target="_blank" rel="noopener">Visit Parish</a>` : '';

  content.innerHTML = `
    <h2 class="detail-title">${esc(evt.title)}</h2>
    <div class="detail-meta">
      <div>${dateFmt}</div>
      <div>${timeFmt}${endStr}</div>
      <div>${parishLogo}${esc(evt.parish_name || '')}</div>
      ${addr ? `<div>${esc(addr)}</div>` : ''}
      <div><span class="event-badge badge-${evt.event_type}">${evt.event_type}</span></div>
      ${evt.distance_km != null ? `<div>${evt.distance_km} km away</div>` : ''}
    </div>
    ${evt.description ? `<div class="detail-description">${esc(evt.description)}</div>` : ''}
    <div class="detail-actions">
      <a class="btn btn-primary" href="https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}" target="_blank" rel="noopener">Get Directions</a>
      ${websiteCta}
    </div>`;

  panel.classList.remove('hidden');
}

document.getElementById('close-detail').addEventListener('click', () => {
  document.getElementById('event-detail').classList.add('hidden');
});

// User area
function renderUserArea() {
  const area = document.getElementById('user-area');
  if (state.user) {
    area.innerHTML = `${esc(state.user.name || state.user.email)} <a href="#" id="logout-link">Logout</a>`;
    document.getElementById('logout-link').addEventListener('click', async e => {
      e.preventDefault();
      await fetch('/auth/logout', { method: 'POST' });
      state.user = null;
      renderUserArea();
    });
  } else {
    area.innerHTML = '<a href="/auth/login">Sign in</a>';
  }
}

// View toggling
document.getElementById('btn-list').addEventListener('click', () => switchView('list'));
document.getElementById('btn-map').addEventListener('click', () => switchView('map'));

function switchView(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`${view}-view`).classList.add('active');
  document.querySelector(`[data-view="${view}"]`).classList.add('active');

  if (view === 'map') {
    initMap(state);
    updateMap(state);
  }
}

// Escape HTML
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// Expose for filters/map
window.agoraState = state;
window.agoraFetchEvents = fetchEvents;
