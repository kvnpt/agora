// Scrape the ROCOR Australian and New Zealand Diocese parish directory.
//
// Step 1 of the pipeline in docs/parish-ingestion.md: fetch and parse to JSON,
// with no geocoding and no writes, so the result can be eyeballed before
// anything is geocoded or written. Step 2 is scripts/geocode-rocor.mjs.
//
// THE SOURCE. rocor.org.au is WordPress and its pages ARE exposed through the
// REST API (unlike the Greek directory, whose church post type was not), so
// this reads wp-json rather than walking HTML. Two pages carry everything:
//
//     page 2   Directory of Parishes and Monasteries   name, suburb, state
//     page 18  Internet Links                          parish websites
//
// Page 2's rendered content is exactly 39 anchors grouped by state with no
// sidebar or calendar markup, which is why it is read through the API — the
// same directory fetched as HTML arrives wrapped in a Google Calendar widget
// that triples the anchor count.
//
// A WARNING ABOUT THE HOMEPAGE. https://rocor.org.au/ serves cloaked casino
// spam to some user agents — the WordPress root is compromised. The rest of
// the site, the REST API included, is intact and is the real diocese. So do
// not take a spam response at `/` as evidence the diocese is gone, and do not
// switch to an archive: fetch the pages, not the front door.
//
// THE DEAD DIRECTORY. 31 of the 39 anchors point at
// directory.stinnocentpress.com/viewparish.cgi?Uid=NNN, the ROCOR-wide parish
// directory that used to hold each parish's address, phone and clergy. Every
// one of those now 404s and the directory root answers 403, so the addresses
// this scrape would most like to have are simply not published any more. That
// is why geocoding here is name-first out of necessity rather than preference:
// for most of these parishes there is no address to fall back to.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchAll, attachAddresses } from './rocor-world-directory.mjs';
import { IGNORE_WORLD_DIRECTORY } from './rocor-addresses.mjs';

const API = 'https://rocor.org.au/wp-json/wp/v2/pages';
const DIRECTORY_PAGE = 2;
const LINKS_PAGE = 18;

// Entries in the directory that are not places where services happen. The
// directory is titled "Parishes and Monasteries" but also lists the diocese's
// office and its theological institute, and neither belongs in a feed of
// services. Monasteries, convents, sketes, missions and chapels DO stay: they
// hold public services, which is the only test that matters here.
const NOT_A_PLACE_OF_WORSHIP = new Set([
  'Diocesan Administration',                    // the diocesan office, Croydon
  'Sts Cyril and Methodius Orthodox Institute', // a theological college
]);

// Provisional only. The directory groups by state heading and one of those
// headings is wrong about which state a parish is in, so the real zone is
// derived from the geocoded address in step 2. See geocode-rocor.mjs.
const ZONE_BY_STATE = {
  'New South Wales': 'Australia/Sydney',
  'Victoria': 'Australia/Melbourne',
  'Queensland': 'Australia/Brisbane',
  'Tasmania': 'Australia/Hobart',
  'South Australia': 'Australia/Adelaide',
  'Australian Capital Territory': 'Australia/Sydney',
  'Western Australia': 'Australia/Perth',
  'New Zealand': 'Pacific/Auckland',
};

const STATE_ABBR = {
  'New South Wales': 'NSW',
  'Victoria': 'VIC',
  'Queensland': 'QLD',
  'Tasmania': 'TAS',
  'South Australia': 'SA',
  'Australian Capital Territory': 'ACT',
  'Western Australia': 'WA',
};

// ── fetching ───────────────────────────────────────────────────────────────

async function cachedJson(cacheDir, name, url) {
  const path = join(cacheDir, name);
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch { /* not cached yet */ }
  const res = await fetch(url, {
    headers: { 'user-agent': 'agora-parish-import/1.0 (+https://agora.orthodoxy.au)' },
  });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const body = await res.json();
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path, JSON.stringify(body, null, 1));
  return body;
}

// ── parsing ────────────────────────────────────────────────────────────────

const decode = (s) => (s || '')
  .replace(/<[^>]+>/g, '')
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCharCode(parseInt(x, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&(?:ndash|mdash|#8211|#8212);/g, '-')
  .replace(/ /g, ' ')
  .trim();

// The list is flat: a heading names a country or state, then anchors follow,
// each with its suburb in the text between the anchor and the next <br>. So
// walk headings and anchors together in document order, carrying the heading.
//
// "Heading" has to mean two different markups. The directory page uses real
// <h1>/<h2>; the Internet Links page styles its country labels as
// <p class="heading2">Canada</p>, a paragraph wearing a heading's class. Both
// are treated as headings here, because on the links page the paragraphs are
// the only thing separating one country's parishes from the next.
const HEADING = /<(h[1-6])[^>]*>([\s\S]*?)<\/\1>|<p[^>]*class="[^"]*heading\d[^"]*"[^>]*>([\s\S]*?)<\/p>/gi;

function walk(htmlText) {
  const token = new RegExp(
    `${HEADING.source}|<a\\s+href="([^"]*)"[^>]*>([\\s\\S]*?)<\\/a>((?:(?!<a\\s|<h[1-6]|<p[^>]*class="[^"]*heading\\d)[\\s\\S])*)`,
    'gi');
  const out = [];
  let heading = '';
  let level = 0;
  for (const m of htmlText.matchAll(token)) {
    if (m[1] || m[3] !== undefined) {
      heading = decode(m[1] ? m[2] : m[3]);
      level = m[1] ? +m[1].slice(1) : 2;
      out.push({ heading, level });
      continue;
    }
    const name = decode(m[5]);
    if (!name) continue;
    let trailing = decode(m[6]);
    trailing = trailing.replace(/^[\s\-–—·|,:]+/, '');
    trailing = trailing.split(/\s{2,}|\n/)[0].trim();
    out.push({ heading, level, name, href: decode(m[4]), trailing });
  }
  return out;
}

function parseDirectory(page) {
  const rows = [];
  let country = '';
  let state = '';
  for (const node of walk(page.content.rendered)) {
    if (node.name === undefined) {
      // The two country blocks are marked up inconsistently: Australia is an
      // <h1>, New Zealand an <h2> that reads like one ("Parishes and
      // Monasteries in New Zealand") and carries no state heading beneath it.
      // So match on the text, not the level — New Zealand is its own state for
      // timezone purposes anyway.
      if (/New Zealand/i.test(node.heading)) {
        country = 'New Zealand';
        state = 'New Zealand';
      } else if (/^Parishes and Monasteries/i.test(node.heading)) {
        country = 'Australia';
        state = '';
      } else {
        state = node.heading;
      }
      continue;
    }
    rows.push({
      name: node.name,
      suburb: node.trailing,
      country,
      state,
      state_abbr: STATE_ABBR[state] || null,
      directory_link: node.href,
      timezone_provisional: ZONE_BY_STATE[state] || null,
    });
  }
  return rows;
}

// Websites come from a different page whose names disagree with the directory's
// ("Joy of All Who Sorrow Church" for "Church of Icon of the Joy of All Who
// Sorrow", "Saint" for "St."), so they are matched on distinctive tokens rather
// than on the name as published. Matches are printed for review.
const STOP = new Set(['the', 'of', 'our', 'and', 'a', 'an', 'in', 'at', 'for',
  'church', 'parish', 'orthodox', 'cathedral', 'monastery', 'convent', 'skete',
  'chapel', 'community', 'mission', 'russian', 'diocesan', 'st', 'sts', 'saint',
  'saints', 'holy', 'lady', 'icon']);

const tokens = (s) => new Set((s || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().split(/[^a-z0-9]+/)
  .filter((w) => w && !STOP.has(w))
  .map((w) => w.replace(/s$/, '')));

// The two pages disagree about how precisely to name a place: the directory
// gives the suburb, the links page sometimes gives the metropolitan area. Both
// are right, so the alias lets them compare equal. Only these four collide;
// everything else agrees to the token ("West Gosford"/"Gosford", "Monarto
// South"/"Monarto", "Bayswater"/"Bayswater, Perth").
const METRO = {
  'east brunswick': 'melbourne',
  'bell park': 'geelong',
  wayville: 'adelaide',
  woolloongabba: 'brisbane',
};

// Suburb tokens plus the metro it sits in, so a suburb and its city match.
function place(suburb) {
  const set = tokens(suburb);
  const key = (suburb || '').toLowerCase().trim();
  if (METRO[key]) set.add(METRO[key]);
  // ...and the other way round, so the links page's "Melbourne" reaches the
  // directory's "East Brunswick".
  for (const [sub, metro] of Object.entries(METRO)) {
    if (set.has(metro)) for (const w of tokens(sub)) set.add(w);
  }
  return set;
}

function parseLinks(page) {
  const html = page.content.rendered;
  const start = html.indexOf('Parishes and Monasteries of the ROCOR');
  if (start < 0) throw new Error('Internet Links page changed shape: parish section not found');
  const out = [];
  for (const node of walk(html.slice(start))) {
    if (node.name === undefined) { out.push({ label: node.heading }); continue; }
    out.push({ name: node.name, suburb: node.trailing, href: node.href });
  }
  // The page runs through every ROCOR diocese worldwide, Australia first. Cut
  // at the "Canada" label, then add back the one New Zealand parish, which is
  // filed near the bottom beside Haiti rather than with its own diocese.
  const canada = out.findIndex((r) => r.label && /^Canada$/i.test(r.label));
  const auNz = canada > 0 ? out.slice(0, canada) : out;
  const strays = out.slice(canada > 0 ? canada : out.length)
    .filter((r) => r.name && /New Zealand/i.test(r.suburb || ''));
  return [...auNz, ...strays]
    .filter((r) => r.name && /^https?:/i.test(r.href))
    .filter((r) => !/stinnocentpress|rocor\.org\.au\/?$/i.test(r.href));
}

// A parish's own site, if the directory or the links page names one. The dead
// St Innocent directory is never a website; a rocor.org.au page IS, because for
// two parishes it is the only page they have.
const isUsableSite = (href) => /^https?:/i.test(href)
  && !/directory\.stinnocentpress\.com/i.test(href)
  && !/^https?:\/\/(www\.)?rocor\.org\.au\/?$/i.test(href);

function attachWebsites(rows, links) {
  const report = [];
  for (const row of rows) {
    if (isUsableSite(row.directory_link)) {
      row.website = row.directory_link;
      row.website_source = 'directory';
      continue;
    }
    const want = tokens(row.name);
    const here = place(row.suburb);
    // Dedication AND place must both agree. Dedication alone is not enough:
    // there are three St Nicholas parishes in three states, and "Protection of
    // the Holy Virgin" names both Cabramatta and the Melbourne cathedral. Place
    // alone is not enough either — Woolloongabba has two parishes.
    const hits = links.filter((l) => {
      const have = tokens(l.name);
      if (![...want].some((w) => have.has(w))) return false;
      const there = place(l.suburb);
      return [...here].some((w) => there.has(w));
    });
    if (hits.length === 1) {
      row.website = hits[0].href;
      row.website_source = 'internet-links';
      report.push(`  matched  ${row.name} - ${row.suburb}  ->  ${hits[0].name} - ${hits[0].suburb}  ${hits[0].href}`);
    } else if (hits.length > 1) {
      row.website = null;
      row.website_source = null;
      report.push(`  AMBIGUOUS ${row.name} - ${row.suburb}  ->  ${hits.map((h) => h.name).join(' | ')}`);
    } else {
      row.website = null;
      row.website_source = null;
    }
  }
  return report;
}

// ── main ───────────────────────────────────────────────────────────────────

export async function scrape(cacheDir) {
  const pages = await cachedJson(cacheDir, 'wp-pages.json',
    `${API}?per_page=100&_fields=id,link,title,content`);
  const byId = new Map(pages.map((p) => [p.id, p]));
  const directory = byId.get(DIRECTORY_PAGE);
  const links = byId.get(LINKS_PAGE);
  if (!directory) throw new Error(`page ${DIRECTORY_PAGE} (the directory) is gone`);
  if (!links) throw new Error(`page ${LINKS_PAGE} (Internet Links) is gone`);

  const all = parseDirectory(directory);
  const kept = all.filter((r) => !NOT_A_PLACE_OF_WORSHIP.has(r.name));
  const dropped = all.filter((r) => NOT_A_PLACE_OF_WORSHIP.has(r.name));
  const report = attachWebsites(kept, parseLinks(links));

  // The diocese publishes no addresses at all, so they come from the World
  // Orthodox Directory, matched on state and dedication. See
  // scripts/rocor-world-directory.mjs for why that is a second source rather
  // than the source.
  let addressReport = [];
  try {
    addressReport = attachAddresses(kept, await fetchAll(join(cacheDir, 'world')), IGNORE_WORLD_DIRECTORY);
  } catch (err) {
    addressReport = [`  the World Orthodox Directory could not be read (${err.message}); rows carry no address`];
  }

  return { rows: kept, dropped, report, addressReport, sourceUrl: directory.link };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cacheDir = process.argv[2] || './cache';
  const out = process.argv[3] || './rocor-scraped.json';
  const { rows, dropped, report, addressReport, sourceUrl } = await scrape(cacheDir);

  console.log(`\n${rows.length} places of worship (${dropped.length} dropped as not one)`);
  for (const d of dropped) console.log(`  dropped  ${d.name} - ${d.suburb}`);
  console.log('\nwebsite matching:');
  for (const line of report) console.log(line);
  console.log('\naddresses, from the World Orthodox Directory:');
  for (const line of addressReport) console.log(line);

  const byState = {};
  for (const r of rows) byState[r.state] = (byState[r.state] || 0) + 1;
  console.log('\nby state:', byState);
  console.log(`with a website: ${rows.filter((r) => r.website).length}/${rows.length}`);
  console.log(`with an address: ${rows.filter((r) => r.directory_address).length}/${rows.length}`);

  await writeFile(out, JSON.stringify({
    source: sourceUrl,
    scraped_at: new Date().toISOString(),
    jurisdiction: 'russian',
    parishes: rows,
  }, null, 1));
  console.log(`\nwrote ${out}`);
}
