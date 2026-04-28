// Skip Leaflet's post-pinch settle animation. Default Leaflet runs a
// ~250ms CSS scale tween after fingers lift to "land" at the target zoom.
// During that window map._animatingZoom = true and TouchZoom._onTouchStart
// rejects new pinches (and Drag stalls). With zoomSnap: 0 our live pinch
// zoom already IS the target — the settle is purely cosmetic and costs
// us a quarter-second input lockout per pinch. Programmatic animations
// (flyTo for cluster expand, fitBounds for reframe) keep their easing
// via _tryAnimatedZoom, which is independent of this handler.
//
// We then have to force-fire zoomend. _resetView only fires zoomend when
// its zoomChanged check is true, but per-frame _move calls during pinch
// already advance map._zoom to the final value, so zoomChanged is false
// at touchend → no zoomend → maplibre-gl-leaflet shim's _zooming flag
// stays true → shim._update returns early → basemap canvas stops
// repositioning past the first gesture (partial-grey tiles, desynced
// markers). shim._zoomEnd is idempotent so a duplicate fire is harmless
// in the rare case where _resetView's zoomend already fired.
// Apple Maps web pattern: pan engages after a small travel threshold
// (no time fallback — even a 2-second slow drag works), then the
// gesture begins from the threshold point with NO snap.
//
// Leaflet 1.9.4 _onMove does NOT anchor: once threshold passes, it
// applies the full accumulated offset to _newPos on that same frame,
// jumping the pane by clickTolerance+ pixels. That jump is the snap.
//
// Patch: re-anchor _startPoint to current finger position on the first
// triggering move and skip _updatePosition for that frame. Subsequent
// moves compute offset from the new anchor, so motion is incremental
// from where the threshold crossed — Apple-style. clickTolerance kept
// at the default 3px (the threshold the user wants to feel).
if (L.Draggable && !L.Draggable.prototype._agoraAnchored) {
  L.Draggable.prototype._agoraAnchored = true;
  L.Draggable.prototype._onMove = function (e) {
    if (!this._enabled) return;
    if (e.touches && e.touches.length > 1) {
      this._moved = true;
      return;
    }
    const first = (e.touches && e.touches.length === 1 ? e.touches[0] : e);
    const offset = new L.Point(first.clientX, first.clientY)._subtract(this._startPoint);
    if (!offset.x && !offset.y) return;
    if (Math.abs(offset.x) + Math.abs(offset.y) < this.options.clickTolerance) return;

    L.DomEvent.preventDefault(e);

    if (!this._moved) {
      this.fire('dragstart');
      this._moved = true;
      L.DomUtil.addClass(document.body, 'leaflet-dragging');
      this._lastTarget = e.target || e.srcElement;
      if (window.SVGElementInstance && this._lastTarget instanceof window.SVGElementInstance) {
        this._lastTarget = this._lastTarget.correspondingUseElement;
      }
      L.DomUtil.addClass(this._lastTarget, 'leaflet-drag-target');
      this._startPoint = new L.Point(first.clientX, first.clientY);
      return;
    }

    offset.x /= this._parentScale.x;
    offset.y /= this._parentScale.y;
    this._newPos = this._startPos.add(offset);
    this._moving = true;
    this._lastEvent = e;
    this._updatePosition();
  };
}

// Hook shim's _update directly to map 'move' events instead of through
// the default L.Util.throttle wrapper. The throttle uses setTimeout to
// gate calls, which fires async after the current RAF — so the marker
// pane (riding mapPane CSS-translate in lockstep with Draggable's RAF)
// updates one frame ahead of the basemap canvas (whose container
// transform is set asynchronously). Visible result: markers drift
// slightly relative to the basemap during fast pan. Synchronous _update
// runs in the same move event as mapPane translate, so both
// transforms commit in the same frame before paint.
if (L.MaplibreGL && !L.MaplibreGL.prototype._agoraSyncMove) {
  L.MaplibreGL.prototype._agoraSyncMove = true;
  const origGetEvents = L.MaplibreGL.prototype.getEvents;
  L.MaplibreGL.prototype.getEvents = function () {
    const events = origGetEvents.call(this);
    events.move = this._update;
    return events;
  };
}

if (L.Map.TouchZoom && !L.Map.TouchZoom.prototype._agoraNoSettle) {
  L.Map.TouchZoom.prototype._agoraNoSettle = true;
  L.Map.TouchZoom.prototype._onTouchEnd = function () {
    if (!this._moved || !this._zooming) {
      this._zooming = false;
      return;
    }
    this._zooming = false;
    L.Util.cancelAnimFrame(this._animRequest);
    L.DomEvent.off(document, 'touchmove', this._onTouchMove, this);
    L.DomEvent.off(document, 'touchend touchcancel', this._onTouchEnd, this);
    const map = this._map;
    map._resetView(this._center, map._limitZoom(this._zoom));
    map.fire('zoomend');
  };
}

let map = null;
// markers = flat union of dotPool / labelPool / clusterPool entries currently
// on the map. Kept up to date by addLabeledMarkers so reframeMap can iterate.
let markers = [];
// Persistent pools keyed by parish_id (dots/labels) or member-set string
// (clusters). Avoids destroy/recreate of ~50 marker DOM nodes on every
// updateMap call — that was a 50-150ms main-thread block during gestures
// (see the gesture-recovery lag investigation 2026-04-27).
const dotPool = new Map();      // parish_id -> { marker, key, onMap }
const labelPool = new Map();    // parish_id -> { marker, key, onMap }
const clusterPool = new Map();  // sorted-member-ids string -> { marker, key, onMap }
let userMarker = null;

function initMap(state) {
  if (map) return;

  // tap: false — disables Leaflet's tap polyfill (was for very old iOS Safari
  // bugs, not needed on modern browsers). With it on, Leaflet imposes a 15px
  // tapTolerance: no panning until the finger crosses 15px, then the map
  // "catches up" instantly. That catch-up is the snap users feel at gesture
  // start. With tap: false, browser-native touchmove drives panning from
  // pixel 1 — no threshold, no snap.
  map = L.map('map', {
    zoomControl: false,
    zoomSnap: 0,
    tap: false
  }).setView([state.userLat, state.userLng], 11);
  window.agoraMap = map;

  // Vector basemap via self-hosted Protomaps pmtiles + MapLibre GL.
  // Leaflet stays as the marker host; MapLibre is mounted as a layer
  // underneath via the maplibre-gl-leaflet shim. Pixel-coord helpers
  // (containerPointToLatLng, latLngToContainerPoint) keep working
  // because they're Leaflet-driven.
  if (!window.__pmtilesRegistered) {
    const proto = new pmtiles.Protocol();
    maplibregl.addProtocol('pmtiles', proto.tile);
    window.__pmtilesRegistered = true;
  }
  const style = {
    version: 8,
    glyphs: '/glyphs/{fontstack}/{range}.pbf',
    sprite: window.location.origin + '/sprites/protomaps',
    sources: {
      protomaps: {
        type: 'vector',
        url: 'pmtiles:///tiles/oceania.pmtiles',
        attribution: '<a href="https://protomaps.com">Protomaps</a> &copy; <a href="https://openstreetmap.org">OSM</a>'
      }
    },
    layers: protomaps_themes_base.default('protomaps', 'light')
  };
  // White translucent fade rendered inside the MapLibre canvas as a final
  // background layer. Painted last so it mutes every basemap layer below;
  // Leaflet markers/labels live in DOM above the canvas and stay sharp.
  style.layers.push({
    id: 'fade-overlay',
    type: 'background',
    paint: { 'background-color': '#ffffff', 'background-opacity': 0.35 }
  });
  L.maplibreGL({ style, attributionControl: false }).addTo(map);

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

  // Viewport hooks — split into two debounced phases so a slow events-list
  // rerender can't block the next gesture:
  //   • mapPhase  (200ms) — viewport ids + markers + in-view chip + pills
  //   • listPhase (800ms) — events/services list innerHTML rebuild
  // Both cancel on movestart so a follow-up gesture preempts the prior
  // gesture's pending work. The list debounce sits long enough that a quick
  // gesture-end → gesture-begin never lets the heavy list rerender start.
  let mapPhase = null, listPhase = null;
  map.on('movestart', () => {
    clearTimeout(mapPhase);
    clearTimeout(listPhase);
  });
  map.on('moveend', () => {
    clearTimeout(mapPhase);
    clearTimeout(listPhase);
    mapPhase = setTimeout(() => {
      if (window.agoraOnViewportMapPhase) window.agoraOnViewportMapPhase();
    }, 200);
    listPhase = setTimeout(() => {
      if (window.agoraOnViewportListPhase) window.agoraOnViewportListPhase();
    }, 800);
  });

  // Live mid-pan re-cluster — clusters detach as the user zooms even before
  // moveend. Throttled to 2Hz so cluster math doesn't run every frame.
  let moveThrottle = null;
  map.on('move', () => {
    if (moveThrottle) return;
    moveThrottle = setTimeout(() => {
      moveThrottle = null;
      if (window.agoraStateRef && typeof updateMap === 'function') updateMap(window.agoraStateRef);
    }, 500);
  });

  // Seed the first viewport after the map settles.
  setTimeout(() => {
    if (window.agoraOnViewportMapPhase) window.agoraOnViewportMapPhase();
    if (window.agoraOnViewportListPhase) window.agoraOnViewportListPhase();
  }, 150);
}

function updateMap(state, opts = {}) {
  if (!map) return;

  // Markers are pool-managed. addLabeledMarkers diffs against the current
  // pools, reuses existing L.marker instances (setLatLng + conditional
  // setIcon), and removes only the parishes/clusters no longer needed.
  // Avoids the destroy/recreate cost that was blocking gesture recovery.

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

  // In selection mode, render every currently-selected parish with the
  // bigger "focus" label so the user gets visual feedback as they tap.
  const selectedIds = (state.selectionMode && state.filters.parishIds)
    ? new Set(state.filters.parishIds) : null;
  addLabeledMarkers(locations, TZ, focusId, selectedIds);

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

// Unified click handler — read parish_id from the marker so reused markers
// don't capture a stale loc closure across updateMap calls. Selection mode
// toggles parish in the picker; otherwise opens the parish sheet.
function onMarkerClick(e) {
  const id = e.target._parishId;
  if (!id) return;
  const st = window.agoraStateRef;
  if (st?.selectionMode) {
    const cur = st.filters.parishIds ? new Set(st.filters.parishIds) : new Set();
    if (cur.has(id)) cur.delete(id); else cur.add(id);
    st.filters.parishIds = cur.size ? cur : null;
    if (typeof renderParishPills === 'function') renderParishPills();
    if (typeof updateMap === 'function') updateMap(st);
    if (typeof window.agoraSyncURL === 'function') window.agoraSyncURL();
    return;
  }
  if (window.openParishSheet) window.openParishSheet(id);
}

function onClusterClick(e) {
  const cluster = e.target;
  const cur = map.getZoom();
  map.flyTo(cluster.getLatLng(), Math.min(cur + 2, 16), { duration: 0.55 });
}

function rebuildMarkersArray() {
  markers = [];
  for (const e of dotPool.values()) if (e.onMap) markers.push(e.marker);
  for (const e of labelPool.values()) if (e.onMap) markers.push(e.marker);
  for (const e of clusterPool.values()) if (e.onMap) markers.push(e.marker);
}

function cullPool(pool, keepKeys) {
  for (const [id, entry] of pool) {
    if (!keepKeys.has(id) && entry.onMap) {
      map.removeLayer(entry.marker);
      entry.onMap = false;
    }
  }
}

function addLabeledMarkers(locations, TZ, focusId, selectedIds) {
  if (!locations.length) {
    cullPool(dotPool, new Set());
    cullPool(labelPool, new Set());
    cullPool(clusterPool, new Set());
    rebuildMarkersArray();
    return;
  }

  const labelMeta = [];
  const hasFocus = !!focusId;
  const isSel = id => !!(selectedIds && selectedIds.has(id));

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

  const keepDotIds = new Set();
  for (const loc of sortedLocs) {
    if (clusteredIds.has(loc.id)) continue; // rendered as a grape cluster below
    const isFocus = loc.id === focusId;
    const isSelected = isSel(loc.id);
    // Selected parishes get the same emphasis as focus (bigger dot, bigger
    // label) but without the logo swap — that's reserved for the parish
    // sheet's single-focus case.
    const emphasised = isFocus || isSelected;
    const opacity = 1.0;

    const focusLogo = isFocus && loc.logo;
    const size = focusLogo ? 32 : (emphasised ? 16 : (loc.active ? 10 : 8));
    const hitSize = emphasised ? 44 : (loc.active ? 36 : 24);
    const borderWidth = emphasised ? 2.5 : 1.5;
    const innerHtml = focusLogo
      ? `<img src="${loc.logo}" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;border:${borderWidth}px solid white;box-sizing:border-box;opacity:${opacity};box-shadow:0 2px 10px rgba(0,0,0,0.25);">`
      : `<div style="width:${size}px;height:${size}px;border-radius:50%;background:${loc.color};border:${borderWidth}px solid white;box-sizing:border-box;opacity:${opacity};box-shadow:${emphasised ? '0 2px 10px rgba(0,0,0,0.25)' : 'none'};"></div>`;
    const html = `<div style="width:${hitSize}px;height:${hitSize}px;display:flex;align-items:center;justify-content:center;">${innerHtml}</div>`;
    const zIdx = isFocus ? 2000 : (isSelected ? 1500 : (loc.active ? 1000 : 0));
    // Style key — anything that changes icon HTML or zIndex. setIcon (which
    // innerHTMLs the icon node) only fires on key change; setLatLng (cheap
    // CSS transform update) always fires.
    const key = `${size}|${hitSize}|${borderWidth}|${loc.color}|${focusLogo ? loc.logo : ''}|${zIdx}`;

    let entry = dotPool.get(loc.id);
    if (!entry) {
      const dot = L.marker([loc.lat, loc.lng], {
        icon: L.divIcon({ className: '', html, iconSize: [hitSize, hitSize], iconAnchor: [hitSize / 2, hitSize / 2] }),
        interactive: true,
        bubblingMouseEvents: false,
        zIndexOffset: zIdx
      });
      dot._parishId = loc.id;
      dot.on('click', onMarkerClick);
      entry = { marker: dot, key, onMap: false };
      dotPool.set(loc.id, entry);
    } else {
      entry.marker._parishId = loc.id;
      if (entry.key !== key) {
        entry.marker.setIcon(L.divIcon({ className: '', html, iconSize: [hitSize, hitSize], iconAnchor: [hitSize / 2, hitSize / 2] }));
        entry.marker.setZIndexOffset(zIdx);
        entry.key = key;
      }
    }
    entry.marker.setLatLng([loc.lat, loc.lng]);
    if (!entry.onMap) {
      entry.marker.addTo(map);
      entry.onMap = true;
    }
    keepDotIds.add(loc.id);

    const parts = loc.name.split(',');
    const line1 = parts[0].trim();
    const line2 = parts.length > 1 ? parts[1].trim() : '';

    labelMeta.push({ loc, line1, line2, opacity, dotMarker: entry.marker, isFocus, isSelected, dotSize: size });
  }

  // Render one grape-bunch marker per multi-member cluster at the pixel
  // centroid (converted back to latLng). Any member being active makes the
  // whole bunch full-opacity. Tap → zoom in toward the cluster so members
  // detach once they exceed the 1.3×diameter threshold at the new zoom.
  // Pool keyed by sorted member id set — a cluster with the same members at
  // the same zoom reuses its marker (just setLatLng for centroid drift).
  const keepClusterKeys = new Set();
  const BOX = 40;
  for (const members of clusterGroups) {
    let sx = 0, sy = 0;
    for (const m of members) { const p = pxPos.get(m.id); sx += p.x; sy += p.y; }
    const cx = sx / members.length, cy = sy / members.length;
    const ll = map.containerPointToLatLng([cx, cy]);
    const anyActive = members.some(m => m.active);
    const setKey = members.map(m => m.id).sort().join(',');
    const styleKey = `${members.length}|${anyActive ? 1 : 0}`;

    let entry = clusterPool.get(setKey);
    if (!entry) {
      const html = buildGrapeClusterHtml(members.length, 1.0);
      const cluster = L.marker(ll, {
        icon: L.divIcon({ className: '', html, iconSize: [BOX, BOX], iconAnchor: [BOX / 2, BOX / 2] }),
        interactive: true,
        bubblingMouseEvents: false,
        zIndexOffset: anyActive ? 1100 : 50
      });
      cluster.on('click', onClusterClick);
      entry = { marker: cluster, key: styleKey, onMap: false };
      clusterPool.set(setKey, entry);
    } else if (entry.key !== styleKey) {
      const html = buildGrapeClusterHtml(members.length, 1.0);
      entry.marker.setIcon(L.divIcon({ className: '', html, iconSize: [BOX, BOX], iconAnchor: [BOX / 2, BOX / 2] }));
      entry.marker.setZIndexOffset(anyActive ? 1100 : 50);
      entry.key = styleKey;
    }
    entry.marker.setLatLng(ll);
    if (!entry.onMap) {
      entry.marker.addTo(map);
      entry.onMap = true;
    }
    keepClusterKeys.add(setKey);
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

  const keepLabelIds = new Set();
  for (const lm of labelMeta) {
    if (!lm.renderLabel) continue;
    const line2Html = lm.line2 ? `<div class="map-label-sub">${escMap(lm.line2)}</div>` : '';

    let html, iconSize, iconAnchor, zIdx, styleKey;
    if (lm.isFocus) {
      const FOCUS_W = 220;
      const FOCUS_H = 60;
      const anchorY = FOCUS_H + lm.dotSize / 2 + 6;
      html = `<div class="map-label map-label-focus" style="color:${lm.loc.color};">${escMap(lm.line1)}${line2Html}</div>`;
      iconSize = [FOCUS_W, FOCUS_H];
      iconAnchor = [FOCUS_W / 2, anchorY];
      zIdx = 2001;
      styleKey = `focus|${lm.line1}|${lm.line2}|${lm.loc.color}|${anchorY}`;
    } else {
      const align = lm.side === 'right' ? 'text-align:left;' : 'text-align:right;';
      const cls = lm.isSelected ? 'map-label map-label-selected' : 'map-label';
      const labelH = lm.isSelected ? 44 : 30;
      const anchorX = lm.side === 'right' ? -8 : LABEL_W + 8;
      html = `<div class="${cls}" style="color:${lm.loc.color};opacity:${lm.opacity};${align}">${escMap(lm.line1)}${line2Html}</div>`;
      iconSize = [LABEL_W, labelH];
      iconAnchor = [anchorX, labelH / 2];
      zIdx = lm.isSelected ? 1500 : (lm.loc.active ? 1000 : 0);
      styleKey = `std|${lm.line1}|${lm.line2}|${lm.loc.color}|${lm.opacity}|${cls}|${labelH}|${anchorX}|${zIdx}`;
    }

    let entry = labelPool.get(lm.loc.id);
    if (!entry) {
      const label = L.marker([lm.loc.lat, lm.loc.lng], {
        icon: L.divIcon({ className: '', html, iconSize, iconAnchor }),
        interactive: true,
        bubblingMouseEvents: false,
        zIndexOffset: zIdx
      });
      label._parishId = lm.loc.id;
      label.on('click', onMarkerClick);
      entry = { marker: label, key: styleKey, onMap: false };
      labelPool.set(lm.loc.id, entry);
    } else {
      entry.marker._parishId = lm.loc.id;
      if (entry.key !== styleKey) {
        entry.marker.setIcon(L.divIcon({ className: '', html, iconSize, iconAnchor }));
        entry.marker.setZIndexOffset(zIdx);
        entry.key = styleKey;
      }
    }
    entry.marker.setLatLng([lm.loc.lat, lm.loc.lng]);
    if (!entry.onMap) {
      entry.marker.addTo(map);
      entry.onMap = true;
    }
    keepLabelIds.add(lm.loc.id);
  }

  // Cull pool entries no longer in target sets — these are parishes/clusters
  // that filtered out, clustered/declustered, or moved out of view.
  cullPool(dotPool, keepDotIds);
  cullPool(labelPool, keepLabelIds);
  cullPool(clusterPool, keepClusterKeys);
  rebuildMarkersArray();
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
