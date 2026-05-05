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
// Linear remap of HSL lightness: L_new = FLOOR + L_old * (1 - FLOOR).
// Preserves order between features (water still darker than land than roads)
// while pushing the darkest end up to FLOOR. Hue and saturation untouched
// so the basemap retains its existing colour identity.
//
// FLOOR=0.18 targets parity with Apple Maps / Google Maps dark, which
// render their darkest land tones around L≈0.18 (vs protomaps ≈0.07).
const FLOOR = 0.18;

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

function liftColor(s) {
  const c = parseColor(s);
  if (!c) return s;
  const [h, sat, l] = rgbToHsl(c.r, c.g, c.b);
  const newL = FLOOR + l * (1 - FLOOR);
  const [r, g, b] = hslToRgb(h, sat, newL);
  if (c.a < 1) return `rgba(${r}, ${g}, ${b}, ${c.a})`;
  return '#' + toHex2(r) + toHex2(g) + toHex2(b);
}

// MapLibre paint expressions are arrays/objects with colour strings as leaves.
// Walk recursively so nested `interpolate`/`step`/`match` expressions get
// every embedded colour lifted, while non-colour values pass through.
const COLOR_RE = /^(?:#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/;

function walkAndLift(value) {
  if (typeof value === 'string') {
    return COLOR_RE.test(value) ? liftColor(value) : value;
  }
  if (Array.isArray(value)) return value.map(walkAndLift);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = walkAndLift(value[k]);
    return out;
  }
  return value;
}

let lifted = 0;
const liftedLayers = darkLayers.map(layer => {
  if (!layer.paint) return layer;
  const newPaint = {};
  for (const k of Object.keys(layer.paint)) {
    if (/color/i.test(k)) {
      const before = JSON.stringify(layer.paint[k]);
      newPaint[k] = walkAndLift(layer.paint[k]);
      if (JSON.stringify(newPaint[k]) !== before) lifted++;
    } else {
      newPaint[k] = layer.paint[k];
    }
  }
  return { ...layer, paint: newPaint };
});

fs.writeFileSync(OUT_PATH, JSON.stringify(liftedLayers));
const size = fs.statSync(OUT_PATH).size;
console.log(`Lifted ${lifted} colour paint properties.`);
console.log(`Wrote ${liftedLayers.length} layers to ${path.relative(ROOT, OUT_PATH)} (${(size / 1024).toFixed(1)} KB)`);
