// Where a parish's details and times come from — one setting, `read_from`
// (public/shared/read-from.js) — and what a person's edit records about it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Router } from '../lib/router.mjs';
import { registerAdminRoutes } from './admin.mjs';
import { registerPublicRoutes } from './public.mjs';

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
const OTHER = 'antiochian-stnicholas-punchbowl';

function fresh(roles = []) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-src-')), 'x.db');
  const raw = new Database(file);
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  for (const r of roles) {
    raw.prepare('INSERT INTO admin_roles (email, role, parish_ids) VALUES (?,?,?)')
      .run(r.email, r.role, r.parishIds ? JSON.stringify(r.parishIds) : null);
  }
  const router = new Router();
  registerAdminRoutes(router);
  registerPublicRoutes(router);
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

test('a new parish row is read from its directory until somebody says otherwise', () => {
  const { raw } = fresh();
  assert.equal(raw.prepare('SELECT read_from FROM parishes WHERE id = ?').get(PARISH).read_from, 'directory');
});

test('the setting is saved, checked, and served publicly for the import scripts', async () => {
  const { raw, call } = fresh();
  assert.equal((await call('PATCH', `/api/admin/parishes/${PARISH}`, { read_from: 'hand' })).status, 200);
  assert.equal(raw.prepare('SELECT read_from FROM parishes WHERE id = ?').get(PARISH).read_from, 'hand');
  assert.equal((await call('PATCH', `/api/admin/parishes/${PARISH}`, { read_from: 'somewhere' })).status, 400);
  const pub = await call('GET', '/api/parishes');
  assert.equal(pub.body.find(p => p.id === PARISH).read_from, 'hand');
});

test('a parish contact may set it for their own parish and no other', async () => {
  const { call } = fresh([
    { email: 'boss@example.org', role: 'owner' },
    { email: 'dev', role: 'parish', parishIds: [PARISH] },
  ]);
  assert.equal((await call('PATCH', `/api/admin/parishes/${PARISH}`, { read_from: 'website' })).status, 200);
  assert.equal((await call('PATCH', `/api/admin/parishes/${OTHER}`, { read_from: 'hand' })).status, 403);
});

test('approving a claim keeps the parish by hand', async () => {
  const { raw, call } = fresh([{ email: 'dev', role: 'owner' }]);
  const id = raw.prepare('INSERT INTO parish_claims (parish_id, email, name) VALUES (?,?,?)')
    .run(PARISH, 'fr.john@example.org', 'Fr John').lastInsertRowid;
  assert.equal((await call('POST', `/api/admin/claims/${id}/decide`, { decision: 'approve' })).status, 200);
  assert.equal(raw.prepare('SELECT read_from FROM parishes WHERE id = ?').get(PARISH).read_from, 'hand');
});

test('the rulings routes are gone', async () => {
  const { call } = fresh();
  for (const [m, u] of [['GET', '/api/info-overrides'], ['GET', '/api/admin/info-overrides'],
    ['PUT', '/api/admin/info-overrides'], ['DELETE', '/api/admin/info-overrides/1']]) {
    const res = await call(m, u).catch(() => null);
    assert.ok(!res || res.status === 404, `${m} ${u} still answers`);
  }
});

// ── an edit in /admin is a claim by a person ───────────────────────────────

test('editing a detail makes the row a person’s, checked today — and pins nothing', async () => {
  const { call, raw } = fresh();
  const before = raw.prepare('SELECT * FROM parishes WHERE id=?').get(PARISH);
  const r = await call('PATCH', `/api/admin/parishes/${PARISH}`, {
    ...before, phone: '0404 172 171', updated_at: undefined, updated_by: undefined,
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.info_source_type, 'person');
  assert.equal(r.body.info_source_name, 'Admin');   // the bootstrap account is an owner
  assert.equal(r.body.info_source_ref, null);
  assert.equal(r.body.info_checked_at.slice(0, 10), new Date().toISOString().slice(0, 10));
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM info_overrides').get().n, 0);
  // Whether imports may still write it is read_from's question, asked by the panel.
  assert.equal(r.body.read_from, 'directory');
});

test('a save that changes nothing about the details leaves the provenance alone', async () => {
  const { call, raw } = fresh();
  const before = raw.prepare('SELECT * FROM parishes WHERE id=?').get(PARISH);
  const r = await call('PATCH', `/api/admin/parishes/${PARISH}`, { color: '#123456' });
  assert.equal(r.status, 200);
  assert.equal(r.body.info_source_type, before.info_source_type);
  assert.equal(r.body.info_checked_at, before.info_checked_at);
});
