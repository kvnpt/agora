// What words mean to the search box, and to a link whose words nothing else
// claims (/smmp/disco): public/shared/search-words.js, which both read.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const W = require('../../public/shared/search-words.js');
const today = '2026-10-28'; // a Wednesday

const disco = { title: 'Disco Night (Registration Essential)', event_type: 'social', description: 'Ages 10 to 15.' };
const festival = { title: 'Antiochian Festival', event_type: 'feast', description: 'Join us at Antiochian Village in Goulburn.' };
const choir = { title: 'Choir Practice', event_type: 'other', day_of_week: 4, start_time: '19:30' };
const at = (date, hm = '19:00') => ({ date, hm });

test('words are looked for whole-word-first, without accents, apostrophes or "Saint"', () => {
  assert.equal(W.norm('St. Mary’s, Saints Peter & Paul — Ἅγιος'), 'st marys st peter paul αγιος');
  assert.ok(W.hasWord('disco night', 'disc'));
  assert.ok(!W.hasWord('disco night', 'isco'));
  assert.equal(W.phraseOf(['disco-night', 'bbq+raffle']), 'disco night bbq raffle');
});

test('"festival" names events, never every social and youth night (Kevin, 28 Oct 2026)', () => {
  for (const w of ['festival', 'fete', 'dinner', 'picnic', 'fundraiser']) {
    const Q = W.parseQuery(w, today);
    assert.equal(Q.kind, null, w);
    assert.deepEqual(Q.text, [w], w);
  }
  assert.ok(W.answers(festival, W.parseQuery('festival', today), at('2026-10-31')), 'by its title, whatever its kind');
  assert.ok(!W.answers(disco, W.parseQuery('festival', today), at('2026-11-14')));
  // A kind word is still a kind.
  assert.equal(W.parseQuery('socials', today).kind, 'social');
  assert.ok(W.answers(disco, W.parseQuery('social', today), at('2026-11-14')));
});

test('an event answers every word in its title, subtitle or description', () => {
  assert.ok(W.answers(disco, W.parseQuery('disco', today), at('2026-11-14')));
  assert.ok(W.answers(disco, W.parseQuery('disco night', today), at('2026-11-14')));
  assert.ok(!W.answers(disco, W.parseQuery('disco dinner', today), at('2026-11-14')), 'every word');
  assert.ok(W.answers(festival, W.parseQuery('village', today), at('2026-10-31')), 'its description');
  assert.ok(W.answers({ title: 'Liturgy', feast: 'St Demetrios', event_type: 'liturgy' }, W.parseQuery('demetrios', today), at('2026-10-26')), 'its subtitle');
});

test('a rule answers a day by its weekday, and "tonight" by its time', () => {
  assert.ok(W.answers(choir, W.parseQuery('choir', today)), 'no date: a rule');
  assert.ok(W.answers(choir, W.parseQuery('choir thursday', today)));
  assert.ok(!W.answers(choir, W.parseQuery('choir friday', today)));
  assert.ok(!W.answers(choir, W.parseQuery('choir tonight', today)), 'Thursday is not tonight, a Wednesday');
  assert.ok(W.answers(disco, W.parseQuery('tonight', '2026-11-14'), at('2026-11-14', '19:00')));
  assert.ok(!W.answers(disco, W.parseQuery('tonight', '2026-11-14'), at('2026-11-14', '10:00')));
});

test('a language word asks a service in it, or a talk at a parish that holds one', () => {
  const Q = W.parseQuery('arabic', today);
  assert.equal(Q.lang, 'Arabic');
  assert.ok(W.answers({ title: 'Liturgy', event_type: 'liturgy', languages: '["Arabic","English"]' }, Q, at('2026-11-01')));
  assert.ok(!W.answers({ title: 'Liturgy', event_type: 'liturgy', languages: '["English"]' }, Q, at('2026-11-01')));
  const talk = { title: 'Bible Study', event_type: 'talk' };
  assert.ok(W.answers(talk, Q, { ...at('2026-11-03'), parishLang: (l) => l === 'Arabic' }));
  assert.ok(!W.answers(talk, Q, { ...at('2026-11-03'), parishLang: () => false }));
});

test('words that ask nothing ask nothing', () => {
  assert.equal(W.asks(W.parseQuery('the', today)), false);
  assert.equal(W.asks(W.parseQuery('disco', today)), true);
});
