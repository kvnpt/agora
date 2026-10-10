// The poster reader: what it sends Claude, and what it makes of the stream
// that comes back. No network — `fetchImpl` answers with a canned stream in
// the shape the Messages API streams it.

import test from 'node:test';
import assert from 'node:assert';
import {
  POSTER_MODEL, POSTER_SCHEMA, SYSTEM_PROMPT, MAX_EVENTS, READ_KINDS,
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
  assert.deepStrictEqual(POSTER_SCHEMA.properties.services.items.properties.event_type.enum,
    POSTER_SCHEMA.properties.events.items.properties.event_type.enum);
  // Whose poster it is comes before the events, and is always answered; a
  // sign's services and details come after them.
  assert.deepStrictEqual(POSTER_SCHEMA.required,
    ['kind', 'written_in', 'other_parish', 'events', 'services', 'details', 'notes']);
  assert.deepStrictEqual(Object.keys(POSTER_SCHEMA.properties), POSTER_SCHEMA.required);
  assert.match(SYSTEM_PROMPT, /other_parish: only when the image is plainly from a different parish/);
  assert.match(SYSTEM_PROMPT, /say it here and not in notes/);
});

test('signs and programmes added no union-typed fields — structured output caps how many a schema has', () => {
  const unions = [];
  const walk = (s, at) => {
    if (s.anyOf) { unions.push(at); s = s.anyOf[0]; }
    for (const [k, v] of Object.entries(s.properties || {})) walk(v, `${at}.${k}`);
    if (s.items) walk(s.items, `${at}[]`);
  };
  walk(POSTER_SCHEMA, '');
  assert.deepStrictEqual(unions, ['.other_parish', '.other_parish.place', '.events[].title', '.events[].date',
    '.events[].weekday_printed', '.events[].start_time', '.events[].end_time', '.events[].venue',
    '.events[].description']);
  assert.deepStrictEqual(READ_KINDS, ['event', 'several_events', 'bulletin', 'timetable', 'not_an_event']);
});

test('the prompt asks for English, a timetable’s services, and a regular service only with its day', () => {
  assert.match(SYSTEM_PROMPT, /Write in English/);
  assert.match(SYSTEM_PROMPT, /"timetable" for a sign, board or notice giving the parish's regular weekly services/);
  assert.match(SYSTEM_PROMPT, /is listed only when the image says something about that date/);
  assert.match(SYSTEM_PROMPT, /with its commemoration in feast and not in the title/);
  assert.match(SYSTEM_PROMPT, /"every 2nd and 4th Sunday" is \["second", "fourth"\]/);
  assert.match(SYSTEM_PROMPT, /Not a priest's own mobile/);
});

test('the context names the parish, its day, and the services already on the site', () => {
  const text = posterContext(PARISH, '2026-10-08', RULES);
  assert.match(text, /St Nicholas, 1 Church St, Marrickville NSW\. Time zone Australia\/Sydney\./);
  assert.match(text, /Today there is Thursday 8 October 2026\./);
  assert.match(text, /- Sundays 09:00 Divine Liturgy/);
  assert.match(text, /- youth: /);
  // The weeks and the end, so a programme's 6pm on the second Sunday reads as the rule it is.
  assert.match(posterContext(PARISH, '2026-10-08',
    [{ day_of_week: 0, start_time: '18:00', end_time: '19:30', title: 'Divine Liturgy', week_of_month: 'second,fourth' }]),
  /- Sundays 18:00–19:30 Divine Liturgy \(second and fourth of the month\)/);
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
    title: 'Youth Night: Faith And Film', feast: null,
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

test('another parish’s poster: the name and place as printed, or nothing', () => {
  assert.deepStrictEqual(
    normalizeRead({ kind: 'event', other_parish: { name: '  St Elias  Antiochian Church ', place: 'Wollongong' } }).other_parish,
    { name: 'St Elias Antiochian Church', place: 'Wollongong' });
  assert.deepStrictEqual(normalizeRead({ other_parish: { name: 'St Elias', place: '  ' } }).other_parish,
    { name: 'St Elias', place: null });
  assert.strictEqual(normalizeRead({ other_parish: { name: ' ', place: 'Wollongong' } }).other_parish, null,
    'a place with no name says nothing about whose poster it is');
  assert.strictEqual(normalizeRead({ other_parish: null }).other_parish, null);
  assert.strictEqual(normalizeRead(ONE).other_parish, null, 'an answer without it, too');
});

test('a sign: its weekly services as rules, its details, and nothing without a day and a time', () => {
  const r = normalizeRead({
    kind: 'timetable', written_in: 'English', other_parish: null, events: [], notes: [],
    services: [
      { title: 'ORTHROS & DIVINE LITURGY', day: 'Saturday', start_time: '8:00', end_time: '10:00',
        weeks: [], languages: [], event_type: 'liturgy', notes: [] },
      { title: 'Divine Liturgy', day: 'Sunday', start_time: '18:00', end_time: '',
        weeks: ['fourth', 'second'], languages: ['English'], event_type: 'liturgy',
        notes: [{ field: 'weeks', text: 'Printed as "2nd & 4th".' }] },
      { title: 'Vespers', day: 'Someday', start_time: '17:00', end_time: '', weeks: [], languages: [], event_type: 'prayer', notes: [] },
      { title: 'Paraklesis', day: 'Friday', start_time: 'evening', end_time: '', weeks: [], languages: [], event_type: 'prayer', notes: [] },
      { title: 'Every week', day: 'Sunday', start_time: '09:00', end_time: '', weeks: ['first', 'second', 'third', 'fourth', 'last'],
        languages: [], event_type: 'nonsense', notes: [] },
    ],
    details: { address: ' Cnr Weekes & Carpenter Ave, Rookwood ', phone: '(02) 9643 2850', email: 'not an email', website: 'www.example.org.au' },
  });
  assert.strictEqual(r.kind, 'timetable');
  assert.strictEqual(r.language, null, 'English is not a translation');
  assert.deepStrictEqual(r.services, [
    { title: 'Orthros & Divine Liturgy', day_of_week: 6, start_time: '08:00', end_time: '10:00',
      week_of_month: null, languages: null, event_type: 'liturgy', read_notes: [] },
    { title: 'Divine Liturgy', day_of_week: 0, start_time: '18:00', end_time: null,
      week_of_month: 'second,fourth', languages: ['English'], event_type: 'liturgy',
      read_notes: [{ field: 'weeks', text: 'Printed as "2nd & 4th".' }] },
    { title: 'Every week', day_of_week: 0, start_time: '09:00', end_time: null,
      week_of_month: null, languages: null, event_type: 'liturgy', read_notes: [] },
  ]);
  assert.deepStrictEqual(r.details, { address: 'Cnr Weekes & Carpenter Ave, Rookwood', phone: '(02) 9643 2850',
    email: null, website: 'https://www.example.org.au' });
  assert.strictEqual(normalizeRead({ details: { address: '', phone: '', email: '', website: '' } }).details, null);
  assert.deepStrictEqual(normalizeRead(ONE).services, [], 'an answer without them, too');
});

test('a programme in Greek: English titles, each date’s saint as its feast, and what it was translated from', () => {
  const r = normalizeRead({
    kind: 'bulletin', written_in: 'Greek', other_parish: null, notes: [], services: [],
    details: { address: '', phone: '', email: '', website: '' },
    events: [{ title: 'Orthros and Divine Liturgy', feast: ' Luke the Evangelist ', date: '2026-10-18',
      weekday_printed: 'Sunday', year_printed: true, start_time: '08:00', end_time: '11:00',
      event_type: 'liturgy', languages: [], venue: null, description: null, notes: [] }],
  });
  assert.strictEqual(r.language, 'Greek');
  assert.deepStrictEqual([r.events[0].title, r.events[0].feast], ['Orthros and Divine Liturgy', 'Luke the Evangelist']);
  assert.strictEqual(normalizeRead({ events: [{ title: 'x', feast: '' }] }).events[0].feast, null);
});
