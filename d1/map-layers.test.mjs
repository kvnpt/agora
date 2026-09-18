// The map's layer stack, read out of public/map.js and inspected.
//
// Here rather than beside map.js because npm test's globs are d1/, worker/ and
// scripts/, and d1/ is already where the tests that read public/ live —
// slugs, dates, locations and the colour table are all frontend files tested
// from this directory.
//
// Not a text grep. map.js is a classic script, so running it in a vm context
// with the browser it expects stubbed out gives the actual layer specs the
// browser would get, and the assertions below are about those objects.
//
// What this pins is the thing a drop shadow on a MapLibre label is built on:
// a symbol layer has one halo, the crisp outline is already spending it, so
// the shadow is a SECOND layer — and the pair only stays a pair because
// MapLibre folds layers sharing a source, a filter and a layout into one
// bucket, laid out and collision-tested once. These labels use
// text-variable-anchor. Split the bucket and the underlay is free to place
// itself on the other side of the dot, and to block the text it is meant to
// sit under. The difference between the two layers must therefore be PAINT
// and nothing else, which is a thing a future edit can break silently.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';

// Build the stack once: run map.js as the browser would, hand
// addParishSourceAndLayers a map that records instead of rendering.
function buildLayers() {
  const added = [];
  const fakeMap = {
    addSource() {},
    addLayer(spec) { added.push(spec); },
    hasImage: () => false,
    addImage() {},
    getSource: () => null,
  };
  const ctx = {
    window: {},
    document: { documentElement: {}, createElement: () => ({ getContext: () => null }) },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: () => Promise.resolve({ ok: false }),
    console,
    setTimeout,
    clearTimeout,
    Image: class {},
    Blob: class {},
    URL: { createObjectURL: () => '', revokeObjectURL() {} },
    __fakeMap: fakeMap,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('public/map.js', 'utf8'), ctx);
  // `map` is a top-level `let`, so it lives in the context's lexical scope
  // rather than on the context object — assign to it from inside.
  vm.runInContext('map = __fakeMap; addParishSourceAndLayers();', ctx);
  return added;
}

const LAYERS = buildLayers();
const byId = Object.fromEntries(LAYERS.map((l) => [l.id, l]));
const order = LAYERS.map((l) => l.id);

// Every pair: the shadow underlay, and the crisp layer it sits under.
const PAIRS = [
  ['parish-label-shadow', 'parish-label'],
  ['parish-label-above-shadow', 'parish-label-above'],
];

test('every parish label layer has a shadow underlay', () => {
  const labelLayers = LAYERS
    .filter((l) => l.type === 'symbol' && l.layout && l.layout['text-field'])
    .map((l) => l.id);
  // The cluster overflow badge is the exception and stays one: it sits on the
  // grape sprite, which carries its own baked drop-shadow, and its halo is
  // the grape's own purple rather than the scheme's.
  const wanted = labelLayers.filter((id) => id !== 'parish-cluster-overflow');
  for (const [shadow, crisp] of PAIRS) {
    assert.ok(wanted.includes(crisp), `${crisp} is gone`);
    assert.ok(wanted.includes(shadow), `${crisp} has lost its shadow underlay`);
  }
  assert.deepEqual(
    wanted.filter((id) => !PAIRS.flat().includes(id)), [],
    'a parish label layer was added without a shadow partner');
});

test('a shadow and its label share a layout, or they stop being a pair', () => {
  // The bucket-grouping key. MapLibre compares these; so does this test.
  for (const [shadow, crisp] of PAIRS) {
    assert.deepEqual(byId[shadow].layout, byId[crisp].layout,
      `${shadow} and ${crisp} would be laid out separately`);
    assert.deepEqual(byId[shadow].filter, byId[crisp].filter,
      `${shadow} and ${crisp} would be bucketed separately`);
    assert.equal(byId[shadow].source, byId[crisp].source);
    assert.equal(byId[shadow].type, byId[crisp].type);
  }
});

test('the offset that makes it a shadow is a paint property', () => {
  // text-translate in layout would split the bucket — which is the whole
  // reason the shadow can be offset at all.
  for (const [shadow] of PAIRS) {
    assert.ok(byId[shadow].paint['text-translate'],
      `${shadow} does not translate, so it is directly under the text`);
    assert.ok(!('text-translate' in byId[shadow].layout),
      `${shadow} moved text-translate into layout`);
  }
});

test('a shadow paints under the thing it is a shadow of', () => {
  // addLayer order is bottom-to-top: no beforeId is passed anywhere here.
  for (const [shadow, crisp] of PAIRS) {
    assert.ok(order.indexOf(shadow) < order.indexOf(crisp),
      `${shadow} paints over ${crisp}`);
  }
  assert.ok(order.indexOf('parish-circle-shadow') < order.indexOf('parish-circle'),
    'the dot shadow paints over the dot');
  // The focused parish with a logo draws no circle at all — the sprite covers
  // it — and the same shadow layer is what that sprite casts.
  assert.ok(order.indexOf('parish-circle-shadow') < order.indexOf('parish-focus-icon'),
    'the dot shadow paints over the focus logo');
});

// Enough of the MapLibre expression language to evaluate the paint
// expressions in this file against a feature: ['case'], ['all'], ['=='],
// ['has'] and ['get']. Evaluating beats pulling branches out by index — the
// dot's radius has a branch its stroke width does not, so the two do not line
// up branch for branch and pairing them positionally would be inventing a
// match that is not there.
function evaluate(expr, props) {
  if (!Array.isArray(expr)) return expr;
  const [op, ...args] = expr;
  switch (op) {
    case 'case': {
      for (let i = 0; i + 1 < args.length; i += 2) {
        if (evaluate(args[i], props)) return evaluate(args[i + 1], props);
      }
      return evaluate(args[args.length - 1], props);
    }
    case 'all': return args.every((a) => evaluate(a, props));
    case 'any': return args.some((a) => evaluate(a, props));
    case '==': return evaluate(args[0], props) === evaluate(args[1], props);
    case '!=': return evaluate(args[0], props) !== evaluate(args[1], props);
    case '!': return !evaluate(args[0], props);
    case 'has': return Object.prototype.hasOwnProperty.call(props, args[0]);
    case 'get': return props[args[0]];
    default: throw new Error('unhandled expression: ' + op);
  }
}

test('the dot shadow reaches past the halo ring the dot draws', () => {
  // Inside the ring the shadow is invisible: the dot is opaque and its stroke
  // is the halo colour. A shadow radius that did not clear radius + stroke
  // would render nothing at all — the layer would be there and cost a draw
  // call and show nothing, which is the failure that looks like it works.
  const dot = byId['parish-circle'].paint;
  const shadow = byId['parish-circle-shadow'].paint;
  // Every state updateMap can put on a feature. The logo case draws no circle
  // at all (radius 0) and the sprite covers it instead, laid out by
  // bakeAndRegisterLogo at 32 CSS px across.
  const STATES = [
    ['a plain dot', {}, null],
    ['the selected dot', { selected: true }, null],
    ['the focused dot', { focused: true }, null],
    ['the focused parish\'s logo', { focused: true, focus_icon_id: 'focus_x' }, 16],
  ];
  for (const [what, props, spriteEdge] of STATES) {
    const edge = spriteEdge != null
      ? spriteEdge
      : evaluate(dot['circle-radius'], props) + evaluate(dot['circle-stroke-width'], props);
    const cast = evaluate(shadow['circle-radius'], props);
    assert.ok(cast > edge,
      `${what}: shadow radius ${cast} does not clear its ${edge} px edge`);
  }
});

test('both schemes get a shadow colour, from CSS rather than from here', () => {
  // --map-shadow flips with prefers-color-scheme exactly as --halo does; a
  // literal here would be one of them ignored.
  const src = fs.readFileSync('public/map.js', 'utf8');
  assert.ok(src.includes("getPropertyValue('--map-shadow')"),
    'map.js no longer reads the shadow colour from CSS');
  const css = fs.readFileSync('public/app.css', 'utf8');
  const dark = css.slice(css.indexOf('@media (prefers-color-scheme: dark)'));
  assert.ok(/--map-shadow:/.test(css.slice(0, css.indexOf('@media'))),
    'app.css has no light-mode --map-shadow');
  assert.ok(/--map-shadow:/.test(dark),
    'app.css has no dark-mode --map-shadow, so the light one is used on both');
});
