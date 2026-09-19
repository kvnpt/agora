// The part of map.js that turns decluttered PIXELS back into map coordinates.
//
// The pure relaxation is tested in declutter.test.mjs. What is tested here is
// the wiring around it, which has one trap in it that is invisible by reading:
// every dot round-trips lng/lat -> Mercator -> pixels -> lng/lat, so comparing
// the returned coordinate against the original to decide "did this dot move?"
// answers yes for almost all of them, on floating-point noise in the last
// bits. The consequence is not a crash — it is that every label on the map
// quietly disappears, because a moved dot is not allowed one.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { declutter } = require('../public/shared/declutter.js');

// A real Web Mercator, so the round trip carries real float error rather than
// being an identity that would hide the bug this file exists for.
class MercatorCoordinate {
  constructor(x, y) { this.x = x; this.y = y; }
  static fromLngLat({ lng, lat }) {
    const s = Math.sin((lat * Math.PI) / 180);
    return new MercatorCoordinate(
      (180 + lng) / 360,
      0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI),
    );
  }
  toLngLat() {
    const y2 = 180 - this.y * 360;
    return {
      lng: this.x * 360 - 180,
      lat: (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90,
    };
  }
}

// Run map.js with just enough browser to reach the functions below. `search`
// and `stored` are the only two inputs markerMode() has: the query string and
// whatever a previous visit remembered. `stored` is a real cell rather than a
// stub returning null, so a test can also watch what gets written to it.
function runMapJs({ search = '', stored = null, zoom = 9 } = {}) {
  const remembered = { value: stored };
  const ctx = {
    window: { AgoraDeclutter: { declutter } },
    document: { documentElement: {}, createElement: () => ({ getContext: () => null }) },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: () => Promise.resolve({ ok: false }),
    console: { ...console, warn() {} },
    setTimeout, clearTimeout,
    Image: class {}, Blob: class {},
    URL: { createObjectURL: () => '', revokeObjectURL() {} },
    URLSearchParams,
    location: { search, reload() {} },
    localStorage: {
      getItem: () => remembered.value,
      setItem: (_k, v) => { remembered.value = v; },
      removeItem() { remembered.value = null; },
    },
    maplibregl: { MercatorCoordinate },
    __fakeMap: { getZoom: () => zoom, getSource: () => null },
  };
  ctx.window.AgoraDeclutter = { declutter };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('public/map.js', 'utf8'), ctx);
  return { ctx, remembered };
}

// What the source would be handed for these parishes at this zoom. Asks for
// 'dots' explicitly: these tests are about the displacement, and which mode is
// the DEFAULT is a separate question, pinned separately below.
function paint(parishes, zoom, mode = 'dots') {
  const { ctx } = runMapJs({ search: '?markers=' + mode, zoom });
  ctx.__features = parishes.map((p, i) => ({
    type: 'Feature',
    properties: { parish_id: 'p' + i, label: 'P' + i },
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
  }));
  return vm.runInContext(
    'map = __fakeMap; trueFeatures = __features; paintedFeatures();', ctx);
}

const mode = (opts) => vm.runInContext('markerMode()', runMapJs(opts).ctx);

test('a dot on its own is not marked crowded by the Mercator round trip', () => {
  // THE regression. These three are hundreds of kilometres apart — nothing
  // should move. If "did it move" is decided by comparing the round-tripped
  // coordinate, they all come back marked crowded and lose their labels.
  const out = paint([
    { lng: 151.2, lat: -33.87 },   // Sydney
    { lng: 144.96, lat: -37.81 },  // Melbourne
    { lng: 115.86, lat: -31.95 },  // Perth
  ], 9);
  for (const f of out) {
    assert.notEqual(f.properties.crowded, true,
      `${f.properties.parish_id} was marked crowded although nothing is near it`);
  }
});

test('dots in a genuine pile are marked crowded', () => {
  // Ten parishes inside about a kilometre, seen at national zoom.
  const pile = [];
  for (let i = 0; i < 10; i++) pile.push({ lng: 151.2 + i * 0.002, lat: -33.87 + i * 0.001 });
  const out = paint(pile, 4);
  const crowded = out.filter((f) => f.properties.crowded === true).length;
  assert.ok(crowded >= 8, `only ${crowded} of 10 piled-up dots were marked crowded`);
});

test('crowding falls away as the map zooms in', () => {
  // The label rule rides on this: no zoom threshold is configured anywhere,
  // so "crowded" decaying with zoom is what brings labels back.
  const pile = [];
  for (let i = 0; i < 10; i++) pile.push({ lng: 151.2 + i * 0.002, lat: -33.87 + i * 0.001 });
  const near = paint(pile, 4).filter((f) => f.properties.crowded).length;
  const far = paint(pile, 14).filter((f) => f.properties.crowded).length;
  assert.ok(far < near,
    `crowding did not ease with zoom: ${near} at z4 vs ${far} at z14`);
  assert.equal(far, 0, `${far} dots still crowded at z14, where they are far apart`);
});

test('the painted dots stay in step with the parishes they came from', () => {
  // properties carry the parish id, so a reordering here would put every pin
  // on the wrong parish — and it would look entirely plausible.
  const out = paint([
    { lng: 151.2, lat: -33.87 },
    { lng: 151.201, lat: -33.871 },
    { lng: 144.96, lat: -37.81 },
  ], 6);
  assert.deepEqual(out.map((f) => f.properties.parish_id), ['p0', 'p1', 'p2']);
  // The isolated one is untouched, so its coordinate is still recognisable.
  assert.ok(Math.abs(out[2].geometry.coordinates[0] - 144.96) < 1e-6);
});

// ── Which mode a visitor actually gets ─────────────────────────────────
// Both modes work; these are about which one is reached with no help, and
// about the switch surviving. Nothing else in map.js reads the mode directly
// — it all goes through markerMode() — so this is the whole of the routing.

test('a visitor who has asked for nothing gets the grape clusters', () => {
  // Dots shipped as the default for one round and was switched back. The mode
  // stays reachable; being the default is what it lost.
  assert.equal(mode(), 'grapes');
});

test('the query string still selects either mode, and is remembered', () => {
  // This is the half of the A/B that has to keep working: a link pins a mode,
  // and it survives the next visit without the link.
  for (const want of ['dots', 'grapes']) {
    const { ctx, remembered } = runMapJs({ search: '?markers=' + want });
    assert.equal(vm.runInContext('markerMode()', ctx), want);
    assert.equal(remembered.value, want, `?markers=${want} was not remembered`);
  }
});

test('a remembered choice outlives the link that set it', () => {
  assert.equal(mode({ stored: 'dots' }), 'dots');
});

test('the query string beats the remembered choice', () => {
  // So a link can pin either mode for someone who has already chosen.
  assert.equal(mode({ search: '?markers=grapes', stored: 'dots' }), 'grapes');
  assert.equal(mode({ search: '?markers=dots', stored: 'grapes' }), 'dots');
});

test('a mode nobody has heard of falls back instead of being obeyed', () => {
  assert.equal(mode({ search: '?markers=pins', stored: 'rubbish' }), 'grapes');
});

test('grapes mode leaves every dot exactly where its parish is', () => {
  // supercluster does the crowding there, so displacing first would move dots
  // that are about to be replaced anyway — and a dot coming back marked
  // crowded would silence a label that grapes mode has no reason to hide.
  const pile = [];
  for (let i = 0; i < 10; i++) pile.push({ lng: 151.2 + i * 0.002, lat: -33.87 + i * 0.001 });
  const out = paint(pile, 4, 'grapes');
  out.forEach((f, i) => {
    assert.deepEqual(f.geometry.coordinates, [pile[i].lng, pile[i].lat],
      `${f.properties.parish_id} was displaced in grapes mode`);
    assert.notEqual(f.properties.crowded, true,
      `${f.properties.parish_id} was marked crowded in grapes mode`);
  });
});
