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
import { validateSuggestion, describeSuggestion, cardFromSuggestion, SUGGESTIONS_DDL, OPEN_LIMIT }
  from '../lib/suggestions.mjs';
import { isDataWrite } from '../lib/data-version.mjs';

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

/** `roles`: rows for admin_roles. The dev bypass signs in as 'dev'. */
function fresh(roles = []) {
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
  const call = async (method, url, body) => {
    const init = { method };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
    const res = await router.handle(new Request(`https://orthodoxy.au${url}`, init), env, {});
    assert.ok(res, `no route matched ${method} ${url}`);
    let parsed = null;
    try { parsed = await res.clone().json(); } catch { /* not json */ }
    return { status: res.status, body: parsed };
  };
  return { raw, call };
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
  const cols = (db) => db.prepare('PRAGMA table_info(parish_suggestions)').all();
  assert.deepEqual(cols(lazy), cols(base));
  const idx = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'parish_suggestions' ORDER BY name").all();
  assert.deepEqual(idx(lazy), idx(base));
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
