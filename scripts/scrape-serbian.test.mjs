// Reading the one field that says where a parish without a building meets.

import test from 'node:test';
import assert from 'node:assert';
import { venueOf } from './scrape-serbian.mjs';

test('the venue comes out of the Additional Information free text', () => {
  assert.equal(venueOf('Services held at: St John the Baptist Greek Orthodox Church'),
    'St John the Baptist Greek Orthodox Church');
  assert.equal(venueOf('Services held at Clontarf College Chapel'),
    'Clontarf College Chapel');
  // Both halves in one field, which is how Waterford publishes it.
  assert.equal(venueOf('Services held at Clontarf College Chapel - Postal address: c/o 45 Jacaranda Drive, Ballajura'),
    'Clontarf College Chapel');
  // A website line is not a venue.
  assert.equal(venueOf('Website: www.lazarica.org.au'), null);
  assert.equal(venueOf('PO Box 115, Blacktown NSW 2148'), null);
  assert.equal(venueOf(''), null);
});
