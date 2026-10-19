// The collections (public/shared/collections.js): each one a link, and a link
// is a collection by what it means, not how it is spelt.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../public/shared/collections.js');
const U = require('../public/shared/url-state.js');
const slugs = require('../public/shared/slugs.js');

const of = (p) => (C.collectionFor(U.classifyPath(p)) || {}).id || null;

test('every collection is found at its own link, which the grammar reads', () => {
  const ids = new Set();
  for (const c of C.COLLECTIONS) {
    assert.equal(of(c.path), c.id, c.path);
    assert.ok(!ids.has(c.id), `${c.id} twice`);
    ids.add(c.id);
    assert.ok(c.title && c.blurb && c.image, c.id);
    assert.doesNotMatch(c.blurb, /worth it|easiest|a drive away/i, `${c.id}: plain words`);
  }
});

test('a collection is what a link means, in any order or spelling', () => {
  assert.equal(of('/liturgy/sun'), 'sunday');
  assert.equal(of('/sunday/liturgy'), 'sunday');
  assert.equal(of('/services/liturgy/sun'), 'sunday', 'Services with Liturgy chosen is /liturgy');
  assert.equal(of('/english'), 'english');
  assert.equal(of('/greek/timetables'), 'j-greek', 'the page is the timetable');
  assert.equal(of('/monastery'), 'monasteries');
  assert.equal(of('/evening/prayer/saturday'), 'vespers');
});

test('a hand-picked list, a mix of filters and a date are not collections', () => {
  for (const p of ['/', '/sgr+snb', '/sgr', '/greek/qld', '/greek/en', '/en-only', '/in-greek-only', '/sun',
    '/en/monasteries', '/sun/liturgy/2026-11-01', '/greek/next-week', '/102']) {
    assert.equal(of(p), null, p);
  }
});

test('no parish acronym can take a collection\'s link', () => {
  for (const c of C.COLLECTIONS) {
    for (const seg of c.path.split('/').filter(Boolean)) {
      assert.ok(slugs.reservedSlugReason(seg), `${seg} is not reserved`);
    }
  }
});

test("every collection's preview picture is drawn (scripts/build-og-images.mjs)", () => {
  const fs = require('node:fs');
  for (const c of C.COLLECTIONS) assert.ok(fs.existsSync(`public${c.image}`), `${c.image} is missing`);
});
