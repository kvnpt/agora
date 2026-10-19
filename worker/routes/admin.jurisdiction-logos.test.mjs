// A jurisdiction's logo, through the real router: an owner uploads and
// removes it, nobody else may, and the bundle carries it to the page.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Router } from '../lib/router.mjs';
import { registerAdminRoutes } from './admin.mjs';
import { jurisdictionLogos } from '../lib/juris-logos.mjs';

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

/** An R2 bucket in a Map: put, and delete of one key or several. */
function bucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, body, opts) { objects.set(key, { body, opts }); },
    async delete(keys) { for (const k of [].concat(keys)) objects.delete(k); },
  };
}

function fresh(role) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-jl-')), 'x.db');
  const raw = new Database(file);
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  if (role) raw.prepare('INSERT INTO admin_roles (email, role) VALUES (?, ?)').run('dev', role);
  const router = new Router();
  registerAdminRoutes(router);
  const r2 = bucket();
  const env = { DB: new D1(raw), AGORA_DEV_ADMIN: 'true', ASSETS_BUCKET: r2 };
  const call = async (method, url, body, type = 'image/png') => {
    const init = { method, headers: body ? { 'content-type': type } : {} };
    if (body) init.body = body;
    const res = await router.handle(new Request(`https://orthodoxy.au${url}`, init), env, {});
    assert.ok(res, `no route matched ${method} ${url}`);
    return { status: res.status, body: await res.json() };
  };
  return { raw, env, r2, call };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

test('an owner uploads a logo, replaces it in another format, and removes it', async () => {
  const { env, r2, call } = fresh('owner');
  const up = await call('POST', '/api/admin/jurisdictions/greek/logo', PNG);
  assert.equal(up.status, 200);
  assert.match(up.body.greek, /^\/logos\/jurisdiction-greek\.png\?v=\d+$/);
  assert.deepEqual([...r2.objects.keys()], ['logos/jurisdiction-greek.png']);
  assert.deepEqual(await jurisdictionLogos(env.DB), up.body, 'what the bundle carries');

  const svg = await call('POST', '/api/admin/jurisdictions/greek/logo', new TextEncoder().encode('<svg/>'), 'image/svg+xml');
  assert.match(svg.body.greek, /^\/logos\/jurisdiction-greek\.svg\?v=\d+$/);
  assert.deepEqual([...r2.objects.keys()], ['logos/jurisdiction-greek.svg'], 'the old format goes');

  const del = await call('DELETE', '/api/admin/jurisdictions/greek/logo');
  assert.equal(del.status, 200);
  assert.deepEqual(del.body, {});
  assert.equal(r2.objects.size, 0, 'the image goes with the row');
});

test('only a jurisdiction with a collection, and only an owner', async () => {
  const owner = fresh('owner');
  for (const j of ['other', 'catholic', 'GREEK']) {
    assert.equal((await owner.call('POST', `/api/admin/jurisdictions/${j}/logo`, PNG)).status, 400, j);
  }
  assert.equal((await owner.call('POST', '/api/admin/jurisdictions/greek/logo', new Uint8Array())).status, 400, 'an empty body');

  for (const role of ['editor', 'parish']) {
    const { r2, call } = fresh(role);
    const r = await call('POST', '/api/admin/jurisdictions/greek/logo', PNG);
    assert.equal(r.status, 403, role);
    assert.match(r.body.error, /logo, because it shows site-wide/);
    assert.equal(r.body.proposable, false, 'not an ask: nothing would carry the image to the owner');
    assert.equal(r2.objects.size, 0);
    assert.equal((await call('DELETE', '/api/admin/jurisdictions/greek/logo')).status, 403, role);
  }
});

test('before migration 027 the upload says so, and puts nothing in R2', async () => {
  const { raw, r2, call } = fresh('owner');
  raw.exec('DROP TABLE jurisdiction_logos');
  const r = await call('POST', '/api/admin/jurisdictions/greek/logo', PNG);
  assert.equal(r.status, 503);
  assert.match(r.body.error, /migration 027/);
  assert.equal(r2.objects.size, 0);
});
