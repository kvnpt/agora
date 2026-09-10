import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandFrom } from '../../public/shared/project.mjs';
import { localPartsOf } from '../../public/shared/tz.mjs';
import { reconcile, titlesMatch } from './reconcile.mjs';
import { GOOD_SHEPHERD } from './infer.fixture.mjs';

const TZ = 'Australia/Melbourne';
const W = { windowFrom: '2026-09-12', windowTo: '2026-11-07' };

// The four rules accepted from inference, as schedules rows.
const RULES = [
  { id: 1, parish_id: 'gs', day_of_week: 6, start_time: '17:00', title: 'Vespers', event_type: 'liturgy', p_timezone: TZ },
  { id: 2, parish_id: 'gs', day_of_week: 6, start_time: '18:00', title: 'Confession', event_type: 'other', p_timezone: TZ },
  { id: 3, parish_id: 'gs', day_of_week: 0, start_time: '09:00', title: 'Matins (Orthros)', event_type: 'liturgy', p_timezone: TZ },
  { id: 4, parish_id: 'gs', day_of_week: 0, start_time: '10:00', title: 'Divine Liturgy', event_type: 'liturgy', p_timezone: TZ },
];
const PROJECTED = expandFrom({ schedules: RULES, overrides: [] },
  '2026-09-12T00:00:00Z', '2026-11-08T00:00:00Z');

const day = (e) => localPartsOf(TZ, Date.parse(e.start_utc)).date;
const run = (scraped, extra = {}) =>
  reconcile({ projected: PROJECTED, scraped, timezone: TZ, ...W, ...extra });
const shift = (e, mins) => ({ ...e, start_utc: new Date(Date.parse(e.start_utc) + mins * 60000).toISOString() });

test('a clean scrape cancels nothing', () => {
  const r = run(GOOD_SHEPHERD);
  assert.equal(r.missing.length, 0);
  assert.equal(r.moved.length, 0);
  assert.equal(r.matched.length, 34);
});

test('events with no rule behind them are extra, not missing', () => {
  // FOUNDATIONS (4), Bookshop (2) and a marriage blessing. Withheld by
  // inference on purpose; they must not read as anything needing action.
  const r = run(GOOD_SHEPHERD);
  assert.equal(r.extra.length, 7);
  assert.ok(r.extra.some(e => e.title === 'FOUNDATIONS Course'));
});

test('a cancelled service is missing', () => {
  const r = run(GOOD_SHEPHERD.filter(e => !(e.title === 'Divine Liturgy' && day(e) === '2026-10-18')));
  assert.equal(r.missing.length, 1);
  assert.equal(r.missing[0].title, 'Divine Liturgy');
  assert.equal(day(r.missing[0]), '2026-10-18');
});

test('a decorated title is still the same service', () => {
  // Parishes rename a liturgy for the feast on the day. Under merge.mjs's
  // exact-title partition key every one of these would read as a cancellation.
  const r = run(GOOD_SHEPHERD.map(e => e.title === 'Divine Liturgy'
    ? { ...e, title: 'Divine Liturgy — Sunday of the Prodigal Son' } : e));
  assert.equal(r.missing.length, 0);
});

test('a small time change is the same service; a large one is a move', () => {
  const at = (e) => e.title === 'Vespers' && day(e) === '2026-10-17';

  const small = run(GOOD_SHEPHERD.map(e => at(e) ? shift(e, 30) : e));
  assert.equal(small.missing.length, 0);
  assert.equal(small.moved.length, 0, '30 minutes is drift, not news');

  const large = run(GOOD_SHEPHERD.map(e => at(e) ? shift(e, 240) : e));
  assert.equal(large.missing.length, 0, 'a moved service has NOT been cancelled');
  assert.equal(large.moved.length, 1);
  assert.equal(large.moved[0].driftMinutes, 240);
});

test('absence outside the window is not evidence of anything', () => {
  // The same scrape, judged against a window that stops before the gap. A
  // source cannot report on dates it was never asked about.
  const short = GOOD_SHEPHERD.filter(e => day(e) !== '2026-11-07');
  assert.equal(run(short).missing.length, 2, 'inside the window: two services gone');
  assert.equal(run(short, { windowTo: '2026-11-01' }).missing.length, 0);
});

test('an emptied calendar reports everything, for the caller to refuse', () => {
  // This module does not decide. It reports 34 missing and lets policy see a
  // number that obviously means "the source broke", not "the parish closed".
  const r = run([]);
  assert.equal(r.missing.length, 34);
  assert.equal(r.matched.length, 0);
});

test('one scraped event cannot satisfy two rules', () => {
  // Matins 09:00 and Divine Liturgy 10:00 are an hour apart, inside tolerance.
  // Drop the liturgy and Matins must not be claimed twice to cover for it.
  const r = run(GOOD_SHEPHERD.filter(e => !(e.title === 'Divine Liturgy' && day(e) === '2026-10-18')));
  assert.equal(r.missing.length, 1);
  assert.ok(r.matched.some(m => m.instance.title === 'Matins (Orthros)' && day(m.instance) === '2026-10-18'));
});

test('titles match at a word boundary, not on any substring', () => {
  assert.ok(titlesMatch('Vespers', 'Vespers'));
  assert.ok(titlesMatch('Vespers', 'vespers  '));
  assert.ok(titlesMatch('Divine Liturgy', 'Divine Liturgy — Sunday of the Prodigal Son'));
  assert.ok(!titlesMatch('Vespers', 'Great Vespers'), 'prefix only, not substring');
  assert.ok(!titlesMatch('Divine Liturgy', 'Divine Liturgyx'));
  assert.ok(!titlesMatch('Matins (Orthros)', 'Divine Liturgy'));
  assert.ok(!titlesMatch('', 'anything'));
});

test('a DST boundary does not fabricate a cancellation', () => {
  // Melbourne shifted +10 -> +11 on 4 October 2026. Comparing instants instead
  // of local dates would misplace every Sunday service by an hour across it.
  const r = run(GOOD_SHEPHERD);
  assert.ok(r.matched.some(m => day(m.instance) === '2026-09-13'), 'before');
  assert.ok(r.matched.some(m => day(m.instance) === '2026-11-01'), 'after');
  assert.equal(r.missing.length, 0);
});
