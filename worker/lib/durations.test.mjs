import test from 'node:test';
import assert from 'node:assert/strict';
import { usualLength, endOf, lengthText, servicesNamed } from './durations.mjs';

const mins = (title, event_type) => (usualLength({ title, event_type }) || {}).minutes ?? null;

test('Kevin’s usual lengths: Liturgy 1½ hours, Matins 1, Vespers 1½, Bible study 1½, a fair 4', () => {
  assert.equal(mins('Divine Liturgy'), 90);
  assert.equal(mins('Liturgy'), 90);
  assert.equal(mins('Matins'), 60);
  assert.equal(mins('Orthros'), 60);
  assert.equal(mins('Great Vespers'), 90);
  assert.equal(mins('Bible Study'), 90);
  assert.equal(mins('Bible studies for young adults'), 90);
  assert.equal(mins('Christmas Fair'), 240);
  assert.equal(mins('Greek Festival'), 240);
  assert.equal(mins('Paniyiri'), 240);
});

test('a name with several services is them one after another; a Vesperal Liturgy is a Liturgy', () => {
  assert.equal(mins('Matins & Divine Liturgy'), 150);
  assert.equal(mins('Orthros and Divine Liturgy'), 150);
  assert.equal(usualLength({ title: 'Orthros and Divine Liturgy' }).what, 'Matins and Liturgy');
  assert.equal(mins('Vesperal Divine Liturgy'), 90);
  assert.deepEqual(servicesNamed('Matins & Divine Liturgy'), ['matins', 'liturgy']);
  assert.deepEqual(servicesNamed('Youth Night'), []);
});

test('nothing is guessed for a name that gives nothing to go by, but a Liturgy by its kind is one', () => {
  assert.equal(mins('Paraklesis', 'prayer'), null);
  assert.equal(mins('Talk on the Nativity', 'talk'), null);
  assert.equal(mins('Youth Night', 'youth'), null);
  assert.equal(mins('Holy Eucharist', 'liturgy'), 90);
});

test('a feast is two hours, by its kind or its name, unless its name says longer', () => {
  // Kevin, 19 Nov 2026: "a feast is default 2 hours". St Nicholas, Punchbowl's
  // "Feast of Saint Catherine, Tuesday 6:30 PM, Vespers and the Breaking of
  // the Five Loaves" printed no end.
  assert.deepEqual(usualLength({ title: 'Feast of Saint Catherine the Great Martyr', event_type: 'feast' }),
    { minutes: 120, what: 'a feast' });
  assert.equal(mins('Feast of St Nicholas', 'prayer'), 120, 'by its name');
  assert.equal(mins('Great Vespers and Artoklasia', 'feast'), 120, 'by its kind: more than the Vespers alone');
  assert.equal(mins('Matins & Divine Liturgy', 'feast'), 150, 'its services, when they run longer');
  assert.equal(mins('Feast Day Paniyiri', 'feast'), 240);
  assert.deepEqual(endOf({ title: 'Feast of Saint Catherine', event_type: 'feast', start_time: '18:30' }),
    { end: '20:30', usual: { minutes: 120, what: 'a feast' } });
  // A feast's Liturgy kinded as a Liturgy is a Liturgy's length.
  assert.equal(mins('Divine Liturgy', 'liturgy'), 90);
});

test('an end of its own wins; a usual one never runs past midnight', () => {
  assert.deepEqual(endOf({ title: 'Divine Liturgy', start_time: '09:00', end_time: '10:15' }), { end: '10:15', usual: null });
  assert.deepEqual(endOf({ title: 'Divine Liturgy', start_time: '10:00' }), { end: '11:30', usual: { minutes: 90, what: 'Liturgy' } });
  assert.equal(endOf({ title: 'New Year Festival', start_time: '21:00' }), null);
  assert.equal(endOf({ title: 'Paraklesis', start_time: '18:00' }), null);
  assert.equal(endOf({ title: 'Divine Liturgy', start_time: null }), null);
  // An end before its start is no end: the usual length instead.
  assert.equal(endOf({ title: 'Divine Liturgy', start_time: '10:00', end_time: '09:00' }).end, '11:30');
});

test('lengths read as a person says them', () => {
  assert.deepEqual([60, 90, 150, 240, 45, 75].map(lengthText),
    ['1 hour', '1½ hours', '2½ hours', '4 hours', '45 minutes', '1 hour 15 minutes']);
});
