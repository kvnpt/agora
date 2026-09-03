// Equivalence test: the ported lens must produce the same instances as the
// Express one it replaces.
//
//   npm test
//
// Both lenses run over identically-seeded databases — the old one on the v29
// migration schema with better-sqlite3 and the Temporal polyfill, the new one on
// d1/schema.sql through a D1-shaped adapter and the OffsetCache. Any divergence
// in the projected output is a port bug.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expandWindow, expandOne, parseInstanceId, isValidOccurrence } from './expand.mjs';

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

// Old world: db.js migrations + the Node seeder.
function buildLegacy() {
  const p = tmp();
  process.env.AGORA_DB_PATH = p;
  for (const m of ['../../db.js', '../../seeds/parishes.js', '../../schedule-expand.js']) {
    delete require.cache[require.resolve(m)];
  }
  const { getDb } = require('../../db.js');
  const { seed } = require('../../seeds/parishes.js');
  const db = getDb();
  seed();
  return { db, legacyExpand: require('../../schedule-expand.js') };
}

// New world: d1/schema.sql + the generated seed.
function buildD1() {
  const db = new Database(tmp());
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  db.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  return db;
}

const FROM = '2026-09-01T00:00:00.000Z';
const TO = '2026-12-01T00:00:00.000Z';

// Fields the legacy projection also produces. start_local/end_local/timezone are
// additions of the port and have no legacy counterpart.
const SHARED = [
  'id', 'parish_id', 'schedule_id', 'source_adapter', 'title', 'description', 'feast',
  'start_utc', 'end_utc', 'location_override', 'lat', 'lng', 'event_type', 'languages',
  'hide_live', 'parish_scoped', 'source_url', 'source_hash', 'confidence', 'mutation_type',
  'status', 'is_tombstone', 'combined_into_event_id', 'created_at', 'updated_at',
  'parish_name', 'jurisdiction', 'parish_address', 'parish_website', 'parish_logo',
  'parish_languages', 'parish_acronym', 'parish_color', 'parish_live_url',
  'concurrent', 'week_of_month',
];
const pick = (o) => Object.fromEntries(SHARED.map(k => [k, o[k] === undefined ? null : o[k]]));

test('ported lens matches the Express lens over a 3-month window', async () => {
  const { db: legacyDb, legacyExpand } = buildLegacy();
  const d1Db = buildD1();

  const legacy = legacyExpand.expandWindow(legacyDb, FROM, TO)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const ported = (await expandWindow(new D1(d1Db), FROM, TO))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  assert.ok(legacy.length > 100, `expected a substantial window, got ${legacy.length}`);
  assert.strictEqual(ported.length, legacy.length, 'instance count differs');
  for (let i = 0; i < legacy.length; i++) {
    assert.deepStrictEqual(pick(ported[i]), pick(legacy[i]), `instance ${legacy[i].id} differs`);
  }
});

test('ported lens matches with overrides of every kind applied', async () => {
  const { db: legacyDb, legacyExpand } = buildLegacy();
  const d1Db = buildD1();

  // Pick four real occurrences and override one of each kind, identically.
  const base = legacyExpand.expandWindow(legacyDb, FROM, TO);
  const targets = [];
  const seen = new Set();
  for (const e of base) {
    if (seen.has(e.schedule_id)) continue;
    seen.add(e.schedule_id);
    targets.push(parseInstanceId(e.id));
    if (targets.length === 4) break;
  }
  const kinds = ['modified', 'cancelled', 'combined', 'hidden'];

  for (const db of [legacyDb, d1Db]) {
    // A combining event for the 'combined' override to point at.
    const p = db.prepare("SELECT id, lat, lng FROM parishes WHERE id != '_unassigned' LIMIT 1").get();
    db.prepare(
      "INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type, source_hash, lat, lng)" +
      " VALUES (?, 'manual', 'Combiner', '2026-09-20T00:00:00.000Z', 'feast', 'h-combine', ?, ?)"
    ).run(p.id, p.lat, p.lng);
    const combiner = db.prepare("SELECT id FROM events WHERE source_hash = 'h-combine'").get().id;

    targets.forEach((t, i) => {
      const kind = kinds[i];
      db.prepare(
        'INSERT INTO schedule_overrides (schedule_id, occurrence_date, kind, patch_title,' +
        ' patch_start_time, combined_into_event_id, updated_at) VALUES (?,?,?,?,?,?,?)'
      ).run(
        t.scheduleId, t.date, kind,
        kind === 'modified' ? 'Patched Title' : null,
        kind === 'modified' ? '18:45' : null,
        kind === 'combined' ? combiner : null,
        '2026-09-01T00:00:00Z',
      );
    });
  }

  const legacy = legacyExpand.expandWindow(legacyDb, FROM, TO)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const ported = (await expandWindow(new D1(d1Db), FROM, TO))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));

  assert.strictEqual(ported.length, legacy.length);
  for (let i = 0; i < legacy.length; i++) {
    assert.deepStrictEqual(pick(ported[i]), pick(legacy[i]), `instance ${legacy[i].id} differs`);
  }

  // The overrides actually took effect, so the comparison above wasn't vacuous.
  const statuses = new Set(ported.map(e => e.status));
  assert.ok(statuses.has('cancelled'), 'expected a cancelled tombstone');
  assert.ok(statuses.has('combined'), 'expected a combined tombstone');
  assert.ok(statuses.has('hidden'), 'expected a hidden instance');
  assert.ok(ported.some(e => e.mutation_type === 'adapted' && e.title === 'Patched Title'),
    'expected a modified instance');
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
