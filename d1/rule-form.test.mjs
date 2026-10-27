// One weekly service's form (public/shared/rule-form.js), as /next adds and
// edits a rule: how often, the fortnight's dates, and the request a form makes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import R from '../public/shared/rule-form.js';

// A stand-in for the projection's week count: weeks from Monday 5 Jan 1970,
// alternating a, b.
const weekAbOf = (iso) => (Math.floor((Date.parse(iso + 'T00:00:00Z') / 86400000 - 4) / 7) % 2 ? 'b' : 'a');
const TODAY = '2026-10-19';   // a Monday

test('a fortnight is its next dates, on its weekday, in its own weeks', () => {
  const a = R.fortnightDates(0, 'a', TODAY, weekAbOf);
  const b = R.fortnightDates(0, 'b', TODAY, weekAbOf);
  assert.equal(a.length, 3);
  for (const d of [...a, ...b]) assert.equal(new Date(d + 'T00:00:00Z').getUTCDay(), 0);
  assert.ok(a.every(d => weekAbOf(d) === 'a') && b.every(d => weekAbOf(d) === 'b'));
  // Two weeks apart, and the two fortnights interleave.
  assert.equal((Date.parse(a[1]) - Date.parse(a[0])) / 86400000, 14);
  assert.equal(Math.abs(Date.parse(a[0]) - Date.parse(b[0])) / 86400000, 7);
  assert.deepEqual(R.fortnightDates(0, 'a', TODAY, null), [], 'no week count, no dates');
});

test('the fortnight that comes round first is offered first', () => {
  const order = R.parityOrder(0, TODAY, weekAbOf);
  const first = R.fortnightDates(0, order[0], TODAY, weekAbOf, 1)[0];
  const second = R.fortnightDates(0, order[1], TODAY, weekAbOf, 1)[0];
  assert.ok(first < second);
});

test('a first date in the words a person uses, with the date beside them', () => {
  assert.equal(R.naturalFirstDate('2026-10-19', TODAY), 'Today, 19 Oct');
  assert.equal(R.naturalFirstDate('2026-10-20', TODAY), 'Tomorrow, 20 Oct');
  assert.equal(R.naturalFirstDate('2026-10-25', TODAY), 'This Sunday, 25 Oct');
  assert.equal(R.naturalFirstDate('2026-11-01', TODAY), 'Next Sunday, 1 Nov');
  assert.equal(R.naturalFirstDate('2026-11-08', TODAY), 'Sunday 8 Nov');
  assert.match(R.fortnightPreview(0, 'a', TODAY, weekAbOf), /^(This|Next) Sunday, \d+ \w+ · then \d+ \w+, \d+ \w+$/);
});

test('how often is always both columns, and never both set', () => {
  assert.deepEqual(R.cadence('weekly'), { week_of_month: null, week_parity: null });
  assert.deepEqual(R.cadence('wom', ['first', 'third']), { week_of_month: 'first,third', week_parity: null });
  assert.deepEqual(R.cadence('wom', []), { week_of_month: null, week_parity: null }, 'no week ticked is every week');
  assert.deepEqual(R.cadence('fortnight', ['first'], 'b'), { week_of_month: null, week_parity: 'b' });
  assert.deepEqual(R.cadence('fortnight', [], 'x'), { week_of_month: null, week_parity: 'a' });
});

test("a form's values are the request the routes take, every empty a null", () => {
  const body = R.requestBody({
    title: '  Vespers ', day_of_week: '6', start_time: '18:00', end_time: '', event_type: 'prayer',
    languages: 'English, Arabic,', description: ' ', hide_live: true, parish_scoped: false,
    effective_from: '', effective_to: '2026-12-31',
    location_override: '', location_parish_id: '', location_lat: '', location_lng: '',
    cadence: 'wom', weeks: ['last'], parity: 'a',
  });
  assert.deepEqual(body, {
    title: 'Vespers', feast: null, day_of_week: 6, days: [6], start_time: '18:00', end_time: null, event_type: 'prayer',
    languages: '["English","Arabic"]', description: null, hide_live: 1, parish_scoped: 0,
    effective_from: null, effective_to: '2026-12-31',
    location_override: null, location_parish_id: null, location_lat: null, location_lng: null,
    week_of_month: 'last', week_parity: null,
  });
  const away = R.requestBody({ title: 'Liturgy', day_of_week: '0', start_time: '09:00',
    location_override: 'St Mary’s hall', location_lat: '-33.9', location_lng: '151.1', cadence: 'weekly' });
  assert.equal(away.location_lat, -33.9);
  assert.equal(away.location_lng, 151.1);
  assert.equal(away.event_type, 'liturgy', 'a kind left unpicked is a liturgy, as the route has it');
});

test('what stops a save is said, and an end before the start is asked', () => {
  const ok = { title: 'Vespers', start_time: '18:00', end_time: '19:00' };
  assert.equal(R.problem(ok), null);
  assert.deepEqual(R.problem({ ...ok, title: null }), { error: 'Give the service a name.' });
  assert.deepEqual(R.problem({ ...ok, start_time: null }), { error: 'When does it start?' });
  assert.deepEqual(R.problem({ ...ok, end_time: '17:30' }), { late: true });
  assert.deepEqual(R.problem({ ...ok, effective_from: '2026-12-01', effective_to: '2026-11-01' }),
    { error: 'Its last date is before its first.' });
});

test('the days ticked are the days sent, Sunday first, and none is asked for', () => {
  const body = R.requestBody({ title: 'Compline', days: ['6', '1', '0', '1'], start_time: '21:00', cadence: 'weekly' });
  assert.deepEqual(body.days, [0, 1, 6]);
  assert.equal(body.day_of_week, 0);
  const none = R.requestBody({ title: 'Compline', days: [], start_time: '21:00', cadence: 'weekly' });
  assert.deepEqual(none.days, []);
  assert.deepEqual(R.problem(none), { error: 'Tick the days it runs.' });
  assert.deepEqual(R.daysOf({ day_of_week: 3 }), [3], 'a rule is its one day');
});
