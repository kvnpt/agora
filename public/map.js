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

  // Tap blank map area clears any active parish focus.
  map.on('click', () => {
    if (window.agoraClearParishFocus) window.agoraClearParishFocus();
  });
}

function updateMap(state, opts = {}) {
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

  const allParishes = state.parishes.filter(p => {
    if (p.id === '_unassigned') return false;
    if (state.filters.jurisdiction && p.jurisdiction !== state.filters.jurisdiction) return false;
    if (!p.lat || !p.lng) return false;
    return true;
  });

  // Parish filter → those parishes always active (full opacity + zoom target)
  if (state.filters.parishIds) {
    for (const pid of state.filters.parishIds) activeParishIds.add(pid);
  }

  // Event data for popups
  const eventsByParish = {};
  if (state.mode !== 'services') {
    for (const evt of state.events) {
      if (!eventsByParish[evt.parish_id]) eventsByParish[evt.parish_id] = [];
      eventsByParish[evt.parish_id].push(evt);
    }
  }

  const focusId = state.parishSheetFocus || null;

  const locations = allParishes.map(p => ({
    id: p.id,
    lat: p.lat,
    lng: p.lng,
    name: p.name,
    color: p.color || '#000',
    logo: p.logo_path || null,
    website: p.website || '',
    active: activeParishIds.has(p.id),
    events: eventsByParish[p.id] || []
  }));

  addLabeledMarkers(locations, TZ, focusId);

  // Fit only when caller opts in — otherwise markers refresh without
  // disturbing the user's current map view.
  if (opts.fit) {
    const active = locations.filter(l => l.active);
    if (active.length) {
      const bounds = L.latLngBounds(active.map(l => [l.lat, l.lng]));
      bounds.pad(0.1);
      const sheetY = typeof window.agoraSheetY === 'function' ? window.agoraSheetY() : window.innerHeight * 0.5;
      const sheetHeight = window.innerHeight - sheetY;
      const topPad = 50;
      map.fitBounds(bounds, {
        paddingTopLeft: [30, topPad],
        paddingBottomRight: [30, sheetHeight + 20],
        maxZoom: 14,
        animate: true,
        duration: 0.9
      });
    }
  }
}

function addLabeledMarkers(locations, TZ, focusId) {
  if (!locations.length) return;

  const labelMeta = [];
  const hasFocus = !!focusId;

  // Sort: inactive first so active dots/labels render above (higher z-index
   // = tap priority when hit targets overlap). Focused parish sorted last
   // so its marker + label paint on top.
  const sortedLocs = [...locations].sort((a, b) => {
    if (a.id === focusId) return 1;
    if (b.id === focusId) return -1;
    return (a.active ? 1 : 0) - (b.active ? 1 : 0);
  });

  for (const loc of sortedLocs) {
    const isFocus = loc.id === focusId;
    // Focus: full opacity, bigger. Non-focus while sheet open: strong dim.
    // No sheet open: original active/inactive logic.
    const opacity = isFocus ? 1.0 : (hasFocus ? 0.15 : (loc.active ? 1.0 : 0.25));

    const focusLogo = isFocus && loc.logo;
    const size = focusLogo ? 32 : (isFocus ? 16 : (loc.active ? 10 : 8));
    const hitSize = isFocus ? 44 : (loc.active ? 36 : 24);
    const borderWidth = isFocus ? 2.5 : 1.5;
    const innerHtml = focusLogo
      ? `<img src="${loc.logo}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;border:${borderWidth}px solid white;box-sizing:border-box;opacity:${opacity};box-shadow:0 2px 10px rgba(0,0,0,0.25);">`
      : `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${loc.color};border:${borderWidth}px solid white;box-sizing:border-box;opacity:${opacity};box-shadow:${isFocus ? '0 2px 10px rgba(0,0,0,0.25)' : 'none'};"></div>`;
    const dot = L.marker([loc.lat, loc.lng], {
      icon: L.divIcon({
        className: '',
        html: `<div style="width:${hitSize}px;height:${hitSize}px;display:flex;align-items:center;justify-content:center;">${innerHtml}</div>`,
        iconSize: [hitSize, hitSize],
        iconAnchor: [hitSize / 2, hitSize / 2]
      }),
      interactive: true,
      bubblingMouseEvents: false,
      zIndexOffset: isFocus ? 2000 : (loc.active ? 1000 : 0)
    });

    dot.on('click', () => {
      if (window.openParishSheet) window.openParishSheet(loc.id);
    });

    dot.addTo(map);
    markers.push(dot);

    const parts = loc.name.split(',');
    const line1 = parts[0].trim();
    const line2 = parts.length > 1 ? parts[1].trim() : '';

    labelMeta.push({ loc, line1, line2, opacity, dotMarker: dot, isFocus, dotSize: size });
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

  // Focused label first (it paints wherever it wants), then active, then rest.
  labelMeta.sort((a, b) => {
    if (a.isFocus) return -1;
    if (b.isFocus) return 1;
    return (b.loc.active ? 1 : 0) - (a.loc.active ? 1 : 0);
  });

  for (const lm of labelMeta) {
    if (lm.isFocus) continue; // focused label floats free above the dot
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
    const line2Html = lm.line2 ? `<div class="map-label-sub">${escMap(lm.line2)}</div>` : '';

    if (lm.isFocus) {
      // Centred above the (now larger) dot. Wider fixed box so longer names
      // don't clip; label sized up via .map-label-focus class.
      const FOCUS_W = 220;
      const FOCUS_H = 60;
      const labelHtml = `<div class="map-label map-label-focus" style="color:${lm.loc.color};">${escMap(lm.line1)}${line2Html}</div>`;
      const label = L.marker([lm.loc.lat, lm.loc.lng], {
        icon: L.divIcon({
          className: '',
          html: labelHtml,
          iconSize: [FOCUS_W, FOCUS_H],
          // Anchor at bottom-centre so the label sits above the dot.
          iconAnchor: [FOCUS_W / 2, FOCUS_H + lm.dotSize / 2 + 6]
        }),
        interactive: true,
        bubblingMouseEvents: false,
        zIndexOffset: 2001
      }).addTo(map);
      label.on('click', () => {
        if (window.openParishSheet) window.openParishSheet(lm.loc.id);
      });
      markers.push(label);
      continue;
    }

    const align = lm.side === 'right' ? 'text-align:left;' : 'text-align:right;';
    const labelHtml = `<div class="map-label" style="color:${lm.loc.color};opacity:${lm.opacity};${align}">${escMap(lm.line1)}${line2Html}</div>`;

    const anchorX = lm.side === 'right' ? -8 : LABEL_W + 8;
    const label = L.marker([lm.loc.lat, lm.loc.lng], {
      icon: L.divIcon({
        className: '',
        html: labelHtml,
        iconSize: [LABEL_W, 30],
        iconAnchor: [anchorX, 15]
      }),
      interactive: true,
      bubblingMouseEvents: false,
      zIndexOffset: lm.loc.active ? 1000 : 0
    }).addTo(map);
    label.on('click', () => {
      if (window.openParishSheet) window.openParishSheet(lm.loc.id);
    });
    markers.push(label);
  }
}

// Reframe map to fit current markers without rebuilding them (smooth animation)
function reframeMap() {
  if (!map) return;
  const active = markers.filter(m => m.options && m.options.zIndexOffset >= 1000);
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
    duration: 0.9
  });
}

function escMap(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
