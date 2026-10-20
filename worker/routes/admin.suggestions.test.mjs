// "Suggest edits" — a signed-in stranger telling whoever keeps a parish what
// is wrong or what is coming up, and the people who may edit it acting on
// that. Through the real Router, because sending one must work for somebody
// `guarded` refuses, and reading them must stop at the parishes you may edit.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Router } from '../lib/router.mjs';
import { registerAdminRoutes } from './admin.mjs';
import { validateSuggestion, describeSuggestion, cardFromSuggestion, formFromRead, SUGGESTIONS_DDL, OPEN_LIMIT,
  POSTER_DAILY_LIMIT } from '../lib/suggestions.mjs';
import { isDataWrite } from '../lib/data-version.mjs';
import { haikuStream, fakeFetch } from '../lib/test-fakes.mjs';

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
  _runSync() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: r.changes } }; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async first() { const r = this.db.prepare(this.sql).get(...this.args); return r === undefined ? null : r; }
  async run() { return this._runSync(); }
}

const PARISH = 'antiochian-stgeorge-redfern';
const OTHER = 'antiochian-good-shepherd-antiochian-church';

/** R2, enough for a poster: put, get, delete — and what was deleted. */
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

/**
 * `roles`: rows for admin_roles. The dev bypass signs in as 'dev'.
 * `posters`: an R2 bucket, and a key for the reader unless `key` is false.
 */
function fresh(roles = [], { posters = false, key = 'test-key' } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-suggest-')), 'x.db');
  const raw = new Database(file);
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  for (const r of roles) {
    raw.prepare('INSERT INTO admin_roles (email, role, parish_ids) VALUES (?,?,?)')
      .run(r.email, r.role, r.parishIds ? JSON.stringify(r.parishIds) : null);
  }
  const router = new Router();
  registerAdminRoutes(router);
  const env = { DB: new D1(raw), AGORA_DEV_ADMIN: 'true' };
  const b = posters ? bucket() : null;
  if (b) env.ASSETS_BUCKET = b;
  if (posters && key) env.ANTHROPIC_API_KEY = key;
  const send = async (method, url, init) => {
    const res = await router.handle(new Request(`https://orthodoxy.au${url}`, { method, ...init }), env, {});
    assert.ok(res, `no route matched ${method} ${url}`);
    let parsed = null;
    try { parsed = await res.clone().json(); } catch { /* not json */ }
    return { status: res.status, body: parsed };
  };
  const call = (method, url, body) => send(method, url, body === undefined ? {} : {
    body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
  });
  /** Add a poster to a suggestion form at `parish`. */
  const poster = (parish = PARISH, bytes = jpeg(), type = 'image/jpeg', { note = '' } = {}) =>
    send('POST', `/api/admin/suggestions/poster?parish=${encodeURIComponent(parish)}${note ? `&note=${encodeURIComponent(note)}` : ''}`, {
      body: bytes, headers: { 'Content-Type': type },
    });
  return { raw, call, poster, bucket: b };
}

const jpeg = () => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9, 9, 9]);

/** Run `fn` with a fake global fetch — the poster reader's — and restore it after. */
async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

/** What Claude answers for a flyer with two events, as the Messages API streams it. */
const TWO = JSON.stringify({
  kind: 'poster', written_in: 'Greek', other_parish: null, services: [], details: null, notes: [],
  events: [
    { title: 'Youth Night', feast: '', date: '2026-11-14', weekday_printed: 'Saturday', year_printed: false,
      start_time: '19:00', end_time: null, end_date: null, event_type: 'youth', languages: [], venue: 'Church hall',
      description: 'Bring a plate.', notes: [] },
    { title: 'Talk on prayer', feast: '', date: '2026-11-21', weekday_printed: 'Saturday', year_printed: false,
      start_time: '18:30', end_time: '20:00', end_date: null, event_type: 'talk', languages: [], venue: null,
      description: null, notes: [] },
  ],
});

/** Somebody with no role adds a poster, has it read, and sends the event with it. */
async function sentWithPoster(t) {
  const up = await withFetch(fakeFetch(haikuStream(TWO)), () => t.poster());
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const sent = await t.call('POST', '/api/admin/suggestions', {
    parish_id: PARISH, kind: 'event', ...up.body.events[0], poster_path: up.body.poster_path,
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  return { path: up.body.poster_path, key: up.body.poster_path.slice(1), id: sent.body.id };
}

const insert = (raw, s) => raw.prepare(
  `INSERT INTO parish_suggestions (parish_id, email, name, kind, about, body, title, date, start_time, end_time, place, link)
   VALUES (@parish_id, @email, @name, @kind, @about, @body, @title, @date, @start_time, @end_time, @place, @link)`
).run({ email: 'reader@example.org', name: null, about: null, body: null, title: null, date: null,
  start_time: null, end_time: null, place: null, link: null, ...s }).lastInsertRowid;

test('somebody signed in with no role can suggest a change and an event, and sees them back', async () => {
  const { raw, call } = fresh([{ email: 'boss@example.org', role: 'owner' }]);
  assert.equal((await call('GET', '/api/admin/ping')).status, 403, 'no role is still refused the panel');

  const change = await call('POST', '/api/admin/suggestions', {
    parish_id: PARISH, kind: 'change', about: 'Sunday 9:00 Divine Liturgy',
    body: 'It starts at 9:30 now.', email: 'someone-else@example.org',
  });
  assert.equal(change.status, 201, JSON.stringify(change.body));
  const row = raw.prepare('SELECT * FROM parish_suggestions WHERE id = ?').get(change.body.id);
  assert.equal(row.email, 'dev', 'the email is the signed-in one, never the one in the body');
  assert.equal(row.status, 'open');
  assert.equal(row.about, 'Sunday 9:00 Divine Liturgy');

  const event = await call('POST', '/api/admin/suggestions', {
    parish_id: PARISH, kind: 'event', name: 'Maria', title: 'Youth night', date: '2026-11-14',
    start_time: '19:00', place: 'The church hall', body: 'Pizza after.',
  });
  assert.equal(event.status, 201, JSON.stringify(event.body));

  const me = await call('GET', '/api/admin/whoami');
  assert.deepEqual(me.body.suggestions.map(s => s.kind), ['event', 'change'], 'newest first');
  assert.equal(me.body.suggestions[0].parish_name, 'St George Cathedral, Redfern');

  assert.equal((await call('POST', `/api/admin/suggestions/${change.body.id}/withdraw`)).status, 200);
  assert.equal(raw.prepare('SELECT status FROM parish_suggestions WHERE id = ?').get(change.body.id).status, 'withdrawn');
  assert.equal((await call('POST', `/api/admin/suggestions/${change.body.id}/withdraw`)).status, 404, 'once');
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM parish_claims').get().n, 0, 'a suggestion is not a claim');
});

test('a suggestion is refused when it cannot mean anything', async () => {
  const { call } = fresh([{ email: 'boss@example.org', role: 'owner' }]);
  const post = (b) => call('POST', '/api/admin/suggestions', { parish_id: PARISH, ...b });
  assert.equal((await post({ kind: 'change' })).body.field, 'body', 'a change says what should change');
  assert.equal((await post({ kind: 'nonsense', body: 'x' })).body.field, 'kind');
  assert.equal((await post({ kind: 'event', date: '2026-11-14' })).body.field, 'title');
  assert.equal((await post({ kind: 'event', title: 'Talk' })).body.field, 'date');
  assert.equal((await post({ kind: 'event', title: 'Talk', date: '2026-02-30' })).body.field, 'date');
  assert.equal((await post({ kind: 'event', title: 'Talk', date: '2026-11-14', start_time: '7pm' })).body.field, 'start_time');
  assert.equal((await post({ kind: 'change', body: 'x', link: 'javascript:alert(1)' })).body.field, 'link');
  assert.equal((await call('POST', '/api/admin/suggestions', { parish_id: 'nowhere', kind: 'change', body: 'x' })).status, 404);

  const contact = fresh([{ email: 'boss@example.org', role: 'owner' }, { email: 'dev', role: 'parish', parishIds: [PARISH] }]);
  const r = await contact.call('POST', '/api/admin/suggestions', { parish_id: PARISH, kind: 'change', body: 'x' });
  assert.equal(r.status, 409, 'somebody who may edit it has the pencil');
  assert.equal(r.body.covered, true);
  assert.equal((await contact.call('POST', '/api/admin/suggestions', { parish_id: OTHER, kind: 'change', body: 'x' })).status, 201,
    'a contact can still suggest at a parish that is not theirs');
});

test('one address has a ceiling on what it can leave waiting', async () => {
  const { raw, call } = fresh([{ email: 'boss@example.org', role: 'owner' }]);
  for (let i = 0; i < OPEN_LIMIT; i++) insert(raw, { parish_id: PARISH, email: 'DEV', kind: 'change', body: `#${i}` });
  const r = await call('POST', '/api/admin/suggestions', { parish_id: OTHER, kind: 'change', body: 'one more' });
  assert.equal(r.status, 429);
  raw.prepare("UPDATE parish_suggestions SET status = 'done' WHERE id = 1").run();
  assert.equal((await call('POST', '/api/admin/suggestions', { parish_id: OTHER, kind: 'change', body: 'one more' })).status, 201,
    'room again once one has been looked at');
});

test('a contact hears about their own parishes, and only theirs', async () => {
  const { raw, call } = fresh([
    { email: 'boss@example.org', role: 'owner' },
    { email: 'dev', role: 'parish', parishIds: [PARISH] },
  ]);
  const mine = insert(raw, { parish_id: PARISH, kind: 'change', name: 'Maria', about: 'Saturday Vespers', body: 'Moved to 5pm' });
  const theirs = insert(raw, { parish_id: OTHER, kind: 'change', body: 'Wrong phone number' });

  assert.equal((await call('GET', '/api/admin/ping')).body.suggestions, 1, 'the dot counts what a contact can act on');
  const list = await call('GET', '/api/admin/suggestions');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map(s => s.id), [Number(mine)]);
  assert.equal(list.body[0].summary, 'Maria suggests a change at St George Cathedral, Redfern — Saturday Vespers.');

  assert.equal((await call('POST', `/api/admin/suggestions/${theirs}/decide`, { decision: 'done' })).status, 403);
  assert.equal((await call('POST', `/api/admin/suggestions/${mine}/decide`, { decision: 'maybe' })).status, 400);
  const done = await call('POST', `/api/admin/suggestions/${mine}/decide`, { decision: 'done', note: 'Fixed, thanks' });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  const row = raw.prepare('SELECT * FROM parish_suggestions WHERE id = ?').get(mine);
  assert.equal(row.status, 'done');
  assert.equal(row.decided_by, 'dev');
  assert.equal(row.decision_note, 'Fixed, thanks');
  assert.equal((await call('POST', `/api/admin/suggestions/${mine}/decide`, { decision: 'dismiss' })).status, 409, 'decided once');
  assert.equal((await call('GET', '/api/admin/ping')).body.suggestions, 0);
});

test('an owner hears about every parish, and nobody without a role reads any', async () => {
  const owner = fresh([{ email: 'dev', role: 'owner' }]);
  insert(owner.raw, { parish_id: PARISH, kind: 'change', body: 'a' });
  insert(owner.raw, { parish_id: OTHER, kind: 'change', body: 'b' });
  assert.equal((await owner.call('GET', '/api/admin/suggestions')).body.length, 2);
  assert.equal((await owner.call('GET', '/api/admin/ping')).body.suggestions, 2);
  assert.equal((await owner.call('GET', '/api/admin/ping')).body.openAsks, 0, 'a suggestion is not an ask');

  const nobody = fresh([{ email: 'boss@example.org', role: 'owner' }]);
  assert.equal((await nobody.call('GET', '/api/admin/suggestions')).status, 403);
});

test('a suggested event becomes a draft at the parish, in its own wall clock', async () => {
  const { raw, call } = fresh([{ email: 'dev', role: 'editor' }]);
  const id = insert(raw, {
    parish_id: PARISH, kind: 'event', title: 'Youth night', date: '2026-11-14', start_time: '19:00',
    end_time: '21:00', place: 'The church hall', body: 'Pizza after.', link: 'https://example.org/youth',
  });
  const events = () => raw.prepare('SELECT COUNT(*) AS n FROM events').get().n;
  const before = events();
  const r = await call('POST', `/api/admin/suggestions/${id}/draft`);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.parish_id, PARISH);
  const [card] = r.body.cards;
  assert.equal(card.title, 'Youth night');
  assert.equal(card.date, '2026-11-14');
  assert.equal(card.start_time, '19:00', 'local, as the person typed it — publishing converts it');
  assert.equal(card.end_time, '21:00');
  assert.equal(card.location_override, 'The church hall');
  assert.equal(card.description, 'Pizza after.\n\nhttps://example.org/youth');

  const row = raw.prepare('SELECT * FROM parish_suggestions WHERE id = ?').get(id);
  assert.equal(row.status, 'done');
  assert.equal(row.draft_id, r.body.id);
  assert.equal(events(), before, 'a draft, not an event — nothing is published');
  assert.equal((await call('POST', `/api/admin/suggestions/${id}/draft`)).status, 409, 'once');

  const change = insert(raw, { parish_id: PARISH, kind: 'change', body: 'x' });
  assert.equal((await call('POST', `/api/admin/suggestions/${change}/draft`)).status, 400);
});

test('a suggestion moves no public data version', () => {
  const ok = new Response('{}', { status: 201 });
  const w = (p) => isDataWrite(new Request(`https://orthodoxy.au${p}`, { method: 'POST' }), ok);
  assert.equal(w('/api/admin/suggestions'), false);
  assert.equal(w('/api/admin/suggestions/poster'), false, 'nor does a poster added to one');
  assert.equal(w('/api/admin/suggestions/3/decide'), false);
  assert.equal(w('/api/admin/suggestions/3/draft'), false);
  assert.equal(w('/api/admin/claims'), true, 'a claim approved can write the parish');
});

test('a suggestion before migration 024 is applied makes the table rather than failing', async () => {
  const { raw, call } = fresh([{ email: 'boss@example.org', role: 'owner' }]);
  raw.exec('DROP TABLE parish_suggestions');
  assert.equal((await call('GET', '/api/admin/whoami')).status, 200, 'reading without the table is fine');
  const r = await call('POST', '/api/admin/suggestions', { parish_id: PARISH, kind: 'change', body: 'x' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM parish_suggestions').get().n, 1);
});

test('the first-use DDL builds the same table as the baseline', () => {
  const base = new Database(':memory:');
  base.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  const lazy = new Database(':memory:');
  lazy.exec('CREATE TABLE parishes (id TEXT PRIMARY KEY)');
  for (const sql of SUGGESTIONS_DDL) lazy.exec(sql);
  for (const table of ['parish_suggestions', 'suggestion_posters']) {
    const cols = (db) => db.prepare(`PRAGMA table_info(${table})`).all();
    assert.deepEqual(cols(lazy), cols(base), table);
    const idx = (db) => db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name").all(table);
    assert.deepEqual(idx(lazy).map(i => i.name), idx(base).map(i => i.name), table);
    assert.ok(idx(base).length, `${table} has its indexes`);
  }
});

test('what a suggestion says, and what it becomes', () => {
  assert.equal(validateSuggestion({ parish_id: 'p', kind: 'change', body: 'x'.repeat(5000) }).suggestion.body.length, 2000);
  assert.equal(validateSuggestion({ parish_id: 'p', kind: 'change', body: 'x', title: 'ignored' }).suggestion.title, null,
    'a change carries no event fields');
  assert.equal(describeSuggestion({ kind: 'event', parish_id: 'p', title: 'Talk', date: '2026-11-14', start_time: '19:00' }, 'St X'),
    'Somebody suggests an event at St X: Talk, 2026-11-14 19:00.');
  assert.deepEqual(cardFromSuggestion({ title: 'Talk', date: '2026-11-14', body: null, link: null }),
    { title: 'Talk', date: '2026-11-14', description: null });
});

// ── a poster on a suggested event ──

test('a poster added to a suggested event is read into the form, and goes with it', async () => {
  const t = fresh([{ email: 'boss@example.org', role: 'owner' }], { posters: true });
  const fetch = fakeFetch(haikuStream(TWO));
  const up = await withFetch(fetch, () => t.poster());
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(fetch.calls.length, 1, 'read once');
  assert.match(fetch.calls[0].body.messages[0].content[1].text, /St George Cathedral, Redfern/, 'with its parish for context');
  assert.match(up.body.poster_path, /^\/posters\/suggested-antiochian-stgeorge-redfern-[a-z0-9]+-[a-z0-9]+\.jpg$/);
  assert.ok(t.bucket.store.has(up.body.poster_path.slice(1)), 'stored before anything is sent');
  assert.equal(up.body.configured, true);
  assert.equal(up.body.language, 'Greek');
  assert.deepEqual(up.body.events, [
    { title: 'Youth Night', date: '2026-11-14', start_time: '19:00', end_time: '', place: 'Church hall', body: 'Bring a plate.' },
    { title: 'Talk on prayer', date: '2026-11-21', start_time: '18:30', end_time: '20:00', place: '', body: '' },
  ]);
  const row = t.raw.prepare('SELECT * FROM suggestion_posters').get();
  assert.equal(row.email, 'dev', 'whose it is: the address Access verified');
  assert.equal(row.suggestion_id, null, 'nothing sent yet');

  const sent = await t.call('POST', '/api/admin/suggestions', {
    parish_id: PARISH, kind: 'event', ...up.body.events[0], poster_path: up.body.poster_path,
  });
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(t.raw.prepare('SELECT suggestion_id FROM suggestion_posters').get().suggestion_id, sent.body.id);
  const me = await t.call('GET', '/api/admin/whoami');
  assert.equal(me.body.posters, 'read');
  assert.equal(me.body.suggestions[0].poster_path, up.body.poster_path, 'the sender sees it went with it');

  // Whoever keeps the parish sees it beside the suggestion.
  t.raw.prepare("INSERT INTO admin_roles (email, role) VALUES ('dev', 'editor')").run();
  const list = await t.call('GET', '/api/admin/suggestions');
  assert.equal(list.body[0].poster_path, up.body.poster_path);
});

test('starting a draft hands the poster to it, and the draft decides its fate from then', async () => {
  const t = fresh([{ email: 'boss@example.org', role: 'owner' }], { posters: true });
  const { path: p, key, id } = await sentWithPoster(t);
  t.raw.prepare("INSERT INTO admin_roles (email, role) VALUES ('dev', 'editor')").run();

  const draft = await t.call('POST', `/api/admin/suggestions/${id}/draft`);
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  assert.equal(draft.body.poster_path, p, 'the editor opens with the poster, to read again or publish with');
  assert.equal(draft.body.cards[0].title, 'Youth Night');
  assert.equal(t.raw.prepare('SELECT poster_path FROM suggestion_posters').get().poster_path, null,
    'the suggestion lets go of it');
  assert.ok(t.bucket.store.has(key));

  assert.equal((await t.call('DELETE', `/api/admin/drafts/${draft.body.id}`)).status, 200);
  assert.ok(!t.bucket.store.has(key), 'discarding the draft takes the poster nobody else shows');
});

test('withdrawing or dismissing lets the poster go; done keeps it', async () => {
  const t = fresh([{ email: 'boss@example.org', role: 'owner' }], { posters: true });
  const withdrawn = await sentWithPoster(t);
  assert.equal((await t.call('POST', `/api/admin/suggestions/${withdrawn.id}/withdraw`)).status, 200);
  assert.ok(!t.bucket.store.has(withdrawn.key), 'a withdrawn suggestion takes its poster');
  assert.equal((await t.call('GET', '/api/admin/whoami')).body.suggestions[0].poster_path, null);

  const dismissed = await sentWithPoster(t);
  const done = await sentWithPoster(t);
  t.raw.prepare("INSERT INTO admin_roles (email, role) VALUES ('dev', 'editor')").run();
  assert.equal((await t.call('POST', `/api/admin/suggestions/${dismissed.id}/decide`, { decision: 'dismiss', note: 'No' })).status, 200);
  assert.ok(!t.bucket.store.has(dismissed.key), 'nobody will act on a dismissed one');
  assert.equal((await t.call('POST', `/api/admin/suggestions/${done.id}/decide`, { decision: 'done' })).status, 200);
  assert.ok(t.bucket.store.has(done.key), 'a done one keeps what the change was made from');
});

test('a poster goes only with its own sender’s suggestion, at its parish, and once', async () => {
  const t = fresh([{ email: 'boss@example.org', role: 'owner' }], { posters: true });
  const up = await withFetch(fakeFetch(haikuStream(TWO)), () => t.poster());
  const event = { kind: 'event', title: 'Youth Night', date: '2026-11-14', poster_path: up.body.poster_path };

  const there = await t.call('POST', '/api/admin/suggestions', { parish_id: OTHER, ...event });
  assert.equal(there.status, 400, 'not at another parish');
  assert.equal(there.body.field, 'poster');

  t.raw.prepare("UPDATE suggestion_posters SET email = 'someone@example.org'").run();
  assert.equal((await t.call('POST', '/api/admin/suggestions', { parish_id: PARISH, ...event })).body.field, 'poster',
    'not somebody else’s');
  t.raw.prepare("UPDATE suggestion_posters SET email = 'dev'").run();

  assert.equal((await t.call('POST', '/api/admin/suggestions', { parish_id: PARISH, ...event })).status, 201);
  assert.equal((await t.call('POST', '/api/admin/suggestions', { parish_id: PARISH, ...event })).body.field, 'poster',
    'not twice');
  const other = await t.call('POST', '/api/admin/suggestions', {
    parish_id: PARISH, kind: 'event', title: 'X', date: '2026-11-14', poster_path: '/posters/somebody-elses.jpg',
  });
  assert.equal(other.body.field, 'poster', 'not one of the site’s own posters');
  assert.equal(validateSuggestion({ parish_id: 'p', kind: 'event', title: 'X', date: '2026-11-14', poster_path: '/logos/x.png' })
    .suggestion.poster_path, null, 'and never anything but a poster');
});

test('a poster taken off the form goes at once, and still counts towards the day', async () => {
  const t = fresh([{ email: 'boss@example.org', role: 'owner' }], { posters: true });
  const up = await withFetch(fakeFetch(haikuStream(TWO)), () => t.poster());
  const off = await t.call('DELETE', '/api/admin/suggestions/poster', { poster_path: up.body.poster_path });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.ok(!t.bucket.store.has(up.body.poster_path.slice(1)));
  assert.equal(t.raw.prepare('SELECT COUNT(*) AS n FROM suggestion_posters').get().n, 1, 'the row stays, counting');
  assert.equal((await t.poster(PARISH, new Uint8Array(0))).status, 400);
  assert.equal(t.raw.prepare('SELECT COUNT(*) AS n FROM suggestion_posters').get().n, 1,
    'an upload refused before anything was stored or read does not count');
  assert.equal((await t.call('DELETE', '/api/admin/suggestions/poster', { poster_path: up.body.poster_path })).status, 404);
  assert.equal((await t.call('POST', '/api/admin/suggestions', {
    parish_id: PARISH, kind: 'event', title: 'Y', date: '2026-11-14', poster_path: up.body.poster_path,
  })).body.field, 'poster', 'a poster taken off cannot be sent');

  // Somebody else's, or one already sent, is not this person's to take off.
  const sent = await sentWithPoster(t);
  assert.equal((await t.call('DELETE', '/api/admin/suggestions/poster', { poster_path: sent.path })).status, 404);
  assert.ok(t.bucket.store.has(sent.key));
});

test('one address may add so many posters a day; the sweep a day on frees them and clears what nobody sent', async () => {
  const t = fresh([{ email: 'boss@example.org', role: 'owner' }], { posters: true });
  const add = t.raw.prepare('INSERT INTO suggestion_posters (parish_id, email, poster_path) VALUES (?, ?, ?)');
  for (let i = 0; i < POSTER_DAILY_LIMIT; i++) add.run(PARISH, 'dev', `/posters/suggested-old-${i}.jpg`);
  for (let i = 0; i < POSTER_DAILY_LIMIT; i++) t.bucket.store.set(`posters/suggested-old-${i}.jpg`, {});
  const fetch = fakeFetch(haikuStream(TWO));
  const refused = await withFetch(fetch, () => t.poster());
  assert.equal(refused.status, 429);
  assert.equal(refused.body.limit, true);
  assert.equal(fetch.calls.length, 0, 'nothing read, nothing stored');
  assert.equal(t.bucket.store.size, POSTER_DAILY_LIMIT);

  // A day on: they stop counting, and the ones nobody sent go.
  t.raw.prepare("UPDATE suggestion_posters SET created_at = '2020-01-01T00:00:00Z'").run();
  const linked = t.raw.prepare('UPDATE suggestion_posters SET suggestion_id = 999 WHERE id = 1').run();
  assert.equal(linked.changes, 1);
  const up = await withFetch(fakeFetch(haikuStream(TWO)), () => t.poster());
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.deepEqual(t.raw.prepare('SELECT id FROM suggestion_posters ORDER BY id').all().map(r => r.id),
    [1, POSTER_DAILY_LIMIT + 1], 'a sent one stays; the unsent ones go');
  assert.ok(t.bucket.store.has('posters/suggested-old-0.jpg'), 'the sent one’s poster stays');
  assert.ok(!t.bucket.store.has('posters/suggested-old-1.jpg'), 'an unsent one’s goes');
});

test('without a reader the poster still goes along; without storage none is offered', async () => {
  const t = fresh([{ email: 'boss@example.org', role: 'owner' }], { posters: true, key: false });
  const fetch = fakeFetch(haikuStream(TWO));
  const up = await withFetch(fetch, () => t.poster());
  assert.equal(up.status, 201);
  assert.equal(up.body.configured, false);
  assert.deepEqual(up.body.events, []);
  assert.equal(fetch.calls.length, 0);
  assert.equal((await t.call('GET', '/api/admin/whoami')).body.posters, 'store');

  const none = fresh([{ email: 'boss@example.org', role: 'owner' }]);
  assert.equal((await none.call('GET', '/api/admin/whoami')).body.posters, null);
  assert.equal((await none.poster()).status, 503);
});

test('a read that fails keeps the poster and says whether to try again', async () => {
  const t = fresh([{ email: 'boss@example.org', role: 'owner' }], { posters: true });
  const up = await withFetch(fakeFetch('{"type":"error"}', { status: 529 }), () => t.poster());
  assert.equal(up.status, 201);
  assert.equal(up.body.retry, true);
  assert.match(up.body.error, /try again/);
  assert.ok(t.bucket.store.has(up.body.poster_path.slice(1)), 'it can still go with the suggestion');
});

test('a poster is an image, at a parish, from somebody who cannot already add the event', async () => {
  const t = fresh([{ email: 'boss@example.org', role: 'owner' }], { posters: true });
  assert.equal((await t.poster(PARISH, new Uint8Array([1, 2, 3]), 'application/pdf')).status, 415);
  assert.equal((await t.poster(PARISH, new Uint8Array(0))).status, 400);
  assert.equal((await t.poster('nowhere')).status, 404);
  const contact = fresh([{ email: 'boss@example.org', role: 'owner' }, { email: 'dev', role: 'parish', parishIds: [PARISH] }],
    { posters: true });
  const r = await contact.poster();
  assert.equal(r.status, 409, 'a contact reads posters in the add-event editor');
  assert.equal(r.body.covered, true);
});

test('a read offers the form only events it can name', () => {
  assert.deepEqual(formFromRead({ events: [{ title: null, date: null }, { title: 'Vespers', date: null, location_override: 'Hall' }] }),
    [{ title: 'Vespers', date: '', start_time: '', end_time: '', place: 'Hall', body: '' }]);
});

test('a poster from the dialog is read with their words beside it, and goes even when the read names nothing', async () => {
  const t = fresh([{ email: 'boss@example.org', role: 'owner' }], { posters: true });
  const fetch = fakeFetch(haikuStream(TWO));
  const words = 'The talk on the 21st — please add it';
  const up = await withFetch(fetch, () => t.poster(PARISH, jpeg(), 'image/jpeg', { note: words }));
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const context = fetch.calls[0].body.messages[0].content[1].text;
  assert.ok(context.includes(words), 'the reader sees what they wrote');
  assert.ok(context.indexOf(words) < context.indexOf('Read the image.'));

  // Nothing read: the poster is enough, with or without their words.
  const bare = await t.call('POST', '/api/admin/suggestions', { parish_id: PARISH, kind: 'event', body: words, poster_path: up.body.poster_path });
  assert.equal(bare.status, 201, JSON.stringify(bare.body));
  t.raw.prepare("INSERT INTO admin_roles (email, role) VALUES ('dev', 'editor')").run();
  const list = await t.call('GET', '/api/admin/suggestions');
  assert.match(list.body[0].summary, /suggests an event at .*: see their poster\./);
  // And it still becomes a draft, with the poster to read again.
  const d = await t.call('POST', `/api/admin/suggestions/${bare.body.id}/draft`);
  assert.equal(d.status, 201, JSON.stringify(d.body));
});
