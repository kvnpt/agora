// /api/ingest/whatsapp: a poster forwarded to Agora's number becomes a draft.
//
// Through the real Router, with Meta's Graph API and the Messages API faked,
// because what can go wrong is between the pieces: a webhook nobody signed, a
// delivery Meta repeats read twice, a poster and its words read as two
// announcements, a phone drafting at a parish its account may not edit.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Router } from '../lib/router.mjs';
import { registerAdminRoutes } from './admin.mjs';
import { registerIngestRoutes } from './ingest.mjs';
import { GRAPH } from '../lib/whatsapp.mjs';
import { haikuStream } from '../lib/test-fakes.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new S(this.db, sql, []); }
  async batch(stmts) { return this.db.transaction(() => stmts.map(s => s._runSync()))(); }
}
class S {
  constructor(db, sql, a) { this.db = db; this.sql = sql; this.args = a; }
  bind(...a) { return new S(this.db, this.sql, a); }
  _runSync() {
    const st = this.db.prepare(this.sql);
    if (st.reader) return { results: st.all(...this.args) };
    const r = st.run(...this.args);
    return { meta: { changes: r.changes } };
  }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async first() { const r = this.db.prepare(this.sql).get(...this.args); return r === undefined ? null : r; }
  async run() { return this._runSync(); }
}

function bucket() {
  const store = new Map();
  const deleted = [];
  return {
    store,
    deleted,
    async put(key, body, opts) { store.set(key, { bytes: new Uint8Array(body), opts }); },
    async get(key) {
      const o = store.get(key);
      return o ? { arrayBuffer: async () => o.bytes.buffer, httpMetadata: o.opts.httpMetadata } : null;
    },
    async delete(keys) { deleted.push(...[].concat(keys)); },
  };
}

const PHONE = '61412345678';
const SECRET = 'app-secret';
const A = 'antiochian-stnicholas-punchbowl';
const B = 'antiochian-stelias-wollongong';

/** Meta's side: the media, and every reply we send, in order. */
function graph() {
  const sent = [];
  const media = new Map([['M1', { mime: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]) }]]);
  const impl = async (url, init = {}) => {
    if (url === `${GRAPH}/111/messages`) {
      sent.push(JSON.parse(init.body));
      return Response.json({ messages: [{ id: `wamid.out${sent.length}` }] });
    }
    const id = url.startsWith(`${GRAPH}/`) ? decodeURIComponent(url.slice(GRAPH.length + 1)) : null;
    if (id && media.has(id)) {
      const m = media.get(id);
      return Response.json({ url: `https://lookaside.example/${id}`, mime_type: m.mime, file_size: m.size || m.bytes.length });
    }
    const dl = /^https:\/\/lookaside\.example\/(.+)$/.exec(url);
    if (dl && media.has(dl[1])) return new Response(media.get(dl[1]).bytes);
    return new Response('not found', { status: 404 });
  };
  return { impl, sent, media, texts: () => sent.map(s => s.text.body) };
}

function fresh({ role = 'parish', parishIds = [A], configured = true, key = 'test-key' } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-wa-')), 'x.db');
  const raw = new Database(file);
  raw.pragma('foreign_keys = ON');
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  raw.prepare("UPDATE parishes SET acronym = 'SNP' WHERE id = ?").run(A);
  raw.prepare("UPDATE parishes SET acronym = 'SEW' WHERE id = ?").run(B);
  if (role) {
    raw.prepare('INSERT INTO admin_roles (email, role, parish_ids) VALUES (?,?,?)')
      .run('dev', role, parishIds ? JSON.stringify(parishIds) : null);
  }
  const g = graph();
  const router = new Router();
  registerAdminRoutes(router);
  // Every wait a hundredth as long: real enough for two deliveries to overlap.
  registerIngestRoutes(router, { sleep: (ms) => new Promise(r => setTimeout(r, ms / 100)), fetchImpl: g.impl });
  const env = { DB: new D1(raw), AGORA_DEV_ADMIN: 'true', ASSETS_BUCKET: bucket() };
  if (key) env.ANTHROPIC_API_KEY = key;
  if (configured) {
    Object.assign(env, { WHATSAPP_TOKEN: 'tok', WHATSAPP_APP_SECRET: SECRET, WHATSAPP_VERIFY_TOKEN: 'verify-me',
      WHATSAPP_PHONE_NUMBER_ID: '111', WHATSAPP_NUMBER: '+1 555 123 4567' });
  }
  const send = (method, url, init = {}) => router.handle(new Request(`https://orthodoxy.au${url}`, { method, ...init }), env, {});
  const call = async (method, url, body) => {
    const res = await send(method, url, body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  let n = 0;
  /** Deliver messages as Meta does: one signed POST. */
  const deliver = async (messages, { signature = null } = {}) => {
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
      messaging_product: 'whatsapp', metadata: { display_phone_number: '15551234567', phone_number_id: '111' },
      contacts: [{ wa_id: PHONE, profile: { name: 'Kevin' } }],
      messages: messages.map(m => ({ from: PHONE, id: m.id || `wamid.${++n}`, timestamp: String(m.at || 1762400000), ...m })),
    } }] }] });
    const sig = signature != null ? signature : `sha256=${crypto.createHmac('sha256', SECRET).update(body).digest('hex')}`;
    const res = await send('POST', '/api/ingest/whatsapp', { body, headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig } });
    return res.status;
  };
  const link = () => raw.prepare("INSERT INTO whatsapp_links (phone, email, name) VALUES (?, 'dev', 'Kevin')").run(PHONE);
  const drafts = () => raw.prepare('SELECT * FROM drafts ORDER BY id').all();
  const suggestions = () => raw.prepare('SELECT * FROM parish_suggestions ORDER BY id').all();
  return { raw, env, graph: g, call, send, deliver, link, drafts, suggestions };
}

const image = (caption = null, extra = {}) => ({ type: 'image', image: { id: 'M1', mime_type: 'image/jpeg', ...(caption ? { caption } : {}) }, ...extra });
const text = (body, extra = {}) => ({ type: 'text', text: { body }, ...extra });

const READ = {
  kind: 'poster', written_in: null, other_parish: null,
  events: [{ title: 'Mums Group', feast: null, date: '2026-12-04', weekday_printed: 'Friday', year_printed: false, after: null,
    start_time: '10:00', end_time: '12:00', event_type: 'social', languages: [], venue: 'Youth Centre',
    description: 'Coffee and a chat.', notes: [] }],
  services: [], details: null, notes: [],
};

/**
 * What the reader answers a request with, from `doc`: a forward's sort
 * (poster-read.mjs sortPosters) from its `posters`, or one poster of every
 * picture; a read of one of them ("announcement n of the k") with the events
 * marked `poster: n`; any other read with the whole of it.
 */
function answerFor(doc, body) {
  const schema = body.output_config.format.schema;
  const content = body.messages[0].content;
  if (schema.properties.posters && !schema.properties.events) {
    const n = content.filter(c => c.type === 'image' || c.type === 'document').length;
    return JSON.stringify({ posters: doc.posters || [{ pictures: Array.from({ length: n }, (_, i) => i + 1), words: [], parish: '', place: '' }] });
  }
  const { posters, ...read } = doc;
  const part = /announcement (\d+) of the \d+ forwarded together/.exec(content[content.length - 1].text);
  return JSON.stringify({ ...read,
    events: read.events.filter(e => !part || e.poster === Number(part[1])).map(({ poster, ...e }) => e),
    services: (read.services || []).filter(x => !part || x.poster === Number(part[1])).map(({ poster, ...x }) => x) });
}

/** The Messages API, answering every request from `doc` (answerFor); the requests it got. */
async function withReader(doc, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return new Response(haikuStream(answerFor(doc, body)), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try { await fn(calls); } finally { globalThis.fetch = real; }
  return calls;
}
/** Which of the reader's requests were a forward's sort, and which reads. */
const sorts = (calls) => calls.filter(c => !c.output_config.format.schema.properties.events);
const reads = (calls) => calls.filter(c => c.output_config.format.schema.properties.events);

// ── the webhook itself ──

test('Meta’s check of the URL echoes the challenge only with the verify token', async () => {
  const f = fresh();
  const get = (qs) => f.send('GET', `/api/ingest/whatsapp?${qs}`);
  const ok = await get('hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=12345');
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), '12345');
  assert.equal((await get('hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1')).status, 403);
  const off = fresh({ configured: false });
  assert.equal((await off.send('GET', '/api/ingest/whatsapp?hub.mode=subscribe&hub.verify_token=&hub.challenge=1')).status, 503);
});

test('an unsigned POST, or one on a site without the number, does nothing', async () => {
  const f = fresh();
  f.link();
  assert.equal(await f.deliver([image('x')], { signature: 'sha256=' + '0'.repeat(64) }), 401);
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM whatsapp_messages').get().n, 0);
  assert.equal(f.drafts().length, 0);
  const off = fresh({ configured: false });
  assert.equal(await off.deliver([image('x')]), 503);
});

// ── a phone, linked to an account ──

test('the code Link WhatsApp shows, sent from the phone, links it to the account', async () => {
  const f = fresh();
  const status = await f.call('GET', '/api/admin/whatsapp');
  assert.equal(status.body.ready, true);
  assert.equal(status.body.number, '15551234567');
  assert.deepEqual(status.body.phones, []);

  const made = await f.call('POST', '/api/admin/whatsapp/code');
  assert.equal(made.status, 201);
  assert.match(made.body.code, /^\d{6}$/);
  assert.equal(made.body.url, `https://wa.me/15551234567?text=LINK%20${made.body.code}`);
  // A second press replaces the first code.
  const again = (await f.call('POST', '/api/admin/whatsapp/code')).body.code;
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM whatsapp_codes').get().n, 1);

  await f.deliver([text('LINK 000000')]);
  assert.match(f.graph.texts()[0], /code didn't work/);
  await f.deliver([text(`LINK ${again}`)]);
  assert.match(f.graph.texts()[1], /^Linked\. Posters you send here become drafts for dev\./);
  assert.deepEqual(f.raw.prepare('SELECT phone, email, name FROM whatsapp_links').all(), [{ phone: PHONE, email: 'dev', name: 'Kevin' }]);
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM whatsapp_codes').get().n, 0, 'a code works once');

  const linked = (await f.call('GET', '/api/admin/whatsapp')).body.phones;
  assert.deepEqual(linked.map(p => p.shown), ['+61 4•• ••• 678']);
  assert.equal((await f.call('DELETE', `/api/admin/whatsapp/phones/${PHONE}`)).status, 200);
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM whatsapp_links').get().n, 0);
});

test('a linked phone whose account lost its role is told so, and nothing is read', async () => {
  const f = fresh({ role: null });
  // Somebody else is on the list, so an empty table's dev owner does not apply.
  f.raw.prepare("INSERT INTO admin_roles (email, role) VALUES ('kevin@example.com', 'owner')").run();
  f.link();
  await withReader(READ, async (calls) => {
    await f.deliver([image('Mums Group')]);
    assert.equal(calls.length, 0);
  });
  assert.match(f.graph.texts()[0], /dev can't add events at any parish yet/);
  assert.equal(f.drafts().length, 0);
});

// ── a poster, read into a draft ──

test('a poster and its caption become one draft at the sender’s parish, and the reply links it', async () => {
  const f = fresh();
  f.link();
  const calls = await withReader(READ, async () => {
    assert.equal(await f.deliver([image('St Emilia’s Mums Group meets first Fridays at the Youth Centre.', { context: { forwarded: true } })]), 200);
  });
  const [d] = f.drafts();
  assert.equal(d.parish_id, A);
  assert.equal(d.source, 'whatsapp');
  assert.equal(d.created_by, 'dev');
  assert.equal(d.message_text, 'St Emilia’s Mums Group meets first Fridays at the Youth Centre.');
  assert.equal(d.read_status, 'read');
  assert.equal(d.seen_at, null);
  assert.match(d.poster_path, new RegExp(`^/posters/${A}-.+\\.jpg$`));
  assert.equal(f.env.ASSETS_BUCKET.store.size, 1);
  const cards = f.raw.prepare('SELECT title, date, start_time FROM draft_events WHERE draft_id = ?').all(d.id);
  assert.deepEqual(cards, [{ title: 'Mums Group', date: '2026-12-04', start_time: '10:00' }]);

  // The reader had the image and the caption, framed as WhatsApp's.
  assert.equal(calls.length, 1);
  const [img, words] = calls[0].messages[0].content;
  assert.equal(img.type, 'image');
  assert.match(words.text, /The words this image came with on WhatsApp/);
  assert.match(words.text, /Mums Group meets first Fridays/);
  assert.match(words.text, /Read the image\.$/);

  assert.equal(f.graph.sent.length, 1);
  assert.equal(f.graph.texts()[0],
    `Got it: Mums Group, Fri 4 Dec 10am. It's a draft at St Nicholas, Punchbowl until it's published: https://orthodoxy.au/snp?draft=${d.id}`);
  assert.equal(f.graph.sent[0].context.message_id, f.raw.prepare("SELECT id FROM whatsapp_messages WHERE type = 'image'").get().id,
    'the reply quotes the poster');
});

test('a feast poster that prints only "Tuesday" is the coming Tuesday, for two hours, neither "from poster"', async () => {
  // St Nicholas, Punchbowl's feast of St Catherine (Kevin, 19 Nov 2026): the
  // parish was right, the date was not. The reader's date is overruled by
  // the weekday it says was printed alone, counted from the parish's today.
  const f = fresh();
  f.link();
  const feast = { ...READ, events: [{ ...READ.events[0], title: 'Feast of Saint Catherine the Great Martyr',
    date_printed: false, date: '2026-11-25', weekday_printed: 'Tuesday', start_time: '18:30', end_time: null,
    event_type: 'feast', venue: null, description: 'Vespers and the Service of the Breaking of the Five Loaves.' }] };
  await withReader(feast, async () => { await f.deliver([image()]); });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date());
  const at = new Date(`${today}T00:00:00Z`);
  const tuesday = new Date(at.getTime() + ((2 - at.getUTCDay() + 7) % 7) * 864e5).toISOString().slice(0, 10);
  const [d] = f.drafts();
  const card = f.raw.prepare('SELECT date, start_time, end_time, year_printed, read_fields, read_notes FROM draft_events WHERE draft_id = ?').get(d.id);
  assert.deepEqual([card.date, card.start_time, card.end_time, card.year_printed], [tuesday, '18:30', '20:30', 0]);
  const marked = JSON.parse(card.read_fields);
  assert.ok(marked.includes('title') && marked.includes('start_time'));
  assert.ok(!marked.includes('date') && !marked.includes('end_time'), 'worked out, not printed');
  const notes = JSON.parse(card.read_notes).map(n => [n.field, n.text]);
  assert.ok(notes.some(([field, t]) => field === 'date' && /^Printed only as “Tuesday”, so the coming one: \d+ \w+\. Check it\.$/.test(t)));
  assert.ok(notes.some(([field, t]) => field === 'end_time' && /a feast usually runs 2 hours: until 8:30pm/.test(t)));
  assert.match(f.graph.texts()[0], /^Got it: Feast of Saint Catherine the Great Martyr, Tue \d+ \w+ 6:30pm\./);
});

test('a delivery Meta repeats is read once', async () => {
  const f = fresh();
  f.link();
  const calls = await withReader(READ, async () => {
    await f.deliver([image('Mums Group', { id: 'wamid.SAME' })]);
    await f.deliver([image('Mums Group', { id: 'wamid.SAME' })]);
  });
  assert.equal(calls.length, 1);
  assert.equal(f.drafts().length, 1);
  assert.equal(f.graph.sent.length, 1);
});

test('a poster and the text sent a moment after it are read together', async () => {
  const f = fresh();
  f.link();
  const calls = await withReader(READ, async () => {
    // Two deliveries, as Meta sends a forward of two messages: overlapping.
    await Promise.all([
      f.deliver([image(null, { at: 1762400000 })]),
      f.deliver([text('Mums Group — first Friday of the month, 10am, Youth Centre.', { at: 1762400001 })]),
    ]);
  });
  assert.equal(calls.length, 1, 'one read');
  const [d] = f.drafts();
  assert.equal(f.drafts().length, 1);
  assert.equal(d.message_text, 'Mums Group — first Friday of the month, 10am, Youth Centre.');
  assert.match(calls[0].messages[0].content[1].text, /first Friday of the month/);
  assert.deepEqual(f.raw.prepare('SELECT type, outcome, draft_id FROM whatsapp_messages ORDER BY sent_at').all(),
    [{ type: 'image', outcome: 'draft', draft_id: d.id }, { type: 'text', outcome: 'joined', draft_id: d.id }]);
  assert.equal(f.graph.sent.length, 1, 'one reply');
});

test('words typed after the draft was made go on it, and a parish link among them moves it', async () => {
  const f = fresh({ role: 'parish', parishIds: [A, B] });
  f.link();
  await withReader(READ, async () => {
    await f.deliver([image('Mums Group', { at: 1762400000 })]);
    await f.deliver([text('/sew', { at: 1762400030 })]);
  });
  const [d] = f.drafts();
  assert.equal(f.drafts().length, 1);
  assert.equal(d.parish_id, B);
  assert.equal(d.message_text, 'Mums Group\n\n/sew');
  assert.match(f.graph.texts()[1], /^Moved the draft to St Elias, Wollongong: https:\/\/orthodoxy\.au\/sew\?draft=/);
});

test('words alone are read as the announcement, with no image', async () => {
  const f = fresh();
  f.link();
  const calls = await withReader(READ, async () => {
    await f.deliver([text('Mums Group this Friday 4 December, 10am at the Youth Centre. All welcome!', { context: { forwarded: true } })]);
  });
  const [d] = f.drafts();
  assert.equal(d.poster_path, null);
  assert.equal(d.read_status, 'read');
  const content = calls[0].messages[0].content;
  assert.equal(content.length, 1, 'no image block');
  assert.match(content[0].text, /There is no image: this is a message sent to Agora on WhatsApp/);
  assert.match(content[0].text, /Read the message\.$/);
});

test('an owner’s poster lands at whose poster it is', async () => {
  const f = fresh({ role: 'owner', parishIds: null });
  f.link();
  f.raw.prepare("INSERT INTO drafts (parish_id, created_by) VALUES (?, 'dev')").run(A);
  const theirs = { ...READ, other_parish: { name: 'St Elias Antiochian Orthodox Church', place: 'Wollongong' } };
  const calls = await withReader(theirs, async () => { await f.deliver([image('Vespers')]); });
  // It started at no parish, and the reader was asked whose it is…
  assert.match(calls[0].messages[0].content[1].text, /^No parish is chosen for this yet\./);
  // …which the poster says.
  const d = f.drafts().find(x => x.source === 'whatsapp');
  assert.equal(d.parish_id, B);
  assert.equal(d.read_parish, null, 'no "move it there" once it is there');
  assert.match(f.graph.texts()[0], /It's a draft at St Elias, Wollongong until/);
});

// Kevin forwarded the Ocean Run Club's Cronulla poster, his last draft having
// been Kamariani's: it went to Kamariani. Somebody who may edit every parish
// has no parish of their own to guess.
test('an owner’s poster that says no parish starts at none, not where they last drafted', async () => {
  const f = fresh({ role: 'owner', parishIds: null });
  f.link();
  f.raw.prepare("INSERT INTO drafts (parish_id, created_by) VALUES (?, 'dev')").run(A);
  await withReader(READ, async () => { await f.deliver([image('ORC - Cronulla Beach')]); });
  const d = f.drafts().find(x => x.source === 'whatsapp');
  assert.equal(d.parish_id, '_unassigned');
  assert.match(f.graph.texts()[0], /It's a draft without a parish yet until it's published: https:\/\/orthodoxy\.au\/\?draft=/);
  // A link in the words still says where.
  const g = fresh({ role: 'owner', parishIds: null });
  g.link();
  await withReader(READ, async () => { await g.deliver([image('Mums Group orthodoxy.au/sew')]); });
  assert.equal(g.drafts()[0].parish_id, B);
});

test('a contact of several parishes starts where they last drafted', async () => {
  const f = fresh({ role: 'parish', parishIds: [A, B] });
  f.link();
  f.raw.prepare("INSERT INTO drafts (parish_id, created_by) VALUES (?, 'dev')").run(B);
  await withReader(READ, async () => { await f.deliver([image('Mums Group')]); });
  assert.equal(f.drafts().find(x => x.source === 'whatsapp').parish_id, B);
});

// ── a forward of several pictures ──

const JPEG2 = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9]);

test('a forward of two pictures and its caption is one draft, read together', async () => {
  const f = fresh();
  f.link();
  f.graph.media.set('M2', { mime: 'image/jpeg', bytes: JPEG2 });
  // As WhatsApp sent Kevin's: each picture its own message (and delivery),
  // the caption on the first, both at the same second.
  const calls = await withReader(READ, async () => {
    await Promise.all([
      f.deliver([image('ORC - Cronulla Beach. We’re heading south.', { at: 1762400000, context: { forwarded: true } })]),
      f.deliver([{ type: 'image', image: { id: 'M2', mime_type: 'image/jpeg' }, at: 1762400000, context: { forwarded: true } }]),
    ]);
  });
  assert.equal(f.drafts().length, 1, 'one draft');
  const [d] = f.drafts();
  assert.equal(d.message_text, 'ORC - Cronulla Beach. We’re heading south.');
  assert.equal(d.sender_name, 'Kevin', 'their WhatsApp name, for the editor');
  // Both pictures are the poster, each its own, in the order sent: a gallery.
  const both = JSON.parse(d.poster_path);
  assert.equal(both.length, 2, 'a gallery of the two');
  assert.equal(d.images, null, 'nothing waits to be joined');
  assert.deepEqual([...f.env.ASSETS_BUCKET.store.get(both[0].slice(1)).bytes], [0xff, 0xd8, 0xff, 0xe0, 1, 2], 'the first is the cover');
  assert.deepEqual([...f.env.ASSETS_BUCKET.store.get(both[1].slice(1)).bytes], [...JPEG2]);

  // Asked first, on its own, whether they are one poster or several: one, so one read of both.
  assert.equal(calls.length, 2, 'the sort, then one read');
  const [sort] = sorts(calls);
  const asked = sort.messages[0].content;
  assert.deepEqual(asked.map(c => c.type), ['text', 'image', 'text', 'image', 'text'], 'both pictures, in the order sent, numbered');
  assert.deepEqual([asked[0].text, asked[2].text], ['Image 1:', 'Image 2:']);
  assert.equal(asked[3].source.data, Buffer.from(JPEG2).toString('base64'));
  assert.match(asked[4].text, /There are 2 images, each headed with its number/);
  assert.match(asked[4].text, /The words the images came with, in numbered parts/);
  assert.match(asked[4].text, /\[1\] ORC - Cronulla Beach\. We’re heading south\./);
  assert.match(asked[4].text, /Sort the images\.$/);
  const [one] = reads(calls);
  const content = one.messages[0].content;
  assert.deepEqual(content.map(c => c.type), ['image', 'image', 'text'], 'read as one, as ever');
  assert.match(content[2].text, /There are 2 images, sent together as one announcement: read them as one image/);
  assert.match(content[2].text, /The words these images came with on WhatsApp/);
  assert.match(content[2].text, /Read the images\.$/);
  // One event, and the words sent with it: they are its description.
  assert.equal(f.raw.prepare('SELECT description FROM draft_events WHERE draft_id = ?').get(d.id).description,
    'ORC - Cronulla Beach. We’re heading south.');

  assert.equal(f.graph.sent.length, 1, 'one reply');
  assert.deepEqual(f.raw.prepare('SELECT outcome, draft_id FROM whatsapp_messages ORDER BY rowid').all().map(r => r.outcome).sort(),
    ['draft', 'joined']);
  assert.ok(f.raw.prepare('SELECT draft_id FROM whatsapp_messages').all().every(r => r.draft_id === d.id));
});

// Run 504 (12 Nov 2026) failed the test above once and passed on a re-run:
// the two pictures share a second, and when the uncaptioned one's delivery
// landed first it became the poster. WhatsApp puts the caption on the first
// picture, so within a second the captioned one leads, whichever arrives first.
test('the captioned picture is the poster even when the other one arrives first', async () => {
  const f = fresh();
  f.link();
  f.graph.media.set('M2', { mime: 'image/jpeg', bytes: JPEG2 });
  await withReader(READ, async () => {
    const second = f.deliver([{ type: 'image', image: { id: 'M2', mime_type: 'image/jpeg' }, at: 1762400000, context: { forwarded: true } }]);
    // Its row is logged before the captioned picture's is sent.
    while (!f.raw.prepare('SELECT 1 FROM whatsapp_messages').get()) await new Promise(r => setImmediate(r));
    await Promise.all([second,
      f.deliver([image('ORC - Cronulla Beach. We’re heading south.', { at: 1762400000, context: { forwarded: true } })])]);
  });
  assert.equal(f.drafts().length, 1, 'one draft');
  const [d] = f.drafts();
  const [cover, second] = JSON.parse(d.poster_path);
  assert.deepEqual([...f.env.ASSETS_BUCKET.store.get(cover.slice(1)).bytes], [0xff, 0xd8, 0xff, 0xe0, 1, 2], 'the captioned one is the cover');
  assert.deepEqual([...f.env.ASSETS_BUCKET.store.get(second.slice(1)).bytes], [...JPEG2]);
  assert.equal(d.message_text, 'ORC - Cronulla Beach. We’re heading south.');
});

// St Mary's, Mays Hill's post (19 Nov 2026): four posters and one caption,
// three parts of it about three of them, and a greeting and a sign-off.
const POST = [
  'Good morning everyone! ☀️',
  '👨🏻 *St Basil’s Men’s Group - Tonight*\n📅 Thursday 19 November\n 🕡 Dinner & fellowship from 6:30pm',
  '🍤 *Seafood Night Fellowship!*\n📅 Sunday 29 November after Evening Liturgy\n 💵 $15 per plate',
  '🍇 *Fruit Picking Trip*\n📅 Saturday 16 January\n🕗 Departing at 8:00am sharp',
  'Have a blessed day! 🙏🏼',
].join('\n\n');
const ev = (title, date, start, poster, extra = {}) => ({ poster, title, feast: null, date, weekday_printed: null,
  year_printed: false, after: null, start_time: start, end_time: null, event_type: 'social', languages: [], venue: null,
  description: `The reader’s words about ${title}.`, notes: [], ...extra });
const FOUR = {
  kind: 'poster', written_in: 'English', other_parish: null,
  posters: [
    { pictures: [1], words: [2], parish: '', place: '' },
    { pictures: [2], words: [3], parish: '', place: '' },
    { pictures: [3], words: [4], parish: '', place: '' },
    { pictures: [4], words: [], parish: '', place: '' },
  ],
  events: [
    ev('Men’s Group', '2026-11-19', '18:30', 1),
    ev('Seafood Night', '2026-11-29', '20:00', 2),
    ev('Fruit Picking Trip', '2027-01-16', '08:00', 3),
    ev('Lunch Cruise', '2027-02-06', '12:00', 4, { venue: 'Huntleys Point Wharf' }),
  ],
  services: [], details: { address: '', phone: '', email: '', website: '' }, notes: [],
};
const pictures = (n) => Array.from({ length: n }, (_, i) => ({ type: 'image',
  image: { id: `M${i + 1}`, mime_type: 'image/jpeg', ...(i === 0 ? { caption: POST } : {}) }, at: 1762400000, context: { forwarded: true } }));
const jpeg = (i) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, i, i]);

test('a forward of several posters is a draft for each, with its own picture and words, and the reply lists them', async () => {
  const f = fresh();
  f.link();
  for (let i = 1; i <= 4; i++) f.graph.media.set(`M${i}`, { mime: 'image/jpeg', bytes: jpeg(i) });
  const calls = await withReader(FOUR, async () => { await f.deliver(pictures(4)); });
  // Sorted, then each read on its own: its own picture and its own words.
  assert.equal(sorts(calls).length, 1, 'one sort of the four');
  const each = reads(calls);
  assert.equal(each.length, 4, 'a read for each poster');
  each.forEach((c, i) => {
    const content = c.messages[0].content;
    assert.deepEqual(content.map(x => x.type), ['image', 'text']);
    assert.equal(content[0].source.data, Buffer.from(jpeg(i + 1)).toString('base64'));
    assert.match(content[1].text, new RegExp(`This image is announcement ${i + 1} of the 4 forwarded together on WhatsApp`));
    assert.doesNotMatch(content[1].text, /Good morning everyone/, 'nobody’s words are nobody’s');
  });
  assert.match(each[1].messages[0].content[1].text, /Seafood Night Fellowship/);
  assert.doesNotMatch(each[1].messages[0].content[1].text, /Fruit Picking/);
  assert.doesNotMatch(each[3].messages[0].content[1].text, /The words this image came with/, 'the cruise came with no words of its own');

  const drafts = f.drafts();
  assert.equal(drafts.length, 4, 'a draft for each poster');
  drafts.forEach((d, i) => {
    assert.equal(d.parish_id, A);
    assert.equal(d.source, 'whatsapp');
    assert.equal(d.sender_name, 'Kevin');
    assert.equal(d.read_status, 'read');
    assert.equal(d.seen_at, null, 'each waits on the parish’s + until it is opened');
    assert.equal(d.images, null, 'one picture, nothing to join');
    assert.deepEqual([...f.env.ASSETS_BUCKET.store.get(d.poster_path.slice(1)).bytes], [...jpeg(i + 1)], `draft ${i + 1} has picture ${i + 1}`);
  });
  // Each its own part of the words, as written; the greeting and the
  // sign-off are nobody's, and the cruise was only on its poster.
  assert.deepEqual(drafts.map(d => d.message_text), [
    '👨🏻 *St Basil’s Men’s Group - Tonight*\n📅 Thursday 19 November\n 🕡 Dinner & fellowship from 6:30pm',
    '🍤 *Seafood Night Fellowship!*\n📅 Sunday 29 November after Evening Liturgy\n 💵 $15 per plate',
    '🍇 *Fruit Picking Trip*\n📅 Saturday 16 January\n🕗 Departing at 8:00am sharp',
    null,
  ]);
  const cards = drafts.map(d => f.raw.prepare('SELECT title, date, description FROM draft_events WHERE draft_id = ?').all(d.id));
  assert.deepEqual(cards.map(c => c.map(x => x.title)), [['Men’s Group'], ['Seafood Night'], ['Fruit Picking Trip'], ['Lunch Cruise']]);
  // The words are each card's description, WhatsApp's stars taken off, and
  // not marked "from poster"; the cruise, with none, keeps the reader's.
  const marks = drafts.map(d => JSON.parse(f.raw.prepare('SELECT read_fields FROM draft_events WHERE draft_id = ?').get(d.id).read_fields));
  assert.deepEqual(marks.map(m => m.includes('description')), [false, false, false, true]);
  assert.deepEqual(cards.map(c => c[0].description), [
    '👨🏻 St Basil’s Men’s Group - Tonight\n📅 Thursday 19 November\n🕡 Dinner & fellowship from 6:30pm',
    '🍤 Seafood Night Fellowship!\n📅 Sunday 29 November after Evening Liturgy\n💵 $15 per plate',
    '🍇 Fruit Picking Trip\n📅 Saturday 16 January\n🕗 Departing at 8:00am sharp',
    'The reader’s words about Lunch Cruise.',
  ]);

  // Each picture's message leads its own draft: four of the day's thirty.
  const rows = f.raw.prepare("SELECT media_id, outcome, draft_id FROM whatsapp_messages ORDER BY media_id").all();
  assert.deepEqual(rows, drafts.map((d, i) => ({ media_id: `M${i + 1}`, outcome: 'draft', draft_id: d.id })));

  assert.equal(f.graph.sent.length, 1, 'one reply');
  assert.equal(f.graph.texts()[0], [
    'Got it: 4 posters, so 4 drafts at St Nicholas, Punchbowl, waiting until they\'re published:',
    `• Men’s Group, Thu 19 Nov 6:30pm: https://orthodoxy.au/snp?draft=${drafts[0].id}`,
    `• Seafood Night, Sun 29 Nov 8pm: https://orthodoxy.au/snp?draft=${drafts[1].id}`,
    `• Fruit Picking Trip, Sat 16 Jan 8am: https://orthodoxy.au/snp?draft=${drafts[2].id}`,
    `• Lunch Cruise, Sat 6 Feb 12pm: https://orthodoxy.au/snp?draft=${drafts[3].id}`,
  ].join('\n'));

  // Words typed after it are about the last poster sent.
  await withReader(FOUR, async () => { await f.deliver([text('Tickets from Eva', { at: 1762400030 })]); });
  assert.match(f.drafts()[3].message_text, /^Tickets from Eva$/);
});

test('an owner’s forward of two parishes’ posters is a draft at each', async () => {
  const f = fresh({ role: 'owner', parishIds: null });
  f.link();
  f.graph.media.set('M2', { mime: 'image/jpeg', bytes: jpeg(2) });
  const two = {
    ...FOUR,
    posters: [
      { pictures: [1], words: [2], parish: 'St Elias Antiochian Orthodox Church', place: 'Wollongong' },
      { pictures: [2], words: [3], parish: 'St Nicholas Antiochian Orthodox Church', place: 'Punchbowl' },
    ],
    events: FOUR.events.slice(0, 2),
  };
  await withReader(two, async () => { await f.deliver(pictures(2)); });
  const drafts = f.drafts().filter(d => d.source === 'whatsapp');
  assert.deepEqual(drafts.map(d => d.parish_id), [B, A], 'each where its poster says');
  assert.equal(f.graph.texts()[0], [
    'Got it: 2 posters, so 2 drafts, waiting until they\'re published:',
    `• Men’s Group, Thu 19 Nov 6:30pm, at St Elias, Wollongong: https://orthodoxy.au/sew?draft=${drafts[0].id}`,
    `• Seafood Night, Sun 29 Nov 8pm, at St Nicholas, Punchbowl: https://orthodoxy.au/snp?draft=${drafts[1].id}`,
  ].join('\n'));
});

test('a forward that is one poster over two pictures stays one draft, and gives no part of the words to a card of several', async () => {
  const f = fresh();
  f.link();
  f.graph.media.set('M2', { mime: 'image/jpeg', bytes: jpeg(2) });
  // A programme's two pages: one poster, both pictures, two events.
  const one = { ...FOUR, posters: [{ pictures: [1, 2], words: [2, 3], parish: '', place: '' }],
    events: [ev('Vespers', '2026-11-21', '18:00', 1), ev('Seafood Night', '2026-11-29', '20:00', 1)] };
  await withReader(one, async () => { await f.deliver(pictures(2)); });
  const [d, ...more] = f.drafts();
  assert.equal(more.length, 0);
  assert.equal(JSON.parse(d.poster_path).length, 2, 'both pictures, a gallery');
  assert.equal(d.images, null);
  assert.equal(d.message_text, POST, 'every word, as it came');
  const descs = f.raw.prepare('SELECT description FROM draft_events WHERE draft_id = ? ORDER BY position').all(d.id).map(r => r.description);
  assert.deepEqual(descs, ['The reader’s words about Vespers.', 'The reader’s words about Seafood Night.']);
  assert.match(f.graph.texts()[0], /^Got it: Vespers, Sat 21 Nov 6pm, and 1 more\. It's a draft at St Nicholas, Punchbowl/);
});

test('a forward of several posters read too slowly is answered, then listed when it lands', async () => {
  const f = fresh();
  f.link();
  f.graph.media.set('M2', { mime: 'image/jpeg', bytes: jpeg(2) });
  const two = { ...FOUR, posters: FOUR.posters.slice(0, 2), events: FOUR.events.slice(0, 2) };
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    await new Promise(r => setTimeout(r, 200));
    return new Response(haikuStream(answerFor(two, JSON.parse(init.body))), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try { await f.deliver(pictures(2)); } finally { globalThis.fetch = real; }
  const drafts = f.drafts();
  assert.equal(drafts.length, 2);
  assert.deepEqual(f.graph.texts(), [
    `Got it. It's still being read, and will be a draft at St Nicholas, Punchbowl: https://orthodoxy.au/snp?draft=${drafts[0].id}`,
    [
      'Read it: 2 posters, so 2 drafts at St Nicholas, Punchbowl:',
      `• Men’s Group, Thu 19 Nov 6:30pm: https://orthodoxy.au/snp?draft=${drafts[0].id}`,
      `• Seafood Night, Sun 29 Nov 8pm: https://orthodoxy.au/snp?draft=${drafts[1].id}`,
    ].join('\n'),
  ]);
});

// Cabramatta's two-page timetable (28 Nov 2026): more than one read takes,
// and on WhatsApp the runtime cut it off at 30 seconds with nothing kept. A
// read that stops part-way keeps what it finished, and the reply says how far.
const PROGRAMME = ['2026-12-06', '2026-12-13', '2026-12-20'].map((date, i) => ({ title: `Divine Liturgy ${i + 1}`, feast: null,
  date, weekday_printed: 'Sunday', year_printed: true, after: null, start_time: '09:00', end_time: null, event_type: 'liturgy',
  languages: [], venue: null, description: null, notes: [] }));
/** As far as two of them, and part of the third: then out of room. */
const outOfRoom = () => haikuStream(`{"kind":"poster","written_in":"English","other_parish":null,"events":[${PROGRAMME.slice(0, 2).map(e => JSON.stringify(e)).join(',')},{"title":"Divine Litur`, { stop: 'max_tokens' });

test('a read that stops part-way keeps what it read, and the reply says how far it got', async () => {
  const f = fresh();
  f.link();
  withPdf(f);
  const real = globalThis.fetch;
  globalThis.fetch = async () => new Response(outOfRoom(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  try { await f.deliver([pdf('Our December services')]); } finally { globalThis.fetch = real; }
  const [d] = f.drafts();
  assert.equal(d.read_status, 'read');
  assert.deepEqual(f.raw.prepare('SELECT date FROM draft_events WHERE draft_id = ? ORDER BY position').all(d.id).map(r => r.date),
    ['2026-12-06', '2026-12-13']);
  const notes = JSON.parse(d.read_notes);
  assert.deepEqual(notes.map(n => n.cut && n.cut.after), ['2026-12-13'], 'where it stopped, kept for reading on');
  assert.match(f.graph.texts()[0], /^Got it: Divine Liturgy 1, Sun 6 Dec 9am, and 1 more\. I read it as far as 13 Dec; open the draft and choose Read the rest for the others\. It's a draft at St Nicholas, Punchbowl until it's published: https:\/\/orthodoxy\.au\/snp\?draft=\d+$/);
});

test('one that stops part-way after the first reply is said again, with how far it got', async () => {
  const f = fresh();
  f.link();
  withPdf(f);
  const real = globalThis.fetch;
  globalThis.fetch = async () => {
    await new Promise(r => setTimeout(r, 400));
    return new Response(outOfRoom(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try { await f.deliver([pdf('Our December services')]); } finally { globalThis.fetch = real; }
  const [d] = f.drafts();
  assert.deepEqual(f.graph.texts(), [
    `Got it. It's still being read, and will be a draft at St Nicholas, Punchbowl: https://orthodoxy.au/snp?draft=${d.id}`,
    `Read as far as 13 Dec: Divine Liturgy 1, Sun 6 Dec 9am, and 1 more. Open the draft and choose Read the rest for the others: https://orthodoxy.au/snp?draft=${d.id}`,
  ]);
});

test('a picture WhatsApp will not give is left out, and the reply says so', async () => {
  const f = fresh();
  f.link();
  await withReader(READ, async () => {
    await f.deliver([
      image('Mums Group', { at: 1762400000 }),
      { type: 'image', image: { id: 'GONE', mime_type: 'image/jpeg' }, at: 1762400000 },
    ]);
  });
  const [d] = f.drafts();
  assert.equal(f.drafts().length, 1);
  assert.equal(d.images, null, 'only the one it got');
  assert.ok(d.poster_path);
  assert.match(f.graph.texts()[0], /I couldn't download one of the pictures; send it again for a draft of its own\.$/);
  assert.equal(f.raw.prepare("SELECT outcome FROM whatsapp_messages WHERE media_id = 'GONE'").get().outcome, 'media-failed');
});

test('a parish contact’s poster from a parish not theirs stays at theirs', async () => {
  const f = fresh({ role: 'parish', parishIds: [A] });
  f.link();
  const theirs = { ...READ, other_parish: { name: 'St Elias Antiochian Orthodox Church', place: 'Wollongong' } };
  await withReader(theirs, async () => { await f.deliver([image('Vespers')]); });
  assert.equal(f.drafts()[0].parish_id, A);
});

test('thirty a day is the most', async () => {
  const f = fresh();
  f.link();
  const ins = f.raw.prepare("INSERT INTO whatsapp_messages (id, phone, type, sent_at, outcome) VALUES (?, ?, 'image', ?, 'draft')");
  for (let i = 0; i < 30; i++) ins.run(`old${i}`, PHONE, 1762400000 - 100 - i);
  await withReader(READ, async (calls) => {
    await f.deliver([image('one more')]);
    await f.deliver([{ ...pdf('and a PDF'), at: 1762400030 }]);
    assert.equal(calls.length, 0);
  });
  assert.match(f.graph.texts()[0], /That's 30 posters from this phone today/);
  assert.match(f.graph.texts()[1], /That's 30 posters from this phone today/);
  assert.equal(f.drafts().length, 0);
});

// ── a PDF ──

const PDF_TEXT = '%PDF-1.7\n% St Nicholas, December\n';
/** A PDF forwarded on WhatsApp: a document, with its caption if it had one. */
const pdf = (caption = null, extra = {}) => ({ type: 'document',
  document: { id: 'D1', mime_type: 'application/pdf', filename: 'December.pdf', ...(caption ? { caption } : {}) }, ...extra });
const withPdf = (f, o = {}) => f.graph.media.set('D1', { mime: 'application/pdf', bytes: new TextEncoder().encode(PDF_TEXT), ...o });

test('a forwarded PDF and its words become a draft, read as the PDF itself', async () => {
  const f = fresh();
  f.link();
  withPdf(f);
  const calls = await withReader(READ, async () => {
    await f.deliver([pdf('Our December programme', { context: { forwarded: true } }), { ...text('Mums Group on the 4th.'), at: 1762400001 }]);
  });
  const [d] = f.drafts();
  assert.equal(d.parish_id, A);
  assert.equal(d.message_text, 'Our December programme\n\nMums Group on the 4th.');
  assert.match(d.poster_path, new RegExp(`^/posters/${A}-.+\\.pdf$`));
  assert.equal(d.images, null);
  const stored = f.env.ASSETS_BUCKET.store.get(d.poster_path.slice(1));
  assert.equal(stored.opts.httpMetadata.contentType, 'application/pdf');
  assert.equal(new TextDecoder().decode(stored.bytes), PDF_TEXT);
  assert.equal(d.read_status, 'read');

  assert.equal(calls.length, 1);
  const [doc, words] = calls[0].messages[0].content;
  assert.equal(doc.type, 'document');
  assert.equal(doc.source.media_type, 'application/pdf');
  assert.equal(Buffer.from(doc.source.data, 'base64').toString(), PDF_TEXT);
  assert.match(words.text, /The image is a PDF/);
  assert.match(words.text, /Our December programme/);
  assert.match(f.graph.texts()[0], /^Got it: Mums Group, Fri 4 Dec 10am\. It's a draft at St Nicholas, Punchbowl/);
  const outcomes = f.raw.prepare('SELECT type, outcome, draft_id FROM whatsapp_messages ORDER BY rowid').all();
  assert.deepEqual(outcomes, [{ type: 'pdf', outcome: 'draft', draft_id: d.id }, { type: 'text', outcome: 'joined', draft_id: d.id }]);
});

test('a PDF sent with a picture is a draft of its own, never joined to it', async () => {
  const f = fresh();
  f.link();
  withPdf(f);
  const calls = await withReader(READ, async () => {
    await f.deliver([image('Mums Group'), pdf()]);
  });
  const ds = f.drafts();
  assert.equal(ds.length, 2);
  assert.deepEqual(ds.map(d => d.poster_path.split('.').pop()).sort(), ['jpg', 'pdf']);
  assert.ok(ds.every(d => d.images === null));
  assert.deepEqual(calls.map(c => c.messages[0].content[0].type).sort(), ['document', 'image']);
});

test('a PDF too large to read, or one WhatsApp will not give, is said so', async () => {
  const f = fresh();
  f.link();
  withPdf(f, { size: 15 * 1024 * 1024 + 1 });
  await withReader(READ, async (calls) => {
    await f.deliver([pdf()]);
    assert.equal(calls.length, 0);
  });
  assert.match(f.graph.texts()[0], /That PDF is over 15 MB, the most I can read/);
  f.graph.media.delete('D1');
  await f.deliver([{ ...pdf(), at: 1762400100 }]);
  assert.match(f.graph.texts()[1], /couldn't download that PDF/);
  assert.equal(f.drafts().length, 0);
});

test('a PDF from a phone nobody linked is a suggestion, read as the PDF', async () => {
  const f = fresh();
  withPdf(f);
  const calls = await withReader(READ, async () => { await f.deliver([pdf('orthodoxy.au/snp')]); });
  const [s] = f.suggestions();
  assert.equal(s.parish_id, A);
  assert.equal(s.kind, 'event');
  const sp = f.raw.prepare('SELECT poster_path FROM suggestion_posters WHERE suggestion_id = ?').get(s.id);
  assert.match(sp.poster_path, /\.pdf$/);
  assert.equal(calls[0].messages[0].content[0].type, 'document');
  assert.match(f.graph.texts()[0], /It's with whoever keeps St Nicholas, Punchbowl now/);
});

test('without the reader’s key the poster is still a draft, to fill in by hand', async () => {
  const f = fresh({ key: null });
  f.link();
  await f.deliver([image('Mums Group')]);
  const [d] = f.drafts();
  assert.equal(d.read_status, null);
  assert.ok(d.poster_path);
  assert.equal(f.graph.texts()[0], `Got it. It's a draft at St Nicholas, Punchbowl: https://orthodoxy.au/snp?draft=${d.id}`);
});

// ── in the app ──

test('the ping lists unopened WhatsApp drafts; opening one takes it off', async () => {
  const f = fresh();
  f.link();
  await withReader(READ, async () => { await f.deliver([image('Mums Group')]); });
  const [d] = f.drafts();
  const ping = (await f.call('GET', '/api/admin/ping')).body;
  assert.equal(ping.whatsapp.ready, true);
  assert.deepEqual(ping.whatsapp.drafts.map(x => ({ id: x.id, parish_id: x.parish_id, title: x.title, mine: x.mine })),
    [{ id: d.id, parish_id: A, title: 'Mums Group', mine: true }]);
  const opened = (await f.call('GET', `/api/admin/drafts/${d.id}`)).body;
  assert.equal(opened.source, 'whatsapp');
  assert.equal(opened.message_text, 'Mums Group');
  assert.ok(opened.seen_at);
  assert.deepEqual((await f.call('GET', '/api/admin/ping')).body.whatsapp.drafts, []);
});

test('reading a WhatsApp draft again reads its words with it', async () => {
  const f = fresh();
  f.link();
  await withReader(READ, async () => { await f.deliver([image('Mums Group, first Fridays')]); });
  const [d] = f.drafts();
  const calls = await withReader(READ, async () => {
    const res = await f.send('POST', `/api/admin/drafts/${d.id}/poster?reread=1`);
    await res.text();
  });
  assert.match(calls[0].messages[0].content[1].text, /The words this image came with on WhatsApp[\s\S]*Mums Group, first Fridays/);
});

test('the link routes are drafts’ kind of write: no new data version', async () => {
  const { isDataWrite } = await import('../lib/data-version.mjs');
  const w = (method, p) => isDataWrite(new Request(`https://orthodoxy.au${p}`, { method }), new Response('{}'));
  assert.equal(w('POST', '/api/admin/whatsapp/code'), false);
  assert.equal(w('DELETE', '/api/admin/whatsapp/phones/614'), false);
  assert.equal(w('POST', '/api/ingest/whatsapp'), false);
  assert.equal(w('POST', '/api/suggest/whatsapp'), false);
});

test('a read that runs long is answered while it runs, and still lands', async () => {
  const f = fresh();
  f.link();
  const real = globalThis.fetch;
  // Slower than the reply waits (REPLY_BY_MS, a hundredth here).
  globalThis.fetch = async () => {
    await new Promise(r => setTimeout(r, 400));
    return new Response(haikuStream(JSON.stringify(READ)), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try { await f.deliver([image('A whole programme')]); } finally { globalThis.fetch = real; }
  const [d] = f.drafts();
  assert.equal(f.graph.texts()[0], `Got it. It's still being read, and will be a draft at St Nicholas, Punchbowl: https://orthodoxy.au/snp?draft=${d.id}`);
  assert.equal(f.graph.sent.length, 1, 'one reply, not two');
  assert.equal(d.read_status, 'read');
});

// ── a phone nobody linked: suggestions ──

const ID = `wa:${PHONE}`;
const KEEPS_A = 'whoever keeps St Nicholas, Punchbowl';

test('a poster from a phone nobody linked is a suggestion to whoever keeps its parish', async () => {
  const f = fresh();
  const calls = await withReader(READ, async () => {
    assert.equal(await f.deliver([image('Mums Group, first Fridays. orthodoxy.au/snp', { context: { forwarded: true } })]), 200);
  });
  assert.equal(f.drafts().length, 0, 'never a draft');
  const [s] = f.suggestions();
  assert.equal(s.parish_id, A, 'the parish its words link');
  assert.equal(s.email, ID, 'filed under the phone');
  assert.equal(s.name, 'Kevin', 'their WhatsApp name');
  assert.equal(s.kind, 'event');
  assert.equal(s.status, 'open');
  assert.equal(s.body, 'Mums Group, first Fridays. orthodoxy.au/snp');
  assert.deepEqual([s.title, s.date, s.start_time, s.end_time], ['Mums Group', '2026-12-04', '10:00', '12:00'], 'filled from the read');
  const sp = f.raw.prepare('SELECT * FROM suggestion_posters').get();
  assert.equal(sp.suggestion_id, s.id);
  assert.equal(sp.email, ID);
  assert.match(sp.poster_path, new RegExp(`^/posters/suggested-${A}-.+\\.jpg$`));
  assert.ok(f.env.ASSETS_BUCKET.store.has(sp.poster_path.slice(1)));

  assert.equal(calls.length, 1);
  const content = calls[0].messages[0].content;
  assert.deepEqual(content.map(c => c.type), ['image', 'text']);
  assert.match(content[1].text, /The parish: St Nicholas/, 'read as that parish’s poster');
  assert.match(content[1].text, /The words this image came with on WhatsApp/);

  assert.deepEqual(f.graph.texts(), [
    `Thank you. Got it: Mums Group, Fri 4 Dec 10am. It's with ${KEEPS_A} now, and nothing on the page changes until one of them has looked.`,
  ]);
  const msg = f.raw.prepare('SELECT outcome, suggestion_id, draft_id FROM whatsapp_messages').get();
  assert.deepEqual(msg, { outcome: 'suggestion', suggestion_id: s.id, draft_id: null });
});

test('with no parish named it goes where the read says; with none, to the editors, until a link typed after moves it', async () => {
  const f = fresh();
  const theirs = { ...READ, other_parish: { name: 'St Elias Antiochian Orthodox Church', place: 'Wollongong' } };
  await withReader(theirs, async () => { await f.deliver([image('Run club this Saturday', { at: 1762400000 })]); });
  assert.equal(f.suggestions()[0].parish_id, B, 'whose poster it is');
  assert.equal(f.raw.prepare('SELECT parish_id FROM suggestion_posters').get().parish_id, B);
  assert.match(f.graph.texts()[0], /It's with whoever keeps St Elias/);

  await withReader(READ, async () => { await f.deliver([image('Mums Group', { at: 1762401000 })]); });
  const second = f.suggestions()[1];
  assert.equal(second.parish_id, '_unassigned', 'nobody’s yet: owners and editors see it');
  assert.equal(f.graph.texts()[1],
    'Thank you. Got it: Mums Group, Fri 4 Dec 10am. I couldn\'t tell which parish it\'s for, so it\'s with orthodoxy.au\'s editors. If you know, reply with the parish\'s link, like orthodoxy.au/snp.');

  await withReader(READ, async (calls) => {
    await f.deliver([text('/snp', { at: 1762401030 })]);
    assert.equal(calls.length, 0, 'a word about it, not read');
  });
  const moved = f.suggestions()[1];
  assert.equal(moved.parish_id, A);
  assert.equal(moved.body, 'Mums Group', 'a link alone is only that');
  assert.equal(f.raw.prepare('SELECT parish_id FROM suggestion_posters WHERE suggestion_id = ?').get(moved.id).parish_id, A);
  assert.equal(f.graph.texts()[2], `Thanks. Your suggestion is with ${KEEPS_A} now.`);
  assert.equal(f.suggestions().length, 2);

  await f.deliver([text('It’s in the hall', { at: 1762401060 })]);
  assert.equal(f.suggestions()[1].body, 'Mums Group\n\nIt’s in the hall');
  assert.equal(f.graph.texts()[3], `Added that to your suggestion. It's with ${KEEPS_A}.`);
});

test('words alone: a greeting is told how, once an hour; words naming a parish, or that a read finds an event in, are suggestions', async () => {
  const f = fresh();
  const nothing = { ...READ, kind: 'not_an_event', events: [] };
  await withReader(nothing, async (calls) => {
    await f.deliver([text('hello?', { at: 1762400000 })]);
    await f.deliver([text('anyone there?', { at: 1762400100 })]);
    assert.equal(calls.length, 2, 'each was read');
  });
  assert.equal(f.suggestions().length, 0);
  assert.equal(f.graph.sent.length, 1, 'told once');
  assert.match(f.graph.texts()[0], /^This is orthodoxy\.au\. To tell a parish its page is wrong or something is coming up, send it here with the parish's link/);
  assert.match(f.graph.texts()[0], /link this phone and your posters become drafts: sign in at https:\/\/orthodoxy\.au, open the account menu, choose Link WhatsApp/);

  await withReader(READ, async (calls) => {
    await f.deliver([text('The Liturgy at orthodoxy.au/snp is at 10 this Sunday, not 9:30', { at: 1762405000 })]);
    assert.equal(calls.length, 0, 'it names its parish: nothing to read');
  });
  const [change] = f.suggestions();
  assert.deepEqual([change.parish_id, change.kind, change.email, change.title], [A, 'change', ID, null]);
  assert.equal(change.body, 'The Liturgy at orthodoxy.au/snp is at 10 this Sunday, not 9:30');
  assert.equal(f.graph.texts()[1], `Thank you. It's with ${KEEPS_A} now, and nothing on the page changes until one of them has looked.`);

  await withReader(READ, async () => { await f.deliver([text('Mums Group, Friday 4 December, 10 to 12', { at: 1762410000 })]); });
  const event = f.suggestions()[1];
  assert.deepEqual([event.kind, event.title, event.date, event.parish_id], ['event', 'Mums Group', '2026-12-04', '_unassigned'],
    'an event read from words is one');
});

test('a phone nobody linked has ten reads a day and twenty suggestions waiting, an emailed sender’s limits', async () => {
  const f = fresh();
  const old = f.raw.prepare("INSERT INTO whatsapp_messages (id, phone, type, sent_at, outcome) VALUES (?, ?, 'image', ?, 'suggestion')");
  for (let i = 0; i < 10; i++) old.run(`wamid.old${i}`, PHONE, 1762390000 + i);
  await withReader(READ, async (calls) => {
    await f.deliver([image('Mums Group', { at: 1762400000 })]);
    assert.equal(calls.length, 0);
  });
  assert.equal(f.suggestions().length, 0);
  assert.equal(f.graph.texts()[0], "That's 10 suggestions from this phone today, the most I read in a day. Send it again tomorrow.");
  assert.equal(f.env.ASSETS_BUCKET.store.size, 0, 'nothing fetched');

  const g = fresh();
  const open = g.raw.prepare("INSERT INTO parish_suggestions (parish_id, email, kind, body) VALUES (?, ?, 'change', 'x')");
  for (let i = 0; i < 20; i++) open.run(A, ID);
  await g.deliver([text('orthodoxy.au/snp has the wrong phone number')]);
  assert.equal(g.suggestions().length, 20);
  assert.equal(g.graph.texts()[0], 'You have 20 suggestions waiting already. Once some have been looked at, send more.');
});

// ── the Suggest dialog's "Confirm on WhatsApp" ──

test('the Suggest dialog’s code, sent from the phone, files what was typed there under it', async () => {
  const f = fresh();
  assert.deepEqual((await f.call('GET', '/api/suggest/whatsapp')).body, { ready: true, number: '15551234567' });
  assert.deepEqual((await fresh({ configured: false }).call('GET', '/api/suggest/whatsapp')).body, { ready: false, number: null });

  assert.equal((await f.call('POST', '/api/suggest/whatsapp', { parish_id: A, body: '' })).status, 400, 'nothing said');
  assert.equal((await f.call('POST', '/api/suggest/whatsapp', { parish_id: 'nope', body: 'x' })).status, 404);
  assert.equal((await f.call('POST', '/api/suggest/whatsapp', { parish_id: '_unassigned', body: 'x' })).status, 404);

  const made = await f.call('POST', '/api/suggest/whatsapp',
    { parish_id: A, about: 'Sunday 9:30am · Divine Liturgy', body: 'It is at 10 now', name: 'Maria', poster: false });
  assert.equal(made.status, 201);
  const t = made.body;
  assert.match(t.code, /^\d{6}$/);
  assert.match(t.secret, /^[0-9a-f]{32}$/);
  assert.equal(t.text, `Send my suggestion for St Nicholas, Punchbowl. Code: ${t.code.slice(0, 3)} ${t.code.slice(3)}`);
  assert.equal(t.url, `https://wa.me/15551234567?text=${encodeURIComponent(t.text)}`);
  assert.equal(f.suggestions().length, 0, 'nothing filed until the phone sends it');
  assert.equal((await f.call('GET', `/api/suggest/whatsapp/${t.secret}`)).body.status, 'waiting');

  const wrong = t.code === '000000' ? '111111' : '000000';
  await f.deliver([text(`Send my suggestion for St Nicholas, Punchbowl. Code: ${wrong}`, { at: 1762400000 })]);
  assert.equal(f.graph.texts()[0], "That code didn't work. It may have run out: send your suggestion from the parish's page again.");
  assert.equal(f.suggestions().length, 0);

  await f.deliver([text(t.text, { at: 1762400100 })]);
  const [s] = f.suggestions();
  assert.deepEqual([s.parish_id, s.email, s.name, s.kind, s.about, s.body],
    [A, ID, 'Maria', 'change', 'Sunday 9:30am · Divine Liturgy', 'It is at 10 now'], 'the name they gave');
  assert.equal(f.graph.texts()[1], `Thank you. It's with ${KEEPS_A} now, and nothing on the page changes until one of them has looked.`);
  assert.deepEqual((await f.call('GET', `/api/suggest/whatsapp/${t.secret}`)).body, { status: 'sent', parish: 'St Nicholas, Punchbowl' });

  await f.deliver([text(t.text, { at: 1762400200 })]);
  assert.match(f.graph.texts()[2], /^That code didn't work/, 'a code goes once');
  assert.equal(f.suggestions().length, 1);
  assert.equal((await f.call('GET', '/api/suggest/whatsapp/nope')).status, 404);
});

test('the dialog’s poster goes up unread, and is read once the code comes, as an event', async () => {
  const f = fresh();
  const t = (await f.call('POST', '/api/suggest/whatsapp',
    { parish_id: A, about: 'An event', body: 'Our mums group', name: '', poster: true })).body;
  const up = await f.send('POST', `/api/suggest/whatsapp/${t.secret}/poster`,
    { body: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9]), headers: { 'content-type': 'image/jpeg' } });
  assert.equal(up.status, 201);
  const held = f.raw.prepare('SELECT poster_path FROM whatsapp_tickets').get().poster_path;
  assert.ok(f.env.ASSETS_BUCKET.store.has(held.slice(1)));
  assert.equal((await f.send('POST', `/api/suggest/whatsapp/${t.secret}/poster`,
    { body: 'x', headers: { 'content-type': 'application/pdf' } })).status, 415);

  const calls = await withReader(READ, async () => { await f.deliver([text(t.text)]); });
  const [s] = f.suggestions();
  assert.deepEqual([s.kind, s.title, s.date, s.body, s.name, s.about], ['event', 'Mums Group', '2026-12-04', 'Our mums group', 'Kevin', null],
    'no name given: their WhatsApp one');
  assert.equal(f.raw.prepare('SELECT poster_path FROM suggestion_posters WHERE suggestion_id = ?').get(s.id).poster_path, held);
  assert.equal(calls.length, 1, 'read now, not before');
  assert.match(calls[0].messages[0].content[1].text, /Our mums group/);
  assert.match(f.graph.texts()[0], /^Thank you\. Got it: Mums Group, Fri 4 Dec 10am\. It's with whoever keeps St Nicholas/);
  assert.equal((await f.send('POST', `/api/suggest/whatsapp/${t.secret}/poster`,
    { body: new Uint8Array([1]), headers: { 'content-type': 'image/jpeg' } })).status, 404, 'too late to add one');

  // A phone linked to an account files under the account.
  const g = fresh();
  g.link();
  const u = (await g.call('POST', '/api/suggest/whatsapp', { parish_id: B, body: 'Wrong phone number' })).body;
  await g.deliver([text(u.text)]);
  assert.equal(g.suggestions()[0].email, 'dev');
});

test('ten codes an hour to an address; a code nobody sends runs out, and its poster goes', async () => {
  const f = fresh();
  for (let i = 0; i < 10; i++) {
    assert.equal((await f.call('POST', '/api/suggest/whatsapp', { parish_id: A, body: `x${i}` })).status, 201);
  }
  assert.equal((await f.call('POST', '/api/suggest/whatsapp', { parish_id: A, body: 'one more' })).status, 429);

  const g = fresh();
  const t = (await g.call('POST', '/api/suggest/whatsapp', { parish_id: A, body: 'x', poster: true })).body;
  await g.send('POST', `/api/suggest/whatsapp/${t.secret}/poster`, { body: new Uint8Array([1, 2]), headers: { 'content-type': 'image/png' } });
  const held = g.raw.prepare('SELECT poster_path FROM whatsapp_tickets').get().poster_path;
  // Run out a minute ago: its row is kept a day, to say so; its poster is not.
  g.raw.prepare('UPDATE whatsapp_tickets SET expires_at = ?').run(new Date(Date.now() - 60e3).toISOString().replace(/\.\d{3}Z$/, 'Z'));
  assert.equal((await g.call('GET', `/api/suggest/whatsapp/${t.secret}`)).body.status, 'expired');
  await g.deliver([text(t.text)]);
  assert.match(g.graph.texts()[0], /^That code didn't work/);
  assert.equal(g.suggestions().length, 0);
  // The next code made sweeps it.
  await g.call('POST', '/api/suggest/whatsapp', { parish_id: A, body: 'y' });
  assert.deepEqual(g.env.ASSETS_BUCKET.deleted, [held.slice(1)]);
  assert.equal(g.raw.prepare('SELECT poster_path FROM whatsapp_tickets WHERE code = ?').get(t.code).poster_path, null);
});

// ── what whoever keeps the parish does with one ──

test('Asks shows a WhatsApp sender’s number; Start a draft opens it as a forwarded poster, pictures and all', async () => {
  const f = fresh({ role: 'owner', parishIds: null });
  f.graph.media.set('M2', { mime: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7]) });
  await withReader(READ, async () => {
    await Promise.all([
      f.deliver([image('Mums Group. orthodoxy.au/snp', { at: 1762400000 })]),
      f.deliver([{ type: 'image', image: { id: 'M2', mime_type: 'image/jpeg' }, at: 1762400000 }]),
    ]);
  });
  assert.equal(f.suggestions().length, 1, 'one forward, one suggestion');
  const list = (await f.call('GET', '/api/admin/suggestions')).body;
  assert.equal(list.length, 1);
  const [x] = list;
  assert.deepEqual(x.whatsapp, { phone: '+61412345678', url: 'https://wa.me/61412345678' });
  assert.equal(x.images.length, 1, 'the second picture');
  assert.match(x.poster_path, /^\/posters\/suggested-/);
  assert.equal(x.summary, 'Kevin suggests an event at St Nicholas, Punchbowl: Mums Group, 2026-12-04 10:00.');

  const made = await f.call('POST', `/api/admin/suggestions/${x.id}/draft`);
  assert.equal(made.status, 201);
  const d = f.drafts()[0];
  assert.deepEqual([d.source, d.message_text, d.sender_name], ['whatsapp', 'Mums Group. orthodoxy.au/snp', 'Kevin']);
  assert.deepEqual(JSON.parse(d.poster_path), [x.poster_path, ...x.images], 'every picture, a gallery');
  assert.equal(d.images, null);
  assert.ok(d.seen_at, 'opened by whoever started it: no + badge');
  const card = f.raw.prepare('SELECT title, date, description FROM draft_events WHERE draft_id = ?').get(d.id);
  assert.deepEqual(card, { title: 'Mums Group', date: '2026-12-04', description: null }, 'their words are in the WhatsApp box');
  const after = f.suggestions()[0];
  assert.deepEqual([after.status, after.images], ['done', null]);

  // Dismissed instead, its pictures go.
  const g = fresh({ role: 'owner', parishIds: null });
  g.graph.media.set('M2', { mime: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 7]) });
  await withReader(READ, async () => {
    await Promise.all([
      g.deliver([image('orthodoxy.au/snp', { at: 1762400000 })]),
      g.deliver([{ type: 'image', image: { id: 'M2', mime_type: 'image/jpeg' }, at: 1762400000 }]),
    ]);
  });
  const y = (await g.call('GET', '/api/admin/suggestions')).body[0];
  assert.equal((await g.call('POST', `/api/admin/suggestions/${y.id}/decide`, { decision: 'dismiss', note: 'Old' })).status, 200);
  assert.deepEqual(g.env.ASSETS_BUCKET.deleted.sort(), [y.poster_path.slice(1), y.images[0].slice(1)].sort());
});

// ── Gorgon: a scan's PDF for the chant editor (worker/routes/ingest.mjs toGorgon) ──

/** Gorgon's GorgonWhatsApp entrypoint, faked: waits under one code, or for a linked email. */
function fakeGorgon({ code = '482193', email = null } = {}) {
  const calls = [];
  let phone = null;
  const mine = ({ from, text, linkedEmail }) => (text && text.includes(code.slice(3))) || from === phone || (email && linkedEmail === email);
  return {
    calls,
    async message(m) {
      calls.push(['message', m]);
      if (m.kind === 'text') { phone = m.from; return { take: 'code', reply: 'Got it. Now share the PDF.' }; }
      return mine(m) ? { take: 'pdf' } : { take: null };
    },
    async deliver(m) {
      calls.push(['deliver', { ...m, bytes: new Uint8Array(m.bytes).length }]);
      return { reply: 'Got it. Your PDF is opening in Gorgon.' };
    },
  };
}
const pdfDoc = (caption = null) => ({ type: 'document', document: { id: 'D1', mime_type: 'application/pdf', filename: 'Kontakion.pdf', ...(caption ? { caption } : {}) } });

test('Gorgon: its code is answered by Gorgon, and the PDF after it is handed over', async () => {
  const f = fresh();
  f.env.GORGON = fakeGorgon();
  f.graph.media.set('D1', { mime: 'application/pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2]) });
  await f.deliver([text('Gorgon code 482 193')]);
  await f.deliver([pdfDoc()]);
  assert.deepEqual(f.env.GORGON.calls.map(c => c[0]), ['message', 'message', 'deliver']);
  assert.equal(f.env.GORGON.calls[2][1].bytes, 6);
  assert.equal(f.env.GORGON.calls[2][1].filename, 'Kontakion.pdf');
  assert.deepEqual(f.graph.texts(), ['Got it. Now share the PDF.', 'Got it. Your PDF is opening in Gorgon.']);
  assert.equal(f.drafts().length + f.suggestions().length, 0);
});

test('Gorgon: a linked phone’s PDF goes with its account’s email', async () => {
  const f = fresh();
  f.link();
  f.env.GORGON = fakeGorgon({ email: 'dev' });
  f.graph.media.set('D1', { mime: 'application/pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) });
  await f.deliver([pdfDoc()]);
  assert.equal(f.env.GORGON.calls[0][1].linkedEmail, 'dev');
  assert.deepEqual(f.graph.texts(), ['Got it. Your PDF is opening in Gorgon.']);
});

test('Gorgon: a PDF nobody waits for, or Gorgon unreachable, goes the usual way', async () => {
  const f = fresh();
  f.link();
  f.graph.media.set('D1', { mime: 'application/pdf', bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]) });
  f.env.GORGON = fakeGorgon();
  await withReader(READ, async () => {
    await f.deliver([pdfDoc()]);
    f.env.GORGON = { async message() { throw new Error('down'); } };
    await f.deliver([{ ...pdfDoc(), at: 1762400100 }]);
  });
  assert.equal(f.drafts().length, 2);
  assert.ok(f.graph.texts().every(t => /^Got it: Mums Group/.test(t)));
});

test('Gorgon: ordinary words and link codes never reach it', async () => {
  const f = fresh();
  f.env.GORGON = fakeGorgon();
  await f.deliver([text('123 456')]);
  assert.equal(f.env.GORGON.calls.length, 0);
});
