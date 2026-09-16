// How much future a scrape can still speak for.
//
// Every case here is one of the live adapters on 16 September 2026, because the
// bug this reports was found by reading /api/adapters/status and noticing that
// the row saying `healthy: true` had a window ending five months earlier.

import test from 'node:test';
import assert from 'node:assert';
import { coverageState, coverageMessage, COVERAGE_WARN_DAYS } from './coverage.mjs';

const TODAY = '2026-09-16';

test('a source that ran out months ago is expired, not OK', () => {
  // pdf-gopssc-buderim, exactly as it reported: one event, Holy Thursday, and
  // a window of a single day in April. `status` was 'success'.
  const c = coverageState('2026-04-09', TODAY);
  assert.equal(c.state, 'expired');
  assert.equal(c.until, '2026-04-09');
  assert.equal(c.daysLeft, -160);
  assert.match(coverageMessage(c), /Out of dates.*2026-04-09.*160 days ago/);
});

test('the last covered day being today is already expired', () => {
  // Nothing is scheduled past the end of today, so there is no future in the
  // feed for this parish. Treating "ends today" as fine would mean the warning
  // never fires on the one day it is most actionable.
  const c = coverageState(TODAY, TODAY);
  assert.equal(c.state, 'expired');
  assert.equal(c.daysLeft, 0);
  assert.match(coverageMessage(c), /\(today\)/);
});

test('a month-long source is ending once it is inside the warning window', () => {
  // A monthly publisher: this is the state that should prompt somebody to check
  // whether next month's programme has gone up.
  const c = coverageState('2026-09-30', TODAY);
  assert.equal(c.state, 'ending');
  assert.equal(c.daysLeft, 14);
  assert.match(coverageMessage(c), /Running dry.*14 more days.*2026-09-30/);
});

test('the boundary is inclusive, and one day past it is not a warning', () => {
  const at = coverageState('2026-10-07', TODAY);       // exactly 21 days
  assert.equal(at.daysLeft, COVERAGE_WARN_DAYS);
  assert.equal(at.state, 'ending');
  const past = coverageState('2026-10-08', TODAY);     // 22
  assert.equal(past.state, 'ok');
  assert.equal(coverageMessage(past), null, 'an OK horizon has nothing to say');
});

test('a rolling source never trips this on its own', () => {
  // gcal-antiochian-good-shepherd asks for ~90 days every run, so its horizon
  // moves with it. The check is inert for rolling sources by construction —
  // which is why it does not need to know what kind of adapter it is looking at.
  const c = coverageState('2026-12-09', TODAY);
  assert.equal(c.state, 'ok');
  assert.equal(c.daysLeft, 84);
});

test('no window is unknown, and unknown is not expired', () => {
  // The adapter reports no window when it parsed nothing it could date —
  // deliberately, so it cannot tombstone over text it did not understand. That
  // is a different thing from a source that has run out, and saying "out of
  // dates" would blame a parish for a parser that read nothing.
  for (const empty of [null, undefined, '']) {
    const c = coverageState(empty, TODAY);
    assert.equal(c.state, 'unknown');
    assert.equal(c.until, null);
    assert.equal(c.daysLeft, null);
  }
  assert.match(coverageMessage(coverageState(null, TODAY)), /Nothing dated was read/);
});

test('a malformed window is unknown rather than a wild number of days', () => {
  const c = coverageState('not-a-date', TODAY);
  assert.equal(c.state, 'unknown');
  assert.equal(c.daysLeft, null);
});

test('a full ISO timestamp in the column is read as its date', () => {
  // window_to is a local date by contract, but nothing enforces the column's
  // shape, and a timestamp slipping in should not read as unknown.
  const c = coverageState('2026-09-30T00:00:00Z', TODAY);
  assert.equal(c.state, 'ending');
  assert.equal(c.until, '2026-09-30');
});

test('the warning distance is adjustable without touching the states', () => {
  // A yearly publisher wants more notice than a monthly one. Nobody has needed
  // to tune this yet, so it is one constant — but the seam is here rather than
  // the number being written into the comparison.
  assert.equal(coverageState('2026-10-31', TODAY).state, 'ok');
  assert.equal(coverageState('2026-10-31', TODAY, { warnDays: 60 }).state, 'ending');
});

test('coverage never claims a source is healthy or broken', () => {
  // The distinction the whole file exists to keep: this says nothing about
  // whether the scrape worked. worker/routes/public.mjs keeps `healthy` as
  // `status !== 'failed'` and reports coverage beside it.
  const c = coverageState('2026-04-09', TODAY);
  assert.ok(!('healthy' in c));
  assert.deepEqual(Object.keys(c).sort(), ['daysLeft', 'state', 'until']);
});
