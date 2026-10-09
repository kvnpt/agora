// Verification for worker/lib/tz.js.
//
//   npm test
//
// Ground truth is the Temporal polyfill — the implementation the Express app
// used — so this proves the ported fast path is behaviourally identical, not
// merely plausible. Temporal is only needed here; once the port lands it can
// move to devDependencies.

import test from 'node:test';
import assert from 'node:assert';
import { Temporal } from '@js-temporal/polyfill';
import { OffsetCache, localSpanToUtc } from '../../public/shared/tz.mjs';

const ref = (zone, d, t) =>
  Temporal.PlainDateTime.from(`${d}T${t}`).toZonedDateTime(zone).toInstant()
    .toString({ smallestUnit: 'millisecond' });

const ZONES = [
  'Australia/Sydney',    // +10/+11
  'Australia/Brisbane',  // +10, no DST
  'Australia/Perth',     // +8, no DST
  'Australia/Adelaide',  // +9:30/+10:30, half-hour offset
  'Pacific/Auckland',    // +12/+13, transitions on different dates to Sydney
  'Australia/Lord_Howe', // +10:30/+11, a THIRTY-minute DST shift
];

// Straddle the transition window — Agora genuinely schedules services in it
// (Paschal vigil, Nativity midnight liturgy).
const TIMES = ['00:30', '02:00', '02:30', '03:00', '09:00', '23:30'];

function datesOfYear(year) {
  const out = [];
  let d = Temporal.PlainDate.from(`${year}-01-01`);
  const end = Temporal.PlainDate.from(`${year}-12-31`);
  while (Temporal.PlainDate.compare(d, end) <= 0) {
    out.push(d.toString());
    d = d.add({ days: 1 });
  }
  return out;
}

for (const zone of ZONES) {
  test(`${zone}: matches Temporal for every day of 2026`, () => {
    const cache = new OffsetCache();
    for (const d of datesOfYear(2026)) {
      for (const t of TIMES) {
        assert.strictEqual(cache.toUtcISO(zone, d, t), ref(zone, d, t), `${zone} ${d} ${t}`);
      }
    }
  });
}

test('spring-forward gap: a nonexistent wall time shifts forward', () => {
  const c = new OffsetCache();
  // 2026-10-04, Sydney: 02:00 -> 03:00, so 02:00-02:59 does not exist.
  assert.strictEqual(c.toUtcISO('Australia/Sydney', '2026-10-04', '02:30'),
                     ref('Australia/Sydney', '2026-10-04', '02:30'));
  // The gap collapses 02:30 and 03:30 onto the same instant.
  assert.strictEqual(c.toUtcISO('Australia/Sydney', '2026-10-04', '02:30'),
                     c.toUtcISO('Australia/Sydney', '2026-10-04', '03:30'));
});

test('fall-back overlap: an ambiguous wall time takes the EARLIER occurrence', () => {
  const c = new OffsetCache();
  // 2026-04-05, Sydney: 03:00 -> 02:00, so 02:00-02:59 happens twice.
  const got = c.toUtcISO('Australia/Sydney', '2026-04-05', '02:30');
  assert.strictEqual(got, ref('Australia/Sydney', '2026-04-05', '02:30'));
  // Earlier occurrence is under AEDT (+11) — 15:30Z, not 16:30Z.
  assert.strictEqual(got, '2026-04-04T15:30:00.000Z');
});

test('unambiguous times on a transition day are not disturbed', () => {
  const c = new OffsetCache();
  // 01:30 on fall-back day occurs once, under +11.
  assert.strictEqual(c.toUtcISO('Australia/Sydney', '2026-04-05', '01:30'),
                     '2026-04-04T14:30:00.000Z');
});

test('a uniform day is cached once and reused across times', () => {
  const c = new OffsetCache();
  for (const t of ['06:00', '09:00', '18:00']) c.epoch('Australia/Sydney', '2026-09-06', t);
  assert.strictEqual(c.size, 1, 'three lookups on one date should build one cache entry');
});

test('distinct zones do not share cache entries', () => {
  const c = new OffsetCache();
  c.epoch('Australia/Sydney', '2026-09-06', '09:00');
  c.epoch('Australia/Perth', '2026-09-06', '09:00');
  assert.strictEqual(c.size, 2);
  assert.notStrictEqual(
    c.epoch('Australia/Sydney', '2026-09-06', '09:00'),
    c.epoch('Australia/Perth', '2026-09-06', '09:00'),
  );
});

// ── localSpanToUtc: a draft's local date and times -> the instants events store ──

test('localSpanToUtc: no end time stores none', () => {
  assert.deepStrictEqual(localSpanToUtc('Pacific/Auckland', '2026-11-14', '19:00', null), {
    start_utc: ref('Pacific/Auckland', '2026-11-14', '19:00'),
    end_utc: null,
  });
});

test('localSpanToUtc: an end at or before the start is the next morning', () => {
  // The Paschal vigil: 23:00 on Holy Saturday to 02:30 on Pascha (Sydney, +10).
  const span = localSpanToUtc('Australia/Sydney', '2026-04-11', '23:00', '02:30');
  assert.strictEqual(span.start_utc, ref('Australia/Sydney', '2026-04-11', '23:00'));
  assert.strictEqual(span.end_utc, ref('Australia/Sydney', '2026-04-12', '02:30'));
  assert.ok(Date.parse(span.end_utc) > Date.parse(span.start_utc));
});

test('localSpanToUtc: a span across the spring-forward hour is read on both sides of it', () => {
  // Sydney, 4 Oct 2026: 02:00 becomes 03:00. 01:30 is still +10, 03:30 is +11,
  // so two hours on the wall clock are one hour of real time.
  const span = localSpanToUtc('Australia/Sydney', '2026-10-04', '01:30', '03:30');
  assert.strictEqual(span.start_utc, '2026-10-03T15:30:00.000Z');
  assert.strictEqual(span.end_utc, '2026-10-03T16:30:00.000Z');
  assert.strictEqual(span.end_utc, ref('Australia/Sydney', '2026-10-04', '03:30'));
});

test('localSpanToUtc: an ordinary evening in Perth', () => {
  const span = localSpanToUtc('Australia/Perth', '2026-11-14', '19:00', '21:30');
  assert.strictEqual(span.start_utc, '2026-11-14T11:00:00.000Z');
  assert.strictEqual(span.end_utc, '2026-11-14T13:30:00.000Z');
});
