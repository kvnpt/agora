// The poster reader: what it sends Claude, and what it makes of the stream
// that comes back. No network — `fetchImpl` answers with a canned stream in
// the shape the Messages API streams it.

import test from 'node:test';
import assert from 'node:assert';
import {
  POSTER_MODEL, POSTER_SCHEMA, SYSTEM_PROMPT, MAX_EVENTS, READ_KINDS,
  buildPosterRequest, posterContext, readPoster, normalizeRead, readFailure, clip,
} from './poster-read.mjs';
import { haikuStream, fakeFetch } from './test-fakes.mjs';

const PARISH = { name: 'St Nicholas', address: '1 Church St, Marrickville NSW', timezone: 'Australia/Sydney' };
const RULES = [{ day_of_week: 0, start_time: '09:00', title: 'Divine Liturgy' }];

const ONE = {
  kind: 'poster',
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

test('the request: Haiku 5.5, medium effort, structured output, the image as base64 — and nothing Haiku refuses', () => {
  const body = buildPosterRequest({ data: 'QUJD', mediaType: 'image/webp', context: 'ctx' });
  assert.strictEqual(body.model, 'claude-haiku-5-5');
  assert.strictEqual(body.stream, true);
  assert.deepStrictEqual(body.output_config,
    { effort: 'medium', format: { type: 'json_schema', schema: POSTER_SCHEMA } });
  assert.ok(!('thinking' in body), 'thinking is on by default: not turned off, not given a budget (a 400)');
  for (const k of ['temperature', 'top_p', 'top_k', 'fallbacks']) assert.ok(!(k in body), `Haiku 5.5 rejects ${k}`);
  assert.strictEqual(body.messages[body.messages.length - 1].role, 'user', 'no prefill');
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
  assert.deepStrictEqual(READ_KINDS, ['timetable', 'poster', 'not_an_event']);
});

test('the prompt asks for English, a timetable’s services, and a regular service only with its day', () => {
  assert.match(SYSTEM_PROMPT, /Write in English/);
  assert.match(SYSTEM_PROMPT, /"timetable" for a sign, board or notice giving the parish's regular services/);
  assert.match(SYSTEM_PROMPT, /Everything an image announces is one of two things, and an image can announce both/);
  assert.match(SYSTEM_PROMPT, /is listed in events only when the image says something about that date/);
  // Haiku 5.5 read Red Hill's Saturday 12 December (Liturgy 8:15 am, Great
  // Vespers 5 pm) as one event with "two times printed", the doors-and-start rule.
  assert.match(SYSTEM_PROMPT, /Two services on the same date, each printed with its own name and time, are two entries/);
  assert.match(SYSTEM_PROMPT, /two services, each with its own name, are two events/);
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

test('an answer that opens with thinking: only the text is the JSON', async () => {
  const plain = await read(fakeFetch(haikuStream(JSON.stringify(ONE))));
  const seen = [];
  const thought = await read(fakeFetch(haikuStream(JSON.stringify(ONE), { thinking: true })),
    (event, payload) => seen.push({ event, ...payload }));
  assert.strictEqual(thought.ok, true);
  assert.deepStrictEqual(thought.read, plain.read);
  assert.deepStrictEqual(seen[0], { event: 'kind', kind: 'poster' });
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

  assert.deepStrictEqual(seen[0], { event: 'kind', kind: 'poster' });
  const titles = seen.filter(s => s.event === 'field' && s.name === 'title');
  assert.ok(titles.length > 1, 'the title streams in pieces');
  assert.ok(titles.slice(0, -1).every(t => !t.done) && titles[titles.length - 1].done);
  const names = seen.filter(s => s.event === 'field' && s.done).map(s => s.name);
  assert.deepStrictEqual(names, ['title', 'date', 'printed_weekday', 'year_printed', 'start_time', 'end_time',
    'event_type', 'languages', 'location_override', 'description'], 'draft names, in form order, no notes');
  assert.deepStrictEqual(seen[seen.length - 1], { event: 'item', index: 0 });

  assert.deepStrictEqual(r.read.events[0], {
    title: 'Youth Night: Faith And Film', feast: null,
    date: '2026-11-14', start_time: '19:00', end_time: '21:30', end_date: null, event_type: 'youth',
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
  assert.strictEqual(r.kind, 'poster', 'a kind from before the two categories reads as a poster');
  assert.strictEqual(r.events.length, MAX_EVENTS);
  assert.strictEqual(r.notes[1], `Read ${MAX_EVENTS} events, the most the reader takes from one poster: check it for any after 14 November.`);
  const e = r.events[0];
  assert.deepStrictEqual(
    [e.title, e.date, e.start_time, e.end_time, e.event_type, e.languages, e.location_override, e.year_printed],
    ['Talk on prayer', null, '07:30', null, 'other', ['Greek', 'English'], 'Hall', 1]);
  assert.match(e.read_notes[0].text, /2026-02-30.*not a date/);
  assert.strictEqual(normalizeRead({ kind: 'nonsense' }).kind, 'poster', 'whatever else the model says, the image announced something');
});

test('a month of daily services: all of it under the cap, and a word when the cap is reached', () => {
  // Panagia Kamariani, Red Hill, December 2026: 1–24 December and Great
  // Vespers on the 12th. At a cap of 20 the reader stopped at the 19th and
  // nothing said so.
  const day = (n) => `2026-12-${String(n).padStart(2, '0')}`;
  const december = [...Array.from({ length: 24 }, (_, i) => ({ title: 'Divine Liturgy', date: day(i + 1), start_time: '07:30' })),
    { title: 'Great Vespers', date: '2026-12-12', start_time: '17:00' }];
  const all = normalizeRead({ kind: 'poster', events: december });
  assert.strictEqual(all.events.length, 25);
  assert.deepStrictEqual(all.notes, [], 'under the cap, nothing to say');

  const full = normalizeRead({ kind: 'poster', events: Array.from({ length: MAX_EVENTS }, (_, i) => ({ title: 'x', date: day((i % 31) + 1) })) });
  assert.strictEqual(full.events.length, MAX_EVENTS);
  assert.match(full.notes[0], /^Read 40 events, the most the reader takes from one poster: check it for any after 31 December\.$/,
    'told the cap, the reader stops at it: reaching it is the only sign of more');
  const undated = normalizeRead({ kind: 'poster', events: Array.from({ length: MAX_EVENTS }, () => ({ title: 'x' })) });
  assert.match(undated.notes[0], /check it for any it left out\.$/);
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
      week_of_month: null, languages: null, event_type: 'liturgy', description: null, effective_from: null, effective_to: null, read_notes: [] },
    { title: 'Divine Liturgy', day_of_week: 0, start_time: '18:00', end_time: null,
      week_of_month: 'second,fourth', languages: ['English'], event_type: 'liturgy', description: null, effective_from: null, effective_to: null,
      read_notes: [{ field: 'weeks', text: 'Printed as "2nd & 4th".' }] },
    { title: 'Every week', day_of_week: 0, start_time: '09:00', end_time: null,
      week_of_month: null, languages: null, event_type: 'liturgy', description: null, effective_from: null, effective_to: null, read_notes: [] },
  ]);
  assert.deepStrictEqual(r.details, { address: 'Cnr Weekes & Carpenter Ave, Rookwood', phone: '(02) 9643 2850',
    email: null, website: 'https://www.example.org.au' });
  assert.strictEqual(normalizeRead({ details: { address: '', phone: '', email: '', website: '' } }).details, null);
  assert.deepStrictEqual(normalizeRead(ONE).services, [], 'an answer without them, too');
});

test('a flyer for something held every week: a rule with its words and its period, and no event', () => {
  // St John the Baptist, Croydon Park's choir practice, which was read as one
  // event with no date — unpublishable — and caught at the timetable as "a
  // poster for an event".
  const r = normalizeRead({
    kind: 'poster', written_in: 'English', other_parish: null, events: [], notes: [],
    services: [{ title: 'CHURCH CHOIR PRACTICE', every: 'every Tuesday', day: 'Tuesday', start_time: '19:00', end_time: '',
      weeks: [], languages: ['Arabic', 'English'], event_type: 'other',
      description: ' Led by Simon Yazbek. No prior experience needed; all are welcome. ', starts: '2026-11-03', until: '', notes: [] },
    { title: 'Bible study', every: '2nd Wednesday of the month', day: 'Wednesday', start_time: '19:30', end_time: '', weeks: ['second'],
      languages: [], event_type: 'talk', description: '', starts: 'next week', until: '2026-12-09', notes: [] }],
    details: { address: '', phone: '', email: '', website: '' },
  });
  assert.strictEqual(r.kind, 'poster');
  assert.deepStrictEqual(r.events, []);
  assert.strictEqual(r.details, null, 'a flyer’s contact is not the parish’s details');
  assert.deepStrictEqual(r.services[0], { title: 'Church Choir Practice', day_of_week: 2, start_time: '19:00',
    end_time: null, week_of_month: null, languages: ['Arabic', 'English'], event_type: 'other',
    description: 'Led by Simon Yazbek. No prior experience needed; all are welcome.', effective_from: '2026-11-03',
    effective_to: null, read_notes: [] });
  assert.deepStrictEqual([r.services[1].description, r.services[1].effective_from, r.services[1].effective_to, r.services[1].week_of_month],
    [null, null, '2026-12-09', 'second'], 'no words, and a start that is not a date, are nothing; a period’s end is kept');
  assert.match(SYSTEM_PROMPT, /"7pm every Tuesday" is one/);
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

test('a long note about the poster is cut at a word, with an ellipsis, never mid-word', () => {
  const long = 'The title at the top of the table indicates a regular Tuesday service; the table then shows entries for specific Tuesdays and other days with their commemorations and events. '.repeat(4)
    + 'All dated entries have been transcribed as printed.';
  const r = normalizeRead({ notes: [long] });
  assert.ok(r.notes[0].length <= 500);
  assert.match(r.notes[0], /[a-z]…$/);
  assert.doesNotMatch(r.notes[0], / a…$/);
  assert.strictEqual(clip('Short and whole.', 500), 'Short and whole.');
  assert.strictEqual(clip('one two three four five six', 15), 'one two three…');
});

test('one event over several days keeps its last day; one that is not after the first is dropped', () => {
  const base = { title: 'Parish festival', date: '2026-11-13', start_time: '18:00', end_time: '16:00' };
  const r = normalizeRead({ kind: 'poster', events: [{ ...base, end_date: '2026-11-15' },
    { ...base, end_date: '2026-11-13' }, { ...base, end_date: '' }] });
  assert.deepStrictEqual(r.events.map(e => e.end_date), ['2026-11-15', null, null]);
  assert.match(SYSTEM_PROMPT, /One event that runs over several days .* is ONE entry with its last day in end_date/);
});

test('a feast day’s schedule: its weekday-and-time items are events on its dates, not weekly services', () => {
  // Archangel Michael, Crows Nest: "Sunday November 8 … Schedule of events:
  // Great Hierarchical Vespers 7pm Sat, Matins 7.30am Sun, Divine Liturgy 9am
  // Sun, Paniyiri 11am onwards". The reader said the schedule was that
  // Sunday's, and then offered all four as every week's.
  const svc = (title, day, start_time, event_type, every = '') => ({ title, every, day, start_time, end_time: '',
    weeks: [], languages: [], event_type, description: '', starts: '', until: '', notes: [] });
  const r = normalizeRead({
    kind: 'poster', written_in: 'English', other_parish: null, notes: [],
    events: [{ title: 'Archangel Michael Feast Day Celebrations', feast: '', date: '2026-11-08', weekday_printed: 'Sunday',
      year_printed: false, start_time: null, end_time: null, end_date: '', event_type: 'feast', languages: [],
      venue: null, description: 'Music, food, dancing and family entertainment, all day.', notes: [] }],
    services: [
      svc('Great Hierarchical Vespers', 'Saturday', '19:00', 'prayer', 'SAT'),
      svc('Matins', 'Sunday', '07:30', 'liturgy'),
      svc('Divine Liturgy', 'Sunday', '09:00', 'liturgy', 'Sun'),
      svc('Paniyiri', 'Sunday', '11:00', 'social'),
      svc('Paraklesis', 'Friday', '19:00', 'prayer', 'every Friday in November'),
    ],
    details: { address: '', phone: '', email: '', website: '' },
  });
  assert.deepStrictEqual(r.services.map(s => s.title), ['Paraklesis'], 'what the poster says repeats stays a rule');
  assert.deepStrictEqual(r.events.map(e => [e.title, e.date, e.start_time, e.event_type, e.printed_weekday]), [
    ['Archangel Michael Feast Day Celebrations', '2026-11-08', null, 'feast', 'Sunday'],
    ['Great Hierarchical Vespers', '2026-11-07', '19:00', 'prayer', 'Saturday'],
    ['Matins', '2026-11-08', '07:30', 'liturgy', 'Sunday'],
    ['Divine Liturgy', '2026-11-08', '09:00', 'liturgy', 'Sunday'],
    ['Paniyiri', '2026-11-08', '11:00', 'social', 'Sunday'],
  ]);
  assert.strictEqual(r.events[1].year_printed, 0);
  assert.deepStrictEqual(r.events[1].read_notes,
    [{ field: 'date', text: 'Printed as “Saturday”, not every Saturday; dated from the poster’s 8 November.' }]);
  assert.match(SYSTEM_PROMPT, /"Vespers 7pm Sat" and "Liturgy 9am Sun" say which day of that occasion/);
  assert.match(SYSTEM_PROMPT, /If you cannot point to such words, it is not a regular service/);
});

test('a service the poster does not call regular, with no date to put it on, stays — with a note; a sign’s always stay', () => {
  const sv = { title: 'Vespers', every: '', day: 'Saturday', start_time: '18:00', end_time: '', weeks: [],
    languages: [], event_type: 'prayer', description: '', starts: '', until: '', notes: [] };
  const empty = { address: '', phone: '', email: '', website: '' };
  const undated = normalizeRead({ kind: 'poster', events: [], services: [sv], details: empty });
  assert.deepStrictEqual(undated.events, []);
  assert.deepStrictEqual(undated.services[0].read_notes, [{ field: 'day',
    text: 'The poster does not say this is held every week. If it is for one date, add it as an event instead.' }]);
  // A month's programme is not one occasion either.
  const month = normalizeRead({ kind: 'poster', services: [sv], details: empty,
    events: [{ title: 'A', date: '2026-11-01' }, { title: 'B', date: '2026-11-29' }] });
  assert.deepStrictEqual([month.events.length, month.services.length], [2, 1]);
  const sign = normalizeRead({ kind: 'timetable', services: [sv], details: empty, events: [{ title: 'A', date: '2026-11-08' }] });
  assert.deepStrictEqual([sign.services.length, sign.services[0].read_notes], [1, []]);
});

test('a poster with no date, only a weekday over its times, is that weekday’s weekly schedule', () => {
  // St Paul, Dandenong, 31 Oct 2026: "Sunday — Matins | 9:00am, Divine Liturgy
  // (Bilingual: English & Arabic) | 10:15am, Sunday School | 11:30am,
  // Fellowship | 12:00pm". Matins and the Liturgy were read as events on the
  // coming Sunday, the other two as services.
  const svc = (title, start_time, event_type, languages = []) => ({ title, every: 'Sunday, on a poster with no date', day: 'Sunday',
    start_time, end_time: '', weeks: [], languages, event_type, description: '', starts: '', until: '', notes: [] });
  const r = normalizeRead({
    kind: 'poster', written_in: 'English', other_parish: null, notes: [], events: [],
    services: [svc('Matins', '09:00', 'prayer'), svc('Divine Liturgy', '10:15', 'liturgy', ['English', 'Arabic']),
      svc('Sunday School', '11:30', 'other'), svc('Fellowship', '12:00', 'social')],
    details: { address: '', phone: '', email: '', website: '' },
  });
  assert.deepStrictEqual(r.services.map(s => [s.title, s.day_of_week, s.start_time, s.read_notes.length]),
    [['Matins', 0, '09:00', 0], ['Divine Liturgy', 0, '10:15', 0], ['Sunday School', 0, '11:30', 0], ['Fellowship', 0, '12:00', 0]]);
  assert.deepStrictEqual(r.events, []);
  assert.match(SYSTEM_PROMPT, /A poster that prints no date anywhere, only a weekday over its times/);
  assert.match(SYSTEM_PROMPT, /"Sunday, on a poster with no date"/);
  // A feast day's poster prints its date, so its "Sat" is still that occasion's.
  assert.match(SYSTEM_PROMPT, /"Vespers 7pm Sat" and "Liturgy 9am Sun" say which day of that occasion/);
});
