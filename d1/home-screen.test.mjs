// The page saved to a Home Screen: its icon, its name, and sw.js.
//
// Nothing in CI opens a browser, so these pin what a browser would read: the
// manifest's icons are the files and sizes it says, both pages link them
// outside the head the Worker rewrites (where a link's own head would drop
// them), and sw.js keeps only what it means to keep.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import vm from 'node:vm';

const read = (p) => fs.readFileSync(new URL(`../public/${p}`, import.meta.url));

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(buf) {
  assert.equal(buf.toString('ascii', 1, 4), 'PNG');
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

test('every icon the manifest names is there, at the size it says', () => {
  const m = JSON.parse(read('manifest.webmanifest'));
  assert.equal(m.start_url, '/');
  assert.equal(m.display, 'standalone');
  assert.ok(m.short_name.length <= 12, 'fits under an iPhone icon');
  for (const icon of m.icons) {
    const buf = read(icon.src.slice(1));
    if (icon.type === 'image/png') assert.equal(pngSize(buf), icon.sizes, icon.src);
    else assert.match(buf.toString('utf8', 0, 200), /<svg/, icon.src);
  }
  assert.ok(m.icons.some((i) => i.purpose === 'maskable'), 'Android crops a maskable one to its own shape');
  assert.equal(pngSize(read('apple-touch-icon.png')), '180x180');
});

test('both pages link the icon outside the head the Worker rewrites', () => {
  for (const page of ['index.html', 'lite.html']) {
    const html = read(page).toString('utf8');
    const outside = html.replace(/<!--page:head-->[\s\S]*?<!--\/page:head-->/, '');
    for (const tag of ['rel="apple-touch-icon" href="/apple-touch-icon.png"', 'rel="manifest" href="/manifest.webmanifest"',
      'name="apple-mobile-web-app-title"']) {
      assert.ok(outside.includes(tag), `${page}: ${tag}`);
    }
  }
  const index = read('index.html').toString('utf8');
  assert.ok(index.includes("register('/sw.js')"), 'the full page registers sw.js');
  assert.ok(index.includes('postMessage({ keep:'), 'and hands it what a first visit loaded without it');
  assert.ok(!read('lite.html').toString('utf8').includes('serviceWorker'), 'the lite version runs no app script');
});

test('sw.js keeps the page and the bundle, and never tiles, posters, admin or the API', () => {
  const ctx = { self: { location: { origin: 'https://orthodoxy.au' }, addEventListener() {} }, URL };
  vm.runInNewContext(read('sw.js').toString('utf8'), ctx);
  const key = (path, init = {}) => ctx.keyFor({
    url: `https://orthodoxy.au${path}`, method: init.method || 'GET',
    headers: new Map(Object.entries(init.headers || {})),
  });
  assert.equal(key('/'), '/');
  assert.equal(key('/sgr'), '/sgr');
  assert.equal(key('/next/next.js'), '/next/next.js');
  assert.equal(key('/logos/sgr.png'), '/logos/sgr.png');
  assert.equal(key('/api/bundle?from=2026-10-30&to=2027-01-01'), '/api/bundle', 'one bundle, whatever its window');
  for (const p of ['/tiles/oceania.pmtiles', '/posters/x.png', '/admin', '/admin/', '/api/admin/parishes', '/api/claims', '/cdn-cgi/x']) {
    assert.equal(key(p), null, p);
  }
  assert.equal(key('/', { method: 'POST' }), null, 'only a GET');
  assert.equal(key('/next/next.js', { headers: { range: 'bytes=0-9' } }), null, 'never a range request');
  assert.equal(ctx.keyFor({ url: 'https://unpkg.com/x.js', method: 'GET', headers: new Map() }), null, 'only this site');
});
