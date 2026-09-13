// Reading "Services held at: …", and turning it into a pin.
//
// A parish's address is where you turn up, because Agora answers "which parish
// is near me and when is the service". A PO box is not that; nor is the postal
// address of a parish that meets somewhere else. Four of the 49 Serbian
// entries say where they meet in a free-text field, and two of them meet in
// churches this database already holds.

import test from 'node:test';
import assert from 'node:assert';
import { venueMatcher, venueAddress, expandSynonyms } from './geocode-parish.mjs';

// The four venue lines the Serbian directory actually publishes.
const REDLYNCH = { id: 'greek-stjohnforerunner-redlynch', jurisdiction: 'greek',
  name: 'St. John the Baptist, Redlynch', lat: -16.885786, lng: 145.7001384,
  address: 'Cnr Kamerunga & Fairweather Rds, Redlynch (Cairns), QLD 4870' };
const SYDENHAM = { id: 'russian-stnicholas-sydenham', jurisdiction: 'russian',
  name: 'St. Nicholas Church, Sydenham', lat: -43.547292, lng: 172.639602,
  address: '297 Brougham St, Sydenham, Canterbury, 8023 New Zealand' };
const NEWTOWN = { id: 'russian-exaltationholy-newtown', jurisdiction: 'russian',
  name: 'Exaltation of the Holy Cross Church, New Town', lat: -42.867283, lng: 147.310054,
  address: '3 Augusta Rd, New Town, Tasmania, TAS 7008 Australia' };
// The Serbian rows themselves, present because a re-run reads a table this
// import has already been written to.
const SELF_HOBART = { id: 'serbian-holycross-lenahvalley', jurisdiction: 'serbian',
  name: 'Holy Cross, Lenah Valley', lat: -42.8673, lng: 147.3101 };
const SELF_CAIRNS = { id: 'serbian-stelijahprophet-redlynch', jurisdiction: 'serbian',
  name: 'St Elijah the Prophet, Redlynch', lat: -16.8858, lng: 145.7001 };

const match = venueMatcher([REDLYNCH, SYDENHAM, NEWTOWN, SELF_HOBART, SELF_CAIRNS], 'serbian');

test('a venue naming another jurisdiction is the right answer, not the wrong one', () => {
  // The dedication matcher refuses a foreign denomination outright — Brisbane's
  // Serbian and Russian St Nicholas are 500m apart. Here it is the point.
  const cairns = match('St John the Baptist Greek Orthodox Church',
    { lat: -16.9207, lng: 145.7722 }, 20);
  assert.equal(cairns.id, 'greek-stjohnforerunner-redlynch');

  const chch = match('St Nicholas Russian Orthodox Church',
    { lat: -43.5320, lng: 172.6306 }, 20);
  assert.equal(chch.id, 'russian-stnicholas-sydenham');
});

test('one letter is not a different church', () => {
  // The Serbian directory writes Exultation; everyone else writes Exaltation.
  const hobart = match('Exultation of the Holy Cross Russian-Serbian Orthodox Church',
    { lat: -42.8700, lng: 147.2900 }, 20);
  assert.equal(hobart.id, 'russian-exaltationholy-newtown');
});

test('a parish cannot be its own venue', () => {
  // serbian-holycross-lenahvalley is in the table on a re-run and its
  // dedication matches the host's to within that one letter. Excluding the
  // importing jurisdiction is what decides which of the two is the host.
  const hits = venueMatcher([NEWTOWN, SELF_HOBART], 'serbian');
  assert.equal(hits('Exultation of the Holy Cross Russian-Serbian Orthodox Church',
    { lat: -42.8700, lng: 147.2900 }, 20).id, 'russian-exaltationholy-newtown');
  // ...and with no host in the table, nothing rather than itself.
  const alone = venueMatcher([SELF_HOBART], 'serbian');
  assert.equal(alone('Exultation of the Holy Cross Russian-Serbian Orthodox Church',
    { lat: -42.8700, lng: 147.2900 }, 20), null);
});

test('a St Nicholas in another city is not this parish\'s venue', () => {
  assert.equal(match('St Nicholas Russian Orthodox Church',
    { lat: -33.8688, lng: 151.2093 }, 20), null);   // Sydney
});

test('the jurisdiction named in the venue is required of the candidate', () => {
  // There is a St John the Baptist in this table, but it is Greek — so a venue
  // that says RUSSIAN must not match it.
  assert.equal(match('St John the Baptist Russian Orthodox Church',
    { lat: -16.9207, lng: 145.7722 }, 20), null);
});

test('two equally good candidates are a question for a person', () => {
  const twin = { ...SYDENHAM, id: 'russian-stnicholas-twin', name: 'St. Nicholas Church, Elsewhere' };
  const ambiguous = venueMatcher([SYDENHAM, twin], 'serbian');
  assert.equal(ambiguous('St Nicholas Russian Orthodox Church',
    { lat: -43.5320, lng: 172.6306 }, 20), null);
});

test('the stored address names the venue, then where it is', () => {
  assert.equal(
    venueAddress('Clontarf College Chapel', {
      address: { house_number: '12', road: 'Clonmel Mews', suburb: 'Waterford',
        state: 'Western Australia', postcode: '6152' },
    }),
    'Clontarf College Chapel, 12 Clonmel Mews, Waterford, Western Australia 6152');
  // A result with no structured address still gives the venue's own name.
  assert.equal(venueAddress('Clontarf College Chapel', {}), 'Clontarf College Chapel');
});

test('synonyms widen both matchers the same way', () => {
  // Tokens reach here with a trailing "s" already stripped — "St Mary's" and
  // "St Mary" have to compare equal — so the groups are stripped the same way
  // on the way in and "cross" is "cros" on both sides. Ugly, symmetrical, and
  // the reason to pin it: an expansion that stripped only one side would fail
  // silently, as a dedication that simply never matched.
  assert.ok(expandSynonyms(new Set(['cros'])).has('exaltation'));
  assert.ok(expandSynonyms(new Set(['petka'])).has('paraskeva'));
  assert.ok(!expandSynonyms(new Set(['nichola'])).has('sava'));
});
