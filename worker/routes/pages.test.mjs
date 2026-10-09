// Shared links answered with a lite card, through the real route and a real
// database (the seed, with St George Redfern given the acronym it has in
// production).
//
// What must hold: the links people send get a page that says what they are —
// title, preview, canonical, robots, structured data — and every other path,
// and any failure, falls through to the app untouched.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { servePage, liteKind, hasAdminCookie } from './pages.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

class D1 {
  constructor(db) { this.db = db; }
  prepare(sql) { return new S(this.db, sql, []); }
  async batch(stmts) { return this.db.transaction(() => stmts.map(s => s._runSync()))(); }
}
class S {
  constructor(db, sql, a) { this.db = db; this.sql = sql; this.args = a; }
  bind(...a) { return new S(this.db, this.sql, a); }
  _runSync() { const r = this.db.prepare(this.sql).run(...this.args); return { meta: { changes: r.changes } }; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.args) }; }
  async first() { const r = this.db.prepare(this.sql).get(...this.args); return r === undefined ? null : r; }
  async run() { return this._runSync(); }
}

const PARISH = 'antiochian-stgeorge-redfern';
// Wednesday 30 September 2026, midday in Sydney.
const NOW = Date.parse('2026-09-30T02:00:00Z');

function fresh() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-lite-')), 'x.db');
  const raw = new Database(file);
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  raw.prepare("UPDATE parishes SET acronym = 'SGR' WHERE id = ?").run(PARISH);
  const env = { DB: new D1(raw) };
  const get = async (p, init = {}) => {
    const res = await servePage(new Request(`https://orthodoxy.au${p}`, init), env, {}, { now: NOW });
    return res ? { res, html: await res.clone().text() } : null;
  };
  return { raw, env, get };
}

const meta = (html, attr, name) => {
  const m = new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`).exec(html);
  return m ? m[1] : null;
};
const canonical = (html) => (/<link rel="canonical" href="([^"]*)"/.exec(html) || [])[1];
// A Saturday 6pm Vespers beside the seed's Sunday 10am Liturgy: one evening rule, one morning.
const VESPERS = `INSERT INTO schedules (parish_id, day_of_week, start_time, title, event_type)
                 VALUES (?, 6, '18:00', 'Vespers', 'prayer')`;
const between = (html, from, to) => html.slice(html.indexOf(from), to ? html.indexOf(to) : undefined);

test('which paths are lite pages', () => {
  const kinds = {
    '/sgr': 'parish', '/SGR/next-tue': 'parish', '/sgr/wed/liturgy': 'parish',
    '/sgr/evening': 'parish', '/sgr/sun/morning/liturgy': 'parish',
    '/sgr/services': 'parish', '/services/sgr': 'parish', '/sgr/evening/services': 'parish',
    '/102': 'event', '/42:2026-10-04': 'event',
    '/greek': 'timetable', '/qld': 'timetable', '/greek/qld': 'timetable', '/services': 'timetable',
    '/liturgy': 'timetable', '/evening': 'timetable', '/wed/evening/vespers': 'timetable',
    '/en': 'timetable', '/smg+sgr': 'timetable', '/greek/services': 'timetable',
    '/': null, '/greek/next-sun': null, '/liturgy/2026-10-04': null, '/social': null, '/greek/social': null,
    '/donate': null, '/greek/donate': null, '/greek/sgr': null,
    '/sgr/en': null, '/sgr/donate': null, '/admin': null, '/api/bundle': null,
    '/102/services': null, '/102/evening': null, '/%E0%A4%A': null,
  };
  for (const [p, want] of Object.entries(kinds)) {
    const k = liteKind(p, NOW);
    assert.equal(k ? k.kind : null, want, p);
  }
});

test('a parish link is a page that says what it is, and is indexable', async () => {
  const { get } = fresh();
  const { res, html } = await get('/sgr');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-agora-page'), 'lite');
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(html, /<title>St George Cathedral, Redfern — Antiochian Orthodox service times \| orthodoxy\.au<\/title>/);
  assert.equal(canonical(html), 'https://orthodoxy.au/sgr');
  assert.equal(meta(html, 'name', 'robots'), 'index,follow');
  assert.match(meta(html, 'name', 'description'), /Sun 10am/);
  assert.equal(meta(html, 'property', 'og:image'), 'https://orthodoxy.au/og/antiochian.jpg',
    'no poster and no logo: the jurisdiction card');
  const ld = JSON.parse(/<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html)[1]);
  assert.equal(ld['@type'], 'Church');
  assert.equal(ld.url, 'https://orthodoxy.au/sgr');
  assert.match(html, /← Back to App/);
  assert.match(html, /<a class="lc-app" href="\/sgr\?app">/, 'the way into the app with this card open');
  assert.match(html, /<details class="lc-ev/, 'the occurrences open without JavaScript');
});

test('a relative date settles on its day, pins what is on then, and stays out of the index', async () => {
  const { get } = fresh();
  const { html } = await get('/sgr/next-sun');
  assert.equal(canonical(html), 'https://orthodoxy.au/sgr/2026-10-04');
  assert.equal(meta(html, 'name', 'robots'), 'noindex,follow');
  assert.match(html, /<article class="lc-pin[^"]*"[^>]*>[\s\S]*Sunday Divine Liturgy/);
});

test('a quiet day pins nothing and says so; a month pins nothing', async () => {
  const { get } = fresh();
  const quiet = (await get('/sgr/next-thu')).html;
  assert.doesNotMatch(quiet, /<article class="lc-pin/);
  assert.match(quiet, /Nothing on Thursday 1 October/);
  assert.doesNotMatch((await get('/sgr/october')).html, /<article class="lc-pin/);
});

test('a service link pins its next occurrence and lists only that service', async () => {
  const { raw, get } = fresh();
  raw.prepare(VESPERS).run(PARISH);
  const { html } = await get('/sgr/vespers');
  // The next one is pinned, so a chat preview says WHEN, not just what.
  assert.match(html, /<title>Vespers — Saturday 3 October, 6pm · St George Cathedral, Redfern/);
  assert.match(html, /<h2 id="ll-h">Vespers<\/h2>/, 'the list is headed by the service');
  const list = html.slice(html.indexOf('class="lc-list"'), html.indexOf('class="lc-times"'));
  assert.doesNotMatch(list, /Divine Liturgy/, 'the list is narrowed to the service');
  assert.match(list, /Vespers/);
});

test('a part of the day narrows the card to its services and pins the next one', async () => {
  const { raw, get } = fresh();
  raw.prepare(VESPERS).run(PARISH);
  const { html } = await get('/sgr/evening');
  assert.equal(canonical(html), 'https://orthodoxy.au/sgr/evening');
  assert.equal(meta(html, 'name', 'robots'), 'noindex,follow');
  assert.match(html, /<title>Vespers — Saturday 3 October, 6pm · St George Cathedral, Redfern/);
  assert.match(html, /<h2 id="ll-h">Evening services<\/h2>/);
  const list = between(html, 'class="lc-list"', 'class="lc-times"');
  assert.match(list, /Vespers/);
  assert.doesNotMatch(list, /Divine Liturgy/, 'a 10am liturgy is a morning one');

  const morning = between((await get('/sgr/sun/morning/liturgy')).html, 'class="lc-list"', 'class="lc-times"');
  assert.match(morning, /Sunday Divine Liturgy/);
  assert.doesNotMatch(morning, /Vespers/);
});

test('/services is the timetable, narrowed by the link, then the way to the upcoming events', async () => {
  const { raw, get } = fresh();
  raw.prepare(VESPERS).run(PARISH);
  const all = (await get('/sgr/services')).html;
  assert.equal(canonical(all), 'https://orthodoxy.au/sgr/services');
  assert.equal(meta(all, 'name', 'robots'), 'noindex,follow');
  assert.doesNotMatch(all, /class="lc-list"/, 'no list of dates');
  assert.doesNotMatch(all, /<article class="lc-pin/, 'and nothing pinned');
  const times = between(all, 'class="lc-times"');
  assert.match(times, /Sunday Divine Liturgy/);
  assert.match(times, /Vespers/);
  assert.ok(all.indexOf('class="lc-times"') < all.indexOf('class="lc-app"'), 'the button is under the timetable');
  assert.match(all, /<a class="lc-app" href="\/sgr\?app">View upcoming events →<\/a>/,
    'the app, with every filter but /services');

  const eve = (await get('/services/sgr/evening')).html;
  assert.equal(canonical(eve), 'https://orthodoxy.au/sgr/evening/services');
  assert.match(eve, /<title>Evening services at St George Cathedral, Redfern — service times/);
  assert.match(eve, /<h2 id="lt-h">Evening services<\/h2>/);
  assert.doesNotMatch(between(eve, 'class="lc-times"'), /Divine Liturgy/);
  assert.match(eve, /<a class="lc-app" href="\/sgr\/evening\?app">View upcoming events →<\/a>/);

  const none = (await get('/sgr/wed/services')).html;
  assert.match(none, /No service on the timetable matches\./, 'an empty timetable says so');
  assert.match(none, /href="\/sgr\/wed\?app"/);
});

test('the way into the app is a button directly above the list', async () => {
  const { get } = fresh();
  for (const p of ['/sgr', '/sgr/next-sun', '/sgr/liturgy']) {
    const { html } = await get(p);
    const btn = html.indexOf('<a class="lc-app"');
    assert.ok(btn > 0, `${p} has the button`);
    assert.ok(btn < html.indexOf('class="lc-list"'), `${p}: above the list`);
    assert.ok(btn > html.indexOf('class="lc-info"'), `${p}: under the parish's links`);
    assert.doesNotMatch(between(html, 'class="lc-foot"'), /\?app/, `${p}: not in the small print`);
  }
  assert.match((await get('/sgr/next-sun')).html, /<a class="lc-app" href="\/sgr\/2026-10-04\?app">Open in the app →<\/a>/);
});

test('an event link — projected or stored — pins that event on its parish card', async () => {
  const { raw, get } = fresh();
  const sid = raw.prepare('SELECT id FROM schedules WHERE parish_id = ? LIMIT 1').get(PARISH).id;
  const proj = (await get(`/${sid}:2026-10-04`)).html;
  assert.match(proj, /<title>Sunday Divine Liturgy — Sunday 4 October, 10am/);
  assert.equal(meta(proj, 'name', 'robots'), 'noindex,follow');
  assert.equal(canonical(proj), `https://orthodoxy.au/${sid}:2026-10-04`);

  const id = raw.prepare(`INSERT INTO events (parish_id, source_adapter, title, start_utc, end_utc,
      event_type, status, mutation_type, poster_path)
    VALUES (?, 'manual', 'Feast of St George', '2026-10-10T23:00:00Z', '2026-10-11T01:00:00Z',
      'feast', 'approved', 'headless', '/posters/x.jpg') RETURNING id`).get(PARISH).id;
  const stored = (await get(`/${id}`)).html;
  assert.match(stored, /<h2>Feast of St George<\/h2>/);
  assert.equal(meta(stored, 'property', 'og:image'), 'https://orthodoxy.au/posters/x.jpg', 'the poster previews');
  assert.equal(meta(stored, 'name', 'twitter:card'), 'summary_large_image');
});

test('a cancelled occurrence previews as cancelled', async () => {
  const { raw, get } = fresh();
  const sid = raw.prepare('SELECT id FROM schedules WHERE parish_id = ? LIMIT 1').get(PARISH).id;
  raw.prepare(`INSERT INTO schedule_overrides (schedule_id, occurrence_date, kind) VALUES (?, '2026-10-04', 'cancelled')`).run(sid);
  const { html } = await get(`/${sid}:2026-10-04`);
  assert.match(meta(html, 'name', 'description'), /^CANCELLED\./);
  assert.match(html, /class="lc-pin tomb"/);
});

test('everything else is the app, and so is any failure', async () => {
  const { env, get } = fresh();
  for (const p of ['/', '/nosuch', '/nosuch+other', '/greek?app', '/sgr?app', '/999999', '/greek/next-sun']) {
    assert.equal(await get(p), null, p);
  }
  assert.equal(await get('/sgr', { headers: { cookie: 'x=1; agora_admin=1' } }), null, 'admins get the app');
  assert.equal(hasAdminCookie(new Request('https://x/', { headers: { cookie: 'agora_admin=0' } })), false);
  assert.equal(await get('/sgr', { method: 'POST' }), null);

  const broken = { DB: { prepare() { throw new Error('D1 is down'); } } };
  const res = await servePage(new Request('https://orthodoxy.au/sgr'), broken, {}, { now: NOW });
  assert.equal(res, null, 'a page that cannot be built falls back to the app');
  assert.ok(env);
});

test('a name cannot break out of the page or its structured data', async () => {
  const { raw, get } = fresh();
  raw.prepare(`UPDATE parishes SET full_name = ? WHERE id = ?`).run('St George </script><b>x</b> "q"', PARISH);
  const { html } = await get('/sgr');
  assert.doesNotMatch(html, /<\/script><b>/);
  assert.match(html, /St George \\u003c\/script>\\u003cb>/, 'JSON-LD escapes <');
  assert.match(html, /<h1>St George &lt;\/script&gt;&lt;b&gt;x&lt;\/b&gt; &quot;q&quot;<\/h1>/);
});

test('the sitemap lists every parish and nothing else', async () => {
  const { raw, get } = fresh();
  const { res, html } = await get('/sitemap.xml');
  assert.match(res.headers.get('content-type'), /xml/);
  const locs = [...html.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);
  const n = raw.prepare("SELECT COUNT(*) n FROM parishes WHERE id != '_unassigned'").get().n;
  assert.equal(locs.length, n + 1, 'the home page and every parish');
  assert.ok(locs.includes('https://orthodoxy.au/sgr'), 'by acronym where there is one');
  assert.ok(locs.every(l => !/\d+:\d{4}/.test(l)), 'no events');
});

test('HEAD gets the headers without the body', async () => {
  const { env } = fresh();
  const res = await servePage(new Request('https://orthodoxy.au/sgr', { method: 'HEAD' }), env, {}, { now: NOW });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
});

test('the timetable drops an ended rule and marks one that starts later', async () => {
  const { raw, get } = fresh();
  raw.prepare(`INSERT INTO schedules (parish_id, day_of_week, start_time, title, event_type, effective_to)
               VALUES (?, 3, '07:00', 'Old Matins', 'prayer', '2026-09-01')`).run(PARISH);
  raw.prepare(`INSERT INTO schedules (parish_id, day_of_week, start_time, title, event_type, effective_from)
               VALUES (?, 3, '18:00', 'Presanctified Liturgy', 'liturgy', '2026-11-04')`).run(PARISH);
  raw.prepare(`INSERT INTO schedules (parish_id, day_of_week, start_time, title, event_type, effective_to)
               VALUES (?, 4, '18:00', 'Paraklesis', 'prayer', '2026-10-15')`).run(PARISH);
  const { html } = await get('/sgr');
  const times = html.slice(html.indexOf('class="lc-times"'));
  assert.doesNotMatch(times, /Old Matins/);
  assert.match(times, /Presanctified Liturgy<small>from 4 Nov<\/small>/);
  assert.match(times, /Paraklesis<small>until 15 Oct<\/small>/);
  assert.doesNotMatch(/<meta name="description" content="([^"]*)"/.exec(html)[1], /Presanctified/,
    'a rule that has not started is not what the times are');
});

test('the lite card offers "Is this your parish?" through the claim page', async () => {
  const { get } = fresh();
  const { html } = await get('/sgr');
  assert.match(html, /<a href="\/admin\?claim=antiochian-stgeorge-redfern" rel="nofollow">Is this your parish\? Help keep its times right/);
});

// ── the timetable page: a link that names no single parish ───────────────

const GREEK_QLD = 'greek-gopssc-buderim';
const rule = (raw, parish, dow, time, title, extra = {}) => {
  const cols = ['parish_id', 'day_of_week', 'start_time', 'title', 'event_type', ...Object.keys(extra)];
  raw.prepare(`INSERT INTO schedules (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(parish, dow, time, title, /liturg/i.test(title) ? 'liturgy' : 'prayer', ...Object.values(extra));
};
const regions = (html) => [...html.matchAll(/<section class="tt-region" aria-label="([^"]*)"/g)].map(m => m[1]);
const names = (html) => [...html.matchAll(/<a class="tt-name" href="[^"]*">([^<]*)<\/a>/g)].map(m => m[1]);

test('/services is every parish timetable, by state then jurisdiction, alphabetical', async () => {
  const { raw, get } = fresh();
  rule(raw, GREEK_QLD, 0, '09:00', 'Divine Liturgy');
  const { res, html } = await get('/services');
  assert.equal(res.headers.get('x-agora-page'), 'lite');
  assert.equal(canonical(html), 'https://orthodoxy.au/services');
  assert.equal(meta(html, 'name', 'robots'), 'noindex,follow', 'not indexed yet');
  assert.match(html, /<h1>Orthodox service times<\/h1>/);
  assert.deepEqual(regions(html), ['New South Wales', 'Queensland']);
  const nsw = between(html, 'aria-label="New South Wales"', 'aria-label="Queensland"');
  assert.match(nsw, /<h3 class="tt-juris"[^>]*>Antiochian Orthodox<\/h3>/, 'a mixed page names the jurisdiction');
  const listed = names(nsw);
  assert.deepEqual(listed, [...listed].sort((a, b) => a.localeCompare(b)), 'parishes alphabetical');
  assert.ok(listed.includes('St George Cathedral, Redfern'));
  assert.match(html, /<a class="tt-name" href="\/sgr">St George Cathedral, Redfern<\/a>/, 'a parish links to its card');
  assert.match(between(html, 'aria-label="Queensland"'), /Sunshine Coast, Buderim[\s\S]*Sun 9am[\s\S]*Divine Liturgy/);
  const n = raw.prepare(`SELECT COUNT(*) n FROM parishes p WHERE id != '_unassigned'
    AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.parish_id = p.id)`).get().n;
  assert.match(html, new RegExp(`<a class="tt-more" href="/services\\?app#no-times">${n} parish(es)? without service times on file →</a>`),
    'the parishes with no times are a count, and it opens the app\'s Schedules view');
  assert.match(html, /<a class="lc-app" href="\/\?app">View upcoming events →<\/a>/);
  assert.ok(html.indexOf('class="tt-more"') < html.indexOf('class="lc-app"'), 'the count sits under the timetable');
});

test('a jurisdiction and a region narrow the parishes; the canonical is the app\'s order', async () => {
  const { raw, get } = fresh();
  rule(raw, GREEK_QLD, 0, '09:00', 'Divine Liturgy');
  const { html } = await get('/QLD/services/greek');
  assert.equal(canonical(html), 'https://orthodoxy.au/greek/qld', '/services is what the page is, not part of its name');
  assert.match(html, /<h1>Greek Orthodox service times in Queensland<\/h1>/);
  assert.deepEqual(names(html), ['Sunshine Coast, Buderim']);
  assert.doesNotMatch(html, /class="tt-juris"/, 'one jurisdiction needs no heading');
  assert.match(html, /href="\/greek\/qld\?app">View upcoming events/);
  assert.doesNotMatch(html, /class="tt-more"/, 'every Greek parish in Queensland has times');
  assert.match((await get('/greek')).html, /<a class="tt-more" href="\/greek\/services\?app#no-times">1 parish without/,
    'the other Greek parish has none');

  const antiochian = (await get('/antiochian/qld')).html;
  assert.match(antiochian, /No parishes on file here yet\./, 'the seed has no Antiochian parish in Queensland');
  assert.doesNotMatch(antiochian, /class="tt-parish"/);
});

test('a service, a day and a part of the day narrow the rules', async () => {
  const { raw, get } = fresh();
  rule(raw, PARISH, 6, '18:00', 'Vespers');
  const eve = (await get('/evening')).html;
  assert.match(eve, /<h1>Orthodox evening services<\/h1>/);
  assert.match(eve, /Sat 6pm<\/time><span>Vespers/);
  assert.doesNotMatch(between(eve, 'class="tt-region"'), /Sun 10am/, 'a morning liturgy is not an evening service');
  const lit = (await get('/sun/liturgy')).html;
  assert.match(lit, /<h1>Orthodox Liturgies on Sundays<\/h1>/);
  assert.doesNotMatch(between(lit, 'class="tt-region"', 'class="lc-app"'), /Vespers/);
  assert.match(lit, /href="\/sun\/liturgy\?app"/);
});

test('a language narrows to the rules served in it, falling back to the parish', async () => {
  const { raw, get } = fresh();
  raw.prepare(`UPDATE schedules SET languages = '["English"]' WHERE parish_id = ?`).run(PARISH);
  raw.prepare(`UPDATE parishes SET languages = '["Arabic","English"]' WHERE id = 'antiochian-stelias-wollongong'`).run();
  const strict = names((await get('/en')).html);
  assert.ok(strict.includes('St George Cathedral, Redfern'));
  assert.ok(!strict.includes('St Elias, Wollongong'), 'Arabic and English is not English only');
  assert.ok(names((await get('/bilingual')).html).includes('St Elias, Wollongong'));
});

test('several parishes by name, and the rules only their own card shows', async () => {
  const { raw, get } = fresh();
  raw.prepare("UPDATE parishes SET acronym = 'SMG' WHERE id = 'antiochian-stmichaelgabriel-ryde'").run();
  rule(raw, PARISH, 2, '19:00', 'Choir practice', { parish_scoped: 1 });
  const { html } = await get('/smg+sgr');
  assert.equal(canonical(html), 'https://orthodoxy.au/smg+sgr');
  assert.match(html, /<h1>Orthodox service times at Sts Michael &amp; Gabriel, Ryde and St George Cathedral, Redfern<\/h1>/);
  assert.deepEqual(names(html).sort(), ['St George Cathedral, Redfern', 'Sts Michael & Gabriel, Ryde'].map(x => x.replace('&', '&amp;')).sort());
  assert.doesNotMatch(html, /Choir practice/, 'parish_scoped stays on its own card');
  assert.match((await get('/sgr')).html, /Choir practice/);
});

test('an ended rule is off the timetable page too', async () => {
  const { raw, get } = fresh();
  rule(raw, PARISH, 3, '07:00', 'Old Matins', { effective_to: '2026-09-01' });
  rule(raw, PARISH, 3, '18:00', 'Presanctified Liturgy', { effective_from: '2026-11-04' });
  const { html } = await get('/antiochian');
  assert.doesNotMatch(html, /Old Matins/);
  assert.match(html, /Presanctified Liturgy<small>from 4 Nov<\/small>/);
});

