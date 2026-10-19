#!/usr/bin/env node
// The link-preview cards: one per jurisdiction, one per collection, and one
// for the site.
//
//   NODE_PATH=<dir with playwright installed> node scripts/build-og-images.mjs [prefix]
//
// With a prefix, only the cards whose file starts with it (`c-` for the
// collections), so a new card does not rewrite the others' bytes.
//
// A chat app or a search engine previewing a parish link wants an image, and
// only a handful of parishes have a logo. So a parish without a poster or a
// logo previews with its jurisdiction's card: its colour, its name, and the
// site — drawn here once, committed as public/og/<jurisdiction>.jpg, and served
// as static files (`!/og/*` in run_worker_first keeps them off the Worker).
// A collection (public/shared/collections.js: /en, /sun/liturgy, /in-greek,
// /monasteries) previews with its own, public/og/c-<id>.jpg, in the colour of
// its card on the page's shelves.
//
// Rendered by a real browser from HTML rather than drawn by hand, so the type
// is real type and a change of colour in public/shared/jurisdiction-colors.js is
// one re-run away. Playwright is not a dependency of this repo; install it
// anywhere and point NODE_PATH at it, the way docs/browser-checks.md does.
// Chromium is pre-installed in the Claude Code environment; set CHROMIUM to its
// binary if it is not where this looks.

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const { JURISDICTION_COLORS } = require('../public/shared/jurisdiction-colors.js');
const { CURATED, LANGUAGES } = require('../public/shared/collections.js');

const OUT = path.resolve('public/og');
const CARDS = [
  { file: 'antiochian', label: 'Antiochian Orthodox' },
  { file: 'greek', label: 'Greek Orthodox' },
  { file: 'serbian', label: 'Serbian Orthodox' },
  { file: 'russian', label: 'Russian Orthodox' },
  { file: 'romanian', label: 'Romanian Orthodox' },
  { file: 'macedonian', label: 'Macedonian Orthodox' },
  { file: 'default', label: 'Orthodox Services & Events', color: '#1f3a5f' },
];
// The first colour of each card's art on /next (LOOK and LANGS in next.js).
const COLLECTION_COLORS = {
  english: '#1d4ed8', sunday: '#9a3412', vespers: '#312e81', weeknights: '#0f766e', talks: '#92400e',
  socials: '#9d174d', monasteries: '#3f3f46',
  'lang-greek': '#0061fe', 'lang-arabic': '#7c3bc1', 'lang-serbian': '#cc2234', 'lang-slavonic': '#d38301',
  'lang-romanian': '#4e7a27', 'lang-macedonian': '#b92d5d',
};
for (const c of CURATED) CARDS.push({ file: `c-${c.id}`, label: c.title, sub: c.blurb, color: COLLECTION_COLORS[c.id] });
for (const c of LANGUAGES) CARDS.push({ file: `c-${c.id}`, label: `Services in ${c.title}`, color: COLLECTION_COLORS[c.id] });

// The three-bar cross, drawn rather than fetched: the card must not depend on
// an icon service being reachable when it is rendered. The footrest rises to
// the VIEWER'S LEFT — Christ's right, the good thief's side — as it does on
// every Orthodox cross.
const CROSS = `<svg viewBox="0 0 60 100" width="96" height="160" aria-hidden="true">
  <g fill="#fff"><rect x="26" y="0" width="8" height="100"/><rect x="16" y="14" width="28" height="7"/>
  <rect x="4" y="32" width="52" height="8"/><rect x="14" y="70" width="32" height="7" transform="rotate(18 30 73.5)"/></g></svg>`;

const SUB = 'Service times &amp; events near you';
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
const html = (label, color, sub = null) => `<!doctype html><html><head><style>
  html,body{margin:0}
  svg{flex:none}
  body{width:1200px;height:630px;display:flex;align-items:center;gap:64px;padding:0 96px;box-sizing:border-box;
    font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;color:#fff;
    background:radial-gradient(120% 140% at 85% 10%, color-mix(in srgb, ${color} 70%, #fff) 0%, ${color} 45%, color-mix(in srgb, ${color} 70%, #000) 100%)}
  .t{display:flex;flex-direction:column;gap:18px}
  .k{font-size:30px;letter-spacing:.18em;text-transform:uppercase;opacity:.85}
  .h{font-size:76px;font-weight:800;line-height:1.02;letter-spacing:-.02em}
  .s{font-size:32px;opacity:.9;line-height:1.25;max-width:820px}
</style></head><body>${CROSS}<div class="t"><div class="k">orthodoxy.au</div>
  <div class="h">${esc(label)}</div><div class="s">${sub ? esc(sub) : SUB}</div></div></body></html>`;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
const only = process.argv[2] || '';
for (const c of CARDS.filter(x => x.file.startsWith(only))) {
  const color = c.color || JURISDICTION_COLORS[c.file];
  await page.setContent(html(c.label, color, c.sub));
  // JPEG: the gradient makes a PNG ~300 KB, the size where chat previews start
  // dropping images; this is a tenth of that.
  await page.screenshot({ path: path.join(OUT, `${c.file}.jpg`), type: 'jpeg', quality: 86 });
  console.log(`wrote public/og/${c.file}.jpg  (${color})`);
}
await browser.close();
