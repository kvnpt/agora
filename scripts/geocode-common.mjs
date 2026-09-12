// The parts of a parish geocode that do not change between jurisdictions.
//
// WHY THIS EXISTS. `docs/parish-ingestion.md` says the fetching and parsing is
// written fresh per directory — every site differs — but that "the tiering, the
// caching and the reports transfer directly". By the third jurisdiction that
// had stopped being an observation and started being duplication: the timezone
// table, the locality check, the throttled cache and the distance helper are
// character-for-character the same work, and every one of them encodes a bug
// that cost a previous run real time. Those belong in one place with tests on
// them, so the next directory inherits the lessons rather than re-learning them.
//
// What is NOT here is anything that knows about a particular jurisdiction: the
// denomination to search for, which dedications are synonyms, which addresses
// were researched by hand. That lives in the per-jurisdiction script, because
// that is the part that is genuinely different each time.
//
// `scripts/geocode-rocor.mjs` predates this module and still carries its own
// copies. It is left alone deliberately — it is the record of a run that wrote
// 37 production rows, it has no test coverage to refactor against, and the only
// thing a rewrite could buy is tidiness.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
// overpass-api.de is unreachable from this environment entirely — every query,
// however small, closes mid-exchange. The kumi mirror answers in about a second.
export const OVERPASS = 'https://overpass.kumi.systems/api/interpreter';
export const UA = 'agora-parish-import/1.0 (+https://agora.orthodoxy.au)';

// Every Australian and New Zealand place of worship in one bounding box.
export const OCEANIA_BBOX = '-48,112,-9,180';

// Nominatim asks for one request per second. Overpass publishes no rate and
// deserves the same courtesy; both are free services doing us a favour.
export const PAUSE_MS = 1100;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * IANA zone per ISO 3166-2 subdivision.
 *
 * Read `ISO3166-2-lvl4`, never `address.state`: Nominatim returns the ACT under
 * `territory` rather than `state`, which left Canberra with no timezone at all.
 * Australia/Sydney covers the ACT; there is no Australia/Canberra worth using.
 */
export const ZONE_BY_ISO = {
  'AU-NSW': 'Australia/Sydney',
  'AU-VIC': 'Australia/Melbourne',
  'AU-QLD': 'Australia/Brisbane',
  'AU-TAS': 'Australia/Hobart',
  'AU-SA': 'Australia/Adelaide',
  'AU-ACT': 'Australia/Sydney',
  'AU-NT': 'Australia/Darwin',
  'AU-WA': 'Australia/Perth',
};

export const ZONE_BY_STATE = {
  'New South Wales': 'Australia/Sydney',
  Victoria: 'Australia/Melbourne',
  Queensland: 'Australia/Brisbane',
  Tasmania: 'Australia/Hobart',
  'South Australia': 'Australia/Adelaide',
  'Australian Capital Territory': 'Australia/Sydney',
  'Northern Territory': 'Australia/Darwin',
  'Western Australia': 'Australia/Perth',
};

/**
 * The timezone for a Nominatim result.
 *
 * New Zealand's regions all keep Pacific/Auckland — only the Chathams differ,
 * and no parish is there — so the country short-circuits the subdivision.
 */
export function zoneFor(address) {
  if (!address) return null;
  if ((address.country_code || '').toLowerCase() === 'nz') return 'Pacific/Auckland';
  return ZONE_BY_ISO[address['ISO3166-2-lvl4']]
    || ZONE_BY_STATE[address.state || address.territory]
    || null;
}

/** Great-circle distance in km, to sanity-check a match against its suburb. */
export function km(a, b) {
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
// before "Blacktown" — and a council centroid can be kilometres from the church.
const PLACE_TYPES = new Set(['suburb', 'town', 'village', 'city', 'neighbourhood',
  'hamlet', 'locality', 'quarter', 'borough']);

/**
 * A locality name reduced to a sorted set of words.
 *
 * Sorted, because the two sources disagree about order: a directory writes
 * "East Brunswick" where OSM writes "Brunswick East", and they are one place.
 */
export const placeKey = (v) => (v || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).sort()
  .join(' ');

const isPlace = (r) => (r.class === 'place' && PLACE_TYPES.has(r.type))
  || (r.class === 'boundary' && r.type === 'administrative')
  || PLACE_TYPES.has(r.addresstype);

/**
 * The result that actually IS the suburb, or null.
 *
 * A state-constrained locality query fails by returning the WRONG PLACE, not
 * nothing. Constrained to Queensland, "Tweed Heads" comes back as Tweed Heads
 * Avenue — a residential street 80km away in North Tamborine — so a run taking
 * results[0] pinned that parish in the wrong state and never said so. The first
 * component of the display name therefore has to name the suburb, and a result
 * that names something else is treated as no result at all.
 */
export function preferLocality(results, suburb) {
  const want = placeKey(suburb);
  const named = (results || []).filter((r) => isPlace(r)
    && placeKey((r.display_name || '').split(',')[0]) === want);
  return named[0] || (results || []).find((r) => r.class === 'place' && PLACE_TYPES.has(r.type)) || null;
}

/** An OSM element's point, whether it is a node or a way/relation with a centre. */
export const centreOf = (el) => el?.center
  || (el?.lat != null ? { lat: el.lat, lon: el.lon } : null);

/** The street address OSM holds for a building, if it holds one. */
export const osmAddress = (tags = {}) => {
  const line = [tags['addr:housenumber'], tags['addr:street']].filter(Boolean).join(' ');
  const rest = [tags['addr:suburb'] || tags['addr:city'], tags['addr:state'], tags['addr:postcode']]
    .filter(Boolean).join(' ');
  return [line, rest].filter(Boolean).join(', ') || null;
};

// ── fetching: deadlines, retries, throttle, cache ──────────────────────────

// Node's fetch has NO DEFAULT TIMEOUT, and Overpass answers a query it dislikes
// by holding the connection open rather than refusing it — which stops a run
// dead with nothing to read. Every request gets a deadline.
export const DEADLINE_MS = 90_000;
export const ATTEMPTS = 3;

export async function fetchJson(url, label, { attempts = ATTEMPTS, deadline = DEADLINE_MS } = {}) {
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

export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

/**
 * A throttled, disk-cached call. Caching every response on the first fetch is
 * what makes the parsing iterative at a cost to the service of one pass.
 */
export function makeCache(cacheDir) {
  let lastCall = 0;
  return async function cached(key, run) {
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
  };
}

/** Nominatim free-form search, cached. */
export const nominatim = (cached, query, countrycodes) => cached(
  `nom-${slug(query)}`,
  () => fetchJson(`${NOMINATIM}?${new URLSearchParams({
    q: query, format: 'json', limit: '5', addressdetails: '1', countrycodes,
  })}`, `nominatim "${query}"`),
);

/**
 * Nominatim STRUCTURED search, cached.
 *
 * Worth its own entry point: free-form left 28 of the 135 Greek parishes
 * unplaced because "St" reads as Saint, house-number ranges miss, and dotted
 * `N.S.W` is not a state. Handing the parts over separately recovered 25.
 */
export const nominatimStructured = (cached, parts, countrycodes) => {
  const params = new URLSearchParams({ format: 'json', limit: '5', addressdetails: '1', countrycodes });
  for (const [k, v] of Object.entries(parts)) if (v) params.set(k, v);
  return cached(`nomq-${slug(Object.values(parts).filter(Boolean).join(' '))}`,
    () => fetchJson(`${NOMINATIM}?${params}`, `nominatim structured ${JSON.stringify(parts)}`));
};

/** An Overpass query, cached. */
export const overpass = (cached, key, body, opts) => cached(key,
  () => fetchJson(`${OVERPASS}?data=${encodeURIComponent(body)}`, `overpass ${key}`, opts));

/**
 * Every place of worship in Oceania whose denomination matches `denomination`.
 *
 * ONE bbox-wide query is the best single source there is: cheap, and the tag
 * asserts the jurisdiction for you, so a St Nicholas it answers is not the
 * Greek St Nicholas down the road. Per-suburb searches 504 on dense inner
 * Sydney or Melbourne; this does not.
 */
export const denominationInOceania = (cached, denomination) => overpass(cached,
  `ovp-oceania-${denomination}`,
  `[out:json][timeout:180];nwr["amenity"="place_of_worship"]["denomination"~"${denomination}",i](${OCEANIA_BBOX});out center tags;`);
