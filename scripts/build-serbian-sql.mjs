// Steps 3 and 4 of the pipeline in docs/parish-ingestion.md: diff the geocoded
// Serbian rows against what production already holds, print the pin list to be
// read, and emit the guarded upsert.
//
// Nothing here is Serbian-specific except the mapping from a scraped row to a
// parish row. The matching and the SQL come from scripts/parish-import.mjs,
// which is where the lessons of the earlier directory imports live.
//
// THIS RUN IS ENTIRELY NEW. Production holds no Serbian parish at all, so
// `reconcile` has nothing to pin and every row is an insert — which makes the
// id derivation the thing to read rather than the pin list. Five parishes are
// called St Sava and four St Nicholas, and the ids that separate them are
// their suburbs: `serbian-stsava-highgate` against `serbian-stsava-hindmarsh`.
// A row whose suburb is wrong is a row that will collide with its own
// jurisdiction the next time this runs.
//
// WHAT IT REFUSES TO DO. A row pinned only to a locality centroid is not
// written unless asked for explicitly (--include-suburb). `lat` and `lng` are
// NOT NULL, so the temptation is to drop a marker in the middle of the suburb
// and move on; that puts a pin where there is no church, which is worse than
// an absent parish, because the absent one is obviously missing.

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { reconcile, buildUpsert } from './parish-import.mjs';

const require = createRequire(import.meta.url);
const { jurisdictionColor } = require('../public/shared/jurisdiction-colors.js');

const LIVE = 'https://agora.orthodoxy.au/api/parishes';

// What to CALL the source. Short, because the parish sheet renders it in a
// line of 11px muted text — "Updated 3 months ago · Serbian Metropolitanate" —
// beside the same source's service times. The Antiochian import's 74-character
// official title had to be cut back in migration 005; this one starts short.
const SOURCE_NAME = 'Serbian Metropolitanate';

// The jurisdiction's answer rather than each parish's: the directory does not
// publish languages. `languages` is excluded from the upsert's refreshable
// columns precisely so a person can correct one and no later scrape undoes it.
const LANGUAGES = '["Serbian", "English"]';

/**
 * The parish row the database wants, from the row the scrape produced.
 *
 * `info_source_type` is 'import', not 'website', and that is deliberate even
 * though soc.org.au belongs to the Metropolitanate itself. The brief is
 * explicit — "a directory scrape is 'import'" — and the distinction it protects
 * is real: 'website' asserts the parish told us, and what actually happened is
 * that Metropolitanate staff maintain a directory page about the parish.
 * `info_source_ref` is each parish's OWN page rather than the directory index,
 * so a row points at the page its address actually came from.
 */
function toRow(p, checkedAt) {
  return {
    name: `${p.name}, ${p.suburb}`,
    full_name: p.full_name || null,
    jurisdiction: 'serbian',
    // A centroid row's address is already null — see geocode-parish.mjs on why
    // an absent address is the only mark the schema has for an unchecked pin.
    address: p.address || null,
    lat: p.lat,
    lng: p.lng,
    timezone: p.timezone,
    website: p.website || null,
    phone: p.phone || null,
    email: p.email || null,
    // One parish is not Serbian-language at all: St Ignatius of Antioch and St
    // Aidan of Lindisfarne, Wendouree, is the Metropolitanate's Western Rite
    // parish and is the only entry in the directory whose title omits the word
    // "Serbian". Giving it the jurisdiction's languages would be the one place
    // a jurisdiction-wide answer is demonstrably wrong.
    languages: /serbian/i.test(p.directory_title || '') ? LANGUAGES : '["English"]',
    // Migration 004 had to paint 51 imported parishes after the fact because
    // the two previous imports wrote null here, on the reasoning that a colour
    // is a person's choice. It is — but the jurisdiction's colour is the
    // baseline every card already draws, and a row without one falls back to
    // grey. `color` is not refreshable, so this lands on the insert and a
    // later per-parish choice is never overwritten by a re-run.
    color: jurisdictionColor('serbian'),
    // The directory publishes no patronal feast, and deriving one from the
    // dedication is a guess that splits on Old versus New Calendar.
    feast_day: null,
    info_source_type: 'import',
    info_source_ref: p.source_ref,
    info_source_name: SOURCE_NAME,
    // When the directory was READ — the scrape's own timestamp, not this
    // build's. Re-running the builder does not make the pages any fresher.
    info_checked_at: checkedAt || null,
    // carried for the report, stripped before the SQL
    _confidence: p.confidence,
    _suburb: p.suburb,
    _dedication: p.name,
    _via: p.matched_via || null,
    _osm: p.osm || null,
    _note: p.note || null,
    _kind: p.kind,
  };
}

const strip = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_')));

// Two URLs for the same site. The stored https://www.example.org/ and a
// directory's http://example.org are the same parish website, and the stored
// one is the better form.
const sameSite = (a, b) => !!a && !!b
  && a.replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').toLowerCase()
  === b.replace(/^https?:\/\/(www\.)?/, '').replace(/\/+$/, '').toLowerCase();

// A scrape that found nothing must not ERASE something. Only relevant on a
// re-run; production holds no Serbian row today.
function mergeWithExisting(row, was) {
  if (!was) return row;
  const out = { ...row };
  for (const f of ['website', 'phone', 'email', 'feast_day', 'address']) {
    if (out[f] == null && was[f] != null) out[f] = was[f];
  }
  if (sameSite(out.website, was.website)) out.website = was.website;
  return out;
}

export async function build(geocoded, existing, { includeSuburb = false } = {}) {
  const rows = geocoded.parishes.map((p) => toRow(p, geocoded.scraped_at));

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
  const input = process.argv[2] || './serbian-geocoded.json';
  const output = process.argv[3] || './serbian-parishes.sql';
  const includeSuburb = process.argv.includes('--include-suburb');

  const geocoded = JSON.parse(await readFile(input, 'utf8'));
  const res = await fetch(LIVE, { headers: { 'User-Agent': 'agora-parish-import/1.0' } });
  if (!res.ok) throw new Error(`${LIVE} -> HTTP ${res.status}`);
  const body = await res.json();
  const existing = Array.isArray(body) ? body : (body.parishes || []);
  console.log(`production holds ${existing.length} parishes, ${existing.filter((e) => e.jurisdiction === 'serbian').length} of them Serbian`);

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
      const same = p.id === p.derived_id ? '' : `\n        derivation would have minted ${p.derived_id}`;
      console.log(`  ${p.id}  <-  ${p.name}${same}`);
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
    console.log(`  ${f.id.padEnd(40)} ${String(f.lat).padStart(11)},${String(f.lng).padEnd(11)} ${(f._confidence || '').padEnd(8)} ${f.timezone}`);
  }

  const write = [...pinned, ...fresh].map(strip);
  await writeFile(output, `-- Serbian Metropolitanate of Australia and New Zealand — ${write.length} parishes\n`
    + `-- Generated by scripts/build-serbian-sql.mjs from ${input}\n`
    + `-- Scraped ${geocoded.scraped_at}, geocoded ${geocoded.geocoded_at}\n\n`
    + `${buildUpsert(write)}\n`);
  console.log(`\nwrote ${output} — ${write.length} rows`);
}
