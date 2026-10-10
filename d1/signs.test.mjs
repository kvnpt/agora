// A church sign beside what is on file (public/shared/signs.js): what the
// review offers to add, what it says is there already, and what it leaves be.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../public/shared/signs.js');

const rule = (o) => ({ id: 1, day_of_week: 0, start_time: '10:00', end_time: null, title: 'Divine Liturgy',
  week_of_month: null, languages: null, active: 1, effective_to: null, ...o });
const svc = (o) => ({ title: 'Divine Liturgy', day_of_week: 0, start_time: '10:00', end_time: null,
  week_of_month: null, languages: null, event_type: 'liturgy', read_notes: [], ...o });

test('the same day, time and weeks is on file, however the title is worded', () => {
  const { rows } = S.compareSign([svc({ title: 'Divine Liturgy' })], [rule({ title: 'Sunday Divine Liturgy' })]);
  assert.equal(rows[0].status, 'on_file');
  assert.equal(rows[0].rule.title, 'Sunday Divine Liturgy');
});

test('a different time is a new service; other weeks at the same time is a correction, not a second rule', () => {
  const rules = [rule({})];
  assert.equal(S.compareSign([svc({ start_time: '18:00' })], rules).rows[0].status, 'new');
  const weeks = S.compareSign([svc({ week_of_month: 'second,fourth' })], rules);
  assert.deepEqual([weeks.rows[0].status, weeks.rows[0].rule.id, weeks.rows[0].fills], ['weeks', 1, { week_of_month: 'second,fourth' }]);
  assert.deepEqual(weeks.missing, [], 'and it is not also "not on the sign"');
  // A rule exactly on the sign is that line's, never another line's "other weeks".
  const both = S.compareSign([svc({ week_of_month: 'first' }), svc({})], [rule({ id: 1 })]);
  assert.deepEqual(both.rows.map(r => r.status), ['new', 'on_file']);
  // The weeks in any order, and all five, are the same thing.
  assert.equal(S.compareSign([svc({ week_of_month: 'fourth,second' })],
    [rule({ week_of_month: 'second,fourth' })]).rows[0].status, 'on_file');
  assert.equal(S.compareSign([svc({ week_of_month: 'first,second,third,fourth,last' })], rules).rows[0].status, 'on_file');
});

test('the sign fills what the rule leaves empty, and nothing it already says', () => {
  const { rows } = S.compareSign(
    [svc({ end_time: '12:00', languages: ['Arabic', 'English'] })],
    [rule({ end_time: null, languages: null })]);
  assert.deepEqual(rows[0].fills, { end_time: '12:00', languages: ['Arabic', 'English'] });
  const said = S.compareSign([svc({ end_time: '12:00', languages: ['Arabic'] })],
    [rule({ end_time: '11:30', languages: '["English"]' })]);
  assert.deepEqual(said.rows[0].fills, {}, 'a rule that says otherwise is the person’s to change on the timetable');
});

test('an ended or inactive rule is not on file; one rule answers one service', () => {
  const ended = rule({ effective_to: '2026-01-01' });
  assert.equal(S.compareSign([svc({})], [ended], '2026-10-10').rows[0].status, 'new');
  assert.equal(S.compareSign([svc({})], [rule({ active: 0 })]).rows[0].status, 'new');
  const two = S.compareSign([svc({}), svc({})], [rule({})]);
  assert.deepEqual(two.rows.map(r => r.status), ['on_file', 'new']);
});

test('what the timetable has and the sign does not is listed, in order, and nothing is offered for it', () => {
  const { missing } = S.compareSign([svc({})], [
    rule({ id: 1 }), rule({ id: 2, day_of_week: 3, start_time: '18:00', title: 'Vespers' }),
    rule({ id: 3, day_of_week: 0, start_time: '08:00', title: 'Orthros' }),
  ]);
  assert.deepEqual(missing.map(r => r.id), [3, 2]);
});

test('details: the same number or address printed another way is the same', () => {
  const p = { address: '182 Hill End Road, Doonside NSW 2767', phone: '02 9643 2850', email: null, website: 'https://www.sts.org.au/' };
  const rows = S.compareDetails({ address: '182 Hill End Rd, Doonside 2767', phone: '(02) 96432850',
    email: 'office@sts.org.au', website: 'www.sts.org.au' }, p);
  assert.deepEqual(rows.map(r => [r.field, r.status]),
    [['address', 'same'], ['phone', 'same'], ['email', 'empty'], ['website', 'same']]);
  assert.equal(S.compareDetails({ phone: '+61 2 9597 3346' }, { phone: '02 9643 2850' })[0].status, 'differs');
  assert.deepEqual(S.compareDetails(null, p), []);
});

test('services the editor sends back are checked, and shaped as the read gives them', () => {
  const ok = S.validateServices([{ day_of_week: 6, start_time: '08:00', end_time: '', title: ' Orthros ',
    week_of_month: 'second,first', languages: ['Greek', 'Greek', ' '], read_notes: [{ field: 'title', text: 'x' }] }]);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.services[0], { title: 'Orthros', day_of_week: 6, start_time: '08:00', end_time: null,
    week_of_month: 'first,second', languages: ['Greek'], event_type: 'liturgy', read_notes: [{ field: 'title', text: 'x' }] });
  for (const [bad, words] of [[{ day_of_week: 7, start_time: '08:00' }, /day/], [{ day_of_week: 0, start_time: '8am' }, /08:00/],
    [{ day_of_week: 0, start_time: '08:00', end_time: '10' }, /end time/], [{ day_of_week: 0, start_time: '08:00', event_type: 'mass' }, /kinds/]]) {
    const r = S.validateServices([bad]);
    assert.equal(r.ok, false);
    assert.match(r.error, words);
  }
  assert.equal(S.validateServices('nope').ok, false);
});

test('weeks read as people say them', () => {
  assert.equal(S.weeksLabel('second,fourth'), '2nd & 4th');
  assert.equal(S.weeksLabel('first,third,last'), '1st, 3rd & last');
  assert.equal(S.weeksLabel(null), '');
  assert.equal(S.SIGN_SOURCE, 'Church signage');
});
