// Does every curated sentence still appear on the page it cites?
//
//   node scripts/check-greek-quotes.mjs greek-pages.json
//
// `greek-schedules.test.mjs` proves that each quote in `greek-service-times.mjs`
// PARSES to the rule claimed beside it. That is half the check, and it is the
// half that runs in CI. This is the other half, and it cannot run in CI because
// it needs the crawl output: that the quote is a real sentence on a real page
// and not something transcribed from memory, a neighbouring parish, or an
// aggregator.
//
// It earned its place immediately. Three of the first thirteen entries cited a
// page that did not carry their sentence — one URL invented outright
// (`/sunday-services`, when All Saints publishes its times on `/sacraments`),
// one citing a homepage when the text was on `/whats-on`, and one quoting
// across a paragraph break so that the hour and the week were never on the same
// line. All three would have shipped a `source_ref` that a reader clicking
// "Updated 2 days ago · Parish website" would have found nothing on.
//
// Run it after any re-crawl. A parish rewording its page is a real finding —
// it means the times may have changed too.

import { readFile } from 'node:fs/promises';
import { SERVICE_TIMES } from './greek-service-times.mjs';

const pagesFile = process.argv[2] || './greek-pages.json';

// Compared loosely on purpose: a site that swaps a straight quote for a curly
// one, or an en dash for a hyphen, has not changed its service times, and a
// check that cried wolf over punctuation would stop being run.
const norm = (s) => String(s || '')
  .replace(/[‘’ʼ]/g, "'")
  .replace(/[“”]/g, '"')
  .replace(/[–—−]/g, '-')
  .replace(/ /g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();

const { parishes } = JSON.parse(await readFile(pagesFile, 'utf8'));
const pages = new Map();
for (const p of parishes) {
  for (const pg of p.pages) pages.set(pg.url.replace(/\/+$/, ''), pg.text);
}

let bad = 0;
for (const e of SERVICE_TIMES) {
  const key = e.source_ref.replace(/\/+$/, '');
  const text = pages.get(key);
  const label = `${e.parish_id} — ${e.title}`;
  if (text === undefined) {
    console.log(`  NO SUCH PAGE IN THE CRAWL  ${label}\n      ${e.source_ref}`);
    bad += 1;
    continue;
  }
  const hay = norm(text);
  if (!hay.includes(norm(e.quote))) {
    console.log(`  QUOTE NOT ON THE PAGE      ${label}\n      ${e.source_ref}\n      ${JSON.stringify(e.quote)}`);
    bad += 1;
    continue;
  }
  // `context` is verbatim page text and is checked exactly like `quote`. A
  // curator's own explanation goes in `note`, which is never checked — it is
  // not something the parish said, so there is nothing to check it against.
  if (e.context && !hay.includes(norm(e.context))) {
    console.log(`  CONTEXT NOT ON THE PAGE    ${label}\n      ${e.source_ref}\n      ${JSON.stringify(e.context)}`);
    bad += 1;
    continue;
  }
  console.log(`  ok  ${label}`);
}

console.log(`\n${SERVICE_TIMES.length - bad}/${SERVICE_TIMES.length} curated sentences are still on the page they cite.`);
if (bad) {
  console.log('A miss is either a bad citation or a parish that has reworded its page — and the second '
    + 'means the times may have changed, so re-read it before re-running the build.');
  process.exitCode = 1;
}
