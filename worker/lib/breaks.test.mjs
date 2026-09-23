// Breaks — a stretch of dates a service is not running.
//
// The property that matters most is the one CLAUDE.md states for the whole
// lens: NOTHING DISAPPEARS. A break is a tombstone, not a gap, so the count of
// instances a window produces is the same with a break as without one — what
// changes is what they SAY.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expandWindow, expandOne, breaksFor, breakCovering, nextOccurrenceAfterBreak }
  from './expand.mjs';
import { expandFrom } from '../../public/shared/project.mjs';
import { filterByStatus, dedupe } from '../../public/shared/merge.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-')), 'x.db');

class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new D1Stmt(this.db, sql, []); }
}
class D1Stmt {
  constructor(db, sql, args) { this.db = db; this.sql = sql; this.args = args; }
  bind(...args) { return new D1Stmt(this.db, this.sql, args); }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args), success: true }; }
  async first() { const r = this.db.prepare(this.sql).get(...this.args); return r === undefined ? null : r; }
  async run() { this.db.prepare(this.sql).run(...this.args); return { success: true }; }
}

function buildD1() {
  const db = new Database(tmp());
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  db.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  return db;
}

const FROM = '2026-11-01T00:00:00.000Z';
const TO = '2027-02-01T00:00:00.000Z';

// A rule in hand, shaped the way the bundle ships one.
const RULE = {
  id: 1, parish_id: 'p1', day_of_week: 0, start_time: '09:00', end_time: null,
  title: 'Divine Liturgy', event_type: 'liturgy', week_of_month: null, week_parity: null,
  p_timezone: 'Australia/Sydney', parish_name: 'Test', created_at: '2026-01-01T00:00:00Z',
};
const BREAK = {
  id: 1, parish_id: 'p1', schedule_id: 1,
  from_date: '2026-12-20', to_date: '2027-01-06', note: 'Christmas break',
};

// ── Nothing disappears ───────────────────────────────────────────────────

test('a break changes what an occurrence says, never whether it exists', () => {
  const without = expandFrom({ schedules: [RULE], overrides: [] }, FROM, TO);
  const withIt = expandFrom({ schedules: [RULE], overrides: [], breaks: [BREAK] }, FROM, TO);
  assert.equal(withIt.length, without.length, 'a break removed instances from the window');
  assert.deepEqual(withIt.map(i => i.id), without.map(i => i.id));
});

test('covered occurrences are BREAK tombstones that carry their window and reason', () => {
  const out = expandFrom({ schedules: [RULE], overrides: [], breaks: [BREAK] }, FROM, TO);
  const covered = out.filter(i => i.id.slice(2) >= BREAK.from_date && i.id.slice(2) <= BREAK.to_date);
  assert.ok(covered.length >= 2, `expected Sundays inside the break, got ${covered.length}`);
  for (const i of covered) {
    assert.equal(i.status, 'break');
    assert.equal(i.is_tombstone, 1);
    assert.equal(i.break_note, 'Christmas break');
    assert.equal(i.break_from, BREAK.from_date);
    assert.equal(i.break_until, BREAK.to_date);
  }
  for (const i of out.filter(x => !covered.includes(x))) {
    assert.equal(i.status, 'approved');
    assert.equal(i.break_note, null);
  }
});

test('a BREAK tombstone survives the default feed filter, like CANCELLED does', () => {
  const out = expandFrom({ schedules: [RULE], overrides: [], breaks: [BREAK] }, FROM, TO);
  const shown = filterByStatus(out);
  assert.equal(shown.length, out.length, 'the default filter dropped a break');
  assert.ok(shown.some(i => i.status === 'break'));
  // …and it is still findable when an admin asks for that status alone.
  assert.ok(filterByStatus(out, 'break').every(i => i.status === 'break'));
});

test('a break is inclusive at both ends', () => {
  const single = { ...BREAK, from_date: '2026-12-27', to_date: '2026-12-27' };
  const out = expandFrom({ schedules: [RULE], overrides: [], breaks: [single] }, FROM, TO);
  const on = out.find(i => i.id === '1:2026-12-27');
  assert.equal(on.status, 'break');
  assert.equal(out.find(i => i.id === '1:2026-12-20').status, 'approved');
  assert.equal(out.find(i => i.id === '1:2027-01-03').status, 'approved');
});

// ── Precedence ───────────────────────────────────────────────────────────

test('an explicit override beats the break covering the same date', () => {
  // The narrower statement is the later thought, and it is how one service is
  // put back mid-break without cutting the break in two.
  const ov = { schedule_id: 1, occurrence_date: '2026-12-27', kind: 'modified',
               patch_title: 'Nativity Liturgy' };
  const out = expandFrom({ schedules: [RULE], overrides: [ov], breaks: [BREAK] }, FROM, TO);
  const it = out.find(i => i.id === '1:2026-12-27');
  assert.equal(it.status, 'approved');
  assert.equal(it.title, 'Nativity Liturgy');
  assert.equal(it.break_note, null, 'the override should not inherit the break');
  // Its neighbours inside the window are untouched.
  assert.equal(out.find(i => i.id === '1:2027-01-03').status, 'break');
});

test('a cancellation inside a break stays a cancellation', () => {
  const ov = { schedule_id: 1, occurrence_date: '2026-12-27', kind: 'cancelled' };
  const out = expandFrom({ schedules: [RULE], overrides: [ov], breaks: [BREAK] }, FROM, TO);
  assert.equal(out.find(i => i.id === '1:2026-12-27').status, 'cancelled');
});

// ── Scope: one rule, or the whole parish ─────────────────────────────────

test('a break with no schedule_id speaks for every rule at that parish', () => {
  const other = { ...RULE, id: 2, day_of_week: 3, title: 'Vespers' };
  const elsewhere = { ...RULE, id: 3, parish_id: 'p2', title: 'Liturgy elsewhere' };
  const parishWide = { ...BREAK, id: 9, schedule_id: null };
  const out = expandFrom(
    { schedules: [RULE, other, elsewhere], overrides: [], breaks: [parishWide] }, FROM, TO);
  const inside = (i) => i.id.split(':')[1] >= BREAK.from_date && i.id.split(':')[1] <= BREAK.to_date;

  assert.ok(out.filter(i => i.schedule_id === 1 && inside(i)).every(i => i.status === 'break'));
  assert.ok(out.filter(i => i.schedule_id === 2 && inside(i)).every(i => i.status === 'break'),
    'the parish-wide break missed the second rule');
  assert.ok(out.filter(i => i.schedule_id === 3).every(i => i.status === 'approved'),
    "another parish's rule was caught by it");
});

test('a rule-scoped break leaves the parish\'s other rules running', () => {
  const other = { ...RULE, id: 2, day_of_week: 3, title: 'Vespers' };
  const out = expandFrom({ schedules: [RULE, other], overrides: [], breaks: [BREAK] }, FROM, TO);
  assert.ok(out.filter(i => i.schedule_id === 2).every(i => i.status === 'approved'));
});

// ── Coming back ─────────────────────────────────────────────────────────

test('the resume date is the rule\'s next real occurrence, not the day after the break', () => {
  // The break ends on a Wednesday; the rule is Sunday, so it comes back on the
  // 10th, not the 7th.
  assert.equal(BREAK.to_date, '2027-01-06');
  assert.equal(new Date(BREAK.to_date + 'T00:00:00Z').getUTCDay(), 3);
  assert.equal(nextOccurrenceAfterBreak(RULE, BREAK.from_date, [BREAK]), '2027-01-10');
});

test('back-to-back breaks are stepped over, not stopped at', () => {
  const second = { ...BREAK, id: 2, from_date: '2027-01-07', to_date: '2027-01-20', note: 'works' };
  assert.equal(nextOccurrenceAfterBreak(RULE, '2026-12-20', [BREAK, second]), '2027-01-24');
});

test('a fortnightly rule resumes on its own week, not the first Sunday going', () => {
  const fortnightly = { ...RULE, week_parity: 'b' };
  const resume = nextOccurrenceAfterBreak(fortnightly, BREAK.from_date, [BREAK]);
  assert.ok(resume > BREAK.to_date);
  assert.equal(new Date(resume + 'T00:00:00Z').getUTCDay(), 0);
  // It is one of the rule's own dates, which is the whole point.
  const projected = expandFrom({ schedules: [fortnightly], overrides: [] }, FROM, TO)
    .map(i => i.id.split(':')[1]);
  assert.ok(projected.includes(resume), `${resume} is not a date this rule runs`);
});

test('a break with no end in sight reports no resume date rather than inventing one', () => {
  const forever = { ...BREAK, to_date: '2099-01-01' };
  assert.equal(nextOccurrenceAfterBreak(RULE, '2026-12-20', [forever]), null);
});

test('breaksFor narrows to the rule, and breakCovering to the date', () => {
  const parishWide = { ...BREAK, id: 9, schedule_id: null, from_date: '2027-03-01', to_date: '2027-03-31' };
  const elsewhere = { ...BREAK, id: 8, schedule_id: null, parish_id: 'p2' };
  const mine = breaksFor(RULE, [BREAK, parishWide, elsewhere]);
  assert.deepEqual(mine.map(b => b.id), [1, 9], 'sorted by start, and p2 excluded');
  assert.equal(breakCovering(RULE, '2026-12-25', [BREAK])?.id, 1);
  assert.equal(breakCovering(RULE, '2026-12-19', [BREAK]), null);
});

// ── Against the real schema ──────────────────────────────────────────────

test('the Worker reads breaks out of D1 and a deep link lands on the tombstone', async () => {
  const raw = buildD1();
  const db = new D1(raw);
  const rule = raw.prepare('SELECT * FROM schedules WHERE active = 1 LIMIT 1').get();
  // A Sunday inside the break, found from the rule's own weekday.
  let date = '2026-12-20';
  while (new Date(date + 'T00:00:00Z').getUTCDay() !== rule.day_of_week) {
    date = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  }
  raw.prepare(
    `INSERT INTO schedule_breaks (parish_id, schedule_id, from_date, to_date, note)
     VALUES (?,?,?,?,?)`
  ).run(rule.parish_id, rule.id, '2026-12-20', '2027-01-06', 'Christmas break');

  const instances = await expandWindow(db, FROM, TO);
  const covered = instances.filter(i => i.schedule_id === rule.id && i.status === 'break');
  assert.ok(covered.length >= 1, 'no break tombstones came back from the database');
  assert.ok(covered.every(i => i.break_note === 'Christmas break'));

  const one = await expandOne(db, rule.id, date);
  assert.equal(one.status, 'break', 'a deep link into a break resolved to the service running');
  assert.equal(one.break_until, '2027-01-06');
});

test('a parish-wide row in D1 covers a rule that does not name it', async () => {
  const raw = buildD1();
  const db = new D1(raw);
  const rule = raw.prepare('SELECT * FROM schedules WHERE active = 1 LIMIT 1').get();
  raw.prepare(
    `INSERT INTO schedule_breaks (parish_id, schedule_id, from_date, to_date, note)
     VALUES (?,NULL,?,?,?)`
  ).run(rule.parish_id, '2026-12-20', '2027-01-06', 'Parish closed');
  const instances = await expandWindow(db, FROM, TO, { scheduleId: rule.id });
  assert.ok(instances.some(i => i.status === 'break'),
    'narrowing to one rule dropped the parish-wide break that silences it');
});

test('the CHECK refuses a break that ends before it starts', () => {
  const raw = buildD1();
  const rule = raw.prepare('SELECT * FROM schedules WHERE active = 1 LIMIT 1').get();
  assert.throws(() => raw.prepare(
    `INSERT INTO schedule_breaks (parish_id, schedule_id, from_date, to_date, note)
     VALUES (?,?,?,?,?)`
  ).run(rule.parish_id, rule.id, '2027-01-06', '2026-12-20', 'backwards'), /CHECK/);
});

test('a break does not survive its rule being deleted', () => {
  const raw = buildD1();
  const rule = raw.prepare('SELECT * FROM schedules WHERE active = 1 LIMIT 1').get();
  raw.prepare(
    `INSERT INTO schedule_breaks (parish_id, schedule_id, from_date, to_date, note)
     VALUES (?,?,?,?,?)`
  ).run(rule.parish_id, rule.id, '2026-12-20', '2027-01-06', 'Christmas');
  raw.prepare('DELETE FROM schedules WHERE id = ?').run(rule.id);
  assert.equal(raw.prepare('SELECT COUNT(*) AS n FROM schedule_breaks').get().n, 0,
    'ON DELETE CASCADE did not clear the break');
});

// ── Dedup ────────────────────────────────────────────────────────────────

test('a break tombstone still dedups against its twin rather than doubling the card', () => {
  const twin = { ...RULE, id: 2 };
  const out = expandFrom({ schedules: [RULE, twin], overrides: [], breaks: [BREAK] }, FROM, TO);
  const onDate = out.filter(i => i.id.endsWith(':2026-12-27'));
  assert.equal(onDate.length, 2, 'both rules should project');
  assert.equal(dedupe(onDate).length, 1, 'two identical services became two cards');
});
