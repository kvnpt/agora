// The doors: the page's main screens, opened in a real browser.
//
// CI runs the Worker and public/shared/ thoroughly and, until this file, none
// of next/next.js, next/editing.js, next/month.js or bundle.js. The bugs that
// reached people came through exactly that gap, and none was a logic error:
//
//   * Add service and Edit service would not open, 31 Oct to 3 Nov 2026
//     (#168, fixed in #183): two functions of one name in rule-form.js, so
//     wire() threw before either form showed.
//   * A cold dated link said "0 parishes in Sydney" (#209): the map counted
//     before the bundle came.
//
// docs/browser-checks.md: "The risk concentrates at the entry point to a new
// feature — the control that reveals it — not in the feature's behaviour."
// So each test here opens a door the way a person does, by tapping what they
// would tap, and checks the room behind it is there. It is not a test of what
// the rooms do; the suite under worker/ and d1/ is that.
//
// It starts its own Worker (`wrangler dev --local`, the dev bypass, so the
// browser is an owner) on a fresh database built from the baseline and the dev
// seed, in a directory of its own, so it neither needs nor touches the one
// `npm run dev` uses. Nothing outside the Worker is fetched.
//
//   npm run test:doors
//
// On a failure the page as it stood is saved to e2e/out/<test>.png (CI keeps
// e2e/out as an artifact).

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const PORT = Number(process.env.DOORS_PORT || 8797);
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = new URL('./out/', import.meta.url).pathname;
const RYDE = 'antiochian-stmichaelgabriel-ryde';   // in the seed: Sunday Liturgy at 9, Saturday Vespers at 5
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true };
const WIDE = { viewport: { width: 1280, height: 800 } };

let worker, browser, state, log = '';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

before(async () => {
  state = fs.mkdtempSync(path.join(os.tmpdir(), 'agora-doors-'));
  const fill = path.join(state, 'fill.sql');
  fs.writeFileSync(fill, fs.readFileSync('d1/schema.sql', 'utf8') + '\n' + fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  execFileSync('npx', ['wrangler', 'd1', 'execute', 'agora', '--local', '--persist-to', state, '--file', fill],
    { stdio: 'pipe', timeout: 120e3 });
  worker = spawn('npx', ['wrangler', 'dev', '--local', '--persist-to', state, '--var', 'AGORA_DEV_ADMIN:true',
    '--ip', '127.0.0.1', '--port', String(PORT)], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  worker.stdout.on('data', d => { log += d; });
  worker.stderr.on('data', d => { log += d; });
  // Ready when the admin ping answers, never after a fixed sleep: it takes 5 to 40s.
  for (let i = 0; ; i++) {
    const ok = await fetch(`${BASE}/api/admin/ping`).then(r => r.ok, () => false);
    if (ok) break;
    if (i > 90 || worker.exitCode !== null) throw new Error(`wrangler dev did not come up:\n${log.slice(-3000)}`);
    await sleep(1000);
  }
  browser = await chromium.launch();
});

after(async () => {
  if (browser) await browser.close();
  // The whole group: npx, wrangler and workerd under it.
  if (worker && worker.exitCode === null) {
    const gone = new Promise(r => worker.once('exit', r));
    try { process.kill(-worker.pid, 'SIGTERM'); } catch { /* gone */ }
    await Promise.race([gone, sleep(5000)]);
    try { process.kill(-worker.pid, 'SIGKILL'); } catch { /* gone */ }
  }
  if (state) fs.rmSync(state, { recursive: true, force: true });
});

/**
 * A page at `where`, as the full version (never the lite one, whatever the
 * machine), with every error it throws or logs collected. `t.after` checks
 * there were none and, on a failure, keeps a picture.
 */
async function open(t, where, device = PHONE) {
  const ctx = await browser.newContext(device);
  await ctx.addCookies([{ name: 'agora_lite', value: '0', url: BASE }]);
  await ctx.route(url => !url.href.startsWith(BASE), r => r.abort());
  const page = await ctx.newPage();
  page.setDefaultTimeout(15e3);
  const errors = [];
  page.on('pageerror', e => errors.push(`pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const at = m.location().url || '';
    // What was refused on purpose (anything not the Worker), and the basemap
    // archive, which is not in local R2.
    if ((at && !at.startsWith(BASE)) || at.includes('/tiles/')) return;
    errors.push(`console: ${m.text()}${at ? ` (${at})` : ''}`);
  });
  t.after(async () => {
    if (!t.passed || errors.length) {
      fs.mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: path.join(OUT, `${t.name.replace(/[^a-z0-9]+/gi, '-').slice(0, 80)}.png`) }).catch(() => {});
    }
    await ctx.close();
    assert.deepEqual(errors, [], 'the page threw or logged an error');
  });
  await page.goto(BASE + where, { waitUntil: 'load' });
  return page;
}

/** The page's own parish card (not the Worker's painted one, which is a plain link). */
const parishCard = (page) => page.locator('.sheet.parish.open:not(.ssr)');

/** Answer "keep it by hand?" if a read parish asks it (a seed parish is read from its directory). */
async function keepByHand(page) {
  const ask = page.locator('.choice-backdrop .choice-opt', { hasText: 'Keep it by hand' });
  await ask.waitFor({ timeout: 3000 }).then(() => ask.click(), () => {});
}

// ── home ──

for (const [name, device] of [['a phone', PHONE], ['a wide screen', WIDE]]) {
  test(`home on ${name}: the map, the parishes in view counted, and the collections`, async (t) => {
    const page = await open(t, '/', device);
    await page.locator('.maplibregl-canvas').waitFor();
    // The parish button under the map says how many are in view: the seed's
    // Sydney parishes, never 0 (#209 counted before the bundle came).
    await page.waitForFunction(() => /[1-9]/.test(document.querySelector('#inview')?.textContent || ''));
    assert.ok(await page.locator('[data-coll]').count() >= 1, 'no collections on the shelf');
  });
}

test('home → the parishes in view → a parish: its card opens', async (t) => {
  const page = await open(t, '/');
  await page.waitForFunction(() => /[1-9]/.test(document.querySelector('#inview')?.textContent || ''));
  await page.locator('#inview').click();
  const inView = page.locator('.sheet.collection.open');
  // "8 parishes in Sydney": counted with the bundle in, not before it.
  await inView.getByText(/^[1-9]\d* parishes in /).first().waitFor();
  await inView.locator('.cstack').click();
  await inView.locator(`.citem-head[data-parish="${RYDE}"]`).click();
  await parishCard(page).waitFor();
  assert.match(await parishCard(page).innerText(), /Sts Michael & Gabriel/);
});

// ── the account menu ──

test('the account menu: Notifications, Favourites and Saved open their cards', async (t) => {
  const page = await open(t, '/');
  const menu = page.locator('.popmenu');
  const row = async (sel) => {
    await page.locator('#btn-account').click();
    await menu.locator(sel).click();
  };
  // Notifications, for anybody with a role (the dev bypass is an owner):
  // read once it opens, never left at "Looking…".
  await row('[data-notes]');
  const notes = page.locator('.sheet.notes.open');
  await notes.locator('h1', { hasText: 'Notifications' }).waitFor();
  await page.waitForFunction(() => !/Looking…/.test(document.querySelector('.sheet.notes .sheet-scroll')?.textContent || ''));
  await notes.locator('[data-act="close"]').click();
  await row('[data-coll="list-fav"]');
  await page.locator('.sheet.collection.open h1', { hasText: 'Favourites' }).waitFor();
  await page.locator('.sheet.collection.open [data-act="close"]').first().click();
  await row('[data-act="bookmarks"]');
  await page.locator('.sheet.bookmarks.open h1', { hasText: 'Saved' }).waitFor();
});

// ── a parish's card, and its Calendar ──

test('a parish link opens its card: timetable and Calendar', async (t) => {
  const page = await open(t, `/${RYDE}`);
  const card = parishCard(page);
  await card.waitFor();
  assert.match(await card.innerText(), /Sunday Divine Liturgy[\s\S]*Saturday Vespers|Saturday Vespers[\s\S]*Sunday Divine Liturgy/);
  // The Calendar: the rules projected into dates, each a synthetic id.
  const rows = card.locator('.erow[data-event]');
  await rows.first().waitFor();
  const ids = await rows.evaluateAll(rs => rs.slice(0, 4).map(r => r.dataset.event));
  assert.equal(ids.length, 4);
  for (const id of ids) assert.match(id, /^\d+:\d{4}-\d\d-\d\d$/);
});

test('the Calendar\'s Month draws the month, with its services on it', async (t) => {
  const page = await open(t, `/${RYDE}`);
  const card = parishCard(page);
  await card.waitFor();
  const menu = card.locator('[data-cal-menu]').first();
  // Any scroll shuts the menu, so the button is brought into view first.
  await menu.scrollIntoViewIfNeeded();
  await sleep(400);
  await menu.click();
  await page.locator('.popmenu [data-cal-view="month"]').click();
  // next/month.js loads on the first tap of Month.
  await card.locator('.mg .mg-d').first().waitFor();
  assert.ok(await card.locator('.mg .mg-d').count() >= 28, 'not a month of days');
  assert.ok(await card.locator('.mg .mg-dots').count() >= 4, 'no services marked on the month');
});

// ── the editor's doors (the dev bypass: an owner) ──

test('Add service opens, and the service it adds is on the timetable', async (t) => {
  const page = await open(t, `/${RYDE}`);
  const card = parishCard(page);
  await card.locator('.add-box[data-suggest="A service time not listed"]').click();
  const form = page.locator('.rule-backdrop.open .rule-form');
  await form.waitFor();
  // The seven weekday ticks: what #168 replaced with the Date pill.
  assert.equal(await form.locator('[data-rf-days] input[type="checkbox"]').count(), 7, 'the seven weekday ticks are not there');
  await form.locator('[data-rf="title"]').fill('Paraklesis');
  await form.locator('[data-rf-days] label', { hasText: 'Wed' }).click();
  await page.locator('.rule-backdrop.open [data-frame-primary]').click();
  await keepByHand(page);
  await card.locator('[data-tt] .tt-line', { hasText: 'Paraklesis' }).waitFor();
  assert.equal(await page.locator('.rule-backdrop.open').count(), 0, 'the form stayed open');
  // The lines carry no pencil, for an editor as for anybody (Kevin, 19 Nov 2026).
  assert.equal(await card.locator('[data-tt] .tt-edit').count(), 0, 'a timetable line has a pencil');
});

// Since 19 Nov 2026 a line has no pencil: the way in is the line, its date's
// card, that card's Edit, then its date's menu: Edit series (20 Nov 2026).
test('Edit service opens from a line\'s date, with the service as it is, and saves', async (t) => {
  const page = await open(t, `/${RYDE}`);
  const card = parishCard(page);
  await card.locator('[data-tt] .tt-line', { hasText: 'Saturday Vespers' }).click();
  const date = page.locator('.sheet.event.open');
  await date.waitFor();
  await date.locator('.abtn[data-edit-event]').click();
  await page.locator('.event-edit-backdrop.open [data-f="date"] .cf-u').click();
  await page.locator('.cf-menu .cf-row', { hasText: 'Edit series' }).click();
  const form = page.locator('.rule-backdrop.open .rule-form');
  await form.waitFor();
  assert.equal(await form.locator('[data-rf="title"]').inputValue(), 'Saturday Vespers');
  assert.ok(await form.locator('[data-rf-days] input[value="6"]').isChecked(), 'Saturday is not ticked');
  await form.locator('[data-rf="title"]').fill('Great Vespers');
  await page.locator('.rule-backdrop.open [data-frame-primary]').click();
  await keepByHand(page);
  await card.locator('[data-tt] .tt-line', { hasText: 'Great Vespers' }).waitFor();
  assert.equal(await card.locator('[data-tt] .tt-line', { hasText: 'Saturday Vespers' }).count(), 0);
});
