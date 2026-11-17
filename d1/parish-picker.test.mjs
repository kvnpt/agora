// public/shared/parish-picker.js — the parts that are not the DOM: how the
// one list of parishes is divided (by distance, by archdiocese, by location),
// what a search finds, and the line under a parish's name. The list itself,
// and every door to it, is checked in a browser (docs/browser-checks.md).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../public/shared/parish-picker.js');
const C = require('../public/shared/collections.js');

const ps = [
  { id: 'sgr', name: 'St. George Cathedral, Redfern', acronym: 'SGR', jurisdiction: 'antiochian', address: 'Cnr Walker & Cooper Sts, Redfern 2016 NSW, Australia', lat: -33.892, lng: 151.209 },
  { id: 'hts', name: 'Holy Trinity, Surry Hills', acronym: 'HTS', jurisdiction: 'greek', address: '626 Bourke St, Surry Hills NSW 2010', lat: -33.889, lng: 151.215 },
  { id: 'snp', name: 'St. Nicholas, Punchbowl', acronym: 'SNP', jurisdiction: 'antiochian', address: '51 Rossmore Ave, Punchbowl NSW 2196', lat: -33.929, lng: 151.055 },
  { id: 'wol', name: 'St Nektarios, Wollongong', acronym: 'SNW', jurisdiction: 'greek', address: '39 Atchison St, Wollongong NSW 2500', lat: -34.427, lng: 150.893 },
  { id: 'dub', name: 'Holy Trinity, Dubbo', acronym: 'HTD', jurisdiction: 'serbian', address: '1 Church St, Dubbo NSW 2830', lat: -32.243, lng: 148.605 },
  { id: 'mel', name: 'St Sava, Greensborough', acronym: 'SSG', jurisdiction: 'serbian', address: '212 Diamond Creek Rd, Greensborough VIC 3088', lat: -37.69, lng: 145.12 },
  { id: 'cbr', name: 'St Nicholas, Kingston', acronym: 'SNK', jurisdiction: 'greek', address: '1 Gosse St, Kingston ACT 2604', lat: -35.315, lng: 149.14 },
  { id: 'akl', name: 'St Milutin the King, Pt Chevalier', acronym: 'SMK', jurisdiction: 'serbian', address: '315 Pt Chevalier Rd, Pt Chevalier, Auckland 1022 New Zealand', lat: -36.87, lng: 174.71 },
  { id: 'old', name: 'Somewhere Old', jurisdiction: 'other', address: '', lat: 10, lng: 10 },
  { id: '_unassigned', name: 'x', jurisdiction: 'other', lat: 0, lng: 0 },
];
const redfern = { lat: -33.892, lng: 151.209 };
const ids = (secs) => secs.map(s => [s.label, s.rows.map(r => r.p.id)]);

test('nearest: one list by distance, divided where the page’s distance colours change', () => {
  const secs = P.sectionsOf(ps, { sort: 'near', origin: redfern });
  assert.deepEqual(ids(secs), [
    ['Within 5km', ['sgr', 'hts']],
    ['5 to 15km', ['snp']],
    ['50 to 200km', ['wol']],
    ['Over 200km', ['cbr', 'dub', 'mel', 'akl', 'old']],
  ]);
  assert.ok(secs[0].rows[0].km < secs[0].rows[1].km);
});

test('nearest with nowhere to measure from is the archdioceses, by name', () => {
  const secs = P.sectionsOf(ps, { sort: 'near' });
  assert.equal(secs[0].label, 'Greek Orthodox');
  assert.deepEqual(secs[0].rows.map(r => r.p.id), ['hts', 'wol', 'cbr']);
});

test('archdiocese: the jurisdiction collections in their order, the asker’s own first, nearest first in each', () => {
  const secs = P.sectionsOf(ps, { sort: 'juris', origin: redfern, first: 'serbian' });
  assert.deepEqual(ids(secs), [
    ['Serbian Orthodox', ['dub', 'mel', 'akl']],
    ['Greek Orthodox', ['hts', 'wol', 'cbr']],
    ['Antiochian Orthodox', ['sgr', 'snp']],
    ['Other', ['old']],
  ]);
  // The names and the order are collections.js's, not a second list.
  const plain = P.sectionsOf(ps, { sort: 'juris' }).map(s => s.label).filter(l => l !== 'Other');
  assert.deepEqual(plain, C.JURISDICTIONS.map(c => c.title).filter(t => plain.includes(t)));
  assert.equal(secs[0].jurisdiction, 'serbian');
});

test('location: a city, then the rest of its state; regions nearest first', () => {
  const secs = P.sectionsOf(ps, { sort: 'place', origin: redfern });
  assert.deepEqual(ids(secs), [
    ['Sydney', ['sgr', 'hts', 'snp']],
    ['Wollongong', ['wol']],
    ['Elsewhere in New South Wales', ['dub']],
    ['Canberra', ['cbr']],
    ['Melbourne', ['mel']],
    ['Auckland', ['akl']],
    ['Elsewhere', ['old']],
  ]);
  // With nowhere to measure from, as locations.js lists them, by name in each.
  assert.deepEqual(P.sectionsOf(ps, { sort: 'place' }).map(s => s.label),
    ['Sydney', 'Wollongong', 'Elsewhere in New South Wales', 'Melbourne', 'Canberra', 'Auckland', 'Elsewhere']);
});

test('every parish is listed, whoever asks: never the unassigned bucket, and nothing narrowed', () => {
  // A contact's list once came back holding only their own parish, which made
  // the ask unreachable by the only people it is for. Whose a parish is, is a
  // word beside its name (`tagOf`), never a reason to leave it out.
  for (const sort of ['near', 'juris', 'place']) {
    const got = P.sectionsOf(ps, { sort, origin: redfern }).flatMap(s => s.rows.map(r => r.p.id)).sort();
    assert.deepEqual(got, ps.map(p => p.id).filter(id => id !== '_unassigned').sort(), sort);
  }
});

test('words typed find a parish by its name, short name, suburb, jurisdiction or city', () => {
  const found = (q) => P.sectionsOf(ps, { sort: 'near', origin: redfern, q }).flatMap(s => s.rows.map(r => r.p.id));
  assert.deepEqual(found('nicholas'), ['snp', 'cbr']);
  assert.deepEqual(found('SGR'), ['sgr']);
  assert.deepEqual(found('surry'), ['hts']);
  assert.deepEqual(found('serbian'), ['dub', 'mel', 'akl']);
  assert.deepEqual(found('melbourne'), ['mel']);
  assert.deepEqual(found('holy trinity dubbo'), ['dub']);
  // A word's start: "st" is not every Constantine, and "ant" is Antiochian.
  assert.deepEqual(found('ant'), ['sgr', 'snp']);
  assert.deepEqual(found('zzz'), []);
  assert.ok(P.matches(ps[0], '  '));
});

test('where a parish is: its city, or its state or country', () => {
  assert.deepEqual(P.placeOf(ps[0]), { key: 'syd', label: 'Sydney', region: 'nsw', regionLabel: 'New South Wales', city: true });
  assert.equal(P.placeOf(ps[4]).key, 'in-nsw');
  assert.equal(P.placeOf(ps[6]).label, 'Canberra');
  assert.equal(P.placeOf(ps[7]).region, 'nz');
  assert.equal(P.placeOf(ps[8]).label, 'Elsewhere');
});

test('the line under a name: the jurisdiction, and a suburb only where the name does not say it', () => {
  assert.equal(P.subOf(ps[0], 'near'), 'Antiochian');
  assert.equal(P.subOf(ps[0], 'juris'), '', 'its section says the jurisdiction');
  assert.equal(P.subOf(ps[5], 'near'), 'Serbian');
  assert.equal(P.subOf({ name: 'St Dionysios, Gosford', jurisdiction: 'greek', address: '21 Nurses Road, Central Mangrove, NSW, 2250' }, 'near'), 'Greek · Central Mangrove');
  // Not a state, a postcode, a country or a street corner.
  assert.equal(P.subOf({ name: 'St. Nicholas Church, Fairfield', jurisdiction: 'russian', address: '5 Barbara St, Fairfield, NSW 2165 Australia' }, 'near'), 'Russian');
  assert.equal(P.subOf({ name: 'St Athanasios, Rookwood', jurisdiction: 'greek', address: 'Cnr. Weekes & Carpenter Ave Rookwood' }, 'near'), 'Greek');
  assert.equal(P.subOf({ name: 'Our Lady, Northcote', jurisdiction: 'greek', address: '7 Hartington Street, Northcote, VIC. 3070' }, 'juris'), '');
});

test('the suburb is the last part of an address that is a place', () => {
  assert.equal(P.suburbOf('12/14 Balmoral Ave, Croydon Park, NSW 2133'), 'Croydon Park');
  assert.equal(P.suburbOf('360 Abercrombie St'), '');
});

test('distance reads as the page’s rows say it', () => {
  assert.equal(P.fmtKm(0.04), '0.1km');
  assert.equal(P.fmtKm(0.64), '0.6km');
  assert.equal(P.fmtKm(3.4), '3km');
  assert.equal(P.fmtKm(701.2), '701km');
  assert.equal(P.km(redfern, { lat: null, lng: null }), Infinity);
});
