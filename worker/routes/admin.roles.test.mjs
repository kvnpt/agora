// Role enforcement, through the real router.
//
// The unit tests in worker/lib/roles.test.mjs prove the model. These prove the
// WIRING: that every mutating route actually consults it, that a parish contact
// is held to their own parishes, and that the acronym carve-out survives being
// nested inside a route an editor is otherwise allowed to call.
//
// It matters that this goes through Router rather than calling handlers
// directly. A capability named on the wrong route, or a handler that reads
// `params` before the guard runs, is invisible to a unit test and is exactly
// the mistake this tier could make.

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

// The same D1 shim the adapter tests use.
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

const PARISH_A = 'antiochian-stgeorge-redfern';
let PARISH_B = null;

function fresh(roleRow) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-r-')), 'x.db');
  const raw = new Database(file);
  raw.pragma('foreign_keys = ON');
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));

  PARISH_B = raw.prepare(
    "SELECT id FROM parishes WHERE id NOT IN (?, '_unassigned') LIMIT 1").get(PARISH_A).id;

  // AGORA_DEV_ADMIN makes adminIdentity() return 'dev', so a row for 'dev' is
  // how these tests choose a role. An absent row is the bootstrap case.
  if (roleRow) {
    raw.prepare('INSERT INTO admin_roles (email, role, parish_ids) VALUES (?,?,?)')
      .bind(roleRow.role ? 'dev' : 'dev', roleRow.role,
            roleRow.parishIds ? JSON.stringify(roleRow.parishIds) : null).run();
  }

  const router = new Router();
  registerAdminRoutes(router);
  const env = { DB: new D1(raw), AGORA_DEV_ADMIN: 'true' };

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
  return { raw, call };
}

// ── the bootstrap case ──

test('with no rows, the signed-in user is an owner and is told so', async () => {
  const { call } = fresh(null);
  const ping = await call('GET', '/api/admin/ping');
  assert.equal(ping.status, 200);
  assert.equal(ping.body.role, 'owner');
  assert.equal(ping.body.bootstrap, true);
  // The deploy that adds roles must not lock the existing admin out.
  assert.equal((await call('DELETE', `/api/admin/parishes/${PARISH_A}`)).status !== 403, true);
});

test('once any row exists, an unlisted account is refused everywhere', async () => {
  const { raw, call } = fresh(null);
  raw.prepare("INSERT INTO admin_roles (email, role) VALUES ('somebody-else@example.org','owner')").run();

  const ping = await call('GET', '/api/admin/ping');
  assert.equal(ping.status, 403);
  assert.match(ping.body.error, /not on the admin list/);

  for (const [m, u, b] of [
    ['PATCH', `/api/admin/parishes/${PARISH_A}`, { phone: '02 1111 1111' }],
    ['POST', '/api/admin/schedules', { parish_id: PARISH_A, day_of_week: 0, start_time: '09:00', title: 'X' }],
    ['GET', '/api/admin/schedules', undefined],
  ]) {
    assert.equal((await call(m, u, b)).status, 403, `${m} ${u} was allowed`);
  }
});

// ── editor ──

test('an editor does the day-to-day work', async () => {
  const { call } = fresh({ role: 'editor' });
  assert.equal((await call('PATCH', `/api/admin/parishes/${PARISH_A}`, { phone: '02 9999 0000' })).status, 200);
  assert.equal((await call('POST', '/api/admin/schedules',
    { parish_id: PARISH_A, day_of_week: 3, start_time: '18:00', title: 'Vespers' })).status, 201);
});

test('an editor cannot delete a parish, repaint a jurisdiction, or manage people', async () => {
  const { call } = fresh({ role: 'editor' });

  const del = await call('DELETE', `/api/admin/parishes/${PARISH_A}`);
  assert.equal(del.status, 403);
  assert.match(del.body.error, /editor cannot delete a parish/);

  const colors = await call('PATCH', '/api/admin/jurisdiction-colors', { greek: '#123456' });
  assert.equal(colors.status, 403);
  assert.match(colors.body.error, /site-wide/);

  assert.equal((await call('GET', '/api/admin/people')).status, 403);
  assert.equal((await call('PUT', '/api/admin/people/x@y.z', { role: 'owner' })).status, 403);
});

test('the acronym is refused even inside an edit the role is allowed to make', async () => {
  // The carve-out that is easy to get wrong: parish.edit is granted, and the
  // acronym rides in on the same PATCH. A capability named only at the route
  // would have let this through.
  const { raw, call } = fresh({ role: 'editor' });
  const r = await call('PATCH', `/api/admin/parishes/${PARISH_A}`, { acronym: 'stg' });
  assert.equal(r.status, 403);
  assert.equal(r.body.field, 'acronym');
  assert.match(r.body.error, /changes its public link/);

  const after = raw.prepare('SELECT acronym FROM parishes WHERE id = ?').get(PARISH_A);
  assert.notEqual(after.acronym, 'stg', 'the acronym was written despite the refusal');
});

test('an unchanged acronym does not trip the carve-out', async () => {
  // The in-app form posts every field on every save, so an editor saving a
  // phone number must not be refused for sending the acronym it already has.
  const { raw, call } = fresh({ role: 'editor' });
  const current = raw.prepare('SELECT acronym FROM parishes WHERE id = ?').get(PARISH_A).acronym;
  const r = await call('PATCH', `/api/admin/parishes/${PARISH_A}`,
    { acronym: current, phone: '02 4444 5555' });
  assert.equal(r.status, 200, r.body && r.body.error);
});

// ── parish contact ──

test('a parish contact edits their own parish and not another', async () => {
  const { call } = fresh({ role: 'parish', parishIds: [PARISH_A] });

  assert.equal((await call('PATCH', `/api/admin/parishes/${PARISH_A}`, { phone: '02 1234 0000' })).status, 200);

  const other = await call('PATCH', `/api/admin/parishes/${PARISH_B}`, { phone: '02 1234 0000' });
  assert.equal(other.status, 403);
  assert.match(other.body.error, /not one of yours/);
});

test('a parish contact cannot create a schedule at somebody else\'s parish', async () => {
  // A create has no existing row to read the scope off, so the check has to be
  // on the parish being written TO. Without it, scoping is trivially escaped.
  const { call } = fresh({ role: 'parish', parishIds: [PARISH_A] });
  assert.equal((await call('POST', '/api/admin/schedules',
    { parish_id: PARISH_A, day_of_week: 1, start_time: '07:00', title: 'Orthros' })).status, 201);
  assert.equal((await call('POST', '/api/admin/schedules',
    { parish_id: PARISH_B, day_of_week: 1, start_time: '07:00', title: 'Orthros' })).status, 403);
});

test('a parish contact cannot edit or delete another parish\'s rule', async () => {
  const { raw, call } = fresh({ role: 'parish', parishIds: [PARISH_A] });
  const theirs = raw.prepare('SELECT id FROM schedules WHERE parish_id = ? LIMIT 1').get(PARISH_A);
  const others = raw.prepare('SELECT id FROM schedules WHERE parish_id != ? LIMIT 1').get(PARISH_A);
  assert.ok(theirs && others, 'the seed should have rules at two parishes');

  assert.equal((await call('PATCH', `/api/admin/schedules/${theirs.id}`, { title: 'Renamed' })).status, 200);
  assert.equal((await call('PATCH', `/api/admin/schedules/${others.id}`, { title: 'Renamed' })).status, 403);
  assert.equal((await call('DELETE', `/api/admin/schedules/${others.id}`)).status, 403);
});

test('a parish contact cannot add a parish or touch the scrapers', async () => {
  const { call } = fresh({ role: 'parish', parishIds: [PARISH_A] });
  const create = await call('POST', '/api/admin/parishes',
    { name: 'New One', jurisdiction: 'greek', lat: -33, lng: 151, timezone: 'Australia/Sydney' });
  assert.equal(create.status, 403, 'a create would be a way straight out of their own scope');
  assert.equal((await call('PATCH', '/api/admin/adapters/pdf-gopssc-buderim/settings', { enabled: false })).status, 403);
});

// ── attribution ──

test('an edit records who made it and when', async () => {
  const { raw, call } = fresh({ role: 'editor' });
  await call('PATCH', `/api/admin/parishes/${PARISH_A}`, { phone: '02 7777 8888' });
  const row = raw.prepare('SELECT updated_by, updated_at, phone FROM parishes WHERE id = ?').get(PARISH_A);
  assert.equal(row.phone, '02 7777 8888');
  assert.equal(row.updated_by, 'dev');
  assert.match(row.updated_at, /^\d{4}-\d{2}-\d{2}T/);
});

test('updated_by cannot be set by the caller', async () => {
  // An audit line somebody can set is not an audit line.
  const { raw, call } = fresh({ role: 'editor' });
  await call('PATCH', `/api/admin/parishes/${PARISH_A}`,
    { phone: '02 5555 5555', updated_by: 'somebody-important@example.org' });
  const row = raw.prepare('SELECT updated_by FROM parishes WHERE id = ?').get(PARISH_A);
  assert.equal(row.updated_by, 'dev');
});

test('a rule edit is attributed too, and carries its source', async () => {
  const { raw, call } = fresh({ role: 'editor' });
  const sched = raw.prepare('SELECT id FROM schedules LIMIT 1').get();
  const r = await call('PATCH', `/api/admin/schedules/${sched.id}`, {
    source_name: 'Antiochian Archdiocese',
    source_ref: 'https://antiochian.org.au/parish',
    source_checked_at: '2026-09-17T00:00:00Z',
  });
  assert.equal(r.status, 200, r.body && r.body.error);
  const row = raw.prepare('SELECT source_name, source_ref, source_checked_at, updated_by FROM schedules WHERE id = ?').get(sched.id);
  // These three were in the schema and refused by the API, so the field the
  // schema calls the only signal anybody has looked could not be filled in.
  assert.equal(row.source_name, 'Antiochian Archdiocese');
  assert.equal(row.source_ref, 'https://antiochian.org.au/parish');
  assert.equal(row.updated_by, 'dev');
});

// ── verification ──

test('verifying a parish stamps info_verified_at with who did it', async () => {
  const { raw, call } = fresh({ role: 'editor' });
  const before = raw.prepare('SELECT info_verified_at FROM parishes WHERE id = ?').get(PARISH_A);
  assert.equal(before.info_verified_at, null, 'the seed should not claim anyone has been there');

  const r = await call('POST', `/api/admin/parishes/${PARISH_A}/verify`);
  assert.equal(r.status, 200);
  const after = raw.prepare('SELECT info_verified_at, updated_by FROM parishes WHERE id = ?').get(PARISH_A);
  assert.match(after.info_verified_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(after.updated_by, 'dev');

  assert.equal((await call('DELETE', `/api/admin/parishes/${PARISH_A}/verify`)).status, 200);
  assert.equal(raw.prepare('SELECT info_verified_at FROM parishes WHERE id = ?').get(PARISH_A).info_verified_at, null);
});

// ── people ──

test('an owner manages the list; a parish contact is refused', async () => {
  const { call } = fresh({ role: 'owner' });
  assert.equal((await call('PUT', '/api/admin/people/deacon@example.org',
    { role: 'parish', parishIds: [PARISH_A], note: 'Blacktown contact' })).status, 200);
  const list = await call('GET', '/api/admin/people');
  assert.equal(list.status, 200);
  const added = list.body.find(p => p.email === 'deacon@example.org');
  assert.deepEqual(added.parishIds, [PARISH_A]);
  assert.equal(added.addedBy, 'dev');
});

test('a parish contact with no parishes is refused as a role that grants nothing', async () => {
  const { call } = fresh({ role: 'owner' });
  const r = await call('PUT', '/api/admin/people/x@example.org', { role: 'parish', parishIds: [] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /at least one parish/);
});

test('an unknown role is refused rather than stored', async () => {
  const { call } = fresh({ role: 'owner' });
  assert.equal((await call('PUT', '/api/admin/people/x@example.org', { role: 'superuser' })).status, 400);
});

test('the last owner cannot demote or remove themselves', async () => {
  // The failure it prevents is total: rows present and no owner means nobody
  // can edit admin_roles and nobody can be added — the only way back is SQL.
  const { raw, call } = fresh({ role: 'owner' });
  raw.prepare("INSERT INTO admin_roles (email, role) VALUES ('editor@example.org','editor')").run();

  const demote = await call('PUT', '/api/admin/people/dev', { role: 'editor' });
  assert.equal(demote.status, 409);
  assert.match(demote.body.error, /only owner/);

  assert.equal((await call('DELETE', '/api/admin/people/dev')).status, 409);

  // With a second owner, it is allowed.
  raw.prepare("INSERT INTO admin_roles (email, role) VALUES ('other@example.org','owner')").run();
  assert.equal((await call('PUT', '/api/admin/people/dev', { role: 'editor' })).status, 200);
});

test('an email is stored lower-cased so it matches at read time', async () => {
  const { raw, call } = fresh({ role: 'owner' });
  await call('PUT', '/api/admin/people/Deacon@EXAMPLE.org', { role: 'editor' });
  const row = raw.prepare("SELECT email FROM admin_roles WHERE role = 'editor'").get();
  assert.equal(row.email, 'deacon@example.org');
});

// ── proposals ──
//
// The refusal that carries the ask. What matters most here is the
// re-validation on approval: a row can sit for a week while the world moves
// under it, and trusting a stored payload is how an approval quietly does
// something nobody asked for.

const asRole = (role, parishIds) => fresh({ role, parishIds });

test('an editor refused a delete is told it can be proposed', async () => {
  const { call } = asRole('editor');
  const r = await call('DELETE', `/api/admin/parishes/${PARISH_A}`);
  assert.equal(r.status, 403);
  assert.equal(r.body.proposable, true);
  assert.equal(r.body.capability, 'parish.delete');
});

test('a refusal for something not proposable says so', async () => {
  const { call } = asRole('parish', [PARISH_A]);
  const r = await call('PATCH', '/api/admin/adapters/pdf-gopssc-buderim/settings', { enabled: false });
  assert.equal(r.status, 403);
  assert.equal(r.body.proposable, false);
});

test('proposing something you could just do is refused as a dead end', async () => {
  // It would sit waiting for an owner to approve what the proposer could have
  // pressed themselves.
  const { call } = asRole('owner');
  const r = await call('POST', '/api/admin/proposals',
    { capability: 'parish.delete', subject: PARISH_A, payload: { disposition: 'purge' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /do that yourself/);
});

test('an editor proposes, an owner sees it with its reason and consequence', async () => {
  const { raw, call } = asRole('editor');
  const made = await call('POST', '/api/admin/proposals', {
    capability: 'parish.delete', subject: PARISH_A,
    payload: { disposition: 'transfer', transferTo: PARISH_B },
    reason: 'Duplicate of the other Redfern listing.',
  });
  assert.equal(made.status, 201);

  // Now read it as an owner.
  raw.prepare("UPDATE admin_roles SET role='owner' WHERE email='dev'").run();
  const list = await call('GET', '/api/admin/proposals');
  assert.equal(list.status, 200);
  const p = list.body[0];
  assert.equal(p.capability, 'parish.delete');
  assert.equal(p.proposedBy, 'dev');
  assert.match(p.reason, /Duplicate/);
  // The summary carries the consequence, with real parish names rather than ids.
  assert.match(p.summary, /moving its events and rules to/);
  assert.ok(!p.summary.includes(PARISH_B), 'the summary should name the parish, not its id');
});

test('an editor cannot decide, even their own proposal', async () => {
  const { call } = asRole('editor');
  const made = await call('POST', '/api/admin/proposals',
    { capability: 'parish.acronym', subject: PARISH_A, payload: { acronym: 'stgr' } });
  const decide = await call('POST', `/api/admin/proposals/${made.body.id}/decide`, { decision: 'approve' });
  assert.equal(decide.status, 403);
});

test('an editor may withdraw their own, and only their own', async () => {
  const { raw, call } = asRole('editor');
  const mine = await call('POST', '/api/admin/proposals',
    { capability: 'parish.acronym', subject: PARISH_A, payload: { acronym: 'stgr' } });
  raw.prepare(
    "INSERT INTO admin_proposals (capability, subject, payload, proposed_by) VALUES ('parish.acronym',?,'{\"acronym\":\"x\"}','someone@else.org')"
  ).bind(PARISH_A).run();
  const theirs = raw.prepare("SELECT id FROM admin_proposals WHERE proposed_by='someone@else.org'").get();

  assert.equal((await call('POST', `/api/admin/proposals/${mine.body.id}/withdraw`)).status, 200);
  const other = await call('POST', `/api/admin/proposals/${theirs.id}/withdraw`);
  assert.equal(other.status, 403);
  assert.match(other.body.error, /only withdraw your own/);
});

test('approving an acronym applies it, and attributes the edit to the approver', async () => {
  const { raw, call } = asRole('owner');
  raw.prepare(
    "INSERT INTO admin_proposals (capability, subject, payload, proposed_by) VALUES ('parish.acronym',?,'{\"acronym\":\"stgr\"}','editor@example.org')"
  ).bind(PARISH_A).run();
  const id = raw.prepare('SELECT id FROM admin_proposals').get().id;

  const r = await call('POST', `/api/admin/proposals/${id}/decide`, { decision: 'approve' });
  assert.equal(r.status, 200, r.body && r.body.error);
  const parish = raw.prepare('SELECT acronym, updated_by FROM parishes WHERE id = ?').get(PARISH_A);
  assert.equal(parish.acronym, 'stgr');
  // The approver made the change, not the proposer — they are the one who
  // decided it should happen.
  assert.equal(parish.updated_by, 'dev');
});

test('approval re-checks the world, and refuses when it has moved', async () => {
  // THE CASE THIS EXISTS FOR. The proposal was fine when it was made; another
  // parish took that acronym while it waited. Approving on the stored payload
  // would have written a duplicate link.
  const { raw, call } = asRole('owner');
  raw.prepare(
    "INSERT INTO admin_proposals (capability, subject, payload, proposed_by) VALUES ('parish.acronym',?,'{\"acronym\":\"taken\"}','editor@example.org')"
  ).bind(PARISH_A).run();
  raw.prepare('UPDATE parishes SET acronym = ? WHERE id = ?').run('taken', PARISH_B);
  const id = raw.prepare('SELECT id FROM admin_proposals').get().id;

  const r = await call('POST', `/api/admin/proposals/${id}/decide`, { decision: 'approve' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already the acronym/);
  // Still open, so it can be fixed and decided again rather than lost.
  assert.equal(raw.prepare('SELECT status FROM admin_proposals WHERE id=?').get(id).status, 'open');
});

test('approving a delete whose parish is gone says so rather than half-acting', async () => {
  const { raw, call } = asRole('owner');
  raw.prepare(
    "INSERT INTO admin_proposals (capability, subject, payload, proposed_by) VALUES ('parish.delete','ghost-parish','{\"disposition\":\"purge\"}','editor@example.org')"
  ).run();
  const id = raw.prepare('SELECT id FROM admin_proposals').get().id;
  const r = await call('POST', `/api/admin/proposals/${id}/decide`, { decision: 'approve' });
  assert.equal(r.status, 410);
  assert.match(r.body.error, /no longer exists/);
});

test('approving a transfer whose target is gone refuses before touching anything', async () => {
  const { raw, call } = asRole('owner');
  raw.prepare(
    "INSERT INTO admin_proposals (capability, subject, payload, proposed_by) VALUES ('parish.delete',?,'{\"disposition\":\"transfer\",\"transferTo\":\"nowhere\"}','editor@example.org')"
  ).bind(PARISH_A).run();
  const id = raw.prepare('SELECT id FROM admin_proposals').get().id;
  const r = await call('POST', `/api/admin/proposals/${id}/decide`, { decision: 'approve' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /no longer exists/);
  // The parish it was about is untouched.
  assert.ok(raw.prepare('SELECT id FROM parishes WHERE id = ?').get(PARISH_A));
});

test('an unreadable payload cannot be approved but does not break the list', async () => {
  const { raw, call } = asRole('owner');
  raw.prepare(
    "INSERT INTO admin_proposals (capability, subject, payload, proposed_by) VALUES ('parish.acronym',?,'not json','editor@example.org')"
  ).bind(PARISH_A).run();
  const id = raw.prepare('SELECT id FROM admin_proposals').get().id;

  const list = await call('GET', '/api/admin/proposals');
  assert.equal(list.status, 200);
  assert.equal(list.body[0].summary, null, 'an unreadable row should render with no summary');

  const r = await call('POST', `/api/admin/proposals/${id}/decide`, { decision: 'approve' });
  assert.equal(r.status, 422);
});

test('declining closes it with a note and changes nothing', async () => {
  const { raw, call } = asRole('owner');
  const before = raw.prepare('SELECT acronym FROM parishes WHERE id = ?').get(PARISH_A).acronym;
  raw.prepare(
    "INSERT INTO admin_proposals (capability, subject, payload, proposed_by) VALUES ('parish.acronym',?,'{\"acronym\":\"nope\"}','editor@example.org')"
  ).bind(PARISH_A).run();
  const id = raw.prepare('SELECT id FROM admin_proposals').get().id;

  const r = await call('POST', `/api/admin/proposals/${id}/decide`,
    { decision: 'decline', note: 'That slug is reserved for the jurisdiction page.' });
  assert.equal(r.status, 200);
  const row = raw.prepare('SELECT status, decided_by, decision_note FROM admin_proposals WHERE id=?').get(id);
  assert.equal(row.status, 'declined');
  assert.equal(row.decided_by, 'dev');
  assert.match(row.decision_note, /reserved/);
  assert.equal(raw.prepare('SELECT acronym FROM parishes WHERE id = ?').get(PARISH_A).acronym, before);
});

test('a decided proposal cannot be decided twice', async () => {
  const { raw, call } = asRole('owner');
  raw.prepare(
    "INSERT INTO admin_proposals (capability, subject, payload, proposed_by, status) VALUES ('parish.acronym',?,'{\"acronym\":\"x\"}','e@x.org','approved')"
  ).bind(PARISH_A).run();
  const id = raw.prepare('SELECT id FROM admin_proposals').get().id;
  const r = await call('POST', `/api/admin/proposals/${id}/decide`, { decision: 'approve' });
  assert.equal(r.status, 409);
  assert.match(r.body.error, /already approved/);
});

test('a parish contact can only propose about their own parishes', async () => {
  const { call } = asRole('parish', [PARISH_A]);
  assert.equal((await call('POST', '/api/admin/proposals',
    { capability: 'parish.delete', subject: PARISH_A, payload: { disposition: 'purge' } })).status, 201);
  assert.equal((await call('POST', '/api/admin/proposals',
    { capability: 'parish.delete', subject: PARISH_B, payload: { disposition: 'purge' } })).status, 403);
});
