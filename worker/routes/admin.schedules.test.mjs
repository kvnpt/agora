// A service held on several days is added once: `days` names them, and each
// day gets its own rule, which the timetable reads back as one line.

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
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-days-')), 'x.db');
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

test('one Add with seven days makes seven rules, and pressing it again makes none', async () => {
  const { raw, call, rule } = fresh();
  const body = { parish_id: rule.parish_id, days: [0, 1, 2, 3, 4, 5, 6], start_time: '21:07', title: 'Compline', event_type: 'prayer' };
  const made = await call('POST', '/api/admin/schedules', body);
  assert.equal(made.status, 201);
  assert.equal(made.body.rules.length, 7);
  assert.deepEqual(made.body.rules.map(r => r.day_of_week), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal(made.body.title, 'Compline', 'the answer is still a rule, the first day\'s');
  const count = () => raw.prepare("SELECT COUNT(*) AS n FROM schedules WHERE parish_id = ? AND title = 'Compline'").get(rule.parish_id).n;
  assert.equal(count(), 7);
  const again = await call('POST', '/api/admin/schedules', body);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal(count(), 7);
});

test('days already there are kept, and only the missing ones are added', async () => {
  const { raw, call, rule } = fresh();
  const base = { parish_id: rule.parish_id, start_time: '21:07', title: 'Compline', event_type: 'prayer' };
  await call('POST', '/api/admin/schedules', { ...base, day_of_week: 3 });
  const made = await call('POST', '/api/admin/schedules', { ...base, days: [1, 3, 5] });
  assert.equal(made.status, 201);
  assert.equal(raw.prepare("SELECT COUNT(*) AS n FROM schedules WHERE parish_id = ? AND title = 'Compline'").get(rule.parish_id).n, 3);
});

test('a day that is not a weekday is refused, and one day still works the old way', async () => {
  const { call, rule } = fresh();
  const base = { parish_id: rule.parish_id, start_time: '21:07', title: 'Compline' };
  assert.equal((await call('POST', '/api/admin/schedules', { ...base, days: [1, 7] })).status, 400);
  const one = await call('POST', '/api/admin/schedules', { ...base, day_of_week: 2 });
  assert.equal(one.status, 201);
  assert.equal(one.body.day_of_week, 2);
});

test('a service is added with its subtitle, on every day ticked', async () => {
  const { raw, call, rule } = fresh();
  const made = await call('POST', '/api/admin/schedules', {
    parish_id: rule.parish_id, days: [2, 4], start_time: '19:13', title: 'Men’s Group', feast: 'St Joseph the Betrothed', event_type: 'social',
  });
  assert.equal(made.status, 201, made.body && made.body.error);
  const rows = raw.prepare("SELECT title, feast FROM schedules WHERE parish_id = ? AND start_time = '19:13'").all(rule.parish_id);
  assert.deepEqual(rows.map(r => [r.title, r.feast]), [['Men’s Group', 'St Joseph the Betrothed'], ['Men’s Group', 'St Joseph the Betrothed']]);
});
