// A rule's week exceptions through the admin API: the card's body whole in,
// one row out, holding only what differs from the service those weeks.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Router } from '../lib/router.mjs';
import { registerAdminRoutes } from './admin.mjs';
import { expandOne, fetchWindowRows, expandWindow } from '../lib/expand.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

// The same D1 shim the other route tests use.
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

function fresh() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-wx-')), 'x.db');
  const raw = new Database(file);
  raw.pragma('foreign_keys = ON');
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
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
  const parish = raw.prepare(`SELECT id FROM parishes WHERE id != '_unassigned'
    AND timezone = 'Australia/Sydney' ORDER BY id LIMIT 1`).get();
  assert.ok(parish, 'the seed should have a Sydney parish');
  // Its own Sunday Liturgy, bilingual, every week.
  const { lastInsertRowid } = raw.prepare(`INSERT INTO schedules
    (parish_id, day_of_week, start_time, end_time, title, event_type, languages)
    VALUES (?, 0, '09:00', '12:00', 'Matins & Divine Liturgy', 'liturgy', '["Arabic","English"]')`).run(parish.id);
  const sid = Number(lastInsertRowid);
  return { raw, db, call, sid, parishId: parish.id };
}

const ENGLISH_LAST = {
  weeks: ['last'], kind: 'modified',
  // The card sends every field as it is held those weeks.
  title: 'Matins & Divine Liturgy', start_time: '09:00', end_time: '11:30',
  languages: ['English'], feast: '', description: '',
};

test('an exception stores only what differs from the service those weeks', async () => {
  const { raw, call, sid } = fresh();
  const r = await call('POST', `/api/admin/schedules/${sid}/exceptions`, ENGLISH_LAST);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.schedule_id, sid);
  assert.equal(r.body.weeks, 'last');
  assert.equal(r.body.kind, 'modified');
  assert.equal(r.body.patch_languages, '["English"]');
  assert.equal(r.body.patch_end_time, '11:30');
  assert.equal(r.body.patch_title, null, 'the same title is "as the service"');
  assert.equal(r.body.patch_start_time, null);
  assert.equal(r.body.patch_location_parish_id, null, 'no Where sent, nothing about the place');
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM schedule_week_exceptions').get().n, 1, 'one row, not one per date');
});

test('the rule then projects the exception on its weeks, and its timetable says so', async () => {
  const { db, call, sid } = fresh();
  await call('POST', `/api/admin/schedules/${sid}/exceptions`, ENGLISH_LAST);
  const last = await expandOne(db, sid, '2026-12-27');
  assert.equal(last.languages, '["English"]');
  assert.equal(last.end_local, '2026-12-27T11:30');
  const other = await expandOne(db, sid, '2026-12-20');
  assert.equal(other.languages, '["Arabic","English"]');
  const rows = await fetchWindowRows(db, '2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z', { scheduleId: sid });
  assert.equal(rows.week_exceptions.length, 1);
  assert.equal(rows.schedules[0].variants[0].languages, '["English"]', 'joined on for the readers of rules');
  const bundleShape = await fetchWindowRows(db, '2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z', { withParish: false });
  assert.ok(bundleShape.week_exceptions.length >= 1);
  assert.equal(bundleShape.schedules[0].exceptions, undefined, 'the bundle sends rows; the browser joins them');
});

test('not held: those weeks are no dates of the service, unless a date says otherwise', async () => {
  const { db, raw, call, sid } = fresh();
  const r = await call('POST', `/api/admin/schedules/${sid}/exceptions`, { ...ENGLISH_LAST, kind: 'not_held' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.patch_languages, null, 'not held keeps no fields');
  assert.equal(await expandOne(db, sid, '2026-12-27'), null);
  const dec = (await expandWindow(db, '2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z', { scheduleId: sid })).map(i => i.id.split(':')[1]);
  assert.deepEqual(dec, ['2026-12-06', '2026-12-13', '2026-12-20']);
  raw.prepare(`INSERT INTO schedule_overrides (schedule_id, occurrence_date, kind, patch_title) VALUES (?, '2026-12-27', 'modified', 'Nativity')`).run(sid);
  assert.equal((await expandOne(db, sid, '2026-12-27')).title, 'Nativity');
});

test('an exception has to differ, and to name weeks the service is held on', async () => {
  const { call, raw, sid } = fresh();
  const same = await call('POST', `/api/admin/schedules/${sid}/exceptions`, { ...ENGLISH_LAST, end_time: '12:00', languages: ['Arabic', 'English'] });
  assert.equal(same.status, 400);
  assert.match(same.body.error, /Nothing those weeks differs/);
  const none = await call('POST', `/api/admin/schedules/${sid}/exceptions`, { ...ENGLISH_LAST, weeks: [] });
  assert.equal(none.status, 400);
  const junk = await call('POST', `/api/admin/schedules/${sid}/exceptions`, { ...ENGLISH_LAST, weeks: ['fifth'] });
  assert.equal(junk.status, 400);
  const badTime = await call('POST', `/api/admin/schedules/${sid}/exceptions`, { ...ENGLISH_LAST, start_time: '9am' });
  assert.equal(badTime.status, 400);
  // A 1st-Sunday rule is never held on the last Sunday.
  raw.prepare(`UPDATE schedules SET week_of_month = 'first' WHERE id = ?`).run(sid);
  const never = await call('POST', `/api/admin/schedules/${sid}/exceptions`, ENGLISH_LAST);
  assert.equal(never.status, 400);
  assert.match(never.body.error, /is not held on those Sundays/);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM schedule_week_exceptions').get().n, 0);
});

test('one exception to a week: a second for the same Sunday is refused', async () => {
  const { call, sid } = fresh();
  assert.equal((await call('POST', `/api/admin/schedules/${sid}/exceptions`, ENGLISH_LAST)).status, 201);
  const again = await call('POST', `/api/admin/schedules/${sid}/exceptions`, { ...ENGLISH_LAST, weeks: ['first', 'last'], kind: 'not_held' });
  assert.equal(again.status, 400);
  assert.match(again.body.error, /The last Sunday already has an exception/);
  const first = await call('POST', `/api/admin/schedules/${sid}/exceptions`, { ...ENGLISH_LAST, weeks: ['first'], start_time: '10:00', end_time: '12:00' });
  assert.equal(first.status, 201, 'another week is fine');
  assert.equal(first.body.patch_start_time, '10:00');
});

test('an exception is changed in place and removed whole', async () => {
  const { call, db, raw, sid } = fresh();
  const made = (await call('POST', `/api/admin/schedules/${sid}/exceptions`, ENGLISH_LAST)).body;
  const moved = await call('PATCH', `/api/admin/week-exceptions/${made.id}`, { ...ENGLISH_LAST, weeks: ['fourth', 'last'], end_time: '11:00' });
  assert.equal(moved.status, 200, JSON.stringify(moved.body));
  assert.equal(moved.body.weeks, 'fourth,last');
  assert.equal(moved.body.patch_end_time, '11:00');
  assert.equal((await expandOne(db, sid, '2027-01-24')).end_local, '2027-01-24T11:00', 'its own weeks are not a clash with itself');
  const off = await call('PATCH', `/api/admin/week-exceptions/${made.id}`, { weeks: ['last'], kind: 'not_held' });
  assert.equal(off.body.kind, 'not_held');
  assert.equal(off.body.patch_end_time, null);
  assert.equal((await call('DELETE', `/api/admin/week-exceptions/${made.id}`)).status, 200);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM schedule_week_exceptions').get().n, 0);
  assert.equal((await expandOne(db, sid, '2026-12-27')).languages, '["Arabic","English"]', 'the last Sunday is the service again');
  assert.equal((await call('DELETE', `/api/admin/week-exceptions/${made.id}`)).status, 404);
});

test('an exception elsewhere is a place of its own; at the parish, the service back home', async () => {
  const { call, raw, sid, parishId } = fresh();
  const hall = await call('POST', `/api/admin/schedules/${sid}/exceptions`, { ...ENGLISH_LAST, location_override: 'Church hall', end_time: '12:00', languages: ['Arabic', 'English'] });
  assert.equal(hall.status, 201, JSON.stringify(hall.body));
  assert.equal(hall.body.patch_location_override, 'Church hall');
  const other = raw.prepare(`SELECT id FROM parishes WHERE id NOT IN ('_unassigned', ?) ORDER BY id LIMIT 1`).get(parishId).id;
  raw.prepare('UPDATE schedules SET location_parish_id = ? WHERE id = ?').run(other, sid);
  const home = await call('POST', `/api/admin/schedules/${sid}/exceptions`,
    { ...ENGLISH_LAST, weeks: ['first'], end_time: '12:00', languages: ['Arabic', 'English'], location_parish_id: null, location_override: null });
  assert.equal(home.status, 201, JSON.stringify(home.body));
  assert.equal(home.body.patch_location_parish_id, parishId, 'its own parish named: at home those weeks');
});

test('a service changed from a date on keeps its exceptions', async () => {
  const { call, raw, sid } = fresh();
  await call('POST', `/api/admin/schedules/${sid}/exceptions`, ENGLISH_LAST);
  // 13 Dec 2026 9:30am Sydney (+11:00) is 22:30Z the day before.
  const r = await call('POST', `/api/admin/events/${sid}:2026-12-13/following`,
    { action: 'edit', start_utc: '2026-12-12T22:30:00.000Z', title: 'Matins & Divine Liturgy' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const newId = r.body.schedule_id;
  const rows = raw.prepare('SELECT schedule_id, weeks, kind, patch_languages, patch_end_time FROM schedule_week_exceptions ORDER BY schedule_id').all();
  assert.deepEqual(rows.map(x => x.schedule_id), [sid, newId], 'the ended rule keeps its own for its past dates');
  assert.equal(rows[1].patch_languages, '["English"]');
  assert.equal(rows[1].patch_end_time, '11:30');
});

test('a rule deleted takes its exceptions with it', async () => {
  const { call, raw, sid } = fresh();
  await call('POST', `/api/admin/schedules/${sid}/exceptions`, ENGLISH_LAST);
  raw.prepare('DELETE FROM schedules WHERE id = ?').run(sid);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM schedule_week_exceptions').get().n, 0);
});

test('an exception on a rule nobody has is a 404', async () => {
  const { call } = fresh();
  assert.equal((await call('POST', '/api/admin/schedules/99999/exceptions', ENGLISH_LAST)).status, 404);
  assert.equal((await call('PATCH', '/api/admin/week-exceptions/99999', ENGLISH_LAST)).status, 404);
});

test("a day ticked on a service gets the service's exceptions as they are (rule-form.js exceptionCopy)", async () => {
  const RF = require('../../public/shared/rule-form.js');
  const { call, raw, sid, parishId } = fresh();
  const made = (await call('POST', `/api/admin/schedules/${sid}/exceptions`, { ...ENGLISH_LAST, location_override: 'Church hall' })).body;
  const off = (await call('POST', `/api/admin/schedules/${sid}/exceptions`, { weeks: ['first'], kind: 'not_held' })).body;
  const sat = Number(raw.prepare(`INSERT INTO schedules (parish_id, day_of_week, start_time, end_time, title, event_type, languages)
    VALUES (?, 6, '09:00', '12:00', 'Matins & Divine Liturgy', 'liturgy', '["Arabic","English"]')`).run(parishId).lastInsertRowid);
  const cols = (x) => { const { id, schedule_id, created_at, updated_at, updated_by, ...rest } = x; return rest; };
  for (const x of [made, off]) {
    const r = await call('POST', `/api/admin/schedules/${sat}/exceptions`, RF.exceptionCopy(x));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(cols(r.body), cols(x));
  }
  // A rule held elsewhere: an exception that says nothing of the place stays elsewhere.
  raw.prepare(`UPDATE schedules SET location_override = 'The school' WHERE id = ?`).run(sat);
  const plain = (await call('POST', `/api/admin/schedules/${sid}/exceptions`, { ...ENGLISH_LAST, weeks: ['second'] })).body;
  const copied = await call('POST', `/api/admin/schedules/${sat}/exceptions`, RF.exceptionCopy(plain));
  assert.equal(copied.body.patch_location_parish_id, null, 'not "at its own church"');
});

test('the form works out the row the Worker will store (rule-form.js exceptionPatch), saved or not', async () => {
  const RF = require('../../public/shared/rule-form.js');
  const { call, raw, sid, parishId } = fresh();
  const other = raw.prepare(`SELECT id FROM parishes WHERE id NOT IN ('_unassigned', ?) ORDER BY id LIMIT 1`).get(parishId).id;
  const card = (over) => RF.exceptionBody({ weeks: ['last'], title: 'Matins & Divine Liturgy', feast: '', start_time: '09:00', end_time: '12:00',
    languages: 'Arabic, English', description: '', location_override: '', location_parish_id: '', location_lat: '', location_lng: '', ...over });
  const bodies = [
    card({ end_time: '11:30', languages: 'English' }),
    card({ title: 'Liturgy in English', start_time: '10:00' }),
    card({ location_override: 'Church hall' }),
    card({ location_parish_id: other }),
    card({ feast: 'Youth Sunday', description: 'Bring a plate' }),
    RF.exceptionBody({ weeks: ['last'], not_held: true }),
  ];
  const cols = (x) => { const { id, schedule_id, created_at, updated_at, updated_by, ...rest } = x; return rest; };
  for (const body of bodies) {
    const rule = raw.prepare('SELECT * FROM schedules WHERE id = ?').get(sid);
    const r = await call('POST', `/api/admin/schedules/${sid}/exceptions`, body);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual(RF.exceptionPatch(body, rule), cols(r.body), JSON.stringify(body));
    await call('DELETE', `/api/admin/week-exceptions/${r.body.id}`);
  }
  // The same as the service is nothing, to the form as to the Worker.
  const same = card({});
  assert.ok(RF.exceptionEmpty(RF.exceptionPatch(same, raw.prepare('SELECT * FROM schedules WHERE id = ?').get(sid))));
  assert.equal((await call('POST', `/api/admin/schedules/${sid}/exceptions`, same)).status, 400);
  // A rule held elsewhere, an exception at home: its own parish named.
  raw.prepare(`UPDATE schedules SET location_override = 'The school' WHERE id = ?`).run(sid);
  const home = card({ end_time: '11:30' });
  const rule = raw.prepare('SELECT * FROM schedules WHERE id = ?').get(sid);
  const made = await call('POST', `/api/admin/schedules/${sid}/exceptions`, home);
  assert.deepEqual(RF.exceptionPatch(home, rule), cols(made.body));
  assert.equal(made.body.patch_location_parish_id, parishId);
});
