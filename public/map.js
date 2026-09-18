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
const LABEL_SHADOW_IMAGE = 'label-shadow';
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
// The drop shadow under the dots and the labels, from CSS var --map-shadow so
// it flips with the scheme exactly as --halo does. Read fresh each time, for
// the same reason: the scheme-change handler rebuilds the style and re-runs
// addParishSourceAndLayers, and a value cached at load would be the old one.
function getMapShadow() {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--map-shadow').trim();
  return v || 'rgba(15, 23, 42, 0.32)';
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

    // Deep-link path may have already aimed the camera at a parish before
    // style.load finished its sprite/logo await — don't yank it back to
    // Australia. Same applies to a single-parish URL whose openParishSheet
    // is fired on a 150 ms setTimeout from init.
    const cameraOwned = state.parishSheetFocus || state.parishFocus || state._openEventId;

    // Fresh session (no cached location): fit to all parishes.
    if (!state.locationActive && !cameraOwned) {
      const pts = (state.parishes || []).filter(p => p.id !== '_unassigned' && p.lat != null && p.lng != null);
      if (pts.length) {
        const b = padBounds(boundsFromPoints(pts), 0.05);
        map.fitBounds(b, { maxZoom: 6, animate: false });
      }
    }

    // Drain pending update if any. Strip fit when a deep-link already owns
    // the camera — markers still need to render, but the queued fitBounds
    // (from fetchEvents({fit:true})) would override the parish flyTo.
    if (pendingUpdate) {
      const { state: st, opts } = pendingUpdate;
      pendingUpdate = null;
      const drainOpts = (st.parishSheetFocus || st.parishFocus || st._openEventId)
        ? { ...opts, fit: false }
        : opts;
      updateMap(st, drainOpts);
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
  const DOT_RADIUS = [
    'case',
    ['all', ['==', ['get', 'focused'], true], ['has', 'focus_icon_id']], 0,
    ['==', ['get', 'focused'], true], 6,
    ['==', ['get', 'selected'], true], 6,
    3.75
  ];
  const DOT_STROKE_WIDTH = [
    'case',
    ['==', ['get', 'focused'], true], 2.5,
    ['==', ['get', 'selected'], true], 2.5,
    1.5
  ];
  // What the reader actually sees the edge of: the fill plus the halo ring
  // around it, and for the focused parish with a logo the sprite instead —
  // that case draws no circle at all (DOT_RADIUS is 0) and the sprite is
  // baked at 32 CSS px, so its edge is 16 out from the centre.
  //
  // Plus a pixel, so the blur has somewhere to fall outside the ring. Without
  // it the shadow is entirely under the marker and the marker is opaque.
  const DOT_SHADOW_RADIUS = [
    'case',
    ['all', ['==', ['get', 'focused'], true], ['has', 'focus_icon_id']], 17,
    ['==', ['get', 'focused'], true], 9.5,
    ['==', ['get', 'selected'], true], 9.5,
    6.25
  ];

  // parish-circle-shadow: the dots' drop shadow, and the focused parish's
  // logo sprite's too — a circle layer is the only thing MapLibre will blur,
  // there being no filter: drop-shadow on a WebGL layer. Added before the dot
  // so it paints under it; circle-blur is a FRACTION of the radius, not a
  // pixel count, which is why it is not the same number at both sizes.
  map.addLayer({
    id: 'parish-circle-shadow',
    type: 'circle',
    source: PARISH_SOURCE,
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-radius': DOT_SHADOW_RADIUS,
      'circle-color': getMapShadow(),
      'circle-blur': [
        'case',
        ['all', ['==', ['get', 'focused'], true], ['has', 'focus_icon_id']], 0.28,
        ['==', ['get', 'focused'], true], 0.45,
        ['==', ['get', 'selected'], true], 0.45,
        0.55
      ],
      // Straight down, as the labels and the grape sprite's baked-in
      // drop-shadow(0 2px 3px) also go. One light source for the whole map:
      // the distance differs with the size of the thing casting, the
      // direction never does.
      'circle-translate': [0, 1],
      'circle-translate-anchor': 'viewport'
    }
  });

  map.addLayer({
    id: 'parish-circle',
    type: 'circle',
    source: PARISH_SOURCE,
    filter: ['!', ['has', 'point_count']],
    paint: {
      'circle-radius': DOT_RADIUS,
      'circle-color': ['get', 'color'],
      // Same source as label halo so dot rings and label outlines flip
      // together (white in light, dark in dark). User-loc dot keeps its
      // hardcoded white ring — that's the universal "I am here" pin.
      'circle-stroke-color': getHalo(),
      'circle-stroke-width': DOT_STROKE_WIDTH
    }
  });

  // ── Label layers ──────────────────────────────────────────────────────
  // A label's shadow is ONE shadow for the whole label, cast by a stretched
  // sprite in the same layer as the text — not a second text layer.
  //
  // The obvious way, a translated dark copy of the text underneath, cannot
  // work, and the reason is worth writing down because it looks like a
  // tuning problem right up until you measure it. A symbol layer's only soft
  // edge is text-halo-blur, and a halo is drawn per GLYPH out of a signed
  // distance field whose glyph has about three SDF pixels of border. At
  // text-size 11 that is roughly 1.4 screen pixels. Past it the halo stops
  // growing and is simply clipped to the glyph's quad, so a "bigger" shadow
  // turns into a row of little dark rectangles, one per letter. And because
  // every glyph draws its own translucent quad, the quads overlap between
  // letters and composite into darker patches where they meet — the opposite
  // of CSS text-shadow, which masks the whole run once and then composites.
  //
  // So the shadow is an ICON instead. icon-text-fit stretches a nine-slice
  // sprite to the text's own box, which makes it one object at any label
  // width, of any size we like, with no glyphs and no SDF anywhere near it.
  // Being in the same layer as the text it is also the same symbol: placed
  // once, flipped with the text by text-variable-anchor, and — because
  // text-optional stays false — never left behind as a pool with no label
  // over it.
  //
  // It costs one sprite for the whole map, built in buildLabelShadowSprite().

  registerLabelShadowSprite();

  // The icon half of a label: the shadow, sized to the text.
  //
  // allow-overlap + ignore-placement keep it out of the collision index
  // entirely, so adding it changes nothing about which labels place — the
  // text decides that alone, exactly as before there was a shadow.
  const LABEL_SHADOW_LAYOUT = {
    'icon-image': LABEL_SHADOW_IMAGE,
    'icon-text-fit': 'both',
    // top, right, bottom, left. Wider than tall: a line of text is a long
    // low object and its shadow should be too.
    'icon-text-fit-padding': [1, 3, 1, 3],
    'icon-allow-overlap': true,
    'icon-ignore-placement': true
  };
  const LABEL_SHADOW_PAINT = {
    // The same light source as the dots and the grape sprite.
    'icon-translate': [0, 1.5],
    'icon-translate-anchor': 'viewport'
  };

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
    // NOT text-optional. With an icon in the layer that would mean "draw the
    // shadow even when the text was collided away", which is a pool of dark
    // with nothing floating over it.
    'symbol-sort-key': ['case', ['==', ['get', 'active'], true], 1, 2],
    ...LABEL_SHADOW_LAYOUT
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
    'symbol-sort-key': 0,
    ...LABEL_SHADOW_LAYOUT
  };

  const CRISP_PAINT = {
    'text-color': ['get', 'color'],
    'text-halo-color': getHalo(),
    'text-halo-width': 2,
    'text-halo-blur': 0,
    ...LABEL_SHADOW_PAINT
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
  // side-flip. Rendered last so they paint over the cluster + focus-icon
  // stack, shadow included: these are the labels that sit ON a grape or a
  // logo rather than on the basemap.
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
// The one sprite every label's shadow is made of: a soft, rounded, blurred
// slab, registered nine-slice so icon-text-fit can stretch its middle to any
// label's width without pulling the blurred corners out of shape.
//
// Drawn with shadowBlur rather than ctx.filter = 'blur()'. The filter
// property is the obvious tool and is missing on Safari before 17, where it
// is silently ignored — which would not fail, it would ship a hard-edged grey
// slab behind every label on a few years of iPhones. shadowBlur is
// everywhere, and drawing the source shape off the left edge of the canvas
// and offsetting its shadow back on is the standard way to get the blur
// without the shape.
//
// content[] is the box icon-text-fit matches to the text; everything outside
// it is the blur's falloff and keeps its natural size at every label width.
// The sprite is a soft slab with its middle PUNCHED OUT, and both halves of
// that matter.
//
// icon-text-fit matches the icon to the text's bounding BOX, and a box is not
// the shape of a label. A centred three-liner — "Sts. Cyril and Methodius
// Community / St Xenia Church" is a real one — has one long line and two
// short ones, so most of that box has no text in it. A filled sprite shows
// through everywhere the words do not reach and reads as a grey rectangle
// parked on the map rather than as a shadow.
//
// Hollowing it is the fix, but drawing a RING does not hollow it. The hole
// has to survive being stretched, and MapLibre stretches by replicating a
// band through the sprite's middle — so what the finished label shows in its
// interior is whatever alpha that one band happens to carry. A ring blurred
// enough to be soft bleeds across its own hole: at blur 16 the centre still
// measures 0.15 alpha, and stretching that across a wide label paints the
// slab straight back on. The hole cannot be made of the same blur that makes
// the edge soft.
//
// So the two are separated. Draw the slab, blurred as softly as we like, then
// erase the content box out of it with destination-out. What survives is the
// falloff OUTSIDE the box, which is all a drop shadow is ever visible as —
// under the object you never see it, and here the label is the object. The
// centre lands at exactly zero, so the stretched interior is exactly nothing.
//
// The corner radius stays small on purpose: corners are the part icon-text-fit
// cannot shrink, and 19 of the 293 real labels are as short as "St Sava".
//
// shadowBlur is roughly twice the gaussian sigma. All of these came off sweeps
// rendered against the three cases that bite: a three-line label, an ordinary
// one, and the shortest one on the map.
const LABEL_SHADOW_BLUR = 16;    // how far the shadow reaches outside the text
const LABEL_SHADOW_RADIUS = 10;  // corner radius; the sprite is 2x this across
const LABEL_SHADOW_CUT = 3;      // softness of the punched inner edge
const LABEL_SHADOW_DPR = 2;

function roundRectPath(ctx, x, y, w, h, r) {
  if (ctx.roundRect) { ctx.roundRect(x, y, w, h, r); return; }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function buildLabelShadowSprite() {
  const dpr = LABEL_SHADOW_DPR;
  const inner = LABEL_SHADOW_RADIUS * 2;
  const margin = Math.ceil(LABEL_SHADOW_BLUR * 1.6);   // room for the falloff
  const size = inner + margin * 2;

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size * dpr;
  const ctx = canvas.getContext('2d');

  // Everything below is in DEVICE pixels, deliberately — no ctx.scale().
  // shadowOffsetX/Y and shadowBlur are specified as NOT affected by the
  // current transform, so scaling the context moves the shape without moving
  // its shadow, and the blur lands a canvas-width off to one side.
  const px = (v) => v * dpr;
  // The shape is always drawn a full canvas to the left and its shadow
  // offset back on, because shadowBlur is the one blur every browser has:
  // ctx.filter is missing on Safari before 17, where it is ignored in silence
  // and would ship a hard-edged slab behind every label.
  const box = () => {
    ctx.beginPath();
    roundRectPath(ctx, px(margin - size), px(margin), px(inner), px(inner), px(LABEL_SHADOW_RADIUS));
  };

  ctx.shadowColor = getMapShadow();
  ctx.shadowBlur = px(LABEL_SHADOW_BLUR);
  ctx.shadowOffsetX = px(size);
  ctx.fillStyle = '#000';         // never seen: only its shadow lands on canvas
  box();
  ctx.fill();

  // Punch the content box back out. destination-out erases in proportion to
  // what it draws, so a second, barely-blurred copy of the same box takes the
  // interior to zero and leaves a soft inner edge.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.shadowColor = 'rgba(0, 0, 0, 1)';
  ctx.shadowBlur = px(LABEL_SHADOW_CUT);
  ctx.shadowOffsetX = px(size);
  box();
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';

  const at = (v) => Math.round(px(v));
  // Stretch a two-pixel band through the dead centre — the part the punch took
  // to zero. Replicating nothing is what keeps a wide label's middle empty,
  // and keeping the band away from the corners is what keeps them round.
  const mid = margin + inner / 2;
  return {
    data: ctx.getImageData(0, 0, canvas.width, canvas.height),
    options: {
      pixelRatio: dpr,
      stretchX: [[at(mid - 1), at(mid + 1)]],
      stretchY: [[at(mid - 1), at(mid + 1)]],
      content: [at(margin), at(margin), at(margin + inner), at(margin + inner)]
    }
  };
}

// Synchronous, and called before the label layers are added rather than with
// the other sprites afterwards: an icon-image naming a picture that is not
// there yet renders the text alone for the first frames, which is the bug
// that made the cluster grapes vanish at low zoom.
function registerLabelShadowSprite() {
  const id = LABEL_SHADOW_IMAGE;
  if (map.hasImage(id)) map.removeImage(id);
  try {
    const { data, options } = buildLabelShadowSprite();
    map.addImage(id, data, options);
  } catch (err) {
    // Without the image the labels render exactly as they did before there
    // were shadows, which is a fine thing to degrade to.
    console.warn('label shadow sprite failed', err);
  }
}

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

// Re-bake one parish's focus sprite after its logo changed. logoRegistered
// is keyed by parish id, so without this an admin who replaces or clears a
// logo keeps seeing the old one baked into the map until a reload.
window.agoraRefreshParishLogo = async function (parishId) {
  if (!map) return;
  const id = `focus_${parishId}`;
  logoRegistered.delete(parishId);
  if (map.hasImage(id)) map.removeImage(id);
  const parish = (window.agoraStateRef && window.agoraStateRef.parishes || [])
    .find(p => p.id === parishId);
  if (parish && parish.logo_path) {
    try { await bakeAndRegisterLogo(parish); } catch { /* falls back to the circle */ }
  }
  const st = window.agoraStateRef;
  if (st && typeof updateMap === 'function') updateMap(st);
};

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
    // One slot, last write wins — except for `fit`, which is sticky. A request
    // to frame something is a one-off intent, and the render that lands behind
    // it (a filter's own refetch, say) would otherwise drop it silently and
    // leave the camera where it started.
    pendingUpdate = { state, opts: { ...opts, fit: opts.fit || !!(pendingUpdate && pendingUpdate.opts.fit) } };
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

  // Schedules / socials filters shape the events list, but parish dots stay
  // visible on the map regardless — the user wants spatial context (where
  // every parish is) even while a content filter is active. Only the English
  // filter still hard-prunes parishes off the map (a non-English parish
  // genuinely has no relevant content for the English-filter view).
  const hardFilterOnEvents = state.filters.englishOnly;

  const locFilter = (state.filters.location && window.AgoraLocations)
    ? window.AgoraLocations.resolveLocation(state.filters.location)
    : null;

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
    // A location filter prunes the map, unlike the content filters above it:
    // asking for Queensland and still seeing every Melbourne dot would be the
    // filter not working. Same reasoning as the English filter below.
    if (locFilter && !window.AgoraLocations.locationMatchesParish(locFilter, p)) continue;
    if (hardFilterOnEvents && !activeSet.has(p.id)) continue;
    const parts = (p.name || '').split(',');
    const label = (parts[0] || p.name || '').trim();
    // The map reads jurisdiction, never the parish's own colour.
    //
    // A custom parish colour is an identity mark and belongs where a parish
    // is the subject: its card, its feed lines, its event groups. On the map
    // the parish is one dot among two hundred, and what a reader is asking
    // there is "which of these is mine" — jurisdiction, not parish. Letting
    // custom hues through would make the answer unreadable the moment two
    // parishes a suburb apart pick unrelated colours, and there is no legend
    // on a map to recover it from.
    //
    // A juris filter changes nothing here: every surviving feature is that
    // jurisdiction already, so its colour is the same either way.
    const baseColor = window.rawJurisColor
      ? window.rawJurisColor(p.jurisdiction)
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
    // Prefer the parishes actually in scope — a region with three parishes in
    // one city is better framed on those three than on the whole state. The
    // region's own box is the fallback, and it is what a location filter that
    // matches nothing still frames, so /nt reads as "the Territory, and
    // nothing here" rather than leaving the map wherever it was.
    const activeFeatures = features.filter(f => f.properties.active);
    // Under a location filter, every remaining feature is in the region, so a
    // region whose parishes have nothing on this week still frames its
    // parishes rather than jumping out to the whole state.
    const fitFeatures = activeFeatures.length ? activeFeatures
      : (locFilter ? features : []);
    let b = null;
    if (fitFeatures.length) {
      b = padBounds(boundsFromPoints(fitFeatures.map(f => ({
        lat: f.geometry.coordinates[1],
        lng: f.geometry.coordinates[0]
      }))), 0.1);
    } else if (locFilter) {
      const [w, s, e, n] = window.AgoraLocations.locationBbox(locFilter);
      b = [[w, s], [e, n]];
    }
    if (b) map.fitBounds(b, { padding: fitPadding(), maxZoom: 14, duration: 900 });
  }
}

// Sheet-aware padding for fitBounds: on mobile the bottom sheet covers the
// lower half of the map, so the visible window is the strip above it.
//
// Clamped, because MapLibre answers a fitBounds it cannot satisfy by doing
// nothing at all — no move, no throw, one console warning. With the sheet
// dragged to full height the bottom inset alone exceeds the canvas, and the
// camera then silently stays wherever it was. That is how a location deep
// link came up showing the whole country instead of the state it named.
function fitPadding() {
  const h = window.innerHeight, w = window.innerWidth;
  const isDesktop = window.agoraIsDesktop?.() ?? false;
  const pad = isDesktop
    ? { top: 50, right: 440, bottom: 50, left: 50 }
    : (() => {
      const sheetY = (typeof window.agoraSheetY === 'function') ? window.agoraSheetY() : h * 0.5;
      return { top: 50, right: 30, bottom: Math.max(0, h - sheetY) + 20, left: 30 };
    })();
  // Leave at least a 120 px window on each axis to fit into.
  const shrink = (a, b, limit) => {
    if (a + b <= limit) return [a, b];
    const k = Math.max(0, limit) / (a + b);
    return [Math.floor(a * k), Math.floor(b * k)];
  };
  [pad.top, pad.bottom] = shrink(pad.top, pad.bottom, h - 120);
  [pad.left, pad.right] = shrink(pad.left, pad.right, w - 120);
  return pad;
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
    const isDesktop = window.agoraIsDesktop?.() ?? false;
    let dx = 0, dy = 0;
    if (isDesktop) {
      dx = 210;
    } else {
      const sheetY = (typeof window.agoraSheetY === 'function')
        ? window.agoraSheetY()
        : (window.agoraSnapHalf ? window.agoraSnapHalf() : window.innerHeight);
      const containerH = map.getContainer().clientHeight;
      dy = Math.max(0, (containerH - sheetY) / 2);
    }
    const clusterPx = map.project(feature.geometry.coordinates);
    const newCentre = map.unproject([clusterPx.x + dx / scale, clusterPx.y + dy / scale]);
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
    // Skip the pending mark when the move is sheet-driven (sheet's own
    // map.resize fires moveend). Sheet snaps don't change the parish
    // set under our stable cutoff. Check both the live flag and the
    // timestamp window — drag → release → snap can fire moveend
    // multiple times across the snap settle.
    if (window.__agoraSheetMoving) return;
    if (window.__agoraSheetSnapAt && (Date.now() - window.__agoraSheetSnapAt) < 1100) return;
    if (window.agoraMarkEventsPending) window.agoraMarkEventsPending();
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
