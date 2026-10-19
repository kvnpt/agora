// The jurisdiction colour table has to stay one table.
//
// It was three: a literal in the app's script, two constants in
// seeds/parishes.js, and — had it been written by hand — a third copy in the
// migration that paints every parish its jurisdiction's colour. Two of the
// three already disagreed about Greek (#0d5eaf in the seed, #00508f in the
// app), which is the drift that reached the database: a seeded Greek parish
// stored one blue while the app drew another.
//
// These tests pin the two live readers to the shared file. The migration is
// deliberately not pinned — it is a one-time transform against rows that
// already exist, so a later change to a jurisdiction's colour should edit the
// table and leave that file as the history it is.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';

import { JURISDICTIONS, HEX, jurisdictionColorOverrides, PARISH_COLOR_SQL } from '../worker/lib/juris-colors.mjs';

const require = createRequire(import.meta.url);
const { JURISDICTION_COLORS, JURISDICTION_COLOR_FALLBACK, jurisdictionColor,
  setJurisdictionColors, jurisdictionColorFrom } = require('../public/shared/jurisdiction-colors.js');
const Database = require('better-sqlite3');
const { parishes } = require('../seeds/parishes.js');

test('the seed gives no parish a colour: a parish wears its jurisdiction\u2019s', () => {
  // parishes.color went stale under 49 production parishes when /admin
  // repainted their jurisdictions, and only the lite pages still drew it.
  for (const p of parishes) assert.ok(!('color' in p), `${p.id} carries a colour`);
  for (const path of ['d1/seed-parishes.sql', 'd1/seed-parishes.console.sql']) {
    const sql = fs.readFileSync(path, 'utf8');
    assert.doesNotMatch(sql, /\bcolor\b/, `${path} writes a colour`);
  }
});

test('the table covers every jurisdiction the schema allows', () => {
  // A jurisdiction added to the CHECK and not to the table falls through to
  // the grey fallback, which renders as "no jurisdiction" rather than as a
  // missing colour — silent, and only visible as a map full of grey dots.
  const schema = fs.readFileSync('d1/schema.sql', 'utf8');
  const check = /jurisdiction\s+TEXT NOT NULL CHECK\(jurisdiction IN\s*\(([^)]*)\)/.exec(schema);
  assert.ok(check, 'could not find the jurisdiction CHECK in d1/schema.sql');
  const allowed = [...check[1].matchAll(/'([a-z]+)'/g)].map(m => m[1]);
  assert.ok(allowed.length > 1, 'parsed no jurisdictions out of the CHECK');

  for (const j of allowed) {
    // 'other' is the one that is meant to take the fallback.
    if (j === 'other') {
      assert.equal(jurisdictionColor(j), JURISDICTION_COLOR_FALLBACK);
      continue;
    }
    assert.ok(JURISDICTION_COLORS[j], `${j} is allowed by the schema but has no colour`);
  }

  // And the other direction: a colour for a jurisdiction no row can hold.
  for (const j of Object.keys(JURISDICTION_COLORS)) {
    assert.ok(allowed.includes(j), `${j} has a colour but the schema CHECK rejects it`);
  }
});

test('the page reads the shared table rather than its own copy', () => {
  const page = fs.readFileSync('public/next/next.js', 'utf8');
  const juris = page.slice(page.indexOf('const JURIS = {'), page.indexOf('const JURIS_ORDER'));
  assert.deepEqual(juris.match(/#[0-9a-fA-F]{3,8}\b/g) || [], [],
    'the page has grown its own jurisdiction colour literal again');
  assert.ok(/const jColor = \(j\) => \(window\.agoraJurisdictionColor \? window\.agoraJurisdictionColor\(j\)/.test(page),
    'the page no longer reads the shared table');

  // The browser gets it as a <script>, so a missing tag is a ReferenceError
  // on the first parish drawn — and nothing in Node would notice.
  const html = fs.readFileSync('public/index.html', 'utf8');
  assert.ok(html.includes('/shared/jurisdiction-colors.js'),
    'index.html does not load the shared colour table');
});

test('the jurisdiction tabs read the table too, at paint time, after the overrides', () => {
  // A tab painted from a frozen copy is the one surface an /admin override
  // could not move: every other reader goes through jurisdictionColor().
  const page = fs.readFileSync('public/next/next.js', 'utf8');
  const tabs = page.slice(page.indexOf('function renderJurisChips'), page.indexOf('\n  }\n', page.indexOf('function renderJurisChips')));
  assert.ok(tabs.includes('jColor(j)'), 'the tabs no longer resolve their colour at paint time');
  // The overrides arrive with the bundle, and the page draws only once it has it.
  const bundle = fs.readFileSync('public/bundle.js', 'utf8');
  assert.ok(bundle.includes('agoraSetJurisdictionColors(raw.jurisdiction_colors)'),
    'bundle.js no longer applies the overrides');
  const boot = page.slice(page.indexOf('async function boot()'));
  assert.ok(boot.indexOf('await window.agoraBundle.load(') < boot.indexOf('renderJurisChips()'),
    'the tabs are painted before the bundle carrying the overrides is in');
});

// ── the override layer ──────────────────────────────────────────────────
//
// /admin can change a jurisdiction's colour without a deploy. That is one more
// place a colour can come from, which is exactly what this file exists to keep
// honest: the file is still the default, an override is still a row, and
// clearing the row still gives the file's colour back.

test('an override wins, and clearing it gives the file back', () => {
  try {
    setJurisdictionColors({ greek: '#123456' });
    assert.equal(jurisdictionColor('greek'), '#123456');
    // Untouched jurisdictions are unaffected — the layer is per key.
    assert.equal(jurisdictionColor('serbian'), JURISDICTION_COLORS.serbian);
    // 'other' has no default at all and can still be overridden.
    setJurisdictionColors({ other: '#abc' });
    assert.equal(jurisdictionColor('other'), '#abc');
    setJurisdictionColors({});
    assert.equal(jurisdictionColor('greek'), JURISDICTION_COLORS.greek);
    assert.equal(jurisdictionColor('other'), JURISDICTION_COLOR_FALLBACK);
  } finally {
    setJurisdictionColors({});
  }
});

test('a colour that is not a colour is ignored, not painted', () => {
  try {
    // These reach inline styles and a MapLibre paint expression. Falling back
    // to the default is the only safe answer; passing them through is not.
    setJurisdictionColors({ greek: 'red; }', serbian: '', russian: null, romanian: 'rgb(1,2,3)' });
    assert.equal(jurisdictionColor('greek'), JURISDICTION_COLORS.greek);
    assert.equal(jurisdictionColor('serbian'), JURISDICTION_COLORS.serbian);
    assert.equal(jurisdictionColor('russian'), JURISDICTION_COLORS.russian);
    assert.equal(jurisdictionColor('romanian'), JURISDICTION_COLORS.romanian);
  } finally {
    setJurisdictionColors({});
  }
});

test('the Worker and the browser agree on what a colour is', () => {
  for (const good of ['#fff', '#FFFFFF', '#1e3a5f']) assert.ok(HEX.test(good), good);
  for (const bad of ['fff', '#ffff', 'red', '#12345g', '']) assert.ok(!HEX.test(bad), bad);
});

test('the jurisdictions the API accepts are the ones the schema allows', () => {
  // A 400 the schema would have rejected anyway is a better error than a D1
  // constraint failure surfacing as a 500 — but only while the two agree.
  const schema = fs.readFileSync('d1/schema.sql', 'utf8');
  const check = /jurisdiction\s+TEXT NOT NULL CHECK\(jurisdiction IN\s*\(([^)]*)\)/.exec(schema);
  const allowed = [...check[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepEqual([...JURISDICTIONS].sort(), allowed.sort());
});

test('a missing overrides table reads as no overrides, not as an error', () => {
  // Migration 006 can land either side of the deploy that reads it. The bundle
  // is the site's whole feed; a 500 here is the site being down.
  const throwing = { prepare() { throw new Error('no such table: jurisdiction_colors'); } };
  return jurisdictionColorOverrides(throwing).then((r) => assert.deepEqual(r, {}));
});

test('a row holding something that is not a colour never reaches the browser', () => {
  const db = {
    prepare: () => ({
      all: async () => ({ results: [
        { jurisdiction: 'greek', color: '  #00508f ' },
        { jurisdiction: 'serbian', color: 'red; }' },
        { jurisdiction: 'russian', color: null },
      ] }),
    }),
  };
  return jurisdictionColorOverrides(db).then((r) => {
    assert.deepEqual(r, { greek: '#00508f' });
  });
});

test('the dark-mode lift is shared, and lifts only what is too dark to read', () => {
  const J = createRequire(import.meta.url)('../public/shared/jurisdiction-colors.js');
  // The values map.js produced before the lift moved here.
  assert.equal(J.liftForDark('#1e3a5f'), '#80a1cc');
  assert.equal(J.liftForDark('#ffffff'), '#ffffff', 'already bright: unchanged');
  assert.equal(J.liftForDark('not a colour'), 'not a colour');
  // Overrides passed in, not set on the module — an isolate serves many requests.
  assert.equal(J.jurisdictionColorFrom({ greek: '#123456' }, 'greek'), '#123456');
  assert.equal(J.jurisdictionColorFrom({ greek: 'red; }' }, 'greek'), J.JURISDICTION_COLORS.greek);
  assert.equal(J.jurisdictionColorFrom({}, 'other'), J.JURISDICTION_COLOR_FALLBACK);
});

test("in SQL, a parish's colour is its jurisdiction's: a valid override, else the table, else grey", () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE jurisdiction_colors (jurisdiction TEXT PRIMARY KEY, color TEXT NOT NULL);
           CREATE TABLE parishes (id TEXT PRIMARY KEY, jurisdiction TEXT NOT NULL, color TEXT);
           INSERT INTO parishes VALUES ('a', 'antiochian', '#d20000'), ('g', 'greek', NULL),
             ('s', 'serbian', NULL), ('m', 'macedonian', '#d20000'), ('o', 'other', NULL),
             ('r', 'russian', NULL), ('ro', 'romanian', NULL);
           INSERT INTO jurisdiction_colors VALUES ('greek', '#123456'), ('serbian', 'red; }'), ('macedonian', '#abc'),
             ('russian', '#12345g'), ('romanian', '#4E7A27');`);
  const got = Object.fromEntries(db.prepare(`SELECT p.id, ${PARISH_COLOR_SQL} AS c FROM parishes p`).all()
    .map(r => [r.id, r.c]));
  assert.deepEqual(got, {
    a: JURISDICTION_COLORS.antiochian,   // the stored #d20000 is not read
    g: '#123456',                        // /admin's override
    s: JURISDICTION_COLORS.serbian,      // an override that is not a colour falls through
    m: '#abc',                           // three digits is a colour
    o: JURISDICTION_COLOR_FALLBACK,
    r: JURISDICTION_COLORS.russian,      // seven characters, one not hex
    ro: '#4E7A27',                       // capitals are hex too
  });
  // The same answer the browser gets from the same overrides.
  const overrides = { greek: '#123456', macedonian: '#abc' };
  for (const [id, j] of [['a', 'antiochian'], ['g', 'greek'], ['m', 'macedonian'], ['o', 'other']]) {
    assert.equal(got[id], jurisdictionColorFrom(overrides, j), j);
  }
});

test('the colour SQL stays inside what D1 accepts', () => {
  // D1 caps a LIKE or GLOB pattern at 50 bytes and better-sqlite3 does not, so
  // a pattern one digit at a time passed every test here and failed every
  // query that carried it under wrangler dev.
  const patterns = [...PARISH_COLOR_SQL.matchAll(/\b(?:GLOB|LIKE)\s+'([^']*)'/gi)].map(m => m[1]);
  assert.ok(patterns.length, 'found no pattern to check');
  for (const pat of patterns) assert.ok(Buffer.byteLength(pat) <= 50, `pattern ${pat} is over D1's 50 bytes`);
});
