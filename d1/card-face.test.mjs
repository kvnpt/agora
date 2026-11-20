// The event's form as its card (public/shared/card-face.js): the parts'
// words and the colour of their dots. The taps are DOM, driven in a browser
// (docs/browser-checks.md).

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const F = require('../public/shared/card-face.js');

test('the clock and the day read as the event card says them', () => {
  assert.strictEqual(F.hm12('18:00'), '6pm');
  assert.strictEqual(F.hm12('08:15'), '8:15am');
  assert.strictEqual(F.hm12('00:00'), '12am');
  assert.strictEqual(F.hm12('12:30'), '12:30pm');
  assert.strictEqual(F.hm12(''), '');
  assert.strictEqual(F.dayText('2026-11-29', '', 2026), 'Sunday 29 November');
  assert.strictEqual(F.dayText('2027-01-03', '', 2026), 'Sunday 3 January 2027', 'another year says which');
  assert.strictEqual(F.dayText('2026-11-27', '2026-11-29', 2026), 'Friday 27 – Sunday 29 November', 'one month said once');
  assert.strictEqual(F.dayText('2026-11-30', '2026-12-01', 2026), 'Monday 30 November – Tuesday 1 December');
  assert.strictEqual(F.dayText('2026-11-29', '2026-11-29', 2026), 'Sunday 29 November', 'a last day on the first is one day');
  assert.strictEqual(F.timeWithDay('19:00', '2026-11-27'), '7pm Fri');
});

test('a part\'s colour: doubt, then a change, then what the reader made of it', () => {
  assert.strictEqual(F.stateOf({ value: true, read: true }), 'read');
  assert.strictEqual(F.stateOf({ value: true, read: true, noted: true }), 'guess', 'a note says it was worked out');
  assert.strictEqual(F.stateOf({ value: true, read: true, looked: true }), '', 'looked at, it is grey');
  assert.strictEqual(F.stateOf({ value: false, doubt: true, looked: true }), 'miss', 'missing stays red though looked at');
  assert.strictEqual(F.stateOf({ value: true, changed: true, looked: true }), 'chg', 'a change stays while it differs');
  assert.strictEqual(F.stateOf({ value: true, doubt: true, changed: true }), 'miss', 'doubt before a change');
  assert.strictEqual(F.stateOf({ value: false, read: true }), '', 'nothing there and nothing wanted is grey');
  assert.strictEqual(F.stateOf({ value: true }), '', 'on file or typed is grey');
});

test('a part is a button in its colour, and says so to a screen reader', () => {
  const h = F.part('start_time', 'Add a start time', 'miss', { empty: true, label: 'Starts' });
  assert.match(h, /^<button type="button" class="cf-u cf-miss cf-empty" data-face="start_time"/);
  assert.match(h, /aria-label="Starts: none\. Missing or doubtful\. Tap to change\."/);
  const t = F.part('title', 'Fish <& chips>', 'read', { label: 'Title' });
  assert.ok(t.includes('>Fish &lt;&amp; chips&gt;</button>'), 'what the poster says is escaped');
  assert.ok(!F.part('title', 'x', '').includes('cf-  '), 'grey has no colour class');
});

test('the tally says what is left to do in each colour, never what was read, and nothing when nothing is', () => {
  const h = F.tallyHTML({ miss: 1, chg: 2, guess: 0, read: 4 });
  assert.match(h, /1 to fill in/);
  assert.match(h, /2 change what's on file/);
  assert.ok(!/read/.test(h), 'no green count (Kevin, 20 Nov 2026)');
  assert.ok(!/to check/.test(h));
  assert.match(F.tallyHTML({ chg: 1 }), /1 changes what's on file/);
  assert.strictEqual(F.tallyHTML({ read: 5 }), '', 'a read alone asks nothing');
  assert.strictEqual(F.tallyHTML({}), '');
});
