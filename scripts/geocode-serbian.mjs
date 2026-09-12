// Step 2 of the pipeline in docs/parish-ingestion.md, for the Serbian
// Metropolitanate: turn scraped rows into rows that can be written — a pin, an
// address and a timezone.
//
// The seven tiers are scripts/geocode-parish.mjs and are shared with the
// Antiochian run. What is worth saying here is what this directory brings to
// them:
//
// FIVE ST SAVAS, FOUR ST NICHOLASES, THREE ST BASILS OF OSTROG. The titles
// carry no suburb at all, so the dedication alone identifies nothing and the
// 20km guard around the suburb centroid is doing real work — it is the only
// thing stopping Melbourne's St Sava claiming Geelong's building.
//
// AND THE NEIGHBOURS SHARE THEM. Brisbane's Russian and Serbian St Nicholas
// are 500m apart and OSM tags the Serbian one `greek_orthodox`; Blacktown has
// a Serbian St Nicholas and a Russian Archangel Michael. The refusal of any
// candidate naming another jurisdiction is not a precaution here, it is the
// difference between a right and a wrong pin.
//
// FOUR PO BOXES. Cairns, Canberra, Mawson and Moree publish a postal address
// and nothing else. The scrape marks those `address_vague`, so they reach the
// geocoder as a name and a suburb — which is the tier that finds churches
// anyway — and are held back rather than pinned to a post office if that
// fails.

import { readFile, writeFile } from 'node:fs/promises';
import { geocodeAll as geocodeParishes, report } from './geocode-parish.mjs';

export const geocodeAll = (scraped, cacheDir, log = () => {}) =>
  geocodeParishes(scraped, cacheDir, log, { jurisdiction: 'serbian' });

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2] || './serbian-scraped.json';
  const cacheDir = process.argv[3] || './cache/geo-serbian';
  const output = process.argv[4] || './serbian-geocoded.json';

  const scraped = JSON.parse(await readFile(input, 'utf8'));
  console.log(`geocoding ${scraped.parishes.length} places of worship\n`);
  const rows = await geocodeAll(scraped, cacheDir, (m) => console.log(m));
  report(rows);

  await writeFile(output, JSON.stringify({ ...scraped, geocoded_at: new Date().toISOString(), parishes: rows }, null, 1));
  console.log(`\nwrote ${output}`);
}
