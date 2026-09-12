// The jurisdiction colour table has to stay one table.
//
// It was three: a literal in public/app.js, two constants in
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

const require = createRequire(import.meta.url);
const { JURISDICTION_COLORS, JURISDICTION_COLOR_FALLBACK, jurisdictionColor } =
  require('../public/shared/jurisdiction-colors.js');
const { parishes } = require('../seeds/parishes.js');

test('every seeded parish carries its jurisdiction colour', () => {
  for (const p of parishes) {
    assert.equal(p.color, jurisdictionColor(p.jurisdiction),
      `${p.id} (${p.jurisdiction}) has ${p.color}`);
  }
});

test('the generated seed SQL carries the same colours', () => {
  // Guards the generate-and-commit step: gen-seed-sql.js reads seeds/
  // parishes.js, so a colour change that is not regenerated leaves the .sql
  // holding the old hex and CI's diff check is the only thing that would
  // catch it.
  for (const path of ['d1/seed-parishes.sql', 'd1/seed-parishes.console.sql']) {
    const sql = fs.readFileSync(path, 'utf8');
    const hexes = new Set([...sql.matchAll(/'(#[0-9a-fA-F]{6})'/g)].map(m => m[1].toLowerCase()));
    const known = new Set(Object.values(JURISDICTION_COLORS).map(h => h.toLowerCase()));
    for (const hex of hexes) {
      assert.ok(known.has(hex), `${path} has ${hex}, which is not a jurisdiction colour`);
    }
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

test('app.js reads the shared table rather than its own copy', () => {
  const app = fs.readFileSync('public/app.js', 'utf8');
  assert.ok(!/_JURIS_RAW_COLORS\s*=\s*\{/.test(app),
    'app.js has grown its own jurisdiction colour literal again');
  assert.ok(app.includes('window.agoraJurisdictionColor'),
    'app.js no longer reads the shared table');

  // The browser gets it as a <script>, so a missing tag is a ReferenceError
  // on the first parish drawn — and nothing in Node would notice.
  const html = fs.readFileSync('public/index.html', 'utf8');
  assert.ok(html.includes('/shared/jurisdiction-colors.js'),
    'index.html does not load the shared colour table');
});
