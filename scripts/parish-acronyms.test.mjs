// The acronym derivation, pinned to the six that were typed by hand.
//
// Those six are the specification: they are printed on pew sheets and shared
// as links, and a derivation that would have produced something else for them
// is a derivation that reads wrong to the people using it.

import test from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { dedicationInitials, candidatesFor, assignAcronyms, buildAcronymSql } from './parish-acronyms.mjs';

const require = createRequire(import.meta.url);
const { RESERVED_SLUGS } = require('../public/shared/slugs.js');

const first = (name, suburb) => candidatesFor(name, suburb).next().value;

test('the derivation reproduces the acronyms somebody typed', () => {
  // Three words, three letters. "St" is one S.
  assert.equal(first('Sts. Peter and Paul, Doonside'), 'SPP');
  assert.equal(first('Sts. Michael & Gabriel, Ryde'), 'SMG');
  assert.equal(first('St. Mary Magdalene, Elimbah'), 'SMM');
  assert.equal(first('Good Shepherd Mission, Clayton'), 'GSM');
  // Two words, so the suburb supplies the third — which is what SPW is.
  assert.equal(first('St. Paul, Woolloongabba'), 'SPW');
});

test('the suburb is not part of the dedication', () => {
  // "All Saints, Belmore" is ASB. Reading the whole stored name as the
  // dedication gave SB, with Belmore mistaken for part of the title.
  assert.deepEqual(dedicationInitials('All Saints, Belmore'), ['A', 'S']);
  assert.equal(first('All Saints, Belmore'), 'ASB');
});

test('a qualifier is kept while it is the dedication, dropped when it is an epithet', () => {
  // "Holy Cross" is what the parish is called; HC is how anyone writes it.
  assert.equal(first('Holy Cross Mission, Kalkallo'), 'HCM');
  assert.equal(first('Holy Trinity, Footscray'), 'HTF');
  // "of the Most Holy Theotokos" is four words and one idea.
  assert.deepEqual(dedicationInitials('Dormition of the Most Holy Theotokos'), ['D', 'T']);
  assert.deepEqual(dedicationInitials('Entrance of the Most Holy Theotokos'), ['E', 'T']);
});

test('five St Savas get five different links', () => {
  const parishes = [
    { id: 'a', name: 'St Sava, Highgate' },
    { id: 'b', name: 'St Sava, Hindmarsh' },
    { id: 'c', name: 'St Sava, Malak' },
    { id: 'd', name: 'St Sava, Greensborough' },
    { id: 'e', name: 'St Sava, Ingleside' },
  ];
  const { assigned, failed } = assignAcronyms(parishes);
  assert.equal(failed.length, 0);
  assert.equal(new Set(assigned.map((a) => a.acronym)).size, 5);
  for (const a of assigned) {
    assert.ok(a.acronym.length >= 3 && a.acronym.length <= 4, a.acronym);
    assert.ok(!RESERVED_SLUGS.has(a.acronym.toLowerCase()), a.acronym);
  }
});

test('an acronym somebody typed is never reassigned or reused', () => {
  const parishes = [
    { id: 'a', name: 'Sts. Peter and Paul, Doonside', acronym: 'SPP' },
    // Same dedication, no acronym: it must not be given SPP.
    { id: 'b', name: 'Sts Peter and Paul, Bayswater' },
  ];
  const { assigned } = assignAcronyms(parishes);
  assert.equal(assigned.length, 1);
  assert.equal(assigned[0].id, 'b');
  assert.notEqual(assigned[0].acronym, 'SPP');
});

test('a reserved slug is never chosen', () => {
  // "Newtown Serbian..." would love NSW. The router would never reach it.
  const { assigned } = assignAcronyms([{ id: 'x', name: 'New Saints, Wales' }]);
  assert.ok(!RESERVED_SLUGS.has(assigned[0].acronym.toLowerCase()));
});

test('the write cannot overwrite an acronym typed since it was generated', () => {
  const sql = buildAcronymSql([{ id: "st-mary's", acronym: 'SMB' }]);
  assert.match(sql, /UPDATE parishes SET acronym = 'SMB'/);
  assert.match(sql, /WHERE id = 'st-mary''s' AND \(acronym IS NULL OR acronym = ''\)/);
});

test('the sentinel parish is left alone', () => {
  const { assigned } = assignAcronyms([{ id: '_unassigned', name: 'Unassigned / Unknown Parish' }]);
  assert.equal(assigned.length, 0);
});
