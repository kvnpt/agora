// What may be proposed, and whether a proposal is well-formed.

import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProposal, describeProposal, readPayload, PROPOSABLE, isOpen }
  from './proposals.mjs';

const ok = (c, subject, payload) => validateProposal({ capability: c, subject, payload });

test('only an ask with nowhere else to go can be proposed', async () => {
  // Not a general approval queue. Ordinary edits just happen — the moderation
  // subsystem died with the VM and is not coming back. Three capability
  // refusals, plus the one scope refusal a combine can be.
  assert.deepEqual(PROPOSABLE,
    ['parish.delete', 'parish.acronym', 'colors.edit', 'event.combine']);
  for (const c of ['parish.edit', 'schedule.delete', 'people.manage', 'adapter.run', '']) {
    const r = validateProposal({ capability: c, subject: 'x', payload: {} });
    assert.equal(r.ok, false, `${c} should not be proposable`);
    assert.match(r.error, /not something that can be proposed/);
  }
});

test('a combine proposal carries the whole desired state', async () => {
  // Not the refused half. `writeCombine` removes whatever a target state does
  // not name, so a payload holding only the out-of-scope targets would strip
  // the in-scope ones the moment it was approved.
  const r = ok('event.combine', '42',
    { additive_parish_ids: [' p1 ', 'p1', 'p2'], replaced_event_ids: [7, '9:2026-09-27', '', null] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.payload.additive_parish_ids, ['p1', 'p2'], 'trimmed and deduped');
  // Ids stay STRINGS and are not classified here: which of these is a stored
  // one-off and which a projected occurrence is a question for the approving
  // route, asked against the database as it is then.
  assert.deepEqual(r.payload.replaced_event_ids, ['7', '9:2026-09-27']);
});

test('a combine proposal has to ask for something', async () => {
  for (const payload of [{}, { additive_parish_ids: [], replaced_event_ids: [] },
                         { additive_parish_ids: 'p1' }]) {
    const r = ok('event.combine', '42', payload);
    assert.equal(r.ok, false, `${JSON.stringify(payload)} passed`);
    assert.match(r.error, /name a parish to appear at, or a service to absorb/);
  }
});

test('a combine reads as a sentence, in names and not ids', async () => {
  const both = describeProposal('event.combine',
    { additive_parish_ids: ['p1'], replaced_event_ids: ['9:2026-09-27'] },
    { subject: 'Deanery Liturgy', parishes: ['St Nicholas, Bankstown'],
      targets: ['Sunday Divine Liturgy at St Nicholas, Bankstown on 2026-09-27'] });
  assert.match(both, /^List “Deanery Liturgy” at St Nicholas, Bankstown, and absorb /);
  // The consequence, not just the verb: an owner is about to make a service
  // stop being its own card.
  assert.match(both, /still renders, as a tombstone/);

  const addOnly = describeProposal('event.combine',
    { additive_parish_ids: ['p1', 'p2'], replaced_event_ids: [] },
    { subject: 'Vigil', parishes: ['St Elias', "St Mary's"], targets: [] });
  assert.equal(addOnly, `List “Vigil” at St Elias and St Mary's.`);

  // An empty target state is a legitimate ask — "take it back off them".
  const none = describeProposal('event.combine',
    { additive_parish_ids: [], replaced_event_ids: [] }, { subject: 'Vigil' });
  assert.match(none, /Take “Vigil” off every other parish/);
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
