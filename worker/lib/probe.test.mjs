// A scanner's probe is a 404 before anything else runs; everything the site
// actually serves is not a probe. Through the Worker's own fetch, with a
// database and an asset binding that fail the test if they are touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.mjs';
import { isProbePath } from './probe.mjs';
import { pageOf } from '../routes/pages.mjs';

const PROBES = [
  '/.env', '/.env.production', '/config/.env', '/.git/config', '/.git/HEAD', '/.aws/credentials',
  '/.DS_Store', '/wp-login.php', '/xmlrpc.php', '/wp-admin/setup-config.php', '/wp-content/x',
  '/cgi-bin/luci', '/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php', '/backup.sql',
  '/db.sql.gz', '/site.zip', '/config.yml', '/docker-compose.yaml', '/server.key', '/%2Eenv',
];

const SITE = [
  '/', '/sgr', '/SGR', '/sgr/next-tue', '/sgr/donate', '/smg/festival', '/42', '/42:2026-10-04',
  '/greek', '/greek/queensland', '/timetables', '/services', '/worship', '/wed/liturgy', '/sitemap.xml', '/robots.txt',
  '/posters/abc123.jpg', '/logos/antiochian-stgeorge-redfern.png', '/tiles/oceania.pmtiles',
  '/api/bundle', '/api/admin/events/12', '/health', '/.well-known/security.txt',
];

test('the probes scanners send are probes', () => {
  for (const p of PROBES) assert.equal(isProbePath(p), true, `${p} is let through`);
});

test('nothing the site serves is mistaken for one', () => {
  for (const p of SITE) assert.equal(isProbePath(p), false, `${p} would be refused`);
});

test('a probe is a 404 with no D1 read and no asset fetch', async () => {
  const untouched = (what) => new Proxy({}, { get: () => () => { throw new Error(`${what} was touched`); } });
  const env = { DB: untouched('D1'), ASSETS: untouched('ASSETS'), ASSETS_BUCKET: untouched('R2') };
  for (const p of ['/.env', '/.git/config', '/wp-login.php']) {
    for (const host of ['orthodoxy.au', 'antiochian.orthodoxy.au']) {
      const res = await worker.fetch(new Request(`https://${host}${p}`), env, { waitUntil() {} });
      assert.equal(res.status, 404, `${host}${p}`);
      assert.equal(await res.text(), 'Not found');
      assert.match(res.headers.get('cache-control'), /max-age/);
    }
  }
});

test('a dotted single segment is a file, not a parish to look up', () => {
  assert.equal(pageOf('/apple-touch-icon.png'), null);
  assert.equal(pageOf('/favicon-32x32.png'), null);
  assert.equal(pageOf('/sgr').kind, 'parish', 'a real parish slug stopped being one');
});
