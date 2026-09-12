// Scrape the Serbian Orthodox Metropolitanate of Australia and New Zealand.
//
// Step 1 of the pipeline in docs/parish-ingestion.md: fetch and parse to JSON,
// with no geocoding and no writes, so the result can be read before anything
// is placed or written. Step 2 is scripts/geocode-serbian.mjs.
//
// THE SOURCE. soc.org.au is the Metropolitanate's own site and is the only one
// this needs — no aggregator, which is the rule in the brief and the thing the
// ROCOR run could not honour. It is WordPress with the real post types exposed:
//
//     /wp-json/wp/v2/parish      45 parishes   (x-wp-total; per_page defaults to 2)
//     /wp-json/wp/v2/monastery    4 monasteries and sketes
//     /wp-json/wp/v2/state        the state taxonomy each of those carries
//
// Monasteries are in scope for the same reason ROCOR's were: they hold public
// services, which is the only test that matters for a feed of services.
//
// WHAT THE REST PAYLOAD DOES NOT CARRY IS THE ADDRESS. `content` is absent and
// `acf` comes back an empty array, so every address is read off the parish's
// own page — which is a plain, uniform template: an <h3> label (Address, Email,
// Phone Number(s), Additional Information) followed by the value. The brief
// predicted the label would read "Postal address:"; it now reads "Address",
// and the value is a street address rather than a PO box on every one of the
// 49 pages. Both labels are accepted here so a revert does not silently empty
// the field.
//
// AND THE TITLES DO NOT CARRY THE SUBURB, which is the thing that shapes the
// rest of this file. Five parishes are called "St Sava Serbian Orthodox
// Church" and four "St Nicholas"; the id convention is
// <jurisdiction>-<dedication>-<suburb> and the stored name is
// "<dedication>, <suburb>", so the suburb has to be recovered from the address
// before a row can be named or identified at all. A run that skipped a page
// would not produce a badly-named parish, it would produce a collision.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const SITE = 'https://soc.org.au';
const API = `${SITE}/wp-json/wp/v2`;
const DIRECTORY = `${SITE}/parish/`;

// Provisional only, and only where a page's address cannot be parsed: the real
// zone comes from the geocoded ISO code in step 2. The site's own state
// taxonomy is a WordPress term, not a location — the ROCOR run is the reason
// that distinction is written down (it filed Tweed Heads under Queensland, and
// Tweed Heads observes daylight saving).
const ZONE_BY_STATE = {
  'New South Wales': 'Australia/Sydney',
  'Australian Capital Territory': 'Australia/Sydney',
  Victoria: 'Australia/Melbourne',
  Queensland: 'Australia/Brisbane',
  Tasmania: 'Australia/Hobart',
  'South Australia': 'Australia/Adelaide',
  'Western Australia': 'Australia/Perth',
  'Northern Territory': 'Australia/Darwin',
  'New Zealand': 'Pacific/Auckland',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Fetch once, then read from disk forever. One pass over the site, ever.
 *
 * Retried on 5xx because LiteSpeed answers 503 to the occasional request that
 * curl gets a 200 for a second later — nothing to do with the crawl rate, and
 * a run that dies on the first page of 49 leaves a half-filled cache and no
 * output to read. 4xx is not retried: that is an answer, not a hiccup.
 */
async function cached(cacheDir, name, url, attempt = 1) {
  const path = join(cacheDir, name);
  try { return await readFile(path, 'utf8'); } catch { /* not cached yet */ }
  let res;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'agora-parish-import/1.0 (+https://agora.orthodoxy.au)' },
      signal: AbortSignal.timeout(45000),
    });
  } catch (err) {
    if (attempt >= 4) throw new Error(`${url} -> ${err.message}`);
    await sleep(2000 * attempt);
    return cached(cacheDir, name, url, attempt + 1);
  }
  if (res.status >= 500 && attempt < 4) {
    await sleep(2000 * attempt);
    return cached(cacheDir, name, url, attempt + 1);
  }
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const body = await res.text();
  await writeFile(path, body);
  await sleep(400);   // a directory of 49 pages is not a load test
  return body;
}

const decode = (s) => String(s || '')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"')
  .replace(/&#8211;|&ndash;/g, '–').replace(/&#8217;|&rsquo;/g, "'")
  .replace(/\s+/g, ' ').trim();

/**
 * TITLE CASE, because the directory is written in capitals.
 *
 * Not a general title-caser: it only has to handle church names, where the
 * hard parts are the honorifics ("STS", "ST."), the words that stay lower
 * ("of", "the", "and"), and hyphenated titles that are two words each needing
 * a capital ("Co-Cathedral", "Protopresbyter-Stavrophor"). A first word is
 * always capitalised however small it is.
 */
const LOWER = new Set(['of', 'the', 'and', 'in', 'on', 'at', 'to', 'for', 'a']);
function titleCase(s) {
  const words = decode(s).toLowerCase().split(' ');
  return words.map((w, i) => {
    if (i > 0 && LOWER.has(w)) return w;
    return w.split('-').map((part) => part.replace(/^[a-zà-ÿ]/, (c) => c.toUpperCase())).join('-');
  }).join(' ');
}

// The generic tail every entry carries. "St Sava Serbian Orthodox Church" and
// "St Sava Serbian Orthodox Parish" are the same kind of name, and neither
// word distinguishes anything: 45 of 49 entries end in one of them.
const GENERIC_TAIL =
  /\s*(serbian\s+)?orthodox\s+(church\s+)?(co-cathedral|pro-cathedral|cathedral|parish|church|monastery|skete)(\s+parish)?\s*$/i;

function dedicationOf(title, suburb) {
  const t = titleCase(title).replace(/\s*[–-]\s*$/, '');
  let stripped = t.replace(GENERIC_TAIL, '').trim();
  // The monasteries carry their locality inside the title, on either side of an
  // en dash: "St Sava Monastery – Elaine", "Tallong – Protection of the Most
  // Holy Theotokos". The stored name is "<dedication>, <suburb>", so leaving it
  // in writes the place twice.
  if (suburb) {
    const esc = suburb.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    stripped = stripped
      .replace(new RegExp(`\\s*[–-]\\s*${esc}\\s*$`, 'i'), '')
      .replace(new RegExp(`^\\s*${esc}\\s*[–-]\\s*`, 'i'), '')
      .trim();
  }
  // The directory spells the honorific both ways — "ST. JOHN" and "ST JOHN" —
  // and the 196 rows already in the table use the unpointed one.
  return (stripped || t).replace(/\bSt\.\s+/g, 'St ').replace(/\bSts\.\s+/g, 'Sts ');
}

/**
 * The suburb, state and postcode out of an Australian or New Zealand address.
 *
 * Australian: "14 Renwick St, Alexandria NSW 2015" — suburb then an abbreviated
 * state then four digits. New Zealand has no state, so the trailing component
 * is the suburb or city and the postcode may be absent entirely.
 *
 * The suburb is the part that matters and the part most easily got wrong: it
 * is what names the parish, what identifies it, and what the geocoder is asked
 * to confirm. When this cannot find one the row keeps `suburb: null` and is
 * reported rather than guessed at.
 */
const AU_STATES = ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'NT', 'ACT'];
const STATE_FULL = {
  NSW: 'New South Wales', VIC: 'Victoria', QLD: 'Queensland',
  SA: 'South Australia', WA: 'Western Australia', TAS: 'Tasmania',
  NT: 'Northern Territory', ACT: 'Australian Capital Territory',
};
function splitAddress(address, termState) {
  const a = cleanAddress(address);
  if (!a) return { suburb: null, state: termState || null, postcode: null };

  // "..., Alexandria NSW 2015" / "..., Alexandria, NSW, 2015" / "... NSW2015"
  const m = new RegExp(`(?:^|[,\\s])([A-Za-z'’.\\- ]{2,40}?)[,\\s]+(${AU_STATES.join('|')})\\b[,\\s]*(\\d{4})?\\s*$`, 'i').exec(a);
  if (m) {
    return {
      suburb: cleanSuburb(m[1]),
      state: STATE_FULL[m[2].toUpperCase()],
      postcode: m[3] || null,
    };
  }

  // New Zealand, which has no state abbreviation to anchor on. The shape is
  // "<street>, [suburb, ]<city>[ postcode][ New Zealand]", and where both are
  // present the SUBURB is the locality worth pinning: the parish at "315 Pt
  // Chevalier Rd, Pt Chevalier, Auckland" is in Pt Chevalier, and calling it
  // Auckland is the same error the ROCOR run found seven times over — every
  // one of those would have pinned in the right region and the wrong place.
  const parts = a.replace(/[,\s]+new zealand\s*$/i, '').split(',')
    .map((x) => x.trim()).filter(Boolean);
  const last = (parts[parts.length - 1] || '').replace(/\s+\d{4}\s*$/, '').trim();
  const postcode = (/(\d{4})\s*$/.exec(parts[parts.length - 1] || '') || [])[1] || null;
  const middle = parts.length >= 3 ? parts[parts.length - 2] : null;
  if (termState !== 'New Zealand') {
    // An Australian line with no state on it at all: "PO Box 2393 Cairns 4870".
    // The suburb is the words in front of the postcode, and the state is the
    // one the site's own taxonomy filed the parish under — which is only ever
    // trusted for the SUBURB SEARCH here, never for the timezone.
    const au = /([A-Za-z'’.\- ]{2,40}?)\s+(\d{4})\s*$/.exec(a);
    if (au) return { suburb: cleanSuburb(au[1]), state: termState || null, postcode: au[2] };
  }
  return { suburb: cleanSuburb(middle || last), state: termState || null, postcode };
}

/**
 * When the address names two localities, the one the TITLE also names wins.
 *
 * "852 Caoura Rd, Tallong, Marulan NSW 2579" is the monastery at Tallong,
 * written with the larger town beside it, and the Australia Post shape —
 * street, suburb, state, postcode — reads Marulan as the suburb. The title
 * says Tallong and so does the address; two sources agreeing on a component
 * beats a positional rule, and the suburb is what names the parish, identifies
 * it and is handed to the geocoder.
 */
function suburbFromTitle(address, title, parsed) {
  if (!address || !title || !parsed) return parsed;
  const words = titleCase(title);
  for (const part of cleanAddress(address).split(',').map((x) => x.trim())) {
    const place = cleanSuburb(part.replace(new RegExp(`\\b(${AU_STATES.join('|')})\\b.*$`, 'i'), ''));
    if (!place || place === parsed) continue;
    if (/^\d/.test(part)) continue;                       // the street line
    if (new RegExp(`\\b${place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(words)) return place;
  }
  return parsed;
}

// A PO box is a place to send mail, not a place to stand.
//
// Four of the 49 publish one and nothing else. Geocoding it pins the post
// office, or the middle of the locality, and says nothing about either — so
// the address is dropped and the row goes to the geocoder with a suburb and a
// name, which is what actually finds a church.
const PO_BOX = /^\s*(gpo\s+box|po\s+box|p\.o\.\s*box|locked\s+bag|private\s+bag)\b/i;
const isPoBox = (a) => PO_BOX.test(cleanAddress(a).replace(/^.*?,\s*/, '')) || PO_BOX.test(cleanAddress(a));

// The template's label leaks into its own value on one page — "Postal address:
// 174 Station Rd, Sunnybank, QLD 4109" — which is the old label the brief
// predicted, still typed by hand into the field below the new one.
function cleanAddress(address) {
  return decode(address)
    .replace(/^\s*(postal\s+address|address)\s*:?\s*/i, '')
    .replace(/\s*,\s*/g, ', ')
    .replace(/\.$/, '')
    .trim();
}

// A suburb is words, not a street number and not a unit. "Level 1" and "PO Box
// 25" are the two shapes that reach here and neither is a place.
function cleanSuburb(s) {
  const t = decode(s).replace(/^[\d/\-\s]+/, '').trim();
  if (!t || /^(po box|locked bag|level|unit|suite)\b/i.test(t)) return null;
  return titleCase(t);
}

/** One <h3>Label</h3> section's value, from the parish page template. */
function section(html, label) {
  const re = new RegExp(`<h3[^>]*>(?:<i[^>]*>\\s*</i>)?\\s*${label}\\s*</h3>([\\s\\S]{0,600}?)</div>`, 'i');
  const m = re.exec(html);
  return m ? m[1] : '';
}
const textOf = (fragment) => decode(String(fragment).replace(/<[^>]+>/g, ' '));

function parsePage(html, entry, stateName) {
  const addrBlock = section(html, 'Address') || section(html, 'Postal address:?');
  // The value sits in <p class="lead">, and the "Get Directions" button that
  // follows it is an anchor whose text would otherwise land in the address.
  const address = textOf((/<p[^>]*class="[^"]*lead[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(addrBlock) || [])[1] || '');

  const email = (/<a[^>]+href="mailto:([^"]+)"/i.exec(section(html, 'Email')) || [])[1] || null;
  const phone = (/<a[^>]+href="tel:([^"]+)"/i.exec(section(html, 'Phone Number\\(s\\)')) || [])[1] || null;

  // "Website: www.lazarica.org.au", occasionally with an <a> around it and
  // occasionally with nothing at all.
  const info = section(html, 'Additional Information');
  const infoText = textOf(info);
  const site = (/<a[^>]+href="(https?:\/\/[^"]+)"/i.exec(info) || [])[1]
    || (/(?:web\s*site|website)\s*:?\s*((?:https?:\/\/)?[\w.-]+\.[a-z]{2,}(?:\/\S*)?)/i.exec(infoText) || [])[1]
    || null;

  const parsed = splitAddress(address, stateName);
  const suburb = suburbFromTitle(address, entry.title.rendered, parsed.suburb);
  const { state, postcode } = parsed;
  const vague = !address || isPoBox(address);
  const country = (state === 'New Zealand' || stateName === 'New Zealand') ? 'New Zealand' : 'Australia';
  return {
    name: dedicationOf(entry.title.rendered, suburb),
    full_name: titleCase(entry.title.rendered).replace(/\bSt\.\s+/g, 'St ').replace(/\bSts\.\s+/g, 'Sts '),
    directory_title: decode(entry.title.rendered),
    kind: entry.type === 'monastery' ? 'monastery' : 'parish',
    slug: entry.slug,
    suburb,
    state,
    state_abbr: Object.keys(STATE_FULL).find((k) => STATE_FULL[k] === state) || null,
    country,
    postcode,
    // Kept verbatim for the report even when it cannot be pinned; the geocoder
    // reads `address_vague` and does not hand a PO box to Nominatim.
    address: cleanAddress(address) || null,
    address_vague: vague,
    email: email ? decode(email) : null,
    phone: normalisePhone(phone),
    website: site ? normaliseSite(site) : null,
    // Provisional; step 2 replaces it from the geocoded ISO code.
    timezone: ZONE_BY_STATE[state] || ZONE_BY_STATE[stateName] || null,
    // The page the address was actually read off, not the directory index.
    source_ref: entry.link,
    extra: infoText && !/^website\s*:/i.test(infoText) ? infoText : null,
  };
}

/**
 * A number somebody can actually dial.
 *
 * The site's own tel: hrefs are typed by hand and three shapes come out of
 * them: "0295161811" (fine), "296721508" — an Australian number with the trunk
 * 0 dropped — and "64224791376", a New Zealand number with the country code
 * and no plus. The last two do not dial as published, and a stored number that
 * does not dial is worse than no number: it looks like a working one.
 */
function normalisePhone(raw) {
  const p = decode(raw || '').replace(/[\s()-]/g, '');
  if (!p) return null;
  if (p.startsWith('+') || p.startsWith('0')) return p;
  if (/^64\d{8,10}$/.test(p)) return `+${p}`;        // New Zealand, plus dropped
  if (/^61\d{9}$/.test(p)) return `+${p}`;           // Australia, plus dropped
  if (/^[2-9]\d{8}$/.test(p)) return `0${p}`;        // Australia, trunk 0 dropped
  return p;
}

function normaliseSite(s) {
  const t = decode(s).replace(/[).,]+$/, '');
  return /^https?:\/\//i.test(t) ? t : `https://${t}`;
}

export async function scrape(cacheDir) {
  await mkdir(cacheDir, { recursive: true });

  // per_page=100 because the default is 2 and a run that trusts it imports two
  // parishes and reports success.
  const [parishes, monasteries, states] = await Promise.all([
    cached(cacheDir, 'parish-list.json', `${API}/parish?per_page=100`).then(JSON.parse),
    cached(cacheDir, 'monastery-list.json', `${API}/monastery?per_page=100`).then(JSON.parse),
    cached(cacheDir, 'states.json', `${API}/state?per_page=100`).then(JSON.parse),
  ]);
  const stateName = Object.fromEntries(states.map((s) => [s.id, decode(s.name)]));

  const entries = [...parishes, ...monasteries];
  const rows = [];
  const missing = [];
  for (const entry of entries) {
    const slug = entry.link.replace(/\/$/, '').split('/').pop();
    const html = await cached(cacheDir, `${entry.type}-${slug}.html`, entry.link);
    const row = parsePage(html, entry, stateName[(entry.state || [])[0]] || null);
    if (!row.address) missing.push({ ...row, why: 'no address on the page' });
    else if (row.address_vague) missing.push({ ...row, why: `a PO box, not a location: "${row.address}"` });
    else if (!row.suburb) missing.push({ ...row, why: `no suburb in "${row.address}"` });
    rows.push(row);
  }
  return { rows, missing, counts: { parishes: parishes.length, monasteries: monasteries.length } };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cacheDir = process.argv[2] || './cache/serbian';
  const out = process.argv[3] || './serbian-scraped.json';
  const { rows, missing, counts } = await scrape(cacheDir);

  console.log(`\n${rows.length} places of worship — ${counts.parishes} parishes, ${counts.monasteries} monasteries`);
  const byState = {};
  for (const r of rows) byState[r.state || '(none)'] = (byState[r.state || '(none)'] || 0) + 1;
  console.log('by state:', byState);
  console.log(`with an address: ${rows.filter((r) => r.address).length}/${rows.length}`);
  console.log(`with a suburb:   ${rows.filter((r) => r.suburb).length}/${rows.length}`);
  console.log(`with a website:  ${rows.filter((r) => r.website).length}/${rows.length}`);
  console.log(`with a phone:    ${rows.filter((r) => r.phone).length}/${rows.length}`);

  if (missing.length) {
    console.log('\nNO ADDRESS TO GEOCODE — placed by name and suburb, or not at all:');
    for (const m of missing) console.log(`  ${m.full_name}  (${m.why})`);
  }

  console.log('\nevery row:');
  for (const r of rows) {
    console.log(`  ${(r.name + ', ' + (r.suburb || '?')).padEnd(44)} ${(r.state || '?').padEnd(28)} ${r.address || ''}`);
  }

  await writeFile(out, JSON.stringify({
    source: DIRECTORY,
    scraped_at: new Date().toISOString(),
    jurisdiction: 'serbian',
    parishes: rows,
  }, null, 1));
  console.log(`\nwrote ${out}`);
}
