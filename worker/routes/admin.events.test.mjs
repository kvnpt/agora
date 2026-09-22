// Creating a one-off event, and the combine that travels with it.
//
// Until the parish sheet grew an add button there was no way into `events`
// except an adapter or a PATCH of a row that already existed, so this covers a
// route with no precedent: what it writes, what it refuses, and the part that is
// easy to get wrong — that the three combine mechanisms CLAUDE.md lists are all
// reachable from the create, routed by the shape of the target id.
//
// Through the real Router, like admin.roles.test.mjs, because a capability named
// on the wrong route or a scope check that reads `params` before the guard runs
// is invisible to a unit test.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Router } from '../lib/router.mjs';
import { registerAdminRoutes } from './admin.mjs';
import { expandWindow, expandOne } from '../lib/expand.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// The same D1 shim the adapter and role tests use.
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

function fresh(roleRow) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-ev-')), 'x.db');
  const raw = new Database(file);
  raw.pragma('foreign_keys = ON');
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));

  if (roleRow) {
    raw.prepare('INSERT INTO admin_roles (email, role, parish_ids) VALUES (?,?,?)')
      .run('dev', roleRow.role, roleRow.parishIds ? JSON.stringify(roleRow.parishIds) : null);
  }

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
  return { raw, db, call };
}

const FROM = '2026-09-01T00:00:00.000Z';
const TO = '2026-10-01T00:00:00.000Z';

/** Two seeded parishes that both have rules, so a combine has somewhere to go. */
function twoParishes(raw) {
  const rows = raw.prepare(
    `SELECT DISTINCT p.id FROM parishes p JOIN schedules s ON s.parish_id = p.id
     WHERE p.id != '_unassigned' ORDER BY p.id`
  ).all();
  assert.ok(rows.length >= 2, 'the seed should have rules at two parishes');
  return [rows[0].id, rows[1].id];
}

/** The first projected occurrence at `parishId` inside the window. */
async function firstInstance(db, parishId) {
  const all = await expandWindow(db, FROM, TO);
  const hit = all.find(e => e.parish_id === parishId);
  assert.ok(hit, `no projected occurrence at ${parishId}`);
  return hit;
}

// ── what a create writes ──

test('an editor adds a one-off, and it is stored as a hand-entered instant', async () => {
  const { raw, call } = fresh({ role: 'editor' });
  const [parishId] = twoParishes(raw);
  const parish = raw.prepare('SELECT lat, lng FROM parishes WHERE id = ?').get(parishId);

  const r = await call('POST', '/api/admin/events', {
    parish_id: parishId,
    title: 'Dormition Vigil',
    start_utc: '2026-09-14T09:00:00.000Z',
    end_utc: '2026-09-14T11:00:00.000Z',
    event_type: 'feast',
    languages: JSON.stringify(['English', 'Greek']),
  });
  assert.equal(r.status, 201, r.body && r.body.error);

  const row = raw.prepare('SELECT * FROM events WHERE id = ?').get(r.body.id);
  assert.equal(row.title, 'Dormition Vigil');
  // 'schedule' is what the bundle query filters OUT, so a hand-entered row must
  // not carry it; 'manual' is what says a person typed this.
  assert.equal(row.source_adapter, 'manual');
  assert.equal(row.status, 'approved');
  // No rule behind it — the same mutation_type the adapters write for a one-off.
  assert.equal(row.mutation_type, 'headless');
  assert.equal(row.schedule_id, null);
  // A one-off with no venue of its own is at the parish, so it gets the pin.
  assert.equal(row.lat, parish.lat);
  assert.equal(row.lng, parish.lng);
  assert.equal(row.source_hash, null, 'a hand-entered row has no scrape to dedup against');
  assert.deepEqual(r.body.additional_parishes, []);
  assert.deepEqual(r.body.replaces, []);
});

test('the required three are required, and a start that is not an instant is refused', async () => {
  const { raw, call } = fresh({ role: 'editor' });
  const [parishId] = twoParishes(raw);

  for (const body of [
    { title: 'X', start_utc: '2026-09-14T09:00:00Z' },
    { parish_id: parishId, start_utc: '2026-09-14T09:00:00Z' },
    { parish_id: parishId, title: 'X' },
  ]) {
    const r = await call('POST', '/api/admin/events', body);
    assert.equal(r.status, 400, `${JSON.stringify(body)} was accepted`);
  }

  const bad = await call('POST', '/api/admin/events',
    { parish_id: parishId, title: 'X', start_utc: 'next Sunday' });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /instant/);

  const backwards = await call('POST', '/api/admin/events', {
    parish_id: parishId, title: 'X',
    start_utc: '2026-09-14T09:00:00Z', end_utc: '2026-09-14T08:00:00Z',
  });
  assert.equal(backwards.status, 400);

  const nowhere = await call('POST', '/api/admin/events',
    { parish_id: 'no-such-parish', title: 'X', start_utc: '2026-09-14T09:00:00Z' });
  assert.equal(nowhere.status, 400);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
});

// ── the combine, entered in the same press ──

test('a create lists the event at other parishes in one request', async () => {
  const { raw, call } = fresh({ role: 'editor' });
  const [home, other] = twoParishes(raw);

  const r = await call('POST', '/api/admin/events', {
    parish_id: home, title: 'Deanery Liturgy', start_utc: '2026-09-20T23:00:00.000Z',
    additive_parish_ids: [other],
  });
  assert.equal(r.status, 201, r.body && r.body.error);
  assert.deepEqual(r.body.additional_parishes, [other]);
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS n FROM event_parishes WHERE event_id = ?').get(r.body.id).n, 1);
  // The home parish is never a row in event_parishes — it is the event's own
  // column, and a second copy is a way to drift.
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS n FROM event_parishes WHERE event_id = ? AND parish_id = ?')
      .get(r.body.id, home).n, 0);
});

test('a create absorbs a stored one-off, which becomes a replaced row', async () => {
  const { raw, call } = fresh({ role: 'editor' });
  const [home] = twoParishes(raw);
  const p = raw.prepare('SELECT lat, lng FROM parishes WHERE id = ?').get(home);
  raw.prepare(
    "INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type, source_hash, lat, lng)" +
    " VALUES (?, 'manual', 'Parish Vespers', '2026-09-20T08:00:00.000Z', 'prayer', 'h-base', ?, ?)"
  ).run(home, p.lat, p.lng);
  const base = raw.prepare("SELECT id FROM events WHERE source_hash = 'h-base'").get().id;

  const r = await call('POST', '/api/admin/events', {
    parish_id: home, title: 'Deanery Vespers', start_utc: '2026-09-20T08:00:00.000Z',
    replaced_event_ids: [base],
  });
  assert.equal(r.status, 201, r.body && r.body.error);
  assert.deepEqual(r.body.replaces, [base]);

  const was = raw.prepare('SELECT status, mutation_type FROM events WHERE id = ?').get(base);
  assert.equal(was.status, 'replaced');
  assert.equal(was.mutation_type, 'replaced');
});

test('a create absorbs a projected occurrence, which renders as a tombstone', async () => {
  // The synthetic-id path. The occurrence has never been a row, so the only
  // thing that can record the combine is a schedule_override — and nothing
  // disappears: the instance still projects, pointing at the new event.
  const { raw, db, call } = fresh({ role: 'editor' });
  const [home] = twoParishes(raw);
  const inst = await firstInstance(db, home);

  const r = await call('POST', '/api/admin/events', {
    parish_id: home, title: 'Combined Liturgy', start_utc: inst.start_utc,
    replaced_event_ids: [inst.id],
  });
  assert.equal(r.status, 201, r.body && r.body.error);

  const [scheduleId, date] = String(inst.id).split(':');
  const after = await expandOne(db, Number(scheduleId), date);
  assert.equal(after.status, 'combined');
  assert.equal(after.is_tombstone, 1, 'somebody who would otherwise turn up still sees it');
  assert.equal(after.combined_into_event_id, r.body.id);
});

// ── scope ──

test('a parish contact adds at their own parish and not at another', async () => {
  const { raw, call } = fresh({ role: 'parish', parishIds: [] });
  const [mine, theirs] = twoParishes(raw);
  raw.prepare('UPDATE admin_roles SET parish_ids = ? WHERE email = ?')
    .run(JSON.stringify([mine]), 'dev');

  assert.equal((await call('POST', '/api/admin/events',
    { parish_id: mine, title: 'Feast', start_utc: '2026-09-20T23:00:00.000Z' })).status, 201);

  const no = await call('POST', '/api/admin/events',
    { parish_id: theirs, title: 'Feast', start_utc: '2026-09-20T23:00:00.000Z' });
  assert.equal(no.status, 403);
  assert.match(no.body.error, /not one of yours/);
});

test('a parish contact cannot list their event at somebody else\'s parish', async () => {
  // A combine is the one write where the parish being touched is not the one in
  // the URL. Without the check, scoping is escaped by ticking a box.
  const { raw, call } = fresh({ role: 'parish', parishIds: [] });
  const [mine, theirs] = twoParishes(raw);
  raw.prepare('UPDATE admin_roles SET parish_ids = ? WHERE email = ?')
    .run(JSON.stringify([mine]), 'dev');

  const r = await call('POST', '/api/admin/events', {
    parish_id: mine, title: 'Deanery Liturgy', start_utc: '2026-09-20T23:00:00.000Z',
    additive_parish_ids: [theirs],
  });
  assert.equal(r.status, 403);
  // And the event is not left behind: a row whose whole point was the combine,
  // sitting beside the service it was meant to replace, is worse than nothing.
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
});

test('a parish contact cannot absorb another parish\'s occurrence', async () => {
  const { raw, db, call } = fresh({ role: 'parish', parishIds: [] });
  const [mine, theirs] = twoParishes(raw);
  raw.prepare('UPDATE admin_roles SET parish_ids = ? WHERE email = ?')
    .run(JSON.stringify([mine]), 'dev');
  const inst = await firstInstance(db, theirs);

  const r = await call('POST', '/api/admin/events', {
    parish_id: mine, title: 'Ours', start_utc: inst.start_utc,
    replaced_event_ids: [inst.id],
  });
  assert.equal(r.status, 403);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM schedule_overrides').get().n, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
});

test('an owner and an editor combine across the whole table', async () => {
  for (const role of ['owner', 'editor']) {
    const { raw, call } = fresh({ role });
    const [home, other] = twoParishes(raw);
    const r = await call('POST', '/api/admin/events', {
      parish_id: home, title: 'Deanery Liturgy', start_utc: '2026-09-20T23:00:00.000Z',
      additive_parish_ids: [other],
    });
    assert.equal(r.status, 201, `${role}: ${r.body && r.body.error}`);
  }
});

// ── the existing escalate route, after being refactored onto the same helper ──

test('escalate is still the target state, and still removes what it is not told', async () => {
  const { raw, call } = fresh({ role: 'editor' });
  const [home, other] = twoParishes(raw);

  const created = await call('POST', '/api/admin/events', {
    parish_id: home, title: 'Deanery Liturgy', start_utc: '2026-09-20T23:00:00.000Z',
    additive_parish_ids: [other],
  });
  assert.equal(created.status, 201);

  const cleared = await call('POST', `/api/admin/events/${created.body.id}/escalate`,
    { additive_parish_ids: [] });
  assert.equal(cleared.status, 200);
  assert.deepEqual(cleared.body.additional_parishes, []);
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS n FROM event_parishes WHERE event_id = ?').get(created.body.id).n, 0);

  const readBack = await call('GET', `/api/admin/events/${created.body.id}/escalation`);
  assert.equal(readBack.status, 200);
  assert.deepEqual(readBack.body.additive_parish_ids, []);
});

test('un-absorbing a stored one-off puts it back on the feed', async () => {
  const { raw, call } = fresh({ role: 'editor' });
  const [home] = twoParishes(raw);
  const p = raw.prepare('SELECT lat, lng FROM parishes WHERE id = ?').get(home);
  raw.prepare(
    "INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type, source_hash, lat, lng)" +
    " VALUES (?, 'manual', 'Parish Vespers', '2026-09-20T08:00:00.000Z', 'prayer', 'h-base', ?, ?)"
  ).run(home, p.lat, p.lng);
  const base = raw.prepare("SELECT id FROM events WHERE source_hash = 'h-base'").get().id;

  const created = await call('POST', '/api/admin/events', {
    parish_id: home, title: 'Deanery Vespers', start_utc: '2026-09-20T08:00:00.000Z',
    replaced_event_ids: [base],
  });
  assert.equal(created.status, 201);

  const undone = await call('POST', `/api/admin/events/${created.body.id}/escalate`,
    { replaced_event_ids: [] });
  assert.equal(undone.status, 200);
  const was = raw.prepare('SELECT status, mutation_type FROM events WHERE id = ?').get(base);
  assert.equal(was.status, 'approved');
  assert.equal(was.mutation_type, 'headless');
});

// ── the candidates list the dialog reads ──

test('candidates cover the PARISH\'s local day when the zone is named', async () => {
  // Without `tz` the range is a Sydney day plus slop, which in New Zealand
  // starts at 02:00 local — so the midnight service that is the likeliest thing
  // anybody combines against falls outside it.
  const { raw, call } = fresh({ role: 'editor' });
  const [home] = twoParishes(raw);
  raw.prepare('UPDATE parishes SET timezone = ? WHERE id = ?').run('Pacific/Auckland', home);
  const p = raw.prepare('SELECT lat, lng FROM parishes WHERE id = ?').get(home);
  // 2026-04-12T12:30Z is 00:30 on the 13th in Auckland (+12 in April).
  raw.prepare(
    "INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type, source_hash, lat, lng)" +
    " VALUES (?, 'manual', 'Paschal Liturgy', '2026-04-12T12:30:00.000Z', 'liturgy', 'h-pascha', ?, ?)"
  ).run(home, p.lat, p.lng);

  const withTz = await call('GET', '/api/admin/events/candidates?date=2026-04-13&tz=Pacific/Auckland');
  assert.equal(withTz.status, 200);
  assert.ok(withTz.body.some(e => e.title === 'Paschal Liturgy'),
    'the parish\'s own midnight service is missing from its own day');

  const withoutTz = await call('GET', '/api/admin/events/candidates?date=2026-04-13');
  assert.equal(withoutTz.status, 200);
  assert.ok(!withoutTz.body.some(e => e.title === 'Paschal Liturgy'),
    'the Sydney-shaped fallback is expected to miss it — that is why tz exists');

  // A zone this runtime cannot resolve falls back rather than 500ing.
  const junk = await call('GET', '/api/admin/events/candidates?date=2026-04-13&tz=Mars/Olympus');
  assert.equal(junk.status, 200);
});
