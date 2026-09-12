// Step 2 of the pipeline in docs/parish-ingestion.md: turn scraped Antiochian
// rows into rows that can be written — a pin, an address and a timezone.
//
// HOW THIS DIFFERS FROM THE ROCOR RUN. That diocese publishes no addresses at
// all, so the whole job was finding them. The Antiochian Archdiocese publishes
// a street address for 23 of its 24 places of worship, which changes the
// tiering: the address is the jurisdiction's own assertion and is trusted, and
// OSM is used to UPGRADE a street-level geocode to the building itself rather
// than to discover where a parish is.
//
//   1. Nominatim for the SUBURB, which it knows reliably. This is where the
//      timezone comes from — never the directory's own state heading.
//   2. One Overpass query for every antiochian-denomination place of worship in
//      Oceania, matched on the dedication. Each building is claimed once.
//   3. Nominatim by NAME, which the brief puts first for good reason: asked for
//      "St George Antiochian Orthodox Cathedral Redfern" it returns the church
//      building itself, where the parish's own address — a street corner —
//      returns nothing at all.
//   4. The published address, handed to Nominatim STRUCTURED — the Greek run
//      showed free-form loses house-number ranges and reads "St" as Saint.
//   5. The published address free-form.
//   6. A "Cnr A & B" corner, resolved from the two streets it names.
//   7. The suburb centroid, marked as such.
//
// The order matters in one specific way: a building tagged antiochian_orthodox
// beats a street geocode, because a street geocode lands at the wrong end of a
// long street — that error put one Blacktown parish 730m from its church.

import { readFile, writeFile } from 'node:fs/promises';
import { geocodeAll as geocodeParishes, report, matcher, addressParts, cornerStreets } from './geocode-parish.mjs';

// The seven tiers above now live in scripts/geocode-parish.mjs, because the
// Serbian directory needed all of them with one word changed. Nothing about
// them was Antiochian except the denomination; what stays here is this file's
// account of what THIS run cost, which is the part that is not reusable.
export { addressParts, cornerStreets };
export const { pickBuilding, nameHitIsSound } = matcher('antiochian');

export const geocodeAll = (scraped, cacheDir, log = () => {}) =>
  geocodeParishes(scraped, cacheDir, log, { jurisdiction: 'antiochian' });

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2] || './antiochian-scraped.json';
  const cacheDir = process.argv[3] || './cache/geo-antiochian';
  const output = process.argv[4] || './antiochian-geocoded.json';

  const scraped = JSON.parse(await readFile(input, 'utf8'));
  console.log(`geocoding ${scraped.parishes.length} places of worship\n`);
  const rows = await geocodeAll(scraped, cacheDir, (m) => console.log(m));
  report(rows);

  await writeFile(output, JSON.stringify({ ...scraped, geocoded_at: new Date().toISOString(), parishes: rows }, null, 1));
  console.log(`\nwrote ${output}`);
}
