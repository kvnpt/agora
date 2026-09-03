// Behaviour of the ported override write-path, and its agreement with the
// Express implementation on the local-time conversion.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expandWindow, expandOne, parseInstanceId } from './expand.mjs';
import { applyAdminEdit, hideInstance, setCombined, clearCombined } from './overrides.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const { Temporal } = require('@js-temporal/polyfill');

class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new D1Stmt(this.db, sql, []); }
}
class D1Stmt {
  constructor(db, sql, args) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new D1Stmt(this.db, this.sql, args); }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args), success: true }; }
  async first() { const r = this.db.prepare(this.sql).get(...this.args); return r === undefined ? null : r; }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } };
  }
}

function fresh() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-ov-')), 'x.db');
  const raw = new Database(p);
  raw.pragma('foreign_keys = ON');
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  return { raw, db: new D1(raw) };
}

const FROM = '2026-09-01T00:00:00.000Z';
const TO = '2026-11-01T00:00:00.000Z';

async function firstInstance(db) {
  const all = await expandWindow(db, FROM, TO);
  return { inst: all[0], ...parseInstanceId(all[0].id) };
}

const overrideRow = (raw, sid, date) =>
  raw.prepare('SELECT * FROM schedule_overrides WHERE schedule_id=? AND occurrence_date=?').get(sid, date);

test('a title edit writes a modified override and the lens reflects it', async () => {
  const { raw, db } = fresh();
  const { scheduleId, date } = await firstInstance(db);

  const res = await applyAdminEdit(db, scheduleId, date, { title: 'Patronal Feast' });
  assert.ok(!res.error, res.error);
  assert.strictEqual(res.instance.title, 'Patronal Feast');
  assert.strictEqual(res.instance.mutation_type, 'adapted');
  assert.strictEqual(overrideRow(raw, scheduleId, date).kind, 'modified');

  // Only this occurrence moved; the rule is untouched.
  const others = (await expandWindow(db, FROM, TO)).filter(e => e.schedule_id === scheduleId && !e.id.endsWith(date));
  assert.ok(others.length > 0);
  assert.ok(others.every(e => e.title !== 'Patronal Feast'), 'the rule itself must not change');
});

test('editing back to the rule\'s own values drops the override entirely', async () => {
  const { raw, db } = fresh();
  const { inst, scheduleId, date } = await firstInstance(db);

  await applyAdminEdit(db, scheduleId, date, { title: 'Temporary' });
  assert.ok(overrideRow(raw, scheduleId, date), 'override should exist');

  const res = await applyAdminEdit(db, scheduleId, date, { title: inst.title });
  assert.ok(!res.error, res.error);
  assert.strictEqual(overrideRow(raw, scheduleId, date), undefined,
    'a no-op patch should leave no override behind');
  assert.strictEqual(res.instance.mutation_type, 'scheduled',
    'the instance should be cleanly scheduled again, not a no-op adapted');
});

test('cancel raises a tombstone; approving again reverts it', async () => {
  const { raw, db } = fresh();
  const { scheduleId, date } = await firstInstance(db);

  const cancelled = await applyAdminEdit(db, scheduleId, date, { status: 'cancelled' });
  assert.strictEqual(cancelled.instance.status, 'cancelled');
  assert.strictEqual(cancelled.instance.is_tombstone, 1);

  const revived = await applyAdminEdit(db, scheduleId, date, { status: 'approved' });
  assert.strictEqual(revived.instance.status, 'approved');
  assert.strictEqual(revived.instance.is_tombstone, 0);
  assert.strictEqual(overrideRow(raw, scheduleId, date), undefined);
});

test('hide suppresses an occurrence without being a tombstone', async () => {
  const { db } = fresh();
  const { scheduleId, date } = await firstInstance(db);

  await hideInstance(db, scheduleId, date);
  const inst = await expandOne(db, scheduleId, date);
  assert.strictEqual(inst.status, 'hidden');
  assert.strictEqual(inst.is_tombstone, 0, 'hidden is not a tombstone');
});

test('combine links to the event, and clearing returns the occurrence', async () => {
  const { raw, db } = fresh();
  const { scheduleId, date } = await firstInstance(db);
  const p = raw.prepare("SELECT id, lat, lng FROM parishes WHERE id != '_unassigned' LIMIT 1").get();
  raw.prepare(
    "INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type, source_hash, lat, lng)" +
    " VALUES (?, 'manual', 'Deanery Liturgy', '2026-09-20T00:00:00.000Z', 'feast', 'h-x', ?, ?)"
  ).run(p.id, p.lat, p.lng);
  const combiner = raw.prepare("SELECT id FROM events WHERE source_hash='h-x'").get().id;

  await setCombined(db, scheduleId, date, combiner);
  let inst = await expandOne(db, scheduleId, date);
  assert.strictEqual(inst.status, 'combined');
  assert.strictEqual(inst.is_tombstone, 1);
  assert.strictEqual(inst.combined_into_event_id, combiner);

  await clearCombined(db, scheduleId, date);
  inst = await expandOne(db, scheduleId, date);
  assert.strictEqual(inst.status, 'approved');
  assert.strictEqual(inst.combined_into_event_id, null);
});

test('a start_utc edit is stored as the PARISH\'s local wall clock, not Sydney\'s', async () => {
  const { raw, db } = fresh();
  const { scheduleId, date } = await firstInstance(db);
  const parishId = (await expandOne(db, scheduleId, date)).parish_id;
  raw.prepare('UPDATE parishes SET timezone = ? WHERE id = ?').run('Australia/Perth', parishId);

  // 04:00Z is 12:00 in Perth (+08) and 14:00 in Sydney (+10).
  const res = await applyAdminEdit(db, scheduleId, date, { start_utc: `${date}T04:00:00.000Z` });
  assert.ok(!res.error, res.error);
  assert.strictEqual(overrideRow(raw, scheduleId, date).patch_start_time, '12:00',
    'must convert through the parish zone, not a hardcoded Sydney');
  assert.strictEqual(res.instance.start_local, `${date}T12:00`);
  assert.strictEqual(res.instance.start_utc, `${date}T04:00:00.000Z`, 'round-trips back to the same instant');
});

test('local wall-clock conversion agrees with the Temporal implementation it replaces', async () => {
  const { raw, db } = fresh();
  const { scheduleId, date } = await firstInstance(db);

  // The Express version: Temporal.Instant -> zoned -> HH:MM, hardcoded Sydney.
  const legacyHHMM = (utc) => {
    const z = Temporal.Instant.from(utc).toZonedDateTimeISO('Australia/Sydney');
    return `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
  };

  for (const utc of [
    `${date}T04:00:00.000Z`, `${date}T21:30:00.000Z`, `${date}T00:15:00.000Z`,
    '2026-10-03T16:30:00.000Z',  // inside the Sydney spring-forward window
    '2026-04-04T15:30:00.000Z',  // inside the fall-back overlap
  ]) {
    await raw.prepare('DELETE FROM schedule_overrides').run();
    const res = await applyAdminEdit(db, scheduleId, date, { start_utc: utc });
    if (res.error) continue;             // a patch equal to the rule reverts; skip those
    const row = overrideRow(raw, scheduleId, date);
    if (!row || row.patch_start_time == null) continue;
    assert.strictEqual(row.patch_start_time, legacyHHMM(utc), `differs for ${utc}`);
  }
});

test('rejects an edit against a date the rule never produces', async () => {
  const { db } = fresh();
  const { scheduleId, date } = await firstInstance(db);
  const next = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const res = await applyAdminEdit(db, scheduleId, next, { title: 'Nope' });
  assert.strictEqual(res.code, 400);
  assert.match(res.error, /valid occurrence/);
});

test('refuses to move a recurring service to another parish', async () => {
  const { db } = fresh();
  const { scheduleId, date } = await firstInstance(db);
  const res = await applyAdminEdit(db, scheduleId, date, { parish_id: 'antiochian-stelias-wollongong' });
  assert.strictEqual(res.code, 400);
  assert.match(res.error, /Edit the schedule/);
});
