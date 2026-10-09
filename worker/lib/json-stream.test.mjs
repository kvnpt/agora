// The incremental scanner the poster reader feeds Claude's stream through.
//
// The property that matters is that WHERE the chunks break makes no
// difference: every split of the same document must produce the same completed
// values in the same order, and the same document at the end.

import test from 'node:test';
import assert from 'node:assert';
import { createJsonScanner } from './json-stream.mjs';

const DOC = {
  kind: 'several_events',
  events: [
    {
      title: 'Youth Night: “Faith & Film” \u{1F3AC}',
      date: '2026-11-14', weekday_printed: 'Saturday', year_printed: false,
      start_time: '19:00', end_time: null, event_type: 'youth', languages: ['English'],
      location: null, description: 'Bring a plate.\nRSVP to \\Fr John\\ by "Friday".',
      notes: [],
    },
    {
      title: 'Talk', date: '2026-11-21', weekday_printed: null, year_printed: true,
      start_time: '18:30', end_time: '20:00', event_type: 'talk', languages: [],
      location: 'Church hall', description: null,
      notes: [{ field: 'start_time', text: 'Two times printed; used 6:30.' }],
    },
  ],
  notes: ['Some text is cut off at the bottom.'],
  n: -1.5e2,
};
// Escaped the way a model writes it: \u escapes for the non-ASCII, so a split
// can land inside one.
const TEXT = JSON.stringify(DOC, null, 1).replace(/[\u007f-￿]/g,
  c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

function run(chunks, partial = () => false) {
  const done = [], partials = [];
  const s = createJsonScanner({
    partial,
    onValue: (e) => (e.done ? done : partials).push({ path: e.path.join('.'), value: e.value }),
  });
  for (const c of chunks) s.push(c);
  return { doc: s.end(), done, partials };
}

test('one push reads the document and reports each value as it closes', () => {
  const { doc, done } = run([TEXT]);
  assert.deepStrictEqual(doc, DOC);
  const paths = done.map(d => d.path);
  assert.strictEqual(paths[0], 'kind');
  assert.ok(paths.indexOf('events.0.title') < paths.indexOf('events.0.date'), 'in document order');
  assert.ok(paths.includes('events.0'), 'a closed object is reported too');
  assert.deepStrictEqual(done.find(d => d.path === 'events.1.notes.0').value,
    { field: 'start_time', text: 'Two times printed; used 6:30.' });
  assert.strictEqual(paths[paths.length - 1], '', 'the root closes last');
});

test('every split point gives the same values and the same document', () => {
  const want = run([TEXT]).done;
  for (let i = 0; i <= TEXT.length; i++) {
    const got = run([TEXT.slice(0, i), TEXT.slice(i)]);
    assert.deepStrictEqual(got.doc, DOC, `split at ${i}`);
    assert.deepStrictEqual(got.done, want, `split at ${i}`);
  }
});

test('one character at a time, with partial titles, never shows half a character', () => {
  const titles = (p) => p[p.length - 1] === 'title';
  const { done, partials } = run([...TEXT], titles);
  const final = done.find(d => d.path === 'events.0.title').value;
  const seen = partials.filter(p => p.path === 'events.0.title').map(p => p.value);
  assert.ok(seen.length > 5, 'the title arrives in pieces');
  for (const v of seen) {
    assert.ok(final.startsWith(v), `${JSON.stringify(v)} is a prefix of the title`);
    const last = v.charCodeAt(v.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), 'no lone high surrogate');
  }
  assert.ok(!partials.some(p => p.path === 'events.0.description'), 'only the paths asked for');
});

test('malformed or unfinished input throws rather than guessing', () => {
  assert.throws(() => run(['{"a": 1,}']), /Expected a key/);
  assert.throws(() => run(['{"a": tru']), /Not a value/);
  assert.throws(() => run(['{"a": [1, 2']), /ended early/);
  assert.throws(() => run(['{"a": "\\q"}']), /Bad escape/);
  assert.throws(() => run(['{"a": 1} x']), /after the end/);
  assert.deepStrictEqual(run([' 42 ']).doc, 42, 'a bare value at the top is fine');
});
