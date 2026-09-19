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

// Run map.js with just enough browser to reach paintedFeatures().
function paint(parishes, zoom) {
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
    location: { search: '?markers=dots' },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    maplibregl: { MercatorCoordinate },
    __fakeMap: { getZoom: () => zoom, getSource: () => null },
  };
  ctx.window.AgoraDeclutter = { declutter };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('public/map.js', 'utf8'), ctx);
  ctx.__features = parishes.map((p, i) => ({
    type: 'Feature',
    properties: { parish_id: 'p' + i, label: 'P' + i },
    geometry: { type: 'Point', coordinates: [p.lng, p.lat] },
  }));
  return vm.runInContext(
    'map = __fakeMap; trueFeatures = __features; paintedFeatures();', ctx);
}

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
