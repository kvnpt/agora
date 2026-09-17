// Do the importers actually obey a ruling?
//
// This is the test the whole mechanism exists for, and it is deliberately
// written against the REAL planners rather than a mock. The failure it guards
// is not hypothetical: St Mary Magdalene, Elimbah publishes two Vespers on its
// Antiochian directory page, neither has run for years, both rules were
// deleted in /admin, and before this change a re-run of
// scripts/build-antiochian-schedules.mjs would have inserted them again.

import test from 'node:test';
import assert from 'node:assert/strict';
import { planWrite as planAntiochian, buildScheduleSql } from './antiochian-schedules.mjs';
import { planWrite as planGreek } from './greek-schedules.mjs';
import { buildUpsert, heldFields } from './parish-import.mjs';
import { indexOverrides } from '../worker/lib/info-overrides.mjs';

const ELIMBAH = 'antiochian-stmarymagdalene-elimbah';

// The four rules the directory page yields, of which two no longer run.
const scraped = () => ([
  { parish_id: ELIMBAH, day_of_week: 0, start_time: '10:30', title: 'Matins', event_type: 'prayer' },
  { parish_id: ELIMBAH, day_of_week: 0, start_time: '11:30', title: 'Liturgy', event_type: 'liturgy' },
  { parish_id: ELIMBAH, day_of_week: 6, start_time: '18:00', title: 'Vespers', event_type: 'prayer' },
  { parish_id: ELIMBAH, day_of_week: 3, start_time: '18:00', title: 'Vespers', event_type: 'prayer' },
]);

// What production actually holds today: the two that survived the deletion.
const inProduction = () => ([
  { id: 59, parish_id: ELIMBAH, day_of_week: 0, start_time: '10:30', title: 'Matins', event_type: 'prayer' },
  { id: 60, parish_id: ELIMBAH, day_of_week: 0, start_time: '11:30', title: 'Liturgy', event_type: 'liturgy' },
]);

const suppressions = () => indexOverrides([
  { parish_id: ELIMBAH, target: 'schedule', subject: '6|18:00', decision: 'suppress',
    tier: 'admin', source_label: 'Vespers', note: 'Confirmed by telephone; stopped years ago.' },
  { parish_id: ELIMBAH, target: 'schedule', subject: '3|18:00', decision: 'suppress',
    tier: 'admin', source_label: 'Vespers', note: 'Confirmed by telephone; stopped years ago.' },
]);

// ── the fault, reproduced ──────────────────────────────────────────────────

test('without a ruling, a re-run recreates the deleted Vespers', () => {
  // Not a regression test — a record of the behaviour the table changes. If
  // this ever stops being true the mechanism is solving a problem that moved.
  const { inserts, refused } = planAntiochian(scraped(), inProduction());
  assert.equal(inserts.length, 2, 'both deleted rules come back as inserts');
  assert.deepEqual(inserts.map((r) => `${r.day_of_week}|${r.start_time}`).sort(), ['3|18:00', '6|18:00']);
  assert.deepEqual(refused, []);

  // And the guard in the emitted SQL does not stop it: it asks whether the
  // rule is there NOW, and a deleted rule is not.
  const sql = buildScheduleSql({ updates: [], inserts });
  assert.match(sql, /WHERE NOT EXISTS/);
  assert.equal((sql.match(/INSERT INTO schedules/g) || []).length, 2);
});

test('with a ruling, the same run refuses them and says so', () => {
  const { inserts, updates, refused } = planAntiochian(scraped(), inProduction(), suppressions(), 'jurisdiction');
  assert.deepEqual(inserts, [], 'nothing the ruling covers may be written');
  assert.equal(refused.length, 2);
  for (const r of refused) {
    assert.match(r.ruling.note, /telephone/i);
    assert.equal(r.existing, null, 'there is no row to update — that is the point');
  }
  // The two that DO run are untouched by any of this.
  assert.deepEqual(updates.map((u) => u.id).sort(), [59, 60]);
  assert.equal(buildScheduleSql({ updates: [], inserts }), '');
});

test('a ruling also stops a deactivated rule being revived', () => {
  // The other way an admin turns a service off. buildScheduleSql's UPDATE sets
  // active=1, so a plain update would switch it back on — the schema comment
  // calls that "the one thing here worth checking", and now it is checked.
  const existing = [...inProduction(),
    { id: 61, parish_id: ELIMBAH, day_of_week: 6, start_time: '18:00', title: 'Vespers', active: 0 }];
  const withRuling = planAntiochian(scraped(), existing, suppressions(), 'jurisdiction');
  assert.equal(withRuling.updates.some((u) => u.id === 61), false, 'row 61 must not be revived');
  assert.equal(withRuling.refused.some((r) => r.existing?.id === 61), true);

  const without = planAntiochian(scraped(), existing);
  assert.equal(without.updates.some((u) => u.id === 61), true);
  assert.match(buildScheduleSql({ updates: without.updates.filter((u) => u.id === 61), inserts: [] }),
    /active=1/, 'which is exactly what the ruling now prevents');
});

test('a refused rule is not also reported as one the source forgot', () => {
  // `untouched` means "the directory did not mention this, which is not
  // evidence it stopped". A refused rule WAS mentioned, so listing it there
  // would tell the reader the opposite of what happened.
  const existing = [...inProduction(),
    { id: 61, parish_id: ELIMBAH, day_of_week: 6, start_time: '18:00', title: 'Vespers' }];
  const { untouched } = planAntiochian(scraped(), existing, suppressions(), 'jurisdiction');
  assert.equal(untouched.some((e) => e.id === 61), false);
});

test('a ruling made on a weaker source does not stop a better one', () => {
  // A suppression recorded from a third-party directory should not bind the
  // parish's own website. This is the ladder being a ladder.
  const weak = indexOverrides([{
    parish_id: ELIMBAH, target: 'schedule', subject: '6|18:00', decision: 'suppress',
    tier: 'directory', note: 'An aggregator stopped listing it.',
  }]);
  const asJurisdiction = planAntiochian(scraped(), inProduction(), weak, 'jurisdiction');
  assert.equal(asJurisdiction.refused.length, 0, 'a jurisdiction read outranks a directory ruling');
  const asDirectory = planAntiochian(scraped(), inProduction(), weak, 'directory');
  assert.equal(asDirectory.refused.length, 1, 'the same tier does not get to win by being later');
});

test('the Greek planner honours the same rulings at its own tier', () => {
  // Greek rules are read off the parish's own site, so that run speaks at
  // `parish` — a rung above the Antiochian directory run.
  const rules = [{ parish_id: 'greek-x', day_of_week: 6, start_time: '18:00', title: 'Vespers' }];
  const ruled = indexOverrides([{
    parish_id: 'greek-x', target: 'schedule', subject: '6|18:00', decision: 'suppress',
    tier: 'admin', note: 'The parish said so on the phone; the site is stale.',
  }]);
  const stopped = planGreek(rules, [], ruled, 'parish');
  assert.deepEqual(stopped.inserts, []);
  assert.equal(stopped.refused.length, 1);

  const plain = planGreek(rules, []);
  assert.equal(plain.inserts.length, 1, 'no ruling means the old behaviour exactly');
  assert.deepEqual(plain.refused, []);
});

// ── the parish-details half ────────────────────────────────────────────────

const row = (over = {}) => ({
  id: ELIMBAH, name: 'St. Mary Magdalene, Elimbah', jurisdiction: 'antiochian',
  address: 'Coronation Street, Elimbah 4516, QLD, Australia',
  lat: -27.011373, lng: 152.9438, timezone: 'Australia/Brisbane',
  website: 'http://www.australianorthodoxchristians.org', phone: '+61437539817',
  email: null, languages: '["English"]', color: '#61187c', feast_day: '22nd July',
  info_source_type: 'import', info_source_ref: 'https://www.antiochian.org.au/x/',
  info_source_name: 'Antiochian Archdiocese', info_checked_at: '2026-09-17T00:00:00Z',
  ...over,
});

const addressPin = () => indexOverrides([
  { parish_id: ELIMBAH, target: 'field', subject: 'address', decision: 'pin', tier: 'parish',
    note: 'The directory omits the street number; the parish site has it.' },
  { parish_id: ELIMBAH, target: 'field', subject: 'lat', decision: 'pin', tier: 'parish', note: 'as above' },
  { parish_id: ELIMBAH, target: 'field', subject: 'lng', decision: 'pin', tier: 'parish', note: 'as above' },
]);

test('a pinned address survives a jurisdiction re-run, and nothing else is frozen', () => {
  const sql = buildUpsert([row()], { overrides: addressPin(), tier: 'jurisdiction' });
  assert.ok(!/\baddress=excluded\.address\b/.test(sql), 'the address must not be refreshed');
  assert.ok(!/\blat=excluded\.lat\b/.test(sql));
  assert.ok(!/\blng=excluded\.lng\b/.test(sql));
  // Everything nobody has ruled on still refreshes. info_verified_at would
  // have frozen all of these too.
  for (const c of ['name', 'phone', 'website', 'feast_day', 'info_checked_at', 'timezone']) {
    assert.match(sql, new RegExp(`\\b${c}=excluded\\.${c}\\b`), `${c} should still refresh`);
  }
  assert.match(sql, /WHERE parishes\.info_verified_at IS NULL/, 'the row-level guard is untouched');
});

test('no rulings means byte-identical SQL to before', () => {
  assert.equal(buildUpsert([row()]), buildUpsert([row()], { overrides: null }));
  assert.match(buildUpsert([row()]), /\baddress=excluded\.address\b/);
});

test('an admin write gets past a pin made on the parish site', () => {
  const sql = buildUpsert([row()], { overrides: addressPin(), tier: 'admin' });
  assert.match(sql, /\baddress=excluded\.address\b/);
});

test('a row with everything pinned becomes DO NOTHING, not broken SQL', () => {
  // `DO UPDATE SET` with an empty list is a syntax error, and an import that
  // emitted one would fail on the statement AFTER it too.
  const all = indexOverrides(['name', 'address', 'lat', 'lng', 'timezone', 'website', 'phone',
    'email', 'feast_day', 'info_source_type', 'info_source_ref', 'info_source_name', 'info_checked_at']
    .map((f) => ({ parish_id: ELIMBAH, target: 'field', subject: f, decision: 'pin', tier: 'admin', note: 'n' })));
  const sql = buildUpsert([row()], { overrides: all, tier: 'jurisdiction' });
  assert.match(sql, /ON CONFLICT\(id\) DO NOTHING;/);
  assert.ok(!/DO UPDATE SET\s*\n\s*WHERE/.test(sql), 'no empty SET list');
  assert.ok(!/DO UPDATE SET\s*$/m.test(sql));
});

test('a pin on one parish does not reach another', () => {
  const sql = buildUpsert([row(), row({ id: 'greek-other', name: 'Other' })],
    { overrides: addressPin(), tier: 'jurisdiction' });
  const statements = sql.split('INSERT INTO parishes').filter(Boolean);
  assert.equal(statements.length, 2);
  assert.ok(!/address=excluded\.address/.test(statements[0]));
  assert.match(statements[1], /address=excluded\.address/);
});

test('heldFields names what the run is leaving alone', () => {
  // So the plan can print it. An import that silently wrote eleven of thirteen
  // columns is the thing this replaces.
  const held = heldFields([row()], { overrides: addressPin(), tier: 'jurisdiction' });
  assert.equal(held.length, 1);
  assert.deepEqual(held[0].held.map((h) => h.field).sort(), ['address', 'lat', 'lng']);
  assert.match(held[0].held[0].note, /street number/);
  assert.deepEqual(heldFields([row()], { overrides: addressPin(), tier: 'admin' }), []);
  assert.deepEqual(heldFields([row()]), []);
});
