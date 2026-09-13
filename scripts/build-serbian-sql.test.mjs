// A re-run must not walk a pin backwards.
//
// Six of the 49 Serbian parishes were placed by hand after the import — two
// street spellings the directory got wrong, and four that meet in another
// parish's church. `lat` and `lng` are refreshable, so a second run offering
// only a locality centroid would overwrite all six with the middle of a suburb
// where there is no church.

import test from 'node:test';
import assert from 'node:assert';
import { build } from './build-serbian-sql.mjs';

const scraped = (over = {}) => ({
  scraped_at: '2026-09-13T00:00:00Z',
  parishes: [{
    name: 'Nativity of the Most Holy Theotokos Skete',
    suburb: 'Inglewood', state: 'South Australia', state_abbr: 'SA',
    country: 'Australia', slug: 'skete', kind: 'monastery',
    directory_title: 'NATIVITY … SERBIAN ORTHODOX',
    lat: -34.8237, lng: 138.7746, timezone: 'Australia/Adelaide',
    confidence: 'suburb', address: null, source_ref: 'https://soc.org.au/monastery/x/',
    ...over,
  }],
});

const ONFILE = {
  id: 'serbian-nativity-inglewood',
  name: 'Nativity of the Most Holy Theotokos Skete, Inglewood',
  jurisdiction: 'serbian',
  address: '61 Chapman Rd, Inglewood SA 5133',
  lat: -34.8181513, lng: 138.7821139,
};

test('a centroid does not replace a pin somebody worked out', async () => {
  const { pinned } = await build(scraped(), [ONFILE], { includeSuburb: true });
  assert.equal(pinned.length, 1);
  assert.equal(pinned[0].lat, ONFILE.lat);
  assert.equal(pinned[0].lng, ONFILE.lng);
  assert.equal(pinned[0].address, ONFILE.address);
  assert.match(pinned[0]._note, /kept the pin already on file/);
});

test('but a real address found on the re-run does replace it', async () => {
  const better = scraped({ confidence: 'building', lat: -34.81, lng: 138.78,
    address: '61 Chapman Rd, Inglewood SA 5133' });
  const { pinned } = await build(better, [ONFILE], {});
  assert.equal(pinned[0].lat, -34.81);
  assert.doesNotMatch(pinned[0]._note || '', /kept the pin/);
});

test('a row with no address on file is not protected — that is the unchecked mark', async () => {
  // Moree and Mawson are centroids with a NULL address on purpose. A later run
  // that can place them properly must be free to.
  const centroidOnFile = { ...ONFILE, address: null };
  const { pinned } = await build(scraped(), [centroidOnFile], { includeSuburb: true });
  assert.equal(pinned[0].lat, -34.8237);
});
