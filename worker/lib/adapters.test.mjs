// Adapter run bookkeeping.
//
// The Express version could not tell a created event from an updated one:
// events_updated was never incremented, and events_created counted ON CONFLICT
// updates too, because SQLite reports a change either way. With scraping as the
// primary ingestion path those counters are the health signal, so they are
// worth a test.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ADAPTERS, PENDING_PARISHES, runAdapter, guessEventType, shouldHideLive, isParishScoped, sha256Hex } from './adapters.mjs';

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

function fresh() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-a-')), 'x.db');
  const raw = new Database(p);
  raw.pragma('foreign_keys = ON');
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  return { raw, env: { DB: new D1(raw) } };
}

// A stand-in for the Google Calendar adapter, so the test needs no API key.
const fakeAdapter = (events) => ({
  id: 'test-adapter',
  parishId: 'antiochian-stgeorge-redfern',
  sourceType: 'test',
  schedule: '0 */4 * * *',
  async fetchEvents() { return events; },
});

const evt = (hash, title, start) => ({
  title, description: null, start_utc: start, end_utc: null,
  event_type: 'liturgy', source_url: null, source_hash: hash,
  location_override: null, hide_live: 0, parish_scoped: 0,
});

test('first run counts every event as created, none as updated', async () => {
  const { raw, env } = fresh();
  const r = await runAdapter(fakeAdapter([
    evt('h1', 'A', '2026-09-06T00:00:00.000Z'),
    evt('h2', 'B', '2026-09-07T00:00:00.000Z'),
  ]), env);

  assert.deepStrictEqual(r, { eventsFound: 2, eventsCreated: 2, eventsUpdated: 0 });
  const run = raw.prepare('SELECT * FROM adapter_runs ORDER BY id DESC LIMIT 1').get();
  assert.strictEqual(run.status, 'success');
  assert.strictEqual(run.events_created, 2);
  assert.strictEqual(run.events_updated, 0);
});

test('re-running the same scrape counts updates, not creations', async () => {
  const { raw, env } = fresh();
  const events = [evt('h1', 'A', '2026-09-06T00:00:00.000Z'), evt('h2', 'B', '2026-09-07T00:00:00.000Z')];
  await runAdapter(fakeAdapter(events), env);

  // Same hashes, one retitled upstream.
  const r = await runAdapter(fakeAdapter([
    evt('h1', 'A renamed', '2026-09-06T00:00:00.000Z'),
    evt('h2', 'B', '2026-09-07T00:00:00.000Z'),
  ]), env);

  assert.deepStrictEqual(r, { eventsFound: 2, eventsCreated: 0, eventsUpdated: 2 },
    'the Express version would have reported created=2, updated=0 here');
  assert.strictEqual(raw.prepare('SELECT COUNT(*) n FROM events').get().n, 2,
    'idempotent: source_hash prevents duplication');
  assert.strictEqual(raw.prepare("SELECT title FROM events WHERE source_hash='h1'").get().title, 'A renamed');
});

test('a mixed run splits the counters correctly', async () => {
  const { env } = fresh();
  await runAdapter(fakeAdapter([evt('h1', 'A', '2026-09-06T00:00:00.000Z')]), env);
  const r = await runAdapter(fakeAdapter([
    evt('h1', 'A', '2026-09-06T00:00:00.000Z'),   // existing
    evt('h9', 'New', '2026-09-09T00:00:00.000Z'), // new
  ]), env);
  assert.deepStrictEqual(r, { eventsFound: 2, eventsCreated: 1, eventsUpdated: 1 });
});

test('a failing fetch is recorded on the run and rethrown', async () => {
  const { raw, env } = fresh();
  const broken = { ...fakeAdapter([]), async fetchEvents() { throw new Error('GOOGLE_API_KEY not set'); } };

  await assert.rejects(() => runAdapter(broken, env), /GOOGLE_API_KEY not set/);

  const run = raw.prepare('SELECT * FROM adapter_runs ORDER BY id DESC LIMIT 1').get();
  assert.strictEqual(run.status, 'failed');
  assert.match(run.error_message, /GOOGLE_API_KEY/);
  assert.ok(run.finished_at, 'a failed run must still be closed out');
});

test('a zero-event scrape succeeds loudly rather than silently', async () => {
  const { raw, env } = fresh();
  const r = await runAdapter(fakeAdapter([]), env);
  assert.deepStrictEqual(r, { eventsFound: 0, eventsCreated: 0, eventsUpdated: 0 });
  const run = raw.prepare('SELECT * FROM adapter_runs ORDER BY id DESC LIMIT 1').get();
  assert.strictEqual(run.status, 'success');
  assert.strictEqual(run.events_found, 0,
    'this row is the only evidence a scrape has gone quiet — the reason adapter_runs was kept');
});

test('event-type guessing and visibility rules survive the port', () => {
  assert.strictEqual(guessEventType('Divine Liturgy'), 'liturgy');
  assert.strictEqual(guessEventType('Great Vespers'), 'prayer');
  assert.strictEqual(guessEventType('Θεία Λειτουργία'), 'liturgy');
  assert.strictEqual(guessEventType('Parish Paniyiri'), 'social');
  assert.strictEqual(guessEventType('Something else'), 'other');

  assert.strictEqual(shouldHideLive('Confession'), true);
  assert.strictEqual(shouldHideLive('Divine Liturgy'), false);
  assert.strictEqual(isParishScoped('Setup'), true);
  assert.strictEqual(isParishScoped('Setup for the feast'), false);
});

test('source_hash is stable and hex', async () => {
  const a = await sha256Hex('gcal-cal@example.com-evt1');
  const b = await sha256Hex('gcal-cal@example.com-evt1');
  assert.strictEqual(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('an adapter naming a parish that does not exist fails with a useful message', async () => {
  const { raw, env } = fresh();
  const orphan = { ...fakeAdapter([evt('h1', 'Liturgy', '2026-09-06T00:00:00Z')]),
    parishId: 'antiochian-nowhere-in-particular' };

  await assert.rejects(() => runAdapter(orphan, env), /not in the database/);

  // The point of the guard is what a human reads in adapter_runs weeks later,
  // so assert on the stored message, not just the throw.
  const run = raw.prepare('SELECT * FROM adapter_runs ORDER BY id DESC LIMIT 1').get();
  assert.strictEqual(run.status, 'failed');
  assert.match(run.error_message, /antiochian-nowhere-in-particular/);
  assert.match(run.error_message, /seeds\/parishes\.js/,
    'the message has to name the fix, not just the symptom');

  assert.strictEqual(raw.prepare('SELECT COUNT(*) n FROM events').get().n, 0,
    'nothing is written for a parish that does not exist');
});

test('every registered adapter targets a seeded parish, or says why not', () => {
  // The registry and the seed are edited in different files and nothing links
  // them. An adapter pointing at a parish the seed never creates cannot fail
  // until the cron fires in production, four hours after the deploy that broke
  // it. Catch it here instead.
  //
  // One adapter is knowingly in that state — see PENDING_PARISHES. The point of
  // the exception being explicit is that it is the only one: anything else that
  // drifts fails here.
  const { raw } = fresh();
  const seeded = new Set(raw.prepare('SELECT id FROM parishes').all().map(r => r.id));
  for (const a of ADAPTERS) {
    if (PENDING_PARISHES.has(a.id)) continue;
    assert.ok(seeded.has(a.parishId),
      `adapter '${a.id}' targets parish '${a.parishId}', which seeds/parishes.js does not create`);
  }
});

test('PENDING_PARISHES lists only adapters that are really still pending', () => {
  // The list is a TODO, and a stale TODO is worse than none: an entry left
  // behind after the parish is seeded silently exempts that adapter from the
  // check above forever.
  const { raw } = fresh();
  const seeded = new Set(raw.prepare('SELECT id FROM parishes').all().map(r => r.id));
  for (const [adapterId, reason] of PENDING_PARISHES) {
    const a = ADAPTERS.find(x => x.id === adapterId);
    assert.ok(a, `PENDING_PARISHES names '${adapterId}', which is not a registered adapter`);
    assert.ok(!seeded.has(a.parishId),
      `'${adapterId}' is listed as pending but its parish is seeded now — delete the entry`);
    assert.ok(reason && reason.length > 20, 'an entry has to say what is missing');
  }
});
