// Every link, answered with the page and that link's head and card, through
// the real route and a real database (the seed, with St George Redfern given
// the acronym it has in production) and the page as it is in public/.
//
// What must hold: the links people send get the page with a head that says
// what they are — title, preview, canonical, robots, structured data — and
// the card they open painted in; a link to nothing is a 404; and any failure
// is the page as deployed, never no page.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { servePage, pageOf, indexedCollections } from './pages.mjs';
import { timetableModel } from '../lib/lite-timetable.mjs';
import collections from '../../public/shared/collections.js';
import urlState from '../../public/shared/url-state.js';

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
const GREEK_QLD = 'greek-gopssc-buderim';
const COLLECTION_PATHS = new Set(collections.COLLECTIONS.map(c => c.path));
// Wednesday 30 September 2026, midday in Sydney.
const NOW = Date.parse('2026-09-30T02:00:00Z');
const SHELL = fs.readFileSync('public/index.html', 'utf8');
const assets = (html = SHELL) => ({ fetch: async () => new Response(html) });

function fresh() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-page-')), 'x.db');
  const raw = new Database(file);
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  raw.prepare("UPDATE parishes SET acronym = 'SGR' WHERE id = ?").run(PARISH);
  const env = { DB: new D1(raw), ASSETS: assets() };
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
const title = (html) => (/<title>([^<]*)<\/title>/.exec(html) || [])[1];
const robots = (html) => meta(html, 'name', 'robots');
/** The card the Worker painted, or '' for none. */
const card = (html) => {
  const at = html.indexOf('<!--page:card-->') + '<!--page:card-->'.length;
  return html.slice(at, html.indexOf('</div>', at)).includes('<section') || html.slice(at).startsWith('<section')
    ? html.slice(at, html.indexOf('</div>\n\n  <script src="/shared/jurisdiction-colors.js"', at)) : '';
};
const between = (html, from, to) => html.slice(html.indexOf(from), to ? html.indexOf(to, html.indexOf(from)) : undefined);
const timesOf = (html) => between(card(html), '<div class="p-times">', '<div class="p-details">');
const comingUp = (html) => between(card(html), '<section class="cu-band"');
// A Saturday 6pm Vespers beside the seed's Sunday 10am Liturgy: one evening rule, one morning.
const VESPERS = `INSERT INTO schedules (parish_id, day_of_week, start_time, title, event_type)
                 VALUES (?, 6, '18:00', 'Vespers', 'prayer')`;
const rule = (raw, parish, dow, time, ruleTitle, extra = {}) => {
  const cols = ['parish_id', 'day_of_week', 'start_time', 'title', 'event_type', ...Object.keys(extra)];
  raw.prepare(`INSERT INTO schedules (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(parish, dow, time, ruleTitle, /liturg/i.test(ruleTitle) ? 'liturgy' : 'prayer', ...Object.values(extra));
};

/** The parishes a filter link lists, by name, from its timetable (as its head and card read it). */
function listed(raw, p) {
  const parishes = raw.prepare("SELECT * FROM parishes WHERE id != '_unassigned'").all();
  const rules = raw.prepare('SELECT * FROM schedules WHERE active = 1').all();
  const m = timetableModel({ parishes, rules, route: urlState.classifyPath(p, { today: '2026-09-30' }), now: NOW, origin: 'https://orthodoxy.au' });
  return m ? m.groups.flatMap(g => g.juris.flatMap(j => j.parishes.filter(x => x.rules.length).map(x => x.parish.name))) : null;
}

test('which kind of page a path is', () => {
  const kinds = {
    '/': 'home',
    '/sgr': 'parish', '/SGR/next-tue': 'parish', '/sgr/wed/liturgy': 'parish', '/sgr/evening': 'parish',
    '/sgr/timetables': 'parish', '/timetables/sgr': 'parish', '/greek/sgr': 'parish', '/sgr/en': 'parish', '/nosuch': 'parish',
    '/102': 'event', '/42:2026-10-04': 'event',
    '/greek': 'timetable', '/qld': 'timetable', '/greek/qld': 'timetable', '/timetables': 'timetable',
    '/liturgy': 'timetable', '/evening': 'timetable', '/wed/evening/vespers': 'timetable', '/en': 'timetable',
    '/smg+sgr': 'timetable', '/services': 'timetable', '/talks': 'timetable', '/social': 'timetable',
    '/monasteries': 'timetable', '/weeknights/services': 'timetable', '/in-arabic': 'timetable',
    '/greek/next-sun': 'other', '/liturgy/2026-10-04': 'other', '/greek/social': 'other', '/2026-10-25': 'other',
    '/donate': 'other', '/greek/donate': 'other', '/sgr/donate': 'other', '/next-week': 'other', '/%E0%A4%A': 'other',
    '/admin': null, '/api/bundle': null, '/next': null, '/next/sgr': null, '/apple-touch-icon.png': null, '/sitemap.xml': null,
  };
  for (const [p, want] of Object.entries(kinds)) {
    const page = pageOf(p, NOW);
    assert.equal(page ? page.kind : null, want, p);
  }
  assert.equal(pageOf('/sgr', NOW).indexable, true, 'its plain link');
  assert.equal(pageOf('/greek/sgr', NOW).indexable, false, 'the same card, under another link');
  assert.equal(pageOf('/sgr/en', NOW).indexable, false);
});

test('a parish link is the page, saying what it is, indexable, with its card painted in', async () => {
  const { get } = fresh();
  const { res, html } = await get('/sgr');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-agora-page'), 'parish');
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  assert.equal(title(html), 'St George Cathedral, Redfern — Antiochian Orthodox service times | orthodoxy.au');
  assert.equal(canonical(html), 'https://orthodoxy.au/sgr');
  assert.equal(robots(html), 'index,follow');
  assert.equal(meta(html, 'property', 'og:url'), 'https://orthodoxy.au/sgr');
  assert.equal(meta(html, 'property', 'og:type'), 'place');
  assert.match(meta(html, 'name', 'description'), /Sun 10am/);
  assert.equal(meta(html, 'property', 'og:image'), 'https://orthodoxy.au/og/antiochian.jpg',
    'no poster and no logo: the jurisdiction card');
  assert.equal(html.match(/<title>/g).length, 1, 'one title: the page\'s own was replaced, not added to');
  assert.equal(html.match(/<meta name="robots"/g).length, 1);
  const ld = JSON.parse(/<script type="application\/ld\+json">([^<]*)<\/script>/.exec(html)[1]);
  assert.equal(ld['@type'], 'Church');
  assert.equal(ld.url, 'https://orthodoxy.au/sgr');
  // The page itself: v3, its scripts and its map.
  assert.match(html, /<script src="\/next\/next\.js"><\/script>/);
  assert.match(html, /<div id="map"><\/div>/);
  assert.doesNotMatch(html, /lite-hero|lite-card|app\.css|\?app/, 'no lite page, no way "into the app"');
  // The card it opens, in the sheet's own class names, closing to the page.
  const c = card(html);
  assert.match(c, /^<section class="sheet parish open ssr" role="dialog" aria-label="St George Cathedral, Redfern"/);
  assert.match(c, /<div class="gtitle"><b>St George Cathedral, Redfern<\/b><small>Antiochian Orthodox<\/small><\/div>/);
  assert.match(c, /<a class="gbtn" href="\/" aria-label="Close">/);
  assert.match(c, /<h1>St George Antiochian Orthodox Cathedral<\/h1>/);
  assert.match(c, /<a class="abtn primary" href="https:\/\/www\.google\.com\/maps\/search\/\?api=1&amp;query=-33\.891,151\.2089" target="_blank" rel="noopener"><svg[^]*?<span>Google Maps<\/span>/,
    'Google Maps, at the place, never directions to it');
  assert.doesNotMatch(c, /maps\/dir\//);
  assert.match(c, /<a class="sum sum-link" href="\/antiochian"><small>Jurisdiction<\/small>/, 'the jurisdiction opens its collection');
  assert.match(c, /<div class="summary"><div class="sum"><small>Next Liturgy<\/small><b class="ok">Sun<br>10am<\/b><\/div>/, 'what is next, a Liturgy first');
  // Nothing today or tomorrow, nothing to say: no Today box, the timetable straight after.
  assert.doesNotMatch(c, /class="today card|Nothing more today/);
  assert.match(c, /<a class="sum sum-link"[^]*?<\/a><\/div>\s*<h2 class="sec">Timetable<\/h2>\s*<div class="p-times">/, 'the timetable, by that name: it holds every kind');
  assert.match(timesOf(html), /<span class="tt-days">Sun<\/span>\s*<span class="t-time">10<span class="t-mer">am<\/span><\/span>[\s\S]*<span class="tt-title">Sunday Divine Liturgy/);
  assert.match(comingUp(html), /<h3 class="dh sun"><span>Sunday 4 Oct<\/span><\/h3><a class="erow" href="\/\d+:2026-10-04">/,
    'the next fortnight, day by day, each date its own link');
});

test('the card says where its details and its times came from, and how long ago (public/shared/source-line.js)', async () => {
  const { raw, get } = fresh();
  raw.prepare(`UPDATE parishes SET info_source_name = 'Antiochian Archdiocese', info_source_ref = 'https://antiochian.org.au/sgr',
    info_checked_at = '2026-08-30' WHERE id = ?`).run(PARISH);
  raw.prepare(`UPDATE schedules SET source_name = 'Admin', source_ref = NULL, source_checked_at = '2026-09-28T05:00:00Z' WHERE parish_id = ?`).run(PARISH);
  const { html } = await get('/sgr');
  assert.match(timesOf(html), /<div class="src-line">Updated yesterday &middot; Admin<\/div>/, 'under the timetable, and no link for a person');
  assert.match(between(card(html), '<div class="p-details">'), /<div class="src-line">Updated 1 month ago &middot; <a href="https:\/\/antiochian\.org\.au\/sgr" target="_blank" rel="noopener nofollow">Antiochian Archdiocese/);
});

test('a rule’s languages sit on its line; a timetable is the morning, then the evening under the moon', async () => {
  const { raw, get } = fresh();
  raw.prepare(VESPERS).run(PARISH);
  raw.prepare(`UPDATE schedules SET languages = '["Arabic","English"]' WHERE parish_id = ? AND title != 'Vespers'`).run(PARISH);
  const times = timesOf((await get('/sgr')).html);
  assert.match(times, /Sunday Divine Liturgy<span class="tt-lang">Arabic, English<\/span>/);
  assert.match(comingUp((await get('/sgr')).html), /<span class="etitle">Sunday Divine Liturgy<\/span><\/span>\s*<span class="esub"><span class="elang">Arabic, English<\/span><\/span>/,
    'and on its dates');
  assert.ok(times.indexOf('Divine Liturgy') < times.indexOf('<div class="eve">'), 'the morning first');
  assert.ok(times.indexOf('<div class="eve">') < times.indexOf('Vespers'), 'then the evening');
});

test('the timetable drops an ended rule and marks one that starts later or ends', async () => {
  const { raw, get } = fresh();
  rule(raw, PARISH, 3, '07:00', 'Old Matins', { effective_to: '2026-09-01' });
  rule(raw, PARISH, 3, '18:00', 'Presanctified Liturgy', { effective_from: '2026-11-04' });
  rule(raw, PARISH, 4, '18:00', 'Paraklesis', { effective_to: '2026-10-15' });
  const { html } = await get('/sgr');
  const times = timesOf(html);
  assert.doesNotMatch(times, /Old Matins/);
  assert.match(times, /Presanctified Liturgy<span class="tt-range">from 4 Nov<\/span>/);
  assert.match(times, /Paraklesis<span class="tt-range">until 15 Oct<\/span>/);
  assert.doesNotMatch(meta(html, 'name', 'description'), /Presanctified/, 'a rule that has not started is not what the times are');
});

test('several days of one service are one line', async () => {
  const { raw, get } = fresh();
  for (const d of [1, 2, 3, 4, 5]) rule(raw, PARISH, d, '18:00', 'Vespers');
  assert.match(timesOf((await get('/sgr')).html), /<span class="tt-days">Mon–Fri<\/span>\s*<span class="t-time">6<span class="t-mer">pm/);
});

test('a relative date settles on its day, starts the card there, and stays out of the index', async () => {
  const { get } = fresh();
  const { html } = await get('/sgr/next-sun');
  assert.equal(canonical(html), 'https://orthodoxy.au/sgr/2026-10-04');
  assert.equal(robots(html), 'noindex,follow');
  assert.match(title(html), /^Sunday Divine Liturgy — Sunday 4 October, 10am/);
  const cu = comingUp(html);
  assert.match(cu, /^<section class="cu-band"[^>]*>[\s\S]*?<h3 class="dh sun"><span>Sunday 4 Oct<\/span>/, 'from that day');
});

test('a service link previews its next occurrence', async () => {
  const { raw, get } = fresh();
  raw.prepare(VESPERS).run(PARISH);
  const { html } = await get('/sgr/vespers');
  assert.match(title(html), /^Vespers — Saturday 3 October, 6pm · St George Cathedral, Redfern/);
  assert.equal(robots(html), 'noindex,follow');
  const eve = (await get('/sgr/evening')).html;
  assert.equal(canonical(eve), 'https://orthodoxy.au/sgr/evening');
  assert.match(title(eve), /^Vespers — Saturday 3 October, 6pm/);
});

test('a kind or a language beside a parish previews the first that answers it, as the page opens it', async () => {
  const { raw, get } = fresh();
  rule(raw, PARISH, 2, '19:00', 'Bible Study', { event_type: 'talk' });
  raw.prepare(`UPDATE schedules SET languages = '["Arabic"]' WHERE parish_id = ? AND title = 'Sunday Divine Liturgy'`).run(PARISH);
  rule(raw, PARISH, 5, '18:00', 'Vespers', { languages: '["English"]' });
  const talks = (await get('/sgr/talks')).html;
  assert.match(title(talks), /^Bible Study — Tuesday 6 October, 7pm · St George Cathedral, Redfern/);
  assert.equal(robots(talks), 'noindex,follow');
  assert.match(card(talks), /^<section class="sheet parish open ssr"/, "the parish's card, which the event opens in front of");
  assert.match(title((await get('/sgr/en')).html), /^Vespers — Friday 2 October, 6pm/, 'its own English, not the parish’s');
});

test('a painted Today: no count, Later today only under Happening now, This evening, Tomorrow, and the evening divided off', async () => {
  const today = async (setup) => {
    const { raw, get } = fresh();
    raw.prepare('DELETE FROM schedules WHERE parish_id = ?').run(PARISH);
    setup(raw);
    return between(card((await get('/sgr')).html), '<section class="today card ptoday"', '<h2 class="sec">Timetable');
  };
  // Nothing till the evening: this evening, under its own title.
  let c = await today(raw => rule(raw, PARISH, 3, '18:00', 'Vespers'));
  assert.match(c, /<h2>This evening<\/h2><p>Wednesday 30 Sep<\/p>/);
  assert.doesNotMatch(c, /class="tsub"|class="eve"/);
  assert.match(c, /Vespers[\s\S]*<a class="see-all" href="#coming-up">Tomorrow/);
  // The day and the evening (from 2pm, as everywhere): Today, the evening under its divider.
  c = await today(raw => { rule(raw, PARISH, 3, '13:00', 'Paraklesis'); rule(raw, PARISH, 3, '18:00', 'Vespers'); });
  assert.match(c, /<h2>Today<\/h2>/);
  assert.doesNotMatch(c, /class="tsub"/, 'no Later today with nothing on now');
  assert.match(c, /Paraklesis[\s\S]*<div class="eve">[\s\S]*Vespers/);
  // On now: Happening now, uncounted, then Later today.
  c = await today(raw => { rule(raw, PARISH, 3, '11:00', 'Divine Liturgy'); rule(raw, PARISH, 3, '18:00', 'Vespers'); });
  assert.match(c, /<h2>Today<\/h2><p>Wednesday 30 Sep<\/p><\/div><\/header>\s*<div class="tsub">Happening now<\/div>[\s\S]*Divine Liturgy[\s\S]*<div class="tsub">Later today<\/div><div class="eve">[\s\S]*Vespers/);
  assert.doesNotMatch(c, /on now/);
  // The day done: tomorrow, by its title and date, going on to the week.
  c = await today(raw => rule(raw, PARISH, 4, '07:00', 'Matins'));
  assert.match(c, /<h2>Tomorrow<\/h2><p>Thursday 1 Oct<\/p><\/div><\/header>\s*<a class="erow"[\s\S]*Matins/);
  assert.doesNotMatch(c, /Nothing more today|class="tsub"/);
  assert.match(c, /<a class="see-all" href="#coming-up">This week/);
  // Nothing at all ahead: no Today, and no Next on the line above it.
  const { raw, get } = fresh();
  raw.prepare('DELETE FROM schedules WHERE parish_id = ?').run(PARISH);
  c = card((await get('/sgr')).html);
  assert.doesNotMatch(c, /class="today card|<small>Next/);
  assert.match(c, /<div class="summary"><div class="sum"><small>Languages<\/small>/);
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

test("a parish's /timetables link names what it narrows to, noindex, under its own canonical", async () => {
  const { raw, get } = fresh();
  raw.prepare(VESPERS).run(PARISH);
  const all = (await get('/sgr/timetables')).html;
  assert.equal(canonical(all), 'https://orthodoxy.au/sgr/timetables');
  assert.equal(robots(all), 'noindex,follow');
  const eve = (await get('/timetables/sgr/evening')).html;
  assert.equal(canonical(eve), 'https://orthodoxy.au/sgr/evening/timetables');
  assert.match(title(eve), /^Evening services at St George Cathedral, Redfern — service times/);
  assert.match(card(eve), /^<section class="sheet parish open ssr"/, "the parish's card");
});

test('an event link — projected or stored — is its card, never indexed', async () => {
  const { raw, get } = fresh();
  const sid = raw.prepare('SELECT id FROM schedules WHERE parish_id = ? LIMIT 1').get(PARISH).id;
  const proj = (await get(`/${sid}:2026-10-04`));
  assert.equal(proj.res.headers.get('x-agora-page'), 'event');
  assert.match(title(proj.html), /^Sunday Divine Liturgy — Sunday 4 October, 10am/);
  assert.equal(robots(proj.html), 'noindex,follow');
  assert.equal(canonical(proj.html), `https://orthodoxy.au/${sid}:2026-10-04`);
  assert.equal(meta(proj.html, 'property', 'og:type'), 'article');
  const c = card(proj.html);
  assert.match(c, /^<section class="sheet event open ssr"/);
  assert.match(c, /<h1>Sunday Divine Liturgy<\/h1>\s*<p class="ev-when">Sunday 4 Oct · 10am/);
  assert.match(c, /<a class="abtn" href="\/sgr">/, 'the way to its parish');

  const id = raw.prepare(`INSERT INTO events (parish_id, source_adapter, title, start_utc, end_utc,
      event_type, status, mutation_type, poster_path, description)
    VALUES (?, 'manual', 'Feast of St George', '2026-10-10T23:00:00Z', '2026-10-11T01:00:00Z',
      'feast', 'approved', 'headless', '/posters/x.jpg', 'Vespers, then a meal.') RETURNING id`).get(PARISH).id;
  const stored = (await get(`/${id}`)).html;
  assert.match(card(stored), /<a class="ev-poster" href="\/posters\/x\.jpg" target="_blank" rel="noopener" aria-label="The poster, full size"><img src="\/posters\/x\.jpg" alt=""><\/a>/,
    'the poster opens full size');
  assert.match(card(stored), /<h1>Feast of St George<\/h1>\s*<p class="ev-when">Sunday 11 Oct · 10am–12pm/);
  assert.match(card(stored), /<div class="ev-desc">Vespers, then a meal\.<\/div>/);
  assert.equal(meta(stored, 'property', 'og:image'), 'https://orthodoxy.au/posters/x.jpg', 'the poster previews');
  assert.equal(meta(stored, 'name', 'twitter:card'), 'summary_large_image');
});

test('a parish\'s stream and its Donate are buttons on its card, its own links smaller above its details, and a date\'s card has the stream unless it hides it', async () => {
  const { raw, get } = fresh();
  raw.prepare("UPDATE parishes SET live_url = 'https://youtube.com/@sgr', donation_url = 'https://give.example/sgr' WHERE id = ?").run(PARISH);
  raw.prepare("INSERT INTO parish_links (parish_id, slug, label, url) VALUES (?, 'fund', 'Building fund', 'https://give.example/fund')").run(PARISH);
  const c = card((await get('/sgr')).html);
  const acts = between(c, '<div class="actions">', '<div class="summary">');
  assert.match(acts, /<a class="abtn" href="https:\/\/youtube\.com\/@sgr" target="_blank" rel="noopener"><svg[^]*?<span>Watch live<\/span><\/a>/);
  assert.match(acts, /<a class="abtn" href="https:\/\/give\.example\/sgr" target="_blank" rel="noopener"><svg[^]*?<span>Donate<\/span><\/a>/);
  assert.ok(acts.indexOf('Watch live') < acts.indexOf('Donate'));
  assert.doesNotMatch(acts, /Building fund/, 'its own links are not among the big buttons');
  assert.match(between(c, '<div class="p-times">', '<div class="p-details">'),
    /<div class="p-links"><a class="lbtn" href="https:\/\/give\.example\/fund" target="_blank" rel="noopener"><svg[^]*?<span>Building fund<\/span><\/a><\/div>\s*$/,
    'but small, just above its details');

  const sid = raw.prepare('SELECT id FROM schedules WHERE parish_id = ? LIMIT 1').get(PARISH).id;
  assert.match(card((await get(`/${sid}:2026-10-04`)).html), /<span>Watch live<\/span>/);
  const id = raw.prepare(`INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type, status, mutation_type, hide_live)
    VALUES (?, 'manual', 'Parish picnic', '2026-10-10T23:00:00Z', 'social', 'approved', 'headless', 1) RETURNING id`).get(PARISH).id;
  assert.doesNotMatch(card((await get(`/${id}`)).html), /Watch live/, 'hide_live hides the stream');
});

test('a cancelled occurrence previews as cancelled, and its card says so', async () => {
  const { raw, get } = fresh();
  const sid = raw.prepare('SELECT id FROM schedules WHERE parish_id = ? LIMIT 1').get(PARISH).id;
  raw.prepare(`INSERT INTO schedule_overrides (schedule_id, occurrence_date, kind) VALUES (?, '2026-10-04', 'cancelled')`).run(sid);
  const { html } = await get(`/${sid}:2026-10-04`);
  assert.match(meta(html, 'name', 'description'), /^CANCELLED\./);
  assert.match(card(html), /<div class="ev-head off cancelled">\s*<span class="ckicker"><span class="ev-off">Cancelled<\/span>/);
  // And on its parish's Coming up, struck through rather than gone.
  assert.match(comingUp((await get('/sgr')).html), /<a class="erow tomb cancelled" href="\/\d+:2026-10-04">[\s\S]*?<span class="etomb">Cancelled<\/span>/);
});

test('an event and a rule held at another parish, or a place, say where', async () => {
  const { raw, get } = fresh();
  const venue = raw.prepare(`SELECT id, name, address FROM parishes
    WHERE id NOT IN (?, '_unassigned') AND address IS NOT NULL ORDER BY id LIMIT 1`).get(PARISH);
  const at = raw.prepare(`INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type, status,
      mutation_type, location_parish_id)
    VALUES (?, 'manual', 'Deanery Vespers', '2026-10-03T07:00:00Z', 'vespers', 'approved', 'headless', ?)
    RETURNING id`).get(PARISH, venue.id).id;
  const away = raw.prepare(`INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type, status,
      mutation_type, location_override, location_lat, location_lng)
    VALUES (?, 'manual', 'Youth retreat', '2026-10-04T00:00:00Z', 'youth', 'approved', 'headless',
      'Antiochian Village, Kangaroo Valley', -34.75, 150.53) RETURNING id`).get(PARISH).id;
  const atPage = await get(`/${at}`);
  assert.ok(card(atPage.html).includes(`<small>Where</small><span>${venue.name} — ${venue.address}</span>`.replace(/&/g, '&amp;')),
    "the parish it is at, by that parish's own address");
  assert.ok(meta(atPage.html, 'name', 'description').includes(venue.address), 'and its preview says that address, not the host\'s');
  assert.match(card(atPage.html), /<h2 class="sec">Parishes<\/h2>[\s\S]*<small>Hosting<\/small>[\s\S]*<small>Held here<\/small>/,
    'both parishes are named, each with its part');
  const place = card((await get(`/${away}`)).html);
  assert.match(place, /<small>Where<\/small><span>Antiochian Village, Kangaroo Valley<\/span>/);
  assert.match(place, /maps\/search\/\?api=1&amp;query=-34\.75,150\.53"[^>]*>.*<span>Google Maps<\/span>/, 'and Google Maps opens there, not directions to it');
});

test("an event's card names the parishes taking part in it", async () => {
  const { raw, get } = fresh();
  const others = raw.prepare(`SELECT id, name FROM parishes WHERE id NOT IN (?, '_unassigned') ORDER BY id LIMIT 2`).all(PARISH);
  const id = raw.prepare(`INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type, status, mutation_type)
    VALUES (?, 'manual', 'Festival', '2026-10-10T23:00:00Z', 'social', 'approved', 'headless') RETURNING id`).get(PARISH).id;
  for (const o of others) raw.prepare('INSERT INTO event_parishes (event_id, parish_id) VALUES (?, ?)').run(id, o.id);
  const c = card((await get(`/${id}`)).html);
  for (const o of others) assert.ok(c.includes(`<b>${o.name.replace(/&/g, '&amp;')}</b><small>Taking part</small>`), o.name);
  // A lone host needs no list.
  const alone = raw.prepare(`INSERT INTO events (parish_id, source_adapter, title, start_utc, event_type, status, mutation_type)
    VALUES (?, 'manual', 'Picnic', '2026-10-11T23:00:00Z', 'social', 'approved', 'headless') RETURNING id`).get(PARISH).id;
  assert.doesNotMatch(card((await get(`/${alone}`)).html), /Parishes<\/h2>/);
});

test('the home page is the site, indexable; anything else is the page with its words, noindex', async () => {
  const { get } = fresh();
  const home = await get('/');
  assert.equal(home.res.status, 200);
  assert.equal(title(home.html), 'Orthodox Services &amp; Events — orthodoxy.au');
  assert.equal(robots(home.html), 'index,follow');
  assert.equal(canonical(home.html), 'https://orthodoxy.au/');
  assert.equal(card(home.html), '');
  for (const p of ['/greek/next-sun', '/2026-10-25', '/donate', '/greek/donate', '/greek/social']) {
    const { res, html } = await get(p);
    assert.equal(res.status, 200, p);
    assert.equal(robots(html), 'noindex,follow', p);
    assert.equal(canonical(html), undefined, `${p}: no claim to be the home page`);
    assert.equal(title(html), 'Orthodox Services &amp; Events — orthodoxy.au', p);
  }
  assert.equal(await get('/sgr', { method: 'POST' }), null, 'only a GET or a HEAD');
  assert.equal(await get('/admin'), null, "a site path is not the page's");
  assert.equal(await get('/apple-touch-icon.png'), null, 'nor is a file');
});

test('a link to a parish, an event or a list that is not here is a 404, noindex', async () => {
  const { get } = fresh();
  for (const p of ['/nosuch', '/greek/nosuch', '/999999', '/999999:2026-10-04', '/nosuch+other']) {
    const { res, html } = await get(p);
    assert.equal(res.status, 404, p);
    assert.equal(robots(html), 'noindex,follow', p);
    assert.match(html, /<script src="\/next\/next\.js"><\/script>/, `${p}: still the page, to go on from`);
  }
});

test('?app, the old way into the app, is the same page', async () => {
  const { get } = fresh();
  const { res, html } = await get('/sgr?app');
  assert.equal(res.headers.get('x-agora-page'), 'parish');
  assert.equal(canonical(html), 'https://orthodoxy.au/sgr');
  const admin = await get('/sgr', { headers: { cookie: 'agora_admin=1' } });
  assert.equal(admin.res.headers.get('x-agora-page'), 'parish', 'and an admin gets it too: editing is on the page');
});

test('any failure is the page as deployed, which says nothing it cannot know', async () => {
  const broken = { DB: { prepare() { throw new Error('D1 is down'); } }, ASSETS: assets() };
  const res = await servePage(new Request('https://orthodoxy.au/sgr'), broken, {}, { now: NOW });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-agora-page'), 'failed-open');
  const html = await res.text();
  assert.equal(html, SHELL);
  assert.equal(robots(html), 'noindex,follow', 'the page as deployed is kept out of the index');
  assert.equal(canonical(html), undefined);
  const noPage = { DB: broken.DB, ASSETS: { fetch: async () => new Response('', { status: 404 }) } };
  assert.equal(await servePage(new Request('https://orthodoxy.au/sgr'), noPage, {}, { now: NOW }), null,
    'no page to wrap: the caller hands it to the asset layer');
});

test('a page without the marks is served as it is', async () => {
  const { env } = fresh();
  env.ASSETS = assets('<html><head><title>x</title></head><body></body></html>');
  const res = await servePage(new Request('https://orthodoxy.au/sgr'), env, {}, { now: NOW });
  assert.equal(await res.text(), '<html><head><title>x</title></head><body></body></html>');
});

test('the ETag is the finished page: a 304 for the same, a new one when the page is deployed again', async () => {
  const { env } = fresh();
  const first = await servePage(new Request('https://orthodoxy.au/sgr'), env, {}, { now: NOW });
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const again = await servePage(new Request('https://orthodoxy.au/sgr', { headers: { 'if-none-match': etag } }), env, {}, { now: NOW });
  assert.equal(again.status, 304);
  env.ASSETS = assets(SHELL.replace('</body>', '<!-- deployed again --></body>'));
  const redeployed = await servePage(new Request('https://orthodoxy.au/sgr', { headers: { 'if-none-match': etag } }), env, {}, { now: NOW });
  assert.equal(redeployed.status, 200);
  assert.notEqual(redeployed.headers.get('etag'), etag);
  assert.match(await redeployed.text(), /deployed again/);
});

test('HEAD gets the headers without the body', async () => {
  const { env } = fresh();
  const res = await servePage(new Request('https://orthodoxy.au/sgr', { method: 'HEAD' }), env, {}, { now: NOW });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '');
});

test('a name cannot break out of the page or its structured data', async () => {
  const { raw, get } = fresh();
  raw.prepare('UPDATE parishes SET full_name = ? WHERE id = ?').run('St George </script><b>x</b> "q"', PARISH);
  const { html } = await get('/sgr');
  assert.doesNotMatch(html, /<\/script><b>/);
  assert.match(html, /St George \\u003c\/script>\\u003cb>/, 'JSON-LD escapes <');
  assert.match(card(html), /<h1>St George &lt;\/script&gt;&lt;b&gt;x&lt;\/b&gt; &quot;q&quot;<\/h1>/);
});

test("the card wears the parish's colour: its jurisdiction's, as /admin set it", async () => {
  const { raw, get } = fresh();
  raw.prepare(`INSERT INTO jurisdiction_colors (jurisdiction, color) VALUES ('antiochian', '#123456')`).run();
  const c = card((await get('/sgr')).html);
  assert.match(c, /^<section class="sheet parish open ssr"[^>]*style="--j:#123456"/);
  assert.match(c, /<div class="tt" style="--pc:#123456">/);
});

// ── the sitemap ──────────────────────────────────────────────────────────

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
  const inMap = locs.filter(l => COLLECTION_PATHS.has(l.slice('https://orthodoxy.au'.length)));
  for (const p of ['/en', '/sun/liturgy', '/greek', '/antiochian']) {
    assert.ok(inMap.includes(`https://orthodoxy.au${p}`), `${p}: a collection with parishes in it`);
  }
  for (const p of ['/serbian', '/monasteries', '/talks', '/social']) {
    assert.ok(!inMap.includes(`https://orthodoxy.au${p}`), `${p}: nobody in the seed`);
  }
});

test('a monastery on file puts /monasteries in the sitemap, and a talk /talks', () => {
  const { raw } = fresh();
  const parishes = raw.prepare("SELECT * FROM parishes WHERE id != '_unassigned'").all();
  const rules = () => raw.prepare('SELECT * FROM schedules WHERE active = 1').all();
  const ids = (ps) => indexedCollections({ parishes: ps, rules: rules(), overrides: {}, logos: {} }, NOW, 'https://orthodoxy.au')
    .map(c => c.id);
  assert.ok(!ids(parishes).includes('monasteries'));
  const named = parishes.map(p => (p.id === PARISH ? { ...p, name: 'St George Monastery, Redfern' } : p));
  assert.ok(ids(named).includes('monasteries'));
  assert.ok(!ids(parishes).includes('talks'));
  rule(raw, PARISH, 2, '19:00', 'Bible Study');
  raw.prepare("UPDATE schedules SET event_type = 'talk' WHERE title = 'Bible Study'").run();
  assert.ok(ids(parishes).includes('talks'), 'v3 answers /talks as a collection like any other');
});

// ── a filter link: its timetable's heading, and a collection's card ──────

test('/timetables is every parish and its times, under its own heading, noindex, with no card', async () => {
  const { get } = fresh();
  const { res, html } = await get('/timetables');
  assert.equal(res.headers.get('x-agora-page'), 'timetable');
  assert.equal(canonical(html), 'https://orthodoxy.au/timetables');
  assert.equal(robots(html), 'noindex,follow');
  assert.equal(title(html), 'Orthodox parishes and times | orthodoxy.au');
  assert.equal(card(html), '', 'not a collection: the page itself, filtered');
});

test("a jurisdiction and a region narrow the parishes; the canonical is the app's order", async () => {
  const { raw, get } = fresh();
  rule(raw, GREEK_QLD, 0, '09:00', 'Divine Liturgy');
  const { html } = await get('/QLD/timetables/greek');
  assert.equal(canonical(html), 'https://orthodoxy.au/greek/qld', '/timetables is what the page is, not part of its name');
  assert.equal(title(html), 'Greek Orthodox parishes and times in Queensland | orthodoxy.au');
  assert.match(meta(html, 'name', 'description'), /^1 parish: Sunshine Coast, Buderim\.$/);
  assert.deepEqual(listed(raw, '/greek/qld'), ['Sunshine Coast, Buderim']);
  assert.equal(meta((await get('/antiochian/qld')).html, 'name', 'description'), 'Nothing on file for this yet.');
});

test('several jurisdictions or days are one link, said together, in the app\'s order', async () => {
  const { raw, get } = fresh();
  rule(raw, GREEK_QLD, 0, '09:00', 'Divine Liturgy');
  rule(raw, PARISH, 5, '18:00', 'Vespers');
  const { html } = await get('/greek/antiochian');
  assert.equal(canonical(html), 'https://orthodoxy.au/antiochian+greek');
  assert.equal(title(html), 'Antiochian and Greek Orthodox parishes and times | orthodoxy.au');
  const both = listed(raw, '/greek+antiochian');
  assert.ok(both.includes('Sunshine Coast, Buderim') && both.includes('St George Cathedral, Redfern'));
  assert.ok(!both.some(n => /serbian/i.test(n)));
  const days = (await get('/fri/sun')).html;
  assert.equal(canonical(days), 'https://orthodoxy.au/sun+fri');
  assert.equal(title(days), 'Orthodox services on Sundays and Fridays | orthodoxy.au');
  assert.ok(listed(raw, '/sun+fri').includes('St George Cathedral, Redfern'), 'its Friday Vespers');
  assert.ok(!listed(raw, '/mon+tue').includes('St George Cathedral, Redfern'));
});

test('a service, a day and a part of the day narrow the rules', async () => {
  const { raw, get } = fresh();
  rule(raw, PARISH, 6, '18:00', 'Vespers');
  assert.equal(title((await get('/evening')).html), 'Orthodox evening services | orthodoxy.au');
  assert.ok(listed(raw, '/evening').includes('St George Cathedral, Redfern'));
  assert.ok(listed(raw, '/sat/evening').includes('St George Cathedral, Redfern'), 'its Saturday Vespers');
  assert.ok(!listed(raw, '/sun/evening').includes('St George Cathedral, Redfern'), 'a 10am Liturgy is not an evening service');
  assert.equal(title((await get('/sun/liturgy')).html), 'Orthodox Liturgies on Sundays | orthodoxy.au');
  assert.ok(!listed(raw, '/sat/liturgy').length, 'a Saturday evening Vespers is not a Saturday Liturgy');
  assert.equal(title((await get('/services')).html), 'Orthodox service times | orthodoxy.au');
  assert.equal(title((await get('/greek/services/en')).html), 'Greek Orthodox service times in English | orthodoxy.au');
  assert.equal(title((await get('/prayer')).html), 'Orthodox prayer services | orthodoxy.au');
});

test('a language narrows to the rules served in it, falling back to the parish', async () => {
  const { raw, get } = fresh();
  raw.prepare(`UPDATE schedules SET languages = '["English"]' WHERE parish_id = ?`).run(PARISH);
  raw.prepare(`UPDATE parishes SET languages = '["Arabic","English"]' WHERE id = 'antiochian-stelias-wollongong'`).run();
  const full = listed(raw, '/en-only');
  assert.ok(full.includes('St George Cathedral, Redfern'));
  assert.ok(!full.includes('St Elias, Wollongong'), 'Arabic and English is not English only');
  assert.equal(title((await get('/en-only')).html), 'Orthodox fully-English services | orthodoxy.au');
  for (const p of ['/en', '/english', '/bilingual', '/half-english', '/english-half', '/some-english']) {
    const names = listed(raw, p);
    assert.ok(names.includes('St Elias, Wollongong'), p);
    assert.ok(names.includes('St George Cathedral, Redfern'), p);
    const { html } = await get(p);
    assert.equal(title(html), 'Orthodox services in English | orthodoxy.au', p);
    assert.equal(canonical(html), 'https://orthodoxy.au/en', p);
  }
  for (const p of ['/english-only', '/full-english']) {
    assert.equal(canonical((await get(p)).html), 'https://orthodoxy.au/en-only', p);
  }
  const lit = (await get('/sun/liturgy/full-english')).html;
  assert.equal(title(lit), 'Orthodox fully-English Liturgies on Sundays | orthodoxy.au');
  assert.equal(canonical(lit), 'https://orthodoxy.au/sun/liturgy/en-only');
});

test('several parishes by name are their maker\'s list: named in the title, noindex, no card', async () => {
  const { raw, get } = fresh();
  raw.prepare("UPDATE parishes SET acronym = 'SMG' WHERE id = 'antiochian-stmichaelgabriel-ryde'").run();
  rule(raw, PARISH, 2, '19:00', 'Choir practice', { parish_scoped: 1 });
  const { html } = await get('/smg+sgr');
  assert.equal(canonical(html), 'https://orthodoxy.au/smg+sgr');
  assert.equal(robots(html), 'noindex,follow');
  assert.equal(title(html), 'Orthodox parishes and times at Sts Michael &amp; Gabriel, Ryde and St George Cathedral, Redfern | orthodoxy.au');
  assert.equal(card(html), '');
  assert.match(timesOf((await get('/sgr')).html), /Choir practice/, 'a parish_scoped rule is on its own card');
});

test('a collection is indexed, under its own name, with its own preview and its card', async () => {
  const { raw, get } = fresh();
  const en = (await get('/en')).html;
  assert.equal(robots(en), 'index,follow');
  assert.equal(canonical(en), 'https://orthodoxy.au/en');
  assert.match(meta(en, 'name', 'description'), /^Parishes with services in English\. \d+ parish/, 'what it holds, then who');
  assert.equal(meta(en, 'property', 'og:image'), 'https://orthodoxy.au/og/c-english.jpg');
  const c = card(en);
  assert.match(c, /^<section class="sheet collection open ssr" role="dialog" aria-label="English services">/);
  assert.match(c, /<div class="chero soft" style="--c:#1d4ed8">\s*<span class="ckicker">Language<\/span>\s*<h1>English services<\/h1>/,
    "in the collection's own look (collections.js)");
  assert.match(c, /<a class="citem-head" href="\/sgr">[\s\S]*?<b>St George Cathedral, Redfern<\/b>/, 'each parish a link to its card');
  assert.match(c, /<div class="tt compact"/, 'with its times');
  assert.match(c, /<section class="ctimes folded">[\s\S]*<label class="ctimes-open"><input type="checkbox" hidden><span>Show timetables<\/span>/,
    'folded to the first few lines until Show timetables, which opens with no script');

  const sun = (await get('/liturgy/sunday')).html;
  assert.equal(canonical(sun), 'https://orthodoxy.au/sun/liturgy', 'however the link spells it');
  raw.prepare(VESPERS).run(PARISH);
  const times = (h) => between(card(h), '<a class="citem-head" href="/sgr">', '</article>');
  const sunTimes = times((await get('/sun/liturgy')).html);
  assert.match(sunTimes, /Sunday Divine Liturgy/);
  assert.doesNotMatch(sunTimes, /Vespers/, "a collection's timetables are the lines that answer it");
  assert.match(times((await get('/antiochian')).html), /Sunday Divine Liturgy[\s\S]*Vespers/, 'and a jurisdiction asks nothing of them');
  assert.equal(robots(sun), 'index,follow');
  assert.equal(meta(sun, 'property', 'og:image'), 'https://orthodoxy.au/og/c-sunday.jpg');

  const greek = (await get('/greek')).html;
  assert.equal(robots(greek), 'index,follow');
  assert.equal(meta(greek, 'property', 'og:image'), 'https://orthodoxy.au/og/greek.jpg', "the jurisdiction's card, with no logo");
  assert.match(card(greek), /<div class="chero" style="background:radial-gradient\(/, "a jurisdiction's look is its colour");
});

test('every other link stays noindex: a hand-picked list, a mix of filters, an empty collection', async () => {
  const { raw, get } = fresh();
  rule(raw, GREEK_QLD, 0, '09:00', 'Divine Liturgy');
  for (const p of ['/smg+sgr', '/greek/qld', '/greek/en', '/sun', '/timetables', '/serbian', '/in-macedonian']) {
    const { html } = await get(p);
    assert.equal(robots(html), 'noindex,follow', p);
  }
  assert.equal(card((await get('/serbian')).html), '', 'an empty collection has no card to paint');
  assert.equal(meta((await get('/greek/qld')).html, 'property', 'og:image'), 'https://orthodoxy.au/og/greek.jpg');
});

test("a jurisdiction's logo is its collection's preview once /admin has one", async () => {
  const { raw, get } = fresh();
  raw.prepare("INSERT INTO jurisdiction_logos (jurisdiction, logo_path) VALUES ('greek', '/logos/jurisdiction-greek.png?v=1')").run();
  // A row that is not one of ours is not served.
  raw.prepare("INSERT INTO jurisdiction_logos (jurisdiction, logo_path) VALUES ('antiochian', 'javascript:alert(1)')").run();
  const img = (html) => meta(html, 'property', 'og:image');
  const greek = (await get('/greek')).html;
  assert.equal(img(greek), 'https://orthodoxy.au/logos/jurisdiction-greek.png?v=1');
  assert.equal(meta(greek, 'name', 'twitter:card'), 'summary', 'a logo is square');
  assert.equal(img((await get('/antiochian')).html), 'https://orthodoxy.au/og/antiochian.jpg');
  assert.equal(img((await get('/greek/qld')).html), 'https://orthodoxy.au/og/greek.jpg', 'not a collection, so its card');
  raw.prepare("UPDATE jurisdiction_logos SET logo_path = '/logos/jurisdiction-greek.svg?v=3' WHERE jurisdiction = 'greek'").run();
  assert.equal(img((await get('/greek')).html), 'https://orthodoxy.au/og/greek.jpg', 'an SVG, which no chat app draws, is not the preview');
  raw.exec('DROP TABLE jurisdiction_logos');
  assert.equal(img((await get('/greek')).html), 'https://orthodoxy.au/og/greek.jpg', 'before migration 027, the card');
});

test('/monasteries is the monasteries, convents and sketes, by name', async () => {
  const { raw, get } = fresh();
  raw.prepare("UPDATE parishes SET name = 'Holy Monastery of St George, Redfern' WHERE id = ?").run(PARISH);
  raw.prepare("UPDATE parishes SET full_name = 'Pantanassa Skete' WHERE id = ?").run(GREEK_QLD);
  rule(raw, GREEK_QLD, 0, '09:00', 'Divine Liturgy');
  const { html } = await get('/monasteries');
  assert.equal(title(html), 'Orthodox monasteries and service times | orthodoxy.au');
  assert.deepEqual(listed(raw, '/monasteries').sort(), ['Holy Monastery of St George, Redfern', 'Sunshine Coast, Buderim']);
  assert.equal(canonical(html), 'https://orthodoxy.au/monasteries');
  assert.equal(robots(html), 'index,follow');
  assert.equal(title((await get('/greek/monasteries')).html), 'Greek Orthodox monasteries and service times | orthodoxy.au');
  assert.equal(canonical((await get('/monastery/greek')).html), 'https://orthodoxy.au/greek/monasteries');
  assert.equal(title((await get('/monasteries/sun/liturgy')).html), 'Orthodox Liturgies at monasteries on Sundays | orthodoxy.au');
});

// ── the lite model's helpers the head still reads ────────────────────────

test('a multi-day event says its span; a vigil past midnight does not', async () => {
  const { raw, get } = fresh();
  const add = (t, start, end) => raw.prepare(`INSERT INTO events (parish_id, source_adapter, title, start_utc, end_utc, event_type, status, mutation_type)
    VALUES (?, 'manual', ?, ?, ?, 'social', 'approved', 'headless') RETURNING id`).get(PARISH, t, start, end).id;
  const camp = add('Youth camp', '2026-11-13T07:00:00Z', '2026-11-15T05:00:00Z');
  assert.match(card((await get(`/${camp}`)).html), /<p class="ev-when">Fri 13 Nov 6pm – Sun 15 Nov 4pm<\/p>/);
  const vigil = add('Vigil', '2026-11-14T12:00:00Z', '2026-11-14T16:00:00Z');
  assert.match(card((await get(`/${vigil}`)).html), /<p class="ev-when">Saturday 14 Nov · 11pm–3am<\/p>/);
});

test('a timetable reads from today round the week', async () => {
  const { weekFrom } = await import('../lib/lite-page.mjs');
  const rules = [[0, '09:00'], [3, '18:00'], [6, '17:00'], [3, '07:00'], [1, '10:00']]
    .map(([day_of_week, start_time]) => ({ day_of_week, start_time }));
  assert.deepEqual([...rules].sort(weekFrom('2026-10-14')).map(r => `${r.day_of_week} ${r.start_time}`),
    ['3 07:00', '3 18:00', '6 17:00', '0 09:00', '1 10:00'], 'Wednesday first, then the week as it comes');
});
