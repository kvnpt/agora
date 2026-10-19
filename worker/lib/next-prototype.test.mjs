// /next is the next version while it is a prototype, and every path under it
// is that one page, which reads its own address: /next/greek/en, /next/sgr,
// /next/sgr+snb. Through the Worker's own fetch, with bindings that fail the
// test if touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { nextPrototype } from '../index.mjs';
import slugs from '../../public/shared/slugs.js';

const untouched = (what) => new Proxy({}, { get: () => () => { throw new Error(`${what} was touched`); } });
const ctx = { waitUntil() {} };

function assetsEnv() {
  const asked = [];
  return {
    asked,
    env: {
      DB: untouched('D1'), ASSETS_BUCKET: untouched('R2'),
      ASSETS: { fetch: (req) => { asked.push(new URL(req.url).pathname); return new Response('page'); } },
    },
  };
}

test('every path under /next is the prototype page, with no D1 read', async () => {
  for (const p of ['/next', '/next/', '/next/greek/en', '/next/sgr', '/next/sgr+snb', '/next/42:2026-10-04',
    '/next/sun/liturgy', '/next/sgr/donate', '/next/greek/qld']) {
    const { env, asked } = assetsEnv();
    const res = await worker.fetch(new Request(`https://orthodoxy.au${p}`), env, ctx);
    assert.equal(await res.text(), 'page', p);
    assert.deepEqual(asked, ['/next'], p);
  }
});

test('a path that only begins with "next" is not the prototype', () => {
  for (const p of ['/next-tue', '/next-week', '/nextdoor', '/sgr/next', '/']) {
    assert.equal(nextPrototype(new Request(`https://orthodoxy.au${p}`)), null, p);
  }
  assert.equal(nextPrototype(new Request('https://orthodoxy.au/next/x', { method: 'POST' })), null, 'only a GET or HEAD');
});

test('no parish can take the acronym "next"', () => {
  assert.ok(slugs.reservedSlugReason('next'));
  assert.ok(slugs.reservedSlugReason('NEXT'));
});

// ── a collection's link previews as that collection ──────────────────────

const PAGE = `<head><title>orthodoxy.au · next</title>
  <meta name="description" content="site">
  <meta property="og:title" content="site">
  <meta property="og:description" content="site">
  <meta property="og:image" content="https://orthodoxy.au/og/default.jpg">
  <meta name="twitter:card" content="summary_large_image"></head>`;
const tag = (html, attr, name) => (new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`).exec(html) || [])[1];

function pageEnv({ logos = [] } = {}) {
  const asked = [];
  return {
    asked,
    env: {
      ASSETS_BUCKET: untouched('R2'),
      ASSETS: { fetch: (req) => { asked.push(new URL(req.url).pathname); return new Response(PAGE); } },
      DB: { prepare: () => ({ all: async () => ({ results: logos }) }) },
    },
  };
}

test('a collection under /next gets its own title, description and picture', async () => {
  const { env } = pageEnv();
  const html = await (await worker.fetch(new Request('https://orthodoxy.au/next/liturgy/sunday'), env, ctx)).text();
  assert.match(html, /<title>Orthodox Liturgies on Sundays \| orthodoxy\.au<\/title>/);
  assert.equal(tag(html, 'name', 'description'), 'Every parish with a Sunday Liturgy on its timetable.');
  assert.equal(tag(html, 'property', 'og:title'), 'Orthodox Liturgies on Sundays');
  assert.equal(tag(html, 'property', 'og:image'), 'https://orthodoxy.au/og/c-sunday.jpg');
  assert.equal(tag(html, 'property', 'og:url'), 'https://orthodoxy.au/next/sun/liturgy', 'by its own spelling');
});

test("a jurisdiction's collection previews with its logo once there is one", async () => {
  const { env } = pageEnv({ logos: [{ jurisdiction: 'greek', logo_path: '/logos/jurisdiction-greek.png?v=2' }] });
  const html = await (await worker.fetch(new Request('https://orthodoxy.au/next/greek'), env, ctx)).text();
  assert.equal(tag(html, 'property', 'og:image'), 'https://orthodoxy.au/logos/jurisdiction-greek.png?v=2');
  assert.equal(tag(html, 'name', 'twitter:card'), 'summary', 'a logo is square');
  const plain = await (await worker.fetch(new Request('https://orthodoxy.au/next/serbian'), pageEnv().env, ctx)).text();
  assert.equal(tag(plain, 'property', 'og:image'), 'https://orthodoxy.au/og/serbian.jpg');
});

test('any other link under /next is the page as it is', async () => {
  for (const p of ['/next', '/next/sgr', '/next/sgr+snb', '/next/greek/qld', '/next/greek/en']) {
    const { env } = pageEnv();
    env.DB = untouched('D1');
    const html = await (await worker.fetch(new Request(`https://orthodoxy.au${p}`), env, ctx)).text();
    assert.equal(html, PAGE, p);
  }
});

test('an SVG logo is on the card but not the preview, which no chat app draws', async () => {
  const { env } = pageEnv({ logos: [{ jurisdiction: 'greek', logo_path: '/logos/jurisdiction-greek.svg?v=3' }] });
  const html = await (await worker.fetch(new Request('https://orthodoxy.au/next/greek'), env, ctx)).text();
  assert.equal(tag(html, 'property', 'og:image'), 'https://orthodoxy.au/og/greek.jpg');
});
