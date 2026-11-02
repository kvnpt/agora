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

test('words that name no parish find one parish, a match at one, a list, or nothing', () => {
  const san = { id: 1, name: 'Antiochian Village', full_name: 'Holy Monastery of St Antony', acronym: 'SAN', address: 'Goulburn NSW' };
  const smmp = { id: 2, name: "St Mary's", acronym: 'SMMP', address: 'Mount Pritchard NSW' };
  const oca = { id: 3, name: 'Holy Resurrection', acronym: 'OCA', address: 'Redfern NSW' };
  const parishes = [san, smmp, oca];
  const rows = [
    { ...festival, parish_id: 1, _at: at('2026-10-31') },
    { ...disco, parish_id: 2, _at: at('2026-11-14') },
    { title: 'Vigil', event_type: 'prayer', day_of_week: 6, start_time: '18:00', parish_id: 3 },
    { title: 'All-night Vigil', event_type: 'prayer', parish_id: 2, _at: at('2026-11-07', '21:00') },
  ];
  const find = (q, more = {}) => W.findAcross({ parishes, rows, Q: W.parseQuery(q, today), ...more });

  assert.deepEqual(find('village'), { verdict: 'parish', pid: 1 }, 'its name, and what it holds is its own');
  assert.deepEqual(find('festival'), { verdict: 'match', pid: 1 }, 'found only at one parish');
  assert.deepEqual(find('disco'), { verdict: 'match', pid: 2 });
  const vigil = find('vigil');
  assert.equal(vigil.verdict, 'list');
  assert.deepEqual(vigil.ids, [3, 2], 'every parish it is found at');
  assert.deepEqual(find('nosuch'), { verdict: 'none' });
  assert.deepEqual(find('the'), { verdict: 'none' }, 'asks nothing');

  // One parish by name, and something elsewhere: both (Kevin, 28 Oct 2026).
  const bus = { title: 'Bus to Antiochian Village', event_type: 'other', parish_id: 2, _at: at('2026-10-31', '07:00') };
  const both = W.findAcross({ parishes, rows: [...rows, bus], Q: W.parseQuery('village', today) });
  assert.equal(both.verdict, 'list');
  assert.deepEqual(both.ids, [1, 2], 'the parish named first');
  assert.deepEqual(both.named, [1]);

  // What else a parish answers to (its jurisdiction's long name) is the caller's.
  assert.deepEqual(find('resurrection'), { verdict: 'parish', pid: 3 });
  assert.equal(find('america').verdict, 'none');
  assert.deepEqual(find('america', { hayOf: (p) => p.id === 3 ? 'Orthodox Church in America' : '' }), { verdict: 'parish', pid: 3 });
  // Words that name a parish ask the rest of themselves of it, as the box
  // does: /smg-feast is /smg/feast (Kevin, 1 Nov 2026).
  const vespers = { title: 'Great Vespers', feast: 'Archangels Michael and Gabriel', event_type: 'feast', parish_id: 2, _at: at('2026-11-07', '18:00') };
  assert.deepEqual(W.findAcross({ parishes, rows: [...rows, vespers], Q: W.parseQuery('smmp feast', today) }),
    { verdict: 'match', pid: 2, words: ['feast'] });
  assert.deepEqual(W.findAcross({ parishes, rows: [...rows, vespers], Q: W.parseQuery('smmp saturday', today) }),
    { verdict: 'match', pid: 2, words: ['saturday'] }, 'a day');
  assert.deepEqual(W.findAcross({ parishes, rows, Q: W.parseQuery('smmp feast', today) }), { verdict: 'parish', pid: 2 }, 'none there: the parish');
  assert.deepEqual(find('smmp'), { verdict: 'parish', pid: 2 }, 'its name alone asks nothing more');
  // Parishes and rows are what the link's other words left in.
  assert.deepEqual(W.findAcross({ parishes: [oca], rows: rows.filter(r => r.parish_id === 3), Q: W.parseQuery('vigil', today) }), { verdict: 'match', pid: 3 });
});

// Kevin, 2 Nov 2026: "antiochian michael" listed Ryde's and the Village's
// events but not Kirrawee's Feast of St Michael. Ryde and the Village have
// "Antiochian" in their names; Kirrawee has it only as its jurisdiction, and
// its feast says "Michael" but not "Antiochian". A word is found wherever it
// is, each in what a row says or in where it is.
test('each word is found in what a row says or in its parishes', () => {
  const smk = { id: 'smk', name: 'St. Michael, Kirrawee', full_name: 'St. Michael, Kirrawee', acronym: 'SMK', address: '47 Durbar Avenue, Kirrawee 2232 NSW', jurisdiction: 'antiochian' };
  const where = W.parishWords(smk, 'Antiochian Orthodox');
  const feast = { title: 'Feast of Saint Michael', feast: 'Saint Michael the Archangel', event_type: 'feast', description: 'Matins at 8:45am, Divine Liturgy at 10:00am.' };
  const liturgy = { title: 'Liturgy', event_type: 'liturgy' };
  const Q = W.parseQuery('antiochian michael', today);
  assert.ok(!W.answers(feast, Q, at('2026-11-08', '08:45')), 'what it says alone has no "antiochian"');
  assert.ok(W.answers(feast, Q, { ...at('2026-11-08', '08:45'), where }), 'its jurisdiction says it');
  assert.ok(W.answers(liturgy, Q, { ...at('2026-11-15', '10:00'), where }), 'its parish says both');
  assert.ok(W.answers(liturgy, W.parseQuery('kirrawee liturgy', today), { ...at('2026-11-15', '10:00'), where }));
  assert.ok(!W.answers(liturgy, W.parseQuery('kirrawee vespers', today), { ...at('2026-11-15', '10:00'), where }), 'still every word');
  assert.ok(W.answers({ title: 'Fishing Day', event_type: 'social', location_override: 'Dolls Point' }, W.parseQuery('dolls point', today)), 'a place of its own');
  // What it says itself counts first.
  assert.equal(W.saysCount(feast, Q), 1);
  assert.equal(W.saysCount(liturgy, Q), 0);
  // Its parishes: its own, the one it is held at, those taking part.
  assert.deepEqual(W.parishIdsOf({ parish_id: 'smg', location_parish_id: 'san', extra_parishes: ['smk', { id: 'san' }] }), ['smg', 'san', 'smk']);
});

test('across the site: a parish named is there for itself; a row elsewhere by what it says and its parishes', () => {
  const smg = { id: 'smg', name: 'Sts. Michael & Gabriel, Ryde', full_name: 'Sts Michael & Gabriel Antiochian Orthodox Church', acronym: 'SMG', address: '72 Belmore St, Ryde 2112 NSW', jurisdiction: 'antiochian' };
  const smk = { id: 'smk', name: 'St. Michael, Kirrawee', acronym: 'SMK', address: '47 Durbar Avenue, Kirrawee 2232 NSW', jurisdiction: 'antiochian' };
  const snp = { id: 'snp', name: 'St Nicholas, Punchbowl', acronym: 'SNP', address: 'Punchbowl NSW', jurisdiction: 'antiochian' };
  const sgr = { id: 'sgr', name: 'St George, Redfern', acronym: 'SGR', address: 'Redfern NSW', jurisdiction: 'greek' };
  const parishes = [smg, smk, snp, sgr];
  const juris = { antiochian: 'Antiochian Orthodox', greek: 'Greek Orthodox' };
  const hayOf = (p) => juris[p.jurisdiction];
  const vespers = { title: 'Great Vespers', feast: 'Archangels Michael and Gabriel', event_type: 'feast', parish_id: 'smg', extra_parishes: ['smk'], _at: at('2026-11-07', '18:00') };
  const kFeast = { title: 'Feast of Saint Michael', event_type: 'feast', parish_id: 'smk', _at: at('2026-11-08', '08:45') };
  const nSynaxis = { title: 'Liturgy', feast: 'Synaxis of the Archangel Michael', event_type: 'liturgy', parish_id: 'snp', _at: at('2026-11-08', '09:00') };
  const gSynaxis = { title: 'Liturgy', feast: 'Archangel Michael', event_type: 'liturgy', parish_id: 'sgr', _at: at('2026-11-08', '09:00') };
  const sunday = { title: 'Liturgy', event_type: 'liturgy', day_of_week: 0, start_time: '10:00', parish_id: 'smk' };
  const rows = [sunday, vespers, kFeast, nSynaxis, gSynaxis];
  const find = (q, more = {}) => W.findAcross({ parishes, rows, Q: W.parseQuery(q, today), hayOf, ...more });

  // Ryde and Kirrawee by name, and Punchbowl's Synaxis by its jurisdiction; not Redfern's.
  const am = find('antiochian michael');
  assert.equal(am.verdict, 'list');
  assert.deepEqual(am.named, ['smg', 'smk']);
  assert.deepEqual(am.ids, ['smg', 'smk', 'snp']);
  // Kirrawee is Kirrawee, not the Vespers at Ryde it takes part in.
  assert.deepEqual(find('kirrawee'), { verdict: 'parish', pid: 'smk' });
  // Found only through those taking part: what is asked of Ryde is what its rows say.
  assert.deepEqual(find('kirrawee vespers'), { verdict: 'match', pid: 'smg', words: ['vespers'] });
  assert.deepEqual(find('ryde vespers'), { verdict: 'match', pid: 'smg', words: ['vespers'] }, 'its own suburb, too');
  assert.deepEqual(find('punchbowl synaxis'), { verdict: 'match', pid: 'snp', words: ['synaxis'] });
  assert.deepEqual(find('synaxis'), { verdict: 'match', pid: 'snp' }, 'all of it said: the words as they are');
  // What says the words comes first: a preview's poster and titles.
  const bus = { title: 'Bus from Ryde to Kirrawee', event_type: 'other', parish_id: 'sgr', _at: at('2026-11-08', '07:00') };
  const rk = W.findAcross({ parishes, rows: [...rows, bus], Q: W.parseQuery('ryde kirrawee', today), hayOf });
  assert.deepEqual(rk.found, [bus, vespers], 'the bus says both; the Vespers is at Ryde with Kirrawee');
  assert.deepEqual(rk.ids, ['sgr', 'smg']);
  // A row's parishes outside the link's (its jurisdiction's) still say their words.
  const greekOnly = W.findAcross({ parishes: [sgr], rows: [{ ...gSynaxis, extra_parishes: ['smk'] }], Q: W.parseQuery('kirrawee archangel', today), hayOf, everyParish: parishes });
  assert.deepEqual(greekOnly, { verdict: 'match', pid: 'sgr', words: ['archangel'] });
});
