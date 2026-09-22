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
