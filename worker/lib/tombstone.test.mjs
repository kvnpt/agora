import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expandFrom } from '../../public/shared/project.mjs';
import { localPartsOf } from '../../public/shared/tz.mjs';
import { reconcile } from './reconcile.mjs';
import { decideTombstones, adapterSource } from './tombstone.mjs';
import { GOOD_SHEPHERD } from './infer.fixture.mjs';

const TZ = 'Australia/Melbourne';
const ADAPTER = 'gcal-antiochian-good-shepherd-antiochian-church';
const SOURCE = adapterSource(ADAPTER);
const W = { windowFrom: '2026-09-12', windowTo: '2026-11-07' };

const RULES = [
  { id: 1, parish_id: 'gs', day_of_week: 6, start_time: '17:00', title: 'Vespers', event_type: 'liturgy', p_timezone: TZ },
  { id: 2, parish_id: 'gs', day_of_week: 6, start_time: '18:00', title: 'Confession', event_type: 'other', p_timezone: TZ },
  { id: 3, parish_id: 'gs', day_of_week: 0, start_time: '09:00', title: 'Matins (Orthros)', event_type: 'liturgy', p_timezone: TZ },
  { id: 4, parish_id: 'gs', day_of_week: 0, start_time: '10:00', title: 'Divine Liturgy', event_type: 'liturgy', p_timezone: TZ },
];
const PROJECTED = expandFrom({ schedules: RULES, overrides: [] },
  '2026-09-12T00:00:00Z', '2026-11-08T00:00:00Z');

const day = (e) => localPartsOf(TZ, Date.parse(e.start_utc)).date;
const without = (pred) => GOOD_SHEPHERD.filter(e => !pred(e));

function decide(scraped, { existing = [], ...opts } = {}) {
  const diff = reconcile({ projected: PROJECTED, scraped, timezone: TZ, ...W });
  return decideTombstones({
    diff, projectedCount: PROJECTED.length, scrapedCount: scraped.length,
    existing, adapterId: ADAPTER, ...opts,
  });
}

test('a clean scrape writes nothing', () => {
  const d = decide(GOOD_SHEPHERD);
  assert.deepEqual(d.create, []);
  assert.deepEqual(d.withdraw, []);
  assert.equal(d.refused, null);
});

test('a genuinely cancelled service is tombstoned', () => {
  const d = decide(without(e => e.title === 'Divine Liturgy' && day(e) === '2026-10-18'));
  assert.equal(d.create.length, 1);
  assert.equal(d.create[0].schedule_id, 4);
  assert.equal(d.create[0].occurrence_date, '2026-10-18');
  assert.match(d.create[0].note, new RegExp(ADAPTER));
});

test('an empty scrape cancels nothing, however successful the run', () => {
  // The dangerous case: the request worked, the calendar came back empty.
  // "Everything is cancelled" and "they stopped publishing" look identical.
  const d = decide([]);
  assert.deepEqual(d.create, []);
  assert.equal(d.refused.reason, 'empty-scrape');
});

test('the breaker refuses a run that would cancel most of a parish', () => {
  // Half the Saturdays and every Sunday gone: 24 of 34.
  const d = decide(GOOD_SHEPHERD.filter(e => day(e) < '2026-10-01' && e.title === 'Vespers'));
  assert.deepEqual(d.create, []);
  assert.equal(d.refused.reason, 'too-many');
  assert.ok(d.refused.missing > d.refused.projected * 0.5);
  assert.match(d.refused.detail, /broken source/);
});

test('the breaker threshold is a knob, not a law', () => {
  const scraped = without(e => day(e) === '2026-10-18');   // 2 of 34 missing
  assert.equal(decide(scraped).create.length, 2);
  assert.equal(decide(scraped, { maxCancelFraction: 0.01 }).refused.reason, 'too-many');
});

test("a person's override is never overwritten", () => {
  const scraped = without(e => e.title === 'Divine Liturgy' && day(e) === '2026-10-18');
  const d = decide(scraped, { existing: [
    { schedule_id: 4, occurrence_date: '2026-10-18', kind: 'modified', source: 'human' },
  ] });
  assert.deepEqual(d.create, []);
  assert.equal(d.skipped[0].because, 'override-on-file');
});

test('an existing tombstone of ours is not written twice', () => {
  const scraped = without(e => e.title === 'Divine Liturgy' && day(e) === '2026-10-18');
  const d = decide(scraped, { existing: [
    { schedule_id: 4, occurrence_date: '2026-10-18', kind: 'cancelled', source: SOURCE },
  ] });
  assert.deepEqual(d.create, []);
  assert.equal(d.skipped[0].because, 'already-tombstoned');
});

test('a service that comes back loses its tombstone', () => {
  // Without this, one bad scrape marks a Sunday cancelled forever.
  const d = decide(GOOD_SHEPHERD, { existing: [
    { schedule_id: 4, occurrence_date: '2026-10-18', kind: 'cancelled', source: SOURCE },
  ] });
  assert.equal(d.withdraw.length, 1);
  assert.deepEqual(d.withdraw[0], { schedule_id: 4, occurrence_date: '2026-10-18' });
});

test("a person's cancellation is not withdrawn when the source disagrees", () => {
  const d = decide(GOOD_SHEPHERD, { existing: [
    { schedule_id: 4, occurrence_date: '2026-10-18', kind: 'cancelled', source: 'human' },
  ] });
  assert.deepEqual(d.withdraw, []);
});

test('a moved service counts as present, not cancelled', () => {
  const moved = GOOD_SHEPHERD.map(e => (e.title === 'Vespers' && day(e) === '2026-10-17')
    ? { ...e, start_utc: new Date(Date.parse(e.start_utc) + 240 * 60000).toISOString() } : e);
  const d = decide(moved, { existing: [
    { schedule_id: 1, occurrence_date: '2026-10-17', kind: 'cancelled', source: SOURCE },
  ] });
  assert.deepEqual(d.create, []);
  assert.equal(d.withdraw.length, 1, 'it is on, at a different hour — untomb it');
});

test('no rules means nothing to decide, not a refusal', () => {
  const d = decideTombstones({
    diff: { missing: [], matched: [], moved: [] },
    projectedCount: 0, scrapedCount: 5, adapterId: ADAPTER,
  });
  assert.equal(d.refused, null);
  assert.deepEqual(d.create, []);
});
