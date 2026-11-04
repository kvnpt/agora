// Week exceptions — a rule held differently, or not at all, on some weeks of
// the month (migration 035): "every last Sunday in English, until 11:30", "not
// on the last Sunday". One row on the rule, projected with it, never a row per
// date; a date's own override still has the last word on that date.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  expandFrom, isValidOccurrence, exceptionsOf, exceptionOn, withException, attachExceptions,
  nextOccurrenceAfterBreak,
} from '../../public/shared/project.mjs';
import { ruleTargets } from './poster-range.mjs';
import { dedupe } from '../../public/shared/merge.mjs';

const require = createRequire(import.meta.url);
const T = require('../../public/shared/timetable.js');
const TL = require('../../public/shared/timetable-lines.js');

const FROM = '2026-12-01T00:00:00.000Z';
const TO = '2027-02-01T00:00:00.000Z';

// Mount Pritchard's, as it will be written: one weekly bilingual rule.
const RULE = {
  id: 34, parish_id: 'smmp', day_of_week: 0, start_time: '09:00', end_time: '12:00',
  title: 'Matins & Divine Liturgy', event_type: 'liturgy', languages: '["Arabic","English"]',
  week_of_month: null, week_parity: null, p_timezone: 'Australia/Sydney',
  created_at: '2026-01-01T00:00:00Z',
};
const ENGLISH_LAST = {
  id: 1, schedule_id: 34, weeks: 'last', kind: 'modified',
  patch_languages: '["English"]', patch_end_time: '11:30', updated_at: '2026-11-04T00:00:00Z',
};
const NOT_LAST = { id: 2, schedule_id: 34, weeks: 'last', kind: 'not_held', updated_at: '2026-11-04T00:00:00Z' };

const dateOf = (i) => i.id.split(':')[1];
const byDate = (out) => Object.fromEntries(out.map(i => [dateOf(i), i]));

// ── Held differently ─────────────────────────────────────────────────────

test('the last Sunday of each month is held as the exception says, and the rest as the rule', () => {
  const out = byDate(expandFrom({ schedules: [RULE], week_exceptions: [ENGLISH_LAST] }, FROM, TO));
  for (const d of ['2026-12-27', '2027-01-31']) {
    assert.equal(out[d].languages, '["English"]', d);
    assert.equal(out[d].end_local, `${d}T11:30`);
    assert.equal(out[d].start_local, `${d}T09:00`, 'what the exception does not name is the rule’s');
    assert.equal(out[d].title, RULE.title);
    assert.equal(out[d].week_exception_id, 1);
    assert.equal(out[d].id, `34:${d}`, 'the same occurrence, not a new one');
  }
  for (const d of ['2026-12-06', '2026-12-20', '2027-01-24']) {
    assert.equal(out[d].languages, RULE.languages, d);
    assert.equal(out[d].end_local, `${d}T12:00`);
    assert.equal(out[d].week_exception_id, undefined);
  }
  assert.equal(Object.keys(out).length, 9, 'every Sunday is still there');
});

test("a 4th Sunday that is also the last is the last Sunday's", () => {
  // December 2026 has four Sundays: the 27th is the 4th and the last.
  const out = byDate(expandFrom({ schedules: [RULE], week_exceptions: [ENGLISH_LAST] }, FROM, TO));
  assert.equal(out['2026-12-27'].languages, '["English"]');
  // January has five: the 24th is the 4th, and only the 31st is the last.
  assert.equal(out['2027-01-24'].languages, RULE.languages);
});

test("a date's own override wins over the week's, and keeps what it does not change", () => {
  const o = { schedule_id: 34, occurrence_date: '2026-12-27', kind: 'modified', patch_start_time: '10:00', updated_at: 'x' };
  const out = byDate(expandFrom({ schedules: [RULE], overrides: [o], week_exceptions: [ENGLISH_LAST] }, FROM, TO));
  const i = out['2026-12-27'];
  assert.equal(i.start_local, '2026-12-27T10:00', 'the date says 10');
  assert.equal(i.languages, '["English"]', 'and is still the English last Sunday');
  assert.equal(i.end_local, '2026-12-27T11:30');
  const lang = { ...o, patch_start_time: null, patch_languages: '["Arabic"]' };
  assert.equal(byDate(expandFrom({ schedules: [RULE], overrides: [lang], week_exceptions: [ENGLISH_LAST] }, FROM, TO))['2026-12-27'].languages,
    '["Arabic"]', 'a date that names its languages has them');
});

test('a cancelled exception week is a tombstone, like any other date', () => {
  const o = { schedule_id: 34, occurrence_date: '2026-12-27', kind: 'cancelled', updated_at: 'x' };
  const i = byDate(expandFrom({ schedules: [RULE], overrides: [o], week_exceptions: [ENGLISH_LAST] }, FROM, TO))['2026-12-27'];
  assert.equal(i.status, 'cancelled');
  assert.equal(i.is_tombstone, 1);
});

test('a break covers an exception week as it covers the rest', () => {
  const b = { id: 1, parish_id: 'smmp', schedule_id: 34, from_date: '2026-12-20', to_date: '2027-01-06', note: 'Christmas' };
  const out = byDate(expandFrom({ schedules: [RULE], breaks: [b], week_exceptions: [ENGLISH_LAST] }, FROM, TO));
  assert.equal(out['2026-12-27'].status, 'break');
  assert.equal(out['2027-01-31'].status, 'approved');
});

// ── Not held ─────────────────────────────────────────────────────────────

test('a week it is not held on is no date of it: every Sunday but the last', () => {
  const out = byDate(expandFrom({ schedules: [RULE], week_exceptions: [NOT_LAST] }, FROM, TO));
  assert.ok(!out['2026-12-27'] && !out['2027-01-31'], 'no last Sunday');
  assert.ok(out['2027-01-24'], 'the 4th of a five-Sunday month is held');
  assert.equal(Object.keys(out).length, 7);
  const mine = exceptionsOf(RULE, [NOT_LAST]);
  assert.equal(isValidOccurrence(RULE, '2026-12-27', mine), false);
  assert.equal(isValidOccurrence(RULE, '2026-12-27'), true, 'the rule alone still says so');
  assert.equal(isValidOccurrence(RULE, '2026-12-27', mine, { overridden: true }), true);
});

test('an override on a week not held brings that one date back', () => {
  const o = { schedule_id: 34, occurrence_date: '2026-12-27', kind: 'modified', patch_title: 'Nativity Liturgy', updated_at: 'x' };
  const out = byDate(expandFrom({ schedules: [RULE], overrides: [o], week_exceptions: [NOT_LAST] }, FROM, TO));
  assert.equal(out['2026-12-27'].title, 'Nativity Liturgy');
  assert.ok(!out['2027-01-31']);
});

test('the service after a break is not on a week it is not held', () => {
  const b = { id: 1, parish_id: 'smmp', schedule_id: 34, from_date: '2027-01-11', to_date: '2027-01-25' };
  const rule = { ...RULE, exceptions: exceptionsOf(RULE, [NOT_LAST]) };
  assert.equal(nextOccurrenceAfterBreak(rule, '2027-01-11', [b]), '2027-02-07', 'not the 31st');
  assert.equal(nextOccurrenceAfterBreak(RULE, '2027-01-11', [b]), '2027-01-31');
});

test('a bulletin over a month does not land on (and so bring back) a week not held', () => {
  const targets = ruleTargets({ schedules: [RULE], overrides: [], breaks: [], week_exceptions: [NOT_LAST] }, '2026-12-01', '2026-12-31');
  assert.deepEqual(targets.map(t => t.date), ['2026-12-06', '2026-12-13', '2026-12-20']);
  const o = { schedule_id: 34, occurrence_date: '2026-12-27', kind: 'modified', patch_title: 'Nativity' };
  const back = ruleTargets({ schedules: [RULE], overrides: [o], breaks: [], week_exceptions: [NOT_LAST] }, '2026-12-01', '2026-12-31');
  assert.ok(back.some(t => t.date === '2026-12-27'), 'a date brought back by its override is a service like any other');
});

// ── Which exception, and how it reads ────────────────────────────────────

test('where two exceptions meet on a date, the one naming fewer weeks speaks', () => {
  const firstThird = { id: 3, schedule_id: 34, weeks: 'first,third', kind: 'modified', patch_title: 'A', updated_at: '2026-11-05T00:00:00Z' };
  const last = { id: 4, schedule_id: 34, weeks: 'last', kind: 'modified', patch_title: 'B', updated_at: '2026-11-01T00:00:00Z' };
  const other = { id: 5, schedule_id: 99, weeks: 'last', kind: 'not_held' };
  const mine = exceptionsOf(RULE, [firstThird, last, other]);
  assert.deepEqual(mine.map(x => x.id), [4, 3], 'its own only, fewer weeks first');
  assert.equal(exceptionOn(mine, '2026-12-06').id, 3);
  assert.equal(exceptionOn(mine, '2026-12-13'), null);
});

test('an exception at its own parish is the service back at home, under a rule held elsewhere', () => {
  const away = { ...RULE, location_parish_id: 'sgr', location_override: null };
  const home = withException(away, { kind: 'modified', patch_location_parish_id: 'smmp' });
  assert.equal(home.location_parish_id, null);
  assert.equal(home.location_override, null);
  const hall = withException(RULE, { kind: 'modified', patch_location_override: 'Church hall' });
  assert.equal(hall.location_override, 'Church hall');
  assert.equal(withException(RULE, NOT_LAST), RULE, 'not held changes nothing about how it is held');
});

test('a rule joined to its exceptions carries each way it is held', () => {
  const [r] = attachExceptions([{ ...RULE }], [ENGLISH_LAST, { id: 9, schedule_id: 1, weeks: 'first', kind: 'not_held' }]);
  assert.deepEqual(r.exceptions.map(x => x.id), [1]);
  assert.equal(r.variants.length, 1);
  assert.equal(r.variants[0].languages, '["English"]');
  assert.equal(r.variants[0].variants, undefined, 'a variant has none of its own');
  const [bare] = attachExceptions([{ ...RULE }], []);
  assert.deepEqual(bare.exceptions, []);
});

test('the dedup still reduces an exception week to one card', () => {
  const twin = { ...RULE, id: 35 };
  const out = expandFrom({ schedules: [RULE, twin], week_exceptions: [ENGLISH_LAST] }, FROM, TO);
  assert.equal(dedupe(out).filter(i => dateOf(i) === '2026-12-27').length, 1);
});

// ── Language filters: Homebush West ──────────────────────────────────────

test('a Serbian Liturgy held in English on the 1st Sunday is a service in English', () => {
  const serbian = { ...RULE, id: 119, parish_id: 'sshw', title: 'Divine Liturgy', languages: '["Serbian"]', start_time: '10:00' };
  const english = { id: 7, schedule_id: 119, weeks: 'first', kind: 'modified', patch_languages: '["English"]' };
  const [r] = attachExceptions([{ ...serbian }], [english]);
  assert.ok(T.ruleMatches(r, { lang: 'English' }));
  assert.ok(T.ruleMatches(r, { englishOnly: true, englishStrict: true }), 'English only, those weeks');
  assert.ok(T.ruleMatches(r, { lang: 'Serbian' }));
  assert.ok(!T.ruleMatches(serbian, { lang: 'English' }), 'without it, it is not');
  assert.deepEqual(T.parishLangsOf([r]), ['Serbian', 'English']);
  assert.ok(T.parishAnswersLang([r], T.langFilterOf({ lang: 'English' })));
  assert.ok(T.rowAnswersLang(r, T.langFilterOf({ lang: 'English' })));
  const [gone] = attachExceptions([{ ...serbian }], [{ ...english, kind: 'not_held' }]);
  assert.ok(!T.ruleMatches(gone, { lang: 'English' }), 'a week not held is in no language');
});

// ── The timetable's line ─────────────────────────────────────────────────

test("a line says what its exception changes, in the timetable's words", () => {
  const note = (x, r = RULE) => TL.exceptionNote(r, x);
  assert.equal(note(ENGLISH_LAST), 'last Sun: English');
  assert.equal(note(NOT_LAST), 'not on the last Sun');
  assert.equal(note({ weeks: 'first,third', kind: 'modified', patch_start_time: '10:30' }), '1st & 3rd Sun: 10:30am');
  assert.equal(note({ weeks: 'last', kind: 'modified', patch_end_time: '11:30' }), 'last Sun: until 11:30am', 'an end only when nothing else differs');
  assert.equal(note({ weeks: 'last', kind: 'modified', patch_location_override: 'the hall' }), 'last Sun: at the hall');
  assert.equal(note({ weeks: 'last', kind: 'modified', patch_description: 'Bring a plate' }), null, 'nothing a timetable shows');
});

test('rules share a line only when their exceptions are the same', () => {
  const sat = { ...RULE, id: 50, day_of_week: 6 };
  const sun = { ...RULE, id: 51 };
  const both = attachExceptions([sat, sun], [{ ...NOT_LAST, id: 10, schedule_id: 50 }, { ...NOT_LAST, id: 11, schedule_id: 51 }]);
  const lines = TL.linesOf(both, { today: '2026-11-04' });
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0].notes, ['not on the last Sat, Sun']);
  const apart = attachExceptions([{ ...sat }, { ...sun }], [{ ...NOT_LAST, id: 10, schedule_id: 50 }]);
  const two = TL.linesOf(apart, { today: '2026-11-04' });
  assert.equal(two.length, 2);
  assert.deepEqual(two.map(l => l.notes.length).sort(), [0, 1]);
});
