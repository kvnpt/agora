#!/usr/bin/env node
// The link-preview cards: one per jurisdiction, and one for the site.
//
//   NODE_PATH=<dir with playwright installed> node scripts/build-og-images.mjs
//
// A chat app or a search engine previewing a parish link wants an image, and
// only a handful of parishes have a logo. So a parish without a poster or a
// logo previews with its jurisdiction's card: its colour, its name, and the
// site — drawn here once, committed as public/og/<jurisdiction>.jpg, and served
// as static files (`!/og/*` in run_worker_first keeps them off the Worker).
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

// The three-bar cross, drawn rather than fetched: the card must not depend on
// an icon service being reachable when it is rendered. The footrest rises to
// the VIEWER'S LEFT — Christ's right, the good thief's side — as it does on
// every Orthodox cross.
const CROSS = `<svg viewBox="0 0 60 100" width="96" height="160" aria-hidden="true">
  <g fill="#fff"><rect x="26" y="0" width="8" height="100"/><rect x="16" y="14" width="28" height="7"/>
  <rect x="4" y="32" width="52" height="8"/><rect x="14" y="70" width="32" height="7" transform="rotate(18 30 73.5)"/></g></svg>`;

const html = (label, color) => `<!doctype html><html><head><style>
  html,body{margin:0}
  body{width:1200px;height:630px;display:flex;align-items:center;gap:64px;padding:0 96px;box-sizing:border-box;
    font-family:"Helvetica Neue",Helvetica,Arial,sans-serif;color:#fff;
    background:radial-gradient(120% 140% at 85% 10%, color-mix(in srgb, ${color} 70%, #fff) 0%, ${color} 45%, color-mix(in srgb, ${color} 70%, #000) 100%)}
  .t{display:flex;flex-direction:column;gap:18px}
  .k{font-size:30px;letter-spacing:.18em;text-transform:uppercase;opacity:.85}
  .h{font-size:76px;font-weight:800;line-height:1.02;letter-spacing:-.02em}
  .s{font-size:32px;opacity:.9}
</style></head><body>${CROSS}<div class="t"><div class="k">orthodoxy.au</div>
  <div class="h">${label}</div><div class="s">Service times &amp; events near you</div></div></body></html>`;

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
for (const c of CARDS) {
  const color = c.color || JURISDICTION_COLORS[c.file];
  await page.setContent(html(c.label, color));
  // JPEG: the gradient makes a PNG ~300 KB, the size where chat previews start
  // dropping images; this is a tenth of that.
  await page.screenshot({ path: path.join(OUT, `${c.file}.jpg`), type: 'jpeg', quality: 86 });
  console.log(`wrote public/og/${c.file}.jpg  (${color})`);
}
await browser.close();
