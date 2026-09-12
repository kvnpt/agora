// The jurisdiction-independent half of a parish geocode.
//
// Every case below is a real one. The Tweed Heads result is what Nominatim
// actually returned when the query was constrained to the state the ROCOR
// directory files that parish under, and taking it would have put every service
// there an hour out for half the year. The Blacktown council boundary is what
// cost a Russian parish a 5.3km pin. The ACT case is the one that produced a
// row with no timezone at all.

import test from 'node:test';
import assert from 'node:assert';
import {
  zoneFor, km, placeKey, preferLocality, centreOf, osmAddress,
} from './geocode-common.mjs';

test('the timezone comes from the ISO subdivision, not the state name', () => {
  assert.equal(zoneFor({ country_code: 'au', 'ISO3166-2-lvl4': 'AU-QLD', state: 'Queensland' }),
    'Australia/Brisbane');
  assert.equal(zoneFor({ country_code: 'au', 'ISO3166-2-lvl4': 'AU-WA' }), 'Australia/Perth');
  // Tweed Heads is in NSW however the directory files it, and NSW keeps DST.
  assert.equal(zoneFor({ country_code: 'au', 'ISO3166-2-lvl4': 'AU-NSW' }), 'Australia/Sydney');
});

test('the ACT arrives under territory and still gets a zone', () => {
  // Nominatim returns Canberra with no `state` key at all; reading state left
  // the parish there with `timezone: null`.
  assert.equal(zoneFor({ country_code: 'au', 'ISO3166-2-lvl4': 'AU-ACT', territory: 'Australian Capital Territory' }),
    'Australia/Sydney');
  assert.equal(zoneFor({ country_code: 'au', territory: 'Australian Capital Territory' }),
    'Australia/Sydney');
});

test('every New Zealand region is Pacific/Auckland', () => {
  assert.equal(zoneFor({ country_code: 'nz', 'ISO3166-2-lvl4': 'NZ-OTA' }), 'Pacific/Auckland');
  assert.equal(zoneFor({ country_code: 'nz', 'ISO3166-2-lvl4': 'NZ-WGN' }), 'Pacific/Auckland');
  assert.equal(zoneFor({ country_code: 'NZ' }), 'Pacific/Auckland');
});

test('an unknown place gets no timezone rather than a default', () => {
  // Australia/Sydney is the column default and is wrong for most of the
  // continent, so a geocode that cannot answer must say so.
  assert.equal(zoneFor({ country_code: 'au' }), null);
  assert.equal(zoneFor(null), null);
});

test('a locality is compared as a sorted set of words', () => {
  assert.equal(placeKey('East Brunswick'), placeKey('Brunswick East'));
  assert.equal(placeKey('Mays Hill'), placeKey('mays  hill'));
  assert.notEqual(placeKey('North Tamworth'), placeKey('Tamworth'));
});

test('a locality result that names something else is no result', () => {
  // Constrained to Queensland, "Tweed Heads" answers with a street 80km away.
  const wrong = [{
    class: 'highway', type: 'residential', addresstype: 'road',
    display_name: 'Tweed Heads Avenue, North Tamborine, Queensland, Australia',
    lat: '-27.93', lon: '153.20',
  }];
  assert.equal(preferLocality(wrong, 'Tweed Heads'), null);
});

test('a populated place beats the council that contains it', () => {
  // "Blacktown" returns Blacktown City Council's centroid, 5.3km from the church.
  const results = [
    {
      class: 'boundary', type: 'administrative', addresstype: 'city_council',
      display_name: 'Blacktown City Council, New South Wales, Australia', lat: '-33.75', lon: '150.85',
    },
    {
      class: 'place', type: 'suburb', addresstype: 'suburb',
      display_name: 'Blacktown, Sydney, New South Wales, Australia', lat: '-33.7688', lon: '150.9063',
    },
  ];
  assert.equal(preferLocality(results, 'Blacktown').lat, '-33.7688');
});

test('distance is great-circle kilometres', () => {
  assert.equal(Math.round(km({ lat: -33.87, lng: 151.21 }, { lat: -37.81, lng: 144.96 })), 713);
  assert.equal(km({ lat: -33.87, lng: 151.21 }, { lat: -33.87, lng: 151.21 }), 0);
});

test('a way with a centre and a bare node both yield a point', () => {
  assert.deepEqual(centreOf({ type: 'way', center: { lat: -33.8, lon: 151.2 } }), { lat: -33.8, lon: 151.2 });
  assert.deepEqual(centreOf({ type: 'node', lat: -33.8, lon: 151.2 }), { lat: -33.8, lon: 151.2 });
  assert.equal(centreOf({ type: 'way' }), null);
  assert.equal(centreOf(null), null);
});

test('an OSM building with no address tags has no address', () => {
  assert.equal(osmAddress({ name: 'St Elias Orthodox Church' }), null);
  assert.equal(osmAddress({
    'addr:housenumber': '86', 'addr:street': 'Kenny Street',
    'addr:city': 'Wollongong', 'addr:state': 'NSW', 'addr:postcode': '2500',
  }), '86 Kenny Street, Wollongong NSW 2500');
});
