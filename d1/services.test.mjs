// Service kinds, weekdays and parts of the day, as URL slugs.
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

test('service, day and part-of-day slugs are reserved against parish acronyms', () => {
  for (const slug of S.SERVICE_SLUGS) assert.ok(Slugs.reservedSlugReason(slug), slug);
  for (const slug of S.DAY_SLUGS) assert.ok(Slugs.reservedSlugReason(slug), slug);
  for (const slug of S.PART_SLUGS) assert.ok(Slugs.reservedSlugReason(slug), slug);
});

test('morning and evening split at 2pm, the line the feed draws its cards on', () => {
  assert.equal(S.resolvePartOfDay('Evenings'), 'evening');
  assert.equal(S.resolvePartOfDay('morning'), 'morning');
  assert.equal(S.resolvePartOfDay('afternoon'), null, 'the feed has two parts, not four');
  assert.equal(S.partOfDayLabel('evening'), 'Evening');
  // A rule is its own wall clock.
  assert.equal(S.partOfDayOf({ start_time: '13:59' }), 'morning');
  assert.equal(S.partOfDayOf({ start_time: '14:00' }), 'evening');
  assert.equal(S.partOfDayOf({ start_time: '00:30' }), 'morning');
  // A projected instance carries its parish's wall clock; UTC is not asked.
  assert.equal(S.partOfDayOf({ start_local: '2026-10-11T18:00', start_utc: '2026-10-11T07:00:00Z' }), 'evening');
  assert.equal(S.partOfDayOf({}), null, 'no time, no part');
});

test("a one-off's part of the day is its parish's, not Sydney's", () => {
  // 1pm in Perth is 4pm in Sydney (AEDT): a morning service, wherever it is read.
  const perth = { start_utc: '2026-10-14T05:00:00Z', timezone: 'Australia/Perth' };
  assert.equal(S.localHourOf(perth), 13);
  assert.equal(S.partOfDayOf(perth), 'morning');
  assert.equal(S.partOfDayOf({ start_utc: '2026-10-14T05:00:00Z' }), 'evening', 'no zone falls back to Sydney');
  assert.equal(S.partOfDayOf({ start_utc: '2026-10-14T05:00:00Z' }, 'Australia/Perth'), 'morning');
  assert.equal(S.partOfDayOf({ start_utc: '2026-10-14T05:00:00Z', timezone: 'Not/AZone' }), 'evening',
    'a zone Intl does not know reads as Sydney rather than throwing');
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
  for (const slug of S.PART_SLUGS) {
    assert.equal(S.resolveDay(slug), null, `${slug} reads as a weekday too`);
    assert.equal(S.resolveService(slug), null, `${slug} reads as a service too`);
  }
});

test('app.js reads the registry and writes the segments back', () => {
  const app = fs.readFileSync('public/app.js', 'utf8');
  // Days are parsed before services — in the shared grammar now.
  const grammar = fs.readFileSync('public/shared/url-state.js', 'utf8');
  assert.ok(grammar.indexOf('services.resolveDay(seg)') < grammar.indexOf('services.resolveService(seg)'),
    'the URL grammar must read a weekday before a service');
  for (const needle of [
    'AgoraUrlState.classifyPath(',
    'scheduleFocusBannerHtml',           // the "Showing …" row
    'data-schedule-focus-clear',         // its dismiss
    'data-sched-focus',                  // tappable schedule rows
    'syncFeedFilterBanner',              // the main feed's "Showing …"
    'data-feed-filter-clear',            // its dismiss
  ]) {
    assert.ok(app.includes(needle), `app.js is missing ${needle}`);
  }
  const html = fs.readFileSync('public/index.html', 'utf8');
  assert.ok(html.includes('/shared/services.js'));
  assert.ok(html.includes('id="feed-filter-banner"'), 'the feed banner needs somewhere to render');
});
