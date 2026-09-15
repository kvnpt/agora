// Pass 2 of the Greek SERVICE TIMES run: fetch each parish's own site and find
// the page its times are on.
//
//   node scripts/scrape-greek-schedules.mjs greek-sites.json cache/greek-sites/ greek-pages.json
//
// Reads pass 1's output, applies the hand-resolved sites in
// `scripts/greek-site-overrides.mjs`, then for each parish: fetch the
// homepage, rank its links with `greek-crawl.mjs`, fetch the best few, and
// write out the text of whichever page looks most like a timetable.
//
// IT DOES NOT PARSE ANYTHING. That is deliberate and it is the whole shape of
// this run. A hundred independent sites have a hundred layouts, and a parser
// confident enough to read all of them unsupervised is a parser confident
// enough to invent a Sunday. So this pass produces TEXT, ranked, with the URL
// it came from, and a person reads it — `greek-schedules.mjs` then parses only
// the shapes that were actually seen, with the rest written down by hand in
// `greek-service-times.mjs` against the page that says so.
//
// A page is fetched at most once, ever, and cached. Re-running is free and
// costs the parishes nothing.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { candidatePages, pageText, timetableScore, WELL_KNOWN_PATHS } from './greek-crawl.mjs';
import { SITE_OVERRIDES } from './greek-site-overrides.mjs';
import { normaliseUrl } from './greek-directory.mjs';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const input = process.argv[2] || './greek-sites.json';
const cacheDir = process.argv[3] || './cache/greek-sites';
const output = process.argv[4] || './greek-pages.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyFor = (url) => createHash('sha1').update(url).digest('hex').slice(0, 16);

/**
 * Fetch once, cache forever. Returns `{ ok, body, status, url, why }`.
 *
 * Never throws: on this pass a failure is an ordinary outcome — a site that is
 * down, a host that refuses a robot — and one parish failing must not stop the
 * other hundred. The reason is carried through to the report instead.
 */
async function get(url) {
  const path = join(cacheDir, `${keyFor(url)}.html`);
  const metaPath = join(cacheDir, `${keyFor(url)}.json`);
  try {
    const [body, meta] = await Promise.all([readFile(path, 'utf8'), readFile(metaPath, 'utf8')]);
    return { ...JSON.parse(meta), body, cached: true };
  } catch { /* not cached yet */ }

  let res;
  try {
    res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-AU,en;q=0.9,el;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(45000) });
  } catch (err) {
    return { ok: false, status: 0, url, why: String(err.message || err).slice(0, 120), body: '' };
  }
  const body = res.ok ? await res.text().catch(() => '') : '';
  const out = { ok: res.ok, status: res.status, url: normaliseUrl(res.url) || url, why: res.ok ? null : `HTTP ${res.status}` };
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path, body);
  await writeFile(metaPath, JSON.stringify(out));
  await sleep(700);
  return { ...out, body };
}

const { scraped_at: scrapedAt, parishes } = JSON.parse(await readFile(input, 'utf8'));

const rows = [];
for (const p of parishes) {
  const override = SITE_OVERRIDES[p.id];
  // An override is the answer even when the directory has one, because that is
  // what an override is for: the directory's link being wrong is the commonest
  // reason a parish ends up in that file at all.
  const site = override?.website !== undefined
    ? override.website
    : (p.live ? (p.live_url || p.directory_website || p.stored_website) : null);

  const row = {
    id: p.id,
    name: p.name,
    timezone: p.timezone,
    website: site,
    website_from: override?.website !== undefined ? (override.found ? `found: ${override.found}` : 'override') : 'directory',
    stored_website: p.stored_website || null,
    directory_website: p.directory_website || null,
    note: override?.note || null,
    pages: [],
  };

  if (!site) {
    row.why = override?.note || p.dead_why || 'no website';
    rows.push(row);
    console.log(`  ${p.id.padEnd(38)} —      ${row.why}`);
    continue;
  }

  const home = await get(site);
  if (!home.ok) {
    row.why = home.why;
    rows.push(row);
    console.log(`  ${p.id.padEnd(38)} FAIL   ${site} — ${home.why}`);
    continue;
  }

  const seen = new Set([normaliseUrl(home.url) || site]);
  const tried = [{ url: home.url || site, label: 'home', body: home.body }];
  for (const c of candidatePages(home.body, home.url || site, 4)) {
    if (seen.has(c.url)) continue;
    seen.add(c.url);
    const res = await get(c.url);
    if (res.ok) tried.push({ url: c.url, label: c.text || '(link)', body: res.body });
  }
  // Then the paths a parish might publish at without linking to them. A 404 is
  // the expected answer and is not worth reporting; only a page that exists is.
  const origin = (() => { try { return new URL(home.url || site).origin; } catch { return null; } })();
  for (const path of (origin ? WELL_KNOWN_PATHS : [])) {
    const url = `${origin}${path}`;
    if (seen.has(url)) continue;
    seen.add(url);
    const res = await get(url);
    if (res.ok && res.body.length > 800) tried.push({ url, label: `(well-known ${path})`, body: res.body });
  }

  for (const t of tried) {
    const text = pageText(t.body);
    row.pages.push({ url: t.url, label: t.label, score: timetableScore(text), chars: text.length, text });
  }
  row.pages.sort((a, b) => b.score - a.score);
  rows.push(row);

  const best = row.pages[0];
  console.log(`  ${p.id.padEnd(38)} ${String(best.score).padStart(3)}    ${best.url}`);
}

const withTimes = rows.filter((r) => r.pages.some((pg) => pg.score > 0));
console.log(`\n${rows.length} parishes; ${rows.filter((r) => r.website).length} with a site to read; `
  + `${withTimes.length} with a page carrying a weekday and a time.`);
console.log(`${rows.filter((r) => r.website && !r.pages.length).length} sites could not be read.`);

await writeFile(output, `${JSON.stringify({ scraped_at: scrapedAt, read_at: new Date().toISOString(), parishes: rows }, null, 2)}\n`);
console.log(`\nwrote ${output}`);
