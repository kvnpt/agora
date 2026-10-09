// The poster reader: what it sends Claude, and what it makes of the stream
// that comes back. No network — `fetchImpl` answers with a canned stream in
// the shape the Messages API streams it.

import test from 'node:test';
import assert from 'node:assert';
import {
  POSTER_MODEL, POSTER_SCHEMA, SYSTEM_PROMPT, MAX_EVENTS,
  buildPosterRequest, posterContext, readPoster, normalizeRead, readFailure,
} from './poster-read.mjs';
import { haikuStream, fakeFetch } from './test-fakes.mjs';

const PARISH = { name: 'St Nicholas', address: '1 Church St, Marrickville NSW', timezone: 'Australia/Sydney' };
const RULES = [{ day_of_week: 0, start_time: '09:00', title: 'Divine Liturgy' }];

const ONE = {
  kind: 'event',
  events: [{
    title: 'YOUTH NIGHT: FAITH AND FILM', date: '2026-11-14', weekday_printed: 'Saturday', year_printed: false,
    start_time: '19:00', end_time: '21:30', event_type: 'youth', languages: [], venue: null,
    description: 'A film and a talk for young adults. Bring a plate to share.',
    notes: [{ field: 'start_time', text: 'Doors 6:30, film 7:00; used 7:00.' }],
  }],
  notes: [],
};

const image = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
const read = (fetchImpl, emit) => readPoster(
  { apiKey: 'test-key', image, mediaType: 'image/jpeg', context: 'ctx', fetchImpl }, emit);

test('the request: Haiku 4.5, structured output, the image as base64 — and nothing Haiku refuses', () => {
  const body = buildPosterRequest({ data: 'QUJD', mediaType: 'image/webp', context: 'ctx' });
  assert.strictEqual(body.model, 'claude-haiku-4-5');
  assert.strictEqual(body.stream, true);
  assert.deepStrictEqual(body.output_config, { format: { type: 'json_schema', schema: POSTER_SCHEMA } });
  assert.ok(!('effort' in body.output_config), 'Haiku 4.5 rejects effort');
  assert.ok(!('thinking' in body) && !('fallbacks' in body));
  assert.deepStrictEqual(body.messages[0].content[0],
    { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'QUJD' } });
  assert.strictEqual(body.system, SYSTEM_PROMPT);
});

test('the schema is closed at every level and offers only the seven kinds', () => {
  const walk = (s) => {
    if (s.type === 'object') assert.strictEqual(s.additionalProperties, false);
    for (const v of Object.values(s.properties || {})) walk(v.anyOf ? v.anyOf[0] : v);
    if (s.items) walk(s.items);
  };
  walk(POSTER_SCHEMA);
  assert.deepStrictEqual(POSTER_SCHEMA.properties.events.items.properties.event_type.enum,
    ['liturgy', 'prayer', 'feast', 'talk', 'youth', 'social', 'other']);
});

test('the context names the parish, its day, and the services already on the site', () => {
  const text = posterContext(PARISH, '2026-10-08', RULES);
  assert.match(text, /St Nicholas, 1 Church St, Marrickville NSW\. Time zone Australia\/Sydney\./);
  assert.match(text, /Today there is Thursday 8 October 2026\./);
  assert.match(text, /- Sundays 09:00 Divine Liturgy/);
  assert.match(text, /- youth: /);
  assert.match(posterContext(PARISH, '2026-10-08', []), /- none on file/);
});

test('a streamed answer arrives as fields, then items, then the normalised read', async () => {
  const f = fakeFetch(haikuStream(JSON.stringify(ONE)));
  const seen = [];
  const r = await read(f, (event, payload) => seen.push({ event, ...payload }));

  assert.strictEqual(r.ok, true);
  assert.strictEqual(f.calls[0].url, 'https://api.anthropic.com/v1/messages');
  const h = f.calls[0].init.headers;
  assert.strictEqual(h['x-api-key'], 'test-key');
  assert.strictEqual(h['anthropic-version'], '2023-06-01');
  assert.strictEqual(f.calls[0].body.messages[0].content[0].source.data, Buffer.from(image).toString('base64'));

  assert.deepStrictEqual(seen[0], { event: 'kind', kind: 'event' });
  const titles = seen.filter(s => s.event === 'field' && s.name === 'title');
  assert.ok(titles.length > 1, 'the title streams in pieces');
  assert.ok(titles.slice(0, -1).every(t => !t.done) && titles[titles.length - 1].done);
  const names = seen.filter(s => s.event === 'field' && s.done).map(s => s.name);
  assert.deepStrictEqual(names, ['title', 'date', 'printed_weekday', 'year_printed', 'start_time', 'end_time',
    'event_type', 'languages', 'location_override', 'description'], 'draft names, in form order, no notes');
  assert.deepStrictEqual(seen[seen.length - 1], { event: 'item', index: 0 });

  assert.deepStrictEqual(r.read.events[0], {
    title: 'Youth Night: Faith And Film',
    date: '2026-11-14', start_time: '19:00', end_time: '21:30', event_type: 'youth',
    description: 'A film and a talk for young adults. Bring a plate to share.',
    languages: null, location_override: null, printed_weekday: 'Saturday', year_printed: 0,
    read_notes: [{ field: 'start_time', text: 'Doors 6:30, film 7:00; used 7:00.' }],
  });
  assert.deepStrictEqual(r.usage, { model: POSTER_MODEL, input_tokens: 1800, output_tokens: 412 });
});

test('a refusal, a cut-off answer and a mid-stream error each say what happened', async () => {
  const refused = await read(fakeFetch(haikuStream('', { stop: 'refusal' })));
  assert.deepStrictEqual([refused.ok, refused.retry], [false, false]);
  assert.match(refused.error, /would not read/);

  const long = await read(fakeFetch(haikuStream('{"kind":"event","events":[', { stop: 'max_tokens' })));
  assert.deepStrictEqual([long.ok, long.retry], [false, false]);
  assert.match(long.error, /more on this poster/);

  const overloaded = 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n';
  const busy = await read(fakeFetch(haikuStream('{"kind":"ev', { extra: [overloaded] })));
  assert.deepStrictEqual([busy.ok, busy.retry], [false, true]);
  assert.match(busy.error, /busy/);

  const garbled = await read(fakeFetch(haikuStream('{"kind": nope}')));
  assert.deepStrictEqual([garbled.ok, garbled.retry], [false, true]);
});

test('HTTP failures and an unreachable API become one line and a retry flag', async () => {
  for (const [status, retry, words] of [[401, false, /key was refused/], [429, true, /busy/],
    [529, true, /trouble/], [400, false, /refused the request/]]) {
    const r = await read(fakeFetch('{"type":"error"}', { status }));
    assert.deepStrictEqual([r.ok, r.retry], [false, retry], String(status));
    assert.match(r.error, words);
    assert.deepStrictEqual(readFailure(status), { retry, error: r.error });
  }
  const offline = await read(async () => { throw new TypeError('fetch failed'); });
  assert.deepStrictEqual([offline.ok, offline.retry], [false, true]);
  assert.match(offline.error, /Could not reach/);
});

test('normalising: shapes checked, odd values dropped with a note, the list capped', () => {
  const r = normalizeRead({
    kind: 'several_events',
    notes: ['Bottom edge cut off.'],
    events: [
      { title: '  Talk  on   prayer ', date: '2026-02-30', start_time: '7:30', end_time: 'late',
        event_type: 'lecture', languages: ['Greek', ' ', 'English'], venue: 'Hall', year_printed: true },
      ...Array.from({ length: MAX_EVENTS + 2 }, () => ({ title: 'x', date: '2026-11-14' })),
    ],
  });
  assert.strictEqual(r.kind, 'several_events');
  assert.strictEqual(r.events.length, MAX_EVENTS);
  assert.match(r.notes[1], /more than 20 events/);
  const e = r.events[0];
  assert.deepStrictEqual(
    [e.title, e.date, e.start_time, e.end_time, e.event_type, e.languages, e.location_override, e.year_printed],
    ['Talk on prayer', null, '07:30', null, 'other', ['Greek', 'English'], 'Hall', 1]);
  assert.match(e.read_notes[0].text, /2026-02-30.*not a date/);
  assert.strictEqual(normalizeRead({ kind: 'nonsense' }).kind, 'event');
});
