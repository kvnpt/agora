// Step 2 of the pipeline in docs/parish-ingestion.md: turn scraped ROCOR rows
// into rows that can be written — a pin, an address, and a timezone — writing a
// second file that can be eyeballed beside the first.
//
// WHY NOT JUST NOMINATIM. The brief says to search by name first, because a
// street address can geocode to the wrong end of a long street. For these
// parishes name search does not merely rank badly, it returns nothing:
// "Russian Orthodox Cathedral Strathfield" has no match, and the cathedral's
// own address resolves to Vernon Street the way rather than the building. So
// the order here is:
//
//   1. Nominatim for the SUBURB, which it knows reliably -> a centroid, and
//      the state the suburb is really in.
//   2. One Overpass query for every russian-denomination place of worship in
//      Oceania, then a pin reviewed by hand (scripts/rocor-addresses.mjs) or a
//      match on the dedication. Each building is claimed by at most one parish.
//   3. Failing that, every place of worship near the suburb, matched on the
//      dedication. Best-effort: the mirror 504s on dense inner-city radii.
//   4. Failing that, Nominatim on a street address from
//      scripts/rocor-addresses.mjs -> usually street-level.
//   5. Failing that, the suburb centroid, marked as such.
//
// Step 3 is queried once per LOCALITY, not once per parish: Woolloongabba,
// Kentlyn and Dandenong each hold two of these, and one query answers for both.
//
// TWO THINGS THAT BITE. Use the kumi mirror — overpass-api.de is unreachable
// from the build environment and a country-wide query never returns; small
// radius queries against kumi answer in about a second. And take the timezone
// from the state Nominatim resolves, never from the directory's state heading:
// the directory files Tweed Heads under Queensland, but Tweed Heads is in New
// South Wales and observes daylight saving, so the heading would put every
// service there an hour out for half the year.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ADDRESSES, OSM_PIN, SUBURB_FIX } from './rocor-addresses.mjs';

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const OVERPASS = 'https://overpass.kumi.systems/api/interpreter';
const UA = 'agora-parish-import/1.0 (+https://agora.orthodoxy.au)';

// 6km, not 3. A suburb centroid can be a long way from the parish: Nominatim
// answers "Blacktown" with the CITY COUNCIL's centroid, which is 5.3km from the
// church, so a 3km radius missed a building that OSM has tagged
// denomination=russian_orthodox.
const RADIUS_M = 6000;

// The whole of Oceania's Russian-denomination places of worship, in one query.
// This is the cheapest and best pass: 15 buildings, most of them these
// parishes, each tagged by the people who mapped them. Anything it answers
// needs no suburb search at all.
const OCEANIA_BBOX = '-48,112,-9,180';

// How far a dedication-matched building may sit from the suburb Nominatim
// resolved before the match is refused. Generous, because the centroid may be a
// council area rather than a suburb, but not unbounded: three of these parishes
// are St Nicholas, and two Woolloongabba parishes share a postcode.
const MAX_KM = 25;

// Nominatim asks for one request per second. Overpass has no published rate but
// deserves the same courtesy; both are free services doing us a favour.
const PAUSE_MS = 1100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Node's fetch has no default timeout, and Overpass answers a query it does not
// like by holding the connection open rather than refusing it — which stops the
// run dead with no error to read. Every request here gets a deadline and two
// retries; a query that has failed three times is reported and skipped, because
// one parish without a building pin is a far better outcome than a run that
// never finishes.
const DEADLINE_MS = 90_000;
const ATTEMPTS = 3;

async function fetchJson(url, label, { attempts = ATTEMPTS, deadline = DEADLINE_MS } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(deadline),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < attempts) await sleep(2000 * attempt);
    }
  }
  throw new Error(`${label}: ${lastErr.message}`);
}

// IANA zone per ISO 3166-2 subdivision, which is what Nominatim always returns
// and what state names are not: the ACT arrives under `territory` rather than
// `state`, so reading `address.state` leaves Canberra with no timezone at all.
// Australia/Sydney covers the ACT; there is no Australia/Canberra worth using.
const ZONE_BY_ISO = {
  'AU-NSW': 'Australia/Sydney',
  'AU-VIC': 'Australia/Melbourne',
  'AU-QLD': 'Australia/Brisbane',
  'AU-TAS': 'Australia/Hobart',
  'AU-SA': 'Australia/Adelaide',
  'AU-ACT': 'Australia/Sydney',
  'AU-NT': 'Australia/Darwin',
  'AU-WA': 'Australia/Perth',
};

const ZONE = {
  'New South Wales': 'Australia/Sydney',
  'Victoria': 'Australia/Melbourne',
  'Queensland': 'Australia/Brisbane',
  'Tasmania': 'Australia/Hobart',
  'South Australia': 'Australia/Adelaide',
  'Australian Capital Territory': 'Australia/Sydney',
  'Northern Territory': 'Australia/Darwin',
  'Western Australia': 'Australia/Perth',
};

// ── cached, throttled fetching ─────────────────────────────────────────────

let lastCall = 0;
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

async function cached(cacheDir, key, run) {
  const path = join(cacheDir, `${key}.json`);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch { /* not cached */ }
  const wait = PAUSE_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const body = await run();
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path, JSON.stringify(body, null, 1));
  return body;
}

async function nominatim(cacheDir, query, countrycodes) {
  return cached(cacheDir, `nom-${slug(query)}`, async () => {
    const params = new URLSearchParams({
      q: query, format: 'json', limit: '5', addressdetails: '1', countrycodes,
    });
    return fetchJson(`${NOMINATIM}?${params}`, `nominatim "${query}"`);
  });
}

async function overpassQuery(cacheDir, key, body, opts) {
  return cached(cacheDir, key, () => fetchJson(
    `${OVERPASS}?data=${encodeURIComponent(body)}`, `overpass ${key}`, opts));
}

// Best-effort, and deliberately impatient. The mirror answers a dense inner-city
// radius with a 504 after thirty seconds, and this pass is a bonus tier — the
// parishes it would place are the ones OSM tags plainly "orthodox". One attempt,
// a short deadline, and a miss costs the run half a minute instead of five.
const overpass = (cacheDir, lat, lon) => overpassQuery(cacheDir,
  `ovp-${lat.toFixed(4)}-${lon.toFixed(4)}`,
  `[out:json][timeout:25];nwr["amenity"="place_of_worship"](around:${RADIUS_M},${lat},${lon});out center tags;`,
  { attempts: 1, deadline: 30_000 });

const russianChurches = (cacheDir) => overpassQuery(cacheDir, 'ovp-oceania-russian',
  `[out:json][timeout:180];nwr["amenity"="place_of_worship"]["denomination"~"russian",i](${OCEANIA_BBOX});out center tags;`);

// Great-circle distance in km, to sanity-check a match against the suburb.
function km(a, b) {
  const R = 6371;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lng - a.lng) * Math.PI / 180;
  const la = a.lat * Math.PI / 180;
  const lb = b.lat * Math.PI / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la) * Math.cos(lb) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Nominatim answers a suburb query with the administrative boundary that
// contains it as often as with the suburb itself — "Blacktown City Council"
// before "Blacktown" — and a council centroid can be kilometres from the
// suburb. Prefer an actual populated place.
const PLACE_TYPES = new Set(['suburb', 'town', 'village', 'city', 'neighbourhood',
  'hamlet', 'locality', 'quarter', 'borough']);

// ...and it must actually BE the suburb. Constrained to Queensland, "Tweed
// Heads" comes back as Tweed Heads AVENUE, a residential street 80km away in
// North Tamborine — and with no place result to prefer, taking results[0]
// pinned the parish in the wrong state. So the first component of the
// display name has to name the suburb, and a result that names something else
// is no result at all.
// Compared as a SORTED SET of words, not as a string: the directory writes
// "East Brunswick" and OSM writes "Brunswick East", and they are the same place.
const placeKey = (v) => (v || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).sort()
  .join(' ');

const isPlace = (r) => (r.class === 'place' && PLACE_TYPES.has(r.type))
  || (r.class === 'boundary' && r.type === 'administrative')
  || PLACE_TYPES.has(r.addresstype);

function preferLocality(results, suburb) {
  const want = placeKey(suburb);
  const named = results.filter((r) => isPlace(r)
    && placeKey((r.display_name || '').split(',')[0]) === want);
  return named[0] || results.find((r) => r.class === 'place' && PLACE_TYPES.has(r.type)) || null;
}

// ── matching a parish to an OSM place of worship ───────────────────────────

// Words that describe any Orthodox church and so distinguish none of them.
const GENERIC = new Set(['the', 'of', 'our', 'and', 'a', 'an', 'in', 'at', 'for',
  'church', 'parish', 'orthodox', 'cathedral', 'monastery', 'convent', 'skete',
  'chapel', 'community', 'mission', 'russian', 'diocesan', 'st', 'sts', 'saint',
  'saints', 'holy', 'lady', 'icon', 'rocor', 'christian']);

// Denominations that belong to another jurisdiction. Matching one of these is
// always wrong, however well the dedication agrees.
const FOREIGN = /greek|serbian|antiochian|romanian|macedonian|coptic|ukrainian|bulgarian|georgian|eritrean|ethiopian|syriac|armenian|catholic|anglican|uniting|baptist_church/;

const toks = (s) => new Set((s || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().split(/[^a-z0-9]+/)
  .filter((w) => w && !GENERIC.has(w))
  .map((w) => w.replace(/s$/, '')));

// Dedications the two sources word differently. "Protection" and
// "Intercession" are both Pokrov; "Dormition" and "Assumption" are both
// Uspenie; the Forerunner is the Baptist. Without these the right building is
// sitting in the results with no token in common.
const SYNONYM = [
  ['protection', 'intercession', 'pokrov'],
  ['dormition', 'assumption', 'uspenie'],
  ['forerunner', 'baptist'],
  ['transfiguration', 'preobrazhenie'],
  ['presentation', 'entry'],
  ['vladimir', 'wladimir'],
  ['panteleimon', 'pantaleon', 'panteleimon'],
  ['seraphim', 'serafim'],
  ['sorrow', 'joy'],
];

const expand = (set) => {
  const out = new Set(set);
  for (const group of SYNONYM) {
    if (group.some((w) => out.has(w))) for (const w of group) out.add(w);
  }
  return out;
};

function pickBuilding(parishName, elements) {
  const want = expand(toks(parishName));
  const scored = [];
  for (const el of elements) {
    const tags = el.tags || {};
    const centre = el.center || (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
    if (!centre) continue;
    const have = expand(toks(tags.name));
    const shared = [...want].filter((w) => have.has(w));
    if (!shared.length) continue;
    const denom = (tags.denomination || '').toLowerCase();
    // A dedication is not a jurisdiction. Brisbane's russian cathedral and its
    // serbian namesake are both "St Nicholas" and sit 500m apart, and OSM tags
    // the serbian one greek_orthodox for good measure — so any denomination
    // naming somebody else's church is refused outright, whatever the name says.
    if (FOREIGN.test(denom)) continue;
    // A Russian-denomination building with a matching dedication is as certain
    // as this gets; a generically Orthodox one is likely; anything else that
    // merely shares a saint's name is not good enough on its own, because
    // "St Nicholas" also names Greek and Serbian parishes in the same suburbs.
    let score = shared.length * 10;
    if (/russian/.test(denom)) score += 100;
    else if (/orthodox/.test(denom)) score += 30;
    else continue;
    scored.push({ el, tags, centre, score, shared });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored[0] || null;
}

const osmAddress = (tags) => {
  const line = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const rest = [tags['addr:suburb'] || tags['addr:city'], tags['addr:state'], tags['addr:postcode']]
    .filter(Boolean).join(' ');
  return [line, rest].filter(Boolean).join(', ') || null;
};

// ── the run ────────────────────────────────────────────────────────────────

export async function geocodeAll(scraped, cacheDir, log = () => {}) {
  const out = [];
  // One OSM building belongs to one parish. Without this a church is handed to
  // every neighbouring suburb that shares a saint with it.
  const claimed = new Set();

  // One query for every Russian-denomination place of worship in Oceania. It
  // answers most of these parishes outright, and it answers them better than a
  // suburb search can: the tag says Russian, so a St Nicholas matched here is
  // not the Greek St Nicholas down the road.
  let russian = [];
  try {
    russian = (await russianChurches(cacheDir)).elements || [];
    log(`OSM knows ${russian.length} russian-denomination places of worship in Oceania\n`);
  } catch (err) {
    log(`the Oceania-wide russian query failed (${err.message}); falling back to per-suburb search\n`);
  }

  for (const p of scraped.parishes) {
    const key = `${p.name} | ${p.suburb}`;
    // The parish's own website first, then the World Orthodox Directory. A
    // parish is the authority on where it is; the directory is a third party
    // that is sometimes a move behind.
    const researched = ADDRESSES[key]
      || (p.directory_address
        ? { address: p.directory_address, source: p.directory_address_source }
        : null);
    const fix = SUBURB_FIX[key] || null;
    // A researched address may name the real suburb where the directory gave a
    // city; SUBURB_FIX does the same for suburbs with nothing else to go on.
    // The directory knows the suburb better than the diocese does: Holy
    // Dormition is filed under Wollongong and is in Corrimal, the Canberra
    // parish is in Narrabundah, the Hobart one in New Town.
    // ...but only where the parish has not answered for itself. St Elizabeth &
    // Barbara publishes Woodcroft and the directory files it under Adelaide;
    // the monastery publishes Monarto South and the directory says Monarto.
    // Where a parish's own site is the source of the address, it is the source
    // of the suburb too.
    const suburb = ADDRESSES[key]
      ? (ADDRESSES[key].suburb || fix?.suburb || p.suburb)
      : (fix?.suburb || p.directory_suburb || p.suburb);
    const nz = p.country === 'New Zealand';
    const cc = nz ? 'nz' : 'au';

    // 1. the suburb, which Nominatim knows
    const where = nz ? 'New Zealand' : 'Australia';
    let stateNote = null;
    let hit = null;
    if (suburb) {
      const withState = await nominatim(cacheDir,
        `${suburb}, ${p.state_abbr || ''}, ${where}`.replace(/,\s*,/, ','), cc);
      hit = preferLocality(withState, suburb);
      if (!hit) {
        // The state in the query can be the thing that is wrong: the directory
        // files Tweed Heads under Queensland, and Tweed Heads is in New South
        // Wales. Constrained to the wrong state Nominatim answers with whatever
        // else it can find there, so a result that is not the suburb is thrown
        // away and the question asked again without the state.
        hit = preferLocality(await nominatim(cacheDir, `${suburb}, ${where}`, cc), suburb);
        stateNote = 'the suburb is not in the state the directory files it under';
      }
    }
    if (!hit) {
      out.push({ ...p, suburb, lat: null, lng: null, confidence: 'unplaced',
        reason: 'suburb did not geocode', address: researched?.address || null });
      log(`  UNPLACED  ${key}`);
      continue;
    }

    const iso = hit.address?.['ISO3166-2-lvl4'] || null;
    const resolvedState = hit.address?.state || hit.address?.territory || null;
    const country = hit.address?.country || null;
    const timezone = nz ? 'Pacific/Auckland' : (ZONE_BY_ISO[iso] || ZONE[resolvedState] || null);
    if (!nz && resolvedState && p.state && resolvedState !== p.state) {
      stateNote = `the directory files this under ${p.state}; it is in ${resolvedState}`;
    }

    const centroid = { lat: +hit.lat, lng: +hit.lon };
    const near = (cand) => cand && km(centroid, { lat: +cand.centre.lat, lng: +cand.centre.lon }) <= MAX_KM;

    // 2a. a pin somebody identified by hand, where the names cannot match
    let best = null;
    let via = null;
    const pin = OSM_PIN[key];
    if (pin) {
      const el = russian.find((e) => `${e.type}/${e.id}` === pin.osm);
      if (el) {
        const c = el.center || { lat: el.lat, lon: el.lon };
        best = { el, tags: el.tags || {}, centre: { lat: c.lat, lon: c.lon } };
        via = 'reviewed-pin';
        claimed.add(pin.osm);
      } else {
        log(`  ${pin.osm} is no longer in OSM's russian-denomination results (${key})`);
      }
    }

    // 2b. the Oceania-wide russian-denomination list, matched on the dedication.
    // A building already claimed by another parish is not a candidate: Croydon
    // is 2.4km from Strathfield and Fairfield 1.5km from Cabramatta, so without
    // this both would take their neighbour's church and look certain about it.
    if (!best) {
      const cand = pickBuilding(p.name, russian.filter((el) => {
        if (claimed.has(`${el.type}/${el.id}`)) return false;
        const c = el.center || (el.lat != null ? { lat: el.lat, lon: el.lon } : null);
        return c && km(centroid, { lat: c.lat, lng: c.lon }) <= MAX_KM;
      }));
      if (cand) {
        best = cand;
        via = 'oceania-russian';
        claimed.add(`${cand.el.type}/${cand.el.id}`);
      }
    }

    // 2c. otherwise every place of worship near the suburb, matched on the
    // dedication. Catches parishes OSM tags as plainly "orthodox".
    if (!best) {
      try {
        const res = await overpass(cacheDir, centroid.lat, centroid.lng);
        const cand = pickBuilding(p.name, (res.elements || [])
          .filter((el) => !claimed.has(`${el.type}/${el.id}`)));
        if (near(cand)) {
          best = cand;
          via = 'suburb-search';
          claimed.add(`${cand.el.type}/${cand.el.id}`);
        }
      } catch (err) {
        log(`  overpass failed for ${suburb}: ${err.message}`);
      }
    }

    if (best) {
      out.push({
        ...p,
        suburb,
        lat: +best.centre.lat.toFixed(6),
        lng: +best.centre.lon.toFixed(6),
        address: researched?.address || osmAddress(best.tags) || null,
        address_source: researched ? researched.source : 'openstreetmap',
        timezone,
        resolved_state: resolvedState,
        resolved_iso: iso,
        country_resolved: country,
        confidence: 'building',
        matched_via: via,
        osm: `${best.el.type}/${best.el.id}`,
        osm_name: best.tags.name || null,
        osm_denomination: best.tags.denomination || null,
        km_from_suburb: +km(centroid, { lat: +best.centre.lat, lng: +best.centre.lon }).toFixed(2),
        note: [researched?.note, fix?.why, stateNote].filter(Boolean).join('; ') || null,
      });
      log(`  building  ${key}  ->  ${best.tags.name} (${best.el.type}/${best.el.id}, ${via})`);
      continue;
    }

    // 3. a researched street address, which usually lands on the street
    if (researched) {
      const addr = await nominatim(cacheDir, researched.address, cc);
      const a = addr[0];
      if (a) {
        const level = /place_of_worship|building|amenity/.test(`${a.class}/${a.type}`) ? 'building' : 'street';
        out.push({
          ...p,
          suburb,
          lat: +(+a.lat).toFixed(6),
          lng: +(+a.lon).toFixed(6),
          address: researched.address,
          address_source: researched.source,
          timezone,
          resolved_state: a.address?.state || resolvedState,
          country_resolved: a.address?.country || country,
          confidence: level,
          osm: `${a.osm_type}/${a.osm_id}`,
          osm_name: null,
          note: [researched.note, fix?.why, stateNote].filter(Boolean).join('; ') || null,
        });
        log(`  ${level.padEnd(8)}  ${key}  ->  ${researched.address}`);
        continue;
      }
    }

    // 4. the suburb centroid, and say so
    out.push({
      ...p,
      suburb,
      lat: +centroid.lat.toFixed(6),
      lng: +centroid.lng.toFixed(6),
      address: researched?.address || null,
      address_source: researched?.source || null,
      timezone,
      resolved_state: resolvedState,
      country_resolved: country,
      confidence: 'suburb',
      osm: null,
      osm_name: null,
      note: [researched?.note, fix?.why, stateNote,
        `no matching place of worship in OSM within ${RADIUS_M / 1000}km; this is the suburb centroid`].filter(Boolean).join('; '),
    });
    log(`  SUBURB    ${key}`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const input = process.argv[2] || './rocor-scraped.json';
  const cacheDir = process.argv[3] || './cache/geo';
  const output = process.argv[4] || './rocor-geocoded.json';

  const scraped = JSON.parse(await readFile(input, 'utf8'));
  console.log(`geocoding ${scraped.parishes.length} parishes\n`);
  const rows = await geocodeAll(scraped, cacheDir, (m) => console.log(m));

  const tally = {};
  for (const r of rows) tally[r.confidence] = (tally[r.confidence] || 0) + 1;
  console.log('\nconfidence:', tally);
  const zones = {};
  for (const r of rows) zones[r.timezone || '(none)'] = (zones[r.timezone || '(none)'] || 0) + 1;
  console.log('timezones:', zones);
  console.log(`addresses: ${rows.filter((r) => r.address).length}/${rows.length}`);
  for (const r of rows) {
    if (r.note && /directory files/.test(r.note)) console.log(`\n  STATE  ${r.name} - ${r.suburb}: ${r.note}`);
  }

  await writeFile(output, JSON.stringify({ ...scraped, geocoded_at: new Date().toISOString(), parishes: rows }, null, 1));
  console.log(`\nwrote ${output}`);
}
