// Location slugs, and the geometry behind them.
//
// The state matcher reads the postal address first and the pin second, so
// most of what these tests pin down is the second half: the two Australian
// borders that no rectangle survives. Both were wrong on the first attempt in
// ways only real coordinates showed — Mildura and Robinvale read as New South
// Wales, Queanbeyan as the ACT, Albury as Victoria — so the fixture is the
// coordinates that caught them.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../public/shared/locations.js');
const S = require('../public/shared/slugs.js');

// Real parishes, at the borders. lat/lng from production; `state` is what the
// parish's own postal address says, which is the answer geometry has to reach
// on its own for the ones whose address is missing or unparseable.
const BORDER_CASES = [
  ['Mildura VIC (Murray, north bank is NSW)',        -34.2426717, 142.0928054, 'VIC'],
  ['Robinvale VIC (Murray)',                         -34.5895182, 142.7749698, 'VIC'],
  ['Albury NSW (Murray, Wodonga is VIC)',            -36.0778536, 146.9187835, 'NSW'],
  ['Queanbeyan NSW (just outside the ACT)',          -35.3537354, 149.2374836, 'NSW'],
  ['Canberra ACT',                                   -35.2809,    149.1300,    'ACT'],
  ['Tweed Heads NSW (1 km from Queensland)',         -28.178664,  153.536999,  'NSW'],
  ['Coolangatta QLD (the other side of that line)',  -28.1670,    153.5360,    'QLD'],
  ['Goondiwindi QLD (river border, inland)',         -28.5480,    150.3090,    'QLD'],
  ['Moree NSW',                                      -29.4658,    149.8416,    'NSW'],
  ['Hobart TAS',                                     -42.882509,  147.328123,  'TAS'],
  ['Bunbury WA',                                     -33.32678,   115.636698,  'WA'],
  ['Darwin NT',                                      -12.4634,    130.8456,    'NT'],
  ['Adelaide SA',                                    -34.9285,    138.6007,    'SA'],
  ['Williamstown VIC',                               -37.861179,  144.889857,  'VIC'],
  ['Kalkallo VIC',                                   -37.530952,  144.949654,  'VIC'],
  ['Allansford VIC',                                 -38.386862,  142.591937,  'VIC'],
];

test('the pin alone resolves the right state at every border', () => {
  for (const [label, lat, lng, expected] of BORDER_CASES) {
    assert.equal(L.auStateFromPoint(lat, lng), expected, label);
  }
});

test('a pin outside Australia resolves to no state', () => {
  // Auckland's postcode is 1041 and Wellington's 6022 — inside the New South
  // Wales and Western Australian ranges respectively. The pin is what stops a
  // New Zealand parish answering to /nsw.
  const auckland = { lat: -36.884522, lng: 174.747991, address: '455 Dominion Road, Mount Eden, Auckland 1041' };
  const wellington = { lat: -41.309725, lng: 174.825026, address: '62 Darlington Rd, Wellington, 6022 New Zealand' };
  assert.equal(L.parishAuState(auckland), null);
  assert.equal(L.parishAuState(wellington), null);
  assert.ok(L.locationMatchesParish(L.resolveLocation('nz'), auckland));
  assert.ok(L.locationMatchesParish(L.resolveLocation('nsw'), auckland) === false);
});

test('addresses name their state, dots and all', () => {
  assert.equal(L.auStateFromAddress('242 Cleveland St. Redfern N.S.W, 2016'), 'NSW');
  assert.equal(L.auStateFromAddress('20 Parker St. Northbridge W.A. 6003'), 'WA');
  assert.equal(L.auStateFromAddress('Cnr Kamerunga & Fairweather Rds, Redlynch (Cairns), QLD 4870'), 'QLD');
  assert.equal(L.auStateFromAddress('11 Henry St, Punchbowl NSW 2196'), 'NSW');
  assert.equal(L.auStateFromAddress('Religious Centre, 38 Exhibition Walk, Clayton VIC 3168'), 'VIC');
  assert.equal(L.auStateFromAddress(''), null);
});

test('both spellings of a region resolve to one canonical slug', () => {
  for (const [input, slug] of [
    ['qld', 'qld'], ['queensland', 'qld'], ['QUEENSLAND', 'qld'],
    ['nsw', 'nsw'], ['new-south-wales', 'nsw'], ['New South Wales', 'nsw'],
    ['act', 'act'], ['canberra', 'act'], ['cbr', 'act'],
    ['syd', 'syd'], ['sydney', 'syd'],
    ['nz', 'nz'], ['aotearoa', 'nz'],
    ['ph', 'ph'], ['phl', 'ph'], ['philippines', 'ph'],
    ['fj', 'fj'], ['fiji', 'fj'],
  ]) {
    const loc = L.resolveLocation(input);
    assert.ok(loc, `${input} did not resolve`);
    assert.equal(loc.slug, slug, input);
  }
  assert.equal(L.resolveLocation('filo'), null, '"filo" is a demonym, not a country code — ph is the slug');
  assert.equal(L.resolveLocation('nowhere'), null);
});

test('cities do not swallow their neighbours', () => {
  const at = (lat, lng) => ({ lat, lng });
  const inCity = (slug, p) => L.locationMatchesParish(L.resolveLocation(slug), p);

  assert.ok(inCity('bne', at(-27.4698, 153.0251)), 'Brisbane CBD is in Brisbane');
  assert.ok(!inCity('bne', at(-28.0167, 153.4000)), 'the Gold Coast is not Brisbane');
  assert.ok(inCity('ool', at(-28.0167, 153.4000)), 'the Gold Coast is the Gold Coast');

  assert.ok(inCity('syd', at(-33.8688, 151.2093)), 'Sydney CBD');
  assert.ok(!inCity('syd', at(-34.4248, 150.8931)), 'Wollongong is not Sydney');
  assert.ok(!inCity('syd', at(-32.9283, 151.7817)), 'Newcastle is not Sydney');

  assert.ok(inCity('mel', at(-37.8136, 144.9631)), 'Melbourne CBD');
  assert.ok(!inCity('mel', at(-38.1499, 144.3617)), 'Geelong is not Melbourne');
});

test('a city sits inside its own state, and a state covers its cities', () => {
  const brisbane = { lat: -27.4698, lng: 153.0251, address: 'Brisbane QLD 4000' };
  assert.ok(L.locationMatchesParish(L.resolveLocation('qld'), brisbane));
  assert.ok(L.locationMatchesParish(L.resolveLocation('bne'), brisbane));
  assert.ok(!L.locationMatchesParish(L.resolveLocation('nsw'), brisbane));
});

test('Fiji wraps the antimeridian', () => {
  // 177°E and 179.5°W are both Fiji; the longitude test has to wrap or the
  // eastern half of the country falls out of its own bounding box.
  assert.ok(L.locationMatchesParish(L.resolveLocation('fj'), { lat: -18.1416, lng: 178.4419 }));
  assert.ok(L.locationMatchesParish(L.resolveLocation('fj'), { lat: -16.7, lng: -179.9 }));
  assert.ok(!L.locationMatchesParish(L.resolveLocation('fj'), { lat: -33.8688, lng: 151.2093 }));
});

test('every location has a box to frame', () => {
  for (const loc of L.LOCATIONS) {
    const box = L.locationBbox(loc);
    assert.ok(Array.isArray(box) && box.length === 4, `${loc.slug} has no bbox`);
    const [, s, , n] = box;
    assert.ok(n > s, `${loc.slug} bbox is inverted`);
  }
});

test('slugs and aliases are unique across the registry', () => {
  const seen = new Map();
  for (const loc of L.LOCATIONS) {
    for (const key of [loc.slug, ...(loc.aliases || [])]) {
      assert.ok(!seen.has(key), `"${key}" is claimed by both ${seen.get(key)} and ${loc.slug}`);
      seen.set(key, loc.slug);
    }
  }
});

test('a location slug can never also be a jurisdiction', () => {
  // /greek/qld has to have exactly one reading for each segment.
  for (const j of S.JURISDICTIONS) {
    assert.equal(L.resolveLocation(j), null, `${j} resolves as a location as well as a jurisdiction`);
  }
});

test('app.js parses and rebuilds a location segment', () => {
  const app = fs.readFileSync('public/app.js', 'utf8');
  assert.ok(app.includes('resolveLocationSlug(seg)'), 'detectUrlState does not read location slugs');
  assert.ok(app.includes("segs.push(state.filters.location)"), 'buildPathSegs does not write the location back');
  const html = fs.readFileSync('public/index.html', 'utf8');
  assert.ok(html.includes('/shared/locations.js'), 'index.html does not load the registry');
});
