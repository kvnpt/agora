// What a crawler walking the lite pages' links costs. A filter path is never a
// parish link, so it must not reach D1 through the redirect routes; the links
// that lead into dated or app URLs are nofollow; robots.txt keeps out the URL
// families that never end (docs/roadmap.md, "If D1 reads spike again").

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import worker from '../index.mjs';

/** A D1 that records every statement it is asked to prepare, and finds nothing. */
function recordingDb() {
  const sql = [];
  const stmt = { bind: () => stmt, first: async () => null, all: async () => ({ results: [] }), run: async () => ({}) };
  return { sql, prepare: (q) => { sql.push(q); return stmt; } };
}

async function linkLookups(path) {
  const DB = recordingDb();
  const env = { DB, ASSETS: { fetch: async () => new Response('app') } };
  await worker.fetch(new Request(`https://orthodoxy.au${path}`), env, { waitUntil() {} });
  return DB.sql.filter(q => /FROM parish_links|SELECT \w+_url AS url/.test(q));
}

test('a filter path never looks for a parish link', async () => {
  for (const p of ['/greek/qld', '/sgr/evening', '/sgr/sun', '/liturgy/sun', '/sgr/2026-10-04',
    '/sgr/next-sun', '/greek/raffle', '/qld/donate', '/102:2026-10-04/x', '/en/liturgy']) {
    assert.deepEqual(await linkLookups(p), [], `${p} queried D1 for a link`);
  }
});

test('a parish link and a payment link are still looked up', async () => {
  assert.equal((await linkLookups('/smg/festival')).length, 1);
  assert.ok((await linkLookups('/smg/donate')).length >= 1);
  assert.ok((await linkLookups('/smg/gala')).length >= 1);
});

test('robots.txt keeps crawlers off dated ids and the way into the app', () => {
  const robots = readFileSync(new URL('../../public/robots.txt', import.meta.url), 'utf8');
  assert.match(robots, /^Disallow: \/\*:\*$/m);
  assert.match(robots, /^Disallow: \/\*\?app$/m);
  assert.doesNotMatch(robots, /^Disallow: \/$/m, 'parish pages must stay crawlable');
});
