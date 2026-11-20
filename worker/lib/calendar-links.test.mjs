// A person's private calendar link: one token per account, the only key.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { CALENDAR_LINKS_DDL, newToken, isToken, tokenFor, identityOf } from './calendar-links.mjs';

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

test('a token is 22 characters of base64url, and a new one each time', () => {
  const a = newToken(), b = newToken();
  assert.ok(isToken(a) && isToken(b));
  assert.notEqual(a, b);
  assert.ok(!isToken('short'));
  assert.ok(!isToken('a'.repeat(21) + '/'));
  assert.ok(!isToken(null));
});

test('one account, one token: asked twice, or in another case, it is the same', async () => {
  const db = new D1(new Database(':memory:'));   // no table yet: made on first use
  const t = await tokenFor(db, 'Someone@Example.org');
  assert.ok(isToken(t));
  assert.equal(await tokenFor(db, 'someone@example.org '), t);
  assert.notEqual(await tokenFor(db, 'other@example.org'), t);
  assert.equal(await identityOf(db, t), 'someone@example.org');
});

test('a token nobody was given, or not a token at all, is nobody', async () => {
  const db = new D1(new Database(':memory:'));
  await tokenFor(db, 'someone@example.org');
  assert.equal(await identityOf(db, newToken()), null);
  assert.equal(await identityOf(db, "x' OR 1=1 --"), null);
});

test('the table made on first use is the baseline\'s', () => {
  const base = new Database(':memory:');
  base.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  const lazy = new Database(':memory:');
  for (const sql of CALENDAR_LINKS_DDL) lazy.exec(sql);
  const cols = (db) => db.prepare('PRAGMA table_info(calendar_links)').all();
  assert.deepEqual(cols(lazy), cols(base));
});
