// Where something is held, when it is not its parish's church (migration 023,
// worker/lib/venues.mjs): at another parish, or at a place of its own with a
// pin. The same reading on a one-off, a rule, and one date of a rule — and the
// distance pin (events.lat/lng) follows it.
//
// Through the real Router, like admin.events.test.mjs, because the venue is
// read in four routes and what matters is that they agree.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Router } from '../lib/router.mjs';
import { registerAdminRoutes } from './admin.mjs';
import { expandOne } from '../lib/expand.mjs';
import { readVenue } from '../lib/venues.mjs';
import { attachExtraParishes } from '../../public/shared/merge.mjs';

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
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-venue-')), 'x.db');
  const raw = new Database(file);
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
  // Two parishes with pins, the first with a rule to put a date's venue on.
  const [host, venue] = raw.prepare(
    `SELECT DISTINCT p.id, p.lat, p.lng FROM parishes p JOIN schedules s ON s.parish_id = p.id
     WHERE p.id != '_unassigned' AND p.lat IS NOT NULL ORDER BY p.id LIMIT 2`
  ).all();
  assert.ok(host && venue, 'the seed should have two parishes with rules and pins');
  return { raw, db, call, host, venue };
}

/** A stubbed geocoder (Nominatim), counting its calls. */
function stubGeocoder(answer) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = answer ? [{ lat: String(answer.lat), lon: String(answer.lng) }] : [];
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

const VILLAGE = { lat: -34.7512, lng: 149.7031 };
const ONE_OFF = { title: 'Youth retreat', start_utc: '2026-11-07T00:00:00.000Z', event_type: 'youth' };

// ── reading a place ──

test('a place is read whole, and a broken pin is refused', async () => {
  const { db, host, venue } = fresh();
  assert.deepEqual(await readVenue(db, { title: 'x' }), { present: false }, 'a body that says nothing about where');
  const there = await readVenue(db, { location_parish_id: venue.id, location_override: 'ignored' }, { hostParishId: host.id });
  assert.deepEqual(there.venue, { location_parish_id: venue.id, location_override: null, location_lat: null, location_lng: null },
    'a parish venue keeps no words or pin of its own');
  assert.deepEqual(there.pin, { lat: venue.lat, lng: venue.lng });
  const self = await readVenue(db, { location_parish_id: host.id }, { hostParishId: host.id });
  assert.equal(self.venue.location_parish_id, null, 'naming the host itself is at home');
  assert.ok((await readVenue(db, { location_parish_id: 'nowhere' })).error);
  assert.ok((await readVenue(db, { location_override: 'x', location_lat: -34 })).error, 'half a pin');
  assert.ok((await readVenue(db, { location_override: 'x', location_lat: 120, location_lng: 10 })).error, 'off the map');
  assert.ok((await readVenue(db, { location_override: 'x', location_lat: 'north', location_lng: 10 })).error, 'not a number');
  const home = await readVenue(db, { location_override: '  ', location_lat: '', location_lng: null });
  assert.deepEqual(home.venue, { location_parish_id: null, location_override: null, location_lat: null, location_lng: null },
    'empty everything is at home');
});

// ── one-offs ──

test('a one-off at another parish is measured from that parish', async () => {
  const { raw, call, host, venue } = fresh();
  const r = await call('POST', '/api/admin/events', { ...ONE_OFF, parish_id: host.id, location_parish_id: venue.id });
  assert.equal(r.status, 201, r.body && r.body.error);
  const row = raw.prepare('SELECT * FROM events WHERE id = ?').get(r.body.id);
  assert.equal(row.location_parish_id, venue.id);
  assert.equal(row.location_lat, null, 'a parish venue has no square of its own');
  assert.deepEqual([row.lat, row.lng], [venue.lat, venue.lng]);
});

test('a one-off at a place of its own keeps the pin it was given, and is measured from it', async () => {
  const { raw, call, host } = fresh();
  const geo = stubGeocoder({ lat: 1, lng: 2 });
  try {
    const r = await call('POST', '/api/admin/events', { ...ONE_OFF, parish_id: host.id,
      location_override: 'Antiochian Village, Kangaroo Valley', location_lat: VILLAGE.lat, location_lng: VILLAGE.lng });
    assert.equal(r.status, 201, r.body && r.body.error);
    const row = raw.prepare('SELECT * FROM events WHERE id = ?').get(r.body.id);
    assert.deepEqual([row.location_lat, row.location_lng], [VILLAGE.lat, VILLAGE.lng]);
    assert.deepEqual([row.lat, row.lng], [VILLAGE.lat, VILLAGE.lng]);
    assert.equal(geo.calls.length, 0, 'a place sent with its pin was looked up again');
  } finally { geo.restore(); }
});

test('a place in words alone is looked up, and the pin it finds is the place\'s', async () => {
  const { raw, call, host } = fresh();
  const geo = stubGeocoder(VILLAGE);
  try {
    const r = await call('POST', '/api/admin/events', { ...ONE_OFF, parish_id: host.id,
      location_override: 'Antiochian Village, Kangaroo Valley' });
    assert.equal(r.status, 201, r.body && r.body.error);
    const row = raw.prepare('SELECT * FROM events WHERE id = ?').get(r.body.id);
    assert.equal(geo.calls.length, 1);
    assert.deepEqual([row.location_lat, row.location_lng], [VILLAGE.lat, VILLAGE.lng]);
  } finally { geo.restore(); }
});

test('an unknown venue is refused before anything is written', async () => {
  const { raw, call, host } = fresh();
  const before = raw.prepare('SELECT count(*) AS n FROM events').get().n;
  const r = await call('POST', '/api/admin/events', { ...ONE_OFF, parish_id: host.id, location_parish_id: 'nowhere' });
  assert.equal(r.status, 400);
  assert.equal(raw.prepare('SELECT count(*) AS n FROM events').get().n, before);
});

test('moving a one-off elsewhere and back moves its pin with it', async () => {
  const { raw, call, host, venue } = fresh();
  const r = await call('POST', '/api/admin/events', { ...ONE_OFF, parish_id: host.id });
  const id = r.body.id;
  const pin = () => raw.prepare('SELECT lat, lng, location_parish_id, location_override, location_lat FROM events WHERE id = ?').get(id);

  assert.equal((await call('PATCH', `/api/admin/events/${id}`, { location_parish_id: venue.id })).status, 200);
  assert.deepEqual(pin(), { lat: venue.lat, lng: venue.lng, location_parish_id: venue.id, location_override: null, location_lat: null });

  const geo = stubGeocoder(null);
  try {
    assert.equal((await call('PATCH', `/api/admin/events/${id}`, {
      location_parish_id: null, location_override: 'The village', location_lat: VILLAGE.lat, location_lng: VILLAGE.lng,
    })).status, 200);
  } finally { geo.restore(); }
  assert.deepEqual(pin(), { lat: VILLAGE.lat, lng: VILLAGE.lng, location_parish_id: null, location_override: 'The village', location_lat: VILLAGE.lat });

  // An unrelated edit leaves the place alone.
  assert.equal((await call('PATCH', `/api/admin/events/${id}`, { title: 'Youth retreat (2 days)' })).status, 200);
  assert.equal(pin().location_lat, VILLAGE.lat);

  assert.equal((await call('PATCH', `/api/admin/events/${id}`, {
    location_parish_id: null, location_override: null, location_lat: null, location_lng: null,
  })).status, 200);
  assert.deepEqual(pin(), { lat: host.lat, lng: host.lng, location_parish_id: null, location_override: null, location_lat: null });
});

// ── rules, and one date of a rule ──

test('a rule held at another parish projects there; one date can be moved on its own', async () => {
  const { raw, db, call, host, venue } = fresh();
  const r = await call('POST', '/api/admin/schedules', {
    parish_id: host.id, day_of_week: 5, start_time: '19:00', title: 'Youth group', event_type: 'youth',
    location_parish_id: venue.id,
  });
  assert.equal(r.status, 201, r.body && r.body.error);
  assert.equal(r.body.location_parish_id, venue.id);

  // 2026-11-06 is a Friday.
  const id = `${r.body.id}:2026-11-06`;
  const ev = await expandOne(db, r.body.id, '2026-11-06');
  assert.equal(ev.location_parish_id, venue.id, 'the occurrence does not carry its rule\'s venue');

  // This one Friday at a place of its own: an override, the place as a unit.
  const p = await call('PATCH', `/api/admin/events/${encodeURIComponent(id)}`, {
    location_override: 'Bankstown Sports Club', location_lat: -33.92, location_lng: 151.03,
  });
  assert.equal(p.status, 200, p.body && p.body.error);
  const ov = raw.prepare('SELECT * FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?')
    .get(r.body.id, '2026-11-06');
  assert.equal(ov.patch_location_override, 'Bankstown Sports Club');
  assert.equal(ov.patch_location_parish_id, null, 'the rule\'s venue leaked into a place of its own');
  assert.deepEqual([ov.patch_location_lat, ov.patch_location_lng], [-33.92, 151.03]);
  const moved = await expandOne(db, r.body.id, '2026-11-06');
  assert.equal(moved.location_parish_id, null);
  assert.equal(moved.location_lat, -33.92);
  // The Friday after is still at the venue.
  assert.equal((await expandOne(db, r.body.id, '2026-11-13')).location_parish_id, venue.id);

  // Back to where the rule says: nothing is different, so nothing is stored.
  const back = await call('PATCH', `/api/admin/events/${encodeURIComponent(id)}`, {
    location_parish_id: venue.id, location_override: null, location_lat: null, location_lng: null,
  });
  assert.equal(back.status, 200, back.body && back.body.error);
  const left = raw.prepare('SELECT * FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?')
    .get(r.body.id, '2026-11-06');
  assert.ok(!left || LOCATION_PATCHES.every(k => left[k] == null),
    'an override still holds a place that is the rule\'s own');
  assert.equal((await expandOne(db, r.body.id, '2026-11-06')).location_parish_id, venue.id);

  // And this one Friday at home, under a rule held elsewhere: said in so many
  // words, because nothing named would read as "where the rule says".
  const home = await call('PATCH', `/api/admin/events/${encodeURIComponent(id)}`, {
    location_parish_id: null, location_override: null, location_lat: null, location_lng: null,
  });
  assert.equal(home.status, 200, home.body && home.body.error);
  const atHome = await expandOne(db, r.body.id, '2026-11-06');
  assert.deepEqual([atHome.location_parish_id, atHome.location_override, atHome.location_lat], [null, null, null],
    'the date stayed at the rule\'s venue');
  assert.equal((await expandOne(db, r.body.id, '2026-11-13')).location_parish_id, venue.id);
});

const LOCATION_PATCHES = ['patch_location_override', 'patch_location_parish_id', 'patch_location_lat', 'patch_location_lng'];

test('a rule edit writes the place whole', async () => {
  const { call, host, venue } = fresh();
  const r = await call('POST', '/api/admin/schedules', {
    parish_id: host.id, day_of_week: 2, start_time: '18:30', title: 'Bible study', event_type: 'study',
    location_override: 'The hall, 1 Smith St', location_lat: -33.9, location_lng: 151.2,
  });
  assert.equal(r.status, 201, r.body && r.body.error);
  assert.equal(r.body.location_lat, -33.9);
  const p = await call('PATCH', `/api/admin/schedules/${r.body.id}`, { location_parish_id: venue.id });
  assert.equal(p.status, 200, p.body && p.body.error);
  assert.equal(p.body.location_parish_id, venue.id);
  assert.equal(p.body.location_override, null, 'the old words stayed beside a parish venue');
  assert.equal(p.body.location_lat, null, 'the old pin stayed beside a parish venue');
  assert.equal((await call('PATCH', `/api/admin/schedules/${r.body.id}`, { location_parish_id: 'nowhere' })).status, 400);
});

// ── the feed ──

test('an event at another parish is on at that parish too, but is not a combine', () => {
  const [plain, held, combined] = attachExtraParishes([
    { id: 1, parish_id: 'h' },
    { id: 2, parish_id: 'h', location_parish_id: 'v' },
    { id: 3, parish_id: 'h', location_parish_id: 'v' },
  ], [{ event_id: 3, parish_id: 'v' }, { event_id: 3, parish_id: 'w' }]);
  assert.deepEqual(plain.extra_parishes, []);
  assert.deepEqual(held.extra_parishes, ['v'], 'the venue parish does not list it');
  assert.deepEqual(held.combined_parishes, [], 'a venue reads as a combine');
  assert.deepEqual(combined.extra_parishes, ['v', 'w'], 'a venue that is also combined is listed twice');
  assert.deepEqual(combined.combined_parishes, ['v', 'w']);
});
