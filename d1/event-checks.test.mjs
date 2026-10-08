// The checks a card shows while it is edited and the Worker enforces on
// Publish. One file, two readers — so the tests are of the file.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const C = require('../public/shared/event-checks.js');
const T = require('../public/shared/event-types.js');

const ok = { title: 'Youth Night', date: '2026-11-14', start_time: '19:00', end_time: '21:30' };
const levels = (checks) => checks.map(c => `${c.field}:${c.level}`);

test('a complete event has nothing to say', () => {
  assert.deepStrictEqual(C.checkDraftEvent(ok, { today: '2026-10-08' }), []);
});

test('missing title, date and start time block Publish', () => {
  const checks = C.checkDraftEvent({}, { today: '2026-10-08' });
  assert.deepStrictEqual(levels(checks), ['title:block', 'date:block', 'start_time:block']);
  assert.strictEqual(C.blockers(checks).length, 3);
});

test('a value that is not a date or a time blocks too', () => {
  const checks = C.checkDraftEvent({ ...ok, date: '2026-02-30', start_time: '7pm', end_time: '25:00' });
  assert.deepStrictEqual(levels(checks), ['date:block', 'start_time:block', 'end_time:block']);
});

test('the printed weekday is checked against the date', () => {
  // 15 Nov 2026 is a Sunday.
  const checks = C.checkDraftEvent({ ...ok, date: '2026-11-15', printed_weekday: 'SAT.' });
  assert.deepStrictEqual(levels(checks), ['date:warn']);
  assert.strictEqual(checks[0].text, 'The poster says Saturday, but 15 Nov 2026 is a Sunday.');
  // A matching weekday, or one that is not a weekday at all, says nothing.
  assert.deepStrictEqual(C.checkDraftEvent({ ...ok, printed_weekday: 'Saturday' }), []);
  assert.deepStrictEqual(C.checkDraftEvent({ ...ok, printed_weekday: 'Σάββατο' }), []);
});

test('an assumed year, a past date and an overnight end are said', () => {
  const checks = C.checkDraftEvent(
    { ...ok, date: '2026-10-01', year_printed: 0, start_time: '23:00', end_time: '02:30' },
    { today: '2026-10-08' });
  assert.deepStrictEqual(levels(checks), ['date:info', 'date:warn', 'end_time:info']);
  assert.strictEqual(checks[0].text, 'No year on the poster — read as 2026.');
  assert.strictEqual(C.blockers(checks).length, 0, 'none of these stop a Publish');
});

test('shapes: dates are real days, times are 24-hour HH:MM', () => {
  assert.ok(C.isLocalDate('2028-02-29'));
  assert.ok(!C.isLocalDate('2026-02-29'));
  assert.ok(!C.isLocalDate('2026-1-05'));
  assert.ok(C.isLocalTime('00:00') && C.isLocalTime('23:59'));
  assert.ok(!C.isLocalTime('24:00') && !C.isLocalTime('9:30'));
  assert.strictEqual(C.printedWeekday('thurs'), 4);
  assert.strictEqual(C.printedWeekday('Sa'), null);
});

test('event kinds: one list, and every kind says what it is for', () => {
  assert.deepStrictEqual(T.EVENT_TYPES, ['liturgy', 'prayer', 'feast', 'talk', 'youth', 'social', 'other']);
  for (const k of T.KINDS) assert.ok(k.label && k.hint, k.id);
  assert.ok(T.isEventType('youth') && !T.isEventType('vespers'));
  assert.strictEqual(T.eventTypeLabel('youth'), 'Youth');
});
