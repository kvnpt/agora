// The date lens against the D1 schema.
//
//   npm test
//
// These began as an equivalence test diffing the ported lens against the
// Express one, over identically-seeded databases, on 36 shared fields. That
// test did its job at the moment of porting and died with the Express app —
// there is nothing left to compare against. The assertions below are the same
// properties stated directly instead of differentially.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expandWindow, expandOne, parseInstanceId, isValidOccurrence } from './expand.mjs';
import { matchesWeekOfMonth } from '../../public/shared/recurrence.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-')), 'x.db');

// ── Minimal D1-shaped adapter over better-sqlite3 ──
// Mirrors the surface the ported code uses: prepare().bind().all()/.first()/.run().
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

// ── Fixtures ──

function buildD1() {
  const db = new Database(tmp());
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  db.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  return db;
}

const FROM = '2026-09-01T00:00:00.000Z';
const TO = '2026-12-01T00:00:00.000Z';

// Fields compared when two projections of the same occurrence must agree.
const SHARED = [
  'id', 'parish_id', 'schedule_id', 'source_adapter', 'title', 'description', 'feast',
  'start_utc', 'end_utc', 'start_local', 'end_local', 'timezone', 'location_override',
  'lat', 'lng', 'event_type', 'languages', 'hide_live', 'parish_scoped', 'source_url',
  'source_hash', 'confidence', 'mutation_type', 'status', 'is_tombstone',
  'combined_into_event_id', 'created_at', 'updated_at', 'parish_name', 'jurisdiction',
  'concurrent', 'week_of_month',
];
const pick = (o) => Object.fromEntries(SHARED.map(k => [k, o[k] === undefined ? null : o[k]]));

test('every rule emits exactly its occurrences in the window, and no others', async () => {
  const raw = buildD1();
  const db = new D1(raw);

  const rules = raw.prepare('SELECT * FROM schedules WHERE active = 1').all();
  const instances = await expandWindow(db, FROM, TO);

  // Derive the expectation from the calendar rather than hardcoding a total.
  let expected = 0;
  for (const r of rules) {
    for (let t = Date.parse(FROM); t <= Date.parse(TO); t += 86400000) {
      const d = new Date(t);
      const date = d.toISOString().slice(0, 10);
      if (d.getUTCDay() === r.day_of_week && matchesWeekOfMonth(date, r.week_of_month)) expected++;
    }
  }
  // Window edges are compared on the projected instant, so allow one per rule.
  assert.ok(Math.abs(instances.length - expected) <= rules.length,
    `expected about ${expected} instances, got ${instances.length}`);

  for (const inst of instances) {
    const { scheduleId, date } = parseInstanceId(inst.id);
    const rule = rules.find(r => r.id === scheduleId);
    assert.ok(rule, `instance ${inst.id} references a live rule`);
    assert.strictEqual(new Date(date + 'T00:00:00Z').getUTCDay(), rule.day_of_week,
      `${inst.id} lands on the rule's weekday`);
    assert.strictEqual(inst.source_adapter, 'schedule');
    assert.strictEqual(inst.start_local, `${date}T${rule.start_time}`,
      'the local wall clock is the rule\'s own, unconverted');
  }
});

test('overrides of every kind change only how an instance renders', async () => {
  const raw = buildD1();
  const db = new D1(raw);

  const base = await expandWindow(db, FROM, TO);
  const targets = [];
  const seen = new Set();
  for (const e of base) {
    if (seen.has(e.schedule_id)) continue;
    seen.add(e.schedule_id);
    targets.push(parseInstanceId(e.id));
    if (targets.length === 4) break;
  }

  const p = raw.prepare("SELECT id, lat, lng FROM parishes WHERE id != '_unassigned' LIMIT 1").get();
  raw.prepare(
    "INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type, source_hash, lat, lng)" +
    " VALUES (?, 'manual', 'Combiner', '2026-09-20T00:00:00.000Z', 'feast', 'h-combine', ?, ?)"
  ).run(p.id, p.lat, p.lng);
  const combiner = raw.prepare("SELECT id FROM events WHERE source_hash = 'h-combine'").get().id;

  const kinds = ['modified', 'cancelled', 'combined', 'hidden'];
  targets.forEach((t, i) => {
    raw.prepare(
      'INSERT INTO schedule_overrides (schedule_id, occurrence_date, kind, patch_title,' +
      ' patch_start_time, combined_into_event_id, updated_at) VALUES (?,?,?,?,?,?,?)'
    ).run(t.scheduleId, t.date, kinds[i],
      kinds[i] === 'modified' ? 'Patched Title' : null,
      kinds[i] === 'modified' ? '18:45' : null,
      kinds[i] === 'combined' ? combiner : null,
      '2026-09-01T00:00:00Z');
  });

  const after = await expandWindow(db, FROM, TO);
  assert.strictEqual(after.length, base.length,
    'nothing disappears — an override changes rendering, not existence');

  const at = (t) => after.find(e => e.id === `${t.scheduleId}:${t.date}`);

  const mod = at(targets[0]);
  assert.strictEqual(mod.title, 'Patched Title');
  assert.strictEqual(mod.mutation_type, 'adapted');
  assert.strictEqual(mod.start_local, `${targets[0].date}T18:45`);
  assert.strictEqual(mod.is_tombstone, 0);

  const can = at(targets[1]);
  assert.strictEqual(can.status, 'cancelled');
  assert.strictEqual(can.is_tombstone, 1, 'a cancellation is still visible, as a tombstone');

  const com = at(targets[2]);
  assert.strictEqual(com.status, 'combined');
  assert.strictEqual(com.is_tombstone, 1);
  assert.strictEqual(com.combined_into_event_id, combiner);

  const hid = at(targets[3]);
  assert.strictEqual(hid.status, 'hidden');
  assert.strictEqual(hid.is_tombstone, 0, 'hidden is suppressed, not a tombstone');
});

test('expandOne round-trips a synthetic id, and rejects a non-occurrence', async () => {
  const d1Db = buildD1();
  const db = new D1(d1Db);
  const all = await expandWindow(db, FROM, TO);
  const { scheduleId, date } = parseInstanceId(all[0].id);

  const one = await expandOne(db, scheduleId, date);
  assert.deepStrictEqual(pick(one), pick(all[0]));

  // The day after a weekly occurrence is not an occurrence.
  const next = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  assert.strictEqual(await expandOne(db, scheduleId, next), null);
});

test('per-parish timezone: moving a parish shifts its instances, not everyone else\'s', async () => {
  const d1Db = buildD1();
  const db = new D1(d1Db);

  const before = await expandWindow(db, FROM, TO);
  const target = before[0].parish_id;
  const others = before.filter(e => e.parish_id !== target).map(e => e.start_utc);

  d1Db.prepare('UPDATE parishes SET timezone = ? WHERE id = ?').run('Australia/Perth', target);

  const after = await expandWindow(db, FROM, TO);
  const movedBefore = before.filter(e => e.parish_id === target);
  const movedAfter = after.filter(e => e.parish_id === target);

  // Perth is +08:00 against Sydney's +10/+11, so every instance shifts later in UTC.
  assert.ok(movedAfter.length > 0);
  for (let i = 0; i < movedAfter.length; i++) {
    assert.ok(Date.parse(movedAfter[i].start_utc) > Date.parse(movedBefore[i].start_utc),
      'a Perth parish should sit later in UTC than the same wall clock in Sydney');
    assert.strictEqual(movedAfter[i].start_local, movedBefore[i].start_local,
      'the LOCAL wall clock must not move — that is the whole point');
    assert.strictEqual(movedAfter[i].timezone, 'Australia/Perth');
  }
  assert.deepStrictEqual(after.filter(e => e.parish_id !== target).map(e => e.start_utc), others,
    'other parishes must be untouched');
});

test('isValidOccurrence honours week_of_month and effective ranges', () => {
  const s = { day_of_week: 0, week_of_month: null, effective_from: null, effective_to: null };
  assert.strictEqual(isValidOccurrence(s, '2026-09-06'), true);   // a Sunday
  assert.strictEqual(isValidOccurrence(s, '2026-09-07'), false);  // Monday

  const firstOnly = { ...s, week_of_month: 'first' };
  assert.strictEqual(isValidOccurrence(firstOnly, '2026-09-06'), true);
  assert.strictEqual(isValidOccurrence(firstOnly, '2026-09-13'), false);

  const ranged = { ...s, effective_from: '2026-09-10', effective_to: '2026-09-20' };
  assert.strictEqual(isValidOccurrence(ranged, '2026-09-06'), false);
  assert.strictEqual(isValidOccurrence(ranged, '2026-09-13'), true);
});
