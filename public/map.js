let map = null;
let markers = [];

function initMap(state) {
  if (map) return;

  map = L.map('map').setView([state.userLat, state.userLng], 11);

  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 18
  }).addTo(map);

  // User location marker
  L.circleMarker([state.userLat, state.userLng], {
    radius: 8,
    fillColor: '#4285f4',
    fillOpacity: 0.9,
    color: 'white',
    weight: 2
  }).addTo(map).bindPopup('You are here');

  // Fix map size after tab switch
  setTimeout(() => map.invalidateSize(), 100);
}

function updateMap(state) {
  if (!map) return;

  // Clear existing markers
  markers.forEach(m => map.removeLayer(m));
  markers = [];

  // Group events by parish
  const byParish = {};
  for (const evt of state.events) {
    const key = evt.parish_id;
    if (!byParish[key]) byParish[key] = { lat: evt.lat, lng: evt.lng, parish: evt.parish_name, events: [] };
    byParish[key].events.push(evt);
  }

  const TZ = 'Australia/Sydney';

  for (const [, data] of Object.entries(byParish)) {
    if (!data.lat || !data.lng) continue;

    const icon = L.divIcon({
      className: 'parish-marker',
      html: `<div style="background: #8b1a1a; color: white; border-radius: 50%; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; border: 2px solid white; box-shadow: 0 2px 6px rgba(0,0,0,0.3);">${data.events.length}</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });

    const evtList = data.events.slice(0, 5).map(e => {
      const t = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(e.start_utc));
      return `<li><strong>${escMap(e.title)}</strong><br>${t}</li>`;
    }).join('');

    const popup = `
      <div style="max-width: 220px;">
        <strong>${escMap(data.parish)}</strong>
        <ul style="margin: 0.5em 0; padding-left: 1.2em; font-size: 0.85em;">${evtList}</ul>
        <a href="https://www.google.com/maps/dir/?api=1&destination=${data.lat},${data.lng}" target="_blank" rel="noopener" style="font-size: 0.8em;">Get directions</a>
      </div>`;

    const marker = L.marker([data.lat, data.lng], { icon }).bindPopup(popup).addTo(map);
    markers.push(marker);
  }
}

function escMap(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
