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
import { DRAFTS_DDL, ensureDraftTables, matchOccurrences } from '../lib/drafts.mjs';
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
  assert.equal(sent.body.model, 'claude-haiku-5-5');
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
  // A talk carries no language, whatever the poster says: only a service is held in one.
  assert.deepEqual([cards[1].title, cards[1].location_override, cards[1].languages], ['Talk on prayer', 'Church hall', []]);
  assert.equal(frames[frames.length - 1].draft.read_status, 'read');
  assert.equal(frames[frames.length - 1].draft.read_kind, 'poster');
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
    { title: 'Early', date: '2026-10-04', start_time: '01:30', end_time: '03:30', event_type: 'prayer', languages: ['English'] });
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

test('the card\'s Public / Parish only pill is kept and published; untapped, the kind decides', async () => {
  const f = fresh({ role: 'editor' }, { key: null });
  const [a] = parishes(f.raw);
  const d = (await f.call('POST', '/api/admin/drafts', { parish_id: a })).body;
  assert.equal(d.cards[0].parish_scoped, null, 'nobody has tapped it');
  const card = async (fields) => (await f.call('POST', `/api/admin/drafts/${d.id}/events`, {
    title: 'Card', date: '2026-11-14', start_time: '19:00', ...fields })).body;
  const scopedOf = async (c) => {
    const r = await f.call('POST', `/api/admin/draft-events/${c.id}/publish`, {});
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return f.raw.prepare('SELECT parish_scoped FROM events WHERE id = ?').get(r.body.event.id).parish_scoped;
  };
  assert.equal((await f.call('PATCH', `/api/admin/draft-events/${d.cards[0].id}`, { parish_scoped: 'yes' })).status, 400);
  const tapped = await f.call('PATCH', `/api/admin/draft-events/${d.cards[0].id}`, { parish_scoped: true });
  assert.equal(tapped.body.parish_scoped, 1);
  assert.equal((await f.call('PATCH', `/api/admin/draft-events/${d.cards[0].id}`, { parish_scoped: null })).body.parish_scoped, null);
  assert.equal(await scopedOf(await card({ event_type: 'other' })), 1, 'an untapped Other is Parish only, as ever');
  assert.equal(await scopedOf(await card({ event_type: 'talk' })), 0, 'an untapped talk is public');
  assert.equal(await scopedOf(await card({ event_type: 'other', parish_scoped: false })), 0, 'tapped to Public');
  assert.equal(await scopedOf(await card({ event_type: 'youth', parish_scoped: true })), 1, 'tapped to Parish only');
});

test('a card over several days publishes its end on the last day, and never matches one Sunday', async () => {
  const f = fresh({ role: 'editor' }, { key: null });
  const [a] = parishes(f.raw);
  const d = (await f.call('POST', '/api/admin/drafts', { parish_id: a })).body;
  const r = await f.call('PATCH', `/api/admin/draft-events/${d.cards[0].id}`,
    { title: 'Parish festival', date: '2026-11-13', end_date: '2026-11-15', start_time: '18:00', end_time: '16:00' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.end_date, '2026-11-15');
  assert.equal((await f.call('PATCH', `/api/admin/draft-events/${d.cards[0].id}`, { end_date: 'Sunday' })).status, 400);
  const pub = await f.call('POST', `/api/admin/draft-events/${d.cards[0].id}/publish`, {});
  assert.equal(pub.status, 201, JSON.stringify(pub.body));
  assert.deepEqual([pub.body.event.start_utc, pub.body.event.end_utc],
    ['2026-11-13T07:00:00.000Z', '2026-11-15T05:00:00.000Z']);
  const read = matchOccurrences({ events: [{ title: 'Divine Liturgy', date: '2026-11-15', end_date: '2026-11-16', start_time: '09:00' }] },
    [{ id: 1, title: 'Divine Liturgy', day_of_week: 0, start_time: '09:00', active: 1 }]);
  assert.equal(read.events[0].occurrence, null, 'a run of days is an event of its own');
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

  // Its pill, tapped to Parish only, is a patch on that date alone.
  await f.call('PATCH', `/api/admin/draft-events/${draft.cards[0].id}`, { parish_scoped: true });
  const one = await f.call('POST', `/api/admin/draft-events/${draft.cards[0].id}/publish`, {});
  assert.equal(one.status, 201);
  assert.equal(one.body.occurrence, true);
  assert.equal(one.body.event.id, `${sat}:2030-11-02`);
  assert.deepEqual([one.body.event.title, one.body.event.feast, one.body.event.poster_path, one.body.event.status],
    ['Orthros & Divine Liturgy', 'Dionysios the Areopagite', poster, 'approved']);
  const o = f.raw.prepare('SELECT * FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?').get(sat, '2030-11-02');
  assert.deepEqual([o.kind, o.patch_title, o.patch_start_time, o.patch_end_time, o.patch_event_type, o.patch_feast, o.patch_poster_path],
    ['modified', null, null, null, null, 'Dionysios the Areopagite', poster], 'only what the programme changes');
  assert.equal(o.patch_parish_scoped, 1, 'and the pill, which somebody tapped');

  // Nothing disappears, and a field the card leaves empty is not "clear it".
  const two = await f.call('POST', `/api/admin/draft-events/${draft.cards[1].id}/publish`, {});
  assert.equal(two.status, 201);
  const c = f.raw.prepare('SELECT * FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?').get(sun, '2030-11-03');
  assert.deepEqual([c.kind, c.patch_description, c.patch_feast], ['cancelled', 'The priest is away.', 'Hierotheos, Bishop of Athens']);
  assert.equal(c.patch_parish_scoped, null, 'an untapped pill is no patch');
  assert.equal(events(), before, 'no event written beside the services');

  // A service not on the timetable is an event, with its saint as its subtitle
  // (events.feast, migration 030), not glued onto its title.
  // It must say its language first: a one-off service has no timetable to go by.
  const bare = await f.call('POST', `/api/admin/draft-events/${draft.cards[3].id}/publish`, {});
  assert.equal(bare.status, 400);
  assert.match(bare.body.error, /Needs a language/);
  await f.call('PATCH', `/api/admin/draft-events/${draft.cards[3].id}`, { languages: ['Greek'] });
  const vespers = await f.call('POST', `/api/admin/draft-events/${draft.cards[3].id}/publish`, {});
  assert.equal(vespers.status, 201);
  assert.deepEqual([vespers.body.event.title, vespers.body.event.feast], ['Great Vespers', 'Luke the Evangelist']);
  assert.equal(vespers.body.event.poster_path, poster);
  assert.equal(events(), before + 1);
});

test('a one-off service the poster gives no language for is suggested the parish\'s usual, unmarked', async () => {
  const f = fresh({ role: 'editor' });
  addRookwood(f.raw);
  f.raw.prepare(`UPDATE schedules SET languages = '["Greek","English"]' WHERE parish_id = ?`).run(ROOKWOOD);
  f.raw.prepare(`INSERT INTO schedules (parish_id, day_of_week, start_time, title, event_type, languages)
    VALUES (?, 6, '17:00', 'Vespers', 'prayer', '["English"]')`).run(ROOKWOOD);
  const draft = await readAt(f, ROOKWOOD, PROGRAMME);
  const vespers = draft.cards[3];
  assert.equal(vespers.occurrence, null);
  assert.deepEqual(vespers.languages, ['English'], 'its kind first: the parish\'s prayers are in English');
  assert.ok(!(vespers.read_fields || []).includes('languages'), 'not from the poster');
  assert.ok((vespers.read_notes || []).some(n => n.field === 'languages' && /Suggested/.test(n.text)));
  assert.deepEqual(draft.cards[1].languages, [], 'a date of a regular service has its service\'s');
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
  assert.equal((await f.call('PATCH', `/api/admin/draft-events/${card.id}`, { occurrence: '', languages: ['Greek'] })).status, 200);
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

// ── something held after a service: not that service, and not at its time ──

/** Doonside's English Liturgy, 6pm on the second and fourth Sundays, as on file. */
const addEnglishLiturgy = (raw, end = null) => raw.prepare(
  `INSERT INTO schedules (parish_id, day_of_week, start_time, end_time, title, event_type, languages, week_of_month)
   VALUES (?, 0, '18:00', ?, 'Liturgy', 'liturgy', '["English"]', 'second,fourth') RETURNING id`).get(DOONSIDE, end).id;

/**
 * SPP Youth's poster (3 Nov 2026): "Outdoor Movie Night", "Following English
 * Liturgy at 6pm", "Sunday 22 November" — here 22 December 2030, a fourth
 * Sunday with a fifth after it — as the reader answered: the Liturgy's 6pm
 * for the movie night's.
 */
const MOVIE_NIGHT = (ev = {}) => ({
  kind: 'poster', written_in: 'English', other_parish: null, notes: [], services: [],
  details: { address: '', phone: '', email: '', website: '' },
  events: [{ title: 'Outdoor Movie Night', feast: '', date: '2030-12-22', weekday_printed: 'Sunday', year_printed: false,
    after: 'English Liturgy', start_time: '18:00', end_time: null, end_date: '', event_type: 'youth', languages: [],
    venue: null, description: 'After the Liturgy. Home Alone, $25 a head with dinner.', notes: [], ...ev }],
});

test('an event after a service is never that service, and does not start when it does', async () => {
  // As it came back on 3 Nov 2026, kind and all: Liturgy, at the Liturgy's 6pm.
  const f = fresh({ role: 'editor' });
  addEnglishLiturgy(f.raw);
  const card = (await readAt(f, DOONSIDE, MOVIE_NIGHT({ event_type: 'liturgy' }))).cards[0];
  assert.equal(card.occurrence, null, 'not that Sunday’s Liturgy');
  assert.equal(card.title, 'Outdoor Movie Night');
  assert.equal(card.start_time, null, 'not the Liturgy’s 6pm: nothing says when it ends');
  assert.deepEqual(card.read_notes.filter(n => n.field === 'start_time').map(n => n.text),
    ['After the 6:00pm Liturgy, so not 6:00pm: nothing gives when that ends, so fill in when this starts.']);

  // With the Liturgy's end on file, it starts then.
  const g = fresh({ role: 'editor' });
  addEnglishLiturgy(g.raw, '19:30');
  const ended = (await readAt(g, DOONSIDE, MOVIE_NIGHT())).cards[0];
  assert.deepEqual([ended.occurrence, ended.start_time, ended.event_type], [null, '19:30', 'youth']);
  assert.ok(ended.read_fields.includes('start_time'));
  assert.match(ended.read_notes.find(n => n.field === 'start_time').text, /from when that ends, 7:30pm; not 6:00pm/);

  // The poster's own service, with its end, goes first: "Cake Stall after the
  // Service" under Vespers 6:00–7:30pm, read at 6pm.
  const h = fresh({ role: 'editor' });
  const stall = (await readAt(h, DOONSIDE, { ...MOVIE_NIGHT(), events: [
    { ...MOVIE_NIGHT().events[0], title: 'Vespers', after: '', start_time: '18:00', end_time: '19:30', event_type: 'prayer' },
    { ...MOVIE_NIGHT().events[0], title: 'Cake Stall', after: 'the Service', start_time: '18:00', event_type: 'social' },
  ] })).cards;
  assert.deepEqual(stall.map(c => c.start_time), ['18:00', '19:30']);

  // A time of its own stays, and so does one after a service at another time.
  const i = fresh({ role: 'editor' });
  addEnglishLiturgy(i.raw);
  const own = (await readAt(i, DOONSIDE, MOVIE_NIGHT({ start_time: '19:45' }))).cards[0];
  assert.deepEqual([own.start_time, own.occurrence], ['19:45', null]);
  assert.ok(!(own.read_notes || []).some(n => n.field === 'start_time'));
});

test('a time alone never makes a youth night a service’s date — a service at that time still is', async () => {
  // An answer with nothing to say the movie night follows the Liturgy: its
  // own kind keeps it off the Liturgy's date, though not off its 6pm.
  const f = fresh({ role: 'editor' });
  const sid = addEnglishLiturgy(f.raw);
  const card = (await readAt(f, DOONSIDE, MOVIE_NIGHT({ after: '' }))).cards[0];
  assert.deepEqual([card.occurrence, card.event_type, card.start_time], [null, 'youth', '18:00']);

  // That Sunday's 6pm Liturgy with its saint, by any name, is the Liturgy.
  const g = fresh({ role: 'editor' });
  const sid2 = addEnglishLiturgy(g.raw);
  const liturgy = (await readAt(g, DOONSIDE, MOVIE_NIGHT({ title: 'English Divine Liturgy', feast: 'Apostle Philip',
    after: '', event_type: 'feast' }))).cards[0];
  assert.equal(liturgy.occurrence, `${sid2}:2030-12-22`);
  assert.deepEqual([liturgy.title, liturgy.event_type, liturgy.feast], ['English Divine Liturgy', 'liturgy', 'Apostle Philip']);

  // And a youth night on a youth group's evening is that evening's.
  const yg = f.raw.prepare(`INSERT INTO schedules (parish_id, day_of_week, start_time, title, event_type)
    VALUES (?, 5, '19:00', 'Youth Group', 'youth') RETURNING id`).get(DOONSIDE).id;
  const read = matchOccurrences({ events: [
    { title: 'Great Vespers', date: '2030-11-22', start_time: '19:00', event_type: 'prayer' },
    { title: 'Games Night', date: '2030-11-22', start_time: '19:00', event_type: 'social' },
    { title: 'Youth Group', date: '2030-11-29', start_time: '19:00', event_type: 'prayer' },
  ] }, [{ id: sid, parish_id: DOONSIDE, day_of_week: 0, start_time: '18:00', title: 'Liturgy', event_type: 'liturgy', active: 1,
    week_of_month: 'second,fourth' }, { id: yg, parish_id: DOONSIDE, day_of_week: 5, start_time: '19:00', title: 'Youth Group',
    event_type: 'youth', active: 1 }]);
  assert.deepEqual(read.events.map(e => e.occurrence), [null, `${yg}:2030-11-22`, `${yg}:2030-11-29`],
    'Vespers at its time is not; a social at its time is; its own name is, whatever the kind');
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

test('a card\'s bin is kept as yes, no or untapped, and the draft goes with its marked cards once the rest is published', async () => {
  const f = fresh({ role: 'editor' }, { key: null });
  const [a] = parishes(f.raw);
  const d = (await f.call('POST', '/api/admin/drafts', { parish_id: a, card: { title: 'Keep', date: '2026-11-14', start_time: '10:00' } })).body;
  assert.equal(d.cards[0].discard, null, 'nobody has tapped it');
  const gone = (await f.call('POST', `/api/admin/drafts/${d.id}/events`, { title: 'Gone', date: '2026-11-01', start_time: '07:30', discard: true })).body;
  assert.equal(gone.discard, 1);
  assert.equal((await f.call('PATCH', `/api/admin/draft-events/${gone.id}`, { discard: 'yes' })).status, 400);
  assert.equal((await f.call('PATCH', `/api/admin/draft-events/${gone.id}`, { discard: false })).body.discard, 0, 'kept');
  assert.equal((await f.call('PATCH', `/api/admin/draft-events/${gone.id}`, { discard: 1 })).body.discard, 1, 'marked again');
  // The editor publishes the rest, then discards the draft and the marked card with it.
  assert.equal((await f.call('POST', `/api/admin/draft-events/${d.cards[0].id}/publish`, {})).status, 201);
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM drafts WHERE id = ?').get(d.id).n, 1, 'the marked card still holds the draft');
  assert.equal((await f.call('DELETE', `/api/admin/drafts/${d.id}`)).status, 200);
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM draft_events').get().n, 0);
  assert.equal(f.raw.prepare("SELECT COUNT(*) n FROM events WHERE title = 'Gone'").get().n, 0, 'never published');
});

test('a database made before 020 gets the sign and programme columns (and 022’s last day, 023’s place) on first use', async () => {
  const raw = new Database(':memory:');
  raw.exec('CREATE TABLE parishes (id TEXT PRIMARY KEY)');
  raw.exec(fs.readFileSync('d1/migrations/018-drafts.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/migrations/019-draft-read-parish.sql', 'utf8'));
  const cols = (t) => raw.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
  assert.ok(!cols('drafts').includes('read_services') && !cols('draft_events').includes('occurrence'));
  await ensureDraftTables(new D1(raw));
  assert.deepEqual(cols('drafts').slice(-4), ['read_parish', 'read_language', 'read_services', 'read_details']);
  assert.deepEqual(cols('draft_events').slice(-10), ['occurrence', 'feast', 'end_date', 'location_parish_id', 'location_lat', 'location_lng', 'parish_scoped', 'discard',
    'host_parish_id', 'host_event_id']);
  const types = Object.fromEntries(raw.prepare('PRAGMA table_info(draft_events)').all().map(c => [c.name, c.type]));
  assert.deepEqual([types.location_lat, types.location_lng, types.end_date, types.parish_scoped, types.discard, types.host_parish_id, types.host_event_id],
    ['REAL', 'REAL', 'TEXT', 'INTEGER', 'INTEGER', 'TEXT', 'INTEGER'],
    'a pin is a number, and so are the pill, the bin and an event on file');
});

// ── an event at another parish: theirs, with this parish taking part ──
//
// St Andrew, Gladesville's November programme listed St Nectarios, Burwood's
// feast "at St Nectarios Church, Burwood". Read at Gladesville it was
// Gladesville's own event at a place of that name, and was moved to Burwood by
// hand (Kevin, 3 Nov 2026). (2030, so no date has passed whenever this runs.)

const SAG = 'greek-standrew-gladesville';
const SBU = 'greek-stnectarios-burwood';

function addGladesvilleBurwood(raw) {
  const parish = raw.prepare(`INSERT INTO parishes (id, name, jurisdiction, address, lat, lng, timezone)
    VALUES (?, ?, 'greek', ?, ?, ?, 'Australia/Sydney')`);
  parish.run(SAG, 'St Andrew, Gladesville', '20 Wharf Rd Gladesville, NSW, 2111', -33.8348, 151.1265);
  parish.run(SBU, 'St Nectarios, Burwood', '26 Railway Parade Burwood NSW 2134', -33.8777, 151.1045);
  const rule = (pid, day, start, end, title, type) => raw.prepare(
    `INSERT INTO schedules (parish_id, day_of_week, start_time, end_time, title, event_type)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`).get(pid, day, start, end, title, type).id;
  return {
    sagSunday: rule(SAG, 0, '07:30', '10:30', 'Matins and Liturgy', 'liturgy'),
    sbuSeniors: rule(SBU, 4, '10:00', '12:00', "Seniors' Group", 'social'),
  };
}

/** One of Burwood's own events, as Kevin's SQL left the 9 Nov feast: Burwood's, Gladesville taking part. */
function burwoodFeast(raw, { at = '2030-11-08T20:00:00.000Z', title = 'Feast of St Nectarios' } = {}) {
  return raw.prepare(`INSERT INTO events (parish_id, source_adapter, title, start_utc, end_utc, event_type, status, mutation_type)
    VALUES (?, 'manual', ?, ?, '2030-11-08T23:30:00.000Z', 'feast', 'approved', 'headless') RETURNING id`).get(SBU, title, at).id;
}

const GLADESVILLE_NOV = (events) => ({
  kind: 'poster', written_in: 'English', other_parish: null, notes: [], services: [],
  details: { address: '', phone: '', email: '', website: '' },
  events: events.map(e => ({ feast: '', weekday_printed: null, year_printed: true, end_time: null, end_date: '',
    languages: [], description: null, notes: [], ...e })),
});
const FEAST_AT_BURWOOD = { title: 'Feast of St Nectarios', date: '2030-11-09', weekday_printed: 'Saturday',
  start_time: '07:30', end_time: '10:30', event_type: 'feast', venue: 'St Nectarios Church, Burwood' };

test('an event the poster puts at another parish on file is theirs: the one already there is joined, nothing new made', async () => {
  const f = fresh({ role: 'editor' });
  addGladesvilleBurwood(f.raw);
  const feast = burwoodFeast(f.raw);
  // Somebody else already takes part: joining must not take them off.
  f.raw.prepare('INSERT INTO event_parishes (event_id, parish_id) VALUES (?, ?)').run(feast, ELIAS);

  const read = await readAt(f, SAG, GLADESVILLE_NOV([FEAST_AT_BURWOOD]));
  const card = read.cards[0];
  assert.deepEqual([card.host_parish_id, card.host_event_id], [SBU, feast]);
  assert.equal(card.location_override, null, 'the venue named their church: it is theirs, not a place of its own');
  assert.ok(card.read_notes.some(n => n.field === 'host_parish_id' && /St Nectarios Church, Burwood/.test(n.text)));
  assert.ok(card.read_notes.some(n => n.field === 'replaces' && /^Check replaced services/.test(n.text)),
    'what it replaces at Gladesville is asked about');
  assert.deepEqual(card.replaces, [], 'nothing of Gladesville’s on a Saturday morning to tick');
  assert.deepEqual(card.languages, [], 'no language guessed for another parish’s service');

  const count = () => f.raw.prepare('SELECT COUNT(*) n FROM events').get().n;
  const before = count();
  const r = await f.call('POST', `/api/admin/draft-events/${card.id}/publish`, {});
  assert.equal(r.status, 201);
  assert.equal(r.body.joined, true);
  assert.equal(r.body.event.id, feast);
  assert.deepEqual(r.body.event.additional_parishes.sort(), [ELIAS, SAG].sort());
  assert.equal(count(), before, 'nothing new');
  assert.deepEqual(f.raw.prepare('SELECT title, start_utc, poster_path FROM events WHERE id = ?').get(feast),
    { title: 'Feast of St Nectarios', start_utc: '2030-11-08T20:00:00.000Z', poster_path: null },
    'Burwood’s event stays as Burwood has it');
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM drafts WHERE id = ?').get(read.id).n, 0, 'the card took its draft with it');
  assert.ok(f.bucket.deleted.includes(read.poster_path.slice(1)), 'and the poster, which nothing published carries');
});

test('not on file there yet, it is added THERE, with this parish taking part and the poster on it', async () => {
  const f = fresh({ role: 'editor' });
  addGladesvilleBurwood(f.raw);
  const read = await readAt(f, SAG, GLADESVILLE_NOV([{ ...FEAST_AT_BURWOOD, title: 'Great Vespers', feast: 'St Nectarios',
    date: '2030-11-08', weekday_printed: 'Friday', start_time: '19:00', end_time: '21:00', event_type: 'prayer',
    languages: ['Greek'], venue: 'St Nectarios Greek Orthodox Church, 26 Railway Parade, Burwood NSW 2134' }]));
  const card = read.cards[0];
  assert.deepEqual([card.host_parish_id, card.host_event_id], [SBU, null]);
  const r = await f.call('POST', `/api/admin/draft-events/${card.id}/publish`, {});
  assert.equal(r.status, 201);
  const ev = r.body.event;
  assert.deepEqual([ev.parish_id, ev.title, ev.feast, ev.start_utc, ev.location_override, ev.location_parish_id],
    [SBU, 'Great Vespers', 'St Nectarios', '2030-11-08T08:00:00.000Z', null, null], 'at their own church, on their clock');
  assert.deepEqual(ev.additional_parishes, [SAG]);
  assert.equal(ev.poster_path, read.poster_path);
});

test('this parish’s own service at that time is ticked as replaced, and so is theirs that it is', async () => {
  const f = fresh({ role: 'owner' });
  const { sagSunday } = addGladesvilleBurwood(f.raw);
  const sbuSunday = f.raw.prepare(`INSERT INTO schedules (parish_id, day_of_week, start_time, end_time, title, event_type)
    VALUES (?, 0, '07:30', '11:00', 'Matins and Divine Liturgy', 'liturgy') RETURNING id`).get(SBU).id;
  const read = await readAt(f, SAG, GLADESVILLE_NOV([{ title: 'Matins and Divine Liturgy', feast: 'Sunday after St Nectarios',
    date: '2030-11-10', weekday_printed: 'Sunday', start_time: '07:30', end_time: '11:00', event_type: 'liturgy',
    languages: ['Greek', 'English'], venue: 'St Nectarios, Burwood' }]));
  const card = read.cards[0];
  assert.equal(card.occurrence, null, 'not Gladesville’s own Sunday with a venue');
  assert.deepEqual(card.replaces, [`${sbuSunday}:2030-11-10`, `${sagSunday}:2030-11-10`]);
  assert.ok(card.read_notes.some(n => /Gladesville’s own 7:30am Matins and Liturgy/.test(n.text)));
  assert.ok(!card.read_notes.some(n => /^Check replaced services/.test(n.text)), 'ticked says it instead');

  const r = await f.call('POST', `/api/admin/draft-events/${card.id}/publish`, {});
  assert.equal(r.status, 201);
  const ov = (sid) => f.raw.prepare('SELECT kind, combined_into_event_id FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?')
    .get(sid, '2030-11-10');
  assert.deepEqual(ov(sagSunday), { kind: 'combined', combined_into_event_id: r.body.event.id }, 'Gladesville’s Sunday points at it');
  assert.deepEqual(ov(sbuSunday), { kind: 'combined', combined_into_event_id: r.body.event.id }, 'and it is shown once at Burwood');
});

test('ticking or saying nothing is replaced answers the prompt', async () => {
  const f = fresh({ role: 'editor' });
  addGladesvilleBurwood(f.raw);
  const read = await readAt(f, SAG, GLADESVILLE_NOV([FEAST_AT_BURWOOD]));
  const r = await f.call('PATCH', `/api/admin/draft-events/${read.cards[0].id}`, { replaces: null });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.read_notes.filter(n => n.field === 'replaces'), []);
  assert.equal(r.body.host_parish_id, SBU, 'still theirs');
});

test('a parish contact joins another parish’s event as their own, and cannot add one there', async () => {
  const f = fresh({ role: 'parish', parishIds: [SAG] });
  addGladesvilleBurwood(f.raw);
  const feast = burwoodFeast(f.raw);
  const join = await readAt(f, SAG, GLADESVILLE_NOV([FEAST_AT_BURWOOD]));
  // Another parish ticked as well is not theirs to add: an ask, as any combine.
  await f.call('PATCH', `/api/admin/draft-events/${join.cards[0].id}`, { also_at: [ELIAS] });
  const no = await f.call('POST', `/api/admin/draft-events/${join.cards[0].id}/publish`, {});
  assert.equal(no.status, 403);
  assert.equal(no.body.proposable, true);
  const yes = await f.call('POST', `/api/admin/draft-events/${join.cards[0].id}/publish`, { propose: 'Deanery feast' });
  assert.equal(yes.status, 201);
  assert.deepEqual(yes.body.event.additional_parishes, [SAG], 'their own half now');
  const ask = f.raw.prepare('SELECT payload FROM admin_proposals WHERE id = ?').get(yes.body.proposal_id);
  assert.deepEqual(JSON.parse(ask.payload).additive_parish_ids.sort(), [ELIAS, SAG].sort(), 'the whole state, for the owner');

  f.raw.prepare('DELETE FROM events WHERE id = ?').run(feast);
  const make = await readAt(f, SAG, GLADESVILLE_NOV([FEAST_AT_BURWOOD]));
  assert.equal(make.cards[0].host_event_id, null);
  await f.call('PATCH', `/api/admin/draft-events/${make.cards[0].id}`, { languages: ['Greek'] });
  const refused = await f.call('POST', `/api/admin/draft-events/${make.cards[0].id}/publish`, {});
  assert.equal(refused.status, 403);
  assert.match(refused.body.error, /St Nectarios, Burwood is not one of your parishes/);
});

test('an event that has gone from their parish is said so, not joined', async () => {
  const f = fresh({ role: 'editor' });
  addGladesvilleBurwood(f.raw);
  const feast = burwoodFeast(f.raw);
  const read = await readAt(f, SAG, GLADESVILLE_NOV([FEAST_AT_BURWOOD]));
  f.raw.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(feast);
  const r = await f.call('POST', `/api/admin/draft-events/${read.cards[0].id}/publish`, {});
  assert.equal(r.status, 400);
  assert.equal(r.body.gone, true);
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM event_parishes WHERE event_id = ?').get(feast).n, 0);
});

test('the whole poster being theirs is a move, not taking part; and moving there makes it theirs outright', async () => {
  const f = fresh({ role: 'editor' });
  addGladesvilleBurwood(f.raw);
  const theirs = await readAt(f, SAG, { ...GLADESVILLE_NOV([FEAST_AT_BURWOOD]),
    other_parish: { name: 'Holy Church of St Nectarios', place: 'Burwood' } });
  assert.equal(theirs.read_parish.parish_id, SBU);
  assert.equal(theirs.cards[0].host_parish_id, null, 'Gladesville takes no part in Burwood’s own poster');

  const ours = await readAt(f, SAG, GLADESVILLE_NOV([FEAST_AT_BURWOOD]));
  assert.equal(ours.cards[0].host_parish_id, SBU);
  const moved = (await f.call('PATCH', `/api/admin/drafts/${ours.id}`, { parish_id: SBU })).body;
  assert.deepEqual([moved.cards[0].host_parish_id, moved.cards[0].host_event_id], [null, null]);
});

// ── an event at this parish's own church, already on file ──
//
// Burwood's own November poster gives its 9 Nov feast, which Burwood already
// has on file (put up by hand, or published from an earlier read). Read at
// Burwood it was a second feast beside the first (Kevin, 3 Nov 2026).

const BURWOOD_NOV = (events) => GLADESVILLE_NOV(events.map(({ venue, ...e }) => e));

test('a poster’s event this parish already has on file is that one: filled in on Publish, not made twice', async () => {
  const f = fresh({ role: 'editor' });
  addGladesvilleBurwood(f.raw);
  const feast = burwoodFeast(f.raw);
  // As printed: "at St Nectarios Church, Burwood" — its own church, so at home.
  const read = await readAt(f, SBU, GLADESVILLE_NOV([{ ...FEAST_AT_BURWOOD, start_time: '07:00', feast: 'St Nectarios of Aegina',
    description: 'Hierarchical Divine Liturgy, then lunch in the hall.' }]));
  const card = read.cards[0];
  assert.deepEqual([card.host_parish_id, card.host_event_id], [SBU, feast], 'its own, on file');
  assert.equal(card.location_override, null, 'its own church by name is home, not a place of its own');
  assert.ok(card.read_notes.some(n => n.field === 'host_event_id' && /Already on file here: 7:00am Feast of St Nectarios/.test(n.text)));
  assert.ok(!card.read_notes.some(n => n.field === 'replaces'), 'nothing to ask about what it replaces');

  const count = () => f.raw.prepare('SELECT COUNT(*) n FROM events').get().n;
  const before = count();
  const r = await f.call('POST', `/api/admin/draft-events/${card.id}/publish`, {});
  assert.equal(r.status, 201);
  assert.equal(r.body.on_file, true);
  assert.equal(count(), before, 'nothing new');
  assert.deepEqual(f.raw.prepare('SELECT title, start_utc, end_utc, feast, description, poster_path FROM events WHERE id = ?').get(feast), {
    title: 'Feast of St Nectarios', start_utc: '2030-11-08T20:00:00.000Z', end_utc: '2030-11-08T23:30:00.000Z',
    feast: 'St Nectarios of Aegina', description: 'Hierarchical Divine Liturgy, then lunch in the hall.',
    poster_path: read.poster_path,
  }, 'the poster and what it was missing; its title and times as they were');
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM event_parishes WHERE event_id = ?').get(feast).n, 0, 'nobody set as taking part');
  assert.equal(f.raw.prepare('SELECT COUNT(*) n FROM drafts WHERE id = ?').get(read.id).n, 0);
  assert.deepEqual(f.bucket.deleted, [], 'the poster is on the event now');
});

test('on file at another time, the card says so and Publish keeps the time on file; what it has stays', async () => {
  const f = fresh({ role: 'editor' });
  addGladesvilleBurwood(f.raw);
  const feast = burwoodFeast(f.raw);
  f.raw.prepare("UPDATE events SET poster_path = '/posters/old.png', description = 'As put up by hand.' WHERE id = ?").run(feast);
  const read = await readAt(f, SBU, BURWOOD_NOV([{ ...FEAST_AT_BURWOOD, description: 'From the poster.' }]));
  const card = read.cards[0];
  assert.equal(card.host_event_id, feast, 'the same feast, at 7:30 rather than 7:00');
  assert.ok(card.read_notes.some(n => n.field === 'host_event_id'
    && /poster has it at 7:30am\. Publishing keeps 7:00am/.test(n.text)));
  const r = await f.call('POST', `/api/admin/draft-events/${card.id}/publish`, {});
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.filled, []);
  assert.deepEqual(f.raw.prepare('SELECT start_utc, description, poster_path FROM events WHERE id = ?').get(feast),
    { start_utc: '2030-11-08T20:00:00.000Z', description: 'As put up by hand.', poster_path: '/posters/old.png' });
  assert.ok(f.bucket.deleted.includes(read.poster_path.slice(1)), 'the new poster, which nothing carries, goes');
});

test('something else that day is not it, and "not that one" makes it the parish’s own new event', async () => {
  const f = fresh({ role: 'editor' });
  addGladesvilleBurwood(f.raw);
  burwoodFeast(f.raw, { title: 'Parish Fete' });
  const other = await readAt(f, SBU, BURWOOD_NOV([{ ...FEAST_AT_BURWOOD, start_time: '18:00', end_time: '20:00',
    title: 'Youth Night', event_type: 'youth' }]));
  assert.equal(other.cards[0].host_event_id, null, 'a different event, not the fete');

  const feast = burwoodFeast(f.raw);
  const read = await readAt(f, SBU, BURWOOD_NOV([FEAST_AT_BURWOOD]));
  const card = read.cards[0];
  assert.equal(card.host_event_id, feast);
  const r = await f.call('PATCH', `/api/admin/draft-events/${card.id}`, { host_parish_id: null, host_event_id: null, languages: ['Greek'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.read_notes.filter(n => n.field === 'host_event_id'), []);
  const made = await f.call('POST', `/api/admin/draft-events/${card.id}/publish`, {});
  assert.equal(made.status, 201);
  assert.notEqual(made.body.event.id, feast);
  assert.equal(made.body.event.parish_id, SBU);
});

test('gone since the read: said so, not filled in', async () => {
  const f = fresh({ role: 'editor' });
  addGladesvilleBurwood(f.raw);
  const feast = burwoodFeast(f.raw);
  const read = await readAt(f, SBU, BURWOOD_NOV([FEAST_AT_BURWOOD]));
  f.raw.prepare("UPDATE events SET status = 'cancelled' WHERE id = ?").run(feast);
  const r = await f.call('POST', `/api/admin/draft-events/${read.cards[0].id}/publish`, {});
  assert.equal(r.status, 400);
  assert.equal(r.body.gone, true);
  assert.equal(f.raw.prepare('SELECT poster_path FROM events WHERE id = ?').get(feast).poster_path, null);
});

test('moving a draft: the old parish’s event on file goes, and another parish’s it joined is its own on file', async () => {
  const f = fresh({ role: 'editor' });
  addGladesvilleBurwood(f.raw);
  const feast = burwoodFeast(f.raw);
  const own = await readAt(f, SBU, BURWOOD_NOV([FEAST_AT_BURWOOD]));
  const away = (await f.call('PATCH', `/api/admin/drafts/${own.id}`, { parish_id: SAG })).body;
  assert.deepEqual([away.cards[0].host_parish_id, away.cards[0].host_event_id], [null, null], 'found at Burwood, not Gladesville');

  const joined = await readAt(f, SAG, GLADESVILLE_NOV([FEAST_AT_BURWOOD]));
  const there = (await f.call('PATCH', `/api/admin/drafts/${joined.id}`, { parish_id: SBU })).body;
  assert.deepEqual([there.cards[0].host_parish_id, there.cards[0].host_event_id], [SBU, feast]);
  const r = await f.call('POST', `/api/admin/draft-events/${there.cards[0].id}/publish`, {});
  assert.equal(r.status, 201);
  assert.equal(r.body.on_file, true, 'filled in, not joined by its own parish');
});
