// The poster reader: what it sends Claude, and what it makes of the stream
// that comes back. No network — `fetchImpl` answers with a canned stream in
// the shape the Messages API streams it.

import test from 'node:test';
import assert from 'node:assert';
import {
  POSTER_MODEL, POSTER_SCHEMA, SORT_SCHEMA, SORT_SYSTEM, SYSTEM_PROMPT, MAX_EVENTS, READ_KINDS,
  buildPosterRequest, posterContext, sortContext, readPoster, sortPosters, normalizeRead, readFailure, clip,
  sortGroups, keepParts, noteParts,
} from './poster-read.mjs';
import { onFrom } from './draft-read.mjs';
import whatsappWords from '../../public/shared/whatsapp-words.js';

const { plainWords } = whatsappWords;
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
const read = (fetchImpl, emit, extra = {}) => readPoster(
  { apiKey: 'test-key', image, mediaType: 'image/jpeg', context: 'ctx', fetchImpl, ...extra }, emit);

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
  // St Andrew Gladesville's November programme: "Cake Stall after the
  // Service" under Vespers 6:00–7:30pm came back with no start time, and the
  // editor typed 7:30pm in. The service's end is the time the poster gives.
  // Since 4 Nov 2026 the Worker works that out (afterServices, drafts.mjs),
  // from the poster's own service first and a usual length when no end is
  // printed: the reader gives only what the event follows.
  assert.match(SYSTEM_PROMPT, /An event with after has start_time null: it starts when that service ends/);
  // St John the Baptist, Croydon Park's Christmas Fair: "Sunday 13th Dec,
  // Liturgy 10AM", then a day of food and fun, no time of its own.
  assert.match(SYSTEM_PROMPT, /An event the image gives no time at all, on a day it gives a service for, follows that service too/);
  assert.match(SYSTEM_PROMPT, /"English Liturgy at 6pm" for "Following English Liturgy at 6pm"/);
  assert.match(SYSTEM_PROMPT, /For an event that starts after a service, say so \("After the Liturgy\."\)/);
  // Sts Peter & Paul, Doonside's "Outdoor Movie Night", "Following English
  // Liturgy at 6pm" (3 Nov 2026), came back at 6pm, the Liturgy's time, and
  // was taken for that Sunday's 6pm Liturgy.
  assert.match(SYSTEM_PROMPT, /A time printed with the service it follows is that service's time, not the event's/);
  assert.match(SYSTEM_PROMPT, /- after: the service the event follows, when the image gives the event no start time of its own/);
  assert.match(SYSTEM_PROMPT, /a movie night after the Liturgy is Youth or Social, never Liturgy/);
  assert.match(SYSTEM_PROMPT, /for the event itself: never the kind of a service it follows/);
  assert.match(SYSTEM_PROMPT, /with what that date is about in feast and not in the title/);
  // St Emilia's Mums Group at St Nicholas, Punchbowl (5 Nov 2026): the group
  // on first Fridays and its 6 November coaster workshop, off one poster.
  assert.match(SYSTEM_PROMPT, /is the group in services \(the first Friday of each month\) and that Friday's meeting in events/);
  assert.match(SYSTEM_PROMPT, /that date's own activity or topic as printed \("Coaster-making Workshop"\)/);
  assert.match(SYSTEM_PROMPT, /Only what holds every time: what is particular to one date/);
  assert.match(SYSTEM_PROMPT, /- venue: where it is held every time, when that is not the parish's own church/);
  assert.match(SYSTEM_PROMPT, /"every 2nd and 4th Sunday" is \["second", "fourth"\]/);
  assert.match(SYSTEM_PROMPT, /Not a priest's own mobile/);
});

test('a poster for one occasion that prints only a weekday is the coming one, counted from today', () => {
  // St Nicholas, Punchbowl's feast of St Catherine, forwarded on Thursday
  // 19 Nov 2026: "Feast of Saint Catherine the Great Martyr, Tuesday 6:30 PM,
  // St Nicholas Church Punchbowl, Vespers and the Service of the Breaking of
  // the Five Loaves". No date on it: Kevin, "Tuesday would mean the coming
  // Tuesday 24th Nov". The reader dated it wrong (here, the 25th: the feast's
  // day in some calendars, and a Wednesday).
  const empty = { address: '', phone: '', email: '', website: '' };
  const feast = (o = {}) => ({ title: 'Feast of Saint Catherine the Great Martyr', feast: '', date_printed: false,
    date: '2026-11-25', weekday_printed: 'Tuesday', year_printed: false, cancelled: false, after: '', start_time: '18:30',
    end_time: null, end_date: '', event_type: 'feast', languages: [], venue: null,
    description: 'Vespers and the Service of the Breaking of the Five Loaves.', notes: [], ...o });
  const read = (ev, today) => normalizeRead({ kind: 'poster', events: [ev], services: [], details: empty }, { today }).events[0];

  const e = read(feast(), '2026-11-19');
  assert.equal(e.date, '2026-11-24');
  assert.equal(e.printed_weekday, 'Tuesday');
  assert.equal(e.year_printed, 0);
  assert.deepEqual(e.suggested, ['date'], 'worked out, not printed: never "from poster"');
  assert.deepEqual(e.read_notes, [{ field: 'date', text: 'Printed only as “Tuesday”, so the coming one: 24 November. Check it.' }]);
  // No date at all from the reader: the same.
  assert.equal(read(feast({ date: null }), '2026-11-19').date, '2026-11-24');
  // Read on a Tuesday, it is that day; on the Wednesday, the week after.
  assert.equal(read(feast(), '2026-11-24').date, '2026-11-24');
  assert.equal(read(feast(), '2026-11-25').date, '2026-12-01');
  // Over a month's end.
  assert.equal(read(feast({ weekday_printed: 'Tue' }), '2026-11-26').date, '2026-12-01');
  // A run of days keeps its length: "Friday to Sunday".
  const run = read(feast({ weekday_printed: 'Friday', date: '2026-11-27', end_date: '2026-11-29' }), '2026-11-19');
  assert.deepEqual([run.date, run.end_date], ['2026-11-20', '2026-11-22']);

  // A printed date is the poster's, whatever its weekday says (sameYear and
  // the editor's checks look after a misprint), and nothing is moved without
  // a today to count from, or a weekday to count to.
  const printed = read(feast({ date_printed: true, date: '2026-12-01' }), '2026-11-19');
  assert.deepEqual([printed.date, printed.suggested, printed.read_notes], ['2026-12-01', undefined, []]);
  assert.equal(read(feast(), undefined).date, '2026-11-25');
  assert.equal(read(feast({ weekday_printed: null }), '2026-11-19').date, '2026-11-25');
  // A read from before date_printed is not a "no".
  const { date_printed, ...old } = feast();
  assert.equal(read(old, '2026-11-19').date, '2026-11-25');

  // The reader is told so, and given the week to find it in.
  assert.match(SYSTEM_PROMPT, /- date_printed: true when the image prints the day of the month for this date/);
  assert.match(SYSTEM_PROMPT, /When it prints only a weekday, the date is the coming one: the first such weekday on or after today/);
  assert.match(SYSTEM_PROMPT, /"Feast of Saint Catherine, Tuesday 6:30 PM, Vespers and the Breaking of the Five Loaves" is one event on the coming Tuesday/);
  assert.match(SYSTEM_PROMPT, /a poster of the parish's ordinary services that prints no date anywhere, and not one for a feast or another occasion/);
  const props = POSTER_SCHEMA.properties.events.items.properties;
  assert.equal(props.date_printed.type, 'boolean', 'no union');
  const order = Object.keys(props);
  assert.ok(order.indexOf('date_printed') < order.indexOf('date'), 'said before the date is written');
  assert.ok(POSTER_SCHEMA.properties.events.items.required.includes('date_printed'));
  assert.ok(!props.notes.items.properties.field.enum.includes('date_printed'));
});

test('the context names the parish, its day, and the services already on the site', () => {
  const text = posterContext(PARISH, '2026-10-08', RULES);
  assert.match(text, /St Nicholas, 1 Church St, Marrickville NSW\. Time zone Australia\/Sydney\./);
  assert.match(text, /Today there is Thursday 8 October 2026\./);
  // The week after it, by name, to find "Tuesday" in.
  assert.match(text, /The coming days: Friday 9 October, Saturday 10 October, Sunday 11 October, Monday 12 October, Tuesday 13 October, Wednesday 14 October, Thursday 15 October\./);
  assert.match(posterContext(PARISH, '2026-11-26', RULES), /The coming days: Friday 27 November, .*Monday 30 November, Tuesday 1 December, Wednesday 2 December, Thursday 3 December\./);
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
    languages: null, location_override: null, printed_weekday: 'Saturday', year_printed: 0, after: null, cancelled: null,
    read_notes: [{ field: 'start_time', text: 'Doors 6:30, film 7:00; used 7:00.' }],
  });
  assert.deepStrictEqual(r.usage, { model: POSTER_MODEL, input_tokens: 1800, output_tokens: 412 });
});

test('what an event follows is read before its time, kept as printed, and is no field of the form', async () => {
  const fields = Object.keys(POSTER_SCHEMA.properties.events.items.properties);
  assert.ok(fields.indexOf('after') < fields.indexOf('start_time'), 'what it follows, then the time');
  assert.deepStrictEqual(POSTER_SCHEMA.properties.events.items.properties.after.type, 'string', 'no union: empty is none');
  const doc = { kind: 'poster', events: [
    { title: 'Outdoor Movie Night', date: '2026-11-22', after: ' English  Liturgy ', start_time: null, event_type: 'youth' },
    { title: 'Parish Picnic', date: '2026-11-22', after: '', start_time: '12:00', event_type: 'social' },
  ] };
  const seen = [];
  const r = await read(fakeFetch(haikuStream(JSON.stringify(doc))), (event, p) => seen.push({ event, ...p }));
  assert.deepStrictEqual(r.read.events.map(e => e.after), ['English Liturgy', null]);
  assert.ok(!seen.some(s => s.event === 'field' && s.name === 'after'), 'the editor is not sent it');
});

test('a date called off is read before its time, only on a plain true, and is no field of the form', async () => {
  const fields = Object.keys(POSTER_SCHEMA.properties.events.items.properties);
  assert.ok(fields.indexOf('cancelled') < fields.indexOf('start_time'), 'that it is off, then when');
  assert.deepStrictEqual(POSTER_SCHEMA.properties.events.items.properties.cancelled.type, 'boolean', 'no union');
  assert.ok(POSTER_SCHEMA.properties.events.items.required.includes('cancelled'));
  const doc = { kind: 'poster', events: [
    { title: 'Divine Liturgy', date: '2030-01-27', cancelled: true, start_time: null, event_type: 'liturgy' },
    { title: 'Vespers', date: '2030-01-26', cancelled: false, start_time: '18:00', event_type: 'prayer' },
    { title: 'Bible Study', date: '2030-01-30', cancelled: 'yes', start_time: '19:00', event_type: 'talk' },
    { title: 'Matins', date: '2030-01-27', start_time: '08:00', event_type: 'prayer' },
  ] };
  const seen = [];
  const r = await read(fakeFetch(haikuStream(JSON.stringify(doc))), (event, p) => seen.push({ event, ...p }));
  assert.deepStrictEqual(r.read.events.map(e => e.cancelled), [1, null, null, null]);
  assert.ok(!seen.some(s => s.event === 'field' && s.name === 'cancelled'), 'the editor is not sent it a field at a time');
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
    { title: 'Orthros & Divine Liturgy', day_of_week: 6, start_time: '08:00', end_time: '10:00', week_of_month: null, languages: null,
      event_type: 'liturgy', location_override: null, description: null, effective_from: null, effective_to: null, read_notes: [], key: 's1' },
    { title: 'Divine Liturgy', day_of_week: 0, start_time: '18:00', end_time: null,
      week_of_month: 'second,fourth', languages: ['English'], event_type: 'liturgy', location_override: null, description: null,
      effective_from: null, effective_to: null, read_notes: [{ field: 'weeks', text: 'Printed as "2nd & 4th".' }], key: 's2' },
    { title: 'Every week', day_of_week: 0, start_time: '09:00', end_time: null, week_of_month: null, languages: null,
      event_type: 'liturgy', location_override: null, description: null, effective_from: null, effective_to: null, read_notes: [], key: 's3' },
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
    end_time: null, week_of_month: null, languages: ['Arabic', 'English'], event_type: 'other', location_override: null,
    description: 'Led by Simon Yazbek. No prior experience needed; all are welcome.', effective_from: '2026-11-03',
    effective_to: null, read_notes: [], key: 's1' });
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
  assert.match(SYSTEM_PROMPT, /A poster that prints no date anywhere, only a weekday over the parish's ordinary services/);
  assert.match(SYSTEM_PROMPT, /"Sunday, on a poster with no date"/);
  // A feast day's poster prints its date, so its "Sat" is still that
  // occasion's; one that prints only a weekday is the coming one (below).
  assert.match(SYSTEM_PROMPT, /"Vespers 7pm Sat" and "Liturgy 9am Sun" say which day of that occasion/);
});

test('a passed date the reader put in next year goes back to the poster’s year, when its weekday says so', () => {
  // St Andrew, Gladesville's November 2026 programme, read on 3 November:
  // "Sunday 1" came back as 1 November 2027, a Monday.
  const ev = (date, weekday, title = 'Matins and Liturgy') => ({ title, feast: '', date, weekday_printed: weekday,
    year_printed: true, start_time: '07:30', end_time: '10:30', end_date: '', event_type: 'liturgy', languages: [],
    venue: null, description: null, notes: [] });
  const empty = { address: '', phone: '', email: '', website: '' };
  const r = normalizeRead({ kind: 'poster', services: [], details: empty, events: [
    ev('2027-11-01', 'Sunday'), ev('2026-11-08', 'Sunday'), ev('2026-11-13', 'Friday'), ev('2026-11-15', 'Sunday'),
  ] });
  assert.deepStrictEqual(r.events.map(e => e.date), ['2026-11-01', '2026-11-08', '2026-11-13', '2026-11-15']);
  assert.deepStrictEqual(r.events[0].read_notes,
    [{ field: 'date', text: 'Read as 1 November 2027, which is not a Sunday; put in 2026 with the poster’s other dates.' }]);
  assert.deepStrictEqual(r.events[1].read_notes, [], 'the rest are left alone');

  // A programme over the new year keeps its January: those weekdays are right.
  const turn = normalizeRead({ kind: 'poster', services: [], details: empty, events: [
    ev('2026-12-27', 'Sunday'), ev('2026-12-25', 'Friday'), ev('2027-01-03', 'Sunday'),
  ] });
  assert.deepStrictEqual(turn.events.map(e => e.date), ['2026-12-27', '2026-12-25', '2027-01-03']);
  // A lone date is never moved on its weekday alone: the poster may misprint it.
  const lone = normalizeRead({ kind: 'poster', services: [], details: empty, events: [ev('2027-11-01', 'Sunday')] });
  assert.strictEqual(lone.events[0].date, '2027-11-01');
  // Nor to a weekday the other year does not have either.
  const wrong = normalizeRead({ kind: 'poster', services: [], details: empty, events: [
    ev('2027-11-01', 'Tuesday'), ev('2026-11-08', 'Sunday'), ev('2026-11-15', 'Sunday'),
  ] });
  assert.strictEqual(wrong.events[0].date, '2027-11-01');

  assert.match(SYSTEM_PROMPT, /a date in it that has already passed keeps that year/);
  assert.match(SYSTEM_PROMPT, /Only when the image prints no year anywhere, use the first such date on or after today/);
});

// ── a WhatsApp forward of several posters (St Mary's, Mays Hill, 19 Nov 2026) ──
//
// Sorted first, in a small request of its own, and each poster then read on
// its own. One read that did both had an answer format the API would not
// compile (a 400, Mays Hill's two posters, 28 Nov 2026).

const NO_DETAILS = { address: '', phone: '', email: '', website: '' };
const ev = (title, date, extra = {}) => ({ title, feast: '', date, weekday_printed: null,
  year_printed: false, cancelled: false, after: '', start_time: '19:00', end_time: null, end_date: '',
  event_type: 'social', languages: [], venue: null, description: null, notes: [], ...extra });
const announce = (pictures, words = [], parish = '', place = '') => ({ pictures, words, parish, place });
const doc = (events, extra = {}) => ({ kind: 'poster', written_in: 'English', other_parish: null,
  details: NO_DETAILS, notes: [], services: [], events, ...extra });
const readOf = (d) => ({ ok: true, read: normalizeRead(d) });

test('the sort: a small schema of its own, nothing transcribed, no unions', () => {
  assert.deepStrictEqual(SORT_SCHEMA.required, ['posters']);
  assert.deepStrictEqual(SORT_SCHEMA.properties.posters.items.required, ['pictures', 'words', 'parish', 'place']);
  const walk = (x) => {
    assert.ok(!x.anyOf, 'no union');
    if (x.type === 'object') assert.strictEqual(x.additionalProperties, false);
    for (const v of Object.values(x.properties || {})) walk(v);
    if (x.items) walk(x.items);
  };
  walk(SORT_SCHEMA);
  assert.match(SORT_SYSTEM, /Transcribe nothing/);
  assert.deepStrictEqual(POSTER_SCHEMA.required, ['kind', 'written_in', 'other_parish', 'events', 'services', 'details', 'notes'],
    'each poster is read with the one schema there is');
});

test('the sort asks with each picture numbered, the words in numbered parts, at low effort', async () => {
  const words = 'Good morning!\n\n*Seafood Night*\nSunday 29 November\n\n*Fruit Picking*\nSaturday 16 January';
  const text = sortContext(PARISH, 3, words);
  assert.match(text, /There are 3 images, each headed with its number\./);
  assert.match(text, /or several posters at once, each its own announcement/);
  assert.match(text, /an image with nothing of its own to announce, such as a QR code/);
  assert.match(text, /\[1\] Good morning!\n\[2\] \*Seafood Night\*\nSunday 29 November\n\[3\] \*Fruit Picking\*\nSaturday 16 January/);
  assert.match(text, /Sort the images\.$/);

  const answer = { posters: [announce([1], [2]), announce([2, 3], [3])] };
  const fetchImpl = fakeFetch(haikuStream(JSON.stringify(answer)));
  const two = [{ bytes: image, mediaType: 'image/jpeg' }, { bytes: image, mediaType: 'image/png' }];
  const r = await sortPosters({ apiKey: 'k', images: two, parish: PARISH, note: words, fetchImpl });
  assert.deepStrictEqual(r.posters, answer.posters);
  const sent = fetchImpl.calls[0].body;
  assert.deepStrictEqual(sent.messages[0].content.map(c => c.type === 'text' ? c.text.slice(0, 8) : c.type),
    ['Image 1:', 'image', 'Image 2:', 'image', 'The pari']);
  assert.deepStrictEqual(sent.output_config.format.schema, SORT_SCHEMA);
  assert.strictEqual(sent.output_config.effort, 'low');
  assert.strictEqual(sent.system, SORT_SYSTEM);
  assert.ok(sent.max_tokens <= 4000);

  // Read as one, as ever: no numbers, the reader's own schema.
  const together = buildPosterRequest({ images: [{ data: 'QUFB', mediaType: 'image/jpeg' }, { data: 'QkJC', mediaType: 'image/png' }], context: 'ctx' });
  assert.deepStrictEqual(together.messages[0].content.map(c => c.type), ['image', 'image', 'text']);
  assert.strictEqual(together.output_config.format.schema, POSTER_SCHEMA);
});

test('one poster of several, read on its own: told so, with its own words or all of them as everyone’s', () => {
  const own = posterContext(PARISH, '2026-11-19', RULES, '*Seafood Night*\nSunday 29 November',
    { whatsapp: true, pictures: 1, part: { n: 2, of: 4, shared: false } });
  assert.match(own, /This image is announcement 2 of the 4 forwarded together on WhatsApp\. The others are read on their own: read only this one\./);
  assert.doesNotMatch(own, /came with the other announcements too/);
  const shared = posterContext(PARISH, '2026-11-19', RULES, 'See you all there',
    { whatsapp: true, pictures: 2, part: { n: 1, of: 2, shared: true } });
  assert.match(shared, /These 2 images are announcement 1 of the 2/);
  assert.match(shared, /They came with the other announcements too, and may be about those as well: take from them only what is about this one\./);
  // Not one of several (the editor's read again of a draft's pictures): one announcement, as before.
  const one = posterContext(PARISH, '2026-11-19', RULES, 'words', { whatsapp: true, pictures: 3 });
  assert.match(one, /sent together as one announcement: read them as one image/);
  assert.doesNotMatch(one, /announcement \d of the/);
});

test('the words in parts: paragraphs, or the lines of one paragraph', () => {
  assert.deepStrictEqual(noteParts('Hello\n\n*A*\nline\n \n*B*'), { parts: ['Hello', '*A*\nline', '*B*'], sep: '\n\n' });
  assert.deepStrictEqual(noteParts('*A* Sunday\n*B* Monday'), { parts: ['*A* Sunday', '*B* Monday'], sep: '\n' });
  assert.deepStrictEqual(noteParts('   '), { parts: [], sep: '\n\n' });
  assert.deepStrictEqual(noteParts('One line').parts, ['One line']);
});

test('the words as a description: WhatsApp’s marks off, emojis and links kept', () => {
  assert.strictEqual(plainWords('🍤 *Seafood Night Fellowship!*\n📅 Sunday 29 November\n 💵 $15 per plate '),
    '🍤 Seafood Night Fellowship!\n📅 Sunday 29 November\n💵 $15 per plate');
  assert.strictEqual(plainWords('_Bring a plate_ and ~bring~ a chair'), 'Bring a plate and bring a chair', 'the marks go, never the words');
  assert.strictEqual(plainWords('Email my_name_here@x.org or see https://x.org/a_b_c *now*'),
    'Email my_name_here@x.org or see https://x.org/a_b_c now');
  assert.strictEqual(plainWords('2 * 3 * 4'), '2 * 3 * 4', 'a star that marks nothing stays');
  assert.strictEqual(plainWords('a\n\n\n\nb'), 'a\n\nb');
  assert.strictEqual(plainWords(''), null);
  assert.ok(plainWords('word '.repeat(400)).length <= 1000);
});

test('the sort as groups to read: four posters are four, each with its pictures and words', () => {
  const groups = sortGroups([announce([1], [2]), announce([2], [3]), announce([3], [4]), announce([4])], { pictures: 4, words: 5 });
  assert.deepStrictEqual(groups.map(g => [g.pictures, g.words]), [[[1], [2]], [[2], [3]], [[3], [4]], [[4], []]]);
  // One announcement over both pictures, a poster and its translation: one group, so one read.
  assert.strictEqual(sortGroups([announce([1, 2], [1])], { pictures: 2, words: 1 }).length, 1);
  // Nothing usable said about the pictures, or one picture: one read of them all.
  assert.strictEqual(sortGroups([], { pictures: 2 }), null);
  assert.strictEqual(sortGroups([announce([], [1])], { pictures: 2, words: 1 }), null);
  assert.strictEqual(sortGroups([announce([7, 0, 1.5, '2'])], { pictures: 2 }), null, 'no picture that is one');
  assert.strictEqual(sortGroups([announce([1]), announce([2])], { pictures: 1 }), null);
  assert.strictEqual(sortGroups('nope', { pictures: 2 }), null);
});

test('a picture no poster lists goes with the one before it; one listed twice is the first’s', () => {
  // 1 a poster, 2 listed by nobody, 3 another poster, 4 listed twice.
  const groups = sortGroups([announce([1], [1, 9]), announce([3, 4], [3]), announce([4], [2])], { pictures: 4, words: 3 });
  assert.deepStrictEqual(groups.map(g => [g.pictures, g.words]), [[[1, 2], [1]], [[3, 4], [3]], [[], [2]]],
    'a part of the words not shown is no part; one only in the words is last');
  // The first picture, listed by nobody, goes with the one after it.
  assert.deepStrictEqual(sortGroups([announce([2]), announce([3])], { pictures: 3 }).map(g => g.pictures), [[1, 2], [3]]);
  // Listed in an order that is not the pictures': by the first picture each holds.
  const order = sortGroups([announce([], [3]), announce([2], [2], 'St Nicholas', 'Punchbowl'), announce([1], [1])], { pictures: 2, words: 3 });
  assert.deepStrictEqual(order.map(g => [g.pictures, g.words, g.parish]), [[[1], [1], null], [[2], [2], 'St Nicholas'], [[], [3], null]]);
});

test('each poster’s read is a draft; one that read nothing goes with the picture before it, and a failure says so', () => {
  const groups = sortGroups([announce([1], [1]), announce([2], [2]), announce([3], [3], 'St Elias', 'Wollongong'), announce([4], [])],
    { pictures: 4, words: 3 });
  const parts = keepParts(groups, [
    readOf(doc([ev('MENS GROUP', '2026-11-19')])),
    readOf(doc([])),                                   // a QR code: nothing of its own
    readOf(doc([ev('Fruit Picking Trip', '2027-01-16')])),
    { ok: false, error: 'The poster reader is busy — try again in a minute.', retry: true },
  ], { pictures: 4 });
  assert.deepStrictEqual(parts.map(p => [p.pictures, p.words]), [[[1, 2], [1, 2]], [[3, 4], [3]]]);
  assert.deepStrictEqual(parts.map(p => p.read.events.map(e => e.title)), [['Mens Group'], ['Fruit Picking Trip']], 'each normalised');
  assert.deepStrictEqual(parts[1].read.notes, ['Image 4 could not be read on its own, so it is with these pictures: read it again to try.']);
  assert.deepStrictEqual(parts[0].read.notes, [], 'nothing to say of a picture that read as nothing');
  // Whose it is, when its read does not say: the sort's.
  assert.deepStrictEqual(parts[1].read.other_parish, { name: 'St Elias', place: 'Wollongong' });
  assert.strictEqual(parts[0].read.other_parish, null);
  // Its read's own say wins over the sort's.
  const own = keepParts(sortGroups([announce([1], [], 'St Elias'), announce([2])], { pictures: 2 }),
    [readOf(doc([ev('A', '2027-01-10')], { other_parish: { name: 'St George', place: 'Enmore' } })), readOf(doc([ev('B', '2027-01-11')]))],
    { pictures: 2 });
  assert.strictEqual(own[0].read.other_parish.name, 'St George');
  // Nothing read anywhere: no drafts to make.
  assert.deepStrictEqual(keepParts(groups, groups.map(() => readOf(doc([]))), { pictures: 4 }), []);
});

test('a sign among the posters keeps its services and its details', () => {
  const service = { title: 'Divine Liturgy', every: 'Sundays', day: 'Sunday', start_time: '09:00', end_time: '',
    weeks: [], languages: [], event_type: 'liturgy', venue: '', description: '', starts: '', until: '', notes: [] };
  const parts = keepParts(sortGroups([announce([1]), announce([2])], { pictures: 2 }), [
    readOf(doc([ev('Fete', '2027-03-06')])),
    readOf(doc([], { kind: 'timetable', services: [service], details: { address: '1 Church St', phone: '', email: '', website: '' } })),
  ], { pictures: 2 });
  assert.deepStrictEqual(parts.map(p => p.read.services.length), [0, 1]);
  assert.strictEqual(parts[0].read.details, null);
  assert.deepStrictEqual(parts[1].read.details, { address: '1 Church St', phone: null, email: null, website: null });
});

test('readPoster counts a weekday printed alone from the today it is given', async () => {
  const d = doc([ev('Feast of Saint Catherine', '2026-11-25', { date_printed: false, weekday_printed: 'Tuesday' }),
    ev('Youth night', '2026-11-27', { date_printed: true, weekday_printed: 'Friday' })]);
  const r = await readPoster({ apiKey: 'k', image, mediaType: 'image/jpeg', context: 'ctx', today: '2026-11-19',
    fetchImpl: fakeFetch(haikuStream(JSON.stringify(d))) });
  assert.deepStrictEqual(r.read.events.map(e => e.date), ['2026-11-24', '2026-11-27']);
});

// ── a read that stops part-way (Cabramatta's timetable, 28 Nov 2026) ──
//
// Out of room after 56 seconds in the editor, and cut off by the runtime at
// 30 on WhatsApp: both kept nothing. Now what it finished is kept, and where
// it stopped, for reading on.

const PROGRAMME = [
  ev('Divine Liturgy', '2026-12-06', { start_time: '09:00', event_type: 'liturgy' }),
  ev('Vespers', '2026-12-12', { start_time: '17:00', event_type: 'vespers' }),
  ev('Divine Liturgy', '2026-12-13', { start_time: '09:00', event_type: 'liturgy' }),
  ev('Sunday School picnic', '2026-12-13', { start_time: '12:00' }),
];
/** The answer as far as it got: whole events, then part of the next. */
const sofar = (events, into = 'Divine Litu') =>
  `{"kind":"poster","written_in":"English","other_parish":null,"events":[${events.map(e => JSON.stringify(e)).join(',')},{"title":"${into}`;

test('out of room, a read keeps every event it finished and says where it stopped', async () => {
  const seen = [];
  const r = await read(fakeFetch(haikuStream(sofar(PROGRAMME.slice(0, 3)), { stop: 'max_tokens' })), (e, p) => seen.push({ e, ...p }));
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.read.events.map(e => [e.title, e.date]),
    [['Divine Liturgy', '2026-12-06'], ['Vespers', '2026-12-12'], ['Divine Liturgy', '2026-12-13']]);
  assert.deepStrictEqual(r.cut, { after: '2026-12-13', count: 3, title: 'Divine Liturgy', why: 'max_tokens',
    had: [{ date: '2026-12-06', start_time: '09:00', title: 'Divine Liturgy' }, { date: '2026-12-12', start_time: '17:00', title: 'Vespers' },
      { date: '2026-12-13', start_time: '09:00', title: 'Divine Liturgy' }], note: r.cut.note });
  assert.strictEqual(r.read.cut, r.cut);
  assert.match(r.cut.note, /^Read up to 13 December, when there was more on the poster than one read takes: the rest is still to read\.$/);
  assert.deepStrictEqual(r.read.notes, [r.cut.note]);
  assert.deepStrictEqual(seen.filter(x => x.e === 'item').map(x => x.index), [0, 1, 2], 'the editor saw each as it came');
  assert.strictEqual(r.read.kind, 'poster');

  // Out of room before one event was whole: nothing to keep, as before.
  const none = await read(fakeFetch(haikuStream(sofar([]), { stop: 'max_tokens' })));
  assert.deepStrictEqual([none.ok, none.retry], [false, false]);
  assert.match(none.error, /more on this poster/);
});

test('at the most events one read lists, it stops there too, to read on', async () => {
  // Cabramatta's timetable is about 57 dated services: told the cap, a read lists 40 and ends.
  const day = (n) => new Date(Date.UTC(2026, 10, 22 + n)).toISOString().slice(0, 10);
  const forty = Array.from({ length: MAX_EVENTS }, (_, i) => ev('Divine Liturgy', day(i), { start_time: '09:00' }));
  const r = await read(fakeFetch(haikuStream(JSON.stringify(doc(forty, { notes: ['Small print.'] })))));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.read.events.length, MAX_EVENTS);
  assert.deepStrictEqual([r.cut.after, r.cut.why, r.cut.count, r.cut.had.length], ['2026-12-31', 'cap', 40, 40]);
  assert.deepStrictEqual(r.read.notes, ['Small print.',
    'Read up to 31 December, when it had read 40 events, the most one read takes: the rest is still to read.'],
    'said once, as a stop, not as "check it for any after"');
  assert.ok(!('capped' in r.read));
  // Under it, a whole read: no stop.
  const some = await read(fakeFetch(haikuStream(JSON.stringify(doc(forty.slice(0, 39))))));
  assert.strictEqual(some.cut, null);
});

/** A fetch whose answer comes as far as `text` and then waits, until the read gives up on it. */
const stalls = (text) => async (url, init) => {
  const body = new TextEncoder().encode(haikuStream(text).split('event: content_block_stop')[0]);
  return new Response(new ReadableStream({
    start(c) {
      c.enqueue(body);
      init.signal.addEventListener('abort', () => c.error(init.signal.reason || new DOMException('aborted', 'AbortError')));
    },
  }), { status: 200 });
};

test('out of time, a read stops at its deadline and keeps what it finished', async (t) => {
  // AbortSignal.timeout's timer holds nothing open in Node: this does, while the reads wait.
  const hold = setInterval(() => {}, 50);
  t.after(() => clearInterval(hold));
  const t0 = Date.now();
  const r = await read(stalls(sofar(PROGRAMME.slice(0, 2))), undefined, { deadline: Date.now() + 1200 });
  assert.ok(Date.now() - t0 < 5000);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.read.events.map(e => e.title), ['Divine Liturgy', 'Vespers']);
  assert.deepStrictEqual([r.cut.after, r.cut.why], ['2026-12-12', 'deadline']);
  assert.match(r.cut.note, /^Read up to 12 December, when it ran out of time/);

  // A stop the caller sets later (the editor gone: routes/admin.mjs) is the same.
  const stop = new AbortController();
  setTimeout(() => stop.abort(), 300);
  const later = await read(stalls(sofar(PROGRAMME.slice(0, 1))), undefined, { stop: stop.signal });
  assert.deepStrictEqual([later.ok, later.cut.why, later.read.events.length], [true, 'deadline', 1]);

  // Out of time with nothing whole: say so, to try again.
  const nothing = await read(stalls(sofar([])), undefined, { deadline: Date.now() + 300 });
  assert.deepStrictEqual([nothing.ok, nothing.retry], [false, true]);
  assert.match(nothing.error, /took too long/);
});

test('reading on: told every event on the draft already, and where it stopped', () => {
  const cut = { after: '2026-12-13', count: 2, title: 'Divine Liturgy',
    had: [{ date: '2026-12-06', start_time: '09:00', title: 'Divine Liturgy' }, { date: '2026-12-13', start_time: '09:00', title: 'Divine Liturgy' }] };
  const text = posterContext(PARISH, '2026-11-28', RULES, '', { pdf: true, after: cut });
  assert.match(text, /This read goes on from one that stopped part-way, after “Divine Liturgy” on 13 December\. The events it read are on the draft already:\n- Sunday 6 December 2026 09:00: Divine Liturgy\n- Sunday 13 December 2026 09:00: Divine Liturgy\nList in events only the ones not among them, in the order the image gives them\./);
  assert.doesNotMatch(posterContext(PARISH, '2026-11-28', RULES, '', { pdf: true }), /goes on from/);
});

test('what a read on says again is dropped, an event out of date order kept, and its own stop has all read so far', () => {
  const after = { after: '2026-12-13', count: 3, title: 'Divine Liturgy', had: [
    { date: '2026-12-06', start_time: '09:00', title: 'Divine Liturgy' }, { date: '2026-12-12', start_time: '17:00', title: 'Vespers' },
    { date: '2026-12-13', start_time: '09:00', title: 'Divine Liturgy' }] };
  const r = { ok: true, read: normalizeRead(doc([
    ev('divine liturgy ', '2026-12-13', { start_time: '09:00' }),   // said again
    ev('Vespers', '2026-12-12', { start_time: null }),              // said again, its time left out
    ev('Sunday School picnic', '2026-12-13', { start_time: '12:00' }),
    ev('Parish lunch', '2026-12-06', { start_time: '12:00' }),      // listed last, on the 6th
    ev('Divine Liturgy', '2026-12-20', { start_time: '09:00' }),
  ])) };
  r.read.cut = { after: '2026-12-20', count: 5, title: 'Divine Liturgy', had: [], why: 'max_tokens' };
  onFrom(r, after);
  assert.deepStrictEqual(r.read.events.map(e => e.title), ['Sunday School picnic', 'Parish lunch', 'Divine Liturgy']);
  assert.strictEqual(r.read.cut.count, 6, 'three before, three now');
  assert.deepStrictEqual(r.read.cut.had.map(e => e.date), ['2026-12-06', '2026-12-12', '2026-12-13', '2026-12-13', '2026-12-06', '2026-12-20']);
});
