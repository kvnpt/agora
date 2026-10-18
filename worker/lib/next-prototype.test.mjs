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
