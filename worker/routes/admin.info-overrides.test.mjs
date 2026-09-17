// The rulings, through the real router and a real database.
//
// worker/lib/info-overrides.test.mjs proves the model. This proves the wiring,
// and one thing the unit tests cannot: that deleting a rule and recording why
// happen in ONE request, so a panel cannot leave the rule gone and the reason
// missing.

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

function fresh(roleRow) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-io-')), 'x.db');
  const raw = new Database(file);
  raw.pragma('foreign_keys = ON');
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  if (roleRow) {
    raw.prepare('INSERT INTO admin_roles (email, role, parish_ids) VALUES (?,?,?)')
      .bind('dev', roleRow.role, roleRow.parishIds ? JSON.stringify(roleRow.parishIds) : null).run();
  }
  const router = new Router();
  registerAdminRoutes(router);
  registerPublicRoutes(router);
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
  const makeRule = (over = {}) => raw.prepare(
    `INSERT INTO schedules (parish_id, day_of_week, start_time, title, source_name, source_ref)
     VALUES (?,?,?,?,?,?) RETURNING id`
  ).get(over.parish_id || PARISH, over.day_of_week ?? 0, over.start_time || '18:00',
        over.title || 'Vespers', over.source_name || 'Antiochian Archdiocese',
        over.source_ref || 'https://www.antiochian.org.au/x/').id;
  return { raw, call, makeRule };
}

const REASON = 'Confirmed by telephone that neither Vespers has run for years.';

// ── the Elimbah case, end to end ───────────────────────────────────────────

test('deleting a rule and recording why is one request', async () => {
  const { call, raw, makeRule } = fresh();
  const id = makeRule();
  const r = await call('DELETE', `/api/admin/schedules/${id}`, {
    suppress: { tier: 'admin', note: REASON, source_name: 'Telephone, Fr John' },
  });
  assert.equal(r.status, 200);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM schedules WHERE id=?').get(id).n, 0,
    'the rule should be gone');
  const ruling = raw.prepare("SELECT * FROM info_overrides WHERE target='schedule'").get();
  assert.ok(ruling, 'the reason should have outlived the rule');
  assert.equal(ruling.subject, '0|18:00');
  assert.equal(ruling.decision, 'suppress');
  assert.equal(ruling.source_label, 'Vespers', 'what the source calls it, for quoting later');
  assert.match(ruling.note, /telephone/i);
});

test('a delete with no ruling behaves exactly as it did before', async () => {
  // The panel may not always have a reason to give, and an import that has
  // nothing to say about a rule nobody explained is the old behaviour, not a
  // regression.
  const { call, raw, makeRule } = fresh();
  const id = makeRule();
  const r = await call('DELETE', `/api/admin/schedules/${id}`);
  assert.equal(r.status, 200);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM schedules WHERE id=?').get(id).n, 0);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM info_overrides').get().n, 0);
});

test('a ruling with no reason is refused, and the rule survives', async () => {
  // The order matters: validate before deleting. Otherwise a malformed ruling
  // costs the rule AND the record.
  const { call, raw, makeRule } = fresh();
  const id = makeRule();
  const r = await call('DELETE', `/api/admin/schedules/${id}`, { suppress: { tier: 'admin' } });
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Say why/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM schedules WHERE id=?').get(id).n, 1,
    'a refused ruling must not take the rule with it');
});

test('recreating a suppressed rule is refused, and says how to proceed', async () => {
  const { call, makeRule } = fresh();
  const id = makeRule();
  await call('DELETE', `/api/admin/schedules/${id}`, { suppress: { tier: 'admin', note: REASON } });

  const again = await call('POST', '/api/admin/schedules', {
    parish_id: PARISH, day_of_week: 0, start_time: '18:00', title: 'Vespers',
  });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /Sunday 18:00/);
  // The reason, not just the fact of a ruling — the person hitting this is
  // the reader the note was written for.
  assert.match(again.body.error, /telephone/i);
  assert.ok(again.body.ruling_id, 'the panel needs the id to offer to lift it');
  assert.equal(again.body.liftable, true);
});

test('lifting the ruling frees the slot', async () => {
  const { call, makeRule } = fresh();
  const id = makeRule();
  await call('DELETE', `/api/admin/schedules/${id}`, { suppress: { tier: 'admin', note: REASON } });
  const blocked = await call('POST', '/api/admin/schedules', {
    parish_id: PARISH, day_of_week: 0, start_time: '18:00', title: 'Vespers',
  });
  assert.equal(blocked.status, 409);

  const lift = await call('DELETE', `/api/admin/info-overrides/${blocked.body.ruling_id}`);
  assert.equal(lift.status, 200);
  assert.match(lift.body.lifted, /Sunday 18:00/);

  const ok = await call('POST', '/api/admin/schedules', {
    parish_id: PARISH, day_of_week: 0, start_time: '18:00', title: 'Vespers',
  });
  assert.equal(ok.status, 201);
});

test('a suppression binds the slot, not the title', async () => {
  const { call, makeRule } = fresh();
  const id = makeRule({ title: 'Vespers' });
  await call('DELETE', `/api/admin/schedules/${id}`, { suppress: { tier: 'admin', note: REASON } });
  const renamed = await call('POST', '/api/admin/schedules', {
    parish_id: PARISH, day_of_week: 0, start_time: '18:00', title: 'Great Vespers',
  });
  assert.equal(renamed.status, 409, 'an upstream rename must not slip past the ruling');
  const elsewhere = await call('POST', '/api/admin/schedules', {
    parish_id: PARISH, day_of_week: 0, start_time: '17:00', title: 'Vespers',
  });
  assert.equal(elsewhere.status, 201, 'a different slot is a different claim');
});

test('a suppression is per parish', async () => {
  const { call, raw, makeRule } = fresh();
  const other = raw.prepare("SELECT id FROM parishes WHERE id NOT IN (?, '_unassigned') LIMIT 1")
    .get(PARISH).id;
  const id = makeRule();
  await call('DELETE', `/api/admin/schedules/${id}`, { suppress: { tier: 'admin', note: REASON } });
  const r = await call('POST', '/api/admin/schedules', {
    parish_id: other, day_of_week: 0, start_time: '18:00', title: 'Vespers',
  });
  assert.equal(r.status, 201);
});

test('moving a rule into a suppressed slot is refused too', async () => {
  // A PATCH that changes the time is a create as far as the ruling is
  // concerned. Missing this would leave the front door locked and the window
  // open.
  const { call, makeRule } = fresh();
  const gone = makeRule({ start_time: '18:00' });
  await call('DELETE', `/api/admin/schedules/${gone}`, { suppress: { tier: 'admin', note: REASON } });
  const other = makeRule({ start_time: '09:30', title: 'Liturgy' });

  const moved = await call('PATCH', `/api/admin/schedules/${other}`, { start_time: '18:00' });
  assert.equal(moved.status, 409);
  // The half of the slot the edit does not mention comes from the stored row.
  const dayOnly = await call('PATCH', `/api/admin/schedules/${other}`, { day_of_week: 3 });
  assert.equal(dayOnly.status, 200, 'Wednesday 09:30 is not the refused slot');
  const edit = await call('PATCH', `/api/admin/schedules/${other}`, { title: 'Divine Liturgy' });
  assert.equal(edit.status, 200, 'an edit that does not move the rule is untouched');
});

// ── pinning a field ────────────────────────────────────────────────────────

test('an address pin rides along with the edit that sets the address', async () => {
  const { call, raw } = fresh();
  const r = await call('PATCH', `/api/admin/parishes/${PARISH}`, {
    address: '12 Coronation Street, Elimbah 4516, QLD, Australia',
    pin: { field: 'address', tier: 'parish', note: 'The directory omits the street number.',
           source_ref: 'http://www.australianorthodoxchristians.org' },
  });
  assert.equal(r.status, 200);
  const pins = raw.prepare("SELECT * FROM info_overrides WHERE target='field' ORDER BY subject").all();
  // An address and its coordinates are one fact.
  assert.deepEqual(pins.map(p => p.subject), ['address', 'lat', 'lng']);
  assert.ok(pins.every(p => p.tier === 'parish'));
  assert.ok(pins.every(p => /street number/.test(p.note)));
});

test('a malformed pin does not cost the edit', async () => {
  const { call, raw } = fresh();
  const r = await call('PATCH', `/api/admin/parishes/${PARISH}`, {
    phone: '+61400000000',
    pin: { field: 'phone', tier: 'parish' },   // no note
  });
  assert.equal(r.status, 200);
  assert.equal(raw.prepare('SELECT phone FROM parishes WHERE id=?').get(PARISH).phone, '+61400000000',
    'the value should be saved even though the ruling was not');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM info_overrides').get().n, 0);
  assert.match(r.body.pin_errors[0].error, /Say why/);
});

test('an edit with no pin reports nothing extra', async () => {
  const { call } = fresh();
  const r = await call('PATCH', `/api/admin/parishes/${PARISH}`, { phone: '+61400000001' });
  assert.equal(r.status, 200);
  assert.equal('pins' in r.body, false);
  assert.equal('pin_errors' in r.body, false);
});

test('a second ruling about one fact replaces the first', async () => {
  const { call, raw } = fresh();
  const put = (note, tier) => call('PUT', '/api/admin/info-overrides', {
    parish_id: PARISH, target: 'field', field: 'website', decision: 'pin', tier, note,
  });
  await put('first reason', 'directory');
  await put('second reason', 'parish');
  const rows = raw.prepare("SELECT * FROM info_overrides WHERE subject='website'").all();
  assert.equal(rows.length, 1, 'two rulings about one field is the condition this table removes');
  assert.equal(rows[0].note, 'second reason');
  assert.equal(rows[0].tier, 'parish');
});

// ── what the panel and the scripts see ─────────────────────────────────────

test('the admin list carries the parish name, the slot and a sentence', async () => {
  const { call, makeRule } = fresh();
  const id = makeRule();
  await call('DELETE', `/api/admin/schedules/${id}`, { suppress: { tier: 'admin', note: REASON } });
  const r = await call('GET', '/api/admin/info-overrides');
  assert.equal(r.status, 200);
  const [o] = r.body.overrides;
  assert.ok(o.parish_name && o.parish_name !== o.parish_id, 'an id is not a thing anybody recognises');
  assert.deepEqual(o.slot, { day_of_week: 0, start_time: '18:00' });
  assert.match(o.describes, /does not run/);
  assert.ok(r.body.tiers.length, 'the panel menu and the guard read one vocabulary');
  assert.ok(r.body.fields.includes('address'));
});

test('the public endpoint serves the reason and withholds the admin', async () => {
  // The import scripts read this with no credential. If they could not, the
  // suppression would not apply where it matters.
  const { call, raw, makeRule } = fresh();
  const id = makeRule();
  await call('DELETE', `/api/admin/schedules/${id}`, { suppress: { tier: 'admin', note: REASON } });
  raw.prepare("UPDATE info_overrides SET updated_by='someone@example.com'").run();

  const r = await call('GET', '/api/info-overrides');
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.match(r.body[0].note, /telephone/i);
  assert.equal(JSON.stringify(r.body).includes('example.com'), false);
  const one = await call('GET', `/api/info-overrides?parish=${PARISH}`);
  assert.equal(one.body.length, 1);
  const none = await call('GET', '/api/info-overrides?parish=nobody');
  assert.equal(none.body.length, 0);
});

// ── who may rule ───────────────────────────────────────────────────────────

test('a parish contact may rule on their own parish and no other', async () => {
  const { call, raw } = fresh({ role: 'parish', parishIds: [PARISH] });
  const other = raw.prepare("SELECT id FROM parishes WHERE id NOT IN (?, '_unassigned') LIMIT 1")
    .get(PARISH).id;
  const mine = await call('PUT', '/api/admin/info-overrides', {
    parish_id: PARISH, target: 'field', field: 'address', decision: 'pin', tier: 'parish', note: 'n',
  });
  assert.equal(mine.status, 200);
  const theirs = await call('PUT', '/api/admin/info-overrides', {
    parish_id: other, target: 'field', field: 'address', decision: 'pin', tier: 'parish', note: 'n',
  });
  assert.equal(theirs.status, 403);
});

test('whoever may delete a rule may record why', async () => {
  // The split that would be worst: the destructive half granted and the
  // durable half withheld, so the delete happens and the next import undoes it.
  for (const role of ['owner', 'editor', 'parish']) {
    const { call, makeRule } = fresh({ role, parishIds: [PARISH] });
    const id = makeRule();
    const r = await call('DELETE', `/api/admin/schedules/${id}`,
      { suppress: { tier: 'admin', note: REASON } });
    assert.equal(r.status, 200, `${role} could delete but not record`);
  }
});

test('lifting a ruling on somebody else’s parish is refused', async () => {
  const { call, raw } = fresh();
  const other = raw.prepare("SELECT id FROM parishes WHERE id NOT IN (?, '_unassigned') LIMIT 1")
    .get(PARISH).id;
  await call('PUT', '/api/admin/info-overrides', {
    parish_id: other, target: 'field', field: 'address', decision: 'pin', tier: 'parish', note: 'n',
  });
  const id = raw.prepare('SELECT id FROM info_overrides').get().id;
  raw.prepare('INSERT INTO admin_roles (email, role, parish_ids) VALUES (?,?,?)')
    .bind('dev', 'parish', JSON.stringify([PARISH])).run();
  const r = await call('DELETE', `/api/admin/info-overrides/${id}`);
  assert.equal(r.status, 403);
});

test('lifting a ruling that is not there is a 404, not a 500', async () => {
  const { call } = fresh();
  const r = await call('DELETE', '/api/admin/info-overrides/99999');
  assert.equal(r.status, 404);
});
