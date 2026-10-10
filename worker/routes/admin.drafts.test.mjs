// Drafts: adding an event through the editor, with or without a poster.
//
// Through the real Router, like the events tests, because the risks here are
// the ones a unit test cannot see: a route scoped on the body instead of the
// draft's own parish, a read that overwrites what a person typed while it was
// running, a publish that loses the combine the old dialog carried.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Router } from '../lib/router.mjs';
import { registerAdminRoutes } from './admin.mjs';
import { expandWindow } from '../lib/expand.mjs';
import { DRAFTS_DDL, ensureDraftTables } from '../lib/drafts.mjs';
import { isDataWrite } from '../lib/data-version.mjs';
import { haikuStream, fakeFetch } from '../lib/test-fakes.mjs';
import sse from '../../public/shared/sse.js';

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
    if (st.reader) return { results: st.all(...this.args) };   // INSERT … RETURNING in a batch
    const r = st.run(...this.args);
    return { meta: { changes: r.changes } };
  }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async first() { const r = this.db.prepare(this.sql).get(...this.args); return r === undefined ? null : r; }
  async run() { return this._runSync(); }
}

/** R2, enough for a poster: put, get (with its type), delete. */
function bucket() {
  const store = new Map();
  const deleted = [];
  return {
    store, deleted,
    async put(key, body, opts) { store.set(key, { bytes: new Uint8Array(body), opts }); },
    async get(key) {
      const o = store.get(key);
      return o ? { arrayBuffer: async () => o.bytes.buffer, httpMetadata: o.opts.httpMetadata } : null;
    },
    async delete(keys) {
      for (const k of (Array.isArray(keys) ? keys : [keys])) { deleted.push(k); store.delete(k); }
    },
  };
}

function fresh(roleRow, { key = 'test-key' } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-dr-')), 'x.db');
  const raw = new Database(file);
  raw.pragma('foreign_keys = ON');
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  if (roleRow) {
    raw.prepare('INSERT INTO admin_roles (email, role, parish_ids) VALUES (?,?,?)')
      .run('dev', roleRow.role, roleRow.parishIds ? JSON.stringify(roleRow.parishIds) : null);
  }
  const router = new Router();
  registerAdminRoutes(router);
  const b = bucket();
  const env = { DB: new D1(raw), AGORA_DEV_ADMIN: 'true', ASSETS_BUCKET: b };
  if (key) env.ANTHROPIC_API_KEY = key;

  const send = async (method, url, init = {}) => {
    const res = await router.handle(new Request(`https://orthodoxy.au${url}`, { method, ...init }), env, {});
    assert.ok(res, `no route matched ${method} ${url}`);
    return res;
  };
  const call = async (method, url, body) => {
    const res = await send(method, url, body === undefined ? {} : {
      body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
    });
    let parsed = null;
    try { parsed = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: parsed };
  };
  /** POST a poster; the SSE answer, parsed into frames. */
  const poster = async (draftId, bytes = jpeg(), type = 'image/jpeg', qs = '') => {
    const res = await send('POST', `/api/admin/drafts/${draftId}/poster${qs}`, {
      body: bytes, headers: { 'Content-Type': type },
    });
    if (!res.headers.get('content-type').startsWith('text/event-stream')) {
      return { status: res.status, body: await res.json(), frames: [] };
    }
    const frames = [];
    const p = sse.createSseParser(e => frames.push({ event: e.event, ...JSON.parse(e.data) }));
    p.push(await res.text());
    p.end();
    return { status: res.status, frames };
  };
  return { raw, env, bucket: b, call, poster, send };
}

const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);

/** Run `fn` with a fake global fetch; restore it after. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

/** A seeded parish in Sydney time that has rules, and another. */
function parishes(raw) {
  const rows = raw.prepare(
    `SELECT DISTINCT p.id FROM parishes p JOIN schedules s ON s.parish_id = p.id
     WHERE p.id != '_unassigned' AND p.timezone = 'Australia/Sydney' ORDER BY p.id`).all();
  assert.ok(rows.length >= 2);
  return [rows[0].id, rows[1].id];
}

const TWO = {
  kind: 'several_events',
  events: [
    { title: 'Youth Night', date: '2026-11-14', weekday_printed: 'Saturday', year_printed: false,
      start_time: '19:00', end_time: null, event_type: 'youth', languages: [], venue: null,
      description: 'Bring a plate.', notes: [{ field: 'start_time', text: 'Doors 6:30.' }] },
    { title: 'Talk on prayer', date: '2026-11-21', weekday_printed: 'Saturday', year_printed: false,
      start_time: '18:30', end_time: '20:00', event_type: 'talk', languages: ['Greek'], venue: 'Church hall',
      description: null, notes: [] },
  ],
  notes: [],
};

// ── who may ──

test('no role is refused; a contact drafts at their own parish only', async () => {
  // Somebody else on the list and not 'dev': signed in, with no role.
  const none = fresh();
  none.raw.prepare("INSERT INTO admin_roles (email, role) VALUES ('someone@else', 'owner')").run();
  const [a, b] = parishes(none.raw);
  assert.equal((await none.call('POST', '/api/admin/drafts', { parish_id: a })).status, 403);

  const f = fresh({ role: 'parish', parishIds: [a] });
  assert.equal((await f.call('POST', '/api/admin/drafts', { parish_id: a })).status, 201);
  assert.equal((await f.call('POST', '/api/admin/drafts', { parish_id: b })).status, 403);
});

test('a draft at another parish is out of reach by its id — read, edit, read a poster, publish, discard', async () => {
  const f = fresh({ role: 'owner' });
  const [a, b] = parishes(f.raw);
  const d = (await f.call('POST', '/api/admin/drafts', { parish_id: b, card: { title: 'Theirs' } })).body;
  f.raw.prepare("UPDATE admin_roles SET role = 'parish', parish_ids = ? WHERE email = 'dev'").run(JSON.stringify([a]));

  const cid = d.cards[0].id;
  assert.equal((await f.call('GET', `/api/admin/drafts/${d.id}`)).status, 403);
  assert.equal((await f.call('PATCH', `/api/admin/draft-events/${cid}`, { title: 'Mine now' })).status, 403);
  assert.equal((await f.poster(d.id)).status, 403);
  assert.equal((await f.call('POST', `/api/admin/draft-events/${cid}/publish`, {})).status, 403);
  assert.equal((await f.call('DELETE', `/api/admin/drafts/${d.id}`)).status, 403);
  assert.deepEqual((await f.call('GET', '/api/admin/drafts')).body, [], 'and it is not listed');
  assert.equal(f.raw.prepare('SELECT title FROM draft_events WHERE id = ?').get(cid).title, 'Theirs');
});

// ── autosave ──

test('a card saves field by field, in the shapes the form holds', async () => {
  const f = fresh({ role: 'editor' });
  const [a] = parishes(f.raw);
  const d = (await f.call('POST', '/api/admin/drafts', { parish_id: a, card: { title: 'Feast' } })).body;
  assert.equal(d.cards.length, 1);
  const cid = d.cards[0].id;

  for (const [patch, field] of [[{ date: '2026-02-30' }, 'date'], [{ start_time: '7pm' }, 'start_time'],
    [{ event_type: 'vespers' }, 'event_type'], [{ replaces: ['abc'] }, 'replaces'], [{ also_at: 'x' }, 'also_at']]) {
    const r = await f.call('PATCH', `/api/admin/draft-events/${cid}`, patch);
    assert.equal(r.status, 400, JSON.stringify(patch));
    assert.equal(r.body.field, field);
  }
  const r = await f.call('PATCH', `/api/admin/draft-events/${cid}`, {
    date: '2026-12-19', start_time: '17:00', end_time: '', event_type: 'feast',
    languages: ['English', 'Greek'], also_at: ['x', 'x'], replaces: ['12', '3:2026-12-19'],
  });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.date, r.body.start_time, r.body.end_time, r.body.languages, r.body.also_at, r.body.replaces],
    ['2026-12-19', '17:00', null, ['English', 'Greek'], ['x'], ['12', '3:2026-12-19']]);
  assert.deepEqual((await f.call('GET', '/api/admin/drafts')).body.map(x => x.id), [d.id]);
});

// ── the poster ──

test('only an image, and not a huge one', async () => {
  const f = fresh({ role: 'editor' });
  const [a] = parishes(f.raw);
  const d = (await f.call('POST', '/api/admin/drafts', { parish_id: a })).body;
  assert.equal((await f.poster(d.id, new Uint8Array([1, 2]), 'text/plain')).status, 415);
  assert.equal((await f.poster(d.id, new Uint8Array(5 * 1024 * 1024 + 1), 'image/png')).status, 413);
  assert.equal(f.bucket.store.size, 0, 'nothing stored for a refused upload');
});

test('with no key the poster is still stored and attached, and the editor is told why nothing was read', async () => {
  const f = fresh({ role: 'editor' }, { key: null });
  const [a] = parishes(f.raw);
  const d = (await f.call('POST', '/api/admin/drafts', { parish_id: a })).body;
  const { frames } = await f.poster(d.id);
  assert.deepEqual(frames.map(x => x.event), ['poster', 'result']);
  const [key] = [...f.bucket.store.keys()];
  assert.match(key, new RegExp(`^posters/${a}-[a-z0-9]+-[a-z0-9]+\\.jpg$`), 'one path segment under posters/');
  assert.equal(frames[0].poster_path, `/${key}`);
  assert.equal(frames[1].configured, false);
  assert.match(frames[1].error, /not set up/);
  assert.equal(frames[1].draft.poster_path, `/${key}`);
  assert.equal(frames[1].draft.cards.length, 1, 'the blank card is still there to type into');
});

test('a read streams into the cards: empty fields filled, the rest appended, a typed title kept', async () => {
  const f = fresh({ role: 'editor' });
  const [a] = parishes(f.raw);
  const d = (await f.call('POST', '/api/admin/drafts', { parish_id: a, card: { title: 'Our Youth Night' } })).body;
  const fetchImpl = fakeFetch(haikuStream(JSON.stringify(TWO)));
  const { frames } = await withFetch(fetchImpl, () => f.poster(d.id));

  const sent = fetchImpl.calls[0];
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.body.model, 'claude-haiku-4-5');
  assert.match(sent.body.messages[0].content[1].text, /Its regular services:\n- /);

  const kinds = frames.map(x => x.event);
  assert.equal(kinds[0], 'poster');
  assert.equal(kinds[1], 'kind');
  assert.ok(kinds.indexOf('item') > kinds.indexOf('field'));
  assert.equal(kinds[kinds.length - 1], 'result');
  assert.deepEqual(frames.filter(x => x.event === 'item').map(x => x.index), [0, 1]);

  const cards = frames[frames.length - 1].draft.cards;
  assert.equal(cards.length, 2);
  assert.equal(cards[0].title, 'Our Youth Night', 'what the person typed stays');
  assert.deepEqual([cards[0].date, cards[0].start_time, cards[0].event_type], ['2026-11-14', '19:00', 'youth']);
  assert.ok(!cards[0].read_fields.includes('title') && cards[0].read_fields.includes('date'));
  assert.deepEqual(cards[0].read_notes, [{ field: 'start_time', text: 'Doors 6:30.' }]);
  assert.deepEqual([cards[0].printed_weekday, cards[0].year_printed], ['Saturday', 0]);
  assert.deepEqual([cards[1].title, cards[1].location_override, cards[1].languages], ['Talk on prayer', 'Church hall', ['Greek']]);
  assert.equal(frames[frames.length - 1].draft.read_status, 'read');
  assert.equal(frames[frames.length - 1].draft.read_kind, 'several_events');
});

test('an edit that lands while the poster is being read wins over the read', async () => {
  const f = fresh({ role: 'editor' });
  const [a] = parishes(f.raw);
  const d = (await f.call('POST', '/api/admin/drafts', { parish_id: a })).body;
  const cid = d.cards[0].id;
  const body = new TextEncoder().encode(haikuStream(JSON.stringify(TWO)));
  // A stream that, halfway through, waits for the person's PATCH to land.
  const slow = async () => new Response(new ReadableStream({
    async start(c) {
      c.enqueue(body.slice(0, body.length >> 1));
      const r = await f.call('PATCH', `/api/admin/draft-events/${cid}`, { start_time: '18:45' });
      assert.equal(r.status, 200);
      c.enqueue(body.slice(body.length >> 1));
      c.close();
    },
  }), { status: 200 });
  const { frames } = await withFetch(slow, () => f.poster(d.id));
  const card = frames[frames.length - 1].draft.cards[0];
  assert.equal(card.start_time, '18:45');
  assert.equal(card.title, 'Youth Night', 'the fields nobody touched are filled');
  assert.ok(!card.read_fields.includes('start_time'));
});

test('a busy reader says to try again, marks the read failed and leaves the cards alone', async () => {
  const f = fresh({ role: 'editor' });
  const [a] = parishes(f.raw);
  const d = (await f.call('POST', '/api/admin/drafts', { parish_id: a, card: { title: 'Kept' } })).body;
  const { frames } = await withFetch(fakeFetch('{"type":"error"}', { status: 429 }), () => f.poster(d.id));
  assert.deepEqual(frames.map(x => x.event), ['poster', 'error', 'result']);
  assert.equal(frames[1].retry, true);
  assert.equal(frames[2].draft.read_status, 'failed');
  assert.deepEqual(frames[2].draft.cards.map(c => c.title), ['Kept']);

  // …and reading again uses the poster already stored, with no upload.
  const again = await withFetch(fakeFetch(haikuStream(JSON.stringify(TWO))), () => f.poster(d.id, undefined, '', '?reread=1'));
  assert.equal(again.frames[again.frames.length - 1].draft.read_status, 'read');
  assert.equal(f.bucket.store.size, 1);
});

// ── publishing ──

test('publishing turns local wall-clock into instants, puts the poster on, and spends the card', async () => {
  const f = fresh({ role: 'editor' }, { key: null });
  const [a] = parishes(f.raw);
  const d = (await f.call('POST', '/api/admin/drafts', { parish_id: a })).body;
  await f.poster(d.id);
  const [key] = [...f.bucket.store.keys()];
  const second = (await f.call('POST', `/api/admin/drafts/${d.id}/events`, { title: 'Vigil' })).body;
  // Sydney's clocks go forward at 02:00 on 4 Oct 2026: 01:30 is +10, 03:30 is +11.
  await f.call('PATCH', `/api/admin/draft-events/${d.cards[0].id}`,
    { title: 'Early', date: '2026-10-04', start_time: '01:30', end_time: '03:30', event_type: 'prayer' });
  await f.call('PATCH', `/api/admin/draft-events/${second.id}`,
    { date: '2026-11-14', start_time: '23:00', end_time: '02:00' });

  const one = await f.call('POST', `/api/admin/draft-events/${d.cards[0].id}/publish`, {});
  assert.equal(one.status, 201);
  assert.equal(one.body.remaining, 1);
  const e1 = one.body.event;
  assert.deepEqual([e1.start_utc, e1.end_utc, e1.event_type, e1.source_adapter, e1.poster_path],
    ['2026-10-03T15:30:00.000Z', '2026-10-03T16:30:00.000Z', 'prayer', 'manual', `/${key}`]);

  const two = await f.call('POST', `/api/admin/draft-events/${second.id}/publish`, {});
  assert.equal(two.status, 201);
  assert.equal(two.body.event.end_utc, '2026-11-14T15:00:00.000Z', 'an end before the start is the next morning');
  assert.equal(two.body.event.event_type, 'other', 'no kind chosen reads as Other, as the create always did');
  assert.equal(two.body.remaining, 0);
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM drafts').get().n, 0, 'the last card takes the draft');
  assert.ok(f.bucket.store.has(key), 'the poster stays — the events show it');
  assert.deepEqual(f.bucket.deleted, []);
});

test('a card that is not ready to publish says what is missing and stays a draft', async () => {
  const f = fresh({ role: 'editor' });
  const [a] = parishes(f.raw);
  const d = (await f.call('POST', '/api/admin/drafts', { parish_id: a, card: { title: 'No time yet' } })).body;
  await f.call('PATCH', `/api/admin/draft-events/${d.cards[0].id}`, { date: '2026-11-14' });
  const r = await f.call('POST', `/api/admin/draft-events/${d.cards[0].id}/publish`, {});
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Needs a start time/);
  assert.deepEqual(r.body.checks.map(c => c.field), ['start_time']);
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM draft_events').get().n, 1);
});

test('the combine travels with the card, and an out-of-reach part becomes an ask', async () => {
  const f = fresh({ role: 'owner' });
  const [a, b] = parishes(f.raw);
  const occ = (await expandWindow(f.env.DB, '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z'))
    .find(e => e.parish_id === b);
  assert.ok(occ, 'parish b has a service in November');
  const date = occ.id.split(':')[1];

  const d = (await f.call('POST', '/api/admin/drafts', { parish_id: a, card: {
    title: 'Deanery Liturgy', date, start_time: '09:30', also_at: [b], replaces: [occ.id],
  } })).body;
  const r = await f.call('POST', `/api/admin/draft-events/${d.cards[0].id}/publish`, {});
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.event.additional_parishes, [b]);
  const [sid] = occ.id.split(':');
  const ov = f.raw.prepare('SELECT kind, combined_into_event_id FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?')
    .get(Number(sid), date);
  assert.deepEqual(ov, { kind: 'combined', combined_into_event_id: r.body.event.id });

  // A parish contact asking for the same thing: refused without `propose`…
  f.raw.prepare("UPDATE admin_roles SET role = 'parish', parish_ids = ? WHERE email = 'dev'").run(JSON.stringify([a]));
  const d2 = (await f.call('POST', '/api/admin/drafts', { parish_id: a, card: {
    title: 'Pan-Orthodox Vespers', date, start_time: '17:00', also_at: [b], ask_reason: 'Sunday of Orthodoxy',
  } })).body;
  const no = await f.call('POST', `/api/admin/draft-events/${d2.cards[0].id}/publish`, {});
  assert.equal(no.status, 403);
  assert.equal(no.body.proposable, true);
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM draft_events WHERE id = ?').get(d2.cards[0].id).n, 1, 'still a draft');
  // …and with it, their half is published and the rest is an ask carrying the card's reason.
  const yes = await f.call('POST', `/api/admin/draft-events/${d2.cards[0].id}/publish`, { propose: true });
  assert.equal(yes.status, 201);
  assert.ok(yes.body.proposal_id);
  const ask = f.raw.prepare('SELECT capability, reason FROM admin_proposals WHERE id = ?').get(yes.body.proposal_id);
  assert.deepEqual(ask, { capability: 'event.combine', reason: 'Sunday of Orthodoxy' });
});

// ── discarding ──

test('discarding deletes the draft and its poster — unless an event published from it shows it', async () => {
  const f = fresh({ role: 'editor' }, { key: null });
  const [a] = parishes(f.raw);
  const d = (await f.call('POST', '/api/admin/drafts', { parish_id: a })).body;
  await f.poster(d.id);
  const [key] = [...f.bucket.store.keys()];
  assert.equal((await f.call('DELETE', `/api/admin/drafts/${d.id}`)).status, 200);
  assert.deepEqual(f.bucket.deleted, [key]);
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM draft_events').get().n, 0, 'the cards go with it');

  const g = fresh({ role: 'editor' }, { key: null });
  const d2 = (await g.call('POST', '/api/admin/drafts', { parish_id: a, card: { title: 'One', date: '2026-11-14', start_time: '10:00' } })).body;
  await g.poster(d2.id);
  const [key2] = [...g.bucket.store.keys()];
  await g.call('POST', `/api/admin/drafts/${d2.id}/events`, { title: 'Two' });
  assert.equal((await g.call('POST', `/api/admin/draft-events/${d2.cards[0].id}/publish`, {})).status, 201);
  assert.equal((await g.call('DELETE', `/api/admin/drafts/${d2.id}`)).status, 200);
  assert.deepEqual(g.bucket.deleted, [], 'the published event still shows the poster');
});

// ── plumbing ──

test('draft writes leave the public data version alone; publishing moves it', () => {
  const ok = new Response('{}', { status: 200 });
  const w = (method, p) => isDataWrite(new Request(`https://orthodoxy.au${p}`, { method }), ok);
  assert.equal(w('POST', '/api/admin/drafts'), false);
  assert.equal(w('PATCH', '/api/admin/draft-events/4'), false);
  assert.equal(w('POST', '/api/admin/drafts/3/poster'), false);
  assert.equal(w('PATCH', '/api/admin/drafts/3'), false, 'moving a draft is still a draft');
  assert.equal(w('DELETE', '/api/admin/drafts/3'), false);
  assert.equal(w('POST', '/api/admin/draft-events/4/publish'), true);
  assert.equal(w('POST', '/api/admin/events'), true);
  assert.equal(w('POST', '/api/admin/draftsman'), true, 'only the draft routes themselves');
});

test('the first-use DDL builds the same tables as the baseline', () => {
  const base = new Database(':memory:');
  base.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  const lazy = new Database(':memory:');
  lazy.exec('CREATE TABLE parishes (id TEXT PRIMARY KEY)');
  for (const sql of DRAFTS_DDL) lazy.exec(sql);
  for (const t of ['drafts', 'draft_events']) {
    const cols = (db) => db.prepare(`PRAGMA table_info(${t})`).all();
    assert.deepEqual(cols(lazy), cols(base), t);
  }
  const idx = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('drafts','draft_events') ORDER BY name").all();
  assert.deepEqual(idx(lazy), idx(base));
});

test('a database made before 019 gets read_parish on first use', async () => {
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE parishes (id TEXT PRIMARY KEY)');
  raw.exec(fs.readFileSync('d1/migrations/018-drafts.sql', 'utf8'));
  const has = () => raw.prepare('PRAGMA table_info(drafts)').all().some(c => c.name === 'read_parish');
  assert.equal(has(), false);
  await ensureDraftTables(new D1(raw));
  assert.equal(has(), true);
  await ensureDraftTables(new D1(raw));   // and again, as the next isolate would: no duplicate column
  assert.equal(has(), true);
});

// ── moving a draft: the poster was another parish's ──

const ELIAS = 'antiochian-stelias-wollongong';      // 86 Kenny Street, Wollongong NSW 2500
const PUNCHBOWL = 'antiochian-stnicholas-punchbowl';
const RYDE = 'antiochian-stmichaelgabriel-ryde';

/** St Elias's youth night, dropped while another parish's editor was open. */
const ELSEWHERE = {
  kind: 'event',
  other_parish: { name: 'St Elias Antiochian Orthodox Church', place: 'Wollongong' },
  events: [{ title: 'Youth Movie Night', date: '2026-11-13', weekday_printed: 'Friday', year_printed: false,
    start_time: '19:00', end_time: null, event_type: 'youth', languages: [], venue: '86 Kenny St, Wollongong NSW',
    description: 'A movie and pizza.', notes: [{ field: 'venue', text: 'Address from the foot of the poster.' }] }],
  notes: [],
};

const readAt = async (f, parishId, doc) => {
  const d = (await f.call('POST', '/api/admin/drafts', { parish_id: parishId })).body;
  const { frames } = await withFetch(fakeFetch(haikuStream(JSON.stringify(doc))), () => f.poster(d.id));
  return frames[frames.length - 1].draft;
};

test('another parish’s poster names that parish, and moving there drops the venue that was only its address', async () => {
  const f = fresh({ role: 'editor' });
  const read = await readAt(f, PUNCHBOWL, ELSEWHERE);
  assert.deepEqual(read.read_parish,
    { name: 'St Elias Antiochian Orthodox Church', place: 'Wollongong', parish_id: ELIAS });
  const cid = read.cards[0].id;
  assert.equal(read.cards[0].location_override, '86 Kenny St, Wollongong NSW', 'somewhere else, seen from Punchbowl');
  assert.ok(read.cards[0].read_fields.includes('location_override'));
  // Ticked before anybody noticed whose poster it was.
  await f.call('PATCH', `/api/admin/draft-events/${cid}`, { also_at: [ELIAS, RYDE] });

  const moved = await f.call('PATCH', `/api/admin/drafts/${read.id}`, { parish_id: ELIAS });
  assert.equal(moved.status, 200);
  assert.deepEqual([moved.body.parish_id, moved.body.parish_name], [ELIAS, 'St Elias, Wollongong']);
  const card = moved.body.cards[0];
  assert.equal(card.id, cid, 'the same card, moved — not a copy');
  assert.equal(card.location_override, null, 'just the church, now the draft is the church’s');
  assert.ok(!card.read_fields.includes('location_override'));
  assert.deepEqual(card.read_notes.filter(n => n.field === 'location_override'), []);
  assert.deepEqual(card.also_at, [RYDE], 'not also at its own parish');
  assert.deepEqual([card.title, card.date, card.start_time], ['Youth Movie Night', '2026-11-13', '19:00']);
  assert.ok(card.read_fields.includes('title'), 'the rest is still as read, marks and all');
  assert.equal(moved.body.read_parish.parish_id, ELIAS, 'kept: the editor hides it once the draft is there');
  assert.equal((await f.call('GET', `/api/admin/drafts?parish=${ELIAS}`)).body.length, 1);
  assert.equal((await f.call('GET', `/api/admin/drafts?parish=${PUNCHBOWL}`)).body.length, 0);
});

test('a venue somebody typed, or a room at the address, survives a move', async () => {
  const f = fresh({ role: 'editor' });
  const typed = (await f.call('POST', '/api/admin/drafts',
    { parish_id: PUNCHBOWL, card: { title: 'Picnic', location_override: '86 Kenny St, Wollongong' } })).body;
  const moved = (await f.call('PATCH', `/api/admin/drafts/${typed.id}`, { parish_id: ELIAS })).body;
  assert.equal(moved.cards[0].location_override, '86 Kenny St, Wollongong', 'a person’s words are theirs');

  const hall = await readAt(f, PUNCHBOWL, { ...ELSEWHERE,
    events: [{ ...ELSEWHERE.events[0], venue: 'Parish hall, 86 Kenny St, Wollongong' }] });
  const movedHall = (await f.call('PATCH', `/api/admin/drafts/${hall.id}`, { parish_id: ELIAS })).body;
  assert.equal(movedHall.cards[0].location_override, 'Parish hall, 86 Kenny St, Wollongong', 'a room to find');
});

test('read at the parish itself: its own address is no venue, and "another parish" that is this one is dropped', async () => {
  const f = fresh({ role: 'editor' });
  const read = await readAt(f, ELIAS, ELSEWHERE);
  assert.equal(read.read_parish, null, 'the reader was wrong that it was somebody else’s');
  assert.equal(read.cards[0].location_override, null, 'the card that started this: 86 Kenny St at 86 Kenny Street');
  assert.ok(!read.cards[0].read_fields.includes('location_override'));
  assert.deepEqual(read.cards[0].read_notes.filter(n => n.field === 'location_override'), []);
  assert.equal(read.cards[0].title, 'Youth Movie Night');
});

test('a parish the read cannot place is kept as printed, and choosing one answers it', async () => {
  const f = fresh({ role: 'editor' });
  const read = await readAt(f, PUNCHBOWL, { ...ELSEWHERE,
    other_parish: { name: 'Holy Archangels Mission', place: 'Toowoomba' },
    events: [{ ...ELSEWHERE.events[0], venue: 'Showground pavilion' }] });
  assert.deepEqual(read.read_parish, { name: 'Holy Archangels Mission', place: 'Toowoomba', parish_id: null });
  const moved = (await f.call('PATCH', `/api/admin/drafts/${read.id}`, { parish_id: RYDE })).body;
  assert.equal(moved.read_parish, null);
  assert.equal(moved.cards[0].location_override, 'Showground pavilion');
});

test('moving is scoped on both parishes, and refused mid-read or to nowhere', async () => {
  const f = fresh({ role: 'parish', parishIds: [PUNCHBOWL] });
  const d = (await f.call('POST', '/api/admin/drafts', { parish_id: PUNCHBOWL, card: { title: 'Ours' } })).body;
  assert.equal((await f.call('PATCH', `/api/admin/drafts/${d.id}`, { parish_id: ELIAS })).status, 403,
    'not one of theirs to move it to');
  assert.equal(f.raw.prepare('SELECT parish_id FROM drafts WHERE id = ?').get(d.id).parish_id, PUNCHBOWL);

  f.raw.prepare("UPDATE admin_roles SET parish_ids = ? WHERE email = 'dev'").run(JSON.stringify([PUNCHBOWL, ELIAS]));
  assert.equal((await f.call('PATCH', `/api/admin/drafts/${d.id}`, {})).status, 400);
  assert.equal((await f.call('PATCH', `/api/admin/drafts/${d.id}`, { parish_id: PUNCHBOWL })).body.parish_id, PUNCHBOWL,
    'where it already is: nothing to do');
  f.raw.prepare("UPDATE drafts SET read_status = 'reading' WHERE id = ?").run(d.id);
  assert.equal((await f.call('PATCH', `/api/admin/drafts/${d.id}`, { parish_id: ELIAS })).status, 409);
  f.raw.prepare('UPDATE drafts SET read_status = NULL WHERE id = ?').run(d.id);
  assert.equal((await f.call('PATCH', `/api/admin/drafts/${d.id}`, { parish_id: ELIAS })).status, 200);

  f.raw.prepare("UPDATE admin_roles SET parish_ids = ? WHERE email = 'dev'").run(JSON.stringify([PUNCHBOWL]));
  assert.equal((await f.call('PATCH', `/api/admin/drafts/${d.id}`, { parish_id: PUNCHBOWL })).status, 403,
    'and not back out of a parish that is not theirs');

  const o = fresh({ role: 'owner' });
  const od = (await o.call('POST', '/api/admin/drafts', { parish_id: PUNCHBOWL })).body;
  assert.equal((await o.call('PATCH', `/api/admin/drafts/${od.id}`, { parish_id: 'nowhere' })).status, 400);
  assert.equal((await o.call('PATCH', `/api/admin/drafts/${od.id}`, { parish_id: '_unassigned' })).status, 400);
});

// ── a month's programme: its Saturdays and Sundays are the regular services ──

const ROOKWOOD = 'greek-stathanasios-rookwood';
const DOONSIDE = 'antiochian-stspeterpaul-doonside';

/** St Athanasios, Rookwood, with the two rules its sign gives. Not in the seed. */
function addRookwood(raw) {
  raw.prepare(`INSERT INTO parishes (id, name, jurisdiction, address, lat, lng, timezone)
    VALUES (?, 'St Athanasios, Rookwood', 'greek', 'Cnr Weekes & Carpenter Ave, Rookwood NSW 2141', -33.874, 151.054, 'Australia/Sydney')`)
    .run(ROOKWOOD);
  const rule = (day, end) => raw.prepare(
    `INSERT INTO schedules (parish_id, day_of_week, start_time, end_time, title, event_type)
     VALUES (?, ?, '08:00', ?, 'Orthros & Divine Liturgy', 'liturgy') RETURNING id`).get(ROOKWOOD, day, end).id;
  return { sat: rule(6, '10:00'), sun: rule(0, '11:00') };
}

/**
 * A programme in Greek, read in English: three of the parish's own services
 * with their saints, and one service that is not on the timetable.
 * (2030, so no date has passed whenever this runs.)
 */
const PROGRAMME = {
  kind: 'bulletin', written_in: 'Greek', other_parish: null, notes: [], services: [],
  details: { address: '', phone: '', email: '', website: '' },
  events: [
    { title: 'Orthros and Divine Liturgy', feast: 'Dionysios the Areopagite', date: '2030-11-02', weekday_printed: 'Saturday',
      year_printed: true, start_time: '08:00', end_time: '10:00', event_type: 'feast', languages: [], venue: null, description: null, notes: [] },
    { title: 'Orthros and Divine Liturgy', feast: 'Hierotheos, Bishop of Athens', date: '2030-11-03', weekday_printed: 'Sunday',
      year_printed: true, start_time: '08:00', end_time: '11:00', event_type: 'liturgy', languages: [], venue: null, description: null, notes: [] },
    { title: 'Orthros and Divine Liturgy', feast: 'Luke the Evangelist', date: '2030-11-10', weekday_printed: 'Sunday',
      year_printed: true, start_time: '08:00', end_time: '11:00', event_type: 'liturgy', languages: [], venue: null, description: null, notes: [] },
    { title: 'Great Vespers', feast: 'Luke the Evangelist', date: '2030-11-09', weekday_printed: 'Saturday',
      year_printed: true, start_time: '18:00', end_time: null, event_type: 'prayer', languages: [], venue: null, description: null, notes: [] },
  ],
};

test('a programme’s dated services are matched to their occurrences, in English, with each day’s saint', async () => {
  const f = fresh({ role: 'editor' });
  const { sat, sun } = addRookwood(f.raw);
  const d = (await f.call('POST', '/api/admin/drafts', { parish_id: ROOKWOOD })).body;
  const fetchImpl = fakeFetch(haikuStream(JSON.stringify(PROGRAMME)));
  const { frames } = await withFetch(fetchImpl, () => f.poster(d.id));
  assert.match(fetchImpl.calls[0].body.messages[0].content[1].text,
    /- Sundays 08:00–11:00 Orthros & Divine Liturgy\n- Saturdays 08:00–10:00 Orthros & Divine Liturgy/);

  const draft = frames[frames.length - 1].draft;
  assert.equal(draft.read_language, 'Greek');
  assert.deepEqual(draft.cards.map(c => c.occurrence),
    [`${sat}:2030-11-02`, `${sun}:2030-11-03`, `${sun}:2030-11-10`, null]);
  assert.deepEqual(draft.cards.map(c => c.feast),
    ['Dionysios the Areopagite', 'Hierotheos, Bishop of Athens', 'Luke the Evangelist', 'Luke the Evangelist']);
  // The rule's own title and kind, so the override says only what changed.
  assert.deepEqual([draft.cards[0].title, draft.cards[0].event_type], ['Orthros & Divine Liturgy', 'liturgy']);
  assert.equal(draft.cards[3].title, 'Great Vespers');
});

test('publishing a matched card writes onto that occurrence: its saint and the poster, nothing beside it', async () => {
  const f = fresh({ role: 'editor' });
  const { sat, sun } = addRookwood(f.raw);
  // The first Sunday is already cancelled, with a note somebody wrote.
  f.raw.prepare(`INSERT INTO schedule_overrides (schedule_id, occurrence_date, kind, patch_description)
    VALUES (?, '2030-11-03', 'cancelled', 'The priest is away.')`).run(sun);
  const draft = await readAt(f, ROOKWOOD, PROGRAMME);
  const poster = draft.poster_path;
  const events = () => f.raw.prepare('SELECT COUNT(*) n FROM events').get().n;
  const before = events();

  const one = await f.call('POST', `/api/admin/draft-events/${draft.cards[0].id}/publish`, {});
  assert.equal(one.status, 201);
  assert.equal(one.body.occurrence, true);
  assert.equal(one.body.event.id, `${sat}:2030-11-02`);
  assert.deepEqual([one.body.event.title, one.body.event.feast, one.body.event.poster_path, one.body.event.status],
    ['Orthros & Divine Liturgy', 'Dionysios the Areopagite', poster, 'approved']);
  const o = f.raw.prepare('SELECT * FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?').get(sat, '2030-11-02');
  assert.deepEqual([o.kind, o.patch_title, o.patch_start_time, o.patch_end_time, o.patch_event_type, o.patch_feast, o.patch_poster_path],
    ['modified', null, null, null, null, 'Dionysios the Areopagite', poster], 'only what the programme changes');

  // Nothing disappears, and a field the card leaves empty is not "clear it".
  const two = await f.call('POST', `/api/admin/draft-events/${draft.cards[1].id}/publish`, {});
  assert.equal(two.status, 201);
  const c = f.raw.prepare('SELECT * FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?').get(sun, '2030-11-03');
  assert.deepEqual([c.kind, c.patch_description, c.patch_feast], ['cancelled', 'The priest is away.', 'Hierotheos, Bishop of Athens']);
  assert.equal(events(), before, 'no event written beside the services');

  // A service not on the timetable is an event, and says its saint in its title.
  const vespers = await f.call('POST', `/api/admin/draft-events/${draft.cards[3].id}/publish`, {});
  assert.equal(vespers.status, 201);
  assert.equal(vespers.body.event.title, 'Great Vespers — Luke the Evangelist');
  assert.equal(vespers.body.event.poster_path, poster);
  assert.equal(events(), before + 1);
});

test('a matched card whose date moved, or whose service is gone, is not written onto it', async () => {
  const f = fresh({ role: 'editor' });
  const { sun } = addRookwood(f.raw);
  const draft = await readAt(f, ROOKWOOD, PROGRAMME);
  const card = draft.cards[2];
  await f.call('PATCH', `/api/admin/draft-events/${card.id}`, { date: '2030-11-17' });
  const moved = await f.call('POST', `/api/admin/draft-events/${card.id}/publish`, {});
  assert.equal(moved.status, 400);
  assert.match(moved.body.error, /date has changed/);
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM schedule_overrides WHERE schedule_id = ?').get(sun).n, 0);

  // Unlinked, it is an event of its own.
  assert.equal((await f.call('PATCH', `/api/admin/draft-events/${card.id}`, { occurrence: '' })).status, 200);
  assert.equal((await f.call('POST', `/api/admin/draft-events/${card.id}/publish`, {})).status, 201);

  // Only a rule's occurrence can be linked, and only this parish's.
  assert.equal((await f.call('PATCH', `/api/admin/draft-events/${draft.cards[1].id}`, { occurrence: 'next sunday' })).body.field,
    'occurrence');
  const other = f.raw.prepare("SELECT id FROM schedules WHERE parish_id = ? LIMIT 1").get(DOONSIDE).id;
  await f.call('PATCH', `/api/admin/draft-events/${draft.cards[1].id}`, { occurrence: `${other}:2030-11-03` });
  const theirs = await f.call('POST', `/api/admin/draft-events/${draft.cards[1].id}/publish`, {});
  assert.equal(theirs.status, 400);
  assert.match(theirs.body.error, /not on this parish/);
});

test('moving a programme’s draft unlinks its cards from the old parish’s services', async () => {
  const f = fresh({ role: 'editor' });
  addRookwood(f.raw);
  const draft = await readAt(f, ROOKWOOD, PROGRAMME);
  const moved = (await f.call('PATCH', `/api/admin/drafts/${draft.id}`, { parish_id: DOONSIDE })).body;
  assert.deepEqual(moved.cards.map(c => c.occurrence), [null, null, null, null]);
  assert.deepEqual(moved.cards.map(c => c.feast).slice(0, 1), ['Dionysios the Areopagite'], 'what it says stays');
});

// ── a church sign: the timetable and the parish's details ──

/** Sts Peter & Paul, Doonside's sign, as a person photographed it. */
const SIGN = {
  kind: 'timetable', written_in: 'English', other_parish: null, events: [], notes: [],
  services: [
    { title: 'Divine Liturgy', day: 'Sunday', start_time: '10:00', end_time: '', weeks: [],
      languages: ['Arabic', 'English'], event_type: 'liturgy', notes: [] },
    { title: 'Divine Liturgy', day: 'Sunday', start_time: '18:00', end_time: '', weeks: ['second', 'fourth'],
      languages: ['English'], event_type: 'liturgy', notes: [] },
  ],
  details: { address: '182 Hill End Road, Doonside 2767', phone: '', email: '', website: '' },
};

test('a sign is read into proposed services and details, and nothing is written to the timetable', async () => {
  const f = fresh({ role: 'editor' });
  const rules = () => f.raw.prepare('SELECT COUNT(*) n FROM schedules WHERE parish_id = ?').get(DOONSIDE).n;
  const before = rules();
  const draft = await readAt(f, DOONSIDE, SIGN);
  assert.equal(draft.read_kind, 'timetable');
  assert.deepEqual(draft.read_services.map(s => [s.day_of_week, s.start_time, s.week_of_month, s.languages]),
    [[0, '10:00', null, ['Arabic', 'English']], [0, '18:00', 'second,fourth', ['English']]]);
  assert.deepEqual(draft.read_details, { address: '182 Hill End Road, Doonside 2767', phone: null, email: null, website: null });
  assert.equal(draft.cards.length, 1, 'the blank card, untouched');
  assert.equal(rules(), before);

  // A person corrects what was read; the list is checked as a whole.
  const fixed = draft.read_services.map((s, i) => (i === 1 ? { ...s, end_time: '19:30' } : s));
  const put = await f.call('PUT', `/api/admin/drafts/${draft.id}/services`, { services: fixed });
  assert.equal(put.status, 200);
  assert.equal(put.body.read_services[1].end_time, '19:30');
  const bad = await f.call('PUT', `/api/admin/drafts/${draft.id}/services`,
    { services: [{ ...fixed[0], start_time: '10am' }] });
  assert.deepEqual([bad.status, bad.body.index], [400, 0]);
  assert.equal(rules(), before, 'still nothing on the timetable');
});

test('a service added from a sign names the sign as the timetable’s source, and keeps the photo', async () => {
  const f = fresh({ role: 'editor' });
  const draft = await readAt(f, DOONSIDE, SIGN);
  const [key] = [...f.bucket.store.keys()];
  const add = await f.call('POST', '/api/admin/schedules', {
    parish_id: DOONSIDE, day_of_week: 0, start_time: '18:00', title: 'Divine Liturgy', event_type: 'liturgy',
    week_of_month: 'second,fourth', languages: '["English"]',
    source_name: 'Church signage', source_ref: draft.poster_path,
  });
  assert.equal(add.status, 201);
  const stamps = f.raw.prepare('SELECT DISTINCT source_name, source_ref FROM schedules WHERE parish_id = ?').all(DOONSIDE);
  assert.deepEqual(stamps, [{ source_name: 'Church signage', source_ref: `/${key}` }], 'one timetable, one source');

  // Done with the sign: the draft goes, the photo the source line links to stays.
  assert.equal((await f.call('DELETE', `/api/admin/drafts/${draft.id}`)).status, 200);
  assert.ok(f.bucket.store.has(key));
  assert.deepEqual(f.bucket.deleted, []);
});

test('a database made before 020 gets the sign and programme columns on first use', async () => {
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE parishes (id TEXT PRIMARY KEY)');
  raw.exec(fs.readFileSync('d1/migrations/018-drafts.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/migrations/019-draft-read-parish.sql', 'utf8'));
  const cols = (t) => raw.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  assert.ok(!cols('drafts').includes('read_services') && !cols('draft_events').includes('occurrence'));
  await ensureDraftTables(new D1(raw));
  assert.deepEqual(cols('drafts').slice(-4), ['read_parish', 'read_language', 'read_services', 'read_details']);
  assert.deepEqual(cols('draft_events').slice(-2), ['occurrence', 'feast']);
});
