import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inferSchedules } from './infer.mjs';
import { matchesWeekParity } from '../../public/shared/recurrence.mjs';
import { GOOD_SHEPHERD, WINDOW } from './infer.fixture.mjs';

const MEL = { timezone: 'Australia/Melbourne', ...WINDOW };
const run = (occ = GOOD_SHEPHERD, opts = MEL) => inferSchedules(occ, opts);
const byTitle = (r, t) => r.proposals.find(p => p.rule.title === t);

// A synthetic series: `dates` at `time` on the weekday those dates fall on.
const series = (title, dates, time = '10:00') => dates.map(d => ({
  title,
  start_utc: new Date(`${d}T${time}:00+11:00`).toISOString(),
  event_type: 'liturgy',
}));

test('the four weekly services are proposed as weekly', () => {
  const r = run();
  for (const [title, dow, time, n] of [
    ['Vespers', 6, '17:00', 9],
    ['Confession', 6, '18:00', 9],
    ['Matins (Orthros)', 0, '09:00', 8],
    ['Divine Liturgy', 0, '10:00', 8],
  ]) {
    const p = byTitle(r, title);
    assert.ok(p, `${title} not proposed`);
    assert.equal(p.rule.week_of_month, null, `${title} should be plain weekly`);
    assert.equal(p.rule.day_of_week, dow);
    assert.equal(p.rule.start_time, time);
    assert.equal(p.support.count, n);
    assert.equal(p.confidence, 'high');
  }
});

test('a service on alternate Sundays is never proposed as weekly', () => {
  // The safety property, and it has not moved: "every Sunday with four
  // absences" fits a frequency count and would later mark four real services
  // CANCELLED. What has changed is that the right answer can now be written
  // down instead of nothing at all.
  const p = byTitle(run(), 'FOUNDATIONS Course');
  assert.ok(p, 'a fortnight now has a spelling, so it should be proposed');
  assert.notEqual(p.rule.week_parity, null, 'proposed as a fortnight');
  assert.equal(p.rule.week_of_month, null, 'and not as month positions');
});

test('a fortnightly series is proposed as a fortnight, not bent into month positions', () => {
  // 'second,last' fits the sample exactly and is wrong: the course was
  // confirmed to run on 22 November 2026, which that rule omits while also
  // inventing one on the 29th. Both readings fit the observed window; only one
  // of them is what the parish is doing, and week_parity is how to say it.
  const p = byTitle(run(), 'FOUNDATIONS Course');
  assert.ok(p, 'expected FOUNDATIONS to be proposed');
  assert.equal(p.rule.day_of_week, 0);
  assert.equal(p.rule.start_time, '12:30');
  assert.equal(p.support.count, 4);
  assert.equal(p.confidence, 'high');

  // The proposed rule reproduces the observed dates and the disputed one.
  const parity = p.rule.week_parity;
  for (const d of ['2026-09-13', '2026-09-27', '2026-10-11', '2026-10-25']) {
    assert.equal(matchesWeekParity(d, parity), true, `${d} was observed and must be covered`);
  }
  assert.equal(matchesWeekParity('2026-11-22', parity), true,
    'the Sunday the course actually runs');
  assert.equal(matchesWeekParity('2026-11-29', parity), false,
    "the Sunday 'second,last' would have invented");

  // And it is no longer sitting in the withheld pile.
  assert.equal(run().unexplained.find(x => x.title === 'FOUNDATIONS Course'), undefined);
});

// Dates are all after 4 October 2026 so Melbourne is on one offset throughout —
// straddling the DST change splits a group by wall clock, which is a different
// property and has its own test above.
const AEDT_WINDOW = { windowFrom: '2026-10-11', windowTo: '2026-12-20',
                      timezone: 'Australia/Melbourne' };

test('an interval that is NOT a fortnight is still withheld', () => {
  // A fortnight has a spelling now; every third week does not. Proposing a
  // rule that cannot express the series is how absence detection turns into a
  // cancellation generator, so it is still withheld.
  const r = inferSchedules(
    series('Triweekly Study', ['2026-10-11', '2026-11-01', '2026-11-22', '2026-12-13']),
    AEDT_WINDOW);
  assert.equal(byTitle(r, 'Triweekly Study'), undefined, 'every 3 weeks is not a fortnight');
  const u = r.unexplained.find(x => x.title === 'Triweekly Study');
  assert.ok(u, 'expected it to be withheld');
  assert.equal(u.support.count, 4, 'all four occurrences should have grouped');
});

test('a series covering BOTH weeks is never called a fortnight', () => {
  // The mirror of the safety property: a fortnightly rule claimed over a
  // series that runs on both weeks would silence half of a real timetable.
  // Whether some week_of_month rule fits is a separate question — what must
  // not happen is a parity.
  const r = inferSchedules(
    series('Mixed Weeks', ['2026-10-11', '2026-10-18', '2026-11-01', '2026-11-08']),
    AEDT_WINDOW);
  const p = byTitle(r, 'Mixed Weeks');
  if (p) assert.equal(p.rule.week_parity, null, 'a both-weeks series was called a fortnight');
});

test('a weekly service is not quietly demoted to a fortnight', () => {
  const r = run();
  for (const title of ['Vespers', 'Divine Liturgy', 'Matins (Orthros)', 'Confession']) {
    const p = byTitle(r, title);
    assert.ok(p, `${title} not proposed`);
    assert.equal(p.rule.week_parity, null, `${title} should stay weekly`);
  }
});

test('thin evidence is held back rather than guessed at', () => {
  const r = run();
  const held = r.unexplained.map(u => u.title);
  assert.ok(held.includes('Bookshop'), 'two first-Sundays is also two 28-day gaps');
  assert.ok(held.includes('Marriage blessing'), 'a single occurrence is not a rule');
  assert.equal(byTitle(r, 'Bookshop'), undefined);
});

test('a gap inside the window blocks the rule that would ignore it', () => {
  // 1 Nov (first), 15 Nov (third), 6 Dec (first). The smallest covering set is
  // 'first,third' — but over this window that also generates 20 Dec, which was
  // not observed. One unexplained date is enough to withhold the rule, because
  // the cost of a wrong rule is later marking real services cancelled.
  const w = { timezone: 'Australia/Melbourne', windowFrom: '2026-11-01', windowTo: '2026-12-20' };
  const r = run(series('Patchy', ['2026-11-01', '2026-11-15', '2026-12-06']), w);
  assert.equal(r.proposals.length, 0);
  assert.match(r.unexplained[0].why, /reproduces these dates exactly/);
});

test('a month-position set that does fit is proposed, at low confidence', () => {
  // {1st, 2nd, 4th} Sunday is expressible and exact over its window, so it is
  // offered — but three dates is thin, and 'low' is what says so.
  const w = { timezone: 'Australia/Melbourne', windowFrom: '2026-11-01', windowTo: '2026-11-22' };
  const r = run(series('Odd', ['2026-11-01', '2026-11-08', '2026-11-22']), w);
  assert.equal(r.proposals.length, 1);
  assert.equal(r.proposals[0].rule.week_of_month, 'first,second,fourth');
  assert.equal(r.proposals[0].confidence, 'low');
});

test('an unexplained extra date blocks an otherwise clean rule', () => {
  const clean = ['2026-11-01', '2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29'];
  const w = { timezone: 'Australia/Melbourne', windowFrom: '2026-11-01', windowTo: '2026-11-29' };
  assert.equal(run(series('Weekly', clean), w).proposals[0].rule.week_of_month, null);

  // Same series, one Sunday dropped: no longer weekly, and 'first,second,fourth,last'
  // is not a set the data supports either.
  const gappy = clean.filter(d => d !== '2026-11-15');
  assert.equal(run(series('Weekly', gappy), w).proposals.length, 1);
  assert.equal(run(series('Weekly', gappy), w).proposals[0].rule.week_of_month, 'first,second,fourth,last');
});

test('a DST transition does not split one service into two rules', () => {
  // Melbourne moved +10 -> +11 on 4 October 2026. Vespers is 5pm local on both
  // sides; stored as UTC those are different wall clocks, and grouping on the
  // instant instead of the parish's local time would produce two rules with
  // half the support each.
  const p = byTitle(run(), 'Vespers');
  assert.equal(p.support.count, 9);
  assert.ok(p.support.dates.includes('2026-09-12'), 'pre-transition');
  assert.ok(p.support.dates.includes('2026-11-07'), 'post-transition');
});

test('same title at two times stays two rules', () => {
  // Matins and Liturgy are separate services; so are two liturgies in a day.
  const r = run();
  assert.ok(byTitle(r, 'Matins (Orthros)').rule.start_time !== byTitle(r, 'Divine Liturgy').rule.start_time);
});

test('location travels with the rule', () => {
  assert.match(byTitle(run(), 'Divine Liturgy').rule.location_override, /Chaplaincy/);
  assert.match(byTitle(run(), 'Vespers').rule.location_override, /Religious Centre/);
});

test('no occurrences is not an error', () => {
  const r = inferSchedules([], MEL);
  assert.deepEqual(r, { proposals: [], unexplained: [] });
});
