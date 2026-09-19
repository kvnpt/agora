// The dot-declutter relaxation. Pixel space, no map, so it tests directly.
//
// Here rather than beside the module because npm test's globs are d1/, worker/
// and scripts/, and d1/ is already where the tests for public/shared/ live.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { declutter } = require('../public/shared/declutter.js');

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// How many pairs are still closer together than they should be.
function overlaps(pts, minDist) {
  let n = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) if (dist(pts[i], pts[j]) < minDist) n++;
  }
  return n;
}

test('dots that were never crowded do not move at all', () => {
  // The whole point of displacing is that it is invisible where it is not
  // needed. A zoomed-in map must put every pin exactly on its parish.
  const pts = [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 0, y: 200 }, { x: 400, y: 400 }];
  const out = declutter(pts, { minDist: 12 });
  for (let i = 0; i < pts.length; i++) {
    assert.equal(out[i].x, pts[i].x, `point ${i} drifted in x`);
    assert.equal(out[i].y, pts[i].y, `point ${i} drifted in y`);
  }
});

test('a crowd is pulled apart', () => {
  // 60 dots inside a 6 px circle — a capital city at national zoom.
  const pts = [];
  for (let i = 0; i < 60; i++) {
    const a = i * 2.39996, r = 6 * Math.sqrt(i / 60);
    pts.push({ x: 500 + r * Math.cos(a), y: 500 + r * Math.sin(a) });
  }
  // Measured at the real dot diameter rather than at minDist: what matters is
  // whether two dots are visually merged, not whether they cleared the gap.
  const DOT = 10.5;
  const before = overlaps(pts, DOT);
  const out = declutter(pts, { minDist: 12 });
  const after = overlaps(out, DOT);
  assert.ok(before > 1500, `expected a dense start, got ${before} merged pairs`);
  assert.ok(after < before * 0.08,
    `declutter left ${after} of ${before} pairs visually merged — it barely spread them`);
});

test('no dot is moved further from its parish than it is allowed', () => {
  // The spring discourages a big lie; maxShift forbids one. A pin that cannot
  // fit stays overlapped rather than being moved somewhere the parish is not.
  const pts = [];
  for (let i = 0; i < 200; i++) {
    const a = i * 2.39996, r = 4 * Math.sqrt(i / 200);
    pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) });
  }
  const maxShift = 25;
  const out = declutter(pts, { minDist: 12, iterations: 150, maxShift });
  for (let i = 0; i < pts.length; i++) {
    assert.ok(dist(out[i], pts[i]) <= maxShift + 1e-6,
      `point ${i} moved ${dist(out[i], pts[i]).toFixed(2)} px, past the ${maxShift} px ceiling`);
  }
});

test('two parishes at one address do not stay stacked', () => {
  // Agora really has these: a parish meeting in another parish's church gets
  // that church's address, offset ten metres — which is zero pixels when the
  // whole country is on screen.
  const pts = [{ x: 10, y: 10 }, { x: 10, y: 10 }, { x: 10, y: 10 }];
  const out = declutter(pts, { minDist: 12, iterations: 120 });
  assert.ok(dist(out[0], out[1]) > 1, 'two exactly coincident dots were left on top of each other');
  assert.ok(dist(out[0], out[2]) > 1, 'three exactly coincident dots were left on top of each other');
});

test('the same input always gives the same output', () => {
  // Recomputed on every zoom change. Anything random here would make the dots
  // jitter each time the user pinched.
  const pts = [];
  for (let i = 0; i < 80; i++) pts.push({ x: (i * 7) % 20, y: (i * 13) % 20 });
  const a = declutter(pts, { minDist: 12 });
  const b = declutter(pts, { minDist: 12 });
  assert.deepEqual(a, b, 'declutter is not deterministic');
});

test('the caller can match output to input by index', () => {
  // updateMap pairs these back up with parish ids positionally. A sort or a
  // filter in here would silently put pins on the wrong parishes.
  const pts = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 900, y: 900 }];
  const out = declutter(pts, { minDist: 12 });
  assert.equal(out.length, pts.length);
  // The far one is identifiable by position and must still be last.
  assert.equal(out[2].x, 900);
  assert.equal(out[2].y, 900);
});

test('degenerate inputs come back unchanged rather than throwing', () => {
  assert.deepEqual(declutter([], { minDist: 12 }), []);
  assert.deepEqual(declutter([{ x: 3, y: 4 }], { minDist: 12 }), [{ x: 3, y: 4 }]);
  assert.deepEqual(declutter([{ x: 3, y: 4 }, { x: 9, y: 9 }], { minDist: 12, iterations: 0 }),
    [{ x: 3, y: 4 }, { x: 9, y: 9 }]);
});
