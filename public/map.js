// Agora map — pure MapLibre GL JS. No Leaflet, no shim.
//
// Why: marker wiggle on pinch zoom was architectural — Leaflet rendered dots as
// DOM nodes inside mapPane (CSS-scaled during pinch) while the maplibre-gl-leaflet
// shim drove a separate per-frame canvas transform. Two transform sources never
// stayed perfectly in sync. Now every marker (parish dots, labels, grape clusters,
// user-location dot) is a MapLibre layer rendered into the same WebGL canvas as
// the basemap. One coordinate system, one transform, no drift.
//
// Side benefits: WASM-driven label collision replaces the hand-rolled greedy
// median-split algorithm; native source clustering (supercluster) replaces the
// custom union-find re-cluster on every move event.

const PARISH_SOURCE = 'parishes';
const USER_SOURCE = 'user-loc';
const CLUSTER_RADIUS_PX = 38;     // tuned to match the old 1.3*diameter feel without hiding small groups
const CLUSTER_MIN_POINTS = 5;     // matches old "≥5 members render as grape"
// Parish labels always use Medium — the heaviest glyph dir we have shipped.
// Regular is reserved for the protomaps basemap (city/town/country names);
// using Medium uniformly keeps parish labels visually distinct from the
// basemap layer underneath. (No Bold glyph dir exists.)
const FONT_MEDIUM = ['Noto Sans Medium'];

// Halo color comes from CSS var --halo so dark mode flips it (white halo on
// light bg, dark halo on dark bg). Read fresh each time it's used.
function getHalo() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--halo').trim();
  return v || '#ffffff';
}
function getMapFade() {
  const css = getComputedStyle(document.documentElement);
  return {
    color: css.getPropertyValue('--map-fade').trim() || '#ffffff',
    opacity: parseFloat(css.getPropertyValue('--map-fade-opacity')) || 0.35
  };
}
function isDark() {
  return matchMedia('(prefers-color-scheme: dark)').matches;
}

// Perceptual-luminance lift in OKLab space. If the input's OKLab L is
// below FLOOR, raise it to FLOOR; otherwise pass through unchanged.
// a/b chroma axes untouched so hue and saturation are preserved.
//
// Asymmetric (lift only) instead of symmetric (full L-flip). A flip
// helps deep-purple parishes (St George Rose Bay) become bright, but
// would also drag bright-green / yellow / pink parishes into dark muddy
// versions on dark mode — wrong direction. Lifting to a floor preserves
// already-bright colours and only intervenes on the dark end.
//
// Why OKLab and not HSL: HSL "L" weighs blue/violet incorrectly, so a
// deep purple at HSL L=0.5 still reads as dim. OKLab L matches what
// the eye actually sees.
function _srgbToLinear(c) {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function _linearToSrgb(c) {
  const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}
function _rgbToOklab(r, g, b) {
  const lr = _srgbToLinear(r);
  const lg = _srgbToLinear(g);
  const lb = _srgbToLinear(b);
  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
  const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_
  ];
}
function _oklabToRgb(L, a, b) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  const lr = l_ ** 3, lm = m_ ** 3, ls = s_ ** 3;
  return [
    _linearToSrgb(+4.0767416621 * lr - 3.3077115913 * lm + 0.2309699292 * ls),
    _linearToSrgb(-1.2684380046 * lr + 2.6097574011 * lm - 0.3413193965 * ls),
    _linearToSrgb(-0.0041960863 * lr - 0.7034186147 * lm + 1.7076147010 * ls)
  ];
}
// OKLab L floor for the dark-mode lift. 0.7 = bright pastel; matches
// the perceptual luminance of a typical UI-friendly mid-pastel.
const PARISH_DARK_FLOOR = 0.7;

function liftParishColor(hex) {
  if (!hex) return '#aaaaaa';
  const m = String(hex).trim().replace(/^#/, '').match(/^([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return hex;
  let s = m[1];
  if (s.length === 3) s = s.split('').map(c => c + c).join('');
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  const [L, A, B] = _rgbToOklab(r, g, b);
  if (L >= PARISH_DARK_FLOOR) return '#' + s.toLowerCase();
  const [r2, g2, b2] = _oklabToRgb(PARISH_DARK_FLOOR, A, B);
  const toHex = v => v.toString(16).padStart(2, '0');
  return '#' + toHex(r2) + toHex(g2) + toHex(b2);
}
window.liftParishColor = liftParishColor;
// Back-compat alias — earlier rev exposed this as solarizeColor; some
// in-flight callers may still reference the old name.
window.solarizeColor = liftParishColor;

let map = null;
let styleLoaded = false;
let pendingUpdate = null;          // queued updateMap call if style not ready
let parishesById = new Map();      // populated at initMap; fast lookup for click handler
const logoRegistered = new Set();   // parish ids whose focus_<id> sprite is registered

// ── Bounds helpers (replace L.latLngBounds.pad). MapLibre fitBounds takes
// [[w,s],[e,n]]. ────────────────────────────────────────────────────────
function padBounds(bounds, pad) {
  const [[w, s], [e, n]] = bounds;
  const lngSpan = (e - w) || 0.001;
  const latSpan = (n - s) || 0.001;
  return [
    [w - lngSpan * pad, s - latSpan * pad],
    [e + lngSpan * pad, n + latSpan * pad]
  ];
}

function boundsFromPoints(pts) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of pts) {
    const lat = (typeof p === 'object' && 'lat' in p) ? p.lat : p[0];
    const lng = (typeof p === 'object' && 'lng' in p) ? p.lng : p[1];
    if (lat == null || lng == null) continue;
    if (lng < w) w = lng;
    if (lng > e) e = lng;
    if (lat < s) s = lat;
    if (lat > n) n = lat;
  }
  return [[w, s], [e, n]];
}

window.agoraPadBounds = padBounds;
window.agoraBoundsFromPoints = boundsFromPoints;

// ── Baked dark basemap ────────────────────────────────────────────────
// Generated by scripts/build-dark-basemap.js — protomaps' upstream "dark"
// theme with HSL luminance lifted (FLOOR=0.18) so land/roads/water sit
// at parity with Apple/Google Maps dark instead of collapsing to near-
// black. Pre-fetched on script load so the first initMap call hits cache
// (or its in-flight promise). Re-bake by running the script and
// committing the new public/protomaps-dark.json.
let darkLayersCache = null;
const darkLayersPromise = fetch('/protomaps-dark.json')
  .then(r => r.ok ? r.json() : null)
  .then(d => { darkLayersCache = d; return d; })
  .catch(() => null);

// ── Base style builder ────────────────────────────────────────────────
// Pulled out of initMap so the scheme-change handler can rebuild it. The
// fade overlay color + the protomaps theme variant flip together with
// prefers-color-scheme.
async function buildBaseStyle() {
  const fade = getMapFade();
  let layers;
  if (isDark()) {
    const baked = darkLayersCache || await darkLayersPromise;
    // Fall back to upstream-unmodified dark if the bake fetch failed —
    // keeps the map functional even if /protomaps-dark.json 404s.
    layers = baked
      ? baked.slice()
      : protomaps_themes_base.default('protomaps', 'dark');
  } else {
    layers = protomaps_themes_base.default('protomaps', 'light');
  }
  layers.push({
    id: 'fade-overlay',
    type: 'background',
    paint: { 'background-color': fade.color, 'background-opacity': fade.opacity }
  });
  return {
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
    layers
  };
}

// ── initMap ────────────────────────────────────────────────────────────
async function initMap(state) {
  if (map) return;

  if (!window.__pmtilesRegistered) {
    const proto = new pmtiles.Protocol();
    maplibregl.addProtocol('pmtiles', proto.tile);
    window.__pmtilesRegistered = true;
  }

  const style = await buildBaseStyle();

  map = new maplibregl.Map({
    container: 'map',
    style,
    center: [145, -20],
    zoom: 4,
    attributionControl: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    boxZoom: false,
    keyboard: false
  });
  map.touchZoomRotate.disableRotation();
  window.agoraMap = map;

  parishesById.clear();
  for (const p of state.parishes || []) parishesById.set(p.id, p);

  map.on('load', async () => {
    addParishSourceAndLayers();
    addUserLocSourceAndLayer(state);
    setupClickHandlers();
    setupViewportPhases();

    // Register sprites BEFORE any layer tries to render them — otherwise the
    // symbol layers report "image missing" and skip drawing for the first
    // render frames, which is what made cluster icons vanish at low zoom.
    await Promise.allSettled([
      registerGrapeSprites(),
      registerParishLogos(state.parishes || [])
    ]);
    map.triggerRepaint();

    styleLoaded = true;
    if (window.lsLog) window.lsLog('✓ map ready');

    // Fresh session (no cached location): fit to all parishes.
    if (!state.locationActive) {
      const pts = (state.parishes || []).filter(p => p.id !== '_unassigned' && p.lat != null && p.lng != null);
      if (pts.length) {
        const b = padBounds(boundsFromPoints(pts), 0.05);
        map.fitBounds(b, { maxZoom: 6, animate: false });
      }
    }

    // Drain pending update if any.
    if (pendingUpdate) {
      const { state: st, opts } = pendingUpdate;
      pendingUpdate = null;
      updateMap(st, opts);
    }

    // Seed first viewport phase (matches old initMap behaviour).
    setTimeout(() => {
      if (window.agoraOnViewportMapPhase) window.agoraOnViewportMapPhase();
      if (window.agoraOnViewportListPhase) window.agoraOnViewportListPhase();
    }, 150);
  });

  // Resize once after layout settles (matches old invalidateSize timing).
  setTimeout(() => map && map.resize(), 100);

  // Live scheme switch — when system flips dark/light, rebuild the basemap
  // style and re-add our custom sources/layers/sprites. setStyle({diff:false})
  // wipes everything; the style.load handler rehydrates from current state.
  if (!window.__agoraSchemeListener) {
    window.__agoraSchemeListener = true;
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', async () => {
      if (!map) return;
      styleLoaded = false;
      logoRegistered.clear();
      map.setStyle(await buildBaseStyle(), { diff: false });
      map.once('style.load', async () => {
        const st = window.agoraStateRef || { parishes: [], locationActive: false };
        addParishSourceAndLayers();
        addUserLocSourceAndLayer(st);
        setupClickHandlers();
        await Promise.allSettled([
          registerGrapeSprites(),
          registerParishLogos(st.parishes || [])
        ]);
        styleLoaded = true;
        if (typeof updateMap === 'function') updateMap(st);
        map.triggerRepaint();
      });
    });
  }
}

// ── Sources & layers ────────────────────────────────────────────────────
function addParishSourceAndLayers() {
  map.addSource(PARISH_SOURCE, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    cluster: true,
    clusterRadius: CLUSTER_RADIUS_PX,
    clusterMinPoints: CLUSTER_MIN_POINTS
  });

  // Drive focus/selected/active off feature properties (rebuilt on every
  // updateMap) rather than feature-state. ~50 features, source rebuild is
  // free, and properties are bulletproof across MapLibre versions and apply
  // uniformly to layout + paint expressions (feature-state has version-by-
  // -version quirks on symbol layers).
  // Circle layer renders for every non-cluster parish, including the focused
  // one. When focused parish has a logo, circle-radius drops to 0 and the
  // focus-icon symbol covers it; without a logo, the circle stays at 8 so
  // the focused parish is still visible. Active state has no size delta —
  // active is purely a sort-key for label priority (matches the pre-migration
  // behaviour where active dots had higher z-index but identical visuals).
  map.addLayer({
    id: 'parish-circle',
    type: 'circle',
    source: PARISH_SOURCE,
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-radius': [
        'case',
        ['all', ['==', ['get', 'focused'], true], ['has', 'focus_icon_id']], 0,
        ['==', ['get', 'focused'], true], 6,
        ['==', ['get', 'selected'], true], 6,
        3.75
      ],
      'circle-color': ['get', 'color'],
      // Same source as label halo so dot rings and label outlines flip
      // together (white in light, dark in dark). User-loc dot keeps its
      // hardcoded white ring — that's the universal "I am here" pin.
      'circle-stroke-color': getHalo(),
      'circle-stroke-width': [
        'case',
        ['==', ['get', 'focused'], true], 2.5,
        ['==', ['get', 'selected'], true], 2.5,
        1.5
      ]
    }
  });

  // ── Label layers ──────────────────────────────────────────────────────
  // MapLibre symbol layers can't render filter: drop-shadow, so the old
  // CSS look (4 px white text-stroke + soft drop-shadow) is composited from
  // TWO layers per label state: a translated dark "shadow" underlay rendered
  // first, then the crisp white-halo text on top. Layout is identical
  // between each pair so the engine's collision pass keeps them in lockstep.

  const DEFAULT_LABEL_FILTER = ['all',
    ['!', ['has', 'point_count']],
    ['!=', ['get', 'focused'], true],
    ['!=', ['get', 'selected'], true]
  ];
  const DEFAULT_LABEL_LAYOUT = {
    'text-field': ['get', 'label'],
    'text-font': FONT_MEDIUM,
    'text-size': 11,
    'text-variable-anchor': ['left', 'right'],
    'text-radial-offset': 0.9,
    'text-justify': 'auto',
    'text-padding': 2,
    'text-allow-overlap': false,
    'text-optional': true,
    'symbol-sort-key': ['case', ['==', ['get', 'active'], true], 1, 2]
  };

  const ABOVE_LABEL_FILTER = ['all',
    ['!', ['has', 'point_count']],
    ['any', ['==', ['get', 'focused'], true], ['==', ['get', 'selected'], true]]
  ];
  const ABOVE_LABEL_LAYOUT = {
    'text-field': ['get', 'label'],
    'text-font': FONT_MEDIUM,
    'text-size': ['case', ['==', ['get', 'focused'], true], 15, 14],
    'text-anchor': 'bottom',
    'text-offset': [0, -1.4],
    'text-padding': 2,
    'text-allow-overlap': true,
    'text-ignore-placement': true,
    'symbol-sort-key': 0
  };

  const CRISP_PAINT = {
    'text-color': ['get', 'color'],
    'text-halo-color': getHalo(),
    'text-halo-width': 2,
    'text-halo-blur': 0
  };

  map.addLayer({
    id: 'parish-label',
    type: 'symbol',
    source: PARISH_SOURCE,
    filter: DEFAULT_LABEL_FILTER,
    layout: DEFAULT_LABEL_LAYOUT,
    paint: CRISP_PAINT
  });

  // parish-focus-icon: only renders for the single focused parish. Filter on
  // the property gates visibility entirely — no need to rely on icon-opacity
  // tricks.
  map.addLayer({
    id: 'parish-focus-icon',
    type: 'symbol',
    source: PARISH_SOURCE,
    filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'focused'], true], ['has', 'focus_icon_id']],
    layout: {
      'icon-image': ['get', 'focus_icon_id'],
      'icon-size': 1,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'icon-anchor': 'center'
    }
  });

  // parish-cluster-icon: grape sprite, count-bucketed.
  map.addLayer({
    id: 'parish-cluster-icon',
    type: 'symbol',
    source: PARISH_SOURCE,
    filter: ['has', 'point_count'],
    layout: {
      'icon-image': [
        'step', ['get', 'point_count'],
        'grape_5',
        6, 'grape_6',
        7, 'grape_7'
      ],
      'icon-size': 1,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true
    }
  });

  // parish-cluster-overflow: "+N" badge for clusters >= 8.
  map.addLayer({
    id: 'parish-cluster-overflow',
    type: 'symbol',
    source: PARISH_SOURCE,
    filter: ['all', ['has', 'point_count'], ['>=', ['get', 'point_count'], 8]],
    layout: {
      'text-field': ['concat', '+', ['to-string', ['-', ['get', 'point_count'], 7]]],
      'text-font': FONT_MEDIUM,
      'text-size': 11,
      'text-offset': [0.7, 0.7],
      'text-allow-overlap': true,
      'text-ignore-placement': true,
      'text-anchor': 'center'
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': '#6a2d5c',
      'text-halo-width': 2.5
    }
  });

  // Emphasised labels (focused / selected) — centred above the marker, no
  // side-flip. Rendered last so they paint over the cluster + focus-icon stack.
  map.addLayer({
    id: 'parish-label-above',
    type: 'symbol',
    source: PARISH_SOURCE,
    filter: ABOVE_LABEL_FILTER,
    layout: ABOVE_LABEL_LAYOUT,
    paint: CRISP_PAINT
  });
}

function addUserLocSourceAndLayer(state) {
  const initialFeatures = (state.locationActive && state.userLat != null)
    ? [{ type: 'Feature', geometry: { type: 'Point', coordinates: [state.userLng, state.userLat] }, properties: {} }]
    : [];
  map.addSource(USER_SOURCE, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: initialFeatures }
  });
  map.addLayer({
    id: 'user-dot',
    type: 'circle',
    source: USER_SOURCE,
    paint: {
      'circle-radius': 4.5,
      'circle-color': '#4285f4',
      'circle-stroke-color': '#ffffff',
      'circle-stroke-width': 2
    }
  });
}

window.agoraUpdateUserLocation = function (lat, lng) {
  if (!map || !map.getSource(USER_SOURCE)) return;
  const fc = (lat == null || lng == null)
    ? { type: 'FeatureCollection', features: [] }
    : { type: 'FeatureCollection', features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [lng, lat] }, properties: {} }] };
  map.getSource(USER_SOURCE).setData(fc);
};

// ── Sprite registration ────────────────────────────────────────────────
// Rasterise the existing grape SVG (buildGrapeClusterHtml is the truth source)
// to per-count bitmaps and register via map.addImage. Symbol layer references
// them by name via icon-image expression.
function registerGrapeSprites() {
  return Promise.all([5, 6, 7].map(n =>
    rasteriseSvgAndRegister(buildGrapeSvg(n), `grape_${n}`, 40, 40, 2)
      .catch(err => console.warn('grape sprite fail', n, err))
  ));
}

function buildGrapeSvg(count) {
  // Same geometry as the old buildGrapeClusterHtml, minus the +N text (that
  // becomes a separate text symbol layer driven by point_count).
  const GRAPE = '#6a2d5c';
  const GRAPE_HI = '#8a4a7a';
  const r = 5;
  const layouts = {
    5: [[-r * 1.15, -r * 0.45], [0, -r * 0.7], [r * 1.15, -r * 0.45], [-r * 0.55, r * 0.6], [r * 0.55, r * 0.6]],
    6: [[-r * 1.05, -r * 0.5], [0, -r * 0.75], [r * 1.05, -r * 0.5], [-r * 0.5, r * 0.45], [r * 0.5, r * 0.45], [0, r * 1.25]],
    7: [[-r * 1.3, -r * 0.65], [0, -r * 0.85], [r * 1.3, -r * 0.65], [-r * 0.7, r * 0.15], [r * 0.7, r * 0.15], [-r * 0.35, r * 1.0], [r * 0.35, r * 1.0]]
  };
  const pts = layouts[count] || layouts[7];
  let grapes = '';
  for (const [ox, oy] of pts) {
    const x = 20 + ox, y = 20 + oy;
    grapes += `<circle cx="${x}" cy="${y}" r="${r}" fill="${GRAPE}" stroke="white" stroke-width="1.1"/>`;
    grapes += `<circle cx="${x - 1.5}" cy="${y - 1.5}" r="1.3" fill="${GRAPE_HI}" opacity="0.85"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="0 0 40 40">
    <g filter="drop-shadow(0 2px 3px rgba(0,0,0,0.18))" transform="rotate(-30 20 20)">${grapes}</g>
  </svg>`;
}

async function rasteriseSvgAndRegister(svgString, imageId, w, h, dpr) {
  if (map.hasImage(imageId)) return;
  const img = await loadSvgAsImage(svgString);
  const canvas = document.createElement('canvas');
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w * dpr, h * dpr);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
  if (!map.hasImage(imageId)) {
    map.addImage(imageId, data, { pixelRatio: dpr });
  }
}

function loadSvgAsImage(svgString) {
  return new Promise((resolve, reject) => {
    const blob = new Blob([svgString], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}

// Per-parish logo registration. Eager: fire all in parallel on init so the
// focus-icon layer's icon-image expression can resolve as soon as a parish
// gets focused. ~50–150 small images, completes within first second.
function registerParishLogos(parishes) {
  return Promise.allSettled(
    parishes
      .filter(p => p.logo_path && !logoRegistered.has(p.id))
      .map(p => bakeAndRegisterLogo(p).catch(() => { /* skip silently — feature falls back to circle */ }))
  );
}

async function bakeAndRegisterLogo(parish) {
  const dpr = 2;
  const size = 32 * dpr;
  const img = await loadHtmlImage(parish.logo_path);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  // White ring background
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();
  // Clip to inner circle (leaves a 2.5*dpr white border ring)
  const innerR = size / 2 - 2.5 * dpr;
  ctx.save();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, innerR, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(img, size / 2 - innerR, size / 2 - innerR, innerR * 2, innerR * 2);
  ctx.restore();
  const data = ctx.getImageData(0, 0, size, size);
  const id = `focus_${parish.id}`;
  if (!map.hasImage(id)) {
    map.addImage(id, data, { pixelRatio: dpr });
  }
  logoRegistered.add(parish.id);
}

function loadHtmlImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

// ── updateMap: rebuild GeoJSON, apply feature state ────────────────────
function updateMap(state, opts = {}) {
  if (!map) return;
  if (!styleLoaded) {
    pendingUpdate = { state, opts };
    return;
  }

  // Refresh parishesById in case state changed (defensive — parish list is
  // stable per session, but a future refresh path may mutate it).
  if (state.parishes && state.parishes.length !== parishesById.size) {
    parishesById.clear();
    for (const p of state.parishes) parishesById.set(p.id, p);
    registerParishLogos(state.parishes);
  }

  // Active set: parishes whose events/schedules pass the current filters.
  const activeSet = new Set();
  if (state.mode === 'services') {
    let scheds = state.schedules || [];
    if (state.filters.parishIds) scheds = scheds.filter(s => state.filters.parishIds.has(s.parish_id));
    for (const s of scheds) activeSet.add(s.parish_id);
  } else {
    const filtered = (typeof applyFilters === 'function') ? applyFilters(state.events) : (state.events || []);
    for (const evt of filtered) activeSet.add(evt.parish_id);
  }
  // Parish filter → those parishes are always active.
  if (state.filters.parishIds) {
    for (const pid of state.filters.parishIds) activeSet.add(pid);
  }

  const hardFilterOnEvents = state.filters.socialOnly || state.filters.englishOnly;

  const focusId = state.parishSheetFocus || null;
  const selectedSet = (state.selectionMode && state.filters.parishIds)
    ? state.filters.parishIds
    : null;

  // Build features. Focus/selected/active are baked into properties so the
  // layer expressions can read them with ['get', ...]; rebuilt-source-on-state
  // is fine for ~50 features and avoids feature-state quirks on symbol layers.
  const features = [];
  for (const p of state.parishes || []) {
    if (p.id === '_unassigned') continue;
    if (p.lat == null || p.lng == null) continue;
    if (state.filters.jurisdiction && p.jurisdiction !== state.filters.jurisdiction) continue;
    if (hardFilterOnEvents && !activeSet.has(p.id)) continue;
    const parts = (p.name || '').split(',');
    const label = (parts[0] || p.name || '').trim();
    // Juris filter active → render every parish as the one juris colour
    // (matches the inline-style funnel in app.js getParishDisplayColor).
    const jurisOverride = state.filters && state.filters.jurisdiction;
    const baseColor = jurisOverride && window.rawJurisColor
      ? window.rawJurisColor(jurisOverride)
      : (p.color || '#000');
    const props = {
      parish_id: p.id,
      label,
      // Single source for both circle-color and text-color paint expressions.
      // Solarized in dark so the dot, the label, and any feature-state-derived
      // visual all stay in lockstep with the inline-styled surfaces in app.js.
      color: isDark() ? liftParishColor(baseColor) : baseColor,
      jurisdiction: p.jurisdiction || '',
      focused: p.id === focusId,
      selected: selectedSet ? selectedSet.has(p.id) : false,
      active: activeSet.has(p.id)
    };
    if (logoRegistered.has(p.id)) props.focus_icon_id = `focus_${p.id}`;
    features.push({
      type: 'Feature',
      properties: props,
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] }
    });
  }

  const src = map.getSource(PARISH_SOURCE);
  if (src) src.setData({ type: 'FeatureCollection', features });

  if (opts.fit) {
    const activeFeatures = features.filter(f => f.properties.active);
    if (activeFeatures.length) {
      let b = boundsFromPoints(activeFeatures.map(f => ({
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0]
      })));
      b = padBounds(b, 0.1);
      const sheetY = (typeof window.agoraSheetY === 'function') ? window.agoraSheetY() : window.innerHeight * 0.5;
      const sheetHeight = window.innerHeight - sheetY;
      map.fitBounds(b, {
        padding: { top: 50, right: 30, bottom: sheetHeight + 20, left: 30 },
        maxZoom: 14,
        duration: 900
      });
    }
  }
}

// ── Click handlers ─────────────────────────────────────────────────────
function setupClickHandlers() {
  map.on('click', (e) => {
    // 20 px hit slop around the click — fingers aren't pixel-precise.
    const bbox = [
      [e.point.x - 20, e.point.y - 20],
      [e.point.x + 20, e.point.y + 20]
    ];
    const features = map.queryRenderedFeatures(bbox, {
      layers: ['parish-circle', 'parish-cluster-icon']
    });
    if (!features.length) {
      if (window.agoraClearParishFocus) window.agoraClearParishFocus();
      return;
    }
    // Closest feature wins when bbox catches multiple.
    let best = features[0], bestD = Infinity;
    for (const f of features) {
      const px = map.project(f.geometry.coordinates);
      const dx = px.x - e.point.x;
      const dy = px.y - e.point.y;
      const d = dx * dx + dy * dy;
      if (d < bestD) { bestD = d; best = f; }
    }
    if (best.layer.id === 'parish-cluster-icon') {
      handleClusterClick(best);
    } else {
      onParishClick(best.properties.parish_id);
    }
  });

  // Cursor feedback (desktop hover).
  for (const layerId of ['parish-circle', 'parish-cluster-icon']) {
    map.on('mouseenter', layerId, () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', layerId, () => { map.getCanvas().style.cursor = ''; });
  }
}

function handleClusterClick(feature) {
  const clusterId = feature.properties.cluster_id;
  const src = map.getSource(PARISH_SOURCE);
  const flyIn = (zoom) => {
    // Sheet-padded centring: project the cluster at current zoom, push the
    // camera centre down by half the occluded (sheet-covered) height so the
    // cluster lands in the visible region above the bottom sheet.
    const targetZoom = Math.min(zoom, 16);
    const currentZoom = map.getZoom();
    const scale = Math.pow(2, targetZoom - currentZoom);
    const sheetY = (typeof window.agoraSheetY === 'function')
      ? window.agoraSheetY()
      : (window.agoraSnapHalf ? window.agoraSnapHalf() : window.innerHeight);
    const containerH = map.getContainer().clientHeight;
    const dy = Math.max(0, (containerH - sheetY) / 2);
    const clusterPx = map.project(feature.geometry.coordinates);
    const newCentre = map.unproject([clusterPx.x, clusterPx.y + dy / scale]);
    map.flyTo({
      center: [newCentre.lng, newCentre.lat],
      zoom: targetZoom,
      duration: 600
    });
  };
  // MapLibre 3+ returns a Promise; older versions take a callback. Handle both.
  let result;
  try { result = src.getClusterExpansionZoom(clusterId); } catch (_) { result = null; }
  if (result && typeof result.then === 'function') {
    result.then(flyIn).catch(() => flyIn(map.getZoom() + 2));
  } else if (typeof src.getClusterExpansionZoom === 'function') {
    src.getClusterExpansionZoom(clusterId, (err, z) => {
      if (err || z == null) return flyIn(map.getZoom() + 2);
      flyIn(z);
    });
  } else {
    flyIn(map.getZoom() + 2);
  }
}

function onParishClick(id) {
  if (!id) return;
  const st = window.agoraStateRef;
  if (st && st.selectionMode) {
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

// ── Viewport phases (moveend → debounced rerenders) ────────────────────
function setupViewportPhases() {
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
}
