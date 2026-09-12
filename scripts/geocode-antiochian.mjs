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
import {
  makeCache, nominatim, nominatimStructured, denominationInOceania, overpass,
  preferLocality, zoneFor, km, centreOf, osmAddress,
} from './geocode-common.mjs';

// How far a dedication-matched building may sit from its suburb before the
// match is refused. Generous, because a "suburb" may resolve to the council
// that contains it, but not unbounded: three of these parishes are St Nicholas
// and two are St Elias.
const MAX_KM = 20;

// Words that describe any Orthodox church and so distinguish none of them.
const GENERIC = new Set(['the', 'of', 'our', 'and', 'a', 'an', 'in', 'at', 'for',
  'church', 'parish', 'orthodox', 'cathedral', 'monastery', 'convent', 'skete',
  'chapel', 'community', 'mission', 'antiochian', 'archdiocesan', 'st', 'sts',
  'saint', 'saints', 'holy', 'lady', 'christian', 'village']);

// Denominations belonging to another jurisdiction. Matching one is always
// wrong, however well the dedication agrees — Brisbane's Russian and Serbian
// St Nicholas sit 500m apart and OSM tags one of them greek_orthodox.
const FOREIGN = /greek|serbian|russian|romanian|macedonian|coptic|ukrainian|bulgarian|georgian|eritrean|ethiopian|syriac|armenian|catholic|anglican|uniting|baptist_church|lutheran/;

// Dedications the two sources word differently. Elias is Elijah, the Forerunner
// is the Baptist, and the Theotokos is St Mary — without these the right
// building sits in the results with no token in common.
const SYNONYM = [
  ['elias', 'elijah', 'ilya'],
  ['forerunner', 'baptist', 'john'],
  ['mary', 'theotokos', 'virgin', 'dormition', 'assumption', 'nativity'],
  ['michael', 'archangel', 'archangels'],
  ['gabriel', 'archangel'],
  ['paul', 'apostle'],
  ['peter', 'apostle'],
  ['magdalene', 'magdalen'],
  ['cross', 'exaltation', 'elevation'],
  ['shepherd', 'goodshepherd'],
];

const toks = (s) => new Set((s || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().split(/[^a-z0-9]+/)
  .filter((w) => w && !GENERIC.has(w))
  .map((w) => w.replace(/s$/, '')));

const expand = (set) => {
  const out = new Set(set);
  for (const group of SYNONYM) {
    const g = group.map((w) => w.replace(/s$/, ''));
    if (g.some((w) => out.has(w))) for (const w of g) out.add(w);
  }
  return out;
};

/**
 * The best OSM place of worship for a parish, or null.
 *
 * A building is claimed by at most ONE parish (the caller filters those out
 * before calling): matching on the dedication alone handed Croydon the
 * Strathfield cathedral and Fairfield the Cabramatta church, both with complete
 * confidence, on the ROCOR run.
 */
export function pickBuilding(parishName, elements) {
  const want = expand(toks(parishName));
  const scored = [];
  for (const el of elements) {
    const tags = el.tags || {};
    const centre = centreOf(el);
    if (!centre) continue;
    const have = expand(toks(tags.name));
    const shared = [...want].filter((w) => have.has(w));
    if (!shared.length) continue;
    const denom = (tags.denomination || '').toLowerCase();
    if (FOREIGN.test(denom)) continue;
    let score = shared.length * 10;
    if (/antiochian/.test(denom)) score += 100;
    else if (/orthodox/.test(denom)) score += 30;
    else continue;
    scored.push({ el, tags, centre, score, shared });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

const AU_STATES = /\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/i;

// A Nominatim result that is a building rather than a road or a boundary.
const isBuilding = (r) => /place_of_worship|church|building|amenity|monastery/
  .test(`${r.class}/${r.type}`);

/**
 * Whether a name-search result may be accepted for this parish.
 *
 * Two ways to be wrong here, both seen on the ROCOR run. A dedication is not a
 * jurisdiction — three of these parishes are St Nicholas and so are Greek and
 * Serbian parishes in the same suburbs — so a result naming somebody else's
 * jurisdiction is refused outright. And a result has to actually share the
 * dedication, not merely rank first for the query.
 */
export function nameHitIsSound(parishName, result) {
  if (!result || !isBuilding(result)) return false;
  const display = result.display_name || '';
  if (FOREIGN.test(display.toLowerCase())) return false;
  const want = expand(toks(parishName));
  const have = expand(toks(display.split(',').slice(0, 2).join(' ')));
  return [...want].some((w) => have.has(w));
}

// "Cnr Walker & Cooper Sts" is not an address and geocodes to nothing, but the
// two streets it names geocode fine on their own. Their closest approach is the
// corner, near enough — and much nearer than the suburb centroid, which is the
// only other thing on offer.
const CORNER = /\b(?:cnr|corner)\b\.?\s*(.+)/i;

export function cornerStreets(addr) {
  const m = (addr || '').match(CORNER);
  if (!m) return null;
  const part = m[1].split(',')[0];
  const bits = part.split(/\s*(?:&|\band\b)\s*/i).map((b) => b.trim()).filter(Boolean);
  if (bits.length < 2) return null;
  // "Walker & Cooper Sts" — the street type is written once, at the end.
  const type = (bits[bits.length - 1].match(/\b(St|Street|Rd|Road|Ave|Avenue|Pde|Parade|Dr|Drive|Ln|Lane)s?\b\.?$/i) || [])[1];
  return bits.map((b) => (/(St|Street|Rd|Road|Ave|Avenue|Pde|Parade|Dr|Drive|Ln|Lane)s?\b\.?$/i.test(b)
    ? b.replace(/s\b\.?$/i, '') : `${b} ${type || 'Street'}`).trim());
}

/**
 * A published address split for a STRUCTURED Nominatim query.
 *
 * Free-form left 28 of the 135 Greek parishes unplaced: `St` reads as Saint,
 * house-number ranges miss, and a leading building name ("Religious Centre",
 * "All Saints' Anglican Church (old building)") derails the whole query.
 * Handing the street over separately from the locality fixes all three.
 */
export function addressParts(addr, suburb) {
  if (!addr) return null;
  const body = addr.replace(/,\s*(Australia|New Zealand)\s*(\([^)]*\))?\s*$/i, '').trim();
  const segs = body.split(',').map((s) => s.trim()).filter(Boolean);
  const postcode = (body.match(/\b(\d{4})\b/) || [])[1] || null;
  const state = (body.match(AU_STATES) || [])[0] || null;
  // The street is the first segment that starts with a number or reads like a
  // corner; a leading building name is dropped rather than searched for.
  const street = segs.find((s) => /^\d/.test(s) || /^cnr\b|^corner\b/i.test(s)) || null;
  return {
    street, city: suburb || null, state, postalcode: postcode,
  };
}

export async function geocodeAll(scraped, cacheDir, log = () => {}) {
  const cached = makeCache(cacheDir);
  const out = [];
  const claimed = new Set();

  let osmChurches = [];
  try {
    osmChurches = (await denominationInOceania(cached, 'antiochian')).elements || [];
    log(`OSM knows ${osmChurches.length} antiochian-denomination places of worship in Oceania\n`);
  } catch (err) {
    log(`the Oceania-wide antiochian query failed (${err.message}); street geocodes only\n`);
  }

  for (const p of scraped.parishes) {
    const cc = p.country === 'New Zealand' ? 'nz' : 'au';
    const where = p.country;
    let note = [];
    if (p.suburb_disagreement) note.push(p.suburb_disagreement);

    // 1. the suburb — the timezone and the sanity check both come from here
    let hit = null;
    if (p.suburb) {
      const q = [p.suburb, p.state_abbr, where].filter(Boolean).join(', ');
      hit = preferLocality(await nominatim(cached, q, cc), p.suburb);
      if (!hit) {
        // A state-constrained locality query fails by returning the WRONG PLACE.
        hit = preferLocality(await nominatim(cached, `${p.suburb}, ${where}`, cc), p.suburb);
        if (hit) note.push('the suburb did not resolve inside the state the directory files it under');
      }
    }
    if (!hit) {
      out.push({ ...p, lat: null, lng: null, timezone: null, confidence: 'unplaced',
        note: [...note, 'the suburb did not geocode'].join('; ') });
      log(`  UNPLACED  ${p.name}`);
      continue;
    }

    const centroid = { lat: +hit.lat, lng: +hit.lon };
    const timezone = zoneFor(hit.address);
    const resolvedState = hit.address?.state || hit.address?.territory || null;
    if (p.state && resolvedState && p.state !== resolvedState) {
      note.push(`the directory files this under ${p.state}; it is in ${resolvedState}`);
    }

    const finish = (row) => { out.push({ ...p, timezone, resolved_state: resolvedState, ...row,
      note: note.length ? note.join('; ') : null }); };

    // 2. an OSM building tagged for this jurisdiction
    const cand = pickBuilding(p.name, osmChurches.filter((el) => {
      if (claimed.has(`${el.type}/${el.id}`)) return false;
      const c = centreOf(el);
      return c && km(centroid, { lat: c.lat, lng: c.lon }) <= MAX_KM;
    }));
    if (cand) {
      claimed.add(`${cand.el.type}/${cand.el.id}`);
      finish({
        lat: +cand.centre.lat.toFixed(6), lng: +cand.centre.lon.toFixed(6),
        confidence: 'building', matched_via: 'oceania-antiochian',
        osm: `${cand.el.type}/${cand.el.id}`, osm_name: cand.tags.name || null,
        osm_denomination: cand.tags.denomination || null,
        address: p.address || osmAddress(cand.tags),
        km_from_suburb: +km(centroid, { lat: +cand.centre.lat, lng: +cand.centre.lon }).toFixed(2),
      });
      log(`  building  ${p.name}  ->  ${cand.tags.name} (${cand.el.type}/${cand.el.id})`);
      continue;
    }

    // 3. by NAME. The brief puts this first and it earns the place: the
    // Redfern cathedral is in OSM as a building under its own name while its
    // published address is a corner that geocodes to nothing.
    const dedication = p.name.split(',')[0].trim();
    for (const q of [`${dedication} Orthodox Church ${p.suburb}`, `${dedication} ${p.suburb}`]) {
      const r = (await nominatim(cached, `${q}, ${where}`, cc)).find((x) => nameHitIsSound(p.name, x));
      if (!r) continue;
      const d = km(centroid, { lat: +r.lat, lng: +r.lon });
      if (d > MAX_KM) continue;
      finish({
        lat: +(+r.lat).toFixed(6), lng: +(+r.lon).toFixed(6),
        confidence: 'building', matched_via: 'nominatim-name',
        osm: `${r.osm_type}/${r.osm_id}`, osm_name: (r.display_name || '').split(',')[0],
        address: p.address || null, km_from_suburb: +d.toFixed(2),
      });
      log(`  building  ${p.name}  ->  ${(r.display_name || '').split(',')[0]} (by name)`);
      break;
    }
    if (out.length && out[out.length - 1].slug === p.slug) continue;

    // 4/5. the published address — structured first, then free-form
    if (p.address && !p.address_vague) {
      const parts = addressParts(p.address, p.suburb);
      let a = null;
      if (parts?.street) {
        a = (await nominatimStructured(cached, { ...parts, country: where }, cc))[0] || null;
      }
      if (!a) a = (await nominatim(cached, p.address, cc))[0] || null;
      if (a) {
        const onBuilding = /place_of_worship|building|amenity/.test(`${a.class}/${a.type}`);
        const d = km(centroid, { lat: +a.lat, lng: +a.lon });
        if (d <= MAX_KM) {
          finish({
            lat: +(+a.lat).toFixed(6), lng: +(+a.lon).toFixed(6),
            confidence: onBuilding ? 'building' : 'street',
            matched_via: parts?.street ? 'address-structured' : 'address-freeform',
            osm: `${a.osm_type}/${a.osm_id}`, address: p.address,
            km_from_suburb: +d.toFixed(2),
          });
          log(`  ${(onBuilding ? 'building' : 'street').padEnd(8)}  ${p.name}  ->  ${p.address}`);
          continue;
        }
        note.push(`the published address geocoded ${d.toFixed(0)}km from ${p.suburb} and was refused`);
      }
    }

    // 6. a corner, resolved from the two streets it names
    const streets = cornerStreets(p.address);
    if (streets && streets.length >= 2) {
      const pts = [];
      for (const st of streets) {
        const r = (await nominatimStructured(cached,
          { street: st, city: p.suburb, country: where }, cc))[0];
        if (r) pts.push({ lat: +r.lat, lng: +r.lon, street: st });
      }
      if (pts.length >= 2) {
        // The closest pair of the returned representative points is as near the
        // junction as this can get without the street geometry itself.
        let best = null;
        for (let i = 0; i < pts.length; i += 1) {
          for (let j = i + 1; j < pts.length; j += 1) {
            const d = km(pts[i], pts[j]);
            if (!best || d < best.d) best = { d, a: pts[i], b: pts[j] };
          }
        }
        if (best && best.d <= 1.5) {
          const mid = { lat: (best.a.lat + best.b.lat) / 2, lng: (best.a.lng + best.b.lng) / 2 };
          if (km(centroid, mid) <= MAX_KM) {
            note.push(`pinned at the junction of ${streets.join(' and ')}, from the two streets ${(best.d * 1000).toFixed(0)}m apart`);
            finish({
              lat: +mid.lat.toFixed(6), lng: +mid.lng.toFixed(6),
              confidence: 'street', matched_via: 'corner',
              address: p.address, osm: null,
              km_from_suburb: +km(centroid, mid).toFixed(2),
            });
            log(`  street    ${p.name}  ->  corner of ${streets.join(' & ')}`);
            continue;
          }
        }
      }
    }

    // 7. the suburb centroid, and say so
    finish({
      lat: +centroid.lat.toFixed(6), lng: +centroid.lng.toFixed(6),
      confidence: 'suburb', matched_via: 'locality-centroid',
      // `address` is nulled only where the parish published nothing usable.
      //
      // The ROCOR run nulled it on every centroid row, because there the
      // address was genuinely unknown and an absent address is the only signal
      // the schema has that a pin is the middle of a locality. That reasoning
      // does not reach a parish that DID publish a street which simply is not in
      // OSM: St Mary Magdalene's Coronation Street is real and is how somebody
      // would actually find the church, and throwing it away to flag the pin
      // would lose true information to record a caveat. So a vague address is
      // nulled and a real one is kept, and the pin quality is reported instead.
      address: p.address_vague ? null : (p.address || null),
      osm: null,
    });
    note.push(`no building matched; this is the ${p.suburb} centroid and there is demonstrably no church at it`);
    out[out.length - 1].note = note.join('; ');
    log(`  SUBURB    ${p.name}  (${p.suburb} centroid)`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2] || './antiochian-scraped.json';
  const cacheDir = process.argv[3] || './cache/geo-antiochian';
  const output = process.argv[4] || './antiochian-geocoded.json';

  const scraped = JSON.parse(await readFile(input, 'utf8'));
  console.log(`geocoding ${scraped.parishes.length} places of worship\n`);
  const rows = await geocodeAll(scraped, cacheDir, (m) => console.log(m));

  const tally = {};
  for (const r of rows) tally[r.confidence] = (tally[r.confidence] || 0) + 1;
  console.log('\nconfidence:', tally);
  const zones = {};
  for (const r of rows) zones[r.timezone || '(none)'] = (zones[r.timezone || '(none)'] || 0) + 1;
  console.log('timezones:', zones);
  const noted = rows.filter((r) => r.note);
  if (noted.length) {
    console.log('\nnotes worth reading:');
    for (const r of noted) console.log(`  ${r.name}\n      ${r.note}`);
  }

  await writeFile(output, JSON.stringify({ ...scraped, geocoded_at: new Date().toISOString(), parishes: rows }, null, 1));
  console.log(`\nwrote ${output}`);
}
