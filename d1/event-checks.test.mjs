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

test('one event over several days: a last day after the first, and the time it ends on it', () => {
  const festival = { ...ok, date: '2026-11-13', start_time: '18:00', end_date: '2026-11-15', end_time: '16:00' };
  assert.deepStrictEqual(C.checkDraftEvent(festival, { today: '2026-10-08' }), [],
    'an end earlier on the clock is the last day, not "after midnight"');
  assert.deepStrictEqual(levels(C.checkDraftEvent({ ...festival, end_time: '' }, { today: '2026-10-08' })), ['end_time:block']);
  assert.deepStrictEqual(levels(C.checkDraftEvent({ ...festival, end_date: '2026-11-13' }, { today: '2026-10-08' })), ['end_date:block']);
  assert.deepStrictEqual(levels(C.checkDraftEvent({ ...festival, end_date: 'Sunday' }, { today: '2026-10-08' })), ['end_date:block']);
});

test('a one-off service needs a language; a date of a regular service and anything else do not', () => {
  const at = { today: '2026-10-08' };
  const vigil = { ...ok, title: 'Vigil', event_type: 'liturgy' };
  assert.deepStrictEqual(levels(C.checkDraftEvent(vigil, at)), ['languages:block']);
  for (const languages of [['English'], '["English"]', 'English, Greek']) {
    assert.deepStrictEqual(C.checkDraftEvent({ ...vigil, languages }, at), [], JSON.stringify(languages));
  }
  assert.deepStrictEqual(levels(C.checkDraftEvent({ ...vigil, languages: '[]' }, at)), ['languages:block']);
  assert.deepStrictEqual(C.checkDraftEvent({ ...vigil, occurrence: '12:2026-11-14' }, at), [], 'its service has one');
  assert.deepStrictEqual(C.checkDraftEvent({ ...ok, event_type: 'talk' }, at), [], 'a talk carries none');
});

test('joining another parish\'s event on file needs no language: nothing is made', () => {
  const at = { today: '2026-10-08' };
  const feast = { ...ok, title: 'Feast of St Nectarios', event_type: 'feast' };
  assert.deepStrictEqual(levels(C.checkDraftEvent(feast, at)), ['languages:block'], 'a new one at their parish still does');
  assert.deepStrictEqual(C.checkDraftEvent({ ...feast, host_parish_id: 'greek-stnectarios-burwood', host_event_id: 913 }, at), []);
});

// St Andrew, Gladesville's programme lists St Nectarios, Burwood's feast; what
// Burwood has on file that day is what it is checked against.
test('the same event on file at another parish: the one at that time, else the one of that name — never a guess', () => {
  const card = { title: 'Feast of St Nectarios', feast: '', start_time: '07:30', event_type: 'feast' };
  const feast = { id: 913, title: 'Feast of St Nectarios', feast: null, time: '07:00', event_type: 'feast' };
  const seniors = { id: 920, title: "Seniors' Group", feast: null, time: '10:00', event_type: 'social' };
  // Burwood's own poster says 7:30, Gladesville's said 7:00: the name decides.
  assert.strictEqual(C.sameEventOnFile(card, [seniors, feast]), 913);
  // Named for the liturgy, with the saint underneath: the saint is the name.
  assert.strictEqual(C.sameEventOnFile({ title: 'Hierarchical Divine Liturgy', feast: 'St Nectarios of Aegina', start_time: '09:00', event_type: 'liturgy' },
    [seniors, feast]), 913);
  // At the same time and the same kind of thing, whatever it is called.
  assert.strictEqual(C.sameEventOnFile({ title: 'Matins and Divine Liturgy', start_time: '07:00', event_type: 'liturgy' }, [seniors, feast]), 913);
  // The same time is not enough for something else altogether.
  assert.strictEqual(C.sameEventOnFile({ title: 'Youth BBQ', start_time: '10:00', event_type: 'youth' }, [seniors, feast]), null);
  // Nothing in common, or two alike: nothing.
  assert.strictEqual(C.sameEventOnFile({ title: 'Divine Liturgy', start_time: '08:00', event_type: 'liturgy' }, [seniors, feast]), null);
  assert.strictEqual(C.sameEventOnFile(card, [feast, { ...feast, id: 914, time: '19:00' }]), null);
  // Two of that name, one at its time: that one.
  assert.strictEqual(C.sameEventOnFile({ ...card, start_time: '19:00' }, [feast, { ...feast, id: 914, time: '19:00' }]), 914);
  assert.strictEqual(C.sameEventOnFile(card, []), null);
});
