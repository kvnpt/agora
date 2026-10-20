// Languages keep to the fixed list (public/shared/languages.js) on every
// write, whatever a form or an old client sends: a parish, a rule, one date of
// a rule. "Russian" and "Slavonic" are Church Slavonic; anything not on the
// list is dropped.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Router } from '../lib/router.mjs';
import { registerAdminRoutes } from './admin.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// The same D1 shim the other route tests use.
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

function fresh() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-langs-')), 'x.db');
  const raw = new Database(file);
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  const router = new Router();
  registerAdminRoutes(router);
  const db = new D1(raw);
  const env = { DB: db, AGORA_DEV_ADMIN: 'true' };
  const call = async (method, url, body) => {
    const init = { method };
    if (body !== undefined) {
      init.body = JSON.stringify(body);
      init.headers = { 'Content-Type': 'application/json' };
    }
    const res = await router.handle(new Request(`https://orthodoxy.au${url}`, init), env, {});
    assert.ok(res, `no route matched ${method} ${url}`);
    let parsed = null;
    try { parsed = await res.clone().json(); } catch { /* not json */ }
    return { status: res.status, body: parsed };
  };
  const rule = raw.prepare(`SELECT s.id, s.parish_id, s.day_of_week FROM schedules s
    WHERE s.parish_id != '_unassigned' AND s.active = 1 AND s.week_of_month IS NULL
      AND s.effective_from IS NULL AND s.effective_to IS NULL ORDER BY s.id LIMIT 1`).get();
  assert.ok(rule, 'the seed should have a weekly rule');
  return { raw, call, rule };
}

const SENT = JSON.stringify(['russian', 'Klingon', 'English', 'Slavonic']);
const KEPT = '["Church Slavonic","English"]';

test('a parish edit keeps its languages to the list, and none is an empty list', async () => {
  const { raw, call, rule } = fresh();
  assert.equal((await call('PATCH', `/api/admin/parishes/${rule.parish_id}`, { languages: SENT })).status, 200);
  assert.equal(raw.prepare('SELECT languages FROM parishes WHERE id = ?').get(rule.parish_id).languages, KEPT);
  assert.equal((await call('PATCH', `/api/admin/parishes/${rule.parish_id}`, { languages: '["Klingon"]' })).status, 200);
  assert.equal(raw.prepare('SELECT languages FROM parishes WHERE id = ?').get(rule.parish_id).languages, '[]');
});

test('a rule added or edited keeps its languages to the list', async () => {
  const { raw, call, rule } = fresh();
  const made = await call('POST', '/api/admin/schedules', {
    parish_id: rule.parish_id, day_of_week: 3, start_time: '18:00', title: 'Vespers', event_type: 'prayer', languages: SENT,
  });
  assert.equal(made.status, 201);
  assert.equal(made.body.languages, KEPT);
  assert.equal((await call('PATCH', `/api/admin/schedules/${rule.id}`, { languages: '["Greek", "French"]' })).status, 200);
  assert.equal(raw.prepare('SELECT languages FROM schedules WHERE id = ?').get(rule.id).languages, '["Greek"]');
});
