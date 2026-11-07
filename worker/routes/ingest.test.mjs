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
    if (id && media.has(id)) return Response.json({ url: `https://lookaside.example/${id}`, mime_type: media.get(id).mime, file_size: 6 });
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

/** The Messages API, answering every read with `doc`; the requests it got. */
async function withReader(doc, fn) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(haikuStream(JSON.stringify(doc)), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try { await fn(calls); } finally { globalThis.fetch = real; }
  return calls;
}

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
  const rest = JSON.parse(d.images);
  assert.equal(rest.length, 1, 'the second picture waits to be joined');
  assert.notEqual(rest[0], d.poster_path);
  assert.deepEqual([...f.env.ASSETS_BUCKET.store.get(d.poster_path.slice(1)).bytes], [0xff, 0xd8, 0xff, 0xe0, 1, 2], 'the first is the poster');
  assert.deepEqual([...f.env.ASSETS_BUCKET.store.get(rest[0].slice(1)).bytes], [...JPEG2]);

  assert.equal(calls.length, 1, 'one read');
  const content = calls[0].messages[0].content;
  assert.deepEqual(content.map(c => c.type), ['image', 'image', 'text'], 'both pictures, in the order sent');
  assert.equal(content[1].source.data, Buffer.from(JPEG2).toString('base64'));
  assert.match(content[2].text, /There are 2 images, sent together as one announcement/);
  assert.match(content[2].text, /The words these images came with on WhatsApp/);
  assert.match(content[2].text, /Read the images\.$/);

  assert.equal(f.graph.sent.length, 1, 'one reply');
  assert.deepEqual(f.raw.prepare('SELECT outcome, draft_id FROM whatsapp_messages ORDER BY rowid').all().map(r => r.outcome).sort(),
    ['draft', 'joined']);
  assert.ok(f.raw.prepare('SELECT draft_id FROM whatsapp_messages').all().every(r => r.draft_id === d.id));
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

test('a PDF is asked for as a screenshot; thirty a day is the most', async () => {
  const f = fresh();
  f.link();
  await f.deliver([{ type: 'document', document: { id: 'D1', mime_type: 'application/pdf', filename: 'Nov.pdf' } }]);
  assert.match(f.graph.texts()[0], /not PDFs yet\. Send a screenshot/);
  const ins = f.raw.prepare("INSERT INTO whatsapp_messages (id, phone, type, sent_at, outcome) VALUES (?, ?, 'image', ?, 'draft')");
  for (let i = 0; i < 30; i++) ins.run(`old${i}`, PHONE, 1762400000 - 100 - i);
  await withReader(READ, async (calls) => {
    await f.deliver([image('one more')]);
    assert.equal(calls.length, 0);
  });
  assert.match(f.graph.texts()[1], /That's 30 posters from this phone today/);
  assert.equal(f.drafts().length, 0);
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
    'Thank you. Got it: Mums Group, Fri 4 Dec 10am. I couldn\'t tell which parish it\'s for, so it\'s with Agora\'s editors. If you know, reply with the parish\'s link, like orthodoxy.au/snp.');

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
  assert.match(f.graph.texts()[0], /^This is Agora \(orthodoxy\.au\)\. To tell a parish its page is wrong or something is coming up, send it here with the parish's link/);
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
  assert.deepEqual([d.source, d.message_text, d.sender_name, d.poster_path], ['whatsapp', 'Mums Group. orthodoxy.au/snp', 'Kevin', x.poster_path]);
  assert.deepEqual(JSON.parse(d.images), x.images, 'for the editor to join');
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
