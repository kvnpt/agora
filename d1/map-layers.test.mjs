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
  const sources = {};
  const painted = [];
  const fakeMap = {
    addSource(id, spec) { sources[id] = spec; },
    // Honours beforeId, as MapLibre does: the layer goes under the one named.
    addLayer(spec, before) {
      const at = before ? added.findIndex((l) => l.id === before) : -1;
      if (before && at < 0) throw new Error(`${spec.id} is added before ${before}, which is not there`);
      if (at < 0) added.push(spec); else added.splice(at, 0, spec);
    },
    getLayer: (id) => added.find((l) => l.id === id),
    setPaintProperty(id, prop, value) { painted.push({ id, prop, value }); },
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
  // What the parish layers register, before the places' square is added.
  const parishImages = Object.keys(images);
  vm.runInContext('addVenueSourceAndLayers();', ctx);
  return { layers: added, images, parishImages, sources, painted, ctx };
}

const { layers: LAYERS, images: IMAGES, parishImages: PARISH_IMAGES, sources: SOURCES, painted: PAINTED, ctx: CTX } = buildStack();
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
  assert.deepEqual(PARISH_IMAGES, [],
    `addParishSourceAndLayers registers sprites again: ${PARISH_IMAGES.join(', ')}`);
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
    case '>': return evaluate(args[0], props) > evaluate(args[1], props);
    case 'coalesce': {
      for (const a of args) { const v = evaluate(a, props); if (v != null) return v; }
      return null;
    }
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

test('the stack a visitor gets is the clustered one', () => {
  // The context above has no location and no localStorage, so markerMode()
  // falls through to its default exactly as a private window would — which
  // makes this the source options a first-time visitor is served.
  //
  // 'dots' is not gone, and the routing that reaches it is pinned in
  // map-declutter.test.mjs. What is pinned here is that it is not what
  // happens by default: clustering is a source option, so the mode is decided
  // once, at addSource, and cannot be changed afterwards.
  assert.equal(SOURCES.parishes.cluster, true,
    'the parish source no longer clusters by default, so every visitor gets 293 loose dots');
  assert.ok(SOURCES.parishes.clusterRadius > 0, 'clustering is on with no radius to cluster by');
});

test('grapes gather only dots that would touch, and never close in', () => {
  // A grape where four churches a street apart should be four dots was the
  // complaint: 38px and clustering up to MapLibre's default zoom 14.
  assert.ok(SOURCES.parishes.clusterRadius <= 33, 'the radius gathers only parishes close to touching');
  assert.ok(SOURCES.parishes.clusterMaxZoom != null && SOURCES.parishes.clusterMaxZoom <= 11,
    'grapes form at suburb zoom again (no clusterMaxZoom means 14)');
});

// ── Halos ────────────────────────────────────────────────────────────────

const ALL_HALOS = LAYERS.filter((l) => l.id.startsWith('parish-halo-') || l.id.startsWith('venue-halo-'));
const HALOS = ALL_HALOS.filter((l) => !l.id.endsWith('-inner'));

test('the halos paint under the dots, their shadow included', () => {
  assert.equal(HALOS.filter((l) => l.id.startsWith('parish-')).length, 6,
    'a green breath, a neutral breath and a toll for each size of marker');
  assert.equal(HALOS.filter((l) => l.id.startsWith('venue-')).length, 2,
    'a place\'s square has the green breath and the toll');
  for (const l of ALL_HALOS) {
    assert.ok(order.indexOf(l.id) < order.indexOf('parish-circle-shadow'),
      `${l.id} paints over the dot's shadow, so over the jurisdiction colour`);
  }
});

test('every halo is one thin ring, sized to its marker, and nothing eases between frames', () => {
  // The white inner ring doubled every edge, and rings 80px across overlapped
  // until a city was a mesh of circles. One crisp line, close to the marker.
  assert.deepEqual(ALL_HALOS.filter((l) => l.id.endsWith('-inner')).map((l) => l.id), [],
    'a second ring inside the halo is back');
  for (const l of HALOS) {
    assert.ok(l.paint['circle-stroke-width'] > 0, `${l.id} is not a ring`);
    assert.ok(l.paint['circle-stroke-width'] <= 1.5, `${l.id} is a heavy ring`);
    for (const prop of ['circle-radius', 'circle-opacity', 'circle-stroke-opacity']) {
      assert.deepEqual(l.paint[`${prop}-transition`], { duration: 0, delay: 0 },
        `${l.id} eases ${prop}, which is how the toll shrank back into the dot before each ring`);
    }
  }
  PAINTED.length = 0;
  vm.runInContext('for (let t = 0; t < 3800; t += 100) paintHalos(t);', CTX);
  const widest = Math.max(...PAINTED.filter((p) => p.prop === 'circle-radius').map((p) => p.value));
  assert.ok(widest <= 30, `a halo reaches ${widest}px out from its marker's centre`);
});

test('what the halos animate is a constant, never an expression', () => {
  // A data-driven paint value that changes makes MapLibre re-tile the
  // source. Stepped every frame, that is a worker round trip a frame. The
  // marker sizes are separate layers for exactly this reason.
  PAINTED.length = 0;
  vm.runInContext('paintHalos(1234); paintHalos(null);', CTX);
  assert.ok(PAINTED.length > 0, 'paintHalos painted nothing');
  for (const { id, prop, value } of PAINTED) {
    assert.equal(typeof value, 'number', `${id} ${prop} is stepped as ${JSON.stringify(value)}`);
  }
  for (const l of HALOS) {
    for (const prop of ['circle-radius', 'circle-opacity', 'circle-stroke-opacity']) {
      if (prop in l.paint) assert.equal(typeof l.paint[prop], 'number', `${l.id} starts with ${prop} as an expression`);
    }
  }
});

test('a grape carries the halos of the parishes in it', () => {
  const props = SOURCES.parishes.clusterProperties || {};
  assert.ok(props.now_count && props.today_count,
    'the clustered source drops now/today, so a grape over a service that is on shows nothing');
  assert.ok(props.away_count,
    'the clustered source drops away, so a grape over a parish running something elsewhere is still');
});

test('one halo per marker: green, then the neutral breath, then the toll', () => {
  // Which halo layers draw under a marker with these flags. A dot, and a grape
  // carrying the same flags as counts.
  const drawn = (size, props) => HALOS
    .filter((l) => l.id.startsWith('parish-halo-') && l.id.endsWith(`-${size}`))
    .filter((l) => evaluate(l.filter, props))
    .map((l) => l.id.replace(/^parish-halo-|-(dot|big)$/g, ''));
  const CASES = [
    [{ now: true, away: true, today: true }, ['now']],
    [{ away: true, today: true }, ['away']],
    [{ today: true }, ['toll']],
    [{}, []],
  ];
  for (const [flags, want] of CASES) {
    assert.deepEqual(drawn('dot', flags), want, `a dot flagged ${JSON.stringify(flags)}`);
    const counts = Object.fromEntries(Object.keys(flags).map((k) => [`${k}_count`, 1]));
    assert.deepEqual(drawn('big', { point_count: 3, ...counts }), want, `a grape counting ${JSON.stringify(counts)}`);
  }
  // The neutral breath is the toll's ring in the toll's colour, breathing.
  const away = byId['parish-halo-away-dot'].paint, toll = byId['parish-halo-toll-dot'].paint;
  assert.deepEqual(away['circle-color'], toll['circle-color'], 'the neutral breath is not the toll\'s colour');
  assert.equal(away['circle-stroke-width'], toll['circle-stroke-width'], 'the breath is not the toll\'s ring');
});

test('on now, later today in the parish\'s own zone, and nothing else', () => {
  const NOW = Date.parse('2026-10-11T00:30:00Z');          // 11:30 in Sydney, 13:30 in Auckland
  const at = (iso) => iso;
  const events = [
    { parish_id: 'on', start_utc: at('2026-10-11T00:00:00Z'), end_utc: at('2026-10-11T01:30:00Z') },
    { parish_id: 'later', start_utc: at('2026-10-11T07:00:00Z') },                  // 18:00 Sydney
    { parish_id: 'tomorrow', start_utc: at('2026-10-11T14:00:00Z') },               // 01:00 Monday in Sydney
    { parish_id: 'nz', start_utc: at('2026-10-11T10:30:00Z'), timezone: 'Pacific/Auckland' }, // 23:30 there
    { parish_id: 'nz-late', start_utc: at('2026-10-11T11:30:00Z'), timezone: 'Pacific/Auckland' }, // 00:30 Monday there
    { parish_id: 'off', start_utc: at('2026-10-11T00:00:00Z'), end_utc: at('2026-10-11T01:30:00Z'), status: 'cancelled' },
    { parish_id: 'gone', start_utc: at('2026-10-11T07:00:00Z'), is_tombstone: true },
    { parish_id: 'done', start_utc: at('2026-10-10T22:00:00Z'), end_utc: at('2026-10-10T23:00:00Z') },
  ];
  CTX.__events = events;
  const flags = vm.runInContext(`(() => {
    const real = Date.now;
    Date.now = () => ${NOW};
    try { return Object.fromEntries([...parishTimeFlags({ events: __events })].map(([k, v]) => [k, v.flag])); }
    finally { Date.now = real; }
  })()`, CTX);
  assert.deepEqual({ ...flags }, { on: 'now', later: 'today', nz: 'today' });
});

test('a halo carries the kind of the event that lit it, the soonest where several do', () => {
  const NOW = Date.parse('2026-10-11T00:30:00Z');          // 11:30 in Sydney
  CTX.__events = [
    { parish_id: 'p', event_type: 'talk', start_utc: '2026-10-11T08:00:00Z' },
    { parish_id: 'p', event_type: 'prayer', start_utc: '2026-10-11T07:00:00Z' },
    { parish_id: 'q', event_type: 'prayer', start_utc: '2026-10-11T07:00:00Z' },
    { parish_id: 'q', event_type: 'liturgy', start_utc: '2026-10-11T00:00:00Z', end_utc: '2026-10-11T01:30:00Z' },
    { parish_id: 'r', start_utc: '2026-10-11T07:00:00Z' },
  ];
  const kinds = vm.runInContext(`(() => {
    const real = Date.now;
    Date.now = () => ${NOW};
    try { return Object.fromEntries([...parishTimeFlags({ events: __events })].map(([k, v]) => [k, v.kind])); }
    finally { Date.now = real; }
  })()`, CTX);
  assert.deepEqual({ ...kinds }, { p: 'prayer', q: 'liturgy', r: 'other' });
});

test('the toll\'s ring grows from the marker\'s centre', () => {
  const painted = [];
  CTX.__painted = painted;
  vm.runInContext(`(() => {
    const real = map.setPaintProperty;
    map.setPaintProperty = (id, prop, value) => __painted.push({ id, prop, value });
    try { paintHalos(0); } finally { map.setPaintProperty = real; }
  })()`, CTX);
  const r = painted.find((x) => x.id === 'parish-halo-toll-dot' && x.prop === 'circle-radius');
  assert.ok(r, 'the toll was not painted');
  assert.equal(r.value, 0, 'the toll starts with a radius, so it snaps into view');
});

// ── Held elsewhere ───────────────────────────────────────────────────────

const NOON = Date.parse('2026-10-11T01:00:00Z');                 // 12:00 in Sydney
const withClock = (expr) => vm.runInContext(`(() => {
  const real = Date.now;
  Date.now = () => ${NOON};
  try { return ${expr}; }
  finally { Date.now = real; }
})()`, CTX);

test('an event elsewhere lights where it is, and its host breathes neutral', () => {
  const on = { start_utc: '2026-10-11T00:30:00Z', end_utc: '2026-10-11T02:00:00Z' };
  const later = { start_utc: '2026-10-11T08:00:00Z' };            // 19:00 Sydney
  CTX.__events = [
    // At another parish: on now there, run from here.
    { parish_id: 'host', location_parish_id: 'venue', ...on },
    // At another parish this evening: both toll.
    { parish_id: 'host2', location_parish_id: 'venue2', ...later },
    // At a place with its own pin, and at a place in words only.
    { parish_id: 'host3', location_lat: -34.75, location_lng: 149.7, location_override: 'Antiochian Village', ...on },
    { parish_id: 'host4', location_override: 'AYC Carpark', ...on },
    // On at home beats on elsewhere; on elsewhere beats later today.
    { parish_id: 'busy', ...on },
    { parish_id: 'busy', location_parish_id: 'venue3', ...on },
    { parish_id: 'away-and-later', location_lat: -33.9, location_lng: 151.1, ...on },
    { parish_id: 'away-and-later', ...later },
    // A venue that also has its own evening service: on now wins there too.
    { parish_id: 'venue', ...later },
    // Naming itself as the venue is at home.
    { parish_id: 'self', location_parish_id: 'self', ...on },
  ];
  const flags = withClock('Object.fromEntries([...parishTimeFlags({ events: __events })].map(([k, v]) => [k, v.flag]))');
  assert.deepEqual({ ...flags }, {
    host: 'away', venue: 'now',
    host2: 'today', venue2: 'today',
    host3: 'away', host4: 'away',
    busy: 'now', venue3: 'now',
    'away-and-later': 'away',
    self: 'now',
  });
});

test('a place with a pin is one square per host, tapping to its soonest event', () => {
  vm.runInContext(`parishesById.set('h', { id: 'h', jurisdiction: 'antiochian', color: '#1f6f3f' });`, CTX);
  const VILLAGE = { location_lat: -34.75, location_lng: 149.7, location_override: 'Antiochian Village' };
  CTX.__events = [
    { id: 'done', parish_id: 'h', title: 'Yesterday', start_utc: '2026-10-10T00:00:00Z', ...VILLAGE },
    { id: 'next', parish_id: 'h', title: 'Youth camp', start_utc: '2026-10-11T00:30:00Z', end_utc: '2026-10-11T03:00:00Z', ...VILLAGE },
    { id: 'later', parish_id: 'h', title: 'Camp, day two', start_utc: '2026-10-12T00:00:00Z', ...VILLAGE },
    { id: 'gone', parish_id: 'h', title: 'Cancelled', start_utc: '2026-10-11T00:30:00Z', status: 'cancelled',
      location_lat: -33, location_lng: 150 },
    { id: 'parish', parish_id: 'h', title: 'At a parish', start_utc: '2026-10-11T00:30:00Z', location_parish_id: 'v' },
    { id: 'orphan', parish_id: 'nobody', title: 'No host on file', start_utc: '2026-10-11T00:30:00Z', ...VILLAGE },
  ];
  const squares = withClock('venueFeatures({ events: __events })');
  assert.equal(squares.length, 1, `expected the village once, got ${JSON.stringify(squares.map((f) => f.properties))}`);
  const [sq] = squares;
  assert.deepEqual([...sq.geometry.coordinates], [149.7, -34.75]);
  assert.equal(sq.properties.event_id, 'next', 'the tap goes to the one on now, the soonest');
  assert.equal(sq.properties.parish_id, 'h');
  assert.equal(sq.properties.label, 'Youth camp');
  assert.equal(sq.properties.now, true);
  assert.equal(sq.properties.today, false, 'green and the toll at once');
});

test('the square paints over the dots, under their names, its halos under everything', () => {
  for (const id of ['venue-halo-now', 'venue-halo-toll']) {
    assert.ok(order.indexOf(id) < order.indexOf('parish-circle-shadow'), `${id} paints over the dots`);
  }
  assert.ok(order.indexOf('venue-square') > order.indexOf('parish-circle'), 'the square is under the dots');
  assert.ok(order.indexOf('venue-square') < order.indexOf('parish-label'), 'the square covers parish names');
  assert.ok(order.indexOf('venue-label') < order.indexOf('parish-label'),
    'a place\'s name is placed ahead of a parish\'s, so wins the collision');
  const sq = byId['venue-square'];
  assert.equal(sq.layout['icon-image'], 'venue-square');
  assert.deepEqual(sq.paint['icon-color'], ['get', 'color'], 'the square is not in its host\'s colour');
  assert.ok(IMAGES['venue-square'] && IMAGES['venue-square'].options.sdf, 'the square is not an SDF, so it cannot take a colour');
});

test('the square image is a square: solid inside, the edge at 0.75, clear in the corners', () => {
  const { data, width, height } = IMAGES['venue-square'].data;
  const alpha = (x, y) => data[(y * width + x) * 4 + 3];
  const c = width / 2;
  assert.equal(alpha(c, c), 255, 'the middle is not solid');
  assert.equal(alpha(0, 0), 0, 'the corner of the image is not clear');
  // Along the middle row the edge is at 4.75 CSS px out, 9.5 image px at 2x —
  // the pixel whose centre that is, centres being at half pixels.
  const edge = alpha(Math.floor(c + 9.5), c);
  assert.ok(Math.abs(edge - 191) < 12, `the edge reads ${edge}, not 0.75`);
  // Square, not round: as far out along the diagonal as along the side, the
  // square is still inside where a circle would not be.
  assert.ok(alpha(c + 8, c + 8) > 191, 'the square has rounded into a circle');
  assert.equal(width, height);
});

test('the toll only ever grows, at a near-even pace, and is seen for most of its cycle', () => {
  const at = (t) => {
    PAINTED.length = 0;
    vm.runInContext(`paintHalos(${t});`, CTX);
    const get = (prop) => PAINTED.find((p) => p.id === 'parish-halo-toll-dot' && p.prop === prop).value;
    return { r: get('circle-radius'), o: get('circle-stroke-opacity') };
  };
  const cycle = vm.runInContext('HALO_TOLL_MS', CTX);
  const steps = 40;
  const frames = Array.from({ length: steps }, (_, i) => at((i * cycle) / steps));
  const visible = frames.filter((f) => f.o > 0.05);
  for (let i = 1; i < visible.length; i++) {
    assert.ok(visible[i].r >= visible[i - 1].r, `the ring shrinks while seen (frame ${i})`);
  }
  assert.ok(visible.length / steps >= 0.75, `seen for only ${Math.round((100 * visible.length) / steps)}% of the cycle`);
  // Near-even: the first quarter of the ring's life covers well under half its spread.
  const ring = vm.runInContext('HALO_RING_MS', CTX);
  const r0 = at(0).r, rq = at(ring / 4).r, rEnd = at(ring - 1).r;
  assert.ok((rq - r0) / (rEnd - r0) < 0.45, 'it still springs out of the dot');
});
