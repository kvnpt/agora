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
import { servePage, liteKind, hasAdminCookie, indexedCollections } from './pages.mjs';
import collections from '../../public/shared/collections.js';

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
const COLLECTION_PATHS = new Set(collections.COLLECTIONS.map(c => c.path));
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
// The card's two halves, as the app lays them out: the timetable box first,
// then the list of dates under the way into the app.
const timesOf = (html) => between(html, '<section class="lc-times', 'class="lc-app"');
const listOf = (html) => between(html, '<section class="lc-list"', '<footer class="lc-foot"');

test('which paths are lite pages', () => {
  const kinds = {
    '/sgr': 'parish', '/SGR/next-tue': 'parish', '/sgr/wed/liturgy': 'parish',
    '/sgr/evening': 'parish', '/sgr/sun/morning/liturgy': 'parish',
    '/sgr/timetables': 'parish', '/timetables/sgr': 'parish', '/sgr/evening/timetables': 'parish',
    '/102': 'event', '/42:2026-10-04': 'event',
    '/greek': 'timetable', '/qld': 'timetable', '/greek/qld': 'timetable', '/timetables': 'timetable',
    '/liturgy': 'timetable', '/evening': 'timetable', '/wed/evening/vespers': 'timetable',
    '/en': 'timetable', '/en-only': 'timetable', '/full-english': 'timetable',
    '/smg+sgr': 'timetable', '/greek/timetables': 'timetable',
    '/': null, '/greek/next-sun': null, '/liturgy/2026-10-04': null, '/social': null, '/greek/social': null,
    '/donate': null, '/greek/donate': null, '/greek/sgr': null,
    '/sgr/en': null, '/sgr/english-only': null, '/sgr/donate': null, '/admin': null, '/api/bundle': null,
    '/102/timetables': null, '/102/evening': null, '/%E0%A4%A': null,
    '/services': 'timetable', '/greek/services': 'timetable', '/prayer': 'timetable', '/parishes': 'timetable',
    '/sgr/services': null, '/talks': null, '/next-week': null, '/this-month': null, '/102/services': null,
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
  assert.match(html, /<a class="lite-close" href="\/" aria-label="[^"]*">&times;<\/a>/, 'an X back to the map');
  // The hero first, then the card over it with the X on its corner — the
  // parish sheet over the map.
  assert.match(html, /<body class="lite">\s*<header class="lite-hero">[\s\S]*?<\/header>\s*<main class="lite-card">\s*<a class="lite-close"/);
  // On the hero: the name, as text alone, and VIEW MAP — this card on the map.
  const hero = between(html, '<header class="lite-hero">', '</header>');
  assert.match(hero, /<a class="lite-hero-brand" href="\/"[^>]*>orthodoxy\.au<\/a>/);
  assert.doesNotMatch(hero, /<svg/, 'no cross beside the name');
  assert.match(hero, /<a class="lite-hero-map" href="\/sgr\?app" rel="nofollow">View map<\/a>/);
  assert.doesNotMatch(html, /lite-bar/, 'the old bar is gone');
  assert.doesNotMatch(html, /Back to App/);
  assert.match(html, /<link rel="stylesheet" href="\/app\.css">/, "the app's own stylesheet");
  assert.match(html, /<a class="lc-app" href="\/sgr\?app" rel="nofollow">/, 'the way into the app with this card open');
  assert.match(html, /<details class="lc-ev/, 'the occurrences open without JavaScript');
  // The timetable's box is the timetable; the list under it is what it projects.
  assert.match(html, /<h2 class="section-header jurisdiction-header" id="lt-h">Timetable<\/h2>/);
  assert.match(html, /<h2 class="section-header feed-header" id="ll-h"[^>]*>Coming up<\/h2>/);
});

test('a rule’s languages sit on its title’s line, before the chevron', async () => {
  const { raw, get } = fresh();
  raw.prepare(`UPDATE schedules SET languages = '["Arabic","English"]' WHERE parish_id = ?`).run(PARISH);
  const times = timesOf((await get('/sgr')).html);
  assert.match(times, /<span class="si-title"><span class="schedule-item-title"[^>]*>[^<]*<\/span><span class="schedule-item-lang">Arabic, English<\/span><img class="si-chev"/);
  assert.doesNotMatch(times, /<div class="si-meta">[^]*?schedule-item-lang/, 'not on a line of its own underneath');
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
  assert.match(html, /<h2 class="ps-focus-banner-text" id="ll-h">Showing Vespers<\/h2>/, 'the list is headed by the service');
  const list = listOf(html);
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
  assert.match(html, /<h2 class="ps-focus-banner-text" id="ll-h">Showing Evening services<\/h2>/);
  const list = listOf(html);
  assert.match(list, /Vespers/);
  assert.doesNotMatch(list, /Divine Liturgy/, 'a 10am liturgy is a morning one');

  const morning = listOf((await get('/sgr/sun/morning/liturgy')).html);
  assert.match(morning, /Sunday Divine Liturgy/);
  assert.doesNotMatch(morning, /Vespers/);
});

test('an old /worship, /services-liturgy or /studies link is sent to its name for good, keeping the rest', async () => {
  const { get } = fresh();
  for (const [from, to] of [['/worship', '/services'], ['/greek/worship-liturgy?x=1', '/greek/liturgy?x=1'],
    ['/sgr/services-feast', '/sgr/feast'], ['/worship?app', '/services?app'], ['/studies', '/talks']]) {
    const { res } = await get(from);
    assert.equal(res.status, 301, from);
    assert.equal(res.headers.get('location'), to, from);
  }
});

test('/timetables is the timetable, narrowed by the link, then the way to the upcoming events', async () => {
  const { raw, get } = fresh();
  raw.prepare(VESPERS).run(PARISH);
  const all = (await get('/sgr/timetables')).html;
  assert.equal(canonical(all), 'https://orthodoxy.au/sgr/timetables');
  assert.equal(meta(all, 'name', 'robots'), 'noindex,follow');
  assert.doesNotMatch(all, /class="lc-list"/, 'no list of dates');
  assert.doesNotMatch(all, /<article class="lc-pin/, 'and nothing pinned');
  const times = timesOf(all);
  assert.match(times, /Sunday Divine Liturgy/);
  assert.match(times, /Vespers/);
  assert.ok(all.indexOf('<section class="lc-times') < all.indexOf('class="lc-app"'), 'the button is under the timetable');
  assert.match(all, /<a class="lc-app" href="\/sgr\?app" rel="nofollow">View upcoming events →<\/a>/,
    'the app, with every filter but /timetables');
  assert.match(all, /<a class="lite-hero-map" href="\/sgr\?app" rel="nofollow">View map<\/a>/, 'and so is the map');

  const eve = (await get('/timetables/sgr/evening')).html;
  assert.equal(canonical(eve), 'https://orthodoxy.au/sgr/evening/timetables');
  assert.match(eve, /<title>Evening services at St George Cathedral, Redfern — service times/);
  assert.match(eve, /<h2 class="ps-focus-banner-text" id="ll-h">Showing Evening services<\/h2>/);
  assert.doesNotMatch(timesOf(eve), /Divine Liturgy/);
  assert.match(eve, /<a class="lc-app" href="\/sgr\/evening\?app" rel="nofollow">View upcoming events →<\/a>/);

  const none = (await get('/sgr/wed/timetables')).html;
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
  assert.match((await get('/sgr/next-sun')).html, /<a class="lc-app" href="\/sgr\/2026-10-04\?app" rel="nofollow">Open in the app →<\/a>/);
});

test('an event link — projected or stored — pins that event on its parish card', async () => {
  const { raw, get } = fresh();
  const sid = raw.prepare('SELECT id FROM schedules WHERE parish_id = ? LIMIT 1').get(PARISH).id;
  const proj = (await get(`/${sid}:2026-10-04`)).html;
  assert.match(proj, /<title>Sunday Divine Liturgy — Sunday 4 October, 10am/);
  assert.equal(meta(proj, 'name', 'robots'), 'noindex,follow');
  assert.equal(canonical(proj), `https://orthodoxy.au/${sid}:2026-10-04`);
  assert.match(proj, new RegExp(`<a class="lite-hero-map" href="/${sid}:2026-10-04\\?app" rel="nofollow">View map</a>`),
    'VIEW MAP opens the event on its parish');

  const id = raw.prepare(`INSERT INTO events (parish_id, source_adapter, title, start_utc, end_utc,
      event_type, status, mutation_type, poster_path)
    VALUES (?, 'manual', 'Feast of St George', '2026-10-10T23:00:00Z', '2026-10-11T01:00:00Z',
      'feast', 'approved', 'headless', '/posters/x.jpg') RETURNING id`).get(PARISH).id;
  const stored = (await get(`/${id}`)).html;
  assert.match(stored, /<h2 class="lc-pin-title">Feast of St George<\/h2>/);
  assert.equal(meta(stored, 'property', 'og:image'), 'https://orthodoxy.au/posters/x.jpg', 'the poster previews');
  assert.equal(meta(stored, 'name', 'twitter:card'), 'summary_large_image');
});

test('a cancelled occurrence previews as cancelled', async () => {
  const { raw, get } = fresh();
  const sid = raw.prepare('SELECT id FROM schedules WHERE parish_id = ? LIMIT 1').get(PARISH).id;
  raw.prepare(`INSERT INTO schedule_overrides (schedule_id, occurrence_date, kind) VALUES (?, '2026-10-04', 'cancelled')`).run(sid);
  const { html } = await get(`/${sid}:2026-10-04`);
  assert.match(meta(html, 'name', 'description'), /^CANCELLED\./);
  assert.match(html, /class="lc-pin ps-pinned-event tomb"/);
});

test('everything else is the app, and so is any failure', async () => {
  const { env, get } = fresh();
  for (const p of ['/', '/nosuch', '/nosuch+other', '/greek?app', '/sgr?app', '/999999', '/greek/next-sun']) {
    assert.equal(await get(p), null, p);
  }
  const admin = { headers: { cookie: 'x=1; agora_admin=1' } };
  assert.equal(await get('/sgr', admin), null, 'an admin at a parish gets the app, where its editors are');
  assert.equal(await get('/102', admin), null, 'and at an event');
  const tt = await get('/greek', admin);
  assert.equal(tt && tt.res.headers.get('x-agora-page'), 'lite', 'a timetable page is an admin\'s page too');
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
  assert.match(html, /<h1 class="ps-name">St George &lt;\/script&gt;&lt;b&gt;x&lt;\/b&gt; &quot;q&quot;<\/h1>/);
});

test('the sitemap lists every parish, and the collections that list somebody', async () => {
  const { raw, get } = fresh();
  const { res, html } = await get('/sitemap.xml');
  assert.match(res.headers.get('content-type'), /xml/);
  const locs = [...html.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]);
  const n = raw.prepare("SELECT COUNT(*) n FROM parishes WHERE id != '_unassigned'").get().n;
  const parishes = locs.filter(l => !COLLECTION_PATHS.has(l.slice('https://orthodoxy.au'.length)));
  assert.equal(parishes.length, n + 1, 'the home page and every parish');
  assert.ok(locs.includes('https://orthodoxy.au/sgr'), 'by acronym where there is one');
  assert.ok(locs.every(l => !/\d+:\d{4}/.test(l)), 'no events');
  const listed = locs.filter(l => COLLECTION_PATHS.has(l.slice('https://orthodoxy.au'.length)));
  for (const p of ['/en', '/sun/liturgy', '/greek', '/antiochian']) {
    assert.ok(listed.includes(`https://orthodoxy.au${p}`), `${p}: a collection with parishes in it`);
  }
  for (const p of ['/serbian', '/monasteries', '/talks', '/social']) {
    assert.ok(!listed.includes(`https://orthodoxy.au${p}`),
      `${p}: nobody in the seed, or the app's feed rather than a page`);
  }
});

test('a monastery on file puts /monasteries in the sitemap', () => {
  const { raw } = fresh();
  const parishes = raw.prepare("SELECT * FROM parishes WHERE id != '_unassigned'").all();
  const rules = raw.prepare('SELECT * FROM schedules WHERE active = 1').all();
  const ids = (ps) => indexedCollections({ parishes: ps, rules, overrides: {}, logos: {} }, NOW, 'https://orthodoxy.au')
    .map(c => c.id);
  assert.ok(!ids(parishes).includes('monasteries'));
  const named = parishes.map(p => (p.id === PARISH ? { ...p, name: 'St George Monastery, Redfern' } : p));
  assert.ok(ids(named).includes('monasteries'));
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
  const times = timesOf(html);
  assert.doesNotMatch(times, /Old Matins/);
  assert.match(times, /Presanctified Liturgy<\/span>[\s\S]*?<span class="schedule-item-range">from 4 Nov<\/span>/);
  assert.match(times, /Paraklesis<\/span>[\s\S]*?<span class="schedule-item-range">until 15 Oct<\/span>/);
  assert.doesNotMatch(/<meta name="description" content="([^"]*)"/.exec(html)[1], /Presanctified/,
    'a rule that has not started is not what the times are');
});

test('the lite card offers "Suggest edits" under its source line, not under the timetable', async () => {
  const { get } = fresh();
  for (const path of ['/sgr', '/sgr/timetables']) {
    const { html } = await get(path);
    const button = 'href="/admin?suggest=antiochian-stgeorge-redfern" data-parish-name="St George Antiochian Orthodox Cathedral" rel="nofollow">';
    assert.equal(html.split(button).length - 1, 1, `${path}: once`);
    assert.match(html, /<a class="ps-btn ps-btn-ghost ps-contribute lc-contrib" href="\/admin\?suggest=antiochian-stgeorge-redfern" data-parish-name="[^"]+" rel="nofollow"><span class="ps-btn-glyph"[^>]*><\/span>Suggest edits<\/a>/,
      `${path}: the app's button`);
    // It asks what should change before the sign-in (public/shared/suggest-dialog.js).
    assert.match(html, /<script src="\/shared\/suggest-dialog\.js" defer><\/script>/, `${path}: the dialog comes with it`);
    const info = html.slice(html.indexOf('<section class="ps-section lc-info">'), html.indexOf('</section>', html.indexOf('<section class="ps-section lc-info">')));
    assert.ok(info.includes(button), `${path}: in the parish's details`);
    assert.ok(info.indexOf(button) < info.indexOf('lc-actions'), `${path}: above the parish's own buttons`);
    // The seed gives St George's a source ("Parish website"), so the line is there.
    const src = info.indexOf('lc-src');
    assert.ok(src >= 0 && src < info.indexOf(button), `${path}: below the source line`);
    assert.doesNotMatch(html, /Is this your parish\?|Become a contributor/, `${path}: the old links are gone`);
  }
});

// ── the timetable page: a link that names no single parish ───────────────

const GREEK_QLD = 'greek-gopssc-buderim';
const rule = (raw, parish, dow, time, title, extra = {}) => {
  const cols = ['parish_id', 'day_of_week', 'start_time', 'title', 'event_type', ...Object.keys(extra)];
  raw.prepare(`INSERT INTO schedules (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(parish, dow, time, title, /liturg/i.test(title) ? 'liturgy' : 'prayer', ...Object.values(extra));
};
const regions = (html) => [...html.matchAll(/<section class="tt-region" aria-label="([^"]*)"/g)].map(m => m[1]);
const names = (html) => [...html.matchAll(/<span class="tt-name">([^<]*)<\/span>/g)].map(m => m[1]);

test('/timetables is every parish and its times, by state then jurisdiction, alphabetical', async () => {
  const { raw, get } = fresh();
  rule(raw, GREEK_QLD, 0, '09:00', 'Divine Liturgy');
  const { res, html } = await get('/timetables');
  assert.equal(res.headers.get('x-agora-page'), 'lite');
  assert.equal(canonical(html), 'https://orthodoxy.au/timetables');
  assert.equal(meta(html, 'name', 'robots'), 'noindex,follow', 'not indexed yet');
  assert.match(html, /<h1>Orthodox parishes and times<\/h1>/);
  assert.deepEqual(regions(html), ['New South Wales', 'Queensland', 'Victoria'], 'a state whose parishes have no times yet too');
  const nsw = between(html, 'aria-label="New South Wales"', 'aria-label="Queensland"');
  assert.match(nsw, /<div class="jurisdiction-box tt-juris-box"[^>]*>\s*<div class="section-header jurisdiction-header">Antiochian Archdiocese<\/div>/,
    "each jurisdiction in the app's framed box, named for what it is");
  const withTimes = names(nsw.slice(0, nsw.indexOf('<p class="tt-no-times">') < 0 ? undefined : nsw.lastIndexOf('<div class="parish-schedule', nsw.indexOf('<p class="tt-no-times">'))));
  assert.deepEqual(withTimes, [...withTimes].sort((a, b) => a.localeCompare(b)), 'parishes alphabetical');
  const listed = names(nsw);
  assert.ok(listed.includes('St George Cathedral, Redfern'));
  assert.match(html, /<a class="parish-schedule-head" href="\/sgr">[\s\S]*?<span class="tt-name">St George Cathedral, Redfern<\/span>/, 'a parish links to its card');
  assert.match(between(html, 'aria-label="Queensland"'), /Sunshine Coast, Buderim[\s\S]*<div class="schedule-day">Sunday<\/div>[\s\S]*9:00<span class="ampm">AM<\/span>[\s\S]*Divine Liturgy/);
  const n = raw.prepare(`SELECT COUNT(*) n FROM parishes p WHERE id != '_unassigned'
    AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.parish_id = p.id)`).get().n;
  assert.equal(html.split('<p class="tt-no-times">').length - 1, n,
    'the parishes with no times are listed in their own boxes, saying so');
  const box = between(html, 'aria-label="Queensland"');
  assert.ok(box.indexOf('Divine Liturgy') < box.indexOf('<p class="tt-no-times">'), 'under the ones with times');
  assert.doesNotMatch(html, /class="tt-more"/);
  assert.match(html, /<a class="lc-app" href="\/\?app" rel="nofollow">View upcoming events →<\/a>/);
  assert.match(html, /<a class="lite-hero-map" href="\/\?app" rel="nofollow">View map<\/a>/, 'every parish, so the map with no filters');
});

test('a jurisdiction and a region narrow the parishes; the canonical is the app\'s order', async () => {
  const { raw, get } = fresh();
  rule(raw, GREEK_QLD, 0, '09:00', 'Divine Liturgy');
  const { html } = await get('/QLD/timetables/greek');
  assert.equal(canonical(html), 'https://orthodoxy.au/greek/qld', '/timetables is what the page is, not part of its name');
  assert.match(html, /<a class="lite-hero-map" href="\/greek\/qld\?app" rel="nofollow">View map<\/a>/, "the map with the page's filters");
  assert.match(html, /<h1>Greek Orthodox parishes and times in Queensland<\/h1>/);
  assert.deepEqual(names(html), ['Sunshine Coast, Buderim']);
  assert.equal(html.split('class="jurisdiction-box tt-juris-box"').length - 1, 1, 'one jurisdiction, one box');
  assert.match(html, /href="\/greek\/qld\?app" rel="nofollow">View upcoming events/);
  assert.doesNotMatch(html, /<p class="tt-no-times">/, 'every Greek parish in Queensland has times');
  assert.equal((await get('/greek')).html.split('<p class="tt-no-times">').length - 1, 1, 'the other Greek parish has none');

  const antiochian = (await get('/antiochian/qld')).html;
  assert.match(antiochian, /No parishes on file here yet\./, 'the seed has no Antiochian parish in Queensland');
  assert.doesNotMatch(antiochian, /class="tt-parish"/);
});

test('a service, a day and a part of the day narrow the rules', async () => {
  const { raw, get } = fresh();
  rule(raw, PARISH, 6, '18:00', 'Vespers');
  const eve = (await get('/evening')).html;
  assert.match(eve, /<h1>Orthodox evening services<\/h1>/);
  assert.match(eve, /6:00<span class="ampm">PM<\/span><\/span><span class="si-title"><span class="schedule-item-title" title="Vespers">Vespers/);
  assert.doesNotMatch(between(eve, 'class="tt-region"'), /Sunday Divine Liturgy/, 'a morning liturgy is not an evening service');
  const lit = (await get('/sun/liturgy')).html;
  assert.match(lit, /<h1>Orthodox Liturgies on Sundays<\/h1>/);
  assert.doesNotMatch(between(lit, 'class="tt-region"', 'class="lc-app"'), /Vespers/);
  assert.match(lit, /href="\/sun\/liturgy\?app"/);
  // The parishes with no rules at all are not counted under a link that asks
  // something of the rules: nothing on file is not "no Liturgy".
  for (const p of ['/sun/liturgy', '/evening', '/antiochian/liturgy', '/en', '/en-only', '/services']) {
    assert.doesNotMatch((await get(p)).html, /<p class="tt-no-times">/, p);
  }
  assert.match((await get('/antiochian')).html, /<p class="tt-no-times">/,
    'a jurisdiction asks nothing of the rules, so it lists them');
});

test('/services is the service times: liturgy, prayer and feast, with whatever narrows it in the heading', async () => {
  const { raw, get } = fresh();
  rule(raw, PARISH, 2, '19:00', 'Bible Study');
  raw.prepare("UPDATE schedules SET event_type = 'talk' WHERE title = 'Bible Study'").run();
  const all = (await get('/services')).html;
  assert.match(all, /<h1>Orthodox service times<\/h1>/);
  assert.equal(canonical(all), 'https://orthodoxy.au/services');
  assert.match(all, /Sunday Divine Liturgy/);
  assert.doesNotMatch(all, /Bible Study/, 'a talk is not a service');
  assert.match((await get('/greek/services/en')).html, /<h1>Greek Orthodox service times in English<\/h1>/);
  assert.match((await get('/prayer')).html, /<h1>Orthodox prayer services<\/h1>/);
});

test('a language narrows to the rules served in it, falling back to the parish', async () => {
  const { raw, get } = fresh();
  raw.prepare(`UPDATE schedules SET languages = '["English"]' WHERE parish_id = ?`).run(PARISH);
  raw.prepare(`UPDATE parishes SET languages = '["Arabic","English"]' WHERE id = 'antiochian-stelias-wollongong'`).run();
  const full = (await get('/en-only')).html;
  assert.ok(names(full).includes('St George Cathedral, Redfern'));
  assert.ok(!names(full).includes('St Elias, Wollongong'), 'Arabic and English is not English only');
  assert.match(full, /<h1>Orthodox fully-English services<\/h1>/);
  assert.equal(canonical(full), 'https://orthodoxy.au/en-only');
  for (const p of ['/en', '/english', '/bilingual', '/half-english', '/english-half', '/some-english']) {
    const { html } = await get(p);
    assert.ok(names(html).includes('St Elias, Wollongong'), p);
    assert.ok(names(html).includes('St George Cathedral, Redfern'), p);
    assert.match(html, /<h1>Orthodox services in English<\/h1>/, p);
    assert.equal(canonical(html), 'https://orthodoxy.au/en', p);
  }
  for (const p of ['/english-only', '/full-english']) {
    assert.equal(canonical((await get(p)).html), 'https://orthodoxy.au/en-only', p);
  }
  const lit = (await get('/sun/liturgy/full-english')).html;
  assert.match(lit, /<h1>Orthodox fully-English Liturgies on Sundays<\/h1>/);
  assert.equal(canonical(lit), 'https://orthodoxy.au/sun/liturgy/en-only');
});

test('several parishes by name, and the rules only their own card shows', async () => {
  const { raw, get } = fresh();
  raw.prepare("UPDATE parishes SET acronym = 'SMG' WHERE id = 'antiochian-stmichaelgabriel-ryde'").run();
  rule(raw, PARISH, 2, '19:00', 'Choir practice', { parish_scoped: 1 });
  const { html } = await get('/smg+sgr');
  assert.equal(canonical(html), 'https://orthodoxy.au/smg+sgr');
  assert.match(html, /<h1>Orthodox parishes and times at Sts Michael &amp; Gabriel, Ryde and St George Cathedral, Redfern<\/h1>/);
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
  assert.match(html, /Presanctified Liturgy<\/span>[\s\S]*?<span class="schedule-item-range">from 4 Nov<\/span>/);
});


test("a page wears the app's colours: the jurisdiction's, as /admin set it, and the dark lift", async () => {
  const { raw, get } = fresh();
  raw.prepare(`INSERT INTO jurisdiction_colors (jurisdiction, color) VALUES ('antiochian', '#123456')`).run();
  const { html } = await get('/sgr');
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)[1];
  assert.match(style, /:root\{[^}]*--parish:#123456/, "the parish wears its jurisdiction's, as /admin set it");
  assert.match(style, /:root\{[^}]*--juris:#123456/, 'and so does the timetable box');
  assert.match(style, /@media \(prefers-color-scheme:dark\)\{:root\{[^}]*--juris:#[0-9a-f]{6}/, 'with a dark variant');
  assert.doesNotMatch(/@media \(prefers-color-scheme:dark\)\{:root\{([^}]*)\}/.exec(style)[1], /--juris:#123456/,
    'lifted, as the app lifts it, not repeated');
  // And the timetable page reads the same overrides.
  const tt = (await get('/antiochian')).html;
  assert.match(tt, /--j-antiochian:#123456/);
});

// ── A multi-day event's span on the lite card ──

test('a multi-day event says its span; a vigil past midnight does not', async () => {
  const { multiDaySpan } = await import('../lib/lite-page.mjs');
  const zone = 'Australia/Sydney';
  // Fri 13 Nov 6pm – Sun 15 Nov 4pm, Sydney (+11).
  assert.equal(multiDaySpan({ start_utc: '2026-11-13T07:00:00.000Z', end_utc: '2026-11-15T05:00:00.000Z' }, zone),
    'Fri 13 – Sun 15 Nov, until 4pm');
  // Across a month.
  assert.equal(multiDaySpan({ start_utc: '2026-10-30T07:00:00.000Z', end_utc: '2026-11-01T05:00:00.000Z' }, zone),
    'Fri 30 Oct – Sun 1 Nov, until 4pm');
  // 11pm–3am is the one night, not two days.
  assert.equal(multiDaySpan({ start_utc: '2026-11-14T12:00:00.000Z', end_utc: '2026-11-14T16:00:00.000Z' }, zone), null);
  assert.equal(multiDaySpan({ start_utc: '2026-11-14T12:00:00.000Z', end_utc: null }, zone), null);
});

test('an event and a rule held at another parish, or a place, say where on the card', async () => {
  const { raw, get } = fresh();
  const venue = raw.prepare(`SELECT id, name, address FROM parishes
    WHERE id NOT IN (?, '_unassigned') AND address IS NOT NULL ORDER BY id LIMIT 1`).get(PARISH);
  raw.prepare(`INSERT INTO schedules (parish_id, day_of_week, start_time, title, event_type, location_parish_id)
               VALUES (?, 5, '19:00', 'Youth group', 'youth', ?)`).run(PARISH, venue.id);
  const at = raw.prepare(`INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type, status,
      mutation_type, location_parish_id)
    VALUES (?, 'manual', 'Deanery Vespers', '2026-10-03T07:00:00Z', 'vespers', 'approved', 'headless', ?)
    RETURNING id`).get(PARISH, venue.id).id;
  const away = raw.prepare(`INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type, status,
      mutation_type, location_override, location_lat, location_lng)
    VALUES (?, 'manual', 'Youth retreat', '2026-10-04T00:00:00Z', 'youth', 'approved', 'headless',
      'Antiochian Village, Kangaroo Valley', -34.75, 150.53) RETURNING id`).get(PARISH).id;

  const card = (await get(`/${at}`)).html;
  const pin = between(card, '<section class="lc-pin', '<section class="lc-times');
  assert.ok(pin.includes(`@ ${venue.name}`) || card.includes(`<span class="event-venue"> @ ${venue.name}`),
    'the card does not say which parish it is at');
  assert.ok(card.includes(`${venue.name} — ${venue.address}`), 'the details give the parish\'s own address, not the host\'s');
  assert.ok(timesOf((await get('/sgr')).html).includes(`At ${venue.name}`), 'the rule held at another parish does not say so');

  const place = (await get(`/${away}`)).html;
  assert.ok(place.includes('<span class="event-venue"> @ Antiochian Village</span>'), 'a place is not named by its first words');
  assert.ok(place.includes('<p class="lf-where">Antiochian Village, Kangaroo Valley</p>'));
});

// ── the timetable starts today; a parish with no logo wears its acronym ──

test('a timetable reads from today round the week, and a parish with no logo shows its acronym', async () => {
  const { weekFrom, avatarHTML, timetableLabel } = await import('../lib/lite-page.mjs');
  const rules = [[0, '09:00'], [3, '18:00'], [6, '17:00'], [3, '07:00'], [1, '10:00']]
    .map(([day_of_week, start_time]) => ({ day_of_week, start_time }));
  const wed = '2026-10-14';   // a Wednesday
  assert.deepEqual([...rules].sort(weekFrom(wed)).map(r => `${r.day_of_week} ${r.start_time}`),
    ['3 07:00', '3 18:00', '6 17:00', '0 09:00', '1 10:00'], 'Wednesday first, then the week as it comes');
  const a = avatarHTML({ acronym: 'smg', name: 'Sts Michael & Gabriel' }, 'ps-avatar', 'var(--parish)');
  assert.match(a, /class="ps-avatar avatar-acronym" style="--avatar-ink:var\(--parish\);"/);
  assert.match(a, /data-len="3">SMG</);
  assert.match(avatarHTML({ logo_path: '/logos/x.png', acronym: 'SMG' }, 'ps-avatar', 'x'), /<img src="\/logos\/x\.png"/);
  assert.equal(timetableLabel('russian'), 'Russian Archdiocese');
});

test('an event\'s page: the card, then "More at this parish" for the next seven days, then the parish', async () => {
  const { raw, get } = fresh();
  rule(raw, PARISH, 3, '18:00', 'Vespers');
  const id = raw.prepare(`INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type, status, mutation_type)
    VALUES (?, 'manual', 'Parish picnic', '2026-10-03T01:00:00Z', 'social', 'approved', 'headless') RETURNING id`).get(PARISH).id;
  const { html } = await get(`/${id}`);
  assert.match(html, /<h2 class="lc-pin-title">Parish picnic<\/h2>/);
  const from = html.slice(html.indexOf('<section class="lc-list"'));
  const more = from.slice(0, from.indexOf('</section>'));
  assert.match(more, />More at this parish</);
  assert.match(more, /Vespers/, 'another rule\'s date this week');
  assert.doesNotMatch(more, /Parish picnic/, 'not the event itself again');
  assert.match(html, /<a class="lc-app" href="\/sgr">View St George Cathedral, Redfern →<\/a>/);
});

// ── collections: the timetable pages a search engine is offered ──────────

const img = (html) => meta(html, 'property', 'og:image');

test('a collection is indexed, under its own name, with its own preview', async () => {
  const { get } = fresh();
  const en = (await get('/en')).html;
  assert.equal(meta(en, 'name', 'robots'), 'index,follow');
  assert.equal(canonical(en), 'https://orthodoxy.au/en');
  assert.match(meta(en, 'name', 'description'), /^Parishes with services in English\. \d+ parish/,
    'what it holds, then who');
  assert.equal(img(en), 'https://orthodoxy.au/og/c-english.jpg');

  const sun = (await get('/liturgy/sunday')).html;
  assert.equal(canonical(sun), 'https://orthodoxy.au/sun/liturgy', 'however the link spells it');
  assert.equal(meta(sun, 'name', 'robots'), 'index,follow');
  assert.equal(img(sun), 'https://orthodoxy.au/og/c-sunday.jpg');

  const greek = (await get('/greek')).html;
  assert.equal(meta(greek, 'name', 'robots'), 'index,follow');
  assert.equal(img(greek), 'https://orthodoxy.au/og/greek.jpg', "the jurisdiction's card, with no logo");
});

test('every other link stays noindex: a hand-picked list, a mix of filters, an empty collection', async () => {
  const { raw, get } = fresh();
  rule(raw, GREEK_QLD, 0, '09:00', 'Divine Liturgy');
  for (const p of ['/smg+sgr', '/greek/qld', '/greek/en', '/sun', '/timetables', '/serbian', '/in-macedonian']) {
    const page = await get(p);
    if (page) assert.equal(meta(page.html, 'name', 'robots'), 'noindex,follow', p);
  }
  assert.equal(meta((await get('/greek/qld')).html, 'property', 'og:image'), 'https://orthodoxy.au/og/greek.jpg');
});

test("a jurisdiction's logo is its collection's preview once /admin has one", async () => {
  const { raw, get } = fresh();
  raw.prepare("INSERT INTO jurisdiction_logos (jurisdiction, logo_path) VALUES ('greek', '/logos/jurisdiction-greek.png?v=1')").run();
  // A row that is not one of ours is not served.
  raw.prepare("INSERT INTO jurisdiction_logos (jurisdiction, logo_path) VALUES ('antiochian', 'javascript:alert(1)')").run();
  assert.equal(img((await get('/greek')).html), 'https://orthodoxy.au/logos/jurisdiction-greek.png?v=1');
  assert.equal(img((await get('/antiochian')).html), 'https://orthodoxy.au/og/antiochian.jpg');
  assert.equal(img((await get('/greek/qld')).html), 'https://orthodoxy.au/og/greek.jpg', 'not a collection, so its card');
  raw.exec('DROP TABLE jurisdiction_logos');
  assert.equal(img((await get('/greek')).html), 'https://orthodoxy.au/og/greek.jpg', 'before migration 027, the card');
});

test('/monasteries is the monasteries, convents and sketes, by name', async () => {
  const { raw, get } = fresh();
  raw.prepare("UPDATE parishes SET name = 'Holy Monastery of St George, Redfern' WHERE id = ?").run(PARISH);
  raw.prepare("UPDATE parishes SET full_name = 'Pantanassa Skete' WHERE id = ?").run(GREEK_QLD);
  const { html } = await get('/monasteries');
  assert.match(html, /<h1>Orthodox monasteries and service times<\/h1>/);
  assert.deepEqual(names(html).sort(), ['Holy Monastery of St George, Redfern', 'Sunshine Coast, Buderim']);
  assert.equal(canonical(html), 'https://orthodoxy.au/monasteries');
  assert.equal(meta(html, 'name', 'robots'), 'index,follow');
  assert.match((await get('/greek/monasteries')).html, /<h1>Greek Orthodox monasteries and service times<\/h1>/);
  assert.equal(canonical((await get('/monastery/greek')).html), 'https://orthodoxy.au/greek/monasteries');
  assert.match((await get('/monasteries/sun/liturgy')).html, /<h1>Orthodox Liturgies at monasteries on Sundays<\/h1>/);
});
