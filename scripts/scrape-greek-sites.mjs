// Pass 1 of the Greek SERVICE TIMES run: re-read the Archdiocese directory and
// find out where each parish actually publishes.
//
//   node scripts/scrape-greek-sites.mjs cache/greek/ greek-sites.json
//
// WHY THIS PASS EXISTS AT ALL. The 135 Greek parishes already have rows, so
// nothing here geocodes or renames anything. It runs because the directory is
// the only place that links a parish to its own website, and the times are on
// that website — the Archdiocese publishes none. Of the 135 rows imported in
// September, 36 carry a website and 99 carry nothing, and neither figure can be
// trusted without looking: a directory gains links, and a linked site dies.
//
// So this pass answers exactly two questions per parish, and writes both down:
//
//   1. what does the directory link to now (which may differ from our row), and
//   2. does that link still answer.
//
// Liveness is checked here rather than in the crawl because a dead link is not
// a crawl failure to retry — it is a finding, and it is the finding that sends
// a parish to `scripts/greek-site-overrides.mjs` to be replaced by hand. A
// site answering 200 with a parked-domain body is still dead in every sense
// this run cares about, so the body is sniffed as well as the status.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { directoryFields, directoryWebsite, normaliseUrl, sameSite } from './greek-directory.mjs';

const PARISHES = 'https://agora.orthodoxy.au/api/parishes';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const cacheDir = process.argv[2] || './cache/greek';
const output = process.argv[3] || './greek-sites.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slugOf = (url) => String(url).replace(/\/+$/, '').split('/').pop() || 'index';

/** Fetch once, then read from disk forever — one pass over the site, ever. */
async function cached(name, url, attempt = 1) {
  const path = join(cacheDir, name);
  try { return await readFile(path, 'utf8'); } catch { /* not cached yet */ }
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) {
    // 5xx is a hiccup and 4xx is an answer — the same split scrape-serbian.mjs
    // makes, and for the same reason: a run that dies on page 9 of 135 leaves
    // a half-filled cache and nothing to read.
    if (res.status >= 500 && attempt < 3) {
      await sleep(attempt * 2000);
      return cached(name, url, attempt + 1);
    }
    throw new Error(`${url} -> HTTP ${res.status}`);
  }
  const body = await res.text();
  await mkdir(cacheDir, { recursive: true });
  await writeFile(path, body);
  await sleep(400);
  return body;
}

// A 200 that is not the parish's site. Squatters and expired-hosting pages
// answer perfectly well, and a crawl that trusted the status code would spend
// the next pass looking for a Divine Liturgy on a domain auction.
const PARKED = [
  /\bdomain\s+(?:is\s+)?(?:for\s+sale|parking|expired)\b/i,
  /\bbuy\s+this\s+domain\b/i,
  /\bthis\s+(?:domain|site|account)\s+has\s+(?:been\s+)?(?:expired|suspended)\b/i,
  /\bwebsite\s+coming\s+soon\b/i,
  /\bunder\s+construction\b/i,
  /\bsuspended\s+(?:page|domain)\b/i,
  /\bgodaddy\b[\s\S]{0,200}\bparked\b/i,
];

/**
 * Is this URL a live parish site? `{ ok, status, url, why }`.
 *
 * Redirects are followed and the FINAL url reported, because half of these
 * moved to a new domain years ago and kept a redirect: the final url is the
 * one worth storing. A redirect landing on a registrar or a search page is not
 * a move, it is a death, and is reported as one.
 */
export async function checkSite(url) {
  const target = normaliseUrl(url);
  if (!target) return { ok: false, status: 0, url: null, why: 'not a URL' };
  let res;
  try {
    res = await fetch(target, {
      headers: { 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(25000),
    });
  } catch (err) {
    return { ok: false, status: 0, url: target, why: String(err.message || err).slice(0, 120) };
  }
  const finalUrl = normaliseUrl(res.url || target);
  if (!res.ok) return { ok: false, status: res.status, url: finalUrl, why: `HTTP ${res.status}` };
  let body = '';
  try { body = (await res.text()).slice(0, 60000); } catch { /* headers only is fine */ }
  const parked = PARKED.find((re) => re.test(body));
  if (parked) return { ok: false, status: res.status, url: finalUrl, why: 'parked or expired' };
  if (body.length < 500) return { ok: false, status: res.status, url: finalUrl, why: 'empty body' };
  return { ok: true, status: res.status, url: finalUrl, why: null };
}

const res = await fetch(PARISHES, { headers: { 'User-Agent': 'agora-parish-import/1.0' } });
if (!res.ok) throw new Error(`${PARISHES} -> HTTP ${res.status}`);
const all = await res.json();
const parishes = (Array.isArray(all) ? all : all.parishes)
  .filter((p) => p.jurisdiction === 'greek')
  .sort((a, b) => a.id.localeCompare(b.id));

console.log(`${parishes.length} Greek parishes\n`);

const checkedAt = new Date().toISOString();
const rows = [];
for (const p of parishes) {
  const ref = p.info_source_ref;
  if (!ref || !/greekorthodox\.org\.au/.test(ref)) {
    rows.push({ id: p.id, name: p.name, directory_ref: ref || null, error: 'not a directory row' });
    console.log(`  ${p.id.padEnd(38)} SKIP — info_source_ref is not the directory`);
    continue;
  }
  let html;
  try {
    html = await cached(`${slugOf(ref)}.html`, ref);
  } catch (err) {
    rows.push({ id: p.id, name: p.name, directory_ref: ref, error: String(err.message) });
    console.log(`  ${p.id.padEnd(38)} FAIL — ${err.message}`);
    continue;
  }
  const fields = directoryFields(html);
  const listed = directoryWebsite(html);
  const stored = normaliseUrl(p.website);
  rows.push({
    id: p.id,
    name: p.name,
    timezone: p.timezone,
    languages: p.languages,
    directory_ref: ref,
    directory_website: listed,
    stored_website: stored,
    moved: Boolean(listed && stored && !sameSite(listed, stored)),
    gained: Boolean(listed && !stored),
    address: fields.get('address') || null,
    phone: fields.get('phone') || null,
  });
  const note = listed
    ? (!stored ? `GAINED  ${listed}` : (sameSite(listed, stored) ? `same    ${listed}` : `MOVED   ${stored} -> ${listed}`))
    : (stored ? `DROPPED (row keeps ${stored})` : 'no website published');
  console.log(`  ${p.id.padEnd(38)} ${note}`);
}

// Liveness: every distinct site, checked once. Parishes share a site more often
// than the directory suggests — two of the Sydney cathedrals sit on one domain.
// The row's own website first: a parish with a site is read from the site it
// has on file (public/shared/source-tiers.js, governingTier), and the
// directory's link is only the fallback for a parish that has none.
const targets = [...new Set(rows.map((r) => r.stored_website || r.directory_website).filter(Boolean))];
console.log(`\nchecking ${targets.length} distinct sites…\n`);
const liveness = new Map();
for (const url of targets) {
  const check = await checkSite(url);
  liveness.set(url, check);
  console.log(`  ${check.ok ? 'live' : 'DEAD'}  ${url}${check.ok ? '' : `  — ${check.why}`}`
    + `${check.ok && check.url && !sameSite(check.url, url) ? `  -> ${check.url}` : ''}`);
}

for (const r of rows) {
  const url = r.stored_website || r.directory_website;
  const check = url ? liveness.get(url) : null;
  r.live = check ? check.ok : false;
  r.live_url = check && check.ok ? check.url : null;
  r.dead_why = check && !check.ok ? check.why : (url ? null : 'no website published');
}

const live = rows.filter((r) => r.live).length;
const dead = rows.filter((r) => !r.live && (r.directory_website || r.stored_website)).length;
const none = rows.filter((r) => !r.directory_website && !r.stored_website).length;

console.log(`\n${live} parishes with a live site, ${dead} with a dead one, ${none} with none published.`);
console.log(`${rows.filter((r) => r.gained).length} gained a website since the September import, `
  + `${rows.filter((r) => r.moved).length} moved.`);

await writeFile(output, `${JSON.stringify({ scraped_at: checkedAt, parishes: rows }, null, 2)}\n`);
console.log(`\nwrote ${rows.length} rows to ${output}`);
