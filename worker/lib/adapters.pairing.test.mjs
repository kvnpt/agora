// A source's dated services land ON the timetable, never beside it.
//
// End to end through runAdapter against a real SQLite, because the bug this
// fixes lived between the pieces: Good Shepherd, Clayton's rules said "Matins"
// and "Liturgy", its calendar "Matins (Orthros)" and "Divine Liturgy", and the
// feed's exact-title dedup let every Sunday show both — while reconcile's
// prefix match would have cancelled every Sunday Liturgy on the next run.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runAdapter } from './adapters.mjs';
import { localSpanToUtc } from '../../public/shared/tz.mjs';

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

const PARISH = 'antiochian-good-shepherd-antiochian-church';
const TZ = 'Australia/Melbourne';
// Sun 8 Nov 00:00 to Mon 7 Dec 00:00, Melbourne: five whole Sundays.
const WINDOW = { from: '2026-11-07T13:00:00.000Z', to: '2026-12-06T13:00:00.000Z' };
const SUNDAYS = ['2026-11-08', '2026-11-15', '2026-11-22', '2026-11-29', '2026-12-06'];

function fresh({ key = null } = {}) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-p-')), 'x.db');
  const raw = new Database(p);
  raw.pragma('foreign_keys = ON');
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  // The Archdiocese's words, as production has them.
  const add = raw.prepare(`INSERT INTO schedules (parish_id, day_of_week, start_time, end_time, title, event_type, languages)
    VALUES (?, 0, ?, ?, ?, ?, '["English"]')`);
  const matins = add.run(PARISH, '09:00', null, 'Matins', 'prayer').lastInsertRowid;
  const liturgy = add.run(PARISH, '10:00', null, 'Liturgy', 'liturgy').lastInsertRowid;
  const env = { DB: new D1(raw) };
  if (key) env.ANTHROPIC_API_KEY = key;
  return { raw, env, matins: Number(matins), liturgy: Number(liturgy) };
}

let n = 0;
const entry = (title, date, start, end = null, hash = null) => ({
  title, description: null, ...localSpanToUtc(TZ, date, start, end),
  event_type: /liturg/i.test(title) ? 'liturgy' : 'other', source_url: null,
  source_hash: hash || `h-${title}-${date}-${start}-${n++}`,
  location_override: null, hide_live: 0, parish_scoped: 0,
});
// The calendar as Good Shepherd publishes it: stable ids per occurrence.
const sunday = (date, liturgy = { title: 'Divine Liturgy', at: '10:00', end: '12:00' }) => [
  entry('Matins (Orthros)', date, '09:00', '10:00', `m-${date}`),
  ...(liturgy ? [entry(liturgy.title, date, liturgy.at, liturgy.end, `l-${date}`)] : []),
];
const calendar = (events) => ({
  id: 'gcal-test', parishId: PARISH, sourceType: 'google-calendar', sourceName: 'Parish calendar',
  async fetchEvents() { return { events, window: WINDOW }; },
});

const overrides = (raw) => raw.prepare('SELECT * FROM schedule_overrides ORDER BY occurrence_date, schedule_id').all();
const eventTitles = (raw) => raw.prepare('SELECT title FROM events ORDER BY start_utc').all().map(r => r.title);

// A stand-in for api.anthropic.com: answers by question kind, and counts.
function fakeClaude(answer) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/v1\/messages$/);
    const body = JSON.parse(init.body);
    calls.push(body);
    const qs = body.messages[0].content.split('\n\n').map(block => {
      const [idLine, kind, ...rest] = block.split('\n');
      return { id: idLine.replace('id: ', ''), kind, text: [kind, ...rest].join('\n') };
    });
    const answers = qs.map(q => ({ id: q.id, entry: 0, sure: true, service: '', feast: '', ...answer(q) }));
    return new Response(JSON.stringify({
      stop_reason: 'end_turn',
      content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: JSON.stringify({ answers }) }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

test('a clean calendar puts nothing beside the timetable and cancels nothing', async () => {
  const { raw, env } = fresh();
  const events = [...SUNDAYS.flatMap(d => sunday(d)), entry('Bookshop', '2026-11-08', '12:00')];
  const r = await runAdapter(calendar(events), env);

  assert.strictEqual(r.eventsPaired, 10, 'five Sundays of Matins and Liturgy are the rules\' own occurrences');
  assert.deepStrictEqual(eventTitles(raw), ['Bookshop'], 'only what is not a regular service is an event');
  assert.deepStrictEqual(overrides(raw), [], 'and nothing to say about any Sunday: same times, no saint');
  assert.strictEqual(r.tombstones.created, 0, '"Liturgy" is "Divine Liturgy": no Sunday cancelled');
});

test('the second cards an earlier run wrote are retired', async () => {
  const { raw, env } = fresh();
  const events = SUNDAYS.flatMap(d => sunday(d));
  // What production holds today: every calendar entry stored as an event.
  const ins = raw.prepare(`INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type, source_hash, mutation_type)
    VALUES (?, 'gcal-test', ?, ?, 'liturgy', ?, 'headless')`);
  for (const e of events) ins.run(PARISH, e.title, e.start_utc, e.source_hash);
  // One of them somebody has put a poster on: that one is not ours to remove.
  raw.prepare("UPDATE events SET poster_path = '/posters/x.jpg' WHERE source_hash = 'l-2026-11-15'").run();

  await runAdapter(calendar(events), env);
  assert.deepStrictEqual(eventTitles(raw), ['Divine Liturgy'], 'nine retired, the one with a poster kept');
});

test('a Sunday at another hour is that Sunday moved, not a second service', async () => {
  const { raw, env, liturgy } = fresh();
  const moved = SUNDAYS.flatMap(d => sunday(d, d === '2026-11-22'
    ? { title: 'Divine Liturgy', at: '09:30', end: '11:30' } : undefined));
  // Matins at 09:00 is untouched; the Liturgy moves half an hour earlier.
  const r = await runAdapter(calendar(moved), env);

  assert.deepStrictEqual(eventTitles(raw), [], 'no card beside the rule');
  const [o] = overrides(raw);
  assert.strictEqual(overrides(raw).length, 1);
  assert.deepStrictEqual(
    { sid: o.schedule_id, date: o.occurrence_date, kind: o.kind, start: o.patch_start_time, end: o.patch_end_time, source: o.source },
    { sid: liturgy, date: '2026-11-22', kind: 'modified', start: '09:30', end: '11:30', source: 'adapter:gcal-test' });
  assert.strictEqual(r.tombstones.created, 0);

  // Moved back: the change of ours goes, and the rule speaks for the day again.
  await runAdapter(calendar(SUNDAYS.flatMap(d => sunday(d))), env);
  assert.deepStrictEqual(overrides(raw), []);
});

test('a Sunday the calendar drops is cancelled, and restored when it returns', async () => {
  const { raw, env, liturgy } = fresh();
  const without = SUNDAYS.flatMap(d => sunday(d, d === '2026-11-29' ? null : undefined));
  await runAdapter(calendar(without), env);
  assert.deepStrictEqual(overrides(raw).map(o => [o.schedule_id, o.occurrence_date, o.kind]),
    [[liturgy, '2026-11-29', 'cancelled']]);

  await runAdapter(calendar(SUNDAYS.flatMap(d => sunday(d))), env);
  assert.deepStrictEqual(overrides(raw), [], 'back on the calendar, back on the page');
});

test("a person's word on a Sunday is never written over", async () => {
  const { raw, env, liturgy } = fresh();
  raw.prepare(`INSERT INTO schedule_overrides (schedule_id, occurrence_date, kind, patch_start_time, source)
    VALUES (?, '2026-11-22', 'modified', '08:00', 'human')`).run(liturgy);
  const moved = SUNDAYS.flatMap(d => sunday(d, d === '2026-11-22'
    ? { title: 'Divine Liturgy', at: '09:30', end: '11:30' } : undefined));
  await runAdapter(calendar(moved), env);
  const [o] = overrides(raw);
  assert.deepStrictEqual([o.patch_start_time, o.source], ['08:00', 'human']);
});

test('the day\'s saint goes under the title, and is asked about once', async () => {
  const { raw, env, liturgy } = fresh({ key: 'test-key' });
  const claude = fakeClaude(q => (q.kind === 'subtitle' && /St Nicholas/.test(q.text) ? { feast: 'St Nicholas' } : {}));
  try {
    const events = SUNDAYS.flatMap(d => sunday(d, d === '2026-12-06'
      ? { title: 'Divine Liturgy – St Nicholas', at: '10:00', end: '12:00' } : undefined));
    await runAdapter(calendar(events), env);
    assert.strictEqual(claude.calls.length, 1, 'one request for the run');
    assert.strictEqual(claude.calls[0].model, 'claude-haiku-5-5');
    assert.ok(!('temperature' in claude.calls[0]), 'Haiku 5.5 rejects sampling parameters');
    assert.match(claude.calls[0].messages[0].content, /Divine Liturgy – St Nicholas/);
    assert.doesNotMatch(claude.calls[0].messages[0].content, /Matins \(Orthros\)/,
      'a title with nothing beyond its service is never asked about');

    const [o] = overrides(raw);
    assert.deepStrictEqual([o.schedule_id, o.occurrence_date, o.patch_feast, o.patch_start_time],
      [liturgy, '2026-12-06', 'St Nicholas', null]);

    await runAdapter(calendar(events), env);
    assert.strictEqual(claude.calls.length, 1, 'the answer is remembered, not asked for again');
    assert.strictEqual(overrides(raw)[0].patch_feast, 'St Nicholas');
  } finally { claude.restore(); }
});

test('a service under the feast\'s name, at another hour, is found by asking', async () => {
  const { raw, env, liturgy } = fresh({ key: 'test-key' });
  const claude = fakeClaude(q => (q.kind === 'which' && /"Liturgy" at 10:00/.test(q.text) && /Feast of St Nicholas/.test(q.text)
    ? { entry: 1, sure: true, service: 'Divine Liturgy', feast: 'St Nicholas' } : {}));
  try {
    const events = SUNDAYS.flatMap(d => sunday(d, d === '2026-12-06' ? null : undefined));
    events.push(entry('Feast of St Nicholas', '2026-12-06', '09:30', '11:30'));
    const r = await runAdapter(calendar(events), env);

    assert.deepStrictEqual(eventTitles(raw), [], 'it was the Liturgy, so no card of its own');
    const [o] = overrides(raw);
    assert.deepStrictEqual([o.schedule_id, o.occurrence_date, o.kind, o.patch_start_time, o.patch_feast, o.patch_title],
      [liturgy, '2026-12-06', 'modified', '09:30', 'St Nicholas', null],
      'the same service keeps the timetable\'s name');
    assert.strictEqual(r.tombstones.created, 0);
  } finally { claude.restore(); }
});

test('an unsure answer cancels nothing, and asks whoever keeps the parish once', async () => {
  const { raw, env } = fresh({ key: 'test-key' });
  const claude = fakeClaude(q => (q.kind === 'which' ? { entry: 1, sure: false } : {}));
  try {
    const events = SUNDAYS.flatMap(d => sunday(d, d === '2026-12-06' ? null : undefined));
    events.push(entry('Parish feast day', '2026-12-06', '09:30'));
    const r = await runAdapter(calendar(events), env);

    assert.strictEqual(r.tombstones.created, 0, 'the rules alone would have cancelled it; unsure holds it back');
    assert.deepStrictEqual(eventTitles(raw), ['Parish feast day'], 'and the entry shows as itself meanwhile');
    const s = raw.prepare('SELECT * FROM parish_suggestions').all();
    assert.strictEqual(s.length, 1);
    assert.deepStrictEqual([s[0].parish_id, s[0].kind, s[0].email, s[0].name], [PARISH, 'change', 'adapter:gcal-test', 'Parish calendar']);
    assert.match(s[0].about, /Sunday 6 December 2026, Liturgy at 10:00/);
    assert.match(s[0].body, /^The parish calendar shows "Parish feast day"/);

    await runAdapter(calendar(events), env);
    assert.strictEqual(raw.prepare('SELECT COUNT(*) n FROM parish_suggestions').get().n, 1, 'said once, not every run');
    assert.strictEqual(claude.calls.length, 1);
  } finally { claude.restore(); }
});

test('an answer can never cause a cancellation the rules would not make', async () => {
  // Something else at the Liturgy's exact minute: the rules leave the Liturgy
  // standing. A model saying "that is not the Liturgy" must not change that.
  const { raw, env } = fresh({ key: 'test-key' });
  const claude = fakeClaude(() => ({ entry: 0, sure: true }));
  try {
    const events = SUNDAYS.flatMap(d => sunday(d, d === '2026-12-06' ? null : undefined));
    events.push(entry('Memorial service', '2026-12-06', '10:00'));
    const r = await runAdapter(calendar(events), env);
    assert.strictEqual(r.tombstones.created, 0);
    assert.deepStrictEqual(overrides(raw), []);
    assert.deepStrictEqual(eventTitles(raw), ['Memorial service']);
  } finally { claude.restore(); }
});

test('without a key the rules decide, and nothing is lost but the subtitle', async () => {
  const { raw, env } = fresh();
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('no network in this test'); };
  try {
    const events = SUNDAYS.flatMap(d => sunday(d, d === '2026-12-06'
      ? { title: 'Divine Liturgy – St Nicholas', at: '10:00', end: '12:00' } : undefined));
    const r = await runAdapter(calendar(events), env);
    assert.strictEqual(r.eventsPaired, 10);
    assert.deepStrictEqual(eventTitles(raw), []);
    assert.deepStrictEqual(overrides(raw), []);
  } finally { globalThis.fetch = real; }
});

test('a source with no window pairs nothing: every entry is an event, as before', async () => {
  const { raw, env } = fresh();
  const bare = { ...calendar([]), async fetchEvents() { return sunday('2026-11-08'); } };
  const r = await runAdapter(bare, env);
  assert.strictEqual(r.eventsPaired, 0);
  assert.deepStrictEqual(eventTitles(raw), ['Matins (Orthros)', 'Divine Liturgy']);
});
