// A parish acronym is a URL segment, so saving one changes what a path means.
//
// detectUrlState resolves a path segment in a fixed order — jurisdiction,
// keyword, event id, location, then parish acronym — and the acronym is last.
// An acronym that spells one of the earlier ones is therefore not an error the
// router reports; it is a parish that has silently stopped being reachable.
// These tests pin the list that stops it being saved in the first place.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../public/shared/slugs.js');
const L = require('../public/shared/locations.js');

test('a free acronym stays free', () => {
  // The two production actually uses, plus shapes that are fine.
  for (const ok of ['sjfc', 'smg', 'stgeorge', 'gs-clayton', 'filo', 'x1']) {
    assert.equal(S.reservedSlugReason(ok), null, ok);
  }
  assert.equal(S.reservedSlugReason(''), null, 'clearing the acronym is allowed');
  assert.equal(S.reservedSlugReason(null), null);
});

test('every jurisdiction is reserved', () => {
  for (const j of S.JURISDICTIONS) assert.ok(S.reservedSlugReason(j), j);
});

test('every location slug and alias is reserved, in either spelling', () => {
  for (const slug of L.LOCATION_SLUGS) {
    assert.ok(S.reservedSlugReason(slug), slug);
    assert.ok(S.reservedSlugReason(String(slug).replace(/-/g, '')), `${slug} without hyphens`);
  }
  // Spot checks from the request, including the ones a person would type.
  for (const s of ['qld', 'queensland', 'NSW', 'New South Wales', 'vic', 'nz', 'fiji', 'ph', 'syd', 'per']) {
    assert.ok(S.reservedSlugReason(s), s);
  }
});

test('path keywords, payment kinds and site paths are reserved', () => {
  for (const s of [...S.PATH_KEYWORDS, ...S.PAY_KINDS, ...S.SITE_PATHS]) {
    assert.ok(S.reservedSlugReason(s), s);
  }
});

test('shapes the router would read as something else are refused', () => {
  assert.match(S.reservedSlugReason('42'), /event id/);
  assert.match(S.reservedSlugReason('42:2026-09-06'), /instance id/);
  assert.match(S.reservedSlugReason('smg+sjfc'), /\+/);
  assert.match(S.reservedSlugReason('a/b'), /cannot contain/);
});

test('comparison ignores case and spacing, the way the router does', () => {
  // index.mjs resolves /<slug>/donate with lower(replace(acronym,' ','')), so
  // "N Z" and "nz" are the same link and both have to be refused.
  assert.equal(S.normaliseSlug('  St M G '), 'stmg');
  assert.ok(S.reservedSlugReason(' N Z '));
  assert.ok(S.reservedSlugReason('QLD'));
});

test('the Worker enforces it, which is what covers both editors', () => {
  const admin = fs.readFileSync('worker/routes/admin.mjs', 'utf8');
  assert.ok(admin.includes("from '../../public/shared/slugs.js'"),
    'the Worker does not read the shared reserved list');
  assert.ok(/acronymConflict\(env\.DB/.test(admin),
    'the parish routes do not call the acronym check');
  // Both surfaces PATCH the same endpoint, so neither can save what the other
  // would refuse. They also warn locally, from the same file.
  for (const path of ['public/index.html', 'public/admin.html']) {
    assert.ok(fs.readFileSync(path, 'utf8').includes('/shared/slugs.js'),
      `${path} does not load the reserved list for its inline warning`);
  }
});
