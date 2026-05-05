#!/usr/bin/env node
// Bake the protomaps "dark" theme with a luminance-floor lift, then write the
// result as a static JSON file the client loads at runtime.
//
// Why bake: protomaps' upstream "dark" theme renders too low on the luminance
// scale vs Google/Apple Maps dark — land/roads/water all collapse to near-
// black. Lifting at runtime would walk the layer paint expressions on every
// scheme flip; baking does the work once at build time so the client just
// fetches a pre-computed JSON.
//
// To regenerate (after a protomaps-themes-base update or a lift-algorithm
// change):  node scripts/build-dark-basemap.js
// Then commit the resulting public/protomaps-dark.json.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const LIB_PATH = path.join(ROOT, 'public', 'lib', 'protomaps-themes-base.js');
const OUT_PATH = path.join(ROOT, 'public', 'protomaps-dark.json');

// The lib is a UMD bundle that assigns `protomaps_themes_base` on whatever
// global it can find. Run it in a sandbox and pull the export out.
const libSrc = fs.readFileSync(LIB_PATH, 'utf8');
const ctx = { window: {}, self: {}, globalThis: {}, console };
ctx.globalThis = ctx;
vm.createContext(ctx);
vm.runInContext(libSrc, ctx);

const themes =
  ctx.protomaps_themes_base ||
  ctx.window.protomaps_themes_base ||
  ctx.globalThis.protomaps_themes_base;
if (!themes || typeof themes.default !== 'function') {
  console.error('Could not locate protomaps_themes_base.default after eval. Context keys:', Object.keys(ctx));
  process.exit(1);
}

const darkLayers = themes.default('protomaps', 'dark');
console.log(`Loaded ${darkLayers.length} layers from protomaps_themes_base('protomaps', 'dark')`);

// ── Lift algorithm ───────────────────────────────────────────────────────
// Linear remap of HSL lightness: L_new = floor + L_old * (1 - floor).
// Preserves order between features (water still darker than land than roads)
// while pushing the darkest end up to floor. Saturation also bumped so
// protomaps' muted park greens / water blues approach Apple/Google's
// vividness — the L lift alone left features sitting at neutral grey.
//
// Per-paint-property tuning:
//   FLOOR     = 0.22  — fills/lines/backgrounds. Apple/Google land floor
//   SAT_BOOST = 1.3   — multiplies saturation, clamped to 1.0
const FLOOR = 0.22;
const SAT_BOOST = 1.3;

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  let r, g, b;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    r = hue2rgb(p, q, h + 1 / 3);
    g = hue2rgb(p, q, h);
    b = hue2rgb(p, q, h - 1 / 3);
  }
  return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}

function parseColor(s) {
  if (typeof s !== 'string') return null;
  if (s[0] === '#') {
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    if (hex.length === 4) hex = hex.split('').map(c => c + c).join('');
    if (hex.length === 6) {
      return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
    }
    if (hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: parseInt(hex.slice(6, 8), 16) / 255
      };
    }
  }
  const m = s.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] !== undefined ? +m[4] : 1 };
  return null;
}

function toHex2(n) {
  return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
}

function liftColor(s, opts) {
  const c = parseColor(s);
  if (!c) return s;
  // eslint-disable-next-line prefer-const
  let [h, sat, l] = rgbToHsl(c.r, c.g, c.b);
  l = opts.floor + l * (1 - opts.floor);
  sat = Math.min(1, sat * opts.sat);
  const [r, g, b] = hslToRgb(h, sat, l);
  if (c.a < 1) return `rgba(${r}, ${g}, ${b}, ${c.a})`;
  return '#' + toHex2(r) + toHex2(g) + toHex2(b);
}

// MapLibre paint expressions are arrays/objects with colour strings as leaves.
// Walk recursively so nested `interpolate`/`step`/`match` expressions get
// every embedded colour lifted, while non-colour values pass through.
const COLOR_RE = /^(?:#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/;

function walkAndLift(value, opts) {
  if (typeof value === 'string') {
    return COLOR_RE.test(value) ? liftColor(value, opts) : value;
  }
  if (Array.isArray(value)) return value.map(v => walkAndLift(v, opts));
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = walkAndLift(value[k], opts);
    return out;
  }
  return value;
}

// Single tuning for every colour paint property. Earlier rev had a
// dedicated LABEL_FLOOR for text-color but it overshot — protomaps' own
// place-name colours sit fine at FLOOR.
const DEFAULT_OPTS = { floor: FLOOR, sat: SAT_BOOST };
function optsForKey() {
  return DEFAULT_OPTS;
}

let lifted = 0;
const liftedLayers = darkLayers.map(layer => {
  if (!layer.paint) return layer;
  const newPaint = {};
  for (const k of Object.keys(layer.paint)) {
    if (/color/i.test(k)) {
      const before = JSON.stringify(layer.paint[k]);
      newPaint[k] = walkAndLift(layer.paint[k], optsForKey(k));
      if (JSON.stringify(newPaint[k]) !== before) lifted++;
    } else {
      newPaint[k] = layer.paint[k];
    }
  }
  return { ...layer, paint: newPaint };
});

// ── Hand-tune pass ──────────────────────────────────────────────────────
// Override the global lift on specific layers where we want a deliberate
// hue cast or a darker/brighter feel than the algorithm produces. Edit
// these values directly when iterating with a designer; map ids here
// match protomaps' upstream layer ids.
const HAND_TUNES = {
  // Land + buildings — neutral grey → slate-blue. Same luminance band as
  // protomaps' upstream so the L hierarchy with water/parks/roads survives,
  // just adds a hue cast (Apple/Google dark land both lean blue).
  'background':           { 'background-color': '#3a4458' },
  'earth':                { 'fill-color': '#3a4458' },
  'landuse_aerodrome':    { 'fill-color': '#3a4458' },
  'landuse_pedestrian':   { 'fill-color': '#3a4458' },
  'landuse_pier':         { 'fill-color': '#465062' },
  'landuse_hospital':     { 'fill-color': '#3f4458' },
  'landuse_industrial':   { 'fill-color': '#3c4458' },
  'landuse_school':       { 'fill-color': '#3e4458' },
  'landuse_beach':        { 'fill-color': '#48495a' },
  'landuse_zoo':          { 'fill-color': '#3a4858' },
  'buildings':            { 'fill-color': '#363f52' },

  // Water — darker than land so it actually reads as water against the
  // blue-shifted ground. Lifted from #1f2c4a (too inky) to #2b3d62.
  'water':                { 'fill-color': '#2b3d62' },
  'water_stream':         { 'line-color': '#2b3d62' },
  'water_river':          { 'line-color': '#2b3d62' },

  // Roads — slate-blue family, brighter than land so they stand out without
  // looking white. Hierarchy preserved: casings darker (border), fills
  // lighter, highways/links the lightest. Same hue family as land so the
  // overall map still reads as one coherent palette.
  // Casings (the dark border drawn under each road)
  'roads_tunnels_other_casing':   { 'line-color': '#404a5e' },
  'roads_tunnels_minor_casing':   { 'line-color': '#404a5e' },
  'roads_tunnels_link_casing':    { 'line-color': '#404a5e' },
  'roads_tunnels_major_casing':   { 'line-color': '#404a5e' },
  'roads_tunnels_highway_casing': { 'line-color': '#404a5e' },
  'roads_minor_service_casing':   { 'line-color': '#454f64' },
  'roads_minor_casing':           { 'line-color': '#454f64' },
  'roads_link_casing':            { 'line-color': '#454f64' },
  'roads_major_casing_late':      { 'line-color': '#454f64' },
  'roads_highway_casing_late':    { 'line-color': '#454f64' },
  'roads_major_casing_early':     { 'line-color': '#454f64' },
  'roads_highway_casing_early':   { 'line-color': '#454f64' },
  'roads_bridges_other_casing':   { 'line-color': '#4d5670' },
  'roads_bridges_minor_casing':   { 'line-color': '#454f64' },
  'roads_bridges_link_casing':    { 'line-color': '#454f64' },
  'roads_bridges_major_casing':   { 'line-color': '#454f64' },
  'roads_bridges_highway_casing': { 'line-color': '#454f64' },
  // Tunnels (under bridges) — slightly darker than open roads
  'roads_tunnels_other':          { 'line-color': '#4a5670' },
  'roads_tunnels_minor':          { 'line-color': '#4a5670' },
  'roads_tunnels_link':           { 'line-color': '#4a5670' },
  'roads_tunnels_major':          { 'line-color': '#4a5670' },
  'roads_tunnels_highway':        { 'line-color': '#4a5670' },
  // Standard roads — slate mid-tone
  'roads_other':                  { 'line-color': '#525d76' },
  'roads_minor_service':          { 'line-color': '#525d76' },
  'roads_minor':                  { 'line-color': '#525d76' },
  // Links + majors — lighter so the road network reads
  'roads_link':                   { 'line-color': '#5b6783' },
  'roads_major':                  { 'line-color': '#5b6783' },
  'roads_highway':                { 'line-color': '#646f8b' },
  // Bridges — match same tier as their open-road counterpart
  'roads_bridges_other':          { 'line-color': '#525d76' },
  'roads_bridges_minor':          { 'line-color': '#525d76' },
  'roads_bridges_link':           { 'line-color': '#525d76' },
  'roads_bridges_major':          { 'line-color': '#5b6783' },
  'roads_bridges_highway':        { 'line-color': '#646f8b' },
  // Special
  'roads_runway':                 { 'line-color': '#525d76' },
  'roads_taxiway':                { 'line-color': '#525d76' },
  'roads_pier':                   { 'line-color': '#525c70' },
  'roads_rail':                   { 'line-color': '#2d3848' },

  // Place labels (suburbs, regions, country, road labels) — protomaps ships
  // these around L≈0.47–0.55; on the brighter basemap they need to read as
  // proper labels, not as ghosts of features. Lifted to mid-light grey
  // with slight cool cast to harmonise with the slate basemap.
  'places_subplace':              { 'text-color': '#a4a8b4' },
  'places_locality':              { 'text-color': '#bcc0cc' },
  'places_region':                { 'text-color': '#92969f' },
  'places_country':               { 'text-color': '#aaaeba' },
  'roads_labels_minor':           { 'text-color': '#9a9eaa' },
  'roads_labels_major':           { 'text-color': '#a4a8b4' },
  'address_label':                { 'text-color': '#92969f' },
  'water_waterway_label':         { 'text-color': '#a8b2c4' },
  'water_label_ocean':            { 'text-color': '#a8b2c4' },
  'water_label_lakes':            { 'text-color': '#a8b2c4' }
};

const tunedLayers = liftedLayers.map(layer => {
  const tune = HAND_TUNES[layer.id];
  if (!tune || !layer.paint) return layer;
  const newPaint = { ...layer.paint };
  for (const k of Object.keys(tune)) {
    if (k in newPaint) newPaint[k] = tune[k];
  }
  return { ...layer, paint: newPaint };
});
const tunedCount = Object.keys(HAND_TUNES).filter(id => liftedLayers.some(l => l.id === id)).length;

fs.writeFileSync(OUT_PATH, JSON.stringify(tunedLayers));
const size = fs.statSync(OUT_PATH).size;
console.log(`Lifted ${lifted} colour paint properties.`);
console.log(`Hand-tuned ${tunedCount} layers (land blue-shift, water darker+saturated).`);
console.log(`Wrote ${tunedLayers.length} layers to ${path.relative(ROOT, OUT_PATH)} (${(size / 1024).toFixed(1)} KB)`);
