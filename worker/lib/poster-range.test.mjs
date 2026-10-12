// What still names a poster object — the question asked before one is deleted.
//
// The query is checked here as TEXT as well as run elsewhere, because the one
// limit that matters is D1's and the tests run on Node's SQLite: D1 refuses a
// compound SELECT of more than five terms ("too many terms in compound
// SELECT"), Node allows hundreds, and a sixth term — a rule's own poster,
// added as a term of its own — passed every test and failed every draft's
// Done and Discard under `wrangler dev`.

import test from 'node:test';
import assert from 'node:assert/strict';
import { namesPoster, referencedSql, posterKeyOf } from './poster-range.mjs';

const key = 'posters/rule-7-abc.jpg';
const cols = ['poster_path', 'patch_poster_path', 'poster_path', 'source_ref', 'poster_path', 'info_source_ref']
  .map(c => namesPoster(c, key));

test('the query that keeps a poster stays within D1’s five terms', () => {
  const sql = referencedSql(...cols);
  const terms = sql.split(/\bUNION\s+ALL\b/i).length;
  assert.ok(terms <= 5, `${terms} terms in a compound SELECT; D1 allows five`);
});

test('every place a poster can be named is asked: a date, a one-off, a draft, a rule’s source and its own poster, a parish', () => {
  const sql = referencedSql(...cols);
  for (const t of ['events', 'schedule_overrides', 'drafts', 'schedules', 'parishes']) assert.match(sql, new RegExp(`FROM ${t}\\b`));
  assert.match(sql, /FROM schedules WHERE \(source_ref = \?.*\) OR \(poster_path = \?/);
  assert.equal(posterKeyOf('/posters/rule-7-abc.jpg?v=1'), key);
});
