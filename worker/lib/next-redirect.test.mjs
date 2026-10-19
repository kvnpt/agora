// /next was v3 while it was a prototype. Now v3 is the page at every address,
// and every link under /next is sent to its own, for good: /next/greek/en is
// /greek/en. Through the Worker's own fetch, with bindings that fail the test
// if touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { nextRedirect } from '../index.mjs';
import slugs from '../../public/shared/slugs.js';

const untouched = (what) => new Proxy({}, { get: () => () => { throw new Error(`${what} was touched`); } });
const ctx = { waitUntil() {} };
const env = { DB: untouched('D1'), ASSETS_BUCKET: untouched('R2'), ASSETS: untouched('the asset layer') };

test('every link under /next is sent to its own, keeping the rest, with no D1 read', async () => {
  for (const [from, to] of [['/next', '/'], ['/next/', '/'], ['/next/greek/en', '/greek/en'], ['/next/sgr', '/sgr'],
    ['/next/sgr+snb', '/sgr+snb'], ['/next/42:2026-10-04', '/42:2026-10-04'], ['/next/sun/liturgy?x=1', '/sun/liturgy?x=1'],
    ['/next/sgr/donate', '/sgr/donate']]) {
    const res = await worker.fetch(new Request(`https://orthodoxy.au${from}`), env, ctx);
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get('location'), to, from);
  }
});

test('the page\'s own files under /next stay where they are, and so does anything not a GET', () => {
  for (const p of ['/next/next.js', '/next/next.css', '/next/editing.js']) {
    assert.equal(nextRedirect(new Request(`https://orthodoxy.au${p}`)), null, p);
  }
  assert.equal(nextRedirect(new Request('https://orthodoxy.au/next/x', { method: 'POST' })), null);
});

test('a path that only begins with "next" is not under /next', () => {
  for (const p of ['/next-tue', '/next-week', '/nextdoor', '/sgr/next', '/']) {
    assert.equal(nextRedirect(new Request(`https://orthodoxy.au${p}`)), null, p);
  }
});

test('no parish can take the acronym "next"', () => {
  assert.ok(slugs.reservedSlugReason('next'));
  assert.ok(slugs.reservedSlugReason('NEXT'));
});

test('the home page is the page with its head, from the asset layer alone', async () => {
  const asked = [];
  const PAGE = '<head><!--page:head--><title>x</title><!--/page:head--></head><body><div id="sheets"><!--page:card--></div></body>';
  const home = { ...env, ASSETS: { fetch: (req) => { asked.push(new URL(req.url).pathname); return new Response(PAGE); } } };
  const res = await worker.fetch(new Request('https://orthodoxy.au/'), home, ctx);
  const html = await res.text();
  assert.deepEqual(asked, ['/next'], 'the page, as deployed');
  assert.match(html, /<title>Orthodox Services &amp; Events — orthodoxy\.au<\/title>/);
  assert.match(html, /<link rel="canonical" href="https:\/\/orthodoxy\.au\/">/);
});
