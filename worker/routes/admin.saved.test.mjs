// Favourites, lists, bookmarks and saved views kept on the account. Through
// the real Router, because it has to work for somebody with no role at all,
// and must never bump the data version.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Router } from '../lib/router.mjs';
import { registerAdminRoutes } from './admin.mjs';
import { isDataWrite } from '../lib/data-version.mjs';
import { SAVED_DDL } from '../lib/saved-items.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const SV = require('../../public/shared/saved.js');

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

/** A database with no saved_items table (a deploy ahead of migration 029), and somebody with no role. */
function fresh({ table = false } = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-saved-')), 'x.db');
  const raw = new Database(file);
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  if (!table) raw.exec('DROP TABLE saved_items');
  // A row, so the dev bypass is not an owner: 'dev' has no role.
  raw.prepare("INSERT INTO admin_roles (email, role) VALUES ('owner@example.org', 'owner')").run();
  const router = new Router();
  registerAdminRoutes(router);
  const env = { DB: new D1(raw), AGORA_DEV_ADMIN: 'true' };
  const call = async (method, url, body) => {
    const req = new Request(`https://orthodoxy.au${url}`, {
      method, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
    });
    const res = await router.handle(req, env, {});
    assert.ok(res, `no route matched ${method} ${url}`);
    return { status: res.status, body: await res.json().catch(() => null), dataWrite: isDataWrite(req, res) };
  };
  return { raw, call };
}

test('nothing saved yet reads as null, for somebody with no role', async () => {
  const t = fresh();
  const r = await t.call('GET', '/api/admin/saved');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { identity: 'dev', saved: null, updated_at: null });
});

test('a PUT replaces the copy; merge adds to it; neither bumps the data version', async () => {
  const t = fresh({ table: true });
  const one = await t.call('PUT', '/api/admin/saved', { saved: { favourites: [{ id: 'a', at: 1 }], lists: [{ id: 'l1', name: 'Sydney', ids: ['a'], at: 1 }] } });
  assert.equal(one.status, 200);
  assert.equal(one.dataWrite, false);
  assert.deepEqual(one.body.saved.favourites, [{ id: 'a', at: 1 }]);

  const merged = await t.call('PUT', '/api/admin/saved', { merge: true, saved: { favourites: [{ id: 'b', at: 2 }], lists: [{ id: 'l2', name: 'sydney', ids: ['b'], at: 2 }] } });
  assert.deepEqual(merged.body.saved.favourites.map(f => f.id), ['b', 'a']);
  assert.deepEqual(merged.body.saved.lists.map(l => l.id), ['l2', 'l1'], 'two lists of one name stay two');

  const replaced = await t.call('PUT', '/api/admin/saved', { saved: { favourites: [{ id: 'b', at: 2 }] } });
  assert.deepEqual(replaced.body.saved.favourites.map(f => f.id), ['b'], 'an unstar on one device is an unstar');
  assert.deepEqual(replaced.body.saved.lists, []);

  const read = await t.call('GET', '/api/admin/saved');
  assert.deepEqual(read.body.saved, replaced.body.saved);
  assert.ok(read.body.updated_at);
  const rows = t.raw.prepare('SELECT email FROM saved_items').all();
  assert.deepEqual(rows, [{ email: 'dev' }]);
});

test('what is not a copy is refused, and what is wrong inside one is dropped', async () => {
  const t = fresh();
  assert.equal((await t.call('PUT', '/api/admin/saved', 'nope')).status, 400);
  assert.equal((await t.call('PUT', '/api/admin/saved', { saved: null })).status, 400);
  assert.equal((await t.call('PUT', '/api/admin/saved', { saved: { favourites: 'x'.repeat(SV.MAX_BYTES) } })).status, 413);
  const r = await t.call('PUT', '/api/admin/saved', { saved: { favourites: [{ id: 'a' }, { nope: 1 }], views: [{ path: 'https://evil.example' }] } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.saved, { favourites: [{ id: 'a', at: 0 }], lists: [], bookmarks: [], views: [] });
});

test('the table made on first use is the baseline\'s', () => {
  const base = new Database(':memory:');
  base.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  const lazy = new Database(':memory:');
  for (const sql of SAVED_DDL) lazy.exec(sql);
  const cols = (db) => db.prepare('PRAGMA table_info(saved_items)').all();
  assert.deepEqual(cols(lazy), cols(base));
});
