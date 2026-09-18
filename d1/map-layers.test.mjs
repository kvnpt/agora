// The map's layer stack, read out of public/map.js and inspected.
//
// Here rather than beside map.js because npm test's globs are d1/, worker/ and
// scripts/, and d1/ is already where the tests that read public/ live —
// slugs, dates, locations and the colour table are all frontend files tested
// from this directory.
//
// Not a text grep. map.js is a classic script, so running it in a vm context
// with the browser it expects stubbed out gives the actual layer specs and the
// actual sprite-drawing calls the browser would get, and the assertions below
// are about those.
//
// WHAT IS BEING PINNED. A label's drop shadow is an icon in the label's own
// layer, stretched to the text by icon-text-fit. The obvious alternative — a
// second, translated, dark copy of the text underneath — is not a tuning
// problem but a dead end: a symbol layer's only soft edge is text-halo-blur,
// that halo is drawn per glyph from a distance field with about three SDF
// pixels of border, and past roughly 1.4 screen pixels at text-size 11 it
// stops growing and is clipped square to each glyph's quad. Worse, the quads
// overlap between letters and composite into darker patches. Every assertion
// here exists to stop some part of the icon arrangement quietly regressing
// back towards that.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';

// Run map.js as the browser would, and hand addParishSourceAndLayers a map
// that records instead of rendering. The canvas records too — the shadow
// sprite is drawn, not declared, so the only way to check it is to watch the
// drawing happen.
function buildStack() {
  const added = [];
  const images = {};
  const canvasCalls = [];

  function fakeContext(canvas) {
    const ctx = {
      canvas,
      shadowColor: '', shadowBlur: 0, shadowOffsetX: 0, shadowOffsetY: 0, fillStyle: '',
      _scale: [1, 1],
      scale(x, y) { ctx._scale = [ctx._scale[0] * x, ctx._scale[1] * y]; canvasCalls.push({ op: 'scale', x, y }); },
      beginPath() {}, closePath() {}, moveTo() {}, arcTo() {}, rect(...a) { ctx._shape = a; },
      roundRect(...a) { ctx._shape = a; },
      strokeStyle: '', lineWidth: 0,
      globalCompositeOperation: 'source-over',
      _draw(op) {
        canvasCalls.push({
          op,
          gco: ctx.globalCompositeOperation,
          shape: ctx._shape,
          scale: ctx._scale.slice(),
          lineWidth: ctx.lineWidth,
          shadowOffsetX: ctx.shadowOffsetX,
          shadowOffsetY: ctx.shadowOffsetY,
          shadowBlur: ctx.shadowBlur,
          shadowColor: ctx.shadowColor,
        });
      },
      fill() { ctx._draw('fill'); },
      stroke() { ctx._draw('stroke'); },
      getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      drawImage() {}, save() {}, restore() {}, clip() {}, arc() {},
    };
    return ctx;
  }

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
      createElement: (tag) => {
        if (tag !== 'canvas') return {};
        const c = { width: 0, height: 0 };
        c.getContext = () => fakeContext(c);
        return c;
      },
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
  return { layers: added, images, canvasCalls };
}

const { layers: LAYERS, images: IMAGES, canvasCalls: CANVAS } = buildStack();
const byId = Object.fromEntries(LAYERS.map((l) => [l.id, l]));
const order = LAYERS.map((l) => l.id);

// Every layer that draws a parish label. The cluster overflow badge is not
// one: it is a count sitting on the grape sprite, which carries its own
// drop-shadow, and its halo is the grape's purple rather than the scheme's.
const LABEL_LAYERS = LAYERS
  .filter((l) => l.type === 'symbol' && l.layout && l.layout['text-field'])
  .filter((l) => l.id !== 'parish-cluster-overflow');

test('every parish label carries a shadow, and it is one object', () => {
  assert.ok(LABEL_LAYERS.length >= 2,
    `expected the default and the emphasised label layers, found ${LABEL_LAYERS.length}`);
  for (const l of LABEL_LAYERS) {
    assert.ok(l.layout['icon-image'], `${l.id} draws a label with no shadow`);
    // Without icon-text-fit the sprite sits at the point at its natural size
    // instead of stretching to the words — a blob beside the label, not under it.
    assert.equal(l.layout['icon-text-fit'], 'both',
      `${l.id}'s shadow is not fitted to its text`);
    assert.ok(IMAGES[l.layout['icon-image']],
      `${l.id} names the image ${l.layout['icon-image']}, which was never registered`);
  }
});

test('the shadow sprite is registered before anything names it', () => {
  // An icon-image pointing at a picture that is not there yet renders the text
  // alone for the first frames. That is the bug that made the cluster grapes
  // vanish at low zoom, and it is invisible in a screenshot taken a second in.
  const names = new Set(LABEL_LAYERS.map((l) => l.layout['icon-image']));
  for (const n of names) assert.ok(IMAGES[n], `${n} was never registered at all`);
  // registerLabelShadowSprite runs at the top of addParishSourceAndLayers, so
  // by the time any addLayer call happened the image already existed.
  assert.ok(CANVAS.some((c) => c.op === 'fill' || c.op === 'stroke'),
    'no sprite was drawn, so the registration never ran');
});

test('the shadow never joins the collision index', () => {
  // The text decides which labels place. An icon that collided would quietly
  // drop labels that used to fit, and an icon that blocked would drop other
  // layers' labels too.
  for (const l of LABEL_LAYERS) {
    assert.equal(l.layout['icon-allow-overlap'], true,
      `${l.id}'s shadow can be collided away, leaving a label with no shadow`);
    assert.equal(l.layout['icon-ignore-placement'], true,
      `${l.id}'s shadow takes a slot in the collision index`);
  }
});

test('a collided-away label takes its shadow with it', () => {
  // text-optional true means "draw the icon even when the text did not fit",
  // which with an icon in the layer is a pool of shadow with nothing over it.
  for (const l of LABEL_LAYERS) {
    assert.notEqual(l.layout['text-optional'], true,
      `${l.id} would leave an orphan shadow where its text was collided away`);
  }
});

test('the sprite is nine-sliced so a long label does not distort it', () => {
  for (const [id, img] of Object.entries(IMAGES)) {
    const o = img.options || {};
    if (!o.content) continue;
    const [l, t, r, b] = o.content;
    assert.ok(r > l && b > t, `${id}'s content box is inside out`);
    assert.ok(r <= img.data.width && b <= img.data.height,
      `${id}'s content box runs off the image`);
    // The stretchable band has to sit inside the content box, or stretching a
    // label wide would pull the blurred corners apart.
    for (const axis of ['stretchX', 'stretchY']) {
      assert.ok(Array.isArray(o[axis]) && o[axis].length === 1, `${id} has no ${axis}`);
      const [from, to] = o[axis][0];
      const [lo, hi] = axis === 'stretchX' ? [l, r] : [t, b];
      assert.ok(from >= lo && to <= hi && to > from,
        `${id}'s ${axis} ${from}..${to} is not inside its content box ${lo}..${hi}`);
    }
  }
});

test('the blur lands on the sprite, not a canvas-width away', () => {
  // The sprite is drawn by putting an opaque shape off the left edge of the
  // canvas and offsetting its SHADOW back into view, because that is the one
  // blur every browser has (ctx.filter is missing on Safari before 17, where
  // it fails silently into a hard-edged grey slab).
  //
  // The trap: shadowOffsetX and shadowBlur are specified as NOT affected by
  // the current transform. Scale the context for devicePixelRatio and the
  // shape moves while its shadow does not, so the blur lands off-canvas and
  // every label gets a dark smear beside it instead of a shadow under it.
  // Checked as the invariant rather than as "do not call scale": wherever the
  // shape is and however the context is scaled, the shadow has to come to rest
  // on the content box.
  const drawn = CANVAS.filter((c) => c.op === 'fill' || c.op === 'stroke');
  // The slab, then the punch that hollows it.
  assert.equal(drawn.length, 2, `expected the slab and its punch, saw ${drawn.length}`);
  const f = drawn[0];
  assert.ok(f.shadowBlur > 0, 'the sprite is drawn with no blur at all');
  assert.ok(f.shape, 'nothing was actually drawn');
  const [sx, sy] = f.shape;
  const landsX = sx * f.scale[0] + f.shadowOffsetX;
  const landsY = sy * f.scale[1] + f.shadowOffsetY;

  const img = IMAGES['label-shadow'];
  assert.ok(img, 'the label shadow sprite is not registered under the name the layers use');
  const [cl, ct] = img.options.content;
  assert.ok(Math.abs(landsX - cl) <= 1,
    `the shadow lands at x=${landsX}, but the content box starts at ${cl}`);
  assert.ok(Math.abs(landsY - ct) <= 1,
    `the shadow lands at y=${landsY}, but the content box starts at ${ct}`);
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

test('a shadow paints under the thing it is a shadow of', () => {
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
  // literal here would be one of them ignored. The sprite bakes the colour in,
  // so it is rebuilt on the scheme change with the layers that use it.
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

test('the sprite is hollowed, so a multi-line label gets no grey slab', () => {
  // icon-text-fit matches the icon to the text's bounding BOX. A centred
  // three-line label fills maybe half of that box, so a solid sprite shows
  // through everywhere the words do not reach and reads as a rectangle parked
  // on the map.
  //
  // Drawing a ring instead does NOT hollow it, which is the trap this pins:
  // MapLibre stretches by replicating a band through the sprite's middle, so a
  // ring blurred softly enough to look like a shadow bleeds across its own
  // hole and the middle band carries that bleed into every wide label. The
  // hole has to be cut AFTER the blur, with destination-out.
  const drawn = CANVAS.filter((c) => c.op === 'fill' || c.op === 'stroke');
  assert.equal(drawn.length, 2);
  const [slab, punch] = drawn;
  assert.equal(slab.gco, 'source-over', 'the slab is not drawn normally');
  assert.equal(punch.gco, 'destination-out',
    'the second pass does not erase, so the sprite is solid and every ' +
    'multi-line label gets a slab behind it');
  assert.ok(punch.shadowBlur < slab.shadowBlur,
    'the punch is blurred as much as the slab, which softens the hole away again');

  // And the hollow has to survive stretching: the band MapLibre replicates
  // runs through the middle, which is the part the punch took to zero.
  const img = IMAGES['label-shadow'];
  const [cl, ct, cr, cb] = img.options.content;
  const midX = (cl + cr) / 2, midY = (ct + cb) / 2;
  for (const [axis, mid] of [['stretchX', midX], ['stretchY', midY]]) {
    const [from, to] = img.options[axis][0];
    assert.ok(from <= mid && to >= mid,
      `${axis} ${from}..${to} does not run through the hollow at ${mid}`);
  }
});

test('the sprite can fit the shortest label on the map', () => {
  // The corners are the part icon-text-fit cannot shrink. 19 of the 293 real
  // parish labels are as short as "St Sava" — about 38 css px at text-size 11
  // — and a sprite whose fixed corners are wider than that blows out into a
  // donut around the word instead of a shadow under it.
  const img = IMAGES['label-shadow'];
  const dpr = img.options.pixelRatio;
  const [from, to] = img.options.stretchX[0];
  // Everything but the stretchable band has to be drawn at natural size.
  const fixedCss = (img.data.width - (to - from)) / dpr;
  const SHORTEST_LABEL_CSS = 38 + 6;   // "St Sava" at 11 px, plus the fit padding
  assert.ok(fixedCss < SHORTEST_LABEL_CSS * 2.2,
    `the sprite's fixed parts are ${fixedCss.toFixed(0)} css px wide, far past the ` +
    `${SHORTEST_LABEL_CSS} px of the shortest real label`);
});
