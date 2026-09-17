// What may be proposed, and whether a proposal is well-formed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProposal, describeProposal, readPayload, PROPOSABLE, isOpen }
  from './proposals.mjs';

const ok = (c, subject, payload) => validateProposal({ capability: c, subject, payload });

test('only the three refused capabilities can be proposed', async () => {
  // Not a general approval queue. Ordinary edits just happen — the moderation
  // subsystem died with the VM and is not coming back.
  assert.deepEqual(PROPOSABLE, ['parish.delete', 'parish.acronym', 'colors.edit']);
  for (const c of ['parish.edit', 'schedule.delete', 'people.manage', 'adapter.run', '']) {
    const r = validateProposal({ capability: c, subject: 'x', payload: {} });
    assert.equal(r.ok, false, `${c} should not be proposable`);
    assert.match(r.error, /not something that can be proposed/);
  }
});

test('a proposal has to name what it is about', async () => {
  for (const subject of ['', '   ', null, undefined, 7]) {
    assert.equal(ok('parish.acronym', subject, { acronym: 'smg' }).ok, false);
  }
});

test('an acronym proposal keeps the asked-for value, empty included', async () => {
  assert.deepEqual(ok('parish.acronym', 'p1', { acronym: ' smg ' }).payload, { acronym: 'smg' });
  // "Take this link away" is a legitimate ask.
  assert.deepEqual(ok('parish.acronym', 'p1', { acronym: '' }).payload, { acronym: '' });
  assert.deepEqual(ok('parish.acronym', 'p1', {}).payload, { acronym: '' });
});

test('a clash is NOT decided here', async () => {
  // Deliberately: the row can sit for a week while the parish is renamed or
  // given that very acronym, so the answer belongs to the approving route.
  assert.equal(ok('parish.acronym', 'p1', { acronym: 'greek' }).ok, true);
  assert.equal(ok('parish.acronym', 'p1', { acronym: 'qld' }).ok, true);
});

test('a colour proposal needs a real hex', async () => {
  assert.equal(ok('colors.edit', 'greek', { color: '#0d5eaf' }).ok, true);
  assert.equal(ok('colors.edit', 'greek', { color: '#abc' }).ok, true);
  for (const bad of ['red', '0d5eaf', '#12345', '#gggggg', '', null, 'red; }']) {
    assert.equal(ok('colors.edit', 'greek', { color: bad }).ok, false, `${bad} passed`);
  }
});

test('a delete proposal carries what happens to the events', async () => {
  // "Delete this parish" and "delete this parish and its 80 events" are
  // different requests, and the owner should not have to guess which was meant.
  const purge = ok('parish.delete', 'p1', { disposition: 'purge' });
  assert.deepEqual(purge.payload, { disposition: 'purge' });

  const move = ok('parish.delete', 'p1', { disposition: 'transfer', transferTo: 'p2' });
  assert.deepEqual(move.payload, { disposition: 'transfer', transferTo: 'p2' });

  const vague = ok('parish.delete', 'p1', { disposition: 'transfer' });
  assert.equal(vague.ok, false);
  assert.match(vague.error, /which parish the events should move to/);

  // Defaulting to transfer rather than purge: the safer reading of an
  // unspecified ask, and it still refuses without a destination.
  assert.equal(ok('parish.delete', 'p1', {}).ok, false);
});

test('the description carries the consequence, not just the verb', async () => {
  // The owner is about to do something irreversible on somebody else's say-so.
  assert.match(describeProposal('parish.acronym', { acronym: 'smg' }, { subject: 'St Michael' }),
    /public link becomes \/smg/);
  assert.match(describeProposal('parish.acronym', { acronym: '' }, { subject: 'St Michael' }),
    /stops resolving/);
  assert.match(describeProposal('colors.edit', { color: '#0d5eaf' }, { subject: 'greek' }),
    /every greek parish/);
  assert.match(describeProposal('parish.delete', { disposition: 'purge' }, { subject: 'St Elias' }),
    /all of its events.*cannot be undone/);
  assert.match(
    describeProposal('parish.delete', { disposition: 'transfer', transferTo: 'p2' },
      { subject: 'St Elias', transferTo: 'St George' }),
    /moving its events and rules to St George/);
});

test('a payload that is not readable makes one proposal un-approvable, not the list broken', async () => {
  assert.equal(readPayload('{"a":1}').a, 1);
  // An array is typeof 'object'. Letting one through would hand the approving
  // route a shape that reads as all-undefined — a delete with no disposition,
  // which then defaults to something nobody asked for.
  for (const bad of ['not json', '[1,2]', 'null', '"a string"', '', '7']) {
    assert.equal(readPayload(bad), null, `${bad} should not read as a payload`);
  }
});

test('only an open proposal is actionable', async () => {
  assert.equal(isOpen({ status: 'open' }), true);
  for (const s of ['approved', 'declined', 'withdrawn']) {
    assert.equal(isOpen({ status: s }), false);
  }
  assert.equal(isOpen(null), false);
});
