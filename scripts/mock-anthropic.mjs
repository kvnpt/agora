// A stand-in for the Claude Messages API, for driving the poster reader under
// `wrangler dev` without a key or a bill: it answers POST /v1/messages with a
// canned Haiku stream, slowly, so the editor's fields can be watched filling
// in. docs/browser-checks.md has the recipe.
//
//   node scripts/mock-anthropic.mjs [port]          # default 8788
//   wrangler dev ... --var ANTHROPIC_BASE_URL:http://127.0.0.1:8788
//
//   POST /__mode   {"mode":"one"|"three"|"elsewhere"|"not_an_event"|"busy"
//                   |"sign_rookwood"|"sign_doonside"|"programme_rookwood","delay":60}
//                  elsewhere: St Elias, Wollongong's poster, read as if dropped at another parish
//                  sign_*: the board out the front of St Athanasios, Rookwood and of
//                    Sts Peter & Paul, Doonside — weekly services and details
//                  programme_rookwood: St Athanasios's October 2026 programme, in
//                    Greek, read in English — its Saturdays and Sundays with their saints
//                  (each written from the photo by hand: what a good read of it says)
//   GET  /__calls  what the Worker sent: model, top-level keys, headers, image
//
// Dev tooling only — nothing deployed imports it.
import http from 'node:http';

const port = Number(process.argv[2] || 8788);
let mode = 'one', delay = 60;
const calls = [];

const DOCS = {
  one: {
    kind: 'event',
    other_parish: null,
    events: [{
      title: 'Youth Night: Faith and Film', date: '2026-11-14', weekday_printed: 'Saturday', year_printed: false,
      start_time: '19:00', end_time: '21:30', event_type: 'youth', languages: ['English'], venue: 'Church hall',
      description: 'A film and a short talk for young adults, followed by supper. Bring a plate to share.',
      notes: [{ field: 'start_time', text: 'Doors 6:30, film 7:00; used 7:00.' }],
    }],
    notes: [],
  },
  three: {
    kind: 'several_events',
    other_parish: null,
    events: [
      { title: 'Lenten Talk: The Ladder of Divine Ascent', date: '2026-11-18', weekday_printed: 'Wednesday', year_printed: false,
        start_time: '19:30', end_time: '20:30', event_type: 'talk', languages: [], venue: null,
        description: 'Fr Nicholas on the first steps of the Ladder.', notes: [] },
      { title: 'Lenten Talk: Watchfulness', date: '2026-11-25', weekday_printed: 'Thursday', year_printed: false,
        start_time: '19:30', end_time: '20:30', event_type: 'talk', languages: [], venue: null,
        description: null, notes: [] },
      { title: 'Feast of St Nicholas', date: '2026-12-06', weekday_printed: 'Sunday', year_printed: false,
        start_time: '09:00', end_time: null, event_type: 'feast', languages: ['Greek', 'English'], venue: null,
        description: 'Divine Liturgy followed by a parish lunch.', notes: [] },
    ],
    notes: [],
  },
  // Dropped at a parish other than St Elias: the reader says whose it is, and
  // gives St Elias's address as the venue — somewhere else, from there.
  elsewhere: {
    kind: 'event',
    other_parish: { name: 'St Elias Antiochian Orthodox Church', place: 'Wollongong' },
    events: [{
      title: 'Youth Movie Night', date: '2026-11-13', weekday_printed: 'Friday', year_printed: false,
      start_time: '19:00', end_time: '21:30', event_type: 'youth', languages: [], venue: '86 Kenny St, Wollongong NSW',
      description: 'A movie and pizza for the youth of the parish. Bring a friend.', notes: [],
    }],
    notes: [],
  },
  not_an_event: { kind: 'not_an_event', other_parish: null, events: [], notes: ['The image is a photo of the church with no event on it.'] },

  // The sign out the front of St Athanasios, Rookwood: Greek, with the
  // church's name in English. Two weekly services and the phone; no street.
  sign_rookwood: {
    kind: 'timetable', written_in: 'Greek', other_parish: null, events: [], notes: [],
    services: [
      { title: 'Orthros and Divine Liturgy', day: 'Saturday', start_time: '08:00', end_time: '10:00', weeks: [],
        languages: [], event_type: 'liturgy', notes: [] },
      { title: 'Orthros and Divine Liturgy', day: 'Sunday', start_time: '08:00', end_time: '11:00', weeks: [],
        languages: [], event_type: 'liturgy', notes: [] },
    ],
    details: { address: '', phone: '(02) 9643 2850', email: '', website: '' },
  },
  // Sts Peter & Paul, Doonside's sign, from a photo somebody sent on WhatsApp.
  // The priests' mobiles are theirs, not the parish's phone.
  sign_doonside: {
    kind: 'timetable', written_in: 'English', other_parish: null, events: [], notes: [],
    services: [
      { title: 'Divine Liturgy', day: 'Sunday', start_time: '10:00', end_time: '', weeks: [],
        languages: ['Arabic', 'English'], event_type: 'liturgy', notes: [] },
      { title: 'Divine Liturgy', day: 'Sunday', start_time: '18:00', end_time: '', weeks: ['second', 'fourth'],
        languages: ['English'], event_type: 'liturgy', notes: [] },
    ],
    details: { address: '182 Hill End Road, Doonside 2767', phone: '', email: '', website: '' },
  },
  // ΠΡΟΓΡΑΜΜΑ ΜΗΝΟΣ ΟΚΤΩΒΡΙΟΥ: every Saturday and Sunday of October 2026,
  // Orthros and Divine Liturgy, with the day's saint.
  programme_rookwood: {
    kind: 'bulletin', written_in: 'Greek', other_parish: null, notes: [], services: [],
    details: { address: 'Cnr Weekes & Carpenter Ave, Rookwood NSW 2141', phone: '(02) 9643 2850',
      email: 'stathanasiosrookwood@gmail.com', website: '' },
    events: [
      ['2026-10-03', 'Saturday', 'Dionysios the Areopagite'],
      ['2026-10-04', 'Sunday', 'Hierotheos, Bishop of Athens'],
      ['2026-10-10', 'Saturday', 'Eulampios the Martyr'],
      ['2026-10-11', 'Sunday', 'Sunday of the Holy Fathers'],
      ['2026-10-17', 'Saturday', 'Translation of the Relics of St Lazarus'],
      ['2026-10-18', 'Sunday', 'Luke the Evangelist'],
      ['2026-10-24', 'Saturday', 'Arethas the Great Martyr'],
      ['2026-10-25', 'Sunday', 'Sixth Sunday of Luke'],
      ['2026-10-31', 'Saturday', 'Stachys the Apostle'],
    ].map(([date, day, feast]) => ({
      title: 'Orthros and Divine Liturgy', feast, date, weekday_printed: day, year_printed: true,
      start_time: '08:00', end_time: day === 'Saturday' ? '10:00' : '11:00', event_type: 'liturgy',
      languages: [], venue: null, description: null, notes: [],
    })),
  },
};

// Every answer in the schema's full shape (worker/lib/poster-read.mjs), as
// structured output always gives it.
for (const d of Object.values(DOCS)) {
  d.written_in ??= 'English';
  d.services ??= [];
  d.details ??= { address: '', phone: '', email: '', website: '' };
  for (const e of d.events) e.feast ??= '';
}

const frame = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.url === '/__mode') {
    const m = JSON.parse(body || '{}');
    if (m.mode) mode = m.mode;
    if (m.delay != null) delay = m.delay;
    res.end(JSON.stringify({ mode, delay, calls: calls.length }));
    return;
  }
  if (req.url === '/__calls') { res.end(JSON.stringify(calls)); return; }
  if (req.method !== 'POST' || req.url !== '/v1/messages') { res.statusCode = 404; res.end(); return; }
  const parsed = JSON.parse(body);
  calls.push({ model: parsed.model, keys: Object.keys(parsed), headers: { key: req.headers['x-api-key'], version: req.headers['anthropic-version'] },
    image: parsed.messages[0].content[0].source.media_type, bytes: parsed.messages[0].content[0].source.data.length,
    context: parsed.messages[0].content[1].text });
  if (mode === 'busy') {
    res.writeHead(529, { 'content-type': 'application/json' });
    res.end('{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const text = JSON.stringify(DOCS[mode]);
  res.write(frame('message_start', { message: { model: parsed.model, usage: { input_tokens: 1700 } } }));
  res.write(frame('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
  for (let i = 0; i < text.length; i += 9) {
    await sleep(delay);
    res.write(frame('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(i, i + 9) } }));
  }
  res.write(frame('content_block_stop', { index: 0 }));
  res.write(frame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 380 } }));
  res.write(frame('message_stop', {}));
  res.end();
}).listen(port, '127.0.0.1', () => console.log(`mock anthropic on ${port}`));
