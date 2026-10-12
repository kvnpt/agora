// public/shared/venue-picker.js — the parts that are not the DOM: which of the
// three answers a stored place is, and the suburb a list row shows.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { modeOf, suburbOf, EMPTY } = require('../public/shared/venue-picker.js');

test('a stored place reads back as the answer that wrote it', () => {
  assert.equal(modeOf(EMPTY), 'home');
  assert.equal(modeOf({ ...EMPTY, location_parish_id: 'x' }), 'parish');
  assert.equal(modeOf({ ...EMPTY, location_override: 'The hall' }), 'custom');
  // A pin with no words yet is still a place of its own, not home.
  assert.equal(modeOf({ ...EMPTY, location_lat: -33.9, location_lng: 151.1 }), 'custom');
});

test('the suburb is the last part of an address that is a place', () => {
  assert.equal(suburbOf('12/14 Balmoral Ave, Croydon Park, NSW 2133'), 'Croydon Park');
  assert.equal(suburbOf('34 Gt Buckingham St, Surry Hills NSW 2010'), 'Surry Hills');
  assert.equal(suburbOf('5 X St, Brunswick VIC 3056, Australia'), 'Brunswick');
  assert.equal(suburbOf('1 Main Rd, Wellington, New Zealand'), 'Wellington');
  // Nothing to say rather than a state or a street number.
  assert.equal(suburbOf('360 Abercrombie St'), '');
  assert.equal(suburbOf(''), '');
  assert.equal(suburbOf(null), '');
});
