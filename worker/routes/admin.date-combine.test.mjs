// Include other parishes in one DATE of a service (migration 041).
//
// A combine used to hang on a stored event only. A date of a service is
// projected, never stored, so its combine is keyed by the date, as an override
// is: `occurrence_parishes` for who takes part, and a 'combined' override at
// another parish naming the date by combined_into_schedule_id +
// combined_into_date. These go through the real Router and the same routes a
// one-off's combine takes, routed by the shape of the id.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Router } from '../lib/router.mjs';
import { registerAdminRoutes } from './admin.mjs';
import { registerPublicRoutes } from './public.mjs';
import { expandWindow, expandOne } from '../lib/expand.mjs';
import { crossRows, hostedDates } from '../lib/taking-part.mjs';
import { buildFeed } from '../../public/shared/merge.mjs';

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

function fresh(roles = [{ email: 'dev', role: 'editor' }]) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-dc-')), 'x.db');
  const raw = new Database(file);
  raw.pragma('foreign_keys = ON');
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  for (const r of roles) {
    raw.prepare('INSERT INTO admin_roles (email, role, parish_ids) VALUES (?,?,?)')
      .run(r.email, r.role, r.parishIds ? JSON.stringify(r.parishIds) : null);
  }
  const router = new Router();
  registerAdminRoutes(router);
  registerPublicRoutes(router);
  const db = new D1(raw);
  const env = { DB: db, AGORA_DEV_ADMIN: 'true' };
  const call = async (method, url, body) => {
    const init = { method };
    if (body !== undefined) { init.body = JSON.stringify(body); init.headers = { 'Content-Type': 'application/json' }; }
    const res = await router.handle(new Request(`https://orthodoxy.au${url}`, init), env, {});
    assert.ok(res, `no route matched ${method} ${url}`);
    let parsed = null;
    try { parsed = await res.clone().json(); } catch { /* not json */ }
    return { status: res.status, body: parsed };
  };
  return { raw, db, call };
}

const FROM = '2026-09-01T00:00:00.000Z';
const TO = '2026-10-02T00:00:00.000Z';

/**
 * Two parishes with a service on the same September day: the host's date, and
 * the other parish's date that day, which the host's can stand in for.
 */
async function sameDay(db, { later = false } = {}) {
  const all = (await expandWindow(db, FROM, TO)).filter(e => e.status === 'approved');
  const first = new Map();
  for (const e of all) if (!first.has(e.schedule_id) || e.id.split(':')[1] < first.get(e.schedule_id)) first.set(e.schedule_id, e.id.split(':')[1]);
  for (const a of all) {
    const day = a.id.split(':')[1];
    // `later`: not its rule's first date here, so there is a date before it to change the rule from.
    if (later && first.get(a.schedule_id) === day) continue;
    const b = all.find(x => x.parish_id !== a.parish_id && x.id.split(':')[1] === day);
    if (b) return { host: a, other: b, day };
  }
  throw new Error('the seed should have two parishes with a service on one day');
}

const at = (id) => String(id).split(':');

test('a date of a service takes other parishes, and the bundle carries them under its id', async () => {
  const f = fresh();
  const { host, other } = await sameDay(f.db);
  const r = await f.call('POST', `/api/admin/events/${host.id}/escalate`, { additive_parish_ids: [other.parish_id] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.additional_parishes, [other.parish_id]);

  const [sid, date] = at(host.id);
  const rows = f.raw.prepare('SELECT * FROM occurrence_parishes').all();
  assert.deepEqual(rows.map(x => [x.schedule_id, x.occurrence_date, x.parish_id]), [[Number(sid), date, other.parish_id]]);

  const state = await f.call('GET', `/api/admin/events/${host.id}/escalation`);
  assert.deepEqual(state.body, { additive_parish_ids: [other.parish_id], replaced_events: [] });

  // The rows every reader joins, keyed by the date's own id, so the feed
  // attaches them to the projected date as it does an event's.
  const cross = await crossRows(f.db);
  assert.ok(cross.some(x => x.event_id === host.id && x.parish_id === other.parish_id), JSON.stringify(cross));
  const feed = buildFeed({ instances: [host], oneOffs: [], crossRows: cross });
  assert.deepEqual(feed[0].combined_parishes, [other.parish_id]);
  assert.ok(feed[0].extra_parishes.includes(other.parish_id));

  const bundle = await f.call('GET', `/api/bundle?from=${FROM}&to=${TO}`);
  assert.equal(bundle.status, 200);
  assert.ok(bundle.body.event_parishes.some(x => x.event_id === host.id && x.parish_id === other.parish_id));

  const one = await f.call('GET', `/api/events/${host.id}`);
  assert.deepEqual(one.body.combined_parishes, [other.parish_id]);
});

test('it stands in for the other parish’s service that day, and letting go brings that back', async () => {
  const f = fresh();
  const { host, other } = await sameDay(f.db);
  const r = await f.call('POST', `/api/admin/events/${host.id}/escalate`, {
    additive_parish_ids: [other.parish_id], replaced_event_ids: [other.id],
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.replaces, [other.id]);

  const [osid, odate] = at(other.id);
  const [hsid, hdate] = at(host.id);
  const ov = f.raw.prepare('SELECT * FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?').get(Number(osid), odate);
  assert.equal(ov.kind, 'combined');
  assert.equal(ov.combined_into_event_id, null);
  assert.equal(ov.combined_into_schedule_id, Number(hsid));
  assert.equal(ov.combined_into_date, hdate);

  // Their date is a tombstone pointing at the host's date, which the card
  // opens as it opens an event ("In its place").
  const theirs = await expandOne(f.db, Number(osid), odate);
  assert.equal(theirs.status, 'combined');
  assert.equal(theirs.combined_into_event_id, host.id);

  const state = await f.call('GET', `/api/admin/events/${host.id}/escalation`);
  assert.deepEqual(state.body.replaced_events.map(x => x.id), [other.id]);

  // The body is the whole state: naming nothing takes both away.
  const off = await f.call('POST', `/api/admin/events/${host.id}/escalate`, { additive_parish_ids: [], replaced_event_ids: [] });
  assert.equal(off.status, 200);
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM occurrence_parishes').get().n, 0);
  assert.equal((await expandOne(f.db, Number(osid), odate)).status, 'approved', 'their service is back');
});

test('a date cannot stand in for a stored one-off, nor for itself', async () => {
  const f = fresh();
  const { host } = await sameDay(f.db);
  const made = await f.call('POST', '/api/admin/events', {
    parish_id: host.parish_id, title: 'Picnic', start_utc: host.start_utc, event_type: 'social',
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  const r = await f.call('POST', `/api/admin/events/${host.id}/escalate`, { replaced_event_ids: [String(made.body.id)] });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /not for an event/);

  await f.call('POST', `/api/admin/events/${host.id}/escalate`, { replaced_event_ids: [host.id] });
  assert.equal(f.raw.prepare("SELECT COUNT(*) AS n FROM schedule_overrides WHERE kind = 'combined'").get().n, 0);
});

test('a date that is not one of its rule’s is not found', async () => {
  const f = fresh();
  const { host } = await sameDay(f.db);
  const [sid, date] = at(host.id);
  const next = new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  const r = await f.call('POST', `/api/admin/events/${sid}:${next}/escalate`, { additive_parish_ids: [] });
  assert.equal(r.status, 404, 'a weekly service has no date the day after');
});

test('a parish contact includes their own and asks an owner for the rest', async () => {
  const f0 = fresh();
  const { host, other } = await sameDay(f0.db);
  const f = fresh([{ email: 'dev', role: 'parish', parishIds: [host.parish_id] }]);

  const refused = await f.call('POST', `/api/admin/events/${host.id}/escalate`, { additive_parish_ids: [other.parish_id] });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.proposable, true);
  assert.equal(refused.body.subject, host.id);

  const asked = await f.call('POST', `/api/admin/events/${host.id}/escalate`, {
    additive_parish_ids: [other.parish_id], replaced_event_ids: [other.id], propose: 'Deanery Liturgy',
  });
  assert.equal(asked.status, 200, JSON.stringify(asked.body));
  assert.ok(asked.body.proposal_id);
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM occurrence_parishes').get().n, 0, 'none of it was theirs');
  const ask = f.raw.prepare('SELECT * FROM admin_proposals WHERE id = ?').get(asked.body.proposal_id);
  assert.equal(ask.subject, host.id);

  // The owner approves: the whole state is written as asked.
  f.raw.prepare("UPDATE admin_roles SET role = 'owner', parish_ids = NULL WHERE email = 'dev'").run();
  const list = await f.call('GET', '/api/admin/proposals');
  assert.match(list.body.find(p => p.id === asked.body.proposal_id).subjectName, / on \d+ \w+ 2026$/);
  const ok = await f.call('POST', `/api/admin/proposals/${asked.body.proposal_id}/decide`, { decision: 'approve' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(f.raw.prepare('SELECT parish_id FROM occurrence_parishes').get().parish_id, other.parish_id);
  const [osid, odate] = at(other.id);
  assert.equal((await expandOne(f.db, Number(osid), odate)).combined_into_event_id, host.id);
});

test('the parish taking part is told, and can take itself out', async () => {
  const f0 = fresh();
  const { host, other } = await sameDay(f0.db);
  const f = fresh([{ email: 'dev', role: 'editor' }]);
  await f.call('POST', `/api/admin/events/${host.id}/escalate`, {
    additive_parish_ids: [other.parish_id], replaced_event_ids: [other.id],
  });
  f.raw.prepare("UPDATE admin_roles SET role = 'parish', parish_ids = ? WHERE email = 'dev'").run(JSON.stringify([other.parish_id]));

  const notices = await f.call('GET', '/api/admin/parish-notices');
  assert.deepEqual(notices.body.map(n => n.kind).sort(), ['absorbed', 'listed']);
  assert.ok(notices.body.every(n => n.event_id === host.id));

  const out = await f.call('POST', `/api/admin/parishes/${other.parish_id}/withdraw`, { event_id: host.id });
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.equal(out.body.restored, 1);
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM occurrence_parishes').get().n, 0);
  const [osid, odate] = at(other.id);
  assert.equal((await expandOne(f.db, Number(osid), odate)).status, 'approved');
});

test('the dates another parish’s service is shared with are read for the parish taking part', async () => {
  const f = fresh();
  const { host, other, day } = await sameDay(f.db);
  await f.call('POST', `/api/admin/events/${host.id}/escalate`, { additive_parish_ids: [other.parish_id] });
  const got = await hostedDates(f.db, [other.parish_id], '2026-09-01', '2026-10-01');
  assert.deepEqual(got.map(e => e.id), [host.id]);
  assert.deepEqual(got[0].combined_parishes, [other.parish_id]);
  assert.equal(got[0].id.split(':')[1], day);
  // Not the host's own: those are its rules already.
  assert.deepEqual(await hostedDates(f.db, [host.parish_id], '2026-09-01', '2026-10-01'), []);
});

/** The rule's own September dates, as ids. */
async function datesOf(db, sid) {
  return (await expandWindow(db, FROM, TO)).filter(e => String(e.schedule_id) === String(sid)).map(e => e.id);
}

test('ending the service before a shared date lets the date’s combine go', async () => {
  const f = fresh();
  const { host, other } = await sameDay(f.db);
  await f.call('POST', `/api/admin/events/${host.id}/escalate`, {
    additive_parish_ids: [other.parish_id], replaced_event_ids: [other.id],
  });
  // Ended from the shared date itself: it and every date after are gone.
  const r = await f.call('POST', `/api/admin/events/${host.id}/following`, { action: 'end' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM occurrence_parishes').get().n, 0);
  const [osid, odate] = at(other.id);
  assert.equal((await expandOne(f.db, Number(osid), odate)).status, 'approved', 'their service is back');
});

test('changing the service from before a shared date asks, and carries the combine onto the new rule', async () => {
  const f = fresh();
  const { host, other } = await sameDay(f.db, { later: true });
  const [sid, hdate] = at(host.id);
  const dates = await datesOf(f.db, sid);
  const earlier = dates.filter(id => at(id)[1] < hdate);
  assert.ok(earlier.length, 'the seed’s first shared day should not be the rule’s first September date');
  await f.call('POST', `/api/admin/events/${host.id}/escalate`, {
    additive_parish_ids: [other.parish_id], replaced_event_ids: [other.id],
  });
  const from = earlier[earlier.length - 1];
  const rule = f.raw.prepare('SELECT * FROM schedules WHERE id = ?').get(Number(sid));
  const body = { action: 'edit', title: `${rule.title} (new)` };

  const ask = await f.call('POST', `/api/admin/events/${from}/following`, body);
  assert.equal(ask.status, 409, JSON.stringify(ask.body));
  assert.ok(ask.body.movable.some(o => o.date === hdate && o.what === 'other parishes take part'), JSON.stringify(ask.body));

  const r = await f.call('POST', `/api/admin/events/${from}/following`, { ...body, keep: 'carry' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const newId = r.body.schedule_id;
  assert.deepEqual(f.raw.prepare('SELECT schedule_id, occurrence_date FROM occurrence_parishes').all(),
    [{ schedule_id: newId, occurrence_date: hdate }]);
  const [osid, odate] = at(other.id);
  assert.equal((await expandOne(f.db, Number(osid), odate)).combined_into_event_id, `${newId}:${hdate}`);
});

test('let go instead, the combine goes and their service comes back', async () => {
  const f = fresh();
  const { host, other } = await sameDay(f.db, { later: true });
  const [sid, hdate] = at(host.id);
  const earlier = (await datesOf(f.db, sid)).filter(id => at(id)[1] < hdate);
  assert.ok(earlier.length);
  await f.call('POST', `/api/admin/events/${host.id}/escalate`, {
    additive_parish_ids: [other.parish_id], replaced_event_ids: [other.id],
  });
  const rule = f.raw.prepare('SELECT * FROM schedules WHERE id = ?').get(Number(sid));
  const r = await f.call('POST', `/api/admin/events/${earlier[earlier.length - 1]}/following`,
    { action: 'edit', title: `${rule.title} (new)`, keep: 'discard' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(f.raw.prepare('SELECT COUNT(*) AS n FROM occurrence_parishes').get().n, 0);
  const [osid, odate] = at(other.id);
  assert.equal((await expandOne(f.db, Number(osid), odate)).status, 'approved');
});
