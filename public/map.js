let map = null;
let markers = [];

function initMap(state) {
  if (map) return;

  map = L.map('map', { zoomControl: false }).setView([state.userLat, state.userLng], 11);
  window.agoraMap = map;

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 18
  }).addTo(map);

  // User location
  L.circleMarker([state.userLat, state.userLng], {
    radius: 6,
    fillColor: '#4285f4',
    fillOpacity: 0.9,
    color: 'white',
    weight: 2
  }).addTo(map).bindPopup('You are here');

  // Zoom control bottom-right
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  setTimeout(() => map.invalidateSize(), 100);
}

function updateMap(state) {
  if (!map) return;

  markers.forEach(m => map.removeLayer(m));
  markers = [];

  const TZ = 'Australia/Sydney';

  if (state.mode === 'services') {
    // Show parish locations from schedules
    const byParish = {};
    for (const s of state.schedules) {
      if (!byParish[s.parish_id]) {
        byParish[s.parish_id] = { lat: s.lat, lng: s.lng, name: s.parish_name, count: 0 };
      }
      byParish[s.parish_id].count++;
    }

    for (const [, data] of Object.entries(byParish)) {
      if (!data.lat || !data.lng) continue;
      const icon = L.divIcon({
        className: '',
        html: `<div style="background:#000;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.2);">${data.count}</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });
      const marker = L.marker([data.lat, data.lng], { icon })
        .bindPopup(`<strong>${escMap(data.name)}</strong>`)
        .addTo(map);
      markers.push(marker);
    }
  } else {
    // Show event locations grouped by parish
    const byParish = {};
    for (const evt of state.events) {
      if (!byParish[evt.parish_id]) {
        byParish[evt.parish_id] = { lat: evt.lat, lng: evt.lng, name: evt.parish_name, events: [] };
      }
      byParish[evt.parish_id].events.push(evt);
    }

    for (const [, data] of Object.entries(byParish)) {
      if (!data.lat || !data.lng) continue;
      const icon = L.divIcon({
        className: '',
        html: `<div style="background:#000;color:#fff;border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,0.2);">${data.events.length}</div>`,
        iconSize: [24, 24],
        iconAnchor: [12, 12]
      });

      const evtList = data.events.slice(0, 5).map(e => {
        const t = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(e.start_utc));
        return `<li><strong>${escMap(e.title)}</strong><br>${t}</li>`;
      }).join('');

      const popup = `<div style="max-width:200px;font-size:13px;"><strong>${escMap(data.name)}</strong><ul style="margin:6px 0;padding-left:1.1em;">${evtList}</ul><a href="https://www.google.com/maps/dir/?api=1&destination=${data.lat},${data.lng}" target="_blank" rel="noopener" style="font-size:12px;color:#000;">Directions</a></div>`;

      const marker = L.marker([data.lat, data.lng], { icon }).bindPopup(popup).addTo(map);
      markers.push(marker);
    }
  }
}

function escMap(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
