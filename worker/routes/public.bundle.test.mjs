// /api/bundle through the real Worker entry: what it sends, what it withholds,
// and the thing the caching change exists for — an edit in /admin is what the
// very next load of the app gets.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import worker from '../index.mjs';
import { fakeBucket, fakeCache } from '../lib/test-fakes.mjs';
import { joinParishes, PARISH_JOIN } from '../../public/shared/parish-join.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

class D1 {
  constructor(db) { this.db = db; this.reads = 0; }
  prepare(sql) { return new S(this, sql, []); }
  async batch(stmts) { return this.db.transaction(() => stmts.map(s => s._runSync()))(); }
}
class S {
  constructor(d1, sql, a) { this.d1 = d1; this.sql = sql; this.args = a; }
  bind(...a) { return new S(this.d1, this.sql, a); }
  _runSync() { const r = this.d1.db.prepare(this.sql).run(...this.args); return { meta: { changes: r.changes } }; }
  async all() { this.d1.reads++; return { results: this.d1.db.prepare(this.sql).all(...this.args) }; }
  async first() { this.d1.reads++; const r = this.d1.db.prepare(this.sql).get(...this.args); return r === undefined ? null : r; }
  async run() { return this._runSync(); }
}

function fresh() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-bundle-')), 'x.db');
  const raw = new Database(file);
  raw.pragma('foreign_keys = ON');
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  // A rule an admin has touched, so there is an author to withhold.
  raw.exec("UPDATE schedules SET updated_by = 'someone@example.org' WHERE id = (SELECT MIN(id) FROM schedules)");
  const db = new D1(raw);
  const env = { DB: db, ASSETS_BUCKET: fakeBucket(), AGORA_DEV_ADMIN: 'true' };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const call = async (method, url, { body, headers = {} } = {}) => {
    const init = { method, headers: { ...headers } };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
    const res = await worker.fetch(new Request(`https://orthodoxy.au${url}`, init), env, ctx);
    await Promise.all(pending.splice(0));
    return res;
  };
  return { raw, db, env, call };
}

test('a rule travels with its own columns only — no parish copies, no author', async () => {
  const { call } = fresh();
  const res = await call('GET', '/api/bundle');
  assert.equal(res.status, 200);
  const b = await res.json();
  assert.ok(b.schedules.length, 'the seed has rules');
  for (const s of b.schedules) {
    for (const [, as] of PARISH_JOIN) assert.ok(!(as in s), `${as} was sent on a rule`);
    assert.ok(!('updated_by' in s), 'an admin email reached the public bundle');
    // Its own two that can differ from the parish's are still there.
    assert.ok('location_override' in s && 'languages' in s);
  }
  assert.ok(!('generated_at' in b), 'a clock in the body would change the ETag on every rebuild');
});

test('joined in the browser, a rule reads exactly as the SQL join gave it', async () => {
  const { raw, call } = fresh();
  const b = await (await call('GET', '/api/bundle')).json();
  const joined = joinParishes(b.schedules, b.parishes);
  const cols = PARISH_JOIN.map(([c, as]) => `p.${c} AS ${as}`).join(', ');
  for (const s of joined) {
    const viaSql = raw.prepare(`SELECT ${cols} FROM parishes p WHERE p.id = ?`).get(s.parish_id);
    for (const [, as] of PARISH_JOIN) assert.equal(s[as], viaSql[as], `${as} for rule ${s.id}`);
  }
});

test('the browser is made to ask every time, and an unchanged bundle is a 304', async () => {
  const { call } = fresh();
  const a = await call('GET', '/api/bundle');
  assert.equal(a.headers.get('cache-control'), 'no-cache');
  const etag = a.headers.get('etag');
  assert.ok(etag);
  const b = await call('GET', '/api/bundle', { headers: { 'If-None-Match': etag } });
  assert.equal(b.status, 304);
});

test('an edit in /admin is what the next load of the app gets', async () => {
  const { raw, call } = fresh();
  const first = await call('GET', '/api/bundle');
  const etag = first.headers.get('etag');
  const version = first.headers.get('x-data-version');
  const id = raw.prepare('SELECT MIN(id) AS id FROM schedules').get().id;

  const w = await call('PATCH', `/api/admin/schedules/${id}`, { body: { title: 'Renamed in admin' } });
  assert.equal(w.status, 200);

  // The browser revalidates with the ETag it holds, as it now always does.
  const next = await call('GET', '/api/bundle', { headers: { 'If-None-Match': etag } });
  assert.equal(next.status, 200, 'the old body was treated as still current');
  assert.notEqual(next.headers.get('x-data-version'), version);
  const b = await next.json();
  assert.equal(b.schedules.find(s => s.id === id).title, 'Renamed in admin');
});

test('a refused admin write leaves the version alone', async () => {
  const { call } = fresh();
  const v = (await call('GET', '/api/bundle')).headers.get('x-data-version');
  const bad = await call('PATCH', '/api/admin/schedules/999999', { body: { title: 'x' } });
  assert.ok(bad.status >= 400);
  assert.equal((await call('GET', '/api/bundle')).headers.get('x-data-version'), v);
});

test('with an edge cache, a repeat load does not reach the database at all', async () => {
  const { db, call } = fresh();
  const had = globalThis.caches;
  globalThis.caches = { default: fakeCache() };
  try {
    const a = await call('GET', '/api/bundle');
    const reads = db.reads;
    const b = await call('GET', '/api/bundle', { headers: { 'If-None-Match': a.headers.get('etag') } });
    assert.equal(b.status, 304);
    assert.equal(db.reads, reads, 'a cached bundle still queried D1');

    // …and after a write, it does, once.
    const id = (await (await call('GET', '/api/bundle')).json()).schedules[0].id;
    await call('PATCH', `/api/admin/schedules/${id}`, { body: { title: 'After' } });
    const c = await call('GET', '/api/bundle', { headers: { 'If-None-Match': a.headers.get('etag') } });
    assert.equal(c.status, 200);
  } finally {
    if (had === undefined) delete globalThis.caches; else globalThis.caches = had;
  }
});

test('/api/schedules withholds the author too', async () => {
  const { call } = fresh();
  const rows = await (await call('GET', '/api/schedules')).json();
  assert.ok(rows.length);
  for (const r of rows) assert.ok(!('updated_by' in r));
});
