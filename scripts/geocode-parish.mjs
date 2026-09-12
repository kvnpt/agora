// Placing a jurisdiction's parishes: the half that is the same every time.
//
// Step 2 of the pipeline in docs/parish-ingestion.md — a pin, an address and a
// timezone per row — written once here and pointed at a jurisdiction by its
// caller. scripts/geocode-common.mjs holds the layer below this (Nominatim,
// Overpass, caching, the ISO-code timezone); this is the tiering, the
// dedication matching and the refusals, which are what actually cost the
// previous runs their time.
//
// It was extracted from geocode-antiochian.mjs when the Serbian directory
// needed the same seven tiers with one word changed. Everything in it is a
// lesson from a run that has already happened, and every one of them
// generalises:
//
//   1. Nominatim for the SUBURB, which it knows reliably. This is where the
//      timezone comes from — never the directory's own state heading.
//   2. One Overpass query for every place of worship in Oceania tagged with
//      this jurisdiction's denomination, matched on the dedication. Each
//      building is claimed once.
//   3. Nominatim by NAME, which the brief puts first for good reason: asked
//      for "St George Serbian Orthodox Church Cabramatta" it can return the
//      church building itself, where a published corner geocodes to nothing.
//   4. The published address, handed to Nominatim STRUCTURED — the Greek run
//      showed free-form loses house-number ranges and reads "St" as Saint.
//   5. The published address free-form.
//   6. A "Cnr A & B" corner, resolved from the two streets it names.
//   7. The suburb centroid, marked as such.
//
// The order matters in one specific way: a building tagged with the right
// denomination beats a street geocode, because a street geocode lands at the
// wrong end of a long street — that error put one Blacktown parish 730m from
// its church.

import {
  makeCache, nominatim, nominatimStructured, denominationInOceania,
  preferLocality, zoneFor, km, centreOf, osmAddress,
} from './geocode-common.mjs';

// How far a dedication-matched building may sit from its suburb before the
// match is refused. Generous, because a "suburb" may resolve to the council
// that contains it, but not unbounded: every directory so far has had three
// parishes sharing a dedication, and the Serbian one has five St Savas.
export const MAX_KM = 20;

// Every jurisdiction the schema allows, as the word OSM writes in a
// `denomination` tag. A parish's own word is generic — it describes all of its
// jurisdiction's churches and distinguishes none of them — and every other
// word is disqualifying, which is the two halves of the same list.
const JURISDICTION_WORDS = ['antiochian', 'greek', 'serbian', 'russian',
  'romanian', 'macedonian', 'coptic', 'ukrainian', 'bulgarian', 'georgian',
  'eritrean', 'ethiopian', 'syriac', 'armenian'];

// Not Orthodox at all. A dedication is shared far more widely than a
// jurisdiction, and St George belongs to half the denominations in Australia.
const NON_ORTHODOX = ['catholic', 'anglican', 'uniting', 'baptist_church', 'lutheran'];

// Words that describe any Orthodox church and so distinguish none of them.
const GENERIC_BASE = ['the', 'of', 'our', 'and', 'a', 'an', 'in', 'at', 'for',
  'church', 'parish', 'orthodox', 'cathedral', 'co-cathedral', 'pro-cathedral',
  'monastery', 'convent', 'skete', 'chapel', 'community', 'mission',
  'archdiocesan', 'metropolitanate', 'diocese', 'st', 'sts', 'saint', 'saints',
  'holy', 'lady', 'christian', 'village'];

// Dedications the two sources word differently. Elias is Elijah, the Forerunner
// is the Baptist, and the Theotokos is St Mary — without these the right
// building sits in the results with no token in common. Petka is Paraskeva and
// Sava is Sabbas, which is the Serbian directory's contribution to the list.
const SYNONYM = [
  ['elias', 'elijah', 'ilya', 'ilija'],
  ['forerunner', 'baptist', 'john', 'jovan'],
  ['mary', 'theotokos', 'virgin', 'dormition', 'assumption', 'nativity', 'entrance', 'protection'],
  ['michael', 'archangel', 'archangels'],
  ['gabriel', 'archangel'],
  ['paul', 'apostle'],
  ['peter', 'apostle'],
  ['magdalene', 'magdalen'],
  ['cross', 'exaltation', 'elevation'],
  ['shepherd', 'goodshepherd'],
  ['petka', 'paraskeva', 'paraskevi'],
  ['sava', 'sabbas'],
  ['nicholas', 'nikola', 'nikolaj'],
  ['george', 'georgije', 'djordje'],
  ['stephen', 'steven', 'stefan'],
  ['lazarus', 'lazar'],
  ['basil', 'vasilije'],
];

/**
 * The dedication matcher for one jurisdiction.
 *
 * Two ways to be wrong, both seen on the ROCOR run. A dedication is not a
 * jurisdiction — Brisbane's Russian and Serbian St Nicholas sit 500m apart,
 * and OSM tags the Serbian one `greek_orthodox` — so a candidate naming
 * somebody else's jurisdiction is refused outright, however well the dedication
 * agrees. And a result has to actually share the dedication rather than merely
 * rank first for the query.
 */
export function matcher(jurisdiction) {
  const generic = new Set([...GENERIC_BASE, jurisdiction]);
  const foreign = new RegExp([...JURISDICTION_WORDS.filter((w) => w !== jurisdiction),
    ...NON_ORTHODOX].join('|'));
  const own = new RegExp(jurisdiction);

  const toks = (s) => new Set((s || '')
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w && !generic.has(w))
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
   * How well one OSM place of worship matches one parish, or null for no match.
   *
   * A shared dedication token is necessary and not sufficient: the denomination
   * decides. Another jurisdiction's is disqualifying outright — Brisbane's
   * Russian and Serbian St Nicholas are 500m apart — and a building with no
   * orthodox denomination at all is not a candidate however well the name
   * agrees, because St George belongs to half the denominations in Australia.
   */
  function scoreBuilding(parishName, el) {
    const tags = el.tags || {};
    const centre = centreOf(el);
    if (!centre) return null;
    const want = expand(toks(parishName));
    const have = expand(toks(tags.name));
    const shared = [...want].filter((w) => have.has(w));
    if (!shared.length) return null;
    const denom = (tags.denomination || '').toLowerCase();
    if (foreign.test(denom)) return null;
    let score = shared.length * 10;
    if (own.test(denom)) score += 100;
    else if (/orthodox/.test(denom)) score += 30;
    else return null;
    return { el, tags, centre, score, shared };
  }

  /**
   * The best OSM place of worship for a parish, or null.
   *
   * A building is claimed by at most ONE parish: matching on the dedication
   * alone handed Croydon the Strathfield cathedral and Fairfield the
   * Cabramatta church, both with complete confidence, on the ROCOR run.
   * geocodeAll() assigns globally rather than calling this per parish — see
   * assignBuildings() — but this stays for a caller that wants one answer.
   */
  function pickBuilding(parishName, elements) {
    const scored = elements.map((el) => scoreBuilding(parishName, el)).filter(Boolean);
    scored.sort((a, b) => b.score - a.score);
    return scored[0] || null;
  }

  function nameHitIsSound(parishName, result) {
    if (!result || !isBuilding(result)) return false;
    const display = result.display_name || '';
    if (foreign.test(display.toLowerCase())) return false;
    const want = expand(toks(parishName));
    const have = expand(toks(display.split(',').slice(0, 2).join(' ')));
    return [...want].some((w) => have.has(w));
  }

  return { toks, expand, scoreBuilding, pickBuilding, nameHitIsSound };
}

const AU_STATES = /\b(NSW|VIC|QLD|SA|WA|TAS|NT|ACT)\b/i;

// A Nominatim result that is a building rather than a road or a boundary.
const isBuilding = (r) => /place_of_worship|church|building|amenity|monastery/
  .test(`${r.class}/${r.type}`);

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
 * "Ven. Alypius the Stylite Memorial Church") derails the whole query. Handing
 * the street over separately from the locality fixes all three.
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
  return { street, city: suburb || null, state, postalcode: postcode };
}

/**
 * Place every scraped row.
 *
 * `scraped.parishes` rows are expected to carry: name, suburb, state,
 * state_abbr, country, address, address_vague, slug. That shape is what
 * scrape-<jurisdiction>.mjs produces, and `address_vague` is the flag that
 * keeps a PO box away from the geocoder — a postal address is a place to send
 * mail, not a place to stand.
 */
export async function geocodeAll(scraped, cacheDir, log = () => {}, opts = {}) {
  const jurisdiction = opts.jurisdiction || scraped.jurisdiction;
  if (!jurisdiction) throw new Error('which jurisdiction? pass opts.jurisdiction');
  const maxKm = opts.maxKm || MAX_KM;
  const { scoreBuilding, nameHitIsSound } = matcher(jurisdiction);

  const cached = makeCache(cacheDir);
  const out = [];
  const claimed = new Set();

  let osmChurches = [];
  try {
    osmChurches = (await denominationInOceania(cached, jurisdiction)).elements || [];
    log(`OSM knows ${osmChurches.length} ${jurisdiction}-denomination places of worship in Oceania\n`);
  } catch (err) {
    log(`the Oceania-wide ${jurisdiction} query failed (${err.message}); street geocodes only\n`);
  }

  // ── pass 1: the suburb for every row ──────────────────────────────────
  //
  // Separated from the tiers below because the OSM assignment that follows has
  // to see every parish before it can give any of them a building. Nominatim
  // answers are cached to disk, so a second loop over the same rows costs
  // nothing.
  const rows = [];
  for (const p of scraped.parishes) {
    const cc = p.country === 'New Zealand' ? 'nz' : 'au';
    const where = p.country;
    const note = [];
    if (p.suburb_disagreement) note.push(p.suburb_disagreement);

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
    rows.push({ p, cc, where, note, hit, centroid: hit ? { lat: +hit.lat, lng: +hit.lon } : null });
  }

  // ── pass 2: hand out the OSM buildings, best pair first ───────────────
  //
  // Globally rather than parish by parish, because "best building for this
  // parish" and "best parish for this building" are different questions and
  // the first one, asked in directory order, gets the wrong answer. Keysborough
  // and Carrum Downs are 10km apart and their dedications share the word
  // Stephen; asked first, Keysborough took the church that is 400m from Carrum
  // Downs and 10km from itself, and Carrum Downs then had nothing left.
  //
  // Sorting by score and then by distance answers both questions at once: the
  // pair that agrees on the most words wins, and where two agree equally the
  // nearer one does.
  const assignment = new Map();      // slug -> scored candidate
  const pairs = [];
  for (const row of rows) {
    if (!row.centroid) continue;
    for (const el of osmChurches) {
      const cand = scoreBuilding(row.p.name, el);
      if (!cand) continue;
      const d = km(row.centroid, { lat: cand.centre.lat, lng: cand.centre.lon });
      if (d > maxKm) continue;
      pairs.push({ row, cand, d });
    }
  }
  pairs.sort((a, b) => b.cand.score - a.cand.score || a.d - b.d);
  for (const { row, cand, d } of pairs) {
    const key = `${cand.el.type}/${cand.el.id}`;
    if (claimed.has(key) || assignment.has(row.p.slug)) continue;
    claimed.add(key);
    assignment.set(row.p.slug, { ...cand, d });
  }

  // ── pass 3: place each row ────────────────────────────────────────────
  for (const { p, cc, where, note, hit, centroid } of rows) {
    if (!hit) {
      out.push({ ...p, lat: null, lng: null, timezone: null, confidence: 'unplaced',
        note: [...note, 'the suburb did not geocode'].join('; ') });
      log(`  UNPLACED  ${p.name}`);
      continue;
    }
    const timezone = zoneFor(hit.address);
    const resolvedState = hit.address?.state || hit.address?.territory || null;
    // Only for Australia. A directory that files a parish under the wrong
    // STATE is an hour of DST twice a year — that is the Tweed Heads lesson —
    // but New Zealand has one zone and no states, so comparing "New Zealand"
    // against the region Nominatim returns ("Canterbury", "Wellington") only
    // produces a note per NZ parish and buries the ones that matter.
    if (p.country !== 'New Zealand' && p.state && resolvedState && p.state !== resolvedState) {
      note.push(`the directory files this under ${p.state}; it is in ${resolvedState}`);
    }

    const finish = (row) => {
      out.push({ ...p, timezone, resolved_state: resolvedState, ...row,
        note: note.length ? note.join('; ') : null });
    };

    // 2. the OSM building pass 2 gave this parish, if any
    const cand = assignment.get(p.slug);
    if (cand) {
      finish({
        lat: +cand.centre.lat.toFixed(6), lng: +cand.centre.lon.toFixed(6),
        confidence: 'building', matched_via: `oceania-${jurisdiction}`,
        osm: `${cand.el.type}/${cand.el.id}`, osm_name: cand.tags.name || null,
        osm_denomination: cand.tags.denomination || null,
        address: (p.address_vague ? null : p.address) || osmAddress(cand.tags),
        km_from_suburb: +cand.d.toFixed(2),
      });
      log(`  building  ${p.name}  ->  ${cand.tags.name} (${cand.el.type}/${cand.el.id})`);
      continue;
    }

    // 3. by NAME. The brief puts this first and it earns the place: a church
    // is in OSM under its own name far more often than its street is useful.
    const dedication = p.name.split(',')[0].trim();
    for (const q of [`${dedication} Orthodox Church ${p.suburb}`, `${dedication} ${p.suburb}`]) {
      const r = (await nominatim(cached, `${q}, ${where}`, cc)).find((x) => nameHitIsSound(p.name, x));
      if (!r) continue;
      const d = km(centroid, { lat: +r.lat, lng: +r.lon });
      if (d > maxKm) continue;
      finish({
        lat: +(+r.lat).toFixed(6), lng: +(+r.lon).toFixed(6),
        confidence: 'building', matched_via: 'nominatim-name',
        osm: `${r.osm_type}/${r.osm_id}`, osm_name: (r.display_name || '').split(',')[0],
        address: (p.address_vague ? null : p.address) || null, km_from_suburb: +d.toFixed(2),
      });
      log(`  building  ${p.name}  ->  ${(r.display_name || '').split(',')[0]} (by name)`);
      break;
    }
    if (out.length && out[out.length - 1].slug === p.slug) continue;

    // 3b. by the JURISDICTION's own name, for the building OSM knows only as
    // "Free Serbian Orthodox Church - Diocese For Australia & New Zealand" —
    // a real church on the road the monastery publishes, with not one token of
    // its dedication in the name, so the tier above cannot see it and neither
    // can the dedication match.
    //
    // Accepted only when the suburb has exactly ONE such church. That is the
    // whole guard: the query cannot tell two parishes of the same jurisdiction
    // apart, so where there are two it must answer neither.
    const jurisWord = jurisdiction[0].toUpperCase() + jurisdiction.slice(1);
    const nearby = (await nominatim(cached, `${jurisWord} Orthodox Church, ${p.suburb}, ${where}`, cc))
      .filter((r) => isBuilding(r)
        && new RegExp(jurisdiction, 'i').test(r.display_name || '')
        // Already somebody else's building. Without this the tier hands a
        // second parish the church the dedication match just assigned.
        && !claimed.has(`${r.osm_type}/${r.osm_id}`)
        && km(centroid, { lat: +r.lat, lng: +r.lon }) <= maxKm);
    if (nearby.length === 1) {
      const r = nearby[0];
      const d = km(centroid, { lat: +r.lat, lng: +r.lon });
      claimed.add(`${r.osm_type}/${r.osm_id}`);
      note.push(`matched on the jurisdiction rather than the dedication: OSM calls it "${(r.display_name || '').split(',')[0]}"`);
      finish({
        lat: +(+r.lat).toFixed(6), lng: +(+r.lon).toFixed(6),
        confidence: 'building', matched_via: 'nominatim-jurisdiction',
        osm: `${r.osm_type}/${r.osm_id}`, osm_name: (r.display_name || '').split(',')[0],
        address: (p.address_vague ? null : p.address) || null, km_from_suburb: +d.toFixed(2),
      });
      log(`  building  ${p.name}  ->  ${(r.display_name || '').split(',')[0]} (by jurisdiction)`);
      continue;
    }

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
        if (d <= maxKm) {
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
    const streets = p.address_vague ? null : cornerStreets(p.address);
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
          if (km(centroid, mid) <= maxKm) {
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
      // does not reach a parish that DID publish a street which simply is not
      // in OSM: the street is real and is how somebody would actually find the
      // church, and throwing it away to flag the pin would lose true
      // information to record a caveat. So a vague address — a PO box, or
      // nothing at all — is nulled and a real one is kept, and the pin quality
      // is reported instead.
      address: p.address_vague ? null : (p.address || null),
      osm: null,
    });
    note.push(`no building matched; this is the ${p.suburb} centroid and there is demonstrably no church at it`);
    out[out.length - 1].note = note.join('; ');
    log(`  SUBURB    ${p.name}  (${p.suburb} centroid)`);
  }
  return out;
}

/** The report both callers print, so two runs read the same way. */
export function report(rows, log = console.log) {
  const tally = {};
  for (const r of rows) tally[r.confidence] = (tally[r.confidence] || 0) + 1;
  log('\nconfidence: ' + JSON.stringify(tally));
  const zones = {};
  for (const r of rows) zones[r.timezone || '(none)'] = (zones[r.timezone || '(none)'] || 0) + 1;
  log('timezones: ' + JSON.stringify(zones));
  const noted = rows.filter((r) => r.note);
  if (noted.length) {
    log('\nnotes worth reading:');
    for (const r of noted) log(`  ${r.name}\n      ${r.note}`);
  }
}
