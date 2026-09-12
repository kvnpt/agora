// Addresses for ROCOR parishes, from the World Orthodox Directory.
//
// WHY A SECOND SOURCE. The diocese's own directory publishes a name, a suburb
// and a link, and 31 of its 39 links point at the ROCOR-wide St Innocent Press
// directory, which used to carry the addresses and now answers 404 for every
// parish and 403 at its root. orthodox-world.org lists the same diocese —
// "Diocese of Sydney, Australia and New Zealand", 43 entries across Australia
// and New Zealand — with a street address on every one of them.
//
// It is a third party rather than the diocese, so it is treated as a source to
// be checked and not as truth: where a parish publishes its own address, that
// one wins (see scripts/rocor-addresses.mjs), and where the two disagree the
// disagreement is recorded rather than resolved.
//
// WHAT IT REVEALS. The diocese's own suburbs are wrong more often than its
// addresses would have been. Holy Dormition is filed under "Woollongong" and is
// in Corrimal; Holy Transfiguration Monastery is filed under Bombala and is at
// Gunningrah; the Hobart church is in Lenah Valley and the Canberra one in
// Narrabundah. A pin built from the published suburb would have been in the
// right region and the wrong place, every time.
//
// MATCHING. Entries are matched to directory rows on STATE plus dedication,
// never on suburb, because the suburb is the field the two sources disagree
// about. Where a state holds two parishes with the same dedication — NSW has
// two St Nicholas, Woolloongabba two parishes — the suburb breaks the tie, and
// anything still ambiguous is reported for a person rather than guessed.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = 'https://orthodox-world.org';
// The diocese page splits its parishes across six category listings —
// cathedrals, churches, chapels, monasteries, missions, sketes.
const DIOCESE = 'diocese-of-sydney-australia-and-new-zealand';
const CATEGORIES = [1, 2, 3, 4, 5, 6];
const UA = 'agora-parish-import/1.0 (+https://agora.orthodoxy.au)';

const PAUSE_MS = 1100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const entities = (s) => (s || '')
  .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
  .replace(/&#x([0-9a-f]+);/gi, (_, x) => String.fromCharCode(parseInt(x, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/\u00a0/g, ' ');

// Every tag becomes a NEWLINE, not a space. On these pages a field is a label
// element followed by a value element, so "Address:" and the street sit on
// separate lines, and that line break is the only thing marking where the value
// ends. Collapse the newlines and the address field runs on into the rest of
// the page — several kilobytes of donation copy, matched as an address.
const toText = (html) => entities(html
  .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<[^>]+>/g, '\n'))
  .replace(/[ \t]+/g, ' ')
  .replace(/ *\n */g, '\n')
  .replace(/\n{2,}/g, '\n')
  .trim();

let lastCall = 0;
async function cachedText(cacheDir, key, url) {
  const path = join(cacheDir, `${key}.html`);
  try {
    const hit = await readFile(path, 'utf8');
    if (hit.length) return hit;
  } catch { /* not cached */ }
  const wait = PAUSE_MS - (Date.now() - lastCall);
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(45_000) });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  const body = await res.text();
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path, body);
  return body;
}

// Each listing page links its parishes as
// /en/i/<id>/<country>/<state>/<suburb>/<kind>/<slug>
const LINK = /\/en\/i\/(\d+)\/([a-z-]+)\/([a-z-]+)\/([a-z0-9-]+)\/([a-z]+)\/[a-z0-9-]+/g;

export async function listParishes(cacheDir) {
  const seen = new Map();
  for (const n of CATEGORIES) {
    const html = await cachedText(cacheDir, `dt-${n}`, `${BASE}/dt/324/${n}/${DIOCESE}`);
    for (const m of html.matchAll(LINK)) {
      const [path, id, country, state, suburb] = m;
      // The diocese also oversees missions in Indonesia; this import covers
      // Oceania, and the basemap has no tiles for anywhere else.
      if (country !== 'australia' && country !== 'new-zealand') continue;
      if (!seen.has(id)) seen.set(id, { id, path, country, state, suburb });
    }
  }
  return [...seen.values()];
}

// A label sits on its own line and its value on the next, so the pattern is
// anchored to both ends of a line. Matched loosely — `Address:\s*(.+)` — the
// address field runs on and swallows the rest of the page.
const FIELD = (text, label) => {
  const m = new RegExp(`^${label}:[ \\t]*\\n(.+)$`, 'im').exec(text);
  return m ? m[1].trim() : null;
};

export async function fetchEntry(cacheDir, entry) {
  const html = await cachedText(cacheDir, `pages/${entry.id}`, `${BASE}${entry.path}`);
  const text = toText(html);
  const title = /^(.*?) - World Orthodox Directory/s.exec(text.trim());
  return {
    ...entry,
    name: title ? title[1].trim() : null,
    address: FIELD(text, 'Address'),
    phone: FIELD(text, 'Phone'),
    website: FIELD(text, 'Url'),
    jurisdiction: FIELD(text, 'Semi-autonomous Church'),
  };
}

export async function fetchAll(cacheDir) {
  const out = [];
  for (const entry of await listParishes(cacheDir)) out.push(await fetchEntry(cacheDir, entry));
  return out;
}

// ── matching ───────────────────────────────────────────────────────────────

const GENERIC = new Set(['the', 'of', 'our', 'and', 'a', 'an', 'in', 'at', 'for',
  'church', 'parish', 'orthodox', 'cathedral', 'monastery', 'convent', 'skete',
  'chapel', 'community', 'mission', 'russian', 'diocesan', 'st', 'sts', 'saint',
  'saints', 'holy', 'lady', 'icon', 'australia', 'new', 'zealand']);

const toks = (s) => new Set((s || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().split(/[^a-z0-9]+/)
  .filter((w) => w && !GENERIC.has(w))
  .map((w) => w.replace(/s$/, '')));

// The same dedications the two sources word differently.
const SYNONYM = [
  ['protection', 'intercession', 'pokrov'],
  ['dormition', 'assumption'],
  ['forerunner', 'baptist'],
  ['vladimir', 'wladimir'],
  ['xenia', 'ksenia'],
  ['elias', 'elijah'],
  ['savior', 'saviour'],
];

const expand = (set) => {
  const out = new Set(set);
  for (const g of SYNONYM) if (g.some((w) => out.has(w))) for (const w of g) out.add(w);
  return out;
};

const STATE_SLUG = {
  'New South Wales': 'new-south-wales',
  'Victoria': 'victoria',
  'Queensland': 'queensland',
  'Tasmania': 'tasmania',
  'South Australia': 'south-australia',
  'Australian Capital Territory': 'australian-capital-territory',
  'Western Australia': 'western-australia',
};

const flat = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Attach a World Orthodox Directory address to each scraped row.
 *
 * Matches on state plus dedication. Never on suburb — that is the field the two
 * sources disagree about, and the disagreements are the useful part.
 */
export function attachAddresses(rows, entries, ignore = {}) {
  const report = [];
  for (const row of rows) {
    const key = `${row.name} | ${row.suburb}`;
    if (ignore[key]) {
      report.push(`  IGNORED         ${key} — ${ignore[key].why.split('.')[0]}.`);
      continue;
    }
    const state = row.country === 'New Zealand' ? null : STATE_SLUG[row.state];
    const want = expand(toks(row.name));
    let hits = entries.filter((e) => {
      if (state && e.state !== state) return false;
      if (!state && e.country !== 'new-zealand') return false;
      return [...want].some((w) => expand(toks(e.name)).has(w));
    });

    // The directory lists Holy Dormition twice — once under Corrimal and once
    // under "wollongong-" — so two hits at the same street are one parish listed
    // twice, not an ambiguity. Compared on the street rather than the whole
    // string, because the two listings punctuate it differently: "61 Wilford St,
    // Corrimal, New South Wales" against "61 Wilford St Corrimal NSW ,
    // Wollongong , New South Wales".
    if (hits.length > 1) {
      const streets = hits.map((e) => flat((e.address || '').split(',')[0]));
      const sameStreet = streets.every((s) => s && (s.startsWith(streets[0]) || streets[0].startsWith(s)));
      // Keep the tidier of the two: the duplicate reached the directory by
      // having its whole address typed into the suburb field as well.
      if (sameStreet) {
        hits = [hits.slice().sort((a, b) => (a.address || '').length - (b.address || '').length)[0]];
      }
    }

    // Two St Nicholas in New South Wales, two parishes in Woolloongabba: where
    // the dedication is not unique inside a state, the place decides. The place
    // may be either field: New Zealand has no state, so its entries are filed by
    // region, and "Auckland" is the REGION of a parish whose suburb is Balmoral
    // — which is how it collided with Christ the Saviour in Wellington.
    if (hits.length > 1) {
      const byPlace = hits.filter((e) => flat(e.suburb) === flat(row.suburb)
        || flat(e.state) === flat(row.suburb));
      if (byPlace.length === 1) hits = byPlace;
    }

    if (hits.length === 1) {
      const e = hits[0];
      row.directory_address = e.address || null;
      row.directory_address_source = `${BASE}${e.path}`;
      row.directory_phone = e.phone || null;
      if (e.suburb && flat(e.suburb) !== flat(row.suburb)) {
        row.directory_suburb = e.suburb.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        report.push(`  SUBURB DIFFERS  ${row.name} — diocese says ${row.suburb}, directory says ${row.directory_suburb}`);
      } else {
        report.push(`  matched         ${row.name} | ${row.suburb}  ->  ${e.address}`);
      }
    } else if (hits.length > 1) {
      report.push(`  AMBIGUOUS       ${row.name} | ${row.suburb}  ->  ${hits.map((h) => h.suburb).join(', ')}`);
    } else {
      report.push(`  no entry        ${row.name} | ${row.suburb}`);
    }
  }
  return report;
}
