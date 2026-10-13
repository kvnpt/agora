// "Is this your parish?" — a signed-in stranger asking for one parish, and an
// owner granting it. Through the real Router, because the point of the two
// claim routes is that they are reachable by somebody `guarded` refuses.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Router } from '../lib/router.mjs';
import { registerAdminRoutes, placesRefusal } from './admin.mjs';
import { planGrant, validateClaim, alreadyCovers } from '../lib/claims.mjs';

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

/** `roles`: rows for admin_roles. The dev bypass signs in as 'dev'. `extra`: more of env. */
function fresh(roles = [], extra = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-claims-')), 'x.db');
  const raw = new Database(file);
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  for (const r of roles) {
    raw.prepare('INSERT INTO admin_roles (email, role, parish_ids) VALUES (?,?,?)')
      .run(r.email, r.role, r.parishIds ? JSON.stringify(r.parishIds) : null);
  }
  const router = new Router();
  registerAdminRoutes(router);
  const env = { DB: new D1(raw), AGORA_DEV_ADMIN: 'true', ...extra };
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

test('somebody signed in with no role can say who they are and ask for a parish', async () => {
  const { raw, call } = fresh([{ email: 'boss@example.org', role: 'owner' }]);
  assert.equal((await call('GET', '/api/admin/ping')).status, 403, 'no role is still refused the panel');

  const me = await call('GET', '/api/admin/whoami');
  assert.equal(me.status, 200);
  assert.equal(me.body.identity, 'dev');
  assert.equal(me.body.role, null);

  const r = await call('POST', '/api/admin/claims',
    { parish_id: PARISH, name: 'Fr John', relation: 'Parish priest', email: 'someone-else@example.org' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = raw.prepare('SELECT * FROM parish_claims WHERE id = ?').get(r.body.id);
  assert.equal(row.email, 'dev', 'the email is the signed-in one, never the one in the body');
  assert.equal(row.status, 'open');

  const again = await call('POST', '/api/admin/claims', { parish_id: PARISH, name: 'Fr John' });
  assert.equal(again.body.id, r.body.id, 'a second press is the same claim');
  assert.equal((await call('GET', '/api/admin/whoami')).body.claims.length, 1);

  assert.equal((await call('POST', `/api/admin/claims/${r.body.id}/withdraw`)).status, 200);
  assert.equal(raw.prepare('SELECT status FROM parish_claims WHERE id = ?').get(r.body.id).status, 'withdrawn');
});

test('a claim is refused when it cannot mean anything', async () => {
  const empty = fresh();
  assert.equal((await empty.call('POST', '/api/admin/claims', { parish_id: PARISH, name: 'X' })).status, 409,
    'with no People list every signed-in person is an owner — nothing to claim onto');

  const { call } = fresh([{ email: 'boss@example.org', role: 'owner' }]);
  assert.equal((await call('POST', '/api/admin/claims', { parish_id: PARISH })).status, 400, 'a name is required');
  assert.equal((await call('POST', '/api/admin/claims', { parish_id: 'nowhere', name: 'X' })).status, 404);

  const contact = fresh([{ email: 'boss@example.org', role: 'owner' }, { email: 'dev', role: 'parish', parishIds: [PARISH] }]);
  const r = await contact.call('POST', '/api/admin/claims', { parish_id: PARISH, name: 'X' });
  assert.equal(r.status, 409);
  assert.equal(r.body.covered, true);
});

test('an owner approving a claim grants the parish, and the dot counts claims', async () => {
  const { raw, call } = fresh([
    { email: 'dev', role: 'owner' },
    { email: 'reader@example.org', role: 'parish', parishIds: ['greek-stgeorge-x'] },
  ]);
  const ins = raw.prepare(`INSERT INTO parish_claims (parish_id, email, name, relation) VALUES (?,?,?,?)`);
  const a = ins.run(PARISH, 'fr.john@example.org', 'Fr John', 'Parish priest').lastInsertRowid;
  const b = ins.run(PARISH, 'reader@example.org', 'Reader', null).lastInsertRowid;
  const d = ins.run(PARISH, 'nope@example.org', 'Nope', null).lastInsertRowid;

  assert.equal((await call('GET', '/api/admin/ping')).body.openAsks, 3);
  const list = await call('GET', '/api/admin/claims');
  assert.equal(list.status, 200);
  assert.match(list.body.find(k => k.id === Number(a)).summary, /Fr John \(Parish priest\) asks to keep St George/);

  assert.equal((await call('POST', `/api/admin/claims/${a}/decide`, { decision: 'approve' })).body.grant, 'insert');
  const fr = raw.prepare('SELECT * FROM admin_roles WHERE email = ?').get('fr.john@example.org');
  assert.equal(fr.role, 'parish');
  assert.deepEqual(JSON.parse(fr.parish_ids), [PARISH]);
  assert.equal(fr.added_by, 'dev');

  assert.equal((await call('POST', `/api/admin/claims/${b}/decide`, { decision: 'approve' })).body.grant, 'update');
  assert.deepEqual(JSON.parse(raw.prepare('SELECT parish_ids FROM admin_roles WHERE email = ?').get('reader@example.org').parish_ids),
    ['greek-stgeorge-x', PARISH], 'a contact gains the parish beside the ones they hold');

  assert.equal((await call('POST', `/api/admin/claims/${d}/decide`, { decision: 'decline', note: 'Not known to the parish' })).status, 200);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM admin_roles WHERE email = ?').get('nope@example.org').n, 0);
  assert.equal(raw.prepare('SELECT decision_note FROM parish_claims WHERE id = ?').get(d).decision_note, 'Not known to the parish');
  assert.equal((await call('POST', `/api/admin/claims/${d}/decide`, { decision: 'approve' })).status, 409, 'decided once');
  assert.equal((await call('GET', '/api/admin/ping')).body.openAsks, 0);
});

test('only an owner decides claims', async () => {
  const { raw, call } = fresh([{ email: 'boss@example.org', role: 'owner' }, { email: 'dev', role: 'editor' }]);
  const id = raw.prepare(`INSERT INTO parish_claims (parish_id, email, name) VALUES (?,?,?)`)
    .run(PARISH, 'x@example.org', 'X').lastInsertRowid;
  assert.equal((await call('GET', '/api/admin/claims')).status, 403);
  assert.equal((await call('POST', `/api/admin/claims/${id}/decide`, { decision: 'approve' })).status, 403);
});

test('approval only ever grants', () => {
  assert.deepEqual(planGrant(null, 'p'), { action: 'insert', role: 'parish', parishIds: ['p'] });
  assert.deepEqual(planGrant({ role: 'owner' }, 'p'), { action: 'none' });
  assert.deepEqual(planGrant({ role: 'editor' }, 'p'), { action: 'none' });
  assert.deepEqual(planGrant({ role: 'parish', parishIds: ['p'] }, 'p'), { action: 'none' });
  assert.deepEqual(planGrant({ role: 'parish', parishIds: ['q'] }, 'p'), { action: 'update', role: 'parish', parishIds: ['q', 'p'] });
  assert.equal(validateClaim({ parish_id: 'p', name: '  ' }).ok, false);
  assert.equal(validateClaim({ parish_id: 'p', name: 'A', note: 'x'.repeat(5000) }).claim.note.length, 1000);
  assert.equal(alreadyCovers({ role: 'editor' }, 'p'), true);
  assert.equal(alreadyCovers({ role: null }, 'p'), false);
});

test('a refused Places search says where to fix it', () => {
  const blocked = placesRefusal(403, { error: { message: 'blocked', details: [{ reason: 'API_KEY_SERVICE_BLOCKED' }] } });
  assert.match(blocked, /API restrictions/);
  assert.match(blocked, /Google said: “blocked”/);
  assert.match(placesRefusal(403, { error: { details: [{ reason: 'SERVICE_DISABLED' }] } }), /not enabled in the Google Cloud project/);
  assert.match(placesRefusal(403, { error: { details: [{ reason: 'API_KEY_HTTP_REFERRER_BLOCKED' }] } }), /Application restrictions → None/);
  assert.match(placesRefusal(500, null), /Google answered 500/);
});

test('a claim before migration 016 is applied makes the table rather than failing', async () => {
  const { raw, call } = fresh([{ email: 'boss@example.org', role: 'owner' }]);
  raw.exec('DROP TABLE parish_claims');
  assert.equal((await call('GET', '/api/admin/whoami')).status, 200, 'reading without the table is fine');
  const r = await call('POST', '/api/admin/claims', { parish_id: PARISH, name: 'Fr John' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM parish_claims').get().n, 1);
});

// ── telling people: lib/mail.mjs ──

/** The send_email binding, keeping what it was asked to send. `fail` throws like a bounce. */
function outbox({ fail = false } = {}) {
  const sent = [];
  return {
    sent,
    async send(m) {
      if (fail) { const e = new Error('nope'); e.code = 'E_RECIPIENT_SUPPRESSED'; throw e; }
      sent.push(m);
      return { messageId: `m${sent.length}` };
    },
  };
}

const claimFrom = (raw, email) => raw.prepare(
  `INSERT INTO parish_claims (parish_id, email, name, relation) VALUES (?,?,?,?)`
).run(PARISH, email, 'Maria', 'Secretary').lastInsertRowid;

test('a claim emails the owners, one message each, and never the claimant', async () => {
  const EMAIL = outbox();
  const { call } = fresh([
    { email: 'boss@example.org', role: 'owner' },
    { email: 'second@example.org', role: 'owner' },
    { email: 'ed@example.org', role: 'editor' },
  ], { EMAIL });
  const r = await call('POST', '/api/admin/claims', {
    parish_id: PARISH, name: 'Maria', relation: 'Secretary', phone: '0400 000 000', note: 'I keep the bulletin.',
  });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual(EMAIL.sent.map(m => m.to).sort(), ['boss@example.org', 'second@example.org'], 'the owners decide; an editor does not');
  const [m] = EMAIL.sent;
  assert.equal(m.from.email, 'noreply@orthodoxy.au');
  assert.equal(m.subject, 'Maria asks to keep St George Cathedral, Redfern');
  assert.match(m.text, /Maria \(Secretary\), dev, asks to become a parish contact/);
  assert.match(m.text, /0400 000 000/);
  assert.match(m.text, /I keep the bulletin/);
  assert.match(m.text, /https:\/\/orthodoxy\.au\/admin#proposals/);

  EMAIL.sent.length = 0;
  assert.equal((await call('POST', '/api/admin/claims', { parish_id: PARISH, name: 'Maria' })).body.already, true);
  assert.equal(EMAIL.sent.length, 0, 'asking again is not news');
});

test('deciding a claim emails the claimant what was decided, with the owner’s note', async () => {
  const EMAIL = outbox();
  const { raw, call } = fresh([{ email: 'dev', role: 'owner' }], { EMAIL });
  const yes = claimFrom(raw, 'maria@example.org');
  const ok = await call('POST', `/api/admin/claims/${yes}/decide`, { decision: 'approve', note: 'Welcome aboard.' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.mailed, true);
  const [m] = EMAIL.sent;
  assert.equal(m.to, 'maria@example.org');
  assert.equal(m.subject, 'You can now keep St George Cathedral, Redfern up to date');
  assert.match(m.text, /has been approved/);
  assert.match(m.text, /https:\/\/orthodoxy\.au\/admin\?suggest=antiochian-stgeorge-redfern/,
    'a link that goes through Access, so it signs them in');
  assert.match(m.text, /Welcome aboard\./);

  const no = raw.prepare(
    "INSERT INTO parish_claims (parish_id, email, name) VALUES (?, 'nikos@example.org', 'Nikos')").run(PARISH).lastInsertRowid;
  const declined = await call('POST', `/api/admin/claims/${no}/decide`, { decision: 'decline', note: 'We have a contact already.' });
  assert.equal(declined.status, 200);
  const d = EMAIL.sent[1];
  assert.equal(d.to, 'nikos@example.org');
  assert.equal(d.subject, 'About your request for St George Cathedral, Redfern');
  assert.match(d.text, /was not approved/);
  assert.match(d.text, /We have a contact already\./);
  assert.match(d.text, /suggest changes from the parish's page/);
});

test('an email that cannot be sent never undoes or refuses the approval', async () => {
  const { raw, call } = fresh([{ email: 'dev', role: 'owner' }], { EMAIL: outbox({ fail: true }) });
  const id = claimFrom(raw, 'maria@example.org');
  const r = await call('POST', `/api/admin/claims/${id}/decide`, { decision: 'approve' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(raw.prepare('SELECT role FROM admin_roles WHERE email = ?').get('maria@example.org').role, 'parish');
  assert.equal(raw.prepare('SELECT status FROM parish_claims WHERE id = ?').get(id).status, 'approved');
});

test('with no email set up nothing is sent and nothing is promised', async () => {
  const { raw, call } = fresh([{ email: 'dev', role: 'owner' }]);
  const id = claimFrom(raw, 'maria@example.org');
  const r = await call('POST', `/api/admin/claims/${id}/decide`, { decision: 'approve' });
  assert.equal(r.status, 200);
  assert.equal(r.body.mailed, false);
  assert.equal((await call('GET', '/api/admin/ping')).body.mail, false, 'the panel promises no email');
  assert.equal((await call('GET', '/api/admin/whoami')).body.mail, false, 'nor does the Suggest edits page');

  const on = fresh([{ email: 'dev', role: 'owner' }], { EMAIL: outbox() });
  assert.equal((await on.call('GET', '/api/admin/ping')).body.mail, true);
  // An identity Access gave with no address (a bare `sub`) has no inbox to write to.
  const sub = claimFrom(on.raw, 'a1b2c3-sub');
  assert.equal((await on.call('POST', `/api/admin/claims/${sub}/decide`, { decision: 'decline' })).body.mailed, false);
});
