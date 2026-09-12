// Service kinds and weekdays, as URL slugs.
//
// The classification is title-first because event_type cannot carry it:
// production's 68 rules are 36 'liturgy', 31 'prayer' and one 'other', and
// "prayer" covers Matins, Vespers, Paraklesis, Compline and Confession alike.
// The fixture below is the real distinct titles those rows use.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../public/shared/services.js');
const Slugs = require('../public/shared/slugs.js');

// Every distinct title in production's schedule rules and one-off events.
const REAL_TITLES = [
  ['Liturgy', 'liturgy'],
  ['Divine Liturgy', 'liturgy'],
  ['English Liturgy', 'liturgy'],
  ['Liturgy (in the hall)', 'liturgy'],
  // Both /vesper/ and /liturg/ match. It is a Liturgy served in the evening,
  // which is why liturgy is first in the registry.
  ['Vesperal Liturgy - Entrance of the Theotokos', 'liturgy'],
  ['Matins', 'matins'],
  ['Matins (Orthros)', 'matins'],
  ['Vespers', 'vespers'],
  ['Vespers at 23 Hill Street POMONA QLD 4568', 'vespers'],
  ['ACOY -Vespers - St John Chrysostom', 'vespers'],
  ['Paraklesis', 'paraklesis'],
  ['Sisterhood of Saints Mary and Martha (Paraklesis Service)', 'paraklesis'],
  ['Small Compline', 'compline'],
  ['Confession', 'confession'],
  // Genuinely not services, and they must stay unclassified rather than being
  // swept into a bucket by their event_type.
  ['FOUNDATIONS Course', null],
  ['Bookshop', null],
  ['Marriage blessing', null],
  ['NATIVITY FAST', null],
  ['AGM', null],
  ['Prayer Ministry (online)', null],
];

test('real titles classify to the right service', () => {
  for (const [title, expected] of REAL_TITLES) {
    assert.equal(S.serviceOf({ title, event_type: 'prayer' }), expected, title);
  }
});

test('event_type is the fallback, not the primary signal', () => {
  // A feast is what the day is; its rows are titled after the feast itself.
  assert.equal(S.serviceOf({ title: 'Dormition of the Theotokos', event_type: 'feast' }), 'feast');
  assert.equal(S.serviceOf({ title: '', event_type: 'liturgy' }), 'liturgy');
  // 'prayer' covers five different services, so it settles nothing on its own.
  assert.equal(S.serviceOf({ title: 'Something else', event_type: 'prayer' }), null);
});

test('slugs and aliases resolve to one canonical service', () => {
  for (const [input, slug] of [
    ['liturgy', 'liturgy'], ['Divine-Liturgy', 'liturgy'], ['liturgies', 'liturgy'],
    ['vespers', 'vespers'], ['matins', 'matins'], ['orthros', 'matins'],
    ['bible-study', 'bible-study'], ['biblestudy', 'bible-study'], ['Bible Study', 'bible-study'],
    ['paraklesis', 'paraklesis'], ['compline', 'compline'], ['feast', 'feast'],
  ]) {
    const svc = S.resolveService(input);
    assert.ok(svc, `${input} did not resolve`);
    assert.equal(svc.slug, slug, input);
  }
  assert.equal(S.resolveService('bookshop'), null);
});

test('plurals are spelled out, because English does not derive them here', () => {
  assert.equal(S.servicePlural('liturgy'), 'Liturgies');
  assert.equal(S.servicePlural('matins'), 'Matins');        // already plural
  assert.equal(S.servicePlural('vespers'), 'Vespers');      // already plural
  assert.equal(S.servicePlural('bible-study'), 'Bible studies');
  assert.equal(S.servicePlural('paraklesis'), 'Paraklesis services');
});

test('weekdays resolve, and 0 is Sunday', () => {
  // 0 is falsy, so anything that tests the result with || instead of != null
  // silently loses Sunday.
  assert.equal(S.resolveDay('sun'), 0);
  assert.equal(S.resolveDay('Sunday'), 0);
  assert.equal(S.resolveDay('wed'), 3);
  assert.equal(S.resolveDay('Wednesday'), 3);
  assert.equal(S.resolveDay('weds'), 3);
  assert.equal(S.resolveDay('thurs'), 4);
  assert.equal(S.resolveDay('sat'), 6);
  assert.equal(S.resolveDay('someday'), null);
  assert.equal(S.daySlug(3), 'wed');
  assert.equal(S.dayName(0), 'Sunday');
  // Round-trips, so /sgr/wednesday/liturgy canonicalises to /sgr/wed/liturgy.
  for (let d = 0; d < 7; d++) assert.equal(S.resolveDay(S.daySlug(d)), d);
});

test('serviceMatches is the same classification, not a looser one', () => {
  const vesperalLiturgy = { title: 'Vesperal Liturgy - Nativity', event_type: 'liturgy' };
  assert.ok(S.serviceMatches('liturgy', vesperalLiturgy));
  assert.ok(!S.serviceMatches('vespers', vesperalLiturgy), 'a Vesperal Liturgy is not Vespers');
  // No filter means everything passes.
  assert.ok(S.serviceMatches(null, { title: 'Bookshop' }));
});

test('service and day slugs are reserved against parish acronyms', () => {
  for (const slug of S.SERVICE_SLUGS) assert.ok(Slugs.reservedSlugReason(slug), slug);
  for (const slug of S.DAY_SLUGS) assert.ok(Slugs.reservedSlugReason(slug), slug);
});

test('a service slug is never also a day or a jurisdiction', () => {
  // /sgr/wed/liturgy has to have exactly one reading per segment.
  for (const slug of S.SERVICE_SLUGS) {
    assert.equal(S.resolveDay(slug), null, `${slug} reads as a weekday too`);
  }
  for (const slug of S.DAY_SLUGS) {
    assert.equal(S.resolveService(slug), null, `${slug} reads as a service too`);
    assert.ok(!Slugs.JURISDICTIONS.includes(slug), `${slug} is a jurisdiction too`);
  }
});

test('app.js reads the registry and writes the segments back', () => {
  const app = fs.readFileSync('public/app.js', 'utf8');
  for (const needle of [
    'resolveDaySlug(seg) !== null',      // days parsed before services
    'resolveServiceSlug(seg)',
    'scheduleFocusBannerHtml',           // the "Showing …" row
    'data-schedule-focus-clear',         // its dismiss
    'data-sched-focus',                  // tappable schedule rows
  ]) {
    assert.ok(app.includes(needle), `app.js is missing ${needle}`);
  }
  assert.ok(fs.readFileSync('public/index.html', 'utf8').includes('/shared/services.js'));
});
