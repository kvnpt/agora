// Steps 3 and 4 of the pipeline in docs/parish-ingestion.md: diff the geocoded
// ROCOR rows against what production already holds, print the pin list to be
// read, and emit the guarded upsert.
//
// Nothing here is ROCOR-specific except the mapping from a scraped row to a
// parish row. The matching and the SQL come from scripts/parish-import.mjs,
// which is where the lessons of the first directory import live.
//
// WHAT IT REFUSES TO DO. A row whose pin is a suburb centroid is not written
// unless it is asked for explicitly (--include-suburb). `lat` and `lng` are NOT
// NULL, so a parish that did not geocode cannot be inserted at all, and the
// temptation is to drop in the middle of the suburb and move on. That puts a
// marker on a map at a place where there is no church, which is worse than an
// absent parish: the absent one is obviously missing, the wrong one is
// confidently wrong. So they are held back, listed, and left for research.

import { readFile, writeFile } from 'node:fs/promises';
import { reconcile, buildUpsert } from './parish-import.mjs';

const DIRECTORY = 'https://rocor.org.au/2-directories/directory/';
const LIVE = 'https://agora.orthodoxy.au/api/parishes';

// ROCOR serves in Church Slavonic and Russian alongside English. The directory
// does not publish languages, so this is the jurisdiction's answer rather than
// each parish's; `languages` is excluded from the upsert's refreshable columns
// precisely so a person can correct one and no later scrape will undo it.
const LANGUAGES = '["Russian", "English"]';

// The parish row the database wants, from the row the scrape produced.
function toRow(p) {
  // Existing rows read "<dedication>, <suburb>", and reconcile recovers the
  // suburb from that comma on the next import. Keep the shape.
  const dedication = p.name.replace(/\s*,\s*$/, '');
  const name = `${dedication}, ${p.suburb}`;
  // `info_source_type` is a CHECK of 'website' | 'person' | 'import', and only
  // the first means what it says: the parish told us. An address read off
  // orthodox-world.org or off an OSM building is somebody else's record of the
  // parish, which is an import however good it turns out to be.
  const fromOwnSite = !!p.address_source
    && !/orthodox-world\.org|openstreetmap/.test(p.address_source);
  return {
    name,
    jurisdiction: 'russian',
    address: p.address || null,
    lat: p.lat,
    lng: p.lng,
    timezone: p.timezone,
    website: p.website || null,
    phone: null,
    email: null,
    languages: LANGUAGES,
    color: null,
    // The directory publishes no patronal feast, and deriving one from the
    // dedication is a guess that splits on Old versus New Calendar. The schema
    // wants the parish's own answer, so it stays empty until somebody asks.
    feast_day: null,
    info_source_type: fromOwnSite ? 'website' : 'import',
    info_source_ref: p.address_source || DIRECTORY,
    // carried through for the report, stripped before the SQL
    _confidence: p.confidence,
    _suburb: p.suburb,
    _dedication: dedication,
    _via: p.matched_via || null,
    _osm: p.osm || null,
    _note: p.note || null,
  };
}

const strip = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')));

export async function build(geocoded, existing, { includeSuburb = false } = {}) {
  const rows = geocoded.parishes.map(toRow);

  const placed = rows.filter((r) => r.lat != null && r.lng != null);
  const unplaced = rows.filter((r) => r.lat == null || r.lng == null);
  const coarse = placed.filter((r) => r._confidence === 'suburb');
  const writable = includeSuburb ? placed : placed.filter((r) => r._confidence !== 'suburb');

  // reconcile wants {name, suburb, jurisdiction} and hands back the EXISTING id
  // for anything already in the database — never the derived one.
  //
  // It is handed the DEDICATION, not the row's name. The stored name is
  // "<dedication>, <suburb>" and `parishId` appends the suburb itself, so
  // passing the composed name mints the suburb twice whenever it fits inside
  // the length cap: russian-allsaintscroydon-croydon.
  const scraped = writable.map((r) => ({ ...r, name: r._dedication, suburb: r._suburb }));
  const { pinned, fresh, ambiguous } = reconcile(scraped, existing);

  // reconcile spreads each row into a new object, so the name is put back from
  // the fields that travelled with it rather than from the input array.
  const restore = (r) => ({ ...r, name: `${r._dedication}, ${r._suburb}` });

  return {
    rows,
    placed,
    unplaced,
    coarse,
    writable,
    ambiguous,
    pinned: pinned.map(restore),
    fresh: fresh.map(restore),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2] || './rocor-geocoded.json';
  const output = process.argv[3] || './rocor-parishes.sql';
  const includeSuburb = process.argv.includes('--include-suburb');

  const geocoded = JSON.parse(await readFile(input, 'utf8'));
  const res = await fetch(LIVE, { headers: { 'User-Agent': 'agora-parish-import/1.0' } });
  if (!res.ok) throw new Error(`${LIVE} -> HTTP ${res.status}`);
  const body = await res.json();
  const existing = Array.isArray(body) ? body : (body.parishes || []);
  console.log(`production holds ${existing.length} parishes`);

  const { rows, unplaced, coarse, pinned, fresh, ambiguous } =
    await build(geocoded, existing, { includeSuburb });

  console.log(`\nscraped ${rows.length}`);
  const tally = {};
  for (const r of rows) tally[r._confidence] = (tally[r._confidence] || 0) + 1;
  console.log('confidence:', tally);

  if (ambiguous.length) {
    console.log('\nAMBIGUOUS — a person decides these, nothing is written for them:');
    for (const a of ambiguous) console.log(`  ${a.name}  ->  ${a.candidates.join(', ')}`);
  }
  if (pinned.length) {
    console.log('\nALREADY IN THE DATABASE — the existing id is used, not the derived one:');
    for (const p of pinned) {
      const same = p.id === p.derived_id ? '' : `   (derived would have been ${p.derived_id})`;
      console.log(`  ${p.id}  <-  ${p.name}${same}`);
    }
  }
  if (unplaced.length) {
    console.log('\nNOT WRITTEN — no coordinates at all:');
    for (const r of unplaced) console.log(`  ${r.name}`);
  }
  if (coarse.length) {
    console.log(`\n${includeSuburb ? 'WRITTEN AS SUBURB CENTROIDS' : 'NOT WRITTEN — suburb centroid only'}:`);
    for (const r of coarse) console.log(`  ${r.name}`);
  }

  console.log(`\nNEW (${fresh.length}):`);
  for (const f of fresh) {
    console.log(`  ${f.id.padEnd(40)} ${String(f.lat).padStart(11)},${String(f.lng).padEnd(11)}  ${f._confidence.padEnd(8)} ${f.timezone}`);
  }

  const toWrite = [...pinned, ...fresh].map(strip);
  if (!toWrite.length) {
    console.log('\nnothing to write');
  } else {
    await writeFile(output, `${buildUpsert(toWrite)}\n`);
    console.log(`\nwrote ${toWrite.length} statements to ${output}`);
  }
}
