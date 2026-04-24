let map = null;
let markers = [];
let userMarker = null;

function initMap(state) {
  if (map) return;

  map = L.map('map', { zoomControl: false, zoomSnap: 0 }).setView([state.userLat, state.userLng], 11);
  window.agoraMap = map;

  L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
    attribution: '&copy; OpenStreetMap &copy; CARTO',
    maxZoom: 18
  }).addTo(map);

  userMarker = L.marker([state.userLat, state.userLng], {
    icon: L.divIcon({
      className: '',
      html: '<div style="width:12px;height:12px;border-radius:50%;background:#4285f4;border:2px solid white;box-sizing:border-box;"></div>',
      iconSize: [12, 12],
      iconAnchor: [6, 6]
    })
  }).addTo(map).bindPopup('You are here');
  window.agoraUpdateUserLocation = (lat, lng) => {
    if (userMarker) userMarker.setLatLng([lat, lng]);
  };

  L.control.zoom({ position: 'bottomright' }).addTo(map);
  setTimeout(() => map.invalidateSize(), 100);

  // Tap blank map area clears any active parish focus.
  map.on('click', () => {
    if (window.agoraClearParishFocus) window.agoraClearParishFocus();
  });

  // Debounced viewport hook — narrows the event list to parishes whose pin
  // is inside the current bounds. 150ms trailing debounce keeps panning smooth.
  let viewportDebounce = null;
  map.on('moveend', () => {
    clearTimeout(viewportDebounce);
    viewportDebounce = setTimeout(() => {
      if (window.agoraOnViewportChange) window.agoraOnViewportChange();
    }, 150);
  });
  // Seed the first viewport after the map settles.
  setTimeout(() => { if (window.agoraOnViewportChange) window.agoraOnViewportChange(); }, 150);

  // Live re-cluster during pan/zoom — clustering is based on pixel distance,
  // so as the user pans/zooms the cluster membership changes. Throttled to
  // 2Hz (500ms) so cluster math doesn't run every frame. Only updateMap runs
  // here; event list + pill sort stay frozen until 'moveend' fires.
  let moveThrottle = null;
  map.on('move', () => {
    if (moveThrottle) return;
    moveThrottle = setTimeout(() => {
      moveThrottle = null;
      if (window.agoraStateRef && typeof updateMap === 'function') updateMap(window.agoraStateRef);
    }, 500);
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

  // Filters that cut visibility entirely (no fading): jurisdiction always
  // hard-filters. Social/English hard-filter parishes with zero matching
  // events — a parish whose events don't pass the filter is hidden, not dimmed.
  const hardFilterOnEvents = state.filters.socialOnly || state.filters.englishOnly;
  const allParishes = state.parishes.filter(p => {
    if (p.id === '_unassigned') return false;
    if (state.filters.jurisdiction && p.jurisdiction !== state.filters.jurisdiction) return false;
    if (hardFilterOnEvents && !activeParishIds.has(p.id)) return false;
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

  // ── Grape clustering ──────────────────────────────────────────
  // Cluster dots whose screen-pixel centres sit within 1.3 × dot diameter
  // of each other (single-linkage union-find). The focused parish is never
  // clustered. Re-runs on every moveend so dots detach as the user zooms.
  const DOT_DIAMETER = 10;
  const CLUSTER_K = 1.3;
  const THRESH2 = (DOT_DIAMETER * CLUSTER_K * 2) ** 2; // squared pixel distance
  const pxPos = new Map();
  for (const loc of sortedLocs) {
    if (loc.id === focusId) continue;
    const pt = map.latLngToContainerPoint([loc.lat, loc.lng]);
    pxPos.set(loc.id, { x: pt.x, y: pt.y });
  }
  const parent = new Map();
  sortedLocs.forEach(l => parent.set(l.id, l.id));
  const find = id => {
    let p = id;
    while (parent.get(p) !== p) p = parent.get(p);
    let q = id;
    while (parent.get(q) !== p) { const nx = parent.get(q); parent.set(q, p); q = nx; }
    return p;
  };
  const clusterable = sortedLocs.filter(l => l.id !== focusId);
  for (let i = 0; i < clusterable.length; i++) {
    const a = clusterable[i], pa = pxPos.get(a.id);
    if (!pa) continue;
    for (let j = i + 1; j < clusterable.length; j++) {
      const b = clusterable[j], pb = pxPos.get(b.id);
      if (!pb) continue;
      const dx = pa.x - pb.x, dy = pa.y - pb.y;
      if (dx * dx + dy * dy < THRESH2) {
        const ra = find(a.id), rb = find(b.id);
        if (ra !== rb) parent.set(ra, rb);
      }
    }
  }
  const clusterMembers = new Map();
  for (const l of clusterable) {
    const root = find(l.id);
    if (!clusterMembers.has(root)) clusterMembers.set(root, []);
    clusterMembers.get(root).push(l);
  }
  const clusteredIds = new Set();
  const clusterGroups = [];
  for (const members of clusterMembers.values()) {
    if (members.length > 1) {
      members.forEach(m => clusteredIds.add(m.id));
      clusterGroups.push(members);
    }
  }

  for (const loc of sortedLocs) {
    if (clusteredIds.has(loc.id)) continue; // rendered as a grape cluster below
    const isFocus = loc.id === focusId;
    // All parishes full opacity — filters cut visibility completely, no fading.
    const opacity = 1.0;

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

  // Render one grape-bunch marker per multi-member cluster at the pixel
  // centroid (converted back to latLng). Any member being active makes the
  // whole bunch full-opacity. Tap → zoom in toward the cluster so members
  // detach once they exceed the 1.3×diameter threshold at the new zoom.
  for (const members of clusterGroups) {
    let sx = 0, sy = 0;
    for (const m of members) { const p = pxPos.get(m.id); sx += p.x; sy += p.y; }
    const cx = sx / members.length, cy = sy / members.length;
    const ll = map.containerPointToLatLng([cx, cy]);
    const anyActive = members.some(m => m.active);
    const html = buildGrapeClusterHtml(members.length, 1.0);
    const BOX = 40;
    const cluster = L.marker(ll, {
      icon: L.divIcon({
        className: '',
        html,
        iconSize: [BOX, BOX],
        iconAnchor: [BOX / 2, BOX / 2]
      }),
      interactive: true,
      bubblingMouseEvents: false,
      zIndexOffset: anyActive ? 1100 : 50
    });
    cluster.on('click', () => {
      const cur = map.getZoom();
      map.flyTo(ll, Math.min(cur + 2, 16), { duration: 0.55 });
    });
    cluster.addTo(map);
    markers.push(cluster);
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

  // Cap text labels to 15 most-central parishes — dots still render for all,
  // but rasterising 40+ divIcon labels lags older iOS devices on pan/zoom.
  // Focused parish always labels regardless of cap.
  const LABEL_CAP = 15;
  const mapSize = map.getSize();
  const cx = mapSize.x / 2, cy = mapSize.y / 2;
  const nonFocus = labelMeta.filter(lm => !lm.isFocus);
  nonFocus.sort((a, b) => {
    const da = (a.px - cx) ** 2 + (a.py - cy) ** 2;
    const db = (b.px - cx) ** 2 + (b.py - cy) ** 2;
    return da - db;
  });
  const keep = new Set(nonFocus.slice(0, LABEL_CAP).map(lm => lm.loc.id));
  for (const lm of labelMeta) lm.renderLabel = lm.isFocus || keep.has(lm.loc.id);

  // Focused label first (it paints wherever it wants), then active, then rest.
  labelMeta.sort((a, b) => {
    if (a.isFocus) return -1;
    if (b.isFocus) return 1;
    return (b.loc.active ? 1 : 0) - (a.loc.active ? 1 : 0);
  });

  for (const lm of labelMeta) {
    if (lm.isFocus) continue; // focused label floats free above the dot
    if (!lm.renderLabel) continue;
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
    if (!lm.renderLabel) continue;
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

// Compact grape-bunch divIcon for a clustered set of parishes. One grape
// per member up to 7; overflow collapses into a "+N" badge on the last
// visible grape. Layout is a tapered bunch pointing downward with a short
// stem at the top.
function buildGrapeClusterHtml(count, opacity) {
  const GRAPE = '#6a2d5c'; // muscat purple
  const GRAPE_HI = '#8a4a7a';
  const r = 5;
  // Tight, heavily overlapping layouts — centre spacing ~0.7r–1.4r so every
  // grape overlaps at least one neighbour. Box is 40×40, visual centre (20,20).
  // Group is rotated -30° at render so the bunch tilts counter-clockwise.
  const n = Math.min(count, 7);
  const layouts = {
    2: [[-r * 0.55, 0], [r * 0.55, 0]],
    3: [[-r * 0.75, -r * 0.45], [r * 0.75, -r * 0.45], [0, r * 0.6]],
    4: [[-r * 0.6, -r * 0.55], [r * 0.6, -r * 0.55], [-r * 0.45, r * 0.55], [r * 0.45, r * 0.55]],
    5: [[-r * 1.15, -r * 0.45], [0, -r * 0.7], [r * 1.15, -r * 0.45], [-r * 0.55, r * 0.6], [r * 0.55, r * 0.6]],
    6: [[-r * 1.05, -r * 0.5], [0, -r * 0.75], [r * 1.05, -r * 0.5], [-r * 0.5, r * 0.45], [r * 0.5, r * 0.45], [0, r * 1.25]],
    7: [[-r * 1.3, -r * 0.65], [0, -r * 0.85], [r * 1.3, -r * 0.65], [-r * 0.7, r * 0.15], [r * 0.7, r * 0.15], [-r * 0.35, r * 1.0], [r * 0.35, r * 1.0]]
  };
  const pts = layouts[n];
  const cx0 = 20, cy0 = 20;
  let grapes = '';
  for (const [ox, oy] of pts) {
    const x = cx0 + ox, y = cy0 + oy;
    grapes += `<circle cx="${x}" cy="${y}" r="${r}" fill="${GRAPE}" stroke="white" stroke-width="1.1"/>`;
    grapes += `<circle cx="${x - 1.5}" cy="${y - 1.5}" r="1.3" fill="${GRAPE_HI}" opacity="0.85"/>`;
  }
  const overflow = count > 7
    ? `<text x="20" y="36" text-anchor="middle" font-size="9" font-weight="700" fill="#fff" style="paint-order:stroke;stroke:${GRAPE};stroke-width:2.5;">+${count - 7}</text>`
    : '';
  return `<div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;opacity:${opacity};filter:drop-shadow(0 2px 3px rgba(0,0,0,0.18));">
    <svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
      <g transform="rotate(-30 20 20)">${grapes}</g>
      ${overflow}
    </svg>
  </div>`;
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
