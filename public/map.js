let map = null;
let markers = [];

function initMap(state) {
  if (map) return;

  map = L.map('map', { zoomControl: false, zoomSnap: 0 }).setView([state.userLat, state.userLng], 11);
  window.agoraMap = map;

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 18
  }).addTo(map);

  L.marker([state.userLat, state.userLng], {
    icon: L.divIcon({
      className: '',
      html: '<div style="width:12px;height:12px;border-radius:50%;background:#4285f4;border:2px solid white;box-sizing:border-box;"></div>',
      iconSize: [12, 12],
      iconAnchor: [6, 6]
    })
  }).addTo(map).bindPopup('You are here');

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  setTimeout(() => map.invalidateSize(), 100);
}

function updateMap(state) {
  if (!map) return;

  markers.forEach(m => map.removeLayer(m));
  markers = [];

  const TZ = 'Australia/Sydney';

  // Build set of active (filtered) parish IDs
  const activeParishIds = new Set();

  if (state.mode === 'services') {
    let scheds = state.schedules;
    if (state.filters.parishIds) {
      scheds = scheds.filter(s => state.filters.parishIds.has(s.parish_id));
    }
    for (const s of scheds) activeParishIds.add(s.parish_id);
  } else {
    const filtered = applyFilters(state.events);
    for (const evt of filtered) activeParishIds.add(evt.parish_id);
  }

  // "Show all" override: 'juris' reveals all parishes in current jurisdiction
  // at full opacity; 'all' reveals every parish everywhere.
  const showAll = state.filters.showAllParishes; // null | 'juris' | 'all'

  // All parishes in jurisdiction (or everywhere when showAll === 'all')
  const allParishes = state.parishes.filter(p => {
    if (p.id === '_unassigned') return false;
    if (showAll !== 'all' && state.filters.jurisdiction && p.jurisdiction !== state.filters.jurisdiction) return false;
    if (!p.lat || !p.lng) return false;
    return true;
  });

  if (showAll) {
    for (const p of allParishes) activeParishIds.add(p.id);
  }

  // Event data for popups
  const eventsByParish = {};
  if (state.mode !== 'services') {
    for (const evt of state.events) {
      if (!eventsByParish[evt.parish_id]) eventsByParish[evt.parish_id] = [];
      eventsByParish[evt.parish_id].push(evt);
    }
  }

  const locations = allParishes.map(p => ({
    id: p.id,
    lat: p.lat,
    lng: p.lng,
    name: p.name,
    color: p.color || '#000',
    website: p.website || '',
    active: activeParishIds.has(p.id),
    events: eventsByParish[p.id] || []
  }));

  addLabeledMarkers(locations, TZ);

  // Fit map so markers appear in the visible area above the bottom sheet
  const active = locations.filter(l => l.active);
  if (active.length) {
    const bounds = L.latLngBounds(active.map(l => [l.lat, l.lng]));
    bounds.pad(0.1);
    // Sheet covers from its Y position down to the bottom of the viewport
    const sheetY = typeof window.agoraSheetY === 'function' ? window.agoraSheetY() : window.innerHeight * 0.5;
    const sheetHeight = window.innerHeight - sheetY;
    // Jurisdiction banner at top (~36px)
    const topPad = 50;
    map.fitBounds(bounds, {
      paddingTopLeft: [30, topPad],
      paddingBottomRight: [30, sheetHeight + 20],
      maxZoom: 14,
      animate: true,
      duration: 0.4
    });
  }
}

function addLabeledMarkers(locations, TZ) {
  if (!locations.length) return;

  const labelMeta = [];

  for (const loc of locations) {
    const opacity = loc.active ? 1.0 : 0.25;

    const size = loc.active ? 10 : 8;
    const hitSize = loc.active ? 36 : 20;
    const dot = L.marker([loc.lat, loc.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div style="width:${hitSize}px;height:${hitSize}px;display:flex;align-items:center;justify-content:center;"><div style="width:${size}px;height:${size}px;border-radius:50%;background:${loc.color};border:1.5px solid white;box-sizing:border-box;opacity:${opacity};"></div></div>`,
        iconSize: [hitSize, hitSize],
        iconAnchor: [hitSize / 2, hitSize / 2]
      }),
      interactive: loc.active,
      bubblingMouseEvents: true
    });

    if (loc.active) {
      const dirLink = `<a href="https://www.google.com/maps/dir/?api=1&destination=${loc.lat},${loc.lng}" target="_blank" rel="noopener" style="font-size:12px;color:#000;">Directions</a>`;
      const webLink = loc.website ? ` · <a href="${escMap(loc.website)}" target="_blank" rel="noopener" style="font-size:12px;color:#000;">Website</a>` : '';
      const allBtn = `<button type="button" class="popup-all-events" onclick="window.agoraFilterParish('${loc.id.replace(/'/g, "\\'")}')">All events</button>`;
      if (loc.events.length) {
        const evtList = loc.events.slice(0, 5).map(e => {
          const t = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(e.start_utc));
          return `<li><strong>${escMap(e.title)}</strong><br>${t}</li>`;
        }).join('');
        dot.bindPopup(`<div style="max-width:200px;font-size:13px;"><strong>${escMap(loc.name)}</strong><ul style="margin:6px 0;padding-left:1.1em;">${evtList}</ul>${allBtn}<div style="margin-top:6px;">${dirLink}${webLink}</div></div>`);
      } else {
        dot.bindPopup(`<div style="max-width:200px;font-size:13px;"><strong>${escMap(loc.name)}</strong>${allBtn}<div style="margin-top:6px;">${dirLink}${webLink}</div></div>`);
      }
    }

    dot.addTo(map);
    markers.push(dot);

    const parts = loc.name.split(',');
    const line1 = parts[0].trim();
    const line2 = parts.length > 1 ? parts[1].trim() : '';

    labelMeta.push({ loc, line1, line2, opacity, dotMarker: dot });
  }

  // Label collision detection
  const sorted = [...labelMeta].sort((a, b) => a.loc.lng - b.loc.lng);
  const medianLng = sorted.length ? sorted[Math.floor(sorted.length / 2)].loc.lng : 151.2;

  for (const lm of labelMeta) {
    lm.side = lm.loc.lng <= medianLng ? 'right' : 'left';
    const pt = map.latLngToContainerPoint([lm.loc.lat, lm.loc.lng]);
    lm.px = pt.x;
    lm.py = pt.y;
  }

  const LABEL_W = 120;
  const LABEL_H = 22;
  const placed = [];

  // Active labels get priority
  labelMeta.sort((a, b) => (b.loc.active ? 1 : 0) - (a.loc.active ? 1 : 0));

  for (const lm of labelMeta) {
    const getBounds = (side) => {
      const x = side === 'right' ? lm.px + 8 : lm.px - LABEL_W - 8;
      return { x1: x, y1: lm.py - LABEL_H / 2, x2: x + LABEL_W, y2: lm.py + LABEL_H / 2 };
    };

    const overlaps = (bounds) =>
      placed.some(p => bounds.x1 < p.x2 && bounds.x2 > p.x1 && bounds.y1 < p.y2 && bounds.y2 > p.y1);

    // Try preferred side, then opposite side
    let bounds = getBounds(lm.side);
    if (overlaps(bounds)) {
      lm.side = lm.side === 'right' ? 'left' : 'right';
      bounds = getBounds(lm.side);
    }
    placed.push(bounds);
  }

  for (const lm of labelMeta) {
    const align = lm.side === 'right' ? 'text-align:left;' : 'text-align:right;';
    const line2Html = lm.line2 ? `<div class="map-label-sub">${escMap(lm.line2)}</div>` : '';
    const labelHtml = `<div class="map-label" style="color:${lm.loc.color};opacity:${lm.opacity};${align}">${escMap(lm.line1)}${line2Html}</div>`;

    const anchorX = lm.side === 'right' ? -8 : LABEL_W + 8;
    const label = L.marker([lm.loc.lat, lm.loc.lng], {
      icon: L.divIcon({
        className: '',
        html: labelHtml,
        iconSize: [LABEL_W, 30],
        iconAnchor: [anchorX, 15]
      }),
      interactive: lm.loc.active,
      bubblingMouseEvents: true
    }).addTo(map);
    if (lm.loc.active && lm.dotMarker) {
      label.on('click', () => lm.dotMarker.openPopup());
    }
    markers.push(label);
  }
}

// Reframe map to fit current markers without rebuilding them (smooth animation)
function reframeMap() {
  if (!map) return;
  const active = markers.filter(m => m.options && m.options.interactive);
  if (!active.length) return;
  const bounds = L.latLngBounds(active.map(m => m.getLatLng()));
  bounds.pad(0.1);
  const sheetY = typeof window.agoraSheetY === 'function' ? window.agoraSheetY() : window.innerHeight * 0.5;
  const sheetHeight = window.innerHeight - sheetY;
  const topPad = 50;
  map.fitBounds(bounds, {
    paddingTopLeft: [30, topPad],
    paddingBottomRight: [30, sheetHeight + 20],
    maxZoom: 14,
    animate: true,
    duration: 0.4
  });
}

function escMap(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
