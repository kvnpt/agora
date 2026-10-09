// The add-event editor's pure parts. The rest of it is DOM, and is driven in a
// browser (docs/browser-checks.md) — CI runs no page.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.AgoraEventTypes = require('../public/shared/event-types.js');
const E = require('../public/shared/event-editor.js');

test('a card in one line: date, time, title, kind', () => {
  assert.strictEqual(E.summaryLine({ date: '2026-11-14', start_time: '19:00', end_time: '21:30',
    title: ' Youth Night ', event_type: 'youth' }, { thisYear: 2026 }),
  'Sat 14 Nov · 7:00–9:30 pm · Youth Night · Youth');
  assert.strictEqual(E.summaryLine({}, { thisYear: 2026 }), 'No date · No time · Untitled');
  assert.strictEqual(E.dateLabel('2027-01-07', 2026), 'Thu 7 Jan 2027', 'another year says which');
});

test('times read the way the cards print them', () => {
  assert.strictEqual(E.timeRange('19:00', '21:30'), '7:00–9:30 pm');
  assert.strictEqual(E.timeRange('11:00', '13:00'), '11:00 am–1:00 pm');
  assert.strictEqual(E.timeRange('00:30', ''), '12:30 am');
  assert.strictEqual(E.timeRange('', '10:00'), '');
});

test('languages travel as a list and are typed as a line', () => {
  assert.deepStrictEqual(E.textToLangs(' Greek,, English ,'), ['Greek', 'English']);
  assert.strictEqual(E.langsToText(['Greek', 'English']), 'Greek, English');
});

test('also-appears-at lists every parish: own first, then its jurisdiction by distance', () => {
  const own = { id: 'a', name: 'A', jurisdiction: 'greek', lat: -33.9, lng: 151.2 };
  const rows = E.orderParishRows(own, [
    { id: 'far', name: 'Far', jurisdiction: 'greek', lat: -27.5, lng: 153.0 },
    { id: 'ant', name: 'Ant', jurisdiction: 'antiochian', lat: -33.9, lng: 151.2 },
    own,
    { id: 'near', name: 'Near', jurisdiction: 'greek', lat: -33.8, lng: 151.2 },
    { id: '_unassigned', name: 'x' },
  ], (cap, pid) => pid === 'a' || pid === 'near');
  assert.deepStrictEqual(rows.map(r => r.id), ['a', 'near', 'far', 'ant']);
  assert.ok(rows[0]._isOwn);
  assert.deepStrictEqual(rows.slice(1).map(r => r._needsAsk), [false, true, true], 'marked, not hidden');
  assert.strictEqual(E.kmLabel(rows[1]._km), '11 km');
  assert.strictEqual(E.kmLabel(4.26), '4.3 km');
});

test('an ask is needed when anything ticked is somebody else’s', () => {
  const may = (cap, pid) => pid === 'mine';
  const parishOf = (rid) => ({ '7': 'mine', '3:2026-11-15': 'theirs' }[rid]);
  assert.strictEqual(E.askNeeded({ also_at: ['mine'], replaces: ['7'] }, may, parishOf), false);
  assert.strictEqual(E.askNeeded({ also_at: ['theirs'], replaces: [] }, may, parishOf), true);
  assert.strictEqual(E.askNeeded({ also_at: [], replaces: ['3:2026-11-15'] }, may, parishOf), true);
  assert.strictEqual(E.askNeeded({ also_at: [], replaces: ['99'] }, may, parishOf), false, 'unknown waits for the Worker');
});

test('the read fills only what nobody has typed — or what it is filling itself', () => {
  const card = { touched: new Set(['title']), readFilling: new Set(['description']),
    fields: { title: 'Mine', date: '', description: 'Bring a pl', location_override: 'Hall' } };
  assert.strictEqual(E.takesRead(card, 'title'), false, 'typed');
  assert.strictEqual(E.takesRead(card, 'date'), true, 'empty');
  assert.strictEqual(E.takesRead(card, 'description'), true, 'its own partial');
  assert.strictEqual(E.takesRead(card, 'location_override'), false, 'already holds something');
});
