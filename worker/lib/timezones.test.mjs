// The parish timezone table, and the guard that keeps a typo out of the column.
//
// `parishes.timezone` is what makes `schedules.start_time` an instant. A wrong
// one is invisible in the row and wrong in every card the parish projects.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { PARISH_TIMEZONES, DEFAULT_TIMEZONE, timezoneLabel, isResolvableTimezone } =
  require('../../public/shared/timezones.js');

test('every offered zone is one the runtime actually knows', async () => {
  // A zone that does not resolve would put the panel's own menu at odds with
  // its own guard — pick it and the save is refused.
  for (const z of PARISH_TIMEZONES) {
    assert.equal(isResolvableTimezone(z.tz), true, `${z.tz} does not resolve`);
  }
});

test('the offered zones cover every region the site declares', async () => {
  // locations.js is what the app says it serves. A parish in one of those with
  // no zone on the menu would have to be given a wrong one.
  const zones = new Set(PARISH_TIMEZONES.map(z => z.tz));
  for (const need of ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane',
    'Australia/Perth', 'Australia/Adelaide', 'Australia/Hobart', 'Australia/Darwin',
    'Pacific/Auckland', 'Pacific/Fiji', 'Asia/Manila']) {
    assert.ok(zones.has(need), `no option for ${need}`);
  }
});

test('the zones production actually uses are all on the menu', async () => {
  // Read from the seed rather than hardcoded: a parish imported with a zone the
  // panel cannot offer is a parish nobody can correct through the panel.
  const seed = fs.readFileSync('seeds/parishes.js', 'utf8');
  const used = new Set([...seed.matchAll(/timezone:\s*'([^']+)'/g)].map(m => m[1]));
  const zones = new Set(PARISH_TIMEZONES.map(z => z.tz));
  for (const tz of used) assert.ok(zones.has(tz), `seed uses ${tz}, which the panel cannot offer`);
});

test('no duplicates, and the default is one of them', async () => {
  const zones = PARISH_TIMEZONES.map(z => z.tz);
  assert.equal(new Set(zones).length ?? new Set(zones).size, zones.length, 'a zone is listed twice');
  assert.ok(zones.includes(DEFAULT_TIMEZONE));
});

test('a label is the city, so a time field can name it', async () => {
  assert.equal(timezoneLabel('Australia/Perth'), 'Perth');
  assert.equal(timezoneLabel('Pacific/Auckland'), 'Auckland');
  // Unlisted but valid still labels sensibly rather than rendering the whole
  // identifier into "Start (America/New_York)".
  assert.equal(timezoneLabel('America/New_York'), 'New York');
  assert.equal(timezoneLabel(null), '');
  assert.equal(timezoneLabel(''), '');
});

test('the guard refuses what a typo looks like', async () => {
  for (const bad of ['Australia/Sydny', 'Sydney', 'AEST', '+10:00', 'UTC+10', '', '   ', null, 42, {}]) {
    assert.equal(isResolvableTimezone(bad), false, `${JSON.stringify(bad)} should be refused`);
  }
});

test('the guard accepts an unlisted but real zone', async () => {
  // The reason it is not an allowlist: the next parish may genuinely need one
  // of these, and a closed list would make that a code change.
  assert.equal(isResolvableTimezone('Australia/Broken_Hill'), true);
  assert.equal(isResolvableTimezone('Australia/Lord_Howe'), true);
  assert.equal(isResolvableTimezone('Pacific/Port_Moresby'), true);
});

test('a bare offset is refused even where the runtime resolves it', async () => {
  // An offset cannot express daylight saving, which is the whole reason this
  // column holds a zone. Some runtimes accept '+10:00' happily.
  assert.equal(isResolvableTimezone('+10:00'), false);
  assert.equal(isResolvableTimezone('Etc/GMT-10'), true);   // a real IANA name, allowed
});

test('the zones really do differ, which is the point of the column', async () => {
  // Brisbane and Sydney agree for half the year and differ for the other half.
  // A parish given the wrong one of these is an hour out every summer, which is
  // the failure the missing form field was quietly producing.
  const jan = Date.UTC(2026, 0, 15, 0, 0);     // southern summer: DST active in NSW
  const at = (tz) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(jan);
  assert.notEqual(at('Australia/Sydney'), at('Australia/Brisbane'));
  assert.notEqual(at('Australia/Sydney'), at('Australia/Perth'));
});
