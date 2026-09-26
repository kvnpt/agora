// Where the pin ends up, through the real router.
//
// The panel gained two controls — "Locate pin", which previews what an address
// resolves to, and "Move pin location", which places the dot by hand — and
// both make a promise this file is here to keep: THE DOT PREVIEWED IS THE DOT
// SAVED. That promise is not a property of either control on its own. It lives
// in the contract between them and PATCH /api/admin/parishes/:id, which
// re-geocodes an address only when no coordinates came with it.
//
// Nominatim is stubbed. What is under test is the routing and that contract,
// never OpenStreetMap's opinion of a street.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { Router } from '../lib/router.mjs';
import { registerAdminRoutes } from './admin.mjs';

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

/**
 * A stubbed Nominatim.
 *
 * `calls` is the interesting half: several tests below are assertions about a
 * lookup NOT happening, which is the whole point of sending coordinates.
 */
function stubNominatim(answer) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const body = answer ? [{ lat: String(answer.lat), lon: String(answer.lng) }] : [];
    return new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

function fresh(roleRow) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-geo-')), 'x.db');
  const raw = new Database(file);
  raw.pragma('foreign_keys = ON');
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  if (roleRow) {
    raw.prepare('INSERT INTO admin_roles (email, role, parish_ids) VALUES (?,?,?)')
      .bind(roleRow.email || 'dev', roleRow.role,
            roleRow.parishIds ? JSON.stringify(roleRow.parishIds) : null).run();
  }
  const router = new Router();
  registerAdminRoutes(router);
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
  return { raw, call };
}

// ── The preview ────────────────────────────────────────────────────────

test('a lookup answers with coordinates and writes nothing', async () => {
  const { raw, call } = fresh();
  const before = raw.prepare('SELECT lat, lng FROM parishes WHERE id = ?').get(PARISH);
  const nom = stubNominatim({ lat: -34.7612, lng: 138.6702 });
  try {
    const res = await call('POST', '/api/admin/geocode', { address: '27 Saints Road, Salisbury Plain SA' });
    assert.equal(res.status, 200);
    assert.equal(res.body.lat, -34.7612);
    assert.equal(res.body.lng, 138.6702);
  } finally { nom.restore(); }
  // The button is pressed mid-edit, with the rest of the form unsaved. A
  // preview that wrote would be a half-finished save.
  const after = raw.prepare('SELECT lat, lng FROM parishes WHERE id = ?').get(PARISH);
  assert.deepEqual(after, before);
});

test('no match is a 404, not a 200 carrying null', async () => {
  const { call } = fresh();
  const nom = stubNominatim(null);
  try {
    const res = await call('POST', '/api/admin/geocode', { address: 'nowhere at all' });
    // The caller has to tell "no match" apart from a match, and a null lat
    // reaching a map is a dot in the Gulf of Guinea.
    assert.equal(res.status, 404);
  } finally { nom.restore(); }
});

test('an empty address is refused before anybody is asked', async () => {
  const { call } = fresh();
  const nom = stubNominatim({ lat: 1, lng: 2 });
  try {
    assert.equal((await call('POST', '/api/admin/geocode', { address: '   ' })).status, 400);
    assert.equal((await call('POST', '/api/admin/geocode', {})).status, 400);
    assert.equal(nom.calls.length, 0, 'an empty box should not reach Nominatim');
  } finally { nom.restore(); }
});

test('somebody with no role cannot use it to probe', async () => {
  // A table with rows in it and nothing for 'dev' — the "no access" case.
  const { call } = fresh({ email: 'someone@else.test', role: 'owner' });
  const nom = stubNominatim({ lat: 1, lng: 2 });
  try {
    assert.equal((await call('POST', '/api/admin/geocode', { address: 'x' })).status, 403);
    assert.equal(nom.calls.length, 0);
  } finally { nom.restore(); }
});

// ── The contract the preview depends on ────────────────────────────────

test('coordinates sent with an address suppress the re-geocode', async () => {
  const { raw, call } = fresh();
  const nom = stubNominatim({ lat: -34.7602933, lng: 138.6596568 });  // the road centroid
  try {
    const res = await call('PATCH', `/api/admin/parishes/${PARISH}`, {
      address: '27 Saints Road Salisbury Plain, SA 5109',
      lat: -34.76121, lng: 138.67015,                                  // the church
    });
    assert.equal(res.status, 200);
    assert.equal(nom.calls.length, 0, 'the save re-geocoded an address it was given a pin for');
  } finally { nom.restore(); }
  const row = raw.prepare('SELECT address, lat, lng FROM parishes WHERE id = ?').get(PARISH);
  // The point of the whole feature: a hand-placed pin survives its own save.
  assert.equal(row.lat, -34.76121);
  assert.equal(row.lng, 138.67015);
});

test('an address sent alone still geocodes, exactly as before', async () => {
  const { raw, call } = fresh();
  const nom = stubNominatim({ lat: -33.9, lng: 151.2 });
  try {
    await call('PATCH', `/api/admin/parishes/${PARISH}`, { address: '1 Some Street, Sydney NSW' });
    assert.equal(nom.calls.length, 1);
  } finally { nom.restore(); }
  const row = raw.prepare('SELECT lat, lng FROM parishes WHERE id = ?').get(PARISH);
  assert.equal(row.lat, -33.9);
  assert.equal(row.lng, 151.2);
});

test('a by-hand pin holds the address AND the coordinates', async () => {
  const { raw, call } = fresh();
  const nom = stubNominatim({ lat: 0, lng: 0 });
  try {
    const res = await call('PATCH', `/api/admin/parishes/${PARISH}`, {
      address: '27 Saints Road Salisbury Plain, SA 5109',
      lat: -34.76121, lng: 138.67015,
      pin: { field: 'address', tier: 'admin', note: 'Placed by hand — the geocoder returns the street.' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.pin_errors, []);
  } finally { nom.restore(); }
  const held = raw.prepare(
    "SELECT subject FROM info_overrides WHERE parish_id = ? AND target = 'field' AND decision = 'pin' ORDER BY subject"
  ).all(PARISH).map(r => r.subject);
  // FIELD_GROUPS: pinning the words and leaving the dot free is how a
  // geocoder moves a pin somebody checked.
  assert.deepEqual(held, ['address', 'lat', 'lng']);
});

test('a pin with no reason fails the ruling and keeps the save', async () => {
  const { raw, call } = fresh();
  const nom = stubNominatim({ lat: 0, lng: 0 });
  try {
    const res = await call('PATCH', `/api/admin/parishes/${PARISH}`, {
      address: '27 Saints Road Salisbury Plain, SA 5109',
      lat: -34.76121, lng: 138.67015,
      pin: { field: 'address', tier: 'admin', note: '  ' },
    });
    assert.equal(res.status, 200, 'the edit lands either way');
    assert.ok(res.body.pin_errors.length, 'and the panel is told the ruling did not');
  } finally { nom.restore(); }
  assert.equal(raw.prepare('SELECT lat FROM parishes WHERE id = ?').get(PARISH).lat, -34.76121);
  assert.equal(raw.prepare('SELECT COUNT(*) n FROM info_overrides WHERE parish_id = ?').get(PARISH).n, 0);
});

// ── The panel's wiring ─────────────────────────────────────────────────
//
// Read as TEXT, and that is a real limit worth naming rather than papering
// over: nothing here executes app.js, so these prove the handlers are wired to
// the names above and not that pressing the button works. What they do catch
// is the regression that would be silent — a second Done growing back beside
// Save, or the address row losing its pin controls in a re-render rewrite.

test('the edit form offers one way to finish, and it saves', () => {
  const app = fs.readFileSync('public/app.js', 'utf8');

  // Edit mode is inline now, so the way out is the admin row: Save, and a
  // Cancel that SAYS it throws the edits away. What must not come back is a
  // second finishing button whose only difference is silently discarding.
  const actions = app.slice(app.indexOf('<div class="ps-actions ps-admin-actions'));
  const row = actions.slice(0, actions.indexOf('</div>'));
  assert.ok(row.includes("finishParishEdit('${pid}')"), 'the row lost its Save');
  assert.ok(/'Save'/.test(row), 'the finishing button is not labelled Save');
  assert.doesNotMatch(row, /'Done'/, 'a Done beside Save is the pair that differed only by discarding');
  assert.ok(row.includes("setParishEditMode('${pid}', false)\">Cancel<"), 'leaving without saving must be labelled Cancel');

  // The header's Done is the same act, not a quieter one that drops the form.
  assert.ok(app.includes("finishParishEdit('${pid}')"), 'the header Done no longer saves');
  assert.ok(
    /window\.finishParishEdit[\s\S]{0,600}window\.saveParish\(id\)/.test(app),
    'finishParishEdit does not route through the save',
  );
  // And saving finishes, which is the other half of "they are one and the same".
  assert.ok(
    /window\.saveParish[\s\S]*?window\.setParishEditMode\(pid, false\)/.test(app),
    'a successful save no longer leaves edit mode',
  );
});

test('the address row carries both pin controls, and they reach the route', () => {
  const app = fs.readFileSync('public/app.js', 'utf8');
  assert.ok(app.includes("geolocateParishPin('${pid}')"), 'no Locate pin button');
  assert.ok(app.includes("openParishPinMover('${pid}')"), 'no Move pin location button');
  assert.ok(app.includes("'/api/admin/geocode'"), 'Locate pin does not call the route this file tests');
  // The same lookup as the save, which is why the preview can be trusted.
  assert.ok(
    /data\.lat = draft\.lat/.test(app),
    'a staged pin is not sent with the save, so the server would re-geocode over it',
  );
  const html = fs.readFileSync('public/index.html', 'utf8');
  assert.ok(html.includes('id="pin-map"'), 'index.html has no map to place the pin on');
});
