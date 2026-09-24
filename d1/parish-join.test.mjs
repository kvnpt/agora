// The browser-side join that puts a rule's parish fields back, and the SQL the
// Worker joins with, are built from one list. These pin the two halves to it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PARISH_JOIN, PARISH_JOIN_SQL, joinParish, joinParishes } from '../public/shared/parish-join.mjs';
import { project } from '../public/shared/project.mjs';
import { OffsetCache } from '../public/shared/tz.mjs';

const parish = {
  id: 'p1', name: 'St Elias', jurisdiction: 'antiochian', address: '1 Church St',
  website: 'https://stelias.example', lat: -34.4, lng: 150.9, timezone: 'Australia/Perth',
  logo_path: null, languages: '["English","Arabic"]', acronym: 'SEW', color: '#123456', live_url: null,
};
const rule = {
  id: 7, parish_id: 'p1', day_of_week: 0, start_time: '09:00', title: 'Divine Liturgy',
  event_type: 'liturgy', active: 1, languages: null, location_override: null,
};

test('every parish field lands under the name the projection reads', () => {
  const j = joinParish(rule, parish);
  for (const [col, as] of PARISH_JOIN) assert.equal(j[as], parish[col], as);
  // The rule's own columns are left exactly as they were.
  assert.equal(j.languages, null);
  assert.equal(j.location_override, null);
});

test('a rule whose parish is not in the list gets nulls, not undefined', () => {
  const [j] = joinParishes([rule], []);
  for (const [, as] of PARISH_JOIN) assert.equal(j[as], null, as);
});

test("a joined rule projects in its parish's zone, with its parish's address to fall back on", () => {
  const inst = project(joinParish(rule, parish), '2026-10-04', null, new OffsetCache());
  // 09:00 in Perth (+08:00, no DST) is 01:00 UTC.
  assert.equal(inst.start_utc, '2026-10-04T01:00:00.000Z');
  assert.equal(inst.parish_address, '1 Church St');
  assert.equal(inst.location_override, null);
});

test('the Worker builds its join from this list, not its own', () => {
  assert.match(PARISH_JOIN_SQL, /^p\.lat AS p_lat, /);
  const expand = fs.readFileSync('worker/lib/expand.mjs', 'utf8');
  assert.ok(expand.includes("from '../../public/shared/parish-join.mjs'"));
  assert.ok(!/p\.website AS parish_website/.test(expand), 'expand.mjs grew its own alias list back');
});
