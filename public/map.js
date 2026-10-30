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
// How hard parishes are gathered into grapes. 38px and every zoom up to
// MapLibre's default of 14 swallowed whole suburbs a person was looking at —
// a grape where four churches a street apart should be four dots. 24px, then
// 33px, still gathered dots a person could tell apart, so since October 2026
// (the owner: "only when the parishes are very close together") a grape is
// five or more dots that would sit on each other — 12px is a dot and its
// ring, touching — and never once the map shows a city (zoom 11 and in,
// every parish is its own dot).
const CLUSTER_RADIUS_PX = 12;
const CLUSTER_MIN_POINTS = 5;     // matches old "≥5 members render as grape"
const CLUSTER_MAX_ZOOM = 10;

// ── How crowding is answered: 'dots' or 'grapes' ───────────────────────
// Two ways of dealing with parishes too close together to draw separately.
//
//   'grapes'  supercluster DELETES the dots and draws one symbol standing for
//             a count. Reads as "twelve things here", and loses every colour.
//   'dots'    every parish keeps its own dot and its own jurisdiction colour,
//             and dots that would overlap are pushed apart until they don't.
//             Reads as "a crowd, mostly Greek". Zoomed out that is 293 dots.
//
// Live A/B, so both stay reachable: ?markers=grapes or ?markers=dots sets it
// and remembers, or agoraSetMarkerMode() from the console. The query string
// wins over the remembered value so a link can pin either one.
//
// Grapes is what a visitor gets. Dots shipped as the default for one round,
// was looked at on the live map, and the default was set back; the mode itself
// stays exactly where it was, which is what the switch above is for. Changing
// this line is the whole of changing the default — nothing below it asks which
// mode is the default, only which mode it is in.
const MARKER_MODE_DEFAULT = 'grapes';
// The gap two dots settle at. The dot is 3.75 r + 1.5 stroke = 10.5 across,
// so this leaves about a pixel and a half of daylight between neighbours.
const DOT_MIN_DISTANCE_PX = 12;
// Under this much movement a dot is still on its parish, so it keeps its label.
const DOT_SHIFT_EPSILON_PX = 0.5;

// ── How big a dot is at each zoom ──────────────────────────────────────
// Its size from the whole country down to the suburbs (zoom 12), then a
// little bigger with every step in: 30% by zoom 14, 60% by 16 and closer.
// The prototype at /next grew them from zoom 10 and doubled them by 14; the
// owner (October 2026) wanted today's size kept until the suburbs, and the
// growth slight. One table, read by the layers (as a zoom expression) and by
// the halo loop (as a number), so a ring stays the same distance off its dot.
const DOT_ZOOM_STOPS = [[12, 1], [14, 1.3], [16, 1.6]];

/** The dot's scale at `zoom`, as MapLibre's linear interpolate would give it. */
function dotScale(zoom) {
  const s = DOT_ZOOM_STOPS;
  if (!(zoom > s[0][0])) return s[0][1];
  for (let i = 1; i < s.length; i++) {
    if (zoom <= s[i][0]) {
      const [z0, k0] = s[i - 1], [z1, k1] = s[i];
      return k0 + (k1 - k0) * (zoom - z0) / (z1 - z0);
    }
  }
  return s[s.length - 1][1];
}

/** A paint value by zoom: `at(k)` is the value at scale k, at each stop. */
function dotByZoom(at) {
  const expr = ['interpolate', ['linear'], ['zoom']];
  for (const [z, k] of DOT_ZOOM_STOPS) expr.push(z, at(k));
  return expr;
}

function markerMode() {
  try {
    const q = new URLSearchParams(location.search).get('markers');
    if (q === 'dots' || q === 'grapes') {
      localStorage.setItem('agoraMarkers', q);
      return q;
    }
    const saved = localStorage.getItem('agoraMarkers');
    if (saved === 'dots' || saved === 'grapes') return saved;
  } catch (_) {
    // Private mode denies localStorage; the default is a fine answer.
  }
  return MARKER_MODE_DEFAULT;
}

window.agoraSetMarkerMode = function (mode) {
  if (mode !== 'dots' && mode !== 'grapes') return markerMode();
  try { localStorage.setItem('agoraMarkers', mode); } catch (_) { /* ignore */ }
  // Clustering is a source option, and a source's options cannot be changed
  // after it is added — so the switch needs the style rebuilt, same as a
  // light/dark flip does.
  location.reload();
  return mode;
};
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

// Perceptual-luminance lift for dark mode: a colour too dark to read on the
// dark basemap is raised to a floor in OKLab, hue kept.
// The arithmetic lives in public/shared/jurisdiction-colors.js now, so the
// Worker paints a lite page's dark variant with the same colours the app does.
function liftParishColor(hex) {
  return window.agoraLiftForDark(hex);
}
window.liftParishColor = liftParishColor;
// Back-compat alias — earlier rev exposed this as solarizeColor; some
// in-flight callers may still reference the old name.
window.solarizeColor = liftParishColor;

let map = null;
let styleLoaded = false;
let pendingUpdate = null;          // queued updateMap call if style not ready
let parishesById = new Map();      // populated at initMap; fast lookup for click handler
let initStarted = false;           // initMap is async; a second call mid-await must not build a second map
let handlersBound = false;         // map.on listeners outlive setStyle: bind them once, not per style.load
// The first "fit to every parish" is owed until the parishes are here. The map
// is created before /api/bundle answers now (the basemap needs nothing from
// it), so on a first load the style is often ready while the list is empty.
let initialFitPending = false;
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
  // Two fonts, not three. The theme sets water names in Noto Sans Italic, a
  // third download (~78 KB) for a handful of labels on a faded map, and the
  // fonts are what the map's first full draw waits on. Upright, they read the
  // same.
  layers = JSON.parse(JSON.stringify(layers).replaceAll('"Noto Sans Italic"', '"Noto Sans Regular"'));
  layers.push({
    id: 'fade-overlay',
    type: 'background',
    paint: { 'background-color': fade.color, 'background-opacity': fade.opacity }
  });
  return {
    version: 8,
    // No easing by default. The halos set paint values on every frame they
    // draw, and each set restarted MapLibre's default 300ms ease on everything
    // that eases, the style's sky included; while anything is easing MapLibre
    // draws the whole map on every screen frame. So the halos' 30 sets a second
    // were 120 full draws a second, and never one fewer. Nothing else here
    // changes a paint value.
    transition: { duration: 0, delay: 0 },
    glyphs: '/glyphs/{fontstack}/{range}.pbf',
    sprite: window.location.origin + '/sprites/protomaps',
    sources: {
      // One tile at a time from the Worker, which reads the archive in R2
      // (worker/routes/assets.mjs, serveTile): each tile an ordinary file the
      // browser keeps, where reading the archive from here took three range
      // requests before the first tile and Safari kept none of them. Zooms and
      // bounds are the archive's (.github/workflows/basemap.yml builds it):
      // past 12 MapLibre draws the zoom-12 tiles larger.
      protomaps: {
        type: 'vector',
        tiles: [window.location.origin + '/tiles/oceania/{z}/{x}/{y}.mvt'],
        minzoom: 0,
        maxzoom: 12,
        bounds: [110, -50, 180, 0],
        attribution: '<a href="https://protomaps.com">Protomaps</a> &copy; <a href="https://openstreetmap.org">OSM</a>'
      }
    },
    layers
  };
}

// Has something already aimed the camera, so the first load must not fit to
// every parish? A deep link to a parish or an event does; so does a page that
// frames its own start (/next, which sets `cameraOwned` and moves the map
// itself before the style loads).
function cameraOwnedBy(state) {
  return !!(state.cameraOwned || state.parishSheetFocus || state.parishFocus || state._openEventId);
}

// The map draws at most two device pixels to a CSS pixel. On a 3x phone that
// is 56% fewer pixels to shade every frame, which is the GPU's whole job while
// a finger pans; a faded basemap under round dots shows no difference, and a
// label only the faintest softening. Apple's and Google's maps take the same
// shortcut. Read again on every resize, so a desktop zoom still sharpens it.
function mapPixelRatio() {
  return Math.min(window.devicePixelRatio || 1, 2);
}

// The label fonts the first view needs, asked for as the map starts. MapLibre
// asks for a font only once a tile it has read wants one, and the map's first
// full draw then waited on the fonts as one more trip after the tiles.
// Preloaded, they come alongside the tiles and MapLibre's own requests are
// answered from them.
// The second Medium range is the parish labels' curly quotes (St Mary’s).
const FIRST_GLYPHS = [['Noto Sans Regular', '0-255'], ['Noto Sans Medium', '0-255'], ['Noto Sans Medium', '8192-8447']];
function preloadGlyphs() {
  for (const [font, range] of FIRST_GLYPHS) {
    const link = document.createElement('link');
    link.rel = 'preload';
    link.as = 'fetch';
    link.crossOrigin = 'anonymous';
    link.href = `/glyphs/${encodeURIComponent(font)}/${range}.pbf`;
    document.head.appendChild(link);
  }
}

// ── initMap ────────────────────────────────────────────────────────────
async function initMap(state) {
  if (map || initStarted) return;
  initStarted = true;
  preloadGlyphs();

  const style = await buildBaseStyle();

  map = new maplibregl.Map({
    container: 'map',
    style,
    center: [145, -20],
    zoom: 4,
    pixelRatio: mapPixelRatio(),
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

  // The parishes go on as soon as the style is read, not on 'load'. 'load'
  // waits for every basemap tile and every label font, and on a slow phone
  // the fonts came ten seconds in: the dots, which need neither, waited with
  // them. Once: a scheme switch's own style.load is handled below.
  map.once('style.load', async () => {
    addFavStarImage();
    addParishSourceAndLayers();
    addVenueSourceAndLayers();
    addUserLocSourceAndLayer(state);
    // Once per map. A scheme switch rebuilds the style, not these listeners —
    // re-binding them there stacked one more click handler per light/dark
    // flip, and every tap on a parish then opened that many cards.
    if (!handlersBound) {
      handlersBound = true;
      setupClickHandlers();
      setupViewportPhases();
      setupDeclutterOnZoom();
      setupSolo();
      setupHaloGates();
      setupStillLabels();
    }

    // Register sprites BEFORE any layer tries to render them — otherwise the
    // symbol layers report "image missing" and skip drawing for the first
    // render frames, which is what made cluster icons vanish at low zoom.
    await registerGrapeSprites().catch(() => {});
    // No logos here: a parish's logo becomes its focus sprite only when it is
    // picked (bakeFocusLogo, from updateMap).
    map.triggerRepaint();

    styleLoaded = true;
    if (window.lsLog) window.lsLog('✓ map ready');

    // Deep-link path may have already aimed the camera at a parish before
    // style.load finished its sprite/logo await — don't yank it back to
    // Australia. Same applies to a single-parish URL whose openParishSheet
    // is fired on a 150 ms setTimeout from init.
    const cameraOwned = cameraOwnedBy(state);

    // Fresh session (no cached location): fit to all parishes — now, or when
    // they arrive.
    if (!state.locationActive && !cameraOwned) {
      if (!fitToAllParishes(state)) initialFitPending = true;
    }

    // Drain pending update if any. Strip fit when a deep-link already owns
    // the camera — markers still need to render, but the queued fitBounds
    // (from fetchEvents({fit:true})) would override the parish flyTo.
    if (pendingUpdate) {
      const { state: st, opts } = pendingUpdate;
      pendingUpdate = null;
      const drainOpts = cameraOwnedBy(st)
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
  // A fixed pixelRatio no longer follows the screen by itself: a desktop zoom
  // or a move to another monitor changes devicePixelRatio and resizes the map.
  map.on('resize', () => {
    const want = mapPixelRatio();
    if (map.getPixelRatio() !== want) map.setPixelRatio(want);
  });

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
        addFavStarImage();
        addParishSourceAndLayers();
        addVenueSourceAndLayers();
        addUserLocSourceAndLayer(st);
        await registerGrapeSprites().catch(() => {});
        styleLoaded = true;
        if (typeof updateMap === 'function') updateMap(st);
        map.triggerRepaint();
      });
    });
  }
}

// ── Sources & layers ────────────────────────────────────────────────────
function addParishSourceAndLayers() {
  // In 'dots' mode clustering is simply off, and every cluster-shaped layer
  // below keeps its filter on ['has', 'point_count'] and quietly matches
  // nothing. Nothing else in the file has to know which mode it is in —
  // including the click handler, which still names parish-cluster-icon.
  map.addSource(PARISH_SOURCE, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
    cluster: markerMode() === 'grapes',
    clusterRadius: CLUSTER_RADIUS_PX,
    clusterMinPoints: CLUSTER_MIN_POINTS,
    clusterMaxZoom: CLUSTER_MAX_ZOOM,
    // A grape stands for its parishes, so it carries their halos: it breathes
    // green if any of them has something on now, neutral if any is running
    // something on now elsewhere, and tolls if any has something still to
    // come today. See addHaloLayers.
    clusterProperties: {
      now_count: ['+', ['case', ['==', ['get', 'now'], true], 1, 0]],
      away_count: ['+', ['case', ['==', ['get', 'away'], true], 1, 0]],
      today_count: ['+', ['case', ['==', ['get', 'today'], true], 1, 0]]
    }
  });

  addHaloLayers();

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
  // A dot keeps its size from the whole country down to the suburbs, then
  // grows a little as the map closes in (dotByZoom), the way the first /next
  // prototype's did — which doubled them, from zoom 10; this is gentler, and
  // starts later, so a city's worth of dots never crowds. The logo case
  // (focused, with a sprite) is the sprite's own size and does not grow.
  //
  // A solo parish (the only one in view, see syncSolo) keeps its dot: the pop
  // is a DOM element over it, and the dot under it is what a tap still finds.
  const DOT_RADIUS = dotByZoom((k) => [
    'case',
    ['all', ['==', ['get', 'focused'], true], ['has', 'focus_icon_id']], 0,
    ['==', ['get', 'focused'], true], 6 * k,
    ['==', ['get', 'selected'], true], 6 * k,
    3.75 * k
  ]);
  const DOT_STROKE_WIDTH = dotByZoom((k) => [
    'case',
    ['==', ['get', 'focused'], true], 2.5,
    ['==', ['get', 'selected'], true], 2.5,
    1.5 * Math.min(k, 4 / 3)
  ]);
  // What the reader actually sees the edge of: the fill plus the halo ring
  // around it, and for the focused parish with a logo the sprite instead —
  // that case draws no circle at all (DOT_RADIUS is 0) and the sprite is
  // baked at 32 CSS px, so its edge is 16 out from the centre.
  //
  // Plus a pixel, so the blur has somewhere to fall outside the ring. Without
  // it the shadow is entirely under the marker and the marker is opaque.
  const DOT_SHADOW_RADIUS = dotByZoom((k) => [
    'case',
    ['all', ['==', ['get', 'focused'], true], ['has', 'focus_icon_id']], 17,
    ['==', ['get', 'focused'], true], 9.5 * k,
    ['==', ['get', 'selected'], true], 9.5 * k,
    6.25 * k
  ]);

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

  // A favourite parish (this browser's star, app.js) wears a small gold star
  // at its dot's shoulder, as its pill in the row above does. The image is
  // registered before this runs (addFavStarImage): nothing here registers a
  // sprite, which is how the label-shadow guard in d1/map-layers.test.mjs
  // keeps watch.
  map.addLayer({
    id: 'parish-fav-star',
    type: 'symbol',
    source: PARISH_SOURCE,
    filter: ['all', ['!', ['has', 'point_count']], ['==', ['get', 'fav'], true]],
    layout: {
      'icon-image': FAV_STAR_ICON,
      'icon-offset': [7, -7],
      'icon-allow-overlap': true,
      'icon-ignore-placement': true
    },
    paint: {
      'icon-color': FAV_STAR_COLOR,
      'icon-halo-color': getHalo(),
      'icon-halo-width': 1.25
    }
  });

  // ── Label layers ──────────────────────────────────────────────────────
  // A halo and no shadow, which is what Google Maps does and what MapLibre
  // can actually draw well.
  //
  // A label shadow was tried twice and removed. A translated dark copy of the
  // text cannot work: a symbol layer's only soft edge is text-halo-blur, that
  // halo is drawn per GLYPH from a distance field with about three SDF pixels
  // of border, and past roughly 1.4 screen pixels at text-size 11 it stops
  // growing and is clipped square to each glyph's quad — a row of little dark
  // rectangles, one per letter, with darker patches where adjacent quads
  // overlap. A stretched sprite behind the whole label cannot work either:
  // icon-text-fit sizes the icon to the text's bounding BOX, and a box is not
  // the shape of a label. "Sts. Cyril and Methodius Community / St Xenia
  // Church" wraps to three centred lines of 122, 79 and 67 px, so a
  // box-shaped shadow stands 28 px past each end of the last line.
  //
  // What draws a text-shaped shadow is an offscreen pass — render the run,
  // blur the surface, composite it underneath — which is what Apple Maps does
  // and what MapLibre GL JS does not expose for symbol layers. Until that is
  // worth building, the halo is the lift. The dots keep their shadow, which is
  // a circle layer and blurs properly.
  const DEFAULT_LABEL_FILTER = ['all',
    ['!', ['has', 'point_count']],
    ['!=', ['get', 'focused'], true],
    ['!=', ['get', 'selected'], true],
    ['!=', ['get', 'solo'], true],
    // Set by the declutter on any dot it had to move. The focused and
    // selected labels below deliberately do NOT check it: the reader asked
    // for that parish by name, so it is named even in a crowd.
    ['!=', ['get', 'crowded'], true]
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
    ['any', ['==', ['get', 'focused'], true], ['==', ['get', 'selected'], true],
      ['==', ['get', 'solo'], true]]
  ];
  const ABOVE_LABEL_LAYOUT = {
    'text-field': ['get', 'label'],
    'text-font': FONT_MEDIUM,
    'text-size': ['case', ['any', ['==', ['get', 'focused'], true], ['==', ['get', 'solo'], true]], 15, 14],
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

// ── Halos: on now, later today, and run from here but on elsewhere ──────
//
// A parish with a service on right now breathes green: a soft halo under its
// dot that fades in and out. One with something still to come today tolls: a
// neutral ring grows out of the dot and fades, then a pause, like a bell
// announcing it. One whose own event is on right now SOMEWHERE ELSE breathes
// too, in the toll's neutral colour: the parish is running something, and the
// green is where the people are. All three sit UNDER the dot, so its
// jurisdiction colour reads exactly as it did. The toll and the breath that is
// not green wear the colour of the kind of event (public/shared/event-types.js)
// that lit them; a grape, which stands for several, stays neutral.
//
// An event held at another parish lights that parish as well (worker/lib/
// venues.mjs is what "held at" means): both toll on the day, and once it starts
// the venue goes green while the host breathes neutral. One held at a place of
// its own, with a pin, is a square on the map (the venue layers below), and the
// square takes the venue's halo. Where a parish has more than one thing on,
// green beats the neutral breath beats the toll.
//
// The flags are properties on the parish features (`now`, `away`, `today`),
// worked out in updateMap from the events the feed shows — its content
// filters, not the viewport — and again every minute, because a service
// starting or ending changes them with nothing else happening.
//
// The motion is constant paint values stepped on animation frames. Constant,
// never an expression reading the feature: a data-driven paint property that
// changes makes MapLibre re-tile the source, which every frame would mean a
// worker round trip per frame. So the different sizes of marker are different
// layers — a dot, and the big ones (a grape, a focused parish's logo) — each
// with its own constant radius. Under reduced motion the halos stand still.
//
// Every frame of the loop is a draw of the WHOLE map, basemap and all, so it
// runs only while it shows: something flagged, the page visible, the map on
// screen (scrolled down the page, it is not), and a lit marker in or near the
// view. Otherwise the map draws nothing until somebody moves it.
const HALO_NOW = '#22c55e';
const HALO_NOW_MS = 3000;        // one breath, in and out
// One toll: the ring spreads and fades for HALO_RING_MS, then a short silence.
// It was a fast ease-out over 2.2s of 3.4s, so it sprang out of the dot and
// was gone for a third of the cycle; now it travels at a near-even pace and
// is visible for all but the last half second.
const HALO_TOLL_MS = 3800;
const HALO_RING_MS = 3300;
const HALO_FRAME_MS = 66;        // ~15fps: a slow ring moves under half a pixel a frame
// Where a marker's edge is: the dot with its ring; a grape's spread or a logo;
// a place's square with its ring.
const HALO_EDGE = { dot: 5.25, big: 16, venue: 6.5 };

const HALO_BIG = ['any', ['has', 'point_count'], ['==', ['get', 'solo'], true],
  ['all', ['==', ['get', 'focused'], true], ['has', 'focus_icon_id']]];
const HALO_IS_NOW = ['any', ['==', ['get', 'now'], true],
  ['>', ['coalesce', ['get', 'now_count'], 0], 0]];
const HALO_IS_AWAY = ['any', ['==', ['get', 'away'], true],
  ['>', ['coalesce', ['get', 'away_count'], 0], 0]];
const HALO_IS_TODAY = ['any', ['==', ['get', 'today'], true],
  ['>', ['coalesce', ['get', 'today_count'], 0], 0]];

let haloState = null;            // the state updateMap last drew, for the minute tick
let haloAny = false;             // is anything flagged — no flags, no loop
let haloRaf = 0, haloLastFrame = 0, haloTimer = 0;
let mapOnScreen = true;          // any of the map's box inside the window (setupHaloGates)
let haloInView = true;           // a lit marker in or near the view (litInView)

// The ring's grey, a step lighter than slate-500 so it reads as a ring rather
// than as an outline. One crisp line and nothing else: the white ring that sat
// just inside it doubled every edge and made a crowded map look blurred.
function haloTollColor() {
  return isDark() ? '#cbd5e1' : '#7d8899';
}

// The toll's colour as a paint value: the kind's text colour (the dark one on
// a light map, the light one on a dark), by the feature's `halo_kind`, and the
// grey where there is none (a grape). A constant expression, set once with the
// layer: only radius and opacity move per frame.
function haloKindColor() {
  const types = window.AgoraEventTypes;
  if (!types) return haloTollColor();
  const dark = isDark();
  const expr = ['match', ['coalesce', ['get', 'halo_kind'], '']];
  for (const id of types.EVENT_TYPES) expr.push(id, types.kindColors(id, dark).fg);
  expr.push(haloTollColor());
  return expr;
}

function addHaloLayers() {
  for (const size of ['dot', 'big']) {
    const isBig = size === 'big' ? HALO_BIG : ['!', HALO_BIG];
    addRingLayers(`parish-halo-now-${size}`, PARISH_SOURCE, ['all', HALO_IS_NOW, isBig], size, HALO_NOW);
    // On elsewhere: the breath, in the toll's colour.
    addRingLayers(`parish-halo-away-${size}`, PARISH_SOURCE,
      ['all', ['!', HALO_IS_NOW], HALO_IS_AWAY, isBig], size, haloKindColor());
    addRingLayers(`parish-halo-toll-${size}`, PARISH_SOURCE,
      ['all', ['!', HALO_IS_NOW], ['!', HALO_IS_AWAY], HALO_IS_TODAY, isBig], size, haloKindColor());
  }
  // The loop is started by updateMap, which follows every (re)build of these.
  haloLastFrame = 0;
}

/**
 * One halo as the toll draws it: a thin ring in its colour over the faintest
 * fill. The breath (green, or the neutral "on elsewhere") is the same ring,
 * swelling and fading a little; the toll spreads out of the dot. `before`
 * places it.
 */
function addRingLayers(id, source, filter, size, color, before) {
  map.addLayer({ id, type: 'circle', source, filter, paint: ringPaint(size, color) }, before);
}

// No transitions: every frame sets these, and MapLibre's default 300ms ease
// between paint values is what made the toll visibly shrink back into the dot
// before each ring. (The style's own `transition` is none as well: see
// buildBaseStyle.)
const NO_EASE = { duration: 0, delay: 0 };
function ringPaint(size, color) {
  return {
    'circle-radius': HALO_EDGE[size] + 4,
    'circle-radius-transition': NO_EASE,
    'circle-color': color,
    'circle-opacity': 0,
    'circle-opacity-transition': NO_EASE,
    'circle-stroke-color': color,
    'circle-stroke-width': 1.25,
    'circle-stroke-opacity': 0,
    'circle-stroke-opacity-transition': NO_EASE
  };
}

/** The events the map lights: the feed's, by its content filters. */
function haloEvents(state) {
  const all = (state && state.events) || [];
  return typeof applyNonViewportFilters === 'function' ? applyNonViewportFilters(all) : all;
}

/**
 * Is this event on now ('now'), still to come today ('today'), or neither?
 *
 * "Today" is the parish's own day, in its own zone — the service is where the
 * parish is. A tombstone is not on.
 */
const _dayFmts = new Map();
/** A zone's 'YYYY-MM-DD' formatter, made once (making one is the slow part). */
function dayFmtIn(zone) {
  let f = _dayFmts.get(zone);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: zone }); _dayFmts.set(zone, f); }
  return f;
}
function eventTiming(e, now) {
  if (e.is_tombstone || (e.status && e.status !== 'approved')) return null;
  const start = Date.parse(e.start_utc);
  if (!Number.isFinite(start)) return null;
  const end = e.end_utc ? Date.parse(e.end_utc) : start + 3600000;
  if (start <= now && end >= now) return 'now';
  if (start <= now || start - now >= 86400000) return null;
  const zone = e.timezone || (parishesById.get(e.parish_id) || {}).timezone;
  const dayIn = (ms) => {
    try { return dayFmtIn(zone || 'Australia/Sydney').format(new Date(ms)); }
    catch { return new Date(ms).toISOString().slice(0, 10); }
  };
  return dayIn(start) === dayIn(now) ? 'today' : null;
}

/**
 * Where an event is held, as the map needs it: at home (null), at another
 * parish ({ parish }), or somewhere else — with a pin of its own ({ place })
 * or only in words ({ elsewhere }). The same reading as worker/lib/venues.mjs.
 */
function heldAt(e) {
  if (e.location_parish_id && e.location_parish_id !== e.parish_id) return { parish: e.location_parish_id };
  if (e.location_lat != null && e.location_lng != null) return { place: [Number(e.location_lng), Number(e.location_lat)] };
  if (e.location_override) return { elsewhere: true };
  return null;
}

const FLAG_RANK = { now: 3, away: 2, today: 1 };

/**
 * Each parish's halo: 'now' (on here, now), 'away' (its own event, on now
 * somewhere else) or 'today' (still to come today, here or elsewhere), as
 * { flag, kind }: `kind` is the event_type of the event that lit it — of the
 * soonest, where several light it alike.
 *
 * An event at another parish lights both: the host and the venue toll on the
 * day; once it is on, the venue is 'now' and the host 'away'. A combined
 * service lights its host, which is where everybody is going.
 */
function parishTimeFlags(state) {
  const flags = new Map();
  const now = Date.now();
  for (const e of haloEvents(state)) {
    const timing = eventTiming(e, now);
    if (!timing) continue;
    const start = Date.parse(e.start_utc);
    const raise = (pid, flag) => {
      if (!pid) return;
      const had = flags.get(pid);
      const rank = FLAG_RANK[flag], hadRank = had ? FLAG_RANK[had.flag] : 0;
      if (rank > hadRank || (rank === hadRank && start < had.start)) {
        flags.set(pid, { flag, kind: e.event_type || 'other', start });
      }
    };
    const at = heldAt(e);
    if (timing === 'today') {
      raise(e.parish_id, 'today');
      if (at && at.parish) raise(at.parish, 'today');
    } else if (!at) {
      raise(e.parish_id, 'now');
    } else {
      raise(e.parish_id, 'away');
      if (at.parish) raise(at.parish, 'now');
    }
  }
  return flags;
}

/** Start or stop the loop to match the flags, and keep the minute tick going. */
function syncHalos() {
  haloAny = trueFeatures.some(f => f.properties.now || f.properties.away || f.properties.today)
    || venueFeaturesNow.some(f => f.properties.now || f.properties.today);
  if (!haloTimer) {
    haloTimer = setInterval(() => {
      if (haloState && styleLoaded && !document.hidden) refreshHaloFlags();
    }, 60000);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (haloState && styleLoaded) refreshHaloFlags();
      startHaloLoop();
    });
  }
  if (!map || !map.getLayer('parish-halo-now-dot')) return;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) { paintHalos(null); return; }
  haloInView = litInView();
  startHaloLoop();
}

/**
 * Is a lit marker in the view, or near enough to be drawn in it? Near is half
 * a view out each way: a grape stands where its parishes average out, so a lit
 * parish just past the edge can be a ringing grape inside it.
 */
function litInView() {
  const b = map.getBounds();
  const w = (b.getEast() - b.getWest()) / 2, h = (b.getNorth() - b.getSouth()) / 2;
  const W = b.getWest() - w, E = b.getEast() + w, S = b.getSouth() - h, N = b.getNorth() + h;
  const near = (f) => {
    const [x, y] = f.geometry.coordinates;
    return x >= W && x <= E && y >= S && y <= N;
  };
  return trueFeatures.some(f => (f.properties.now || f.properties.away || f.properties.today) && near(f))
    || venueFeaturesNow.some(f => (f.properties.now || f.properties.today) && near(f));
}

/**
 * The loop's two gates that move on their own: the map scrolling on or off
 * the screen, and the view moving onto or away from a lit marker. Once per map.
 */
function setupHaloGates() {
  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      mapOnScreen = entries[entries.length - 1].isIntersecting;
      startHaloLoop();
    }).observe(map.getContainer());
  }
  let lastCheck = 0;
  const check = () => {
    haloInView = haloAny && litInView();
    startHaloLoop();
  };
  // Mid-move, a few times a second catches a lit marker coming into view.
  map.on('move', () => {
    const now = performance.now();
    if (now - lastCheck > 250) { lastCheck = now; check(); }
  });
  map.on('moveend', check);
}

// Labels fade in and out over 300ms as they are placed, and after placing
// them again MapLibre draws every frame for those 300ms. It places them again
// after any change at all, so a halo frame every 66ms meant it never stopped
// drawing. On a still map no label is placed differently, so the fade is off
// while the map is still and back the moment it moves, where it shows.
// (_fadeDuration is the vendored MapLibre 4.7.1's own, read on every frame.)
const LABEL_FADE_MS = 300;
function setupStillLabels() {
  if (!('_fadeDuration' in map)) return;
  let settle = 0;
  map._fadeDuration = 0;
  map.on('movestart', () => { clearTimeout(settle); map._fadeDuration = LABEL_FADE_MS; });
  map.on('moveend', () => {
    clearTimeout(settle);
    settle = setTimeout(() => { map._fadeDuration = 0; }, LABEL_FADE_MS);
  });
}

function haloShows() {
  return haloAny && haloInView && mapOnScreen && !document.hidden && !reducedMotion();
}

/** The minute tick: the same features with their flags worked out again. */
function refreshHaloFlags() {
  const flags = parishTimeFlags(haloState);
  let changed = false;
  for (const f of trueFeatures) {
    const { flag, kind } = flags.get(f.properties.parish_id) || {};
    const now = flag === 'now', away = flag === 'away', today = flag === 'today';
    const halo_kind = kind || '';
    if (f.properties.now !== now || f.properties.away !== away || f.properties.today !== today
      || f.properties.halo_kind !== halo_kind) {
      f.properties = { ...f.properties, now, away, today, halo_kind };
      changed = true;
    }
  }
  // Same positions: the declutter cache is keyed on the token, untouched here.
  if (changed) paintParishSource();
  // A place's square comes and goes with its events, so it is rebuilt whole.
  const venuesChanged = paintVenueSource(haloState);
  if (changed || venuesChanged) syncHalos();
}

function startHaloLoop() {
  if (!haloRaf && haloShows()) haloRaf = requestAnimationFrame(haloFrame);
}

function haloFrame(t) {
  haloRaf = 0;
  if (!map || !haloShows() || !map.getLayer('parish-halo-now-dot')) return;
  if (t - haloLastFrame >= HALO_FRAME_MS) {
    haloLastFrame = t;
    paintHalos(t);
  }
  haloRaf = requestAnimationFrame(haloFrame);
}

// Every halo layer, by the marker it sits under and how it moves. `ring` is
// how far past the marker's edge the toll travels. It was 18–22px, which on a
// grape made a ring 80px across; overlapping, they crowded the city. Now a
// ring stays close enough to read as belonging to its marker. The toll grows
// from nothing at the marker's centre, under it, so it comes out of the dot
// rather than appearing already around it.
const HALO_LAYERS = [
  { id: 'parish-halo-now-dot', edge: HALO_EDGE.dot, move: 'breath', grows: true },
  { id: 'parish-halo-away-dot', edge: HALO_EDGE.dot, move: 'breath', grows: true },
  { id: 'parish-halo-toll-dot', edge: HALO_EDGE.dot, move: 'toll', ring: 9, grows: true },
  { id: 'parish-halo-now-big', edge: HALO_EDGE.big, move: 'breath' },
  { id: 'parish-halo-away-big', edge: HALO_EDGE.big, move: 'breath' },
  { id: 'parish-halo-toll-big', edge: HALO_EDGE.big, move: 'toll', ring: 10 },
  { id: 'venue-halo-now', edge: HALO_EDGE.venue, move: 'breath' },
  { id: 'venue-halo-toll', edge: HALO_EDGE.venue, move: 'toll', ring: 9 },
];

/** One frame of every halo at time `t`; null paints them still. */
function paintHalos(t) {
  // The breath: 0 → 1 → 0, eased at both ends the way breathing is — a ring
  // that swells a little and brightens a little, never leaving the dot.
  const breath = t == null ? 0.6 : (1 - Math.cos((2 * Math.PI * (t % HALO_NOW_MS)) / HALO_NOW_MS)) / 2;
  // The toll: the ring's life from 0 to 1, then still until the next. Nearly
  // even speed outward (a gentle ease, not a spring), and a fade that holds
  // the ring visible most of the way before letting it go.
  const life = t == null ? 0.35 : Math.min(1, (t % HALO_TOLL_MS) / HALO_RING_MS);
  const spread = 1 - Math.pow(1 - life, 1.35);
  const fade = life >= 1 ? 0 : Math.cos(life * Math.PI / 2);
  // A dot grows as the map closes in (dotScale), so its ring moves out with it.
  const k = dotScale(typeof map.getZoom === 'function' ? map.getZoom() : 0);
  for (const h of HALO_LAYERS) {
    if (!map.getLayer(h.id)) continue;
    const edge = h.grows ? h.edge * k : h.edge;
    let r, fill, ring;
    if (h.move === 'breath') {
      // A tight ring hugging the marker; the fill only tints, so a cluster
      // of green parishes does not wash the map.
      r = edge + 3 + 1.5 * breath;
      fill = 0.05 + 0.07 * breath;
      ring = 0.6 + 0.35 * breath;
    } else {
      r = (edge + 2 + h.ring) * spread;
      fill = 0.05 * fade;
      ring = 0.7 * fade;
    }
    map.setPaintProperty(h.id, 'circle-radius', r);
    map.setPaintProperty(h.id, 'circle-opacity', fill);
    map.setPaintProperty(h.id, 'circle-stroke-opacity', ring);
  }
}

// ── Places: an event's own pin, drawn as a square ──────────────────────
//
// The first marker on the map that is not a parish. An event held at a place
// of its own — "Somewhere else" with a pin, in the venue picker — is drawn
// there as a square in its host's jurisdiction colour, labelled with the
// event, and takes the halo of what is on there. Tapping it opens the event,
// focused, in the sheet of the parish running it.
//
// One square per place per host: a weekly class at the same hall is one
// square, and the tap goes to the soonest of them (the one on, if one is).
// Ended events draw nothing. Where a group runs events and has no church of
// its own, this is what it will be on the map.
const VENUE_SOURCE = 'venues';
const VENUE_ICON = 'venue-square';
let venueFeaturesNow = [];

function addVenueSourceAndLayers() {
  map.addSource(VENUE_SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: venueFeaturesNow } });
  if (!map.hasImage(VENUE_ICON)) {
    const img = venueSquareImage();
    map.addImage(VENUE_ICON, img, { sdf: true, pixelRatio: img.pixelRatio });
  }
  // The halos under every marker, the squares over the dots, their names
  // under the parishes' — a parish's name wins a collision with a place's.
  addRingLayers('venue-halo-now', VENUE_SOURCE, ['==', ['get', 'now'], true], 'venue', HALO_NOW, 'parish-circle-shadow');
  addRingLayers('venue-halo-toll', VENUE_SOURCE,
    ['all', ['!=', ['get', 'now'], true], ['==', ['get', 'today'], true]], 'venue', haloKindColor(), 'parish-circle-shadow');
  map.addLayer({
    id: 'venue-square',
    type: 'symbol',
    source: VENUE_SOURCE,
    layout: {
      'icon-image': VENUE_ICON,
      'icon-allow-overlap': true,
      'icon-ignore-placement': true,
      'symbol-sort-key': ['case', ['==', ['get', 'now'], true], 0, 1]
    },
    paint: {
      'icon-color': ['get', 'color'],
      'icon-halo-color': getHalo(),
      'icon-halo-width': 1.5
    }
  }, 'parish-label');
  map.addLayer({
    id: 'venue-label',
    type: 'symbol',
    source: VENUE_SOURCE,
    layout: {
      'text-field': ['get', 'label'],
      'text-font': FONT_MEDIUM,
      'text-size': 11,
      'text-variable-anchor': ['left', 'right'],
      'text-radial-offset': 0.9,
      'text-justify': 'auto',
      'text-padding': 2,
      'text-allow-overlap': false,
      'text-optional': true
    },
    paint: {
      'text-color': ['get', 'color'],
      'text-halo-color': getHalo(),
      'text-halo-width': 2,
      'text-halo-blur': 0
    }
  }, 'parish-label');
}

/**
 * The square, as a signed distance field so one image takes every colour
 * (icon-color) and the ring (icon-halo). MapLibre reads an SDF icon's alpha as
 * 0.75 at the edge, falling by 1/8 per CSS pixel outward. Raw pixels rather
 * than a canvas: it is the same few lines either way, and this way it needs
 * nothing from the browser.
 */
function venueSquareImage() {
  const ratio = 2, size = 24 * ratio;               // 24 CSS px, room for the ring
  const half = 4.75, round = 1.25;                  // the square, CSS px
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Signed distance from the rounded square, in CSS px; negative inside.
      const px = Math.abs((x + 0.5) / ratio - 12) - (half - round);
      const py = Math.abs((y + 0.5) / ratio - 12) - (half - round);
      const d = Math.hypot(Math.max(px, 0), Math.max(py, 0)) + Math.min(Math.max(px, py), 0) - round;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(255 * Math.min(1, Math.max(0, 0.75 - d / 8)));
    }
  }
  return { width: size, height: size, data, pixelRatio: ratio };
}

// ── A favourite's star ─────────────────────────────────────────────────
const FAV_STAR_ICON = 'fav-star';
const FAV_STAR_COLOR = '#f2b01e';

function addFavStarImage() {
  if (map.hasImage(FAV_STAR_ICON)) return;
  const img = favStarImage();
  map.addImage(FAV_STAR_ICON, img, { sdf: true, pixelRatio: img.pixelRatio });
}

/**
 * A five-pointed star, as a signed distance field like the square above, so
 * the halo rings it in the map's own white (or charcoal, in dark).
 */
function favStarImage() {
  const ratio = 2, size = 18 * ratio, c = 9;        // 18 CSS px, room for the ring
  const outer = 5.2, inner = 2.3;
  const pts = [];
  for (let k = 0; k < 10; k++) {
    const r = k % 2 ? inner : outer;
    const a = -Math.PI / 2 + k * Math.PI / 5;
    pts.push([c + r * Math.cos(a), c + r * Math.sin(a)]);
  }
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const qx = (x + 0.5) / ratio, qy = (y + 0.5) / ratio;
      let d = Infinity, inside = false;
      for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
        const [ax, ay] = pts[j], [bx, by] = pts[i];
        const ex = bx - ax, ey = by - ay;
        const t = Math.max(0, Math.min(1, ((qx - ax) * ex + (qy - ay) * ey) / (ex * ex + ey * ey)));
        d = Math.min(d, Math.hypot(qx - ax - t * ex, qy - ay - t * ey));
        if ((ay > qy) !== (by > qy) && qx < ax + (qy - ay) * ex / ey) inside = !inside;
      }
      const sd = inside ? -d : d;
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(255 * Math.min(1, Math.max(0, 0.75 - sd / 8)));
    }
  }
  return { width: size, height: size, data, pixelRatio: ratio };
}

/** The squares the feed's events put on the map, each with its halo. */
function venueFeatures(state) {
  const now = Date.now();
  const groups = new Map();
  for (const e of haloEvents(state)) {
    const at = heldAt(e);
    if (!at || !at.place) continue;
    if (e.is_tombstone || (e.status && e.status !== 'approved')) continue;
    const start = Date.parse(e.start_utc);
    if (!Number.isFinite(start)) continue;
    const end = e.end_utc ? Date.parse(e.end_utc) : start + 3600000;
    if (end < now) continue;
    const p = parishesById.get(e.parish_id);
    if (!p) continue;
    const [lng, lat] = at.place;
    const key = `${e.parish_id}|${lat.toFixed(4)}|${lng.toFixed(4)}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { e, start, at: at.place, p, now: false, today: false, kind: '' }));
    else if (start < g.start) { g.e = e; g.start = start; }
    const timing = eventTiming(e, now);
    if (timing === 'now') g.now = true;
    else if (timing === 'today') {
      if (!g.today || start < g.todayStart) { g.kind = e.event_type || 'other'; g.todayStart = start; }
      g.today = true;
    }
  }
  return [...groups.values()].map((g) => {
    const base = window.rawJurisColor ? window.rawJurisColor(g.p.jurisdiction) : (g.p.color || '#000');
    return {
      type: 'Feature',
      geometry: { type: 'Point', coordinates: g.at },
      properties: {
        event_id: String(g.e.id),
        parish_id: g.e.parish_id,
        label: g.e.title || '',
        color: isDark() ? liftParishColor(base) : base,
        now: g.now,
        today: g.today && !g.now,
        halo_kind: g.kind
      }
    };
  });
}

/** Rebuild the squares; true if anything about them changed. */
function paintVenueSource(state) {
  const next = venueFeatures(state);
  const same = next.length === venueFeaturesNow.length
    && JSON.stringify(next) === JSON.stringify(venueFeaturesNow);
  venueFeaturesNow = next;
  const src = map && map.getSource(VENUE_SOURCE);
  if (src && !same) src.setData({ type: 'FeatureCollection', features: next });
  return !same;
}

function onVenueClick(props) {
  const st = window.agoraStateRef;
  if (!props || !props.parish_id) return;
  // Choosing parishes is about parishes: the square stands in for its host.
  if (st && st.selectionMode) { onParishClick(props.parish_id); return; }
  // The event, in a sheet of its own, and the map stays where it is: the
  // square is already what the reader is looking at, and flying to the host
  // parish took them away from it. Its parish button goes to the parish.
  if (window.agoraOpenEventSheet) window.agoraOpenEventSheet(props.event_id);
  else if (window.openParishSheet) window.openParishSheet(props.parish_id, { focusEventId: props.event_id });
}

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

// A parish's logo becomes its focus sprite when the parish is picked, and not
// before. Baking every parish's at startup downloaded every logo (~700 KB)
// while the map still waited on its fonts, for a sprite only the one picked
// parish ever wears. Until it lands the picked parish is its plain dot, and
// the map is drawn again with the logo once it has.
const logoBaking = new Set();
function bakeFocusLogo(state) {
  const id = state && state.parishSheetFocus;
  const p = id && parishesById.get(id);
  if (!p || !p.logo_path || logoRegistered.has(id) || logoBaking.has(id)) return;
  logoBaking.add(id);
  bakeAndRegisterLogo(p)
    .then(() => {
      const st = window.agoraStateRef || haloState;
      if (map && styleLoaded && st && st.parishSheetFocus === id) updateMap(st);
    })
    .catch(() => { /* falls back to the circle */ })
    .finally(() => logoBaking.delete(id));
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

// ── Dot declutter ──────────────────────────────────────────────────────
// Pushing overlapping dots apart, so a crowd can be drawn as the parishes it
// actually contains instead of replaced by a grape.
//
// The work is done in Mercator WORLD pixels rather than screen pixels, and
// that is the whole reason this is affordable. Two fixed lng/lats sit a fixed
// number of pixels apart at a given zoom no matter where the map is panned —
// panning only translates. So the answer depends on zoom alone and can be
// cached per zoom step; dragging the map recomputes nothing.
//
// Recomputed on zoom rather than on every frame: 293 parishes takes about
// 30 ms at national zoom, which is fine once a gesture settles and much too
// slow sixty times a second.
const ZOOM_STEP = 0.25;            // cache granularity; finer than the eye needs
let trueFeatures = [];             // what updateMap built, at real coordinates
let declutterCache = new Map();    // zoom step -> displaced [lng, lat] per feature
let declutterToken = 0;            // bumped when trueFeatures changes, voids the cache

function worldPixels(zoom) {
  return 512 * Math.pow(2, zoom);
}

// The features as the source should see them: displaced in 'dots' mode, and
// the plain truth in 'grapes' mode, where supercluster does the crowding.
function paintedFeatures() {
  if (markerMode() !== 'dots' || !trueFeatures.length || !map) return trueFeatures;
  const step = Math.round(map.getZoom() / ZOOM_STEP) * ZOOM_STEP;
  const cacheKey = declutterToken + ':' + step;
  let moved = declutterCache.get(cacheKey);
  if (!moved) {
    const world = worldPixels(step);
    const pts = trueFeatures.map((f) => {
      const m = maplibregl.MercatorCoordinate.fromLngLat({
        lng: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
      });
      return { x: m.x * world, y: m.y * world };
    });
    const out = window.AgoraDeclutter.declutter(pts, { minDist: DOT_MIN_DISTANCE_PX });
    // Whether a dot moved is decided HERE, in pixels, before the trip back to
    // lng/lat. Comparing the returned coordinates against the originals looks
    // equivalent and is not: every point round-trips through Mercator, so
    // floating-point noise in the last bits marks almost all of them moved,
    // and then no dot anywhere is ever allowed a label.
    moved = out.map((pt, i) => {
      const ll = new maplibregl.MercatorCoordinate(pt.x / world, pt.y / world).toLngLat();
      return {
        at: [ll.lng, ll.lat],
        crowded: Math.hypot(pt.x - pts[i].x, pt.y - pts[i].y) > DOT_SHIFT_EPSILON_PX,
      };
    });
    // One entry per zoom step is ~20 arrays for the whole zoom range; keeping
    // them costs nothing and makes zooming back out instant.
    declutterCache.set(cacheKey, moved);
  }
  // A dot that had to move is in a crowd, and its label would now be pointing
  // at a place the parish is not. Mark it so the label layer can stand down —
  // which also answers "no labels when zoomed out" without a zoom threshold to
  // pick, because being crowded is exactly the condition that matters.
  return trueFeatures.map((f, i) => ({
    type: 'Feature',
    properties: moved[i].crowded ? { ...f.properties, crowded: true } : f.properties,
    geometry: { type: 'Point', coordinates: moved[i].at },
  }));
}

function paintParishSource() {
  const src = map && map.getSource(PARISH_SOURCE);
  if (!src) return;
  src.setData({ type: 'FeatureCollection', features: paintedFeatures() });
}

// Zoom changes how much the dots overlap, so it changes where they settle.
// Bound to zoomend rather than zoom: mid-pinch the existing positions scale
// with the map, which stays stable and readable, and the settle lands once.
function setupDeclutterOnZoom() {
  if (markerMode() !== 'dots') return;
  map.on('zoomend', paintParishSource);
}

// ── One parish in view: its dot pops into its logo ─────────────────────
// When the map holds a single parish, its dot bounces up into the parish's
// logo — the logo, or its acronym in its colour on white, as the parish row
// draws it — and shrinks back into the dot the moment another parish comes
// into view. The owner's ask, October 2026: "nice and playfully".
//
// A DOM marker, not a layer, and the one exception to the rule at the top of
// this file. A bounce is a size that overshoots and settles, and a symbol's
// size is a LAYOUT property: stepping it per frame re-lays the source out in
// the worker every frame. A paint transition cannot overshoot. One element,
// alive only while one parish is in view, with a CSS animation on its face,
// costs nothing; the marker's own transform is MapLibre's, set in the same
// frame as the canvas, so it does not drift from the dot under it.
//
// The dot stays drawn underneath (covered), so a tap still finds it and opens
// the parish as any dot does; the element itself takes no pointer events.
// The feature carries `solo` meanwhile, which moves its name above it and
// gives it the big halo, as the focused parish's logo has. A focused parish
// is already its logo, so it never pops.
let soloId = null;
let soloPop = null;                // { id, marker, face } on the map now
let soloRaf = 0;

function reducedMotion() {
  return matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** The one parish in view, or null: none, several, or the one is focused. */
function soloCandidate() {
  if (!map || !styleLoaded || !trueFeatures.length) return null;
  const b = map.getBounds();
  let only = null;
  for (const f of trueFeatures) {
    if (!b.contains(f.geometry.coordinates)) continue;
    if (only) return null;
    only = f;
  }
  return only && !only.properties.focused ? only : null;
}

function syncSolo() {
  const f = soloCandidate();
  const id = f ? f.properties.parish_id : null;
  if (id === soloId) return;
  soloId = id;
  let changed = false;
  for (const t of trueFeatures) {
    const solo = t.properties.parish_id === id;
    if (!!t.properties.solo !== solo) { t.properties = { ...t.properties, solo }; changed = true; }
  }
  if (changed) paintParishSource();
  popOut();
  if (f) popIn(f);
}

function popIn(f) {
  const p = parishesById.get(f.properties.parish_id) || {};
  const el = document.createElement('div');
  el.className = 'map-pop';
  el.setAttribute('aria-hidden', 'true');
  el.style.setProperty('--pop-ring', f.properties.color || '#64748b');
  const face = document.createElement('span');
  face.className = 'map-pop-face';
  if (p.logo_path) {
    face.classList.add('avatar-logo');
    const img = document.createElement('img');
    img.alt = '';
    img.src = p.logo_path;
    face.appendChild(img);
  } else {
    const text = String(p.acronym || (p.name || '?')[0]).toUpperCase();
    face.classList.add('avatar-acronym');
    face.style.setProperty('--avatar-ink', f.properties.color || '#555');
    const t = document.createElement('span');
    t.className = 'avatar-acronym-text';
    t.dataset.len = String(Math.min(text.length, 5));
    t.textContent = text;
    face.appendChild(t);
  }
  el.appendChild(face);
  const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
    .setLngLat(f.geometry.coordinates)
    .addTo(map);
  soloPop = { id: f.properties.parish_id, marker, face };
}

/** Shrink the pop back into its dot, and take it off the map once it has. */
function popOut() {
  const pop = soloPop;
  if (!pop) return;
  soloPop = null;
  if (reducedMotion()) { pop.marker.remove(); return; }
  pop.face.classList.add('out');
  let gone = false;
  const done = () => { if (!gone) { gone = true; pop.marker.remove(); } };
  pop.face.addEventListener('animationend', done, { once: true });
  setTimeout(done, 600);         // in case the animation never runs (hidden tab)
}

// Checked on every frame of a move, as the map's own markers are: a pinch in
// on a suburb pops the last parish left the moment the others leave the view.
// Cheap — one bounds test per parish, and nothing else unless the answer
// changes. The halos are re-sized here too when they stand still (reduced
// motion), since the loop that normally sizes them is not running.
function setupSolo() {
  map.on('move', () => {
    if (soloRaf) return;
    soloRaf = requestAnimationFrame(() => {
      soloRaf = 0;
      syncSolo();
    });
  });
  map.on('zoomend', () => {
    if (reducedMotion() && haloAny && map.getLayer('parish-halo-now-dot')) paintHalos(null);
  });
}

// ── updateMap: rebuild GeoJSON, apply feature state ────────────────────
/** Frame every parish. False when there are none yet to frame. */
function fitToAllParishes(state) {
  const pts = (state.parishes || []).filter(p => p.id !== '_unassigned' && p.lat != null && p.lng != null);
  if (!pts.length) return false;
  map.fitBounds(padBounds(boundsFromPoints(pts), 0.05), { maxZoom: 6, animate: false });
  return true;
}

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
  }

  // The first-load fit the style could not do because the list was not here
  // yet. Re-checks what the load handler checked: a location or a deep link
  // that arrived in the meantime owns the camera, and wins.
  if (initialFitPending && state.parishes && state.parishes.length) {
    initialFitPending = false;
    const cameraOwned = cameraOwnedBy(state);
    if (!state.locationActive && !cameraOwned && !opts.fit) fitToAllParishes(state);
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
  // Bookmarks likewise: the map shows the parishes that hold them.
  const hardFilterOnEvents = !!state.filters.lang || !!state.filters.bookmarked;

  const locFilter = (state.filters.location && window.AgoraLocations)
    ? window.AgoraLocations.resolveLocation(state.filters.location)
    : null;

  const focusId = state.parishSheetFocus || null;
  bakeFocusLogo(state);
  const timeFlags = parishTimeFlags(state);
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
      solo: p.id === soloId,
      selected: selectedSet ? selectedSet.has(p.id) : false,
      active: activeSet.has(p.id),
      now: (timeFlags.get(p.id) || {}).flag === 'now',
      away: (timeFlags.get(p.id) || {}).flag === 'away',
      today: (timeFlags.get(p.id) || {}).flag === 'today',
      halo_kind: (timeFlags.get(p.id) || {}).kind || '',
      fav: !!(window.agoraIsFavourite && window.agoraIsFavourite(p.id))
    };
    if (logoRegistered.has(p.id)) props.focus_icon_id = `focus_${p.id}`;
    features.push({
      type: 'Feature',
      properties: props,
      geometry: { type: 'Point', coordinates: [p.lng, p.lat] }
    });
  }

  // Keep what was built at true coordinates: the declutter re-derives from it
  // on every zoom, and fitBounds below must frame where the parishes ARE
  // rather than where their dots were nudged to.
  trueFeatures = features;
  declutterToken++;
  declutterCache = new Map();
  paintParishSource();
  paintVenueSource(state);
  haloState = state;
  syncHalos();
  // A filter, a focus or a first load can each leave one parish in view.
  syncSolo();

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
// The two layers that draw a parish's name: beside its dot, and above it when
// focused or selected.
const LABEL_LAYERS = ['parish-label', 'parish-label-above'];

// Querying a layer the style does not have is an error, not an empty answer.
const present = (ids) => ids.filter((id) => map.getLayer(id));

function setupClickHandlers() {
  map.on('click', (e) => {
    // 20 px hit slop around the click — fingers aren't pixel-precise.
    const bbox = [
      [e.point.x - 20, e.point.y - 20],
      [e.point.x + 20, e.point.y + 20]
    ];
    // A tap ON a parish's name selects that parish. Checked first and without
    // the slop: the name sits beside its dot, often nearer to a neighbour's
    // dot than to its own, so the nearest-dot rule below would hand the tap to
    // the wrong parish. A label's hit box is its rendered text, which is
    // exactly the target somebody aimed at.
    const labelHit = map.queryRenderedFeatures([
      [e.point.x - 3, e.point.y - 3],
      [e.point.x + 3, e.point.y + 3]
    ], { layers: present([...LABEL_LAYERS, 'venue-label']) });
    if (labelHit.length && labelHit[0].properties.event_id) {
      onVenueClick(labelHit[0].properties);
      return;
    }
    if (labelHit.length && labelHit[0].properties.parish_id) {
      onParishClick(labelHit[0].properties.parish_id);
      return;
    }
    const features = map.queryRenderedFeatures(bbox, {
      layers: present(['venue-square', 'parish-circle', 'parish-cluster-icon'])
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
    } else if (best.layer.id === 'venue-square') {
      onVenueClick(best.properties);
    } else {
      onParishClick(best.properties.parish_id);
    }
  });

  // Cursor feedback (desktop hover).
  for (const layerId of present(['parish-circle', 'parish-cluster-icon', ...LABEL_LAYERS, 'venue-square', 'venue-label'])) {
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
  map.on('movestart', (e) => {
    clearTimeout(mapPhase);
    clearTimeout(listPhase);
    // A pan or a zoom by the person (a gesture carries its originalEvent; a
    // fit, a fly-to or a resize does not) starts searching the area in view.
    if (e && e.originalEvent && window.agoraSetAreaSearch) window.agoraSetAreaSearch(true);
    // With no area searched, the map narrows nothing and the list stays lit.
    if (!(window.agoraState && window.agoraState.areaSearch)) return;
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
