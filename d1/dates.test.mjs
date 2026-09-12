// Date slugs — the segment that winds the feed forward.
//
// Every case here is a link somebody can type, and the two that matter most are
// the ones that must NOT resolve: `sep` is a parish, and a segment that looks
// like a date must be refused as an acronym so the two can never mean different
// things on different days.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../public/shared/dates.js');
const Slugs = require('../public/shared/slugs.js');

// A Saturday, so "next Sunday" is tomorrow and "next Saturday" is a week out.
const TODAY = '2026-09-12';

test('an explicit day resolves to itself and reads back unchanged', () => {
  const r = D.resolveDateSlug('2027-07-03', TODAY);
  assert.deepEqual(r, { date: '2027-07-03', precision: 'day', slug: '2027-07-03' });
  assert.equal(D.dateSlugFor(r.date, r.precision), '2027-07-03');
  assert.equal(D.dateFocusLabel(r.date, r.precision), '3/7/2027');
});

test('a month keeps its month shape through the round trip', () => {
  const r = D.resolveDateSlug('2026-07', TODAY);
  assert.deepEqual(r, { date: '2026-07-01', precision: 'month', slug: '2026-07' });
  // The point of carrying precision: /smg/2026-07 must not read back as
  // /smg/2026-07-01, which is a different link from the one that was shared.
  assert.equal(D.dateSlugFor(r.date, r.precision), '2026-07');
  assert.equal(D.dateFocusLabel(r.date, r.precision), 'July 2026');
});

test('a month name means the next time that month comes round', () => {
  assert.equal(D.resolveDateSlug('march', TODAY).date, '2027-03-01');
  assert.equal(D.resolveDateSlug('december', TODAY).date, '2026-12-01');
  // The month we are standing in counts as this one, not next year's.
  assert.equal(D.resolveDateSlug('september', TODAY).date, '2026-09-01');
  assert.equal(D.resolveDateSlug('September', TODAY).slug, '2026-09');
});

test('"next <weekday>" is never today; "this <weekday>" can be', () => {
  assert.equal(D.resolveDateSlug('next-thursday', TODAY).date, '2026-09-17');
  assert.equal(D.resolveDateSlug('next-sunday', TODAY).date, '2026-09-13');
  // TODAY is a Saturday. Asking for next Saturday on a Saturday means the one
  // after this — somebody standing in front of today's service.
  assert.equal(D.resolveDateSlug('next-saturday', TODAY).date, '2026-09-19');
  assert.equal(D.resolveDateSlug('this-saturday', TODAY).date, '2026-09-12');
  // Every weekday spelling services.js knows works here too.
  assert.equal(D.resolveDateSlug('next-thurs', TODAY).date, '2026-09-17');
  assert.equal(D.resolveDateSlug('nextthursday', TODAY).date, '2026-09-17');
});

test('relative slugs resolve to an absolute date, so the URL settles', () => {
  const r = D.resolveDateSlug('next-thursday', TODAY);
  assert.equal(r.slug, '2026-09-17');
  assert.equal(D.resolveDateSlug('today', TODAY).date, TODAY);
  assert.equal(D.resolveDateSlug('tomorrow', TODAY).date, '2026-09-13');
  assert.equal(D.resolveDateSlug('next-week', TODAY).date, '2026-09-19');
  assert.equal(D.resolveDateSlug('next-month', TODAY).date, '2026-10-01');
  assert.equal(D.resolveDateSlug('next-year', TODAY).date, '2027-09-01');
});

test('a month-offset crossing a year boundary lands in the next year', () => {
  assert.equal(D.resolveDateSlug('next-month', '2026-12-31').date, '2027-01-01');
  assert.equal(D.resolveDateSlug('next-year', '2026-12-01').date, '2027-12-01');
});

test('anything that is not a date resolves to null', () => {
  for (const seg of ['smg', 'liturgy', 'wed', 'greek', 'qld', '', null, '42']) {
    assert.equal(D.resolveDateSlug(seg, TODAY), null, String(seg));
  }
  // Date-SHAPED but not a date.
  assert.equal(D.resolveDateSlug('2026-13', TODAY), null);
  assert.equal(D.resolveDateSlug('2026-02-30', TODAY), null);
});

test('three-letter month abbreviations are NOT dates', () => {
  // `sep` is St Elijah the Prophet, Coober Pedy. The parish acronym resolves
  // last, so teaching the router that `sep` is September would not raise a
  // clash — it would silently take the parish's link away.
  for (const seg of ['sep', 'mar', 'jan', 'dec', 'aug']) {
    assert.equal(D.resolveDateSlug(seg, TODAY), null, seg);
    assert.equal(Slugs.reservedSlugReason(seg), null, `${seg} stays available as an acronym`);
  }
});

test('every date slug is reserved against parish acronyms', () => {
  for (const slug of D.DATE_SLUGS) {
    assert.ok(Slugs.reservedSlugReason(slug), slug);
    assert.ok(Slugs.reservedSlugReason(String(slug).replace(/-/g, '')), `${slug} without hyphens`);
  }
});

test('a date-shaped acronym is refused before it can shadow a date', () => {
  for (const bad of ['2026-07', '2026-07-15']) {
    assert.match(Slugs.reservedSlugReason(bad) || '', /date/i, bad);
  }
});
