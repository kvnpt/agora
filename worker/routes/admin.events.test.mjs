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
  /** A raw-body request, for the poster uploads — no JSON, a real content type. */
  const callRaw = async (method, url, bytes, contentType) => {
    const res = await router.handle(new Request(`https://orthodoxy.au${url}`, {
      method, body: bytes, headers: { 'Content-Type': contentType },
    }), env, {});
    assert.ok(res, `no route matched ${method} ${url}`);
    let parsed = null;
    try { parsed = await res.clone().json(); } catch { /* not json */ }
    return { status: res.status, body: parsed };
  };

  return { raw, db, call, callRaw, env };
}

const FROM = '2026-09-01T00:00:00.000Z';
const TO = '2026-10-01T00:00:00.000Z';

/** Seeded parishes that have rules, so a combine has somewhere to go. */
function twoParishes(raw, want = 2) {
  const rows = raw.prepare(
    `SELECT DISTINCT p.id FROM parishes p JOIN schedules s ON s.parish_id = p.id
     WHERE p.id != '_unassigned' ORDER BY p.id`
  ).all();
  assert.ok(rows.length >= want, `the seed should have rules at ${want} parishes`);
  return rows.slice(0, want).map(r => r.id);
}

/** A synthetic id back to the [scheduleId, date] pair expandOne takes. */
function splitInstance(id) {
  const [sid, date] = String(id).split(':');
  return [Number(sid), date];
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

// ── asking for what is out of reach ──
//
// A parish contact may combine freely at their own parish and at nobody
// else's. The refusal is not the end of it: the same request with `propose`
// set applies their half and files the rest as an ask, which is what the
// owner sees under Asks and what puts the dot on the account icon.

/** The dev identity as a contact for exactly one parish. */
function contact(raw, parishId) {
  raw.prepare('UPDATE admin_roles SET parish_ids = ? WHERE email = ?')
    .run(JSON.stringify([parishId]), 'dev');
}

test('the refusal names what was out of reach, and offers to carry it', async () => {
  const { raw, db, call } = fresh({ role: 'parish', parishIds: [] });
  const [mine, theirs] = twoParishes(raw);
  contact(raw, mine);
  const inst = await firstInstance(db, theirs);

  const r = await call('POST', '/api/admin/events', {
    parish_id: mine, title: 'Deanery Liturgy', start_utc: inst.start_utc,
    additive_parish_ids: [theirs], replaced_event_ids: [inst.id],
  });
  assert.equal(r.status, 403);
  assert.equal(r.body.proposable, true, 'a dead end is what this exists to stop');
  assert.equal(r.body.capability, 'event.combine');
  // Named, not counted: "some parish is not yours" is not something anybody
  // can act on.
  assert.equal(r.body.outside.length, 2);
  const theirName = raw.prepare('SELECT name FROM parishes WHERE id = ?').get(theirs).name;
  assert.ok(r.body.outside.every(o => o.label.includes(theirName)), JSON.stringify(r.body.outside));
  // Nothing written, event included.
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0);
});

test('proposing applies their own half now and asks for the rest', async () => {
  const { raw, db, call } = fresh({ role: 'parish', parishIds: [] });
  const [mine, theirs] = twoParishes(raw);
  contact(raw, mine);
  const ours = await firstInstance(db, mine);
  const yours = await firstInstance(db, theirs);

  const r = await call('POST', '/api/admin/events', {
    parish_id: mine, title: 'Deanery Liturgy', start_utc: ours.start_utc,
    additive_parish_ids: [theirs],
    replaced_event_ids: [ours.id, yours.id],
    propose: 'We are joining them for the feast',
  });
  assert.equal(r.status, 201, r.body && r.body.error);

  // Their own parish's half is live: the deanery liturgy should not sit
  // unpublished for however long an owner takes to answer.
  const ourAfter = await expandOne(db, ...splitInstance(ours.id));
  assert.equal(ourAfter.status, 'combined');
  // The other parish's is untouched until somebody decides.
  const theirAfter = await expandOne(db, ...splitInstance(yours.id));
  assert.equal(theirAfter.status, 'approved');
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS n FROM event_parishes WHERE event_id = ?').get(r.body.id).n, 0);

  const ask = raw.prepare('SELECT * FROM admin_proposals').get();
  assert.ok(ask, 'nothing was filed');
  assert.equal(r.body.proposal_id, ask.id);
  assert.equal(ask.capability, 'event.combine');
  assert.equal(ask.subject, String(r.body.id));
  assert.equal(ask.status, 'open');
  assert.equal(ask.proposed_by, 'dev');
  assert.equal(ask.reason, 'We are joining them for the feast');
  // The WHOLE desired state, not the refused half — approving replays it
  // through a path that removes whatever the payload does not name.
  const payload = JSON.parse(ask.payload);
  assert.deepEqual(payload.additive_parish_ids, [theirs]);
  assert.deepEqual([...payload.replaced_event_ids].sort(), [ours.id, yours.id].sort());
});

test('an owner sees it as a sentence about parishes, not ids', async () => {
  const { raw, db, call } = fresh({ role: 'parish', parishIds: [] });
  const [mine, theirs] = twoParishes(raw);
  contact(raw, mine);
  const yours = await firstInstance(db, theirs);
  const created = await call('POST', '/api/admin/events', {
    parish_id: mine, title: 'Deanery Liturgy', start_utc: yours.start_utc,
    additive_parish_ids: [theirs], replaced_event_ids: [yours.id], propose: 'Joint feast',
  });
  assert.equal(created.status, 201);

  // Read as the owner the ask is for.
  raw.prepare("UPDATE admin_roles SET role='owner', parish_ids=NULL WHERE email='dev'").run();
  const list = await call('GET', '/api/admin/proposals');
  assert.equal(list.status, 200);
  const row = list.body.find(p => p.capability === 'event.combine');
  assert.ok(row, 'the ask is missing from the panel');
  assert.equal(row.subjectName, 'Deanery Liturgy');
  const theirName = raw.prepare('SELECT name FROM parishes WHERE id = ?').get(theirs).name;
  assert.match(row.summary, /^List “Deanery Liturgy” at /);
  assert.ok(row.summary.includes(theirName), row.summary);
  assert.match(row.summary, /tombstone/, 'the consequence, not just the verb');
  // A date somebody reads, not the join key it is stored as.
  // "6 Sept 2026" — en-AU's short month is three letters or four.
  assert.match(row.summary, / on \d{1,2} [A-Z][a-z]{2,4} \d{4}/, row.summary);
  assert.ok(!row.summary.includes(yours.id), 'a synthetic id leaked into the sentence');
  assert.equal(row.reason, 'Joint feast');
});

test('approving carries out the whole ask; declining carries out none of it', async () => {
  for (const decision of ['approve', 'decline']) {
    const { raw, db, call } = fresh({ role: 'parish', parishIds: [] });
    const [mine, theirs] = twoParishes(raw);
    contact(raw, mine);
    const yours = await firstInstance(db, theirs);
    const created = await call('POST', '/api/admin/events', {
      parish_id: mine, title: 'Deanery Liturgy', start_utc: yours.start_utc,
      additive_parish_ids: [theirs], replaced_event_ids: [yours.id], propose: 'Joint feast',
    });
    assert.equal(created.status, 201);
    const askId = created.body.proposal_id;

    raw.prepare("UPDATE admin_roles SET role='owner', parish_ids=NULL WHERE email='dev'").run();
    const decided = await call('POST', `/api/admin/proposals/${askId}/decide`,
      { decision, note: 'ok' });
    assert.equal(decided.status, 200, JSON.stringify(decided.body));

    const after = await expandOne(db, ...splitInstance(yours.id));
    const crossRows = raw.prepare(
      'SELECT COUNT(*) AS n FROM event_parishes WHERE event_id = ?').get(created.body.id).n;
    if (decision === 'approve') {
      assert.equal(after.status, 'combined', 'approval did not carry out the ask');
      assert.equal(after.combined_into_event_id, created.body.id);
      assert.equal(crossRows, 1);
    } else {
      assert.equal(after.status, 'approved', 'a decline changed the world');
      assert.equal(crossRows, 0);
    }
    assert.equal(
      raw.prepare('SELECT status FROM admin_proposals WHERE id = ?').get(askId).status,
      decision === 'approve' ? 'approved' : 'declined');
  }
});

test('an ask whose targets have since gone is applied without them', async () => {
  // A row can sit for a week. A parish deleted in the meantime is not a reason
  // to refuse the rest of what was asked for.
  const { raw, db, call } = fresh({ role: 'parish', parishIds: [] });
  const [mine, theirs] = twoParishes(raw);
  contact(raw, mine);
  const yours = await firstInstance(db, theirs);
  const created = await call('POST', '/api/admin/events', {
    parish_id: mine, title: 'Deanery Liturgy', start_utc: yours.start_utc,
    additive_parish_ids: [theirs, 'a-parish-that-never-was'],
    replaced_event_ids: [yours.id], propose: 'Joint feast',
  });
  assert.equal(created.status, 201);

  raw.prepare("UPDATE admin_roles SET role='owner', parish_ids=NULL WHERE email='dev'").run();
  const decided = await call('POST', `/api/admin/proposals/${created.body.proposal_id}/decide`,
    { decision: 'approve' });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.deepEqual(decided.body.dropped, ['a-parish-that-never-was']);
  assert.equal((await expandOne(db, ...splitInstance(yours.id))).status, 'combined');
});

test('an ask about an event that has since been deleted cannot be approved', async () => {
  const { raw, db, call } = fresh({ role: 'parish', parishIds: [] });
  const [mine, theirs] = twoParishes(raw);
  contact(raw, mine);
  const yours = await firstInstance(db, theirs);
  const created = await call('POST', '/api/admin/events', {
    parish_id: mine, title: 'Deanery Liturgy', start_utc: yours.start_utc,
    additive_parish_ids: [theirs], propose: 'Joint feast',
  });
  assert.equal(created.status, 201);
  raw.prepare('DELETE FROM events WHERE id = ?').run(created.body.id);

  raw.prepare("UPDATE admin_roles SET role='owner', parish_ids=NULL WHERE email='dev'").run();
  const decided = await call('POST', `/api/admin/proposals/${created.body.proposal_id}/decide`,
    { decision: 'approve' });
  assert.equal(decided.status, 410);
  assert.match(decided.body.error, /no longer exists/);
});

test('an owner combining is never turned into an ask', async () => {
  // `propose` is a flag on a refusal, not a mode. An owner is refused nothing,
  // so the combine simply happens and no row is filed.
  const { raw, db, call } = fresh({ role: 'owner' });
  const [home, other] = twoParishes(raw);
  const inst = await firstInstance(db, other);
  const r = await call('POST', '/api/admin/events', {
    parish_id: home, title: 'Deanery Liturgy', start_utc: inst.start_utc,
    additive_parish_ids: [other], replaced_event_ids: [inst.id], propose: 'please',
  });
  assert.equal(r.status, 201, r.body && r.body.error);
  assert.equal(r.body.proposal_id, null);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM admin_proposals').get().n, 0);
  assert.equal((await expandOne(db, ...splitInstance(inst.id))).status, 'combined');
});

test('a contact cannot ask about somebody else\'s event, or ask for what they already have', async () => {
  const { raw, db, call } = fresh({ role: 'parish', parishIds: [] });
  const [mine, theirs] = twoParishes(raw);
  contact(raw, mine);
  const ours = await firstInstance(db, mine);

  // Their own event, but every target already theirs: there is nothing to ask.
  const own = await call('POST', '/api/admin/events',
    { parish_id: mine, title: 'Ours', start_utc: ours.start_utc });
  assert.equal(own.status, 201);
  const pointless = await call('POST', '/api/admin/proposals', {
    capability: 'event.combine', subject: String(own.body.id),
    payload: { replaced_event_ids: [ours.id] },
  });
  assert.equal(pointless.status, 400);
  assert.match(pointless.body.error, /do that yourself/);

  // Somebody else's event is not theirs to ask about either — that is the
  // refusal wearing a different hat.
  const p = raw.prepare('SELECT lat, lng FROM parishes WHERE id = ?').get(theirs);
  raw.prepare("INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type, source_hash, lat, lng)"
    + " VALUES (?, 'manual','Theirs','2026-09-20T08:00:00.000Z','feast','h-t',?,?)").run(theirs, p.lat, p.lng);
  const notMine = raw.prepare("SELECT id FROM events WHERE source_hash='h-t'").get().id;
  const sneaky = await call('POST', '/api/admin/proposals', {
    capability: 'event.combine', subject: String(notMine),
    payload: { additive_parish_ids: [mine] },
  });
  assert.equal(sneaky.status, 403);
  assert.match(sneaky.body.error, /not one of yours/);
});

// ── the dot ──

test('the account icon counts asks only for somebody who can decide one', async () => {
  const { raw, call } = fresh({ role: 'parish', parishIds: [] });
  const [mine, theirs] = twoParishes(raw);
  contact(raw, mine);

  assert.equal((await call('GET', '/api/admin/ping')).body.openAsks, 0);
  await call('POST', '/api/admin/events', {
    parish_id: mine, title: 'Deanery Liturgy', start_utc: '2026-09-20T23:00:00.000Z',
    additive_parish_ids: [theirs], propose: 'Joint feast',
  });
  // Still zero: a dot on somebody who can only look at it is noise.
  assert.equal((await call('GET', '/api/admin/ping')).body.openAsks, 0);

  raw.prepare("UPDATE admin_roles SET role='editor', parish_ids=NULL WHERE email='dev'").run();
  assert.equal((await call('GET', '/api/admin/ping')).body.openAsks, 0,
    'an editor cannot decide one either');

  raw.prepare("UPDATE admin_roles SET role='owner' WHERE email='dev'").run();
  const ping = await call('GET', '/api/admin/ping');
  assert.equal(ping.body.openAsks, 1);

  const id = raw.prepare('SELECT id FROM admin_proposals').get().id;
  await call('POST', `/api/admin/proposals/${id}/decide`, { decision: 'decline', note: 'no' });
  assert.equal((await call('GET', '/api/admin/ping')).body.openAsks, 0,
    'a decided ask is not still waiting');
});

// ── the subject, as against the targets ──
//
// `applyEscalation` scopes what a combine REACHES. These scope whose event it
// is in the first place, which is a different question and was not being asked
// at all: `event.edit` is on all three role lists precisely because the parish
// scoping is supposed to be what holds a contact to their own.

test('a contact cannot strip the combine off somebody else\'s event', async () => {
  // The hole the body's own semantics opened: escalate is a target state and
  // removes anything it is not told about, so an EMPTY body named no targets,
  // ran no target check, and cleared every parish and every absorbed service
  // off any event on the site.
  const { raw, call } = fresh({ role: 'parish', parishIds: [] });
  const [mine, theirs, third] = twoParishes(raw, 3);
  contact(raw, mine);

  const p = raw.prepare('SELECT lat, lng FROM parishes WHERE id = ?').get(theirs);
  raw.prepare("INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type, source_hash, lat, lng)"
    + " VALUES (?, 'manual','Theirs','2026-09-20T08:00:00.000Z','feast','h-t',?,?)").run(theirs, p.lat, p.lng);
  const ev = raw.prepare("SELECT id FROM events WHERE source_hash='h-t'").get().id;
  raw.prepare('INSERT INTO event_parishes (event_id, parish_id) VALUES (?,?)').run(ev, third);

  const r = await call('POST', `/api/admin/events/${ev}/escalate`,
    { additive_parish_ids: [], replaced_event_ids: [] });
  assert.equal(r.status, 403);
  assert.match(r.body.error, /not one of yours/);
  assert.equal(
    raw.prepare('SELECT COUNT(*) AS n FROM event_parishes WHERE event_id = ?').get(ev).n, 1,
    'the combine was cleared by somebody with no claim on the event');
});

test('a contact cannot edit or delete another parish\'s event', async () => {
  const { raw, call } = fresh({ role: 'parish', parishIds: [] });
  const [mine, theirs] = twoParishes(raw);
  contact(raw, mine);
  const p = raw.prepare('SELECT lat, lng FROM parishes WHERE id = ?').get(theirs);
  raw.prepare("INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type, source_hash, lat, lng)"
    + " VALUES (?, 'manual','Theirs','2026-09-20T08:00:00.000Z','feast','h-t',?,?)").run(theirs, p.lat, p.lng);
  const ev = raw.prepare("SELECT id FROM events WHERE source_hash='h-t'").get().id;

  assert.equal((await call('PATCH', `/api/admin/events/${ev}`, { title: 'Renamed' })).status, 403);
  assert.equal(raw.prepare('SELECT title FROM events WHERE id = ?').get(ev).title, 'Theirs');
  assert.equal((await call('DELETE', `/api/admin/events/${ev}`)).status, 403);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM events WHERE id = ?').get(ev).n, 1);

  // Their own is untouched by the guard.
  const ours = await call('POST', '/api/admin/events',
    { parish_id: mine, title: 'Ours', start_utc: '2026-09-20T23:00:00.000Z' });
  assert.equal(ours.status, 201);
  assert.equal((await call('PATCH', `/api/admin/events/${ours.body.id}`, { title: 'Renamed' })).status, 200);
  assert.equal((await call('DELETE', `/api/admin/events/${ours.body.id}`)).status, 200);
});

test('a contact cannot move an event out of, or into, their own parish', async () => {
  // Scoped against where it is GOING as well as where it is: handing an event
  // to a parish that is not yours is a write to that parish, and handing one
  // away is how a scope is escaped in a single PATCH.
  const { raw, call } = fresh({ role: 'parish', parishIds: [] });
  const [mine, theirs] = twoParishes(raw);
  contact(raw, mine);
  const ours = await call('POST', '/api/admin/events',
    { parish_id: mine, title: 'Ours', start_utc: '2026-09-20T23:00:00.000Z' });
  assert.equal(ours.status, 201);

  const moved = await call('PATCH', `/api/admin/events/${ours.body.id}`, { parish_id: theirs });
  assert.equal(moved.status, 403);
  assert.equal(raw.prepare('SELECT parish_id FROM events WHERE id = ?').get(ours.body.id).parish_id, mine);
});

test('a contact cannot patch or hide another parish\'s occurrence', async () => {
  // A synthetic id names a RULE's occurrence, so the parish is the rule's and
  // is nowhere in the URL.
  const { raw, db, call } = fresh({ role: 'parish', parishIds: [] });
  const [mine, theirs] = twoParishes(raw);
  contact(raw, mine);
  const ours = await firstInstance(db, mine);
  const yours = await firstInstance(db, theirs);

  assert.equal((await call('PATCH', `/api/admin/events/${yours.id}`, { title: 'Renamed' })).status, 403);
  assert.equal((await call('DELETE', `/api/admin/events/${yours.id}`)).status, 403);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM schedule_overrides').get().n, 0);

  // Their own rule's occurrence still edits.
  assert.equal((await call('PATCH', `/api/admin/events/${ours.id}`, { title: 'This week only' })).status, 200);
});

test('an owner and an editor are unaffected by all of it', async () => {
  for (const role of ['owner', 'editor']) {
    const { raw, db, call } = fresh({ role });
    const [home, other] = twoParishes(raw);
    const inst = await firstInstance(db, other);
    const made = await call('POST', '/api/admin/events',
      { parish_id: other, title: 'Theirs', start_utc: '2026-09-20T23:00:00.000Z' });
    assert.equal(made.status, 201, `${role} create`);
    assert.equal((await call('PATCH', `/api/admin/events/${made.body.id}`, { title: 'R' })).status, 200, `${role} patch`);
    assert.equal((await call('PATCH', `/api/admin/events/${made.body.id}`, { parish_id: home })).status, 200, `${role} move`);
    assert.equal((await call('POST', `/api/admin/events/${made.body.id}/escalate`,
      { additive_parish_ids: [other] })).status, 200, `${role} escalate`);
    assert.equal((await call('PATCH', `/api/admin/events/${inst.id}`, { title: 'R' })).status, 200, `${role} patch instance`);
    assert.equal((await call('DELETE', `/api/admin/events/${made.body.id}`)).status, 200, `${role} delete`);
  }
});

// ── posters ──
//
// `events.poster_path` outlived the WhatsApp ingestor that filled it; a
// schedule occurrence never had anywhere to put one, because a rule has no
// flyer. One route, routed by the shape of the id, like the rest of this file.

/** A minimal R2 stand-in: enough to record what was put and deleted. */
function bucket() {
  const store = new Map();
  const deleted = [];
  return {
    store, deleted,
    async put(key, body, opts) { store.set(key, { size: body.byteLength, opts }); },
    async delete(keys) {
      for (const k of (Array.isArray(keys) ? keys : [keys])) { deleted.push(k); store.delete(k); }
    },
  };
}

const png = () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

/** POST/DELETE a poster; `fresh` gives no ASSETS_BUCKET, so pass one in. */
function withBucket(fixture) {
  const b = bucket();
  fixture.env.ASSETS_BUCKET = b;
  return b;
}

test('a poster on a stored event lands in R2 and on the row', async () => {
  const f = fresh({ role: 'editor' });
  const b = withBucket(f);
  const [parishId] = twoParishes(f.raw);
  const made = await f.call('POST', '/api/admin/events',
    { parish_id: parishId, title: 'Parish Feast', start_utc: '2026-09-20T23:00:00.000Z' });
  assert.equal(made.status, 201);

  const r = await f.callRaw('POST', `/api/admin/events/${made.body.id}/poster`, png(), 'image/png');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.poster_path, new RegExp(`^/posters/${made.body.id}\\.png\\?v=\\d+$`));
  assert.ok(b.store.has(`posters/${made.body.id}.png`), [...b.store.keys()].join(','));
  assert.equal(
    f.raw.prepare('SELECT poster_path FROM events WHERE id = ?').get(made.body.id).poster_path,
    r.body.poster_path);
  // The other extensions are swept, so replacing a jpg with a png leaves one.
  assert.ok(b.deleted.includes(`posters/${made.body.id}.jpg`), b.deleted.join(','));
});

test('a poster on an occurrence writes an override and projects', async () => {
  const f = fresh({ role: 'editor' });
  const b = withBucket(f);
  const [parishId] = twoParishes(f.raw);
  const inst = await firstInstance(f.db, parishId);
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM schedule_overrides').get().n, 0);

  const r = await f.callRaw('POST', `/api/admin/events/${inst.id}/poster`, png(), 'image/jpeg');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  // The colon is not a key separator in R2 — it becomes a dash.
  assert.match(r.body.poster_path, /^\/posters\/\d+-\d{4}-\d{2}-\d{2}\.jpg\?v=\d+$/);

  const [sid, date] = splitInstance(inst.id);
  const row = f.raw.prepare(
    'SELECT * FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?').get(sid, date);
  assert.ok(row, 'no override was written');
  assert.equal(row.patch_poster_path, r.body.poster_path);
  assert.equal(row.kind, 'modified');

  // It projects onto that one occurrence and no other.
  const after = await expandOne(f.db, sid, date);
  assert.equal(after.poster_path, r.body.poster_path);
  const all = await expandWindow(f.db, FROM, TO);
  const others = all.filter(e => e.schedule_id === sid && e.id !== inst.id);
  assert.ok(others.length, 'the rule should produce more than one occurrence');
  assert.ok(others.every(e => !e.poster_path), 'a poster leaked onto the weeks either side');
});

test('clearing an occurrence poster drops the override it was holding open', async () => {
  // A poster-only override modifies nothing once the poster goes, and an
  // override that modifies nothing is not an override.
  const f = fresh({ role: 'editor' });
  const b = withBucket(f);
  const [parishId] = twoParishes(f.raw);
  const inst = await firstInstance(f.db, parishId);
  const [sid, date] = splitInstance(inst.id);

  assert.equal((await f.callRaw('POST', `/api/admin/events/${inst.id}/poster`, png(), 'image/png')).status, 200);
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM schedule_overrides').get().n, 1);

  const del = await f.call('DELETE', `/api/admin/events/${inst.id}/poster`);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM schedule_overrides').get().n, 0);
  assert.equal((await expandOne(f.db, sid, date)).poster_path, null);
  assert.ok(b.deleted.includes(`posters/${sid}-${date}.png`), b.deleted.join(','));
});

test('a poster does not disturb a cancellation the occurrence already carries', async () => {
  const f = fresh({ role: 'editor' });
  withBucket(f);
  const [parishId] = twoParishes(f.raw);
  const inst = await firstInstance(f.db, parishId);
  const [sid, date] = splitInstance(inst.id);

  assert.equal((await f.call('PATCH', `/api/admin/events/${inst.id}`, { status: 'cancelled' })).status, 200);
  assert.equal((await f.callRaw('POST', `/api/admin/events/${inst.id}/poster`, png(), 'image/png')).status, 200);

  const after = await expandOne(f.db, sid, date);
  assert.equal(after.status, 'cancelled', 'the poster overwrote the tombstone');
  assert.equal(after.is_tombstone, 1);
  assert.ok(after.poster_path, 'the poster did not stick');
});

test('a poster is refused for another parish, and when there is nothing to put it on', async () => {
  const f = fresh({ role: 'parish', parishIds: [] });
  withBucket(f);
  const [mine, theirs] = twoParishes(f.raw);
  contact(f.raw, mine);
  const theirInst = await firstInstance(f.db, theirs);

  assert.equal((await f.callRaw('POST', `/api/admin/events/${theirInst.id}/poster`, png(), 'image/png')).status, 403);
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM schedule_overrides').get().n, 0);
  assert.equal((await f.call('DELETE', `/api/admin/events/${theirInst.id}/poster`)).status, 403);
  assert.equal((await f.callRaw('POST', '/api/admin/events/99999/poster', png(), 'image/png')).status, 404);

  // Their own occurrence is fine.
  const mineInst = await firstInstance(f.db, mine);
  assert.equal((await f.callRaw('POST', `/api/admin/events/${mineInst.id}/poster`, png(), 'image/png')).status, 200);
});

test('an empty or oversized poster is refused before anything is written', async () => {
  const f = fresh({ role: 'editor' });
  const b = withBucket(f);
  const [parishId] = twoParishes(f.raw);
  const made = await f.call('POST', '/api/admin/events',
    { parish_id: parishId, title: 'Feast', start_utc: '2026-09-20T23:00:00.000Z' });

  assert.equal((await f.callRaw('POST', `/api/admin/events/${made.body.id}/poster`,
    new Uint8Array(0), 'image/png')).status, 400);
  assert.equal((await f.callRaw('POST', `/api/admin/events/${made.body.id}/poster`,
    new Uint8Array(8 * 1024 * 1024 + 1), 'image/png')).status, 413);
  assert.equal(b.store.size, 0);
  assert.equal(f.raw.prepare('SELECT poster_path FROM events WHERE id = ?').get(made.body.id).poster_path, null);
});

test('without R2 bound the upload says so rather than half-writing', async () => {
  const f = fresh({ role: 'editor' });
  const [parishId] = twoParishes(f.raw);
  const made = await f.call('POST', '/api/admin/events',
    { parish_id: parishId, title: 'Feast', start_utc: '2026-09-20T23:00:00.000Z' });
  const r = await f.callRaw('POST', `/api/admin/events/${made.body.id}/poster`, png(), 'image/png');
  assert.equal(r.status, 503);
  assert.equal(f.raw.prepare('SELECT poster_path FROM events WHERE id = ?').get(made.body.id).poster_path, null);
});

// ── told, not asked ──
//
// An owner may combine across parishes without asking, because waiting on a
// quorum of contacts who mostly do not exist would mean a deanery liturgy never
// gets published. The parish it happens to still hears about it, and can take
// itself back out. The notice is derived from the rows that already exist.

test('a contact is told what another parish\'s event is doing at theirs', async () => {
  const f = fresh({ role: 'parish', parishIds: [] });
  const [mine, theirs] = twoParishes(f.raw);
  contact(f.raw, mine);

  // An owner does the combine, reaching into `mine` both ways.
  f.raw.prepare("UPDATE admin_roles SET role='owner', parish_ids=NULL WHERE email='dev'").run();
  const myInst = await firstInstance(f.db, mine);
  const made = await f.call('POST', '/api/admin/events', {
    parish_id: theirs, title: 'Deanery Liturgy', start_utc: myInst.start_utc,
    additive_parish_ids: [mine], replaced_event_ids: [myInst.id],
  });
  assert.equal(made.status, 201, made.body && made.body.error);

  // Back as the contact.
  contact(f.raw, mine);
  f.raw.prepare("UPDATE admin_roles SET role='parish' WHERE email='dev'").run();
  const notices = await f.call('GET', '/api/admin/parish-notices');
  assert.equal(notices.status, 200);
  assert.equal(notices.body.length, 2, JSON.stringify(notices.body));
  const kinds = notices.body.map(n => n.kind).sort();
  assert.deepEqual(kinds, ['absorbed', 'listed']);
  // Sentences, not ids — the reader is a parish priest, not a DBA.
  const absorbed = notices.body.find(n => n.kind === 'absorbed');
  assert.match(absorbed.detail, /is combined into “Deanery Liturgy”/);
  assert.match(absorbed.detail, /tombstone/);
  assert.ok(notices.body.every(n => n.seen === false));

  // And the dot counts them, for somebody who decides nothing.
  const ping = await f.call('GET', '/api/admin/ping');
  assert.equal(ping.body.openAsks, 0, 'a contact decides nothing');
  assert.equal(ping.body.parishNotices, 2);
});

test('marking one seen takes it off the dot but leaves it on the list', async () => {
  const f = fresh({ role: 'owner' });
  const [mine, theirs] = twoParishes(f.raw);
  const made = await f.call('POST', '/api/admin/events', {
    parish_id: theirs, title: 'Deanery Liturgy', start_utc: '2026-09-20T23:00:00.000Z',
    additive_parish_ids: [mine],
  });
  f.raw.prepare("UPDATE admin_roles SET role='parish', parish_ids=? WHERE email='dev'")
    .run(JSON.stringify([mine]));

  assert.equal((await f.call('GET', '/api/admin/ping')).body.parishNotices, 1);
  const seen = await f.call('POST', '/api/admin/parish-notices/seen',
    { parish_id: mine, event_id: made.body.id });
  assert.equal(seen.status, 200);
  assert.equal((await f.call('GET', '/api/admin/ping')).body.parishNotices, 0);
  // Still there — seen is not gone.
  const after = await f.call('GET', '/api/admin/parish-notices');
  assert.equal(after.body.length, 1);
  assert.equal(after.body[0].seen, true);
  // Idempotent.
  assert.equal((await f.call('POST', '/api/admin/parish-notices/seen',
    { parish_id: mine, event_id: made.body.id })).status, 200);
});

test('withdrawing takes the parish out and gives its occurrence back', async () => {
  const f = fresh({ role: 'owner' });
  const [mine, theirs] = twoParishes(f.raw);
  const myInst = await firstInstance(f.db, mine);
  const made = await f.call('POST', '/api/admin/events', {
    parish_id: theirs, title: 'Deanery Liturgy', start_utc: myInst.start_utc,
    additive_parish_ids: [mine], replaced_event_ids: [myInst.id],
  });
  assert.equal(made.status, 201);
  const [sid, date] = splitInstance(myInst.id);
  assert.equal((await expandOne(f.db, sid, date)).status, 'combined');

  f.raw.prepare("UPDATE admin_roles SET role='parish', parish_ids=? WHERE email='dev'")
    .run(JSON.stringify([mine]));
  const out = await f.call('POST', `/api/admin/parishes/${mine}/withdraw`, { event_id: made.body.id });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.restored, 1);

  // Their Sunday is back, and the listing is gone.
  assert.equal((await expandOne(f.db, sid, date)).status, 'approved');
  assert.equal(f.raw.prepare(
    'SELECT COUNT(*) AS n FROM event_parishes WHERE event_id = ?').get(made.body.id).n, 0);
  // The event itself is untouched — this is not a delete, and it reaches
  // nothing at the parish that owns it.
  assert.equal(f.raw.prepare('SELECT parish_id FROM events WHERE id = ?').get(made.body.id).parish_id, theirs);
  assert.equal((await f.call('GET', '/api/admin/parish-notices')).body.length, 0);
});

test('a contact cannot withdraw another parish, or the event\'s own', async () => {
  const f = fresh({ role: 'owner' });
  const [mine, theirs] = twoParishes(f.raw);
  const made = await f.call('POST', '/api/admin/events', {
    parish_id: theirs, title: 'Deanery Liturgy', start_utc: '2026-09-20T23:00:00.000Z',
    additive_parish_ids: [mine],
  });
  f.raw.prepare("UPDATE admin_roles SET role='parish', parish_ids=? WHERE email='dev'")
    .run(JSON.stringify([mine]));

  const other = await f.call('POST', `/api/admin/parishes/${theirs}/withdraw`, { event_id: made.body.id });
  assert.equal(other.status, 403);
  assert.match(other.body.error, /not one of yours/);
  assert.equal(f.raw.prepare(
    'SELECT COUNT(*) AS n FROM event_parishes WHERE event_id = ?').get(made.body.id).n, 1);

  // And the owning parish cannot be withdrawn from its own event — that would
  // leave it belonging nowhere, and deleting is a different button.
  f.raw.prepare("UPDATE admin_roles SET parish_ids=? WHERE email='dev'").run(JSON.stringify([theirs]));
  const own = await f.call('POST', `/api/admin/parishes/${theirs}/withdraw`, { event_id: made.body.id });
  assert.equal(own.status, 400);
  assert.match(own.body.error, /Delete it instead/);
});

test('an account with no parishes has no notices and no dot from them', async () => {
  const f = fresh({ role: 'editor' });
  const [a, b] = twoParishes(f.raw);
  await f.call('POST', '/api/admin/events', {
    parish_id: b, title: 'Deanery Liturgy', start_utc: '2026-09-20T23:00:00.000Z',
    additive_parish_ids: [a],
  });
  assert.deepEqual((await f.call('GET', '/api/admin/parish-notices')).body, []);
  assert.equal((await f.call('GET', '/api/admin/ping')).body.parishNotices, 0);
});

// ── a decided ask stops vanishing ──

test('a proposer can read their own ask after it is decided, note and all', async () => {
  const f = fresh({ role: 'parish', parishIds: [] });
  const [mine, theirs] = twoParishes(f.raw);
  contact(f.raw, mine);
  const made = await f.call('POST', '/api/admin/events', {
    parish_id: mine, title: 'Deanery Liturgy', start_utc: '2026-09-20T23:00:00.000Z',
    additive_parish_ids: [theirs], propose: 'Joint feast',
  });
  assert.equal(made.status, 201);

  // The default list is open-only, which is what made it vanish.
  assert.equal((await f.call('GET', '/api/admin/proposals')).body.length, 1);
  assert.equal((await f.call('GET', '/api/admin/proposals?mine=1')).body.length, 1);

  f.raw.prepare("UPDATE admin_roles SET role='owner', parish_ids=NULL WHERE email='dev'").run();
  assert.equal((await f.call('POST', `/api/admin/proposals/${made.body.proposal_id}/decide`,
    { decision: 'decline', note: 'Not this year — we have our own vigil.' })).status, 200);

  assert.equal((await f.call('GET', '/api/admin/proposals')).body.length, 0, 'still open?');
  const mineList = await f.call('GET', '/api/admin/proposals?mine=1');
  assert.equal(mineList.body.length, 1, 'the proposer lost sight of their own ask');
  assert.equal(mineList.body[0].status, 'declined');
  // The note is the whole point of forcing one.
  assert.equal(mineList.body[0].decisionNote, 'Not this year — we have our own vigil.');
  assert.equal(mineList.body[0].decidedBy, 'dev');
});

// ── one poster across a range ──
//
// A parish bulletin covers a period — Crows Nest's covers September — so the
// upload names a range and every service in it points at ONE object. Not the
// rule: next month's Liturgy must not carry this month's commemorations.

const SEPT = 'scope=rule&from=2026-09-01&until=2026-09-30';

/** Every occurrence of rule `sid` in September, by date. */
async function septemberOf(db, sid) {
  const all = await expandWindow(db, FROM, '2026-10-02T00:00:00.000Z');
  return all.filter(e => e.schedule_id === sid && e.id.split(':')[1].startsWith('2026-09'));
}

test('a range poster lands on every occurrence of the rule in range, as one object', async () => {
  const f = fresh({ role: 'editor' });
  const b = withBucket(f);
  const [parishId] = twoParishes(f.raw);
  const inst = await firstInstance(f.db, parishId);
  const [sid] = splitInstance(inst.id);
  const sept = await septemberOf(f.db, sid);
  assert.ok(sept.length >= 4, 'a weekly rule has four or five Septembers');

  const r = await f.callRaw('POST', `/api/admin/events/${inst.id}/poster?${SEPT}`, png(), 'image/png');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.count, sept.length);
  assert.match(r.body.poster_path, new RegExp(`^/posters/${parishId}-2026-09-01-2026-09-30-[a-z0-9]+\\.png$`));
  assert.equal(b.store.size, 1, 'one object, not one per service');

  for (const e of sept) {
    assert.equal((await expandOne(f.db, sid, e.id.split(':')[1])).poster_path, r.body.poster_path, e.id);
  }
  // October is outside the bulletin.
  const oct = (await expandWindow(f.db, '2026-10-02T00:00:00.000Z', '2026-10-31T00:00:00.000Z'))
    .filter(e => e.schedule_id === sid);
  assert.ok(oct.length && oct.every(e => !e.poster_path), 'the poster leaked past the range');
});

test('a parish range covers every rule and the one-offs in range, and nothing outside it', async () => {
  const f = fresh({ role: 'editor' });
  withBucket(f);
  const [parishId] = twoParishes(f.raw);
  const inst = await firstInstance(f.db, parishId);
  f.raw.prepare(`INSERT INTO schedules (parish_id, day_of_week, start_time, title, event_type)
                 VALUES (?, 1, '18:00', 'Paraklesis', 'prayer')`).run(parishId);
  const inRange = await f.call('POST', '/api/admin/events',
    { parish_id: parishId, title: 'Feast', start_utc: '2026-09-07T23:00:00.000Z' });
  const after = await f.call('POST', '/api/admin/events',
    { parish_id: parishId, title: 'Later', start_utc: '2026-10-07T23:00:00.000Z' });

  const r = await f.callRaw('POST',
    `/api/admin/events/${inst.id}/poster?scope=parish&from=2026-09-01&until=2026-09-30`, png(), 'image/jpeg');
  assert.equal(r.status, 200, JSON.stringify(r.body));

  const sept = (await expandWindow(f.db, FROM, '2026-10-01T00:00:00.000Z'))
    .filter(e => e.parish_id === parishId && e.id.split(':')[1] <= '2026-09-30');
  assert.ok(sept.some(e => e.title === 'Paraklesis'), 'the second rule projects');
  assert.ok(sept.every(e => e.poster_path === r.body.poster_path), 'a rule in range was missed');
  const ev = (id) => f.raw.prepare('SELECT poster_path FROM events WHERE id = ?').get(id).poster_path;
  assert.equal(ev(inRange.body.id), r.body.poster_path);
  assert.equal(ev(after.body.id), null);
  assert.equal(r.body.count, sept.length + 1);
});

test('a range keeps what each occurrence is, and skips a break and a hidden one', async () => {
  const f = fresh({ role: 'editor' });
  withBucket(f);
  const [parishId] = twoParishes(f.raw);
  const inst = await firstInstance(f.db, parishId);
  const [sid] = splitInstance(inst.id);
  const dates = (await septemberOf(f.db, sid)).map(e => e.id.split(':')[1]);
  const [cancelled, feast, hidden, onBreak] = dates;

  await f.call('PATCH', `/api/admin/events/${sid}:${cancelled}`, { status: 'cancelled' });
  await f.call('PATCH', `/api/admin/events/${sid}:${feast}`, { feast: 'Nativity of the Theotokos' });
  await f.call('DELETE', `/api/admin/events/${sid}:${hidden}`);
  f.raw.prepare(`INSERT INTO schedule_breaks (parish_id, schedule_id, from_date, to_date, note)
                 VALUES (?, ?, ?, ?, 'Priest away')`).run(parishId, sid, onBreak, onBreak);

  const r = await f.callRaw('POST', `/api/admin/events/${sid}:${cancelled}/poster?${SEPT}`, png(), 'image/png');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.count, dates.length - 2);

  const c = await expandOne(f.db, sid, cancelled);
  assert.equal(c.status, 'cancelled', 'the poster revived a cancelled service');
  assert.equal(c.poster_path, r.body.poster_path);
  const fe = await expandOne(f.db, sid, feast);
  assert.equal(fe.feast, 'Nativity of the Theotokos', 'the poster wiped the commemoration');
  assert.equal(fe.poster_path, r.body.poster_path);
  const ov = (d) => f.raw.prepare(
    'SELECT * FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?').get(sid, d);
  assert.equal(ov(hidden).kind, 'hidden');
  assert.equal(ov(hidden).patch_poster_path, null);
  assert.equal(ov(onBreak), undefined, 'an override on a break date would bring the service back');
  assert.equal((await expandOne(f.db, sid, onBreak)).is_tombstone, 1);
});

test('a bulletin is released only when nothing shows it, and comes down in one go', async () => {
  const f = fresh({ role: 'editor' });
  const b = withBucket(f);
  const [parishId] = twoParishes(f.raw);
  const inst = await firstInstance(f.db, parishId);
  const [sid] = splitInstance(inst.id);
  const dates = (await septemberOf(f.db, sid)).map(e => e.id.split(':')[1]);
  await f.call('PATCH', `/api/admin/events/${sid}:${dates[1]}`, { feast: 'Exaltation of the Cross' });

  const first = await f.callRaw('POST', `/api/admin/events/${inst.id}/poster?${SEPT}`, png(), 'image/png');
  const key1 = first.body.poster_path.slice(1);

  // Off one Sunday: the others keep it, so the object stays.
  assert.equal((await f.call('DELETE', `/api/admin/events/${sid}:${dates[0]}/poster`)).status, 200);
  assert.equal((await expandOne(f.db, sid, dates[0])).poster_path, null);
  assert.equal((await expandOne(f.db, sid, dates[2])).poster_path, first.body.poster_path);
  assert.ok(b.store.has(key1), 'a shared poster was deleted while others still show it');

  // A corrected bulletin replaces it everywhere; the first is no longer shown, so it goes.
  const second = await f.callRaw('POST', `/api/admin/events/${sid}:${dates[2]}/poster?${SEPT}`, png(), 'image/jpeg');
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.ok(!b.store.has(key1), 'the replaced bulletin was left behind in R2');
  const key2 = second.body.poster_path.slice(1);

  // Down everywhere at once: poster-only overrides go, the commemoration stays.
  const del = await f.call('DELETE', `/api/admin/events/${sid}:${dates[2]}/poster?everywhere`);
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(del.body.count, dates.length);
  for (const d of dates) assert.equal((await expandOne(f.db, sid, d)).poster_path, null, d);
  assert.equal((await expandOne(f.db, sid, dates[1])).feast, 'Exaltation of the Cross');
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM schedule_overrides').get().n, 1);
  assert.ok(!b.store.has(key2));
});

test('a range is refused before anything is stored when it cannot mean anything', async () => {
  const f = fresh({ role: 'editor' });
  const b = withBucket(f);
  const [parishId] = twoParishes(f.raw);
  const inst = await firstInstance(f.db, parishId);
  const made = await f.call('POST', '/api/admin/events',
    { parish_id: parishId, title: 'Feast', start_utc: '2026-09-20T23:00:00.000Z' });
  const bad = [
    [inst.id, 'scope=rule&from=2026-10-01&until=2026-10-31'],   // does not include this service
    [inst.id, 'scope=rule&from=2026-09-30&until=2026-09-01'],   // backwards
    [inst.id, 'scope=rule&from=2026-09-01&until=2027-12-31'],   // over a year
    [inst.id, 'scope=rule&from=2026-02-30&until=2026-09-30'],   // not a date
    [inst.id, 'scope=forever&from=2026-09-01&until=2026-09-30'],
    [made.body.id, 'scope=rule&from=2026-09-01&until=2026-09-30'], // a one-off has no rule
  ];
  for (const [id, q] of bad) {
    const r = await f.callRaw('POST', `/api/admin/events/${id}/poster?${q}`, png(), 'image/png');
    assert.equal(r.status, 400, `${q}: ${JSON.stringify(r.body)}`);
  }
  assert.equal(b.store.size, 0);
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM schedule_overrides').get().n, 0);

  // A one-off can anchor a parish range.
  const ok = await f.callRaw('POST',
    `/api/admin/events/${made.body.id}/poster?scope=parish&from=2026-09-01&until=2026-09-30`, png(), 'image/png');
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
});

test('a parish contact cannot range a poster over another parish', async () => {
  const f = fresh({ role: 'parish', parishIds: [] });
  const b = withBucket(f);
  const [mine, theirs] = twoParishes(f.raw);
  contact(f.raw, mine);
  const theirInst = await firstInstance(f.db, theirs);
  const r = await f.callRaw('POST', `/api/admin/events/${theirInst.id}/poster?${SEPT}`, png(), 'image/png');
  assert.equal(r.status, 403);
  assert.equal(b.store.size, 0);
});

// ── this and every following ──
//
// The question a calendar asks of a repeating event, answered with the rule's
// own dates: end it before a date, or change it from a date on by closing the
// old rule and opening a new one. Past dates must keep what they were.

/** A rule and four of its September dates, for the split tests. */
async function septRule(f) {
  const [parishId] = twoParishes(f.raw);
  const inst = await firstInstance(f.db, parishId);
  const [sid] = splitInstance(inst.id);
  const dates = (await septemberOf(f.db, sid)).map(e => e.id.split(':')[1]);
  const rule = f.raw.prepare('SELECT * FROM schedules WHERE id = ?').get(sid);
  return { parishId, sid, dates, rule };
}

/** The drawer's body for an occurrence, with its start moved to `hhmm` Sydney time. */
function drawerBody(date, hhmm, extra = {}) {
  // September in Sydney is +10:00 (DST starts 4 Oct 2026).
  const [h, m] = hhmm.split(':').map(Number);
  const start = new Date(Date.UTC(...date.split('-').map((x, i) => i === 1 ? x - 1 : +x), h - 10, m));
  return { start_utc: start.toISOString(), ...extra };
}

test('ending a rule from a date keeps the dates before it and nothing after', async () => {
  const f = fresh({ role: 'editor' });
  const { sid, dates } = await septRule(f);
  const r = await f.call('POST', `/api/admin/events/${sid}:${dates[2]}/following`, { action: 'end' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const rule = f.raw.prepare('SELECT effective_to FROM schedules WHERE id = ?').get(sid);
  assert.ok(rule.effective_to < dates[2] && rule.effective_to >= dates[1], rule.effective_to);
  const left = (await septemberOf(f.db, sid)).map(e => e.id.split(':')[1]);
  assert.deepEqual(left, dates.slice(0, 2));
  // Not tombstones: a service that has stopped is not cancelled every week.
  assert.equal(await expandOne(f.db, sid, dates[2]), null);
});

test('changing a rule from a date on leaves the earlier dates as they were', async () => {
  const f = fresh({ role: 'editor' });
  const { sid, dates, rule } = await septRule(f);
  const r = await f.call('POST', `/api/admin/events/${sid}:${dates[2]}/following`,
    { action: 'edit', ...drawerBody(dates[2], '08:30'), title: 'Matins and Liturgy' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'split');
  const newId = r.body.schedule_id;

  const old = f.raw.prepare('SELECT * FROM schedules WHERE id = ?').get(sid);
  const neu = f.raw.prepare('SELECT * FROM schedules WHERE id = ?').get(newId);
  assert.ok(old.effective_to < dates[2]);
  assert.equal(neu.effective_from, dates[2]);
  assert.equal(neu.start_time, '08:30');
  assert.equal(neu.title, 'Matins and Liturgy');
  assert.equal(neu.day_of_week, rule.day_of_week);
  assert.equal(neu.languages, rule.languages, 'what was not changed carries over');

  assert.equal((await expandOne(f.db, sid, dates[1])).title, rule.title, 'a past date was rewritten');
  const after = await expandOne(f.db, newId, dates[3]);
  assert.equal(after.title, 'Matins and Liturgy');
  assert.equal(await expandOne(f.db, sid, dates[3]), null, 'the old rule still runs after the split');
});

test('later decisions are asked about, then carried or let go', async () => {
  const f = fresh({ role: 'editor' });
  const { sid, dates } = await septRule(f);
  await f.call('PATCH', `/api/admin/events/${sid}:${dates[3]}`, { status: 'cancelled' });
  await f.call('PATCH', `/api/admin/events/${sid}:${dates[2]}`, { feast: 'Exaltation of the Cross' });
  const body = { action: 'edit', ...drawerBody(dates[2], '09:00') };

  const rulesBefore = f.raw.prepare('SELECT COUNT(*) AS n FROM schedules').get().n;
  const ask = await f.call('POST', `/api/admin/events/${sid}:${dates[2]}/following`, body);
  assert.equal(ask.status, 409);
  assert.equal(ask.body.needs_choice, true);
  assert.deepEqual(ask.body.movable.map(o => o.date), [dates[2], dates[3]]);
  assert.equal(ask.body.movable[1].what, 'cancelled');
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM schedules').get().n, rulesBefore,
    'nothing written before the answer');
  assert.equal(f.raw.prepare('SELECT effective_to FROM schedules WHERE id = ?').get(sid).effective_to, null);

  const r = await f.call('POST', `/api/admin/events/${sid}:${dates[2]}/following`, { ...body, keep: 'carry' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.carried, 2);
  const newId = r.body.schedule_id;
  assert.equal((await expandOne(f.db, newId, dates[3])).status, 'cancelled', 'the cancellation was lost');
  const anchor = await expandOne(f.db, newId, dates[2]);
  assert.equal(anchor.feast, 'Exaltation of the Cross');
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM schedule_overrides WHERE schedule_id = ?').get(sid).n, 0);
});

test('letting later decisions go deletes them, and a new weekday strands what cannot move', async () => {
  const f = fresh({ role: 'editor' });
  const { sid, dates } = await septRule(f);
  await f.call('PATCH', `/api/admin/events/${sid}:${dates[3]}`, { status: 'cancelled' });

  const discard = await f.call('POST', `/api/admin/events/${sid}:${dates[2]}/following`,
    { action: 'edit', ...drawerBody(dates[2], '09:00'), keep: 'discard' });
  assert.equal(discard.status, 201, JSON.stringify(discard.body));
  assert.equal(discard.body.dropped, 1);
  assert.notEqual((await expandOne(f.db, discard.body.schedule_id, dates[3])).status, 'cancelled');

  // A second rule, moved to the next day: its later Sunday has no Monday twin.
  const g = fresh({ role: 'editor' });
  const s2 = await septRule(g);
  await g.call('PATCH', `/api/admin/events/${s2.sid}:${s2.dates[3]}`, { status: 'cancelled' });
  const nextDay = new Date(Date.parse(s2.dates[2] + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const moved = drawerBody(nextDay, '19:00');
  const q = await g.call('POST', `/api/admin/events/${s2.sid}:${s2.dates[2]}/following`, { action: 'edit', ...moved });
  assert.equal(q.status, 409);
  assert.equal(q.body.movable.length, 0);
  assert.deepEqual(q.body.stranded.map(o => o.date), [s2.dates[3]]);
  const r = await g.call('POST', `/api/admin/events/${s2.sid}:${s2.dates[2]}/following`, { action: 'edit', ...moved, keep: 'carry' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.dropped, 1);
  assert.equal(g.raw.prepare('SELECT day_of_week FROM schedules WHERE id = ?').get(r.body.schedule_id).day_of_week,
    (s2.rule.day_of_week + 1) % 7);
});

test('the date the edit came from shows the edit, even over an override it already had', async () => {
  const f = fresh({ role: 'editor' });
  const { sid, dates } = await septRule(f);
  // This one Sunday was already moved to 7am by hand.
  await f.call('PATCH', `/api/admin/events/${sid}:${dates[2]}`, drawerBody(dates[2], '07:00'));
  assert.equal((await expandOne(f.db, sid, dates[2])).start_local.slice(11, 16), '07:00');

  const r = await f.call('POST', `/api/admin/events/${sid}:${dates[2]}/following`,
    { action: 'edit', ...drawerBody(dates[2], '09:00'), keep: 'carry' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const anchor = await expandOne(f.db, r.body.schedule_id, dates[2]);
  assert.equal(anchor.start_local.slice(11, 16), '09:00', 'the old one-date time beat the series edit');
});

test('a break running past the split follows the new rule, or ends with the old one', async () => {
  const f = fresh({ role: 'editor' });
  const { parishId, sid, dates } = await septRule(f);
  f.raw.prepare(`INSERT INTO schedule_breaks (parish_id, schedule_id, from_date, to_date, note)
                 VALUES (?, ?, ?, ?, 'Priest away')`).run(parishId, sid, dates[1], dates[3]);
  const r = await f.call('POST', `/api/admin/events/${sid}:${dates[2]}/following`,
    { action: 'edit', ...drawerBody(dates[2], '09:00'), keep: 'carry' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const rows = f.raw.prepare('SELECT schedule_id, from_date, to_date FROM schedule_breaks ORDER BY id').all();
  assert.deepEqual(rows.map(b => [b.schedule_id, b.from_date]), [[sid, dates[1]], [r.body.schedule_id, dates[2]]]);
  assert.ok(rows[0].to_date < dates[2]);
  assert.equal((await expandOne(f.db, r.body.schedule_id, dates[3])).status, 'break');
});

test('a rule that only starts on that date is simply edited, not split', async () => {
  const f = fresh({ role: 'editor' });
  const { sid, dates } = await septRule(f);
  f.raw.prepare('UPDATE schedules SET effective_from = ? WHERE id = ?').run(dates[1], sid);
  const before = f.raw.prepare('SELECT COUNT(*) AS n FROM schedules').get().n;
  const r = await f.call('POST', `/api/admin/events/${sid}:${dates[1]}/following`,
    { action: 'edit', ...drawerBody(dates[1], '09:00') });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.mode, 'whole');
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM schedules').get().n, before);
  assert.equal(f.raw.prepare('SELECT start_time FROM schedules WHERE id = ?').get(sid).start_time, '09:00');
});

test('following-dates edits are refused where they cannot mean anything, and out of scope', async () => {
  const f = fresh({ role: 'parish', parishIds: [] });
  const [mine, theirs] = twoParishes(f.raw);
  contact(f.raw, mine);
  const theirInst = await firstInstance(f.db, theirs);
  assert.equal((await f.call('POST', `/api/admin/events/${theirInst.id}/following`, { action: 'end' })).status, 403);

  const mineInst = await firstInstance(f.db, mine);
  const [sid, date] = splitInstance(mineInst.id);
  const wrongDay = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  assert.equal((await f.call('POST', `/api/admin/events/${sid}:${wrongDay}/following`, { action: 'end' })).status, 400);
  assert.equal((await f.call('POST', `/api/admin/events/${mineInst.id}/following`, { action: 'nuke' })).status, 400);
  assert.equal((await f.call('POST', '/api/admin/events/123/following', { action: 'end' })).status, 400);
  assert.equal((await f.call('POST', `/api/admin/events/${mineInst.id}/following`, { action: 'end' })).status, 200);
});

test('a rule can be given dates, and one that starts later is still in the window', async () => {
  const f = fresh({ role: 'editor' });
  const { parishId, sid } = await septRule(f);
  assert.equal((await f.call('PATCH', `/api/admin/schedules/${sid}`,
    { effective_from: '2026-10-01', effective_to: '2026-09-01' })).status, 400);
  assert.equal((await f.call('PATCH', `/api/admin/schedules/${sid}`, { effective_to: 'soon' })).status, 400);
  assert.equal((await f.call('PATCH', `/api/admin/schedules/${sid}`, { effective_to: '' })).status, 200);

  const made = await f.call('POST', '/api/admin/schedules', {
    parish_id: parishId, title: 'Presanctified Liturgy', day_of_week: 3, start_time: '18:00',
    effective_from: '2027-03-01', effective_to: '2027-04-20',
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const { fetchWindowRows } = await import('../lib/expand.mjs');
  const rows = await fetchWindowRows(f.db, FROM, TO, { withParish: false });
  assert.ok(rows.schedules.some(s => s.id === made.body.id), 'a rule starting later is announced on the timetable');
  const all = await expandWindow(f.db, FROM, TO);
  assert.ok(!all.some(e => e.schedule_id === made.body.id), 'but projects nothing before it starts');
});

// ── the St George double tap ──
//
// A parish contact tapped Add twice and got two Thursday rules, deleted one
// with a reason, and the reason refused the slot the other still sat in — so
// the survivor could not be saved, not even to tick "Parish only".

const thursday = { day_of_week: 4, start_time: '19:00', title: 'Choir Practice', event_type: 'other' };

test('adding the same rule twice makes one rule', async () => {
  const f = fresh({ role: 'editor' });
  const [parishId] = twoParishes(f.raw);
  const a = await f.call('POST', '/api/admin/schedules', { parish_id: parishId, ...thursday });
  const b = await f.call('POST', '/api/admin/schedules', { parish_id: parishId, ...thursday });
  assert.equal(a.status, 201);
  assert.equal(b.status, 200);
  assert.equal(b.body.duplicate, true);
  assert.equal(b.body.id, a.body.id);
  assert.equal(f.raw.prepare("SELECT COUNT(*) AS n FROM schedules WHERE title = 'Choir Practice'").get().n, 1);
  // A 1st-of-the-month rule at the same time is a different rule.
  const c = await f.call('POST', '/api/admin/schedules', { parish_id: parishId, ...thursday, week_of_month: 'first' });
  assert.equal(c.status, 201);
});

test('deleting a rule is just a delete — nothing is recorded against the slot', async () => {
  // Whether an import may put it back is the parish's read_from, not a ruling.
  const f = fresh({ role: 'editor' });
  const [parishId] = twoParishes(f.raw);
  const ins = f.raw.prepare(`INSERT INTO schedules (parish_id, day_of_week, start_time, title, event_type)
                             VALUES (?, 4, '19:00', 'Choir Practice', 'other') RETURNING id`);
  const keep = ins.get(parishId).id;
  const spare = ins.get(parishId).id;
  const del = await f.call('DELETE', `/api/admin/schedules/${spare}`,
    { suppress: { tier: 'admin', note: 'Accidental duplicate addition of choir practice' } });
  assert.equal(del.status, 200, JSON.stringify(del.body));
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM info_overrides').get().n, 0);
  assert.equal((await f.call('PATCH', `/api/admin/schedules/${keep}`, { ...thursday, parish_scoped: 1 })).status, 200);
});

