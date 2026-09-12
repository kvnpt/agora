// Steps 3 and 4 of the pipeline in docs/parish-ingestion.md: diff the geocoded
// Antiochian rows against what production already holds, print the pin list to
// be read, and emit the guarded upsert.
//
// Nothing here is Antiochian-specific except the mapping from a scraped row to
// a parish row. The matching and the SQL come from scripts/parish-import.mjs,
// which is where the lessons of the first directory import live.
//
// THIS RUN IS MOSTLY AN UPDATE, which the ROCOR one was not. Nine Antiochian
// rows were seeded by hand long before any scraping, and `reconcile` exists
// precisely because one of them is
//
//     antiochian-good-shepherd-antiochian-church   "The Good Shepherd, Clayton"
//
// — hyphenated inside its name, naming its jurisdiction twice, and not
// containing its suburb. No rule derives that. Trusting derivation inserts a
// SECOND Good Shepherd, and because the Google Calendar adapter names the old
// id, every event stays on the old row while an empty duplicate appears beside
// it. So the pin list below is the thing to read before anything is written.
//
// WHAT IT REFUSES TO DO. A row pinned only to a locality centroid is not
// written unless asked for explicitly (--include-suburb). `lat` and `lng` are
// NOT NULL, so the temptation is to drop a marker in the middle of the suburb
// and move on; that puts a pin where there is no church, which is worse than an
// absent parish, because the absent one is obviously missing.

import { readFile, writeFile } from 'node:fs/promises';
import { reconcile, buildUpsert } from './parish-import.mjs';

const LIVE = 'https://agora.orthodoxy.au/api/parishes';
const SOURCE_NAME = 'Antiochian Orthodox Archdiocese of Australia, New Zealand and the Philippines';

/**
 * The parish row the database wants, from the row the scrape produced.
 *
 * `info_source_type` is 'import', not 'website', and that is deliberate even
 * though antiochian.org.au belongs to the jurisdiction itself. The brief is
 * explicit — "a directory scrape is 'import'" — and the distinction it protects
 * is real: 'website' asserts the parish told us, and what actually happened is
 * that Archdiocese staff maintain a directory page about the parish. The 135
 * Greek rows in production record their own archdiocese's directory the same
 * way. `info_source_ref` is each parish's OWN page rather than the directory
 * index, so a row points at the page its address actually came from.
 */
function toRow(p) {
  // The directory already names every entry "<dedication>, <suburb>", so the
  // suburb has to come OFF before it is put back on — otherwise the stored name
  // reads "St. Mary's, Mays Hill, Mays Hill".
  //
  // It is put back using the RESOLVED suburb rather than the directory's own
  // word, and that matters beyond tidiness: `reconcile` recovers a parish's
  // suburb from the comma in its stored name, so a row named "Melbourne North"
  // whose id says `kalkallo` would fail to match itself on the next import and
  // mint a duplicate. Name and id have to agree about where the parish is.
  let dedication = p.name.replace(/\s*,\s*$/, '').replace(/\s{2,}/g, ' ').trim();
  if (p.directory_suburb) {
    dedication = dedication.replace(new RegExp(`\\s*,\\s*${p.directory_suburb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '').trim();
  }
  const feast = Object.entries(p.sections || {})
    .find(([h]) => /patron.*feast|feast.*day/i.test(h))?.[1];
  return {
    name: `${dedication}, ${p.suburb}`,
    jurisdiction: 'antiochian',
    address: p.address || null,
    lat: p.lat,
    lng: p.lng,
    timezone: p.timezone,
    website: p.website || null,
    phone: p.phone || null,
    email: p.email || null,
    // Published per parish, unlike either previous jurisdiction — so this is
    // each parish's own answer rather than a label applied to all of them.
    // `languages` is excluded from the upsert's refreshable columns, so it only
    // ever lands on an insert and a person's correction is never undone.
    // Spaced to match the 172 rows already in the table — `["Greek", "English"]`.
    languages: p.languages ? JSON.stringify(p.languages).replace(/","/g, '", "') : null,
    color: null,
    // Kept as the parish words it. "St George day – April / May ( depending on
    // Easter )" is not a date and normalising it would invent one.
    feast_day: feast ? feast.split('\n')[0].replace(/\s+/g, ' ').trim() : null,
    info_source_type: 'import',
    info_source_ref: p.source_ref,
    info_source_name: SOURCE_NAME,
    // carried for the report, stripped before the SQL
    _confidence: p.confidence,
    _suburb: p.suburb,
    _dedication: dedication,
    _via: p.matched_via || null,
    _osm: p.osm || null,
    _note: p.note || null,
  };
}

const strip = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')));

// Two URLs for the same site. The stored https://www.example.org/ and a
// directory's http://example.org are the same parish website, and the stored
// one is the better form.
const sameSite = (a, b) => !!a && !!b
  && a.replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').toLowerCase()
  === b.replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').toLowerCase();

/**
 * Merge a scraped row onto the row already in the database.
 *
 * A scrape that found nothing must not ERASE something. The directory does not
 * link every parish's own site — it links some by mailto and some not at all —
 * so writing the scraped value straight through would blank seven working
 * websites and downgrade three more from https to http. The upsert's whole
 * purpose is to refresh what nobody has checked, not to lose what is known, so
 * a null from the scrape defers to what is there and a URL that differs only by
 * scheme or `www.` leaves the stored form alone.
 */
function mergeWithExisting(row, was) {
  if (!was) return row;
  const out = { ...row };
  for (const f of ['website', 'phone', 'email', 'feast_day']) {
    if (out[f] == null && was[f] != null) out[f] = was[f];
  }
  if (sameSite(out.website, was.website)) out.website = was.website;
  return out;
}

const km = (a, b) => {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lng - a.lng) * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
};

export async function build(geocoded, existing, { includeSuburb = false } = {}) {
  const rows = geocoded.parishes.map(toRow);

  const placed = rows.filter((r) => r.lat != null && r.lng != null);
  const unplaced = rows.filter((r) => r.lat == null || r.lng == null);
  const coarse = placed.filter((r) => r._confidence === 'suburb');
  const writable = includeSuburb ? placed : placed.filter((r) => r._confidence !== 'suburb');

  // reconcile is handed the DEDICATION, not the composed name: the stored name
  // is "<dedication>, <suburb>" and parishId appends the suburb itself, so
  // passing the whole thing mints the suburb twice.
  const scraped = writable.map((r) => ({ ...r, name: r._dedication, suburb: r._suburb }));
  const { pinned, fresh, ambiguous } = reconcile(scraped, existing);
  const byId = new Map(existing.map((e) => [e.id, e]));
  const restore = (r) => ({ ...r, name: `${r._dedication}, ${r._suburb}` });

  return {
    rows, placed, unplaced, coarse, writable, ambiguous,
    pinned: pinned.map((r) => mergeWithExisting(restore(r), byId.get(r.id))),
    fresh: fresh.map(restore),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2] || './antiochian-geocoded.json';
  const output = process.argv[3] || './antiochian-parishes.sql';
  const includeSuburb = process.argv.includes('--include-suburb');

  const geocoded = JSON.parse(await readFile(input, 'utf8'));
  const res = await fetch(LIVE, { headers: { 'User-Agent': 'agora-parish-import/1.0' } });
  if (!res.ok) throw new Error(`${LIVE} -> HTTP ${res.status}`);
  const body = await res.json();
  const existing = Array.isArray(body) ? body : (body.parishes || []);
  console.log(`production holds ${existing.length} parishes, ${existing.filter((e) => e.jurisdiction === 'antiochian').length} of them Antiochian`);

  const { rows, unplaced, coarse, pinned, fresh, ambiguous } =
    await build(geocoded, existing, { includeSuburb });

  const tally = {};
  for (const r of rows) tally[r._confidence] = (tally[r._confidence] || 0) + 1;
  console.log(`\nscraped ${rows.length} — confidence:`, tally);

  if (ambiguous.length) {
    console.log('\nAMBIGUOUS — a person decides these, nothing is written for them:');
    for (const a of ambiguous) console.log(`  ${a.name}  ->  ${a.candidates.join(', ')}`);
  }

  if (pinned.length) {
    console.log('\nALREADY IN THE DATABASE — the EXISTING id is used, never the derived one:');
    for (const p of pinned) {
      const same = p.id === p.derived_id ? '' : `\n        derivation would have minted ${p.derived_id} and inserted a duplicate`;
      console.log(`  ${p.id}  <-  ${p.name}${same}`);
    }
    console.log('\nWHAT CHANGES ON THOSE ROWS:');
    for (const p of pinned) {
      const was = existing.find((e) => e.id === p.id);
      if (!was) continue;
      const diffs = [];
      const moved = km({ lat: was.lat, lng: was.lng }, { lat: p.lat, lng: p.lng });
      if (moved > 0.02) diffs.push(`pin moves ${(moved * 1000).toFixed(0)}m (${p._confidence}, ${p._via})`);
      for (const f of ['name', 'address', 'website', 'phone', 'email', 'feast_day', 'timezone',
        'info_source_type', 'info_source_name']) {
        const a = was[f] ?? null; const b = p[f] ?? null;
        if (String(a ?? '') !== String(b ?? '')) diffs.push(`${f}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
      }
      if (diffs.length) console.log(`  ${p.id}\n      ${diffs.join('\n      ')}`);
      else console.log(`  ${p.id}  (no change)`);
    }
  }

  if (unplaced.length) {
    console.log('\nNOT WRITTEN — no coordinates at all:');
    for (const r of unplaced) console.log(`  ${r.name}  (${r._note || 'no reason recorded'})`);
  }
  if (coarse.length) {
    console.log(`\n${includeSuburb ? 'WRITTEN AS LOCALITY CENTROIDS — there is no church at these pins' : 'NOT WRITTEN — locality centroid only'}:`);
    for (const r of coarse) console.log(`  ${r.name}\n      ${r._note}`);
  }

  console.log(`\nNEW (${fresh.length}):`);
  for (const f of fresh) {
    console.log(`  ${f.id.padEnd(42)} ${String(f.lat).padStart(11)},${String(f.lng).padEnd(11)} ${f._confidence.padEnd(8)} ${f.timezone}`);
  }

  const toWrite = [...pinned, ...fresh].map(strip);
  if (!toWrite.length) {
    console.log('\nnothing to write');
  } else {
    await writeFile(output, `${buildUpsert(toWrite)}\n`);
    console.log(`\nwrote ${toWrite.length} statements to ${output}`);
  }
}
