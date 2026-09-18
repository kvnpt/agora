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

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';

// Run map.js as the browser would, and hand addParishSourceAndLayers a map
// that records instead of rendering.
function buildStack() {
  const added = [];
  const images = {};
  const fakeMap = {
    addSource() {},
    addLayer(spec) { added.push(spec); },
    hasImage: (id) => Object.prototype.hasOwnProperty.call(images, id),
    addImage(id, data, options) { images[id] = { data, options }; },
    removeImage(id) { delete images[id]; },
    getSource: () => null,
  };
  const ctx = {
    window: {},
    document: {
      documentElement: {},
      createElement: () => ({ width: 0, height: 0, getContext: () => null }),
    },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    fetch: () => Promise.resolve({ ok: false }),
    console: { ...console, warn() {} },
    setTimeout, clearTimeout,
    Image: class {}, Blob: class {},
    URL: { createObjectURL: () => '', revokeObjectURL() {} },
    __fakeMap: fakeMap,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('public/map.js', 'utf8'), ctx);
  // `map` is a top-level `let`, so it lives in the context's lexical scope
  // rather than on the context object — assign to it from inside.
  vm.runInContext('map = __fakeMap; addParishSourceAndLayers();', ctx);
  return { layers: added, images };
}

const { layers: LAYERS, images: IMAGES } = buildStack();
const byId = Object.fromEntries(LAYERS.map((l) => [l.id, l]));
const order = LAYERS.map((l) => l.id);

// Every layer that draws a parish label. The cluster overflow badge is not
// one: it is a count sitting on the grape sprite, which carries its own
// drop-shadow, and its halo is the grape's purple rather than the scheme's.
const LABEL_LAYERS = LAYERS
  .filter((l) => l.type === 'symbol' && l.layout && l.layout['text-field'])
  .filter((l) => l.id !== 'parish-cluster-overflow');

test('parish labels are lifted by a halo, not by a shadow', () => {
  // This is the assertion that stops a label shadow being reintroduced by
  // someone who has not read why there isn't one. Two shapes were tried:
  //
  //   1. A second, translated text layer. A symbol layer's only soft edge is
  //      text-halo-blur, that halo is drawn per GLYPH from a distance field
  //      with about three SDF pixels of border, and past roughly 1.4 screen
  //      pixels at text-size 11 it stops growing and is clipped square to the
  //      glyph's quad. It comes out as a row of little dark rectangles, one
  //      per letter, with darker patches where adjacent quads overlap.
  //
  //   2. A sprite stretched behind the label with icon-text-fit. That fits
  //      the icon to the text's bounding BOX, and a box is not the shape of a
  //      label: the real "Sts. Cyril and Methodius Community / St Xenia
  //      Church" wraps to three centred lines of 122, 79 and 67 px, so the
  //      shadow stood 28 px past each end of the last one.
  //
  // What draws a text-shaped shadow is an offscreen render-and-blur pass,
  // which MapLibre GL JS does not expose for symbol layers. Anything short of
  // that lands back on one of those two.
  assert.ok(LABEL_LAYERS.length >= 2,
    `expected the default and the emphasised label layers, found ${LABEL_LAYERS.length}`);
  for (const l of LABEL_LAYERS) {
    assert.ok(l.paint['text-halo-width'] > 0, `${l.id} has no halo, so nothing lifts it`);
    assert.ok(!l.layout['icon-image'],
      `${l.id} has grown a shadow sprite again — read the comment above it first`);
    assert.ok(!l.layout['icon-text-fit'],
      `${l.id} fits an icon to its text box, which is the box-shaped shadow coming back`);
    assert.ok(!l.paint['text-translate'],
      `${l.id} is translated, which is how the per-glyph shadow underlay was built`);
  }
  assert.deepEqual(Object.keys(IMAGES), [],
    `addParishSourceAndLayers registers sprites again: ${Object.keys(IMAGES).join(', ')}`);
});

test('a dot that was moved off its parish does not get to keep its label', () => {
  // In 'dots' mode a crowded parish's dot is nudged away from where the parish
  // actually is, so labelling it would point the name at the wrong place. It
  // is also what answers "no labels when zoomed out" without anyone having to
  // pick a zoom threshold: being crowded is exactly the condition that matters.
  const flat = (f) => JSON.stringify(f);
  const def = LAYERS.find((l) => l.id === 'parish-label');
  assert.ok(flat(def.filter).includes('"crowded"'),
    'parish-label no longer skips crowded dots, so every dot in a pile is labelled');

  // The emphasised labels deliberately do NOT check it: the reader asked for
  // that parish by name, so it stays named even in a crowd.
  const above = LAYERS.find((l) => l.id === 'parish-label-above');
  assert.ok(!flat(above.filter).includes('"crowded"'),
    'the focused/selected label now hides itself in a crowd, which is where it is most needed');
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

test('the dot shadow paints under the thing it is a shadow of', () => {
  // addLayer order is bottom-to-top: no beforeId is passed anywhere here.
  assert.ok(order.indexOf('parish-circle-shadow') < order.indexOf('parish-circle'),
    'the dot shadow paints over the dot');
  // The focused parish with a logo draws no circle at all — the sprite covers
  // it — and the same shadow layer is what that sprite casts.
  assert.ok(order.indexOf('parish-circle-shadow') < order.indexOf('parish-focus-icon'),
    'the dot shadow paints over the focus logo');
});

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
