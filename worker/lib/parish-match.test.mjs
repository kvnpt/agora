// Which parish a poster is from, and when a venue is only the parish itself.
// The fixtures are written the way production holds them — "St." and "St",
// "Street" and "St", suburbs with and without their comma.

import test from 'node:test';
import assert from 'node:assert/strict';
import { streetKey, sameStreetAddress, isOwnVenue, matchParish } from './parish-match.mjs';

const PARISHES = [
  { id: 'antiochian-stelias-wollongong', name: 'St. Elias, Wollongong', address: '86 Kenny Street, Wollongong 2500 NSW, Australia' },
  { id: 'antiochian-stelias-westcroydon', name: 'St. Elias, West Croydon', address: '17 Herbert Road, West Croydon 5008 SA, Australia' },
  { id: 'greek-prophetelias-norwood', name: 'Prophet Elias, Norwood', address: '87 Beulah Rd Norwood, SA 5067' },
  { id: 'russian-prophetelias-monartosouth', name: 'Monastery of the Prophet Elias, Monarto South', address: '272 Frahns Farm Road, Monarto South SA 5254' },
  { id: 'antiochian-stgeorge-redfern', name: 'St George Cathedral, Redfern', address: 'Cnr Walker & Cooper Streets, Redfern NSW 2016' },
  { id: 'greek-annunciation-redfern', name: 'Cathedral of the Annunciation of our Lady, Redfern', address: '242 Cleveland St. Redfern N.S.W, 2016' },
  { id: 'antiochian-stnicholas-punchbowl', name: 'St. Nicholas, Punchbowl', address: '11 Henry St, Punchbowl NSW 2196' },
  { id: 'antiochian-stnicholas-bankstown', name: 'St. Nicholas, Bankstown', address: '2a Weigand Ave, Bankstown 2200 NSW, Australia' },
  { id: 'greek-holytrinity-hobart', name: 'Holy Trinity Greek Orthodox Parish of Hobart, Hobart', address: '50 Warwick Street Hobart, TAS 7000' },
  { id: 'greek-stdimitrios-mooneeponds', name: 'St Dimitrios, Moonee Ponds (Ascot Vale)', address: '1 Gladstone St, Moonee Ponds, VIC 3039' },
  { id: '_unassigned', name: 'Unassigned / Unknown Parish', address: 'Sydney NSW' },
];

test('an address is a number and a street, whatever it is called', () => {
  const k = streetKey('86 Kenny Street, Wollongong 2500 NSW, Australia');
  assert.deepEqual([[...k.numbers], k.street, [...k.places]], [['86'], 'kenny st', ['wollongong']]);
  assert.deepEqual([...streetKey('Koondoola Plaza, 8/34 Burbridge Ave, Koondoola, WA 6064').numbers], ['34'], 'unit 8 of number 34');
  assert.deepEqual([...streetKey('2-4 Parsons Ave Springvale, VIC 3171').numbers], ['2', '4']);
  assert.equal(streetKey('45 St Johns Rd').street, 'st johns rd', 'a street called St Johns, not one called St');
  assert.equal(streetKey('75 The Parade St, Island Bay').street, 'the pde');
  assert.equal(streetKey('75 The Parade, Island Bay').street, 'the pde');
  assert.equal(streetKey('Cnr Walker & Cooper Streets, Redfern NSW 2016'), null, 'no number, nothing to compare');
  assert.equal(streetKey('Saint Nicholas St. Coober Pedy, SA 5723'), null);
});

test('two ways of writing one address agree; another number, street or suburb does not', () => {
  assert.ok(sameStreetAddress('86 Kenny St, Wollongong NSW', '86 Kenny Street, Wollongong 2500 NSW, Australia'));
  assert.ok(sameStreetAddress('86 Kenny St', '86 Kenny Street, Wollongong NSW 2500'), 'no suburb is not a disagreement');
  assert.ok(sameStreetAddress('2a Weigand Avenue', '2a Weigand Ave, Bankstown 2200 NSW'));
  assert.ok(sameStreetAddress('12 Parsons Ave', '12-14 Parsons Ave'), 'inside a range at either end');
  assert.ok(!sameStreetAddress('88 Kenny St, Wollongong', '86 Kenny Street, Wollongong'));
  assert.ok(!sameStreetAddress('86 Kenny Rd, Wollongong', '86 Kenny Street, Wollongong'));
  assert.ok(!sameStreetAddress('86 Kenny St, Ryde', '86 Kenny Street, Wollongong'));
  assert.ok(!sameStreetAddress('Church hall', '86 Kenny Street'));
});

test('a venue that only names the parish goes; one that names a room stays', () => {
  const elias = PARISHES[0];
  assert.ok(isOwnVenue('86 Kenny St, Wollongong NSW', elias), 'the card that started this');
  assert.ok(isOwnVenue('St Elias Antiochian Orthodox Church, 86 Kenny St, Wollongong', elias));
  assert.ok(isOwnVenue('86 Kenny Street, Wollongong 2500 NSW, Australia', elias), 'word for word');
  assert.ok(!isOwnVenue('Parish hall, 86 Kenny St', elias), 'a room a visitor has to find');
  assert.ok(!isOwnVenue('Church hall', elias));
  assert.ok(!isOwnVenue('12 Smith St, Wollongong', elias));
  assert.ok(!isOwnVenue('86 Kenny St, Wollongong', PARISHES[6]), 'somebody else’s address is a venue');
  const clayton = { name: 'The Good Shepherd, Clayton', address: 'Religious Centre, 38 Exhibition Walk, Clayton VIC 3168' };
  assert.ok(isOwnVenue('Religious Centre, 38 Exhibition Walk, Clayton', clayton), 'the parish’s own address starts with a name');
  assert.ok(!isOwnVenue('', elias) && !isOwnVenue('86 Kenny St', { name: 'x', address: null }));
});

test('a poster from St Elias, Wollongong is found by its name and its town', () => {
  assert.equal(matchParish({ name: 'St Elias Antiochian Orthodox Church', place: 'Wollongong' }, [], PARISHES),
    'antiochian-stelias-wollongong');
  assert.equal(matchParish({ name: 'St Elias Antiochian Orthodox Church', place: 'Wollongong NSW' },
    ['86 Kenny St, Wollongong NSW'], PARISHES), 'antiochian-stelias-wollongong', 'a state is not a place');
  assert.equal(matchParish({ name: 'St Elias Antiochian Orthodox Church, Wollongong', place: null }, [], PARISHES),
    'antiochian-stelias-wollongong', 'the town inside the name');
  assert.equal(matchParish({ name: 'St Elias', place: null }, ['86 Kenny St'], PARISHES),
    'antiochian-stelias-wollongong', 'the name and the venue’s address');
  assert.equal(matchParish({ name: 'Antiochian Church', place: 'Wollongong' }, ['86 Kenny St'], PARISHES),
    'antiochian-stelias-wollongong', 'the town and the venue’s address');
});

test('one piece of evidence, or a tie, is nobody', () => {
  assert.equal(matchParish({ name: 'St Elias', place: null }, [], PARISHES), null, 'four parishes are Elias');
  assert.equal(matchParish({ name: 'St Nicholas', place: null }, [], PARISHES), null);
  assert.equal(matchParish({ name: 'Greek Orthodox Community', place: 'Redfern' }, [], PARISHES), null, 'two churches in Redfern');
  assert.equal(matchParish({ name: 'St Nicholas', place: 'Wollongong' }, [], PARISHES), null, 'no St Nicholas there');
  assert.equal(matchParish(null, [], PARISHES), null);
  assert.equal(matchParish({ name: '', place: '' }, [], PARISHES), null);
  assert.equal(matchParish({ name: 'Unknown Parish', place: 'Sydney' }, [], PARISHES), null, 'never the unassigned bucket');
});

test('the dedication tells a town’s churches apart; aliases and the name’s own place count', () => {
  assert.equal(matchParish({ name: 'St George Antiochian Orthodox Cathedral', place: 'Redfern' }, [], PARISHES),
    'antiochian-stgeorge-redfern');
  assert.equal(matchParish({ name: 'Annunciation of Our Lady', place: 'Redfern' }, [], PARISHES),
    'greek-annunciation-redfern');
  assert.equal(matchParish({ name: 'Prophet Elias Greek Orthodox Church', place: 'Norwood' }, [], PARISHES),
    'greek-prophetelias-norwood');
  assert.equal(matchParish({ name: 'Holy Trinity Greek Orthodox Parish of Hobart', place: null }, [], PARISHES),
    'greek-holytrinity-hobart');
  assert.equal(matchParish({ name: 'St Dimitrios', place: 'Ascot Vale' }, [], PARISHES), 'greek-stdimitrios-mooneeponds');
});

test('more of the name in common breaks a tie; a title that is the whole name counts', () => {
  const towns = [
    { id: 'holycross', name: 'Holy Cross, Wollongong', address: '1 Smith St, Wollongong NSW' },
    { id: 'holydormition', name: 'Holy Dormition Church, Wollongong', address: '9 Jones St, Wollongong NSW' },
    { id: 'archangels-albury', name: 'The Archangels, Albury', address: '5 Kiewa St, Albury NSW' },
    { id: 'archangels-parkdale', name: 'The Archangels, Parkdale', address: '56 The Corso, Parkdale, VIC 3195' },
    { id: 'twin-a', name: 'St George, Thornbury', address: '1 High St, Thornbury VIC' },
    { id: 'twin-b', name: 'St. George, Thornbury', address: '7 Station St, Thornbury VIC' },
  ];
  assert.equal(matchParish({ name: 'Holy Cross Greek Orthodox Church', place: 'Wollongong' }, [], towns), 'holycross');
  assert.equal(matchParish({ name: 'Church of the Holy Dormition', place: 'Wollongong' }, [], towns), 'holydormition');
  assert.equal(matchParish({ name: 'Church of the Archangels', place: 'Albury' }, [], towns), 'archangels-albury');
  assert.equal(matchParish({ name: 'St George', place: 'Thornbury' }, [], towns), null, 'two of them, as production has');
});
