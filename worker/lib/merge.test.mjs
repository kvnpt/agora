// The client-side pipeline: given a bundle, the browser must produce the same
// feed the server used to. Covers the dedup rules that decide which of two
// competing rows becomes the single visible card.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { expandFrom, expandWindow, fetchWindowRows } from './expand.mjs';
import { buildFeed, dedupe, partitionKey, preferenceCmp, sortFeed } from '../../public/shared/merge.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new S(this.db, sql, []); }
}
class S {
  constructor(db, sql, a) { this.db = db; this.sql = sql; this.args = a; }
  bind(...a) { return new S(this.db, this.sql, a); }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async first() { const r = this.db.prepare(this.sql).get(...this.args); return r === undefined ? null : r; }
  async run() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: r.changes, last_row_id: Number(r.lastInsertRowid) } }; }
}

function fresh() {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-m-')), 'x.db');
  const raw = new Database(p);
  raw.pragma('foreign_keys = ON');
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  return { raw, db: new D1(raw) };
}

const FROM = '2026-09-01T00:00:00.000Z';
const TO = '2026-11-01T00:00:00.000Z';

test('client expansion over a bundle equals server-side expansion', async () => {
  const { db } = fresh();

  // What the Worker ships.
  const bundle = await fetchWindowRows(db, FROM, TO);
  // What the browser does with it.
  const clientSide = expandFrom(bundle, FROM, TO);
  // What the Worker would have computed itself.
  const serverSide = await expandWindow(db, FROM, TO);

  assert.ok(clientSide.length > 50);
  assert.deepStrictEqual(clientSide, serverSide);
});

test('a stored one-off supersedes its schedule twin at the same slot', async () => {
  const { raw, db } = fresh();
  const instances = await expandWindow(db, FROM, TO);
  const twin = instances[0];

  // A scraped event at exactly the same parish, instant and title.
  raw.prepare(
    `INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type,
      source_hash, lat, lng, updated_at)
     VALUES (?, 'gcal', ?, ?, 'liturgy', 'h-twin', ?, ?, '2026-09-01T00:00:00Z')`
  ).run(twin.parish_id, twin.title, twin.start_utc, twin.lat, twin.lng);
  const oneOffs = raw.prepare("SELECT e.*, p.jurisdiction FROM events e JOIN parishes p ON e.parish_id=p.id WHERE e.source_adapter != 'schedule'").all();

  const feed = buildFeed({ instances, oneOffs, crossRows: [] });
  const atSlot = feed.filter(e =>
    e.parish_id === twin.parish_id && e.start_utc === twin.start_utc && e.title === twin.title);

  assert.strictEqual(atSlot.length, 1, 'the twin should collapse to one card');
  assert.strictEqual(atSlot[0].source_adapter, 'gcal',
    'the stored one-off must win over the schedule instance');
});

test('concurrent rules never collapse into each other', () => {
  const a = { id: 'a', parish_id: 'p', start_utc: '2026-09-06T00:00:00.000Z', title: 'Liturgy', concurrent: 1 };
  const b = { id: 'b', parish_id: 'p', start_utc: '2026-09-06T00:00:00.000Z', title: 'Liturgy', concurrent: 1 };
  assert.notStrictEqual(partitionKey(a), partitionKey(b));
  assert.strictEqual(dedupe([a, b]).length, 2);

  const c = { ...a, id: 'c', concurrent: 0 };
  const d = { ...b, id: 'd', concurrent: 0 };
  assert.strictEqual(partitionKey(c), partitionKey(d));
  assert.strictEqual(dedupe([c, d]).length, 1);
});

test('a week_of_month rule beats a generic weekly one', () => {
  const generic = { id: 'g', parish_id: 'p', start_utc: '2026-09-06T00:00:00.000Z', title: 'X', source_adapter: 'schedule', week_of_month: null };
  const specific = { ...generic, id: 's', week_of_month: 'first' };
  assert.ok(preferenceCmp(specific, generic) < 0);
  assert.strictEqual(dedupe([generic, specific])[0].id, 's');
});

test('tombstones survive the default filter; hidden does not', () => {
  const base = { parish_id: 'p', start_utc: '2026-09-06T00:00:00.000Z', concurrent: 1 };
  const events = [
    { ...base, id: 1, title: 'a', status: 'approved' },
    { ...base, id: 2, title: 'b', status: 'cancelled' },
    { ...base, id: 3, title: 'c', status: 'combined' },
    { ...base, id: 4, title: 'd', status: 'hidden' },
    { ...base, id: 5, title: 'e', status: 'replaced' },
  ];
  const shown = buildFeed({ instances: events, oneOffs: [], crossRows: [] }).map(e => e.id).sort();
  assert.deepStrictEqual(shown, [1, 2, 3], 'approved + cancelled + combined only');
});

test('cross-parish links attach to stored events only', () => {
  const events = [
    { id: 7, parish_id: 'p1', start_utc: '2026-09-06T00:00:00.000Z', title: 'x', status: 'approved', concurrent: 1 },
    { id: '3:2026-09-06', parish_id: 'p2', start_utc: '2026-09-06T00:00:00.000Z', title: 'y', status: 'approved', concurrent: 1 },
  ];
  const feed = buildFeed({ instances: events, oneOffs: [], crossRows: [{ event_id: 7, parish_id: 'p9' }] });
  assert.deepStrictEqual(feed.find(e => e.id === 7).extra_parishes, ['p9']);
  assert.deepStrictEqual(feed.find(e => e.id === '3:2026-09-06').extra_parishes, []);
});

test('sortFeed: chronological without a location, proximity-blended with one', () => {
  const now = Date.parse('2026-09-06T00:00:00.000Z');
  const near = { id: 'near', lat: -33.87, lng: 151.21, start_utc: '2026-09-08T00:00:00.000Z' };
  const far = { id: 'far', lat: -34.43, lng: 150.89, start_utc: '2026-09-07T00:00:00.000Z' };

  assert.deepStrictEqual(sortFeed([near, far]).map(e => e.id), ['far', 'near'],
    'no location -> purely chronological');

  const byProx = sortFeed([near, far], { lat: -33.87, lng: 151.21, now });
  assert.strictEqual(byProx[0].id, 'near', 'a much closer event outranks a slightly sooner one');
  assert.strictEqual(byProx[0].distance_km, 0);

  const bounded = sortFeed([near, far], { lat: -33.87, lng: 151.21, radiusKm: 10, now });
  assert.deepStrictEqual(bounded.map(e => e.id), ['near'], 'radius filters the far one out');
});
