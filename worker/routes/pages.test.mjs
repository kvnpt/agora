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

test('which paths are lite pages', () => {
  const kinds = {
    '/sgr': 'parish', '/SGR/next-tue': 'parish', '/sgr/wed/liturgy': 'parish',
    '/102': 'event', '/42:2026-10-04': 'event',
    '/': null, '/greek': null, '/qld': null, '/services': null, '/liturgy': null,
    '/smg+sgr': null, '/sgr/en': null, '/sgr/donate': null, '/admin': null, '/api/bundle': null,
    // The card does not narrow by part of the day, so the app answers.
    '/evening': null, '/sgr/evening': null, '/sgr/sun/morning/liturgy': null,
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
  assert.match(html, /href="\/sgr\?app"/, 'the way into the app with this card open');
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
  raw.prepare(`INSERT INTO schedules (parish_id, day_of_week, start_time, title, event_type)
               VALUES (?, 6, '18:00', 'Vespers', 'prayer')`).run(PARISH);
  const { html } = await get('/sgr/vespers');
  // The next one is pinned, so a chat preview says WHEN, not just what.
  assert.match(html, /<title>Vespers — Saturday 3 October, 6pm · St George Cathedral, Redfern/);
  assert.match(html, /<h2 id="ll-h">Vespers<\/h2>/, 'the list is headed by the service');
  const list = html.slice(html.indexOf('class="lc-list"'), html.indexOf('class="lc-times"'));
  assert.doesNotMatch(list, /Divine Liturgy/, 'the list is narrowed to the service');
  assert.match(list, /Vespers/);
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
  for (const p of ['/', '/greek', '/nosuch', '/sgr?app', '/999999']) {
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
