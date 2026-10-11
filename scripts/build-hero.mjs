#!/usr/bin/env node
// The hero above every lite page: orthodoxy.au's parishes as points of light.
//
//   NODE_PATH=<dir with playwright installed> node scripts/build-hero.mjs [origin]
//
// The app opens on its map, and the parish sheet slides up over it. A shared
// link opens on a page instead (worker/lib/lite-page.mjs), and this is what
// stands where the map would: the site's navy, and every parish on file at its
// own latitude and longitude, so Sydney and Melbourne glow where they are dense
// and Perth and Auckland sit out on their own. Real places, not decoration —
// the same dots the map draws.
//
// ONE standard image for every page, drawn here and committed as
// public/og/hero.jpg beside the link-preview cards (scripts/build-og-images.mjs,
// whose colour and cross it shares), served as a static file. The words over it
// ("orthodoxy.au" and the cross) are the page's own HTML, so they stay sharp at
// any width and are read by a screen reader; the image is only the backdrop.
//
// The parishes come from the public /api/parishes of `origin` (default the
// live site), so a re-run after an import draws the parishes as they are.
//
// Cropping: the page shows it with `background-size: cover`, so a phone sees
// the middle of its width and a wide screen the middle of its height. The
// lights sit right of centre and inside the middle half of the height, which
// is what both keep; the left is left dark for the words.

import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ORIGIN = process.argv[2] || 'https://orthodoxy.au';
const OUT = path.resolve('public/og/hero.jpg');
const W = 2400, H = 600;
// The page's own background-color behind the image (LITE_CSS .lite-hero): the
// image's edges fade to exactly this, so at any width the image can sit at
// the hero's full height with plain navy either side and no seam.
const NAVY = '#1c3454';
// Natural Earth's land at 1:110m (public domain), as TopoJSON — coarse, which
// is right: a silhouette under the lights, not a map anybody reads streets on.
const LAND = 'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-110m.json';

const parishes = (await (await fetch(`${ORIGIN}/api/parishes`)).json())
  .filter(p => p.id !== '_unassigned' && Number.isFinite(+p.lat) && Number.isFinite(+p.lng))
  .map(p => ({ lat: +p.lat, lng: +p.lng }));
if (!parishes.length) throw new Error(`no parishes from ${ORIGIN}/api/parishes`);

/** TopoJSON's land as rings of [lng, lat]: arcs un-delta'd and un-quantised. */
function landRings(topo) {
  const [sx, sy] = topo.transform.scale, [tx, ty] = topo.transform.translate;
  const arcs = topo.arcs.map(arc => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => { x += dx; y += dy; return [x * sx + tx, y * sy + ty]; });
  });
  const ring = (ids) => ids.flatMap((i, n) => {
    const a = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
    return n ? a.slice(1) : a;
  });
  const geoms = topo.objects.land.type === 'GeometryCollection' ? topo.objects.land.geometries : [topo.objects.land];
  return geoms.flatMap(g => (g.type === 'Polygon' ? [g.arcs] : g.arcs)).flatMap(poly => poly.map(ring));
}
const rings = landRings(await (await fetch(LAND)).json())
  // Oceania only — and none that crosses 180° (part of Fiji is stored at
  // -179°), which would be drawn as a line across the whole image.
  .filter(r => r.some(([lng, lat]) => lng > 105 && lat < 0 && lat > -55) && r.every(([lng]) => lng > 95));

const html = `<!doctype html><html><head><style>
  html,body{margin:0}
  body{width:${W}px;height:${H}px;overflow:hidden;background:${NAVY}}
  canvas{position:absolute;inset:0}
</style></head><body><canvas id="c" width="${W}" height="${H}"></canvas><script>
  const P = ${JSON.stringify(parishes)}, R = ${JSON.stringify(rings)};
  const c = document.getElementById('c'), g = c.getContext('2d');
  // The frame: Australia and New Zealand, whatever the parishes span.
  const [w, e, n, s] = [112, 179, -9.5, -47.5];
  const k = Math.cos(-28 * Math.PI / 180);
  const boxH = ${H} * 0.86, scale = boxH / (n - s), boxW = (e - w) * k * scale;
  const x0 = ${W} * 0.665 - boxW / 2, y0 = (${H} - boxH) / 2;
  const x = (lng) => x0 + (lng - w) * k * scale;
  const y = (lat) => y0 + (n - lat) * scale;

  // A glow behind the land, fading to the flat navy well before any edge.
  const halo = g.createRadialGradient(x(150), y(-30), 0, x(150), y(-30), ${H} * 1.15);
  halo.addColorStop(0, 'rgba(120,160,215,0.30)');
  halo.addColorStop(1, 'rgba(120,160,215,0)');
  g.fillStyle = halo; g.fillRect(0, 0, ${W}, ${H});

  // The land: a shade lighter than the sea, with a faint coast.
  g.beginPath();
  for (const r of R) r.forEach(([lng, lat], i) => (i ? g.lineTo : g.moveTo).call(g, x(lng), y(lat)));
  g.fillStyle = 'rgba(255,255,255,0.085)'; g.fill('evenodd');
  g.strokeStyle = 'rgba(200,220,255,0.22)'; g.lineWidth = 2.2; g.stroke();

  // The parishes: a warm point each, and a soft glow that deepens where they
  // are many. Blended over, not added: a hundred glows at Sydney approach the
  // glow's own warm colour instead of burning out to a white disc.
  for (const p of P) {
    const px = x(p.lng), py = y(p.lat);
    const glow = g.createRadialGradient(px, py, 0, px, py, 24);
    glow.addColorStop(0, 'rgba(255,200,120,0.16)');
    glow.addColorStop(1, 'rgba(255,200,120,0)');
    g.fillStyle = glow; g.beginPath(); g.arc(px, py, 24, 0, Math.PI * 2); g.fill();
  }
  for (const p of P) {
    g.fillStyle = 'rgba(255,238,205,0.8)';
    g.beginPath(); g.arc(x(p.lng), y(p.lat), 4.2, 0, Math.PI * 2); g.fill();
  }
</script></body></html>`;

mkdirSync(path.dirname(OUT), { recursive: true });
const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: W, height: H } });
// A script error leaves a blank canvas that looks like a finished image.
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.setContent(html);
if (errors.length) throw new Error(`the drawing failed: ${errors.join('; ')}`);
// JPEG, like the cards: a gradient and soft glows are what PNG is worst at.
await page.screenshot({ path: OUT, type: 'jpeg', quality: 82 });
await browser.close();
console.log(`wrote ${path.relative(process.cwd(), OUT)} — ${parishes.length} parishes from ${ORIGIN}`);
