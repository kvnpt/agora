// Week A / week B — the fortnight.
//
// The table in recurrence.mjs is the shipped answer, and this is what makes it
// trustworthy: every assertion below rebuilds it from a CONTINUOUS count of
// weeks and checks the shipped copy against that, rather than against a second
// hand-written list that could be wrong in the same way.

import test from 'node:test';
import assert from 'node:assert';
import {
  WEEK_AB_FROM, WEEK_AB_TO, WEEK_AB_TABLE,
  weekAParity, weekAbOf, matchesWeekParity, isoWeekOf, matchesWeekOfMonth,
} from '../../public/shared/recurrence.mjs';

const DAY = 86400000, WEEK = 7 * DAY;
const d = (s) => Date.parse(s + 'T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const EPOCH = d('1970-01-05');                    // a Monday
const mondayOf = (ms) => ms - ((new Date(ms).getUTCDay() + 6) % 7) * DAY;

/** The independent answer: a plain running count of weeks since the epoch. */
const countedAb = (dateStr) =>
  Math.round((mondayOf(d(dateStr)) - EPOCH) / WEEK) % 2 === 0 ? 'a' : 'b';

/** Every date from `from` to `to`, inclusive. */
function* everyDay(from, to) {
  for (let t = d(from); t <= d(to); t += DAY) yield iso(t);
}

test('the shipped table is exactly what a continuous count produces', () => {
  for (let year = WEEK_AB_FROM; year <= WEEK_AB_TO; year++) {
    const week1Monday = mondayOf(Date.UTC(year, 0, 4));   // ISO week 1 holds 4 Jan
    const expected = Math.round((week1Monday - EPOCH) / WEEK) % 2 === 0 ? 1 : 0;
    assert.equal(WEEK_AB_TABLE[year - WEEK_AB_FROM], expected,
      `table entry for ${year} does not continue the alternation`);
  }
});

test('the table covers 2020 through 2126, with no gaps', () => {
  assert.equal(WEEK_AB_FROM, 2020);
  assert.equal(WEEK_AB_TO, 2126);
  assert.equal(WEEK_AB_TABLE.length, 2126 - 2020 + 1);
  assert.ok(WEEK_AB_TABLE.every(v => v === 0 || v === 1), 'every entry is a parity');
});

test('A and B alternate on a fixed weekday, every week, for a century', () => {
  // Sundays, because that is when the services this exists for actually run.
  let prev = null, checked = 0;
  for (const date of everyDay('2020-01-05', '2126-12-26')) {
    if (new Date(d(date)).getUTCDay() !== 0) continue;
    const ab = weekAbOf(date);
    if (prev) assert.notEqual(ab, prev, `${date} repeats ${ab} — the alternation broke`);
    prev = ab;
    checked++;
  }
  assert.ok(checked > 5000, `only checked ${checked} Sundays`);
});

test('every date in the table\'s range agrees with the continuous count', () => {
  for (const date of everyDay('2020-01-01', '2126-12-31')) {
    assert.equal(weekAbOf(date), countedAb(date), `disagreement on ${date}`);
  }
});

test('past the table, the sequence carries on rather than stopping', () => {
  for (const date of everyDay('2127-01-01', '2135-12-31')) {
    assert.equal(weekAbOf(date), countedAb(date), `disagreement past the table on ${date}`);
  }
  assert.equal(WEEK_AB_TABLE[2127 - WEEK_AB_FROM], undefined, 'this range is past the table');
});

// ── The seam the table exists for ────────────────────────────────────────

test('a 53-week year does not give a fortnightly service a 7-day gap', () => {
  // 2026 has 53 ISO weeks. 3 Jan 2027 is 2026-W53 and 10 Jan 2027 is 2027-W01
  // — both ODD, which is what breaks a bare "odd weeks" reading.
  assert.equal(isoWeekOf('2027-01-03').week, 53);
  assert.equal(isoWeekOf('2027-01-03').year, 2026);
  assert.equal(isoWeekOf('2027-01-10').week, 1);
  assert.equal(isoWeekOf('2027-01-10').year, 2027);
  assert.equal(isoWeekOf('2027-01-03').week % 2, isoWeekOf('2027-01-10').week % 2);

  // The table carries the alternation across it anyway.
  assert.notEqual(weekAbOf('2027-01-03'), weekAbOf('2027-01-10'));

  // And the gaps either side of the seam are a fortnight, not a week.
  const sundays = [...everyDay('2026-11-01', '2027-03-01')]
    .filter(s => new Date(d(s)).getUTCDay() === 0);
  const hits = sundays.filter(s => weekAbOf(s) === weekAbOf('2026-11-08'));
  const gaps = new Set(hits.slice(1).map((s, i) => (d(s) - d(hits[i])) / DAY));
  assert.deepEqual([...gaps], [14], `gaps across the 2026→2027 seam were ${[...gaps]}`);
});

test('every 53-week seam in the table survives, not just 2026', () => {
  for (let year = WEEK_AB_FROM; year < WEEK_AB_TO; year++) {
    if (isoWeekOf(`${year}-12-28`).week !== 53) continue;   // 28 Dec is always in the last week
    // The last Monday of the long year and the first of the next must differ.
    const lastMonday = iso(mondayOf(d(`${year}-12-28`)));
    const nextMonday = iso(d(lastMonday) + WEEK);
    assert.notEqual(weekAbOf(lastMonday), weekAbOf(nextMonday),
      `${year}→${year + 1} repeats ${weekAbOf(lastMonday)}`);
  }
});

// ── The rule predicate ───────────────────────────────────────────────────

test('a NULL parity is not a fortnightly rule and matches every week', () => {
  for (const date of everyDay('2026-09-01', '2026-10-31')) {
    assert.equal(matchesWeekParity(date, null), true);
    assert.equal(matchesWeekParity(date, ''), true);
  }
});

test('a and b partition the weeks — never both, never neither', () => {
  for (const date of everyDay('2026-01-01', '2028-12-31')) {
    const a = matchesWeekParity(date, 'a'), b = matchesWeekParity(date, 'b');
    assert.ok(a !== b, `${date} matched a=${a} b=${b}`);
  }
});

test('parity is case-insensitive, because a scraper writes what it reads', () => {
  const date = '2026-09-13';
  assert.equal(matchesWeekParity(date, 'A'), matchesWeekParity(date, 'a'));
  assert.equal(matchesWeekParity(date, 'B'), matchesWeekParity(date, 'b'));
});

test('a whole week shares one parity, Monday to Sunday', () => {
  for (const monday of ['2026-09-07', '2026-12-28', '2027-01-04']) {
    const want = weekAbOf(monday);
    for (let i = 0; i < 7; i++) {
      assert.equal(weekAbOf(iso(d(monday) + i * DAY)), want,
        `the week of ${monday} is not one parity throughout`);
    }
  }
});

// ── The case that paid for the feature ───────────────────────────────────

test("Good Shepherd's FOUNDATIONS course, which week_of_month gets wrong", () => {
  // Observed, from worker/lib/infer.fixture.mjs.
  const OBSERVED = ['2026-09-13', '2026-09-27', '2026-10-11', '2026-10-25'];
  const parity = weekAbOf(OBSERVED[0]);
  for (const o of OBSERVED) {
    assert.equal(weekAbOf(o), parity, `${o} is not the same fortnight as the rest`);
  }

  // infer.mjs records that it really runs on 22 November 2026. 'second,last' —
  // the closest week_of_month spelling, and the one that fits the four observed
  // dates exactly — omits it and invents 29 November instead.
  assert.equal(matchesWeekParity('2026-11-22', parity), true);
  assert.equal(matchesWeekOfMonth('2026-11-22', 'second,last'), false);
  assert.equal(matchesWeekParity('2026-11-29', parity), false);
  assert.equal(matchesWeekOfMonth('2026-11-29', 'second,last'), true);
});

test('a fortnightly rule keeps a 14-day cadence where week_of_month drifts to 21', () => {
  const sundays = [...everyDay('2026-09-13', '2026-12-20')]
    .filter(s => new Date(d(s)).getUTCDay() === 0);
  const parity = weekAbOf('2026-09-13');
  const byParity = sundays.filter(s => matchesWeekParity(s, parity));
  const byWom = sundays.filter(s => matchesWeekOfMonth(s, 'second,last'));
  const gapsOf = (xs) => [...new Set(xs.slice(1).map((s, i) => (d(s) - d(xs[i])) / DAY))].sort();
  assert.deepEqual(gapsOf(byParity), [14]);
  assert.deepEqual(gapsOf(byWom), [14, 21]);
});
