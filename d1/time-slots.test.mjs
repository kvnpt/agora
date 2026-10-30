// A day of Coming up in time slots: the rows at one time share one stretch of
// its rule, with the time said once (public/shared/timetable-lines.js slotsOf).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TL = require('../public/shared/timetable-lines.js');

const at = (time, title) => ({ time, title });
const slots = (rows) => TL.slotsOf(rows, r => r.time).map(s => [s.time, s.rows.map(r => r.title)]);

test('rows at one time are one slot, in the order they came', () => {
  assert.deepEqual(slots([at('08:00', 'Orthros'), at('09:00', 'Liturgy in English'), at('09:00', 'Matins'), at('09:00', 'Festival'), at('17:00', 'Vespers')]), [
    ['08:00', ['Orthros']],
    ['09:00', ['Liturgy in English', 'Matins', 'Festival']],
    ['17:00', ['Vespers']],
  ]);
});

test('only a run is a slot: the same time apart is two', () => {
  // Rows from two zones in a parish's own wall clock need not come in its order.
  assert.deepEqual(slots([at('09:00', 'Sydney'), at('08:30', 'Perth'), at('09:00', 'Brisbane')]).map(s => s[0]), ['09:00', '08:30', '09:00']);
});

test('no rows, no slots', () => {
  assert.deepEqual(TL.slotsOf([], r => r.time), []);
});
