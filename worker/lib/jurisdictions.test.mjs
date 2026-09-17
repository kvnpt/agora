// The jurisdiction registry, and the staleness it exists to measure.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JURISDICTION_SOURCES, getJurisdiction, isRerunnable, automationNote,
  daysSince, staleness, STALE_DAYS } from './jurisdictions.mjs';
import { JURISDICTIONS } from './juris-colors.mjs';

test('every jurisdiction the schema allows has an entry', async () => {
  // A jurisdiction with parishes and no entry here is one the tab silently
  // cannot describe, which is worse than an empty row.
  //
  // JURISDICTIONS in juris-colors.mjs is the schema's CHECK as a set, and
  // d1/juris-colors.test.mjs already parses the schema and pins it there. Two
  // places parsing the same CHECK is two places to get it wrong, so this reads
  // the set the repo already keeps honest.
  for (const j of JURISDICTIONS) {
    // 'other' is in the CHECK and is not a jurisdiction with a directory — it
    // is the bucket for one that has no flag of its own.
    if (j === 'other') continue;
    assert.ok(getJurisdiction(j), `no registry entry for ${j}`);
  }
});

test('every named script actually exists', async () => {
  // A registry naming a script that was renamed or never written would put a
  // re-scrape button on a card that cannot run.
  for (const j of JURISDICTION_SOURCES) {
    for (const s of [...j.parishScripts, ...j.scheduleScripts]) {
      assert.ok(fs.existsSync(`scripts/${s}`), `${j.slug} names scripts/${s}, which is missing`);
    }
  }
});

test('a jurisdiction with no scripts is not offered as re-runnable', async () => {
  for (const j of JURISDICTION_SOURCES) {
    if (!j.parishScripts.length) {
      assert.equal(isRerunnable(j), false, `${j.slug} has no scripts but is offered`);
    }
  }
  assert.equal(isRerunnable(null), false);
});

test('the three automation states are told apart, not collapsed', async () => {
  // Antiochian 403s every automated client and Greek needs a browser for half
  // its sites. A boolean would promise a button that cannot work.
  const anti = getJurisdiction('antiochian');
  assert.equal(anti.automation, 'person');
  assert.match(automationNote(anti), /403/);

  const greek = getJurisdiction('greek');
  assert.equal(greek.automation, 'browser');
  assert.match(automationNote(greek), /real browser/);

  const serbian = getJurisdiction('serbian');
  assert.equal(serbian.automation, 'full');
  assert.match(automationNote(serbian), /cleanly/);

  assert.match(automationNote(getJurisdiction('macedonian')), /imported by hand/);
});

test('the one jurisdiction publishing its own service times is marked as such', async () => {
  // It is the case the owner most wants to re-read: 62 of 67 Antiochian rules
  // cite the Archdiocese itself, so one page changing moves a whole
  // jurisdiction's timetable.
  assert.equal(getJurisdiction('antiochian').scheduleSource, 'Antiochian Archdiocese');
  // Greek and Romanian rules cite the PARISH, deliberately — the Archdiocese
  // publishes none of them and should not be credited under a timetable.
  assert.equal(getJurisdiction('greek').scheduleSource, 'Parish website');
  assert.equal(getJurisdiction('romanian').scheduleSource, 'Parish website');
  // Serbian's six rules were typed by hand and cite nothing.
  assert.equal(getJurisdiction('serbian').scheduleSource, undefined);
});

test('days are counted from an ISO date, with or without its Z', async () => {
  const now = Date.parse('2026-12-17T00:00:00Z');
  assert.equal(daysSince('2026-12-17T00:00:00Z', now), 0);
  assert.equal(daysSince('2026-12-10T00:00:00Z', now), 7);
  // D1 writes this shape via strftime; older rows come back without the Z and
  // would otherwise be read as local time.
  assert.equal(daysSince('2026-12-10T00:00:00', now), 7);
  // A fractional-seconds ISO string, which is what new Date().toISOString() gives.
  assert.equal(daysSince('2026-09-15T15:02:20.591Z', now), 92);
  assert.equal(daysSince(null, now), null);
  assert.equal(daysSince('not a date', now), null);
});

test('a future date reads as today rather than as negative', async () => {
  const now = Date.parse('2026-09-17T00:00:00Z');
  assert.equal(daysSince('2026-10-01T00:00:00Z', now), 0);
});

test('staleness has a never, and never is not the same as old', async () => {
  // Serbian's rules have no source_checked_at at all. "Nobody has ever looked"
  // and "somebody looked a year ago" want different answers.
  assert.equal(staleness(null), 'never');
  assert.equal(staleness(0), 'fresh');
  assert.equal(staleness(STALE_DAYS - 1), 'fresh');
  assert.equal(staleness(STALE_DAYS), 'stale');
  assert.equal(staleness(STALE_DAYS * 2), 'overdue');
});

test('the registry does not claim a directory it cannot name', async () => {
  // Romanian and Macedonian were imported without a reusable script; inventing
  // a directory URL for them would put a link on the card to a page nobody
  // checked.
  for (const j of JURISDICTION_SOURCES) {
    if (j.automation === 'none') assert.equal(j.directory, undefined, `${j.slug}`);
    else assert.match(j.directory, /^https:\/\//, `${j.slug} needs a directory`);
  }
});

test('every entry carries notes worth reading', async () => {
  for (const j of JURISDICTION_SOURCES) {
    assert.ok(j.label && j.notes, `${j.slug} is missing a label or notes`);
    assert.ok(j.notes.length > 80, `${j.slug}'s notes are too thin to be worth showing`);
  }
});
