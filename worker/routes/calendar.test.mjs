// Every link's calendar twin (.ics), through the real route and a real
// database (the seed): what a phone subscribed to St George's gets, what a
// timetable line's calendar holds, one date's file, and the links that are
// no calendar.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { serveCalendar, calendarPath, dateFileName, feedWindow, BACK_DAYS, AHEAD_DAYS } from './calendar.mjs';

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

const SGR = 'antiochian-stgeorge-redfern';
const SMG = 'antiochian-stmichaelgabriel-ryde';
// Wednesday 30 September 2026, midday in Sydney.
const NOW = Date.parse('2026-09-30T02:00:00Z');

function fresh() {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'agora-ics-')), 'x.db');
  const raw = new Database(file);
  raw.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  raw.exec(fs.readFileSync('d1/seed-parishes.sql', 'utf8'));
  raw.prepare("UPDATE parishes SET acronym = 'SGR' WHERE id = ?").run(SGR);
  raw.prepare("UPDATE parishes SET acronym = 'SMG' WHERE id = ?").run(SMG);
  const env = { DB: new D1(raw) };
  const get = async (p) => {
    const res = await serveCalendar(new Request(`https://orthodoxy.au${p}`), env, {}, { now: NOW });
    return res ? { res, text: await res.clone().text() } : null;
  };
  return { raw, env, get };
}

const unfold = (text) => text.replace(/\r\n /g, '').split('\r\n');
/** Each VEVENT as { UID, SUMMARY, DTSTART, … }. */
function eventsOf(text) {
  const out = [];
  let cur = null;
  for (const line of unfold(text)) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') { out.push(cur); cur = null; }
    else if (cur) { const i = line.indexOf(':'); cur[line.slice(0, i)] = line.slice(i + 1); }
  }
  return out;
}
const ruleId = (raw, parish, title) => raw.prepare('SELECT id FROM schedules WHERE parish_id = ? AND title = ?').get(parish, title).id;

test('only a link ending in .ics is a calendar', () => {
  assert.equal(calendarPath('/sgr.ics'), '/sgr');
  assert.equal(calendarPath('/sgr/sun/liturgy.ICS'), '/sgr/sun/liturgy');
  assert.equal(calendarPath('/20:2026-11-22.ics'), '/20:2026-11-22');
  assert.equal(calendarPath('/sgr'), null);
  assert.equal(calendarPath('/icon.png'), null);
  assert.equal(dateFileName('20:2026-11-22'), 'orthodoxy-20-2026-11-22.ics');
});

test('the window: a fortnight back, a season ahead', () => {
  const w = feedWindow(NOW);
  assert.equal(new Date(w.from).toISOString().slice(0, 10), '2026-09-16');
  assert.equal(w.days, BACK_DAYS + AHEAD_DAYS);
});

test('a parish’s calendar: every Sunday Liturgy written out, each by its own id, under the parish’s name', async () => {
  const { raw, get } = fresh();
  const { res, text } = await get('/sgr.ics');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/calendar/);
  assert.ok(res.headers.get('etag'));
  assert.ok(unfold(text).includes('X-WR-CALNAME:St George Cathedral\\, Redfern'));
  const id = ruleId(raw, SGR, 'Sunday Divine Liturgy');
  const evs = eventsOf(text);
  // 20 Sep (a fortnight back) to the end of December: fifteen Sundays.
  assert.equal(evs.length, 15);
  assert.equal(evs[0].UID, `${id}:2026-09-20@orthodoxy.au`);
  // 10am in Sydney on 4 October, the day daylight saving starts: 11pm UTC the day before.
  assert.equal(evs.find(e => e.UID === `${id}:2026-10-04@orthodoxy.au`).DTSTART, '20261003T230000Z');
  assert.equal(evs.find(e => e.UID === `${id}:2026-09-27@orthodoxy.au`).DTSTART, '20260927T000000Z');
  assert.ok(evs.every(e => e.SUMMARY === 'Sunday Divine Liturgy'));
  assert.ok(evs.every(e => /^St George Cathedral\\, Redfern\\, Cnr Walker/.test(e.LOCATION)));
  assert.ok(!text.includes('RRULE'));
  assert.equal(new Set(evs.map(e => e.UID)).size, evs.length, 'no date twice');
});

test('a cancelled date stays and says so; a hidden one is not there', async () => {
  const { raw, get } = fresh();
  const id = ruleId(raw, SGR, 'Sunday Divine Liturgy');
  raw.prepare("INSERT INTO schedule_overrides (schedule_id, occurrence_date, kind) VALUES (?, '2026-10-11', 'cancelled')").run(id);
  raw.prepare("INSERT INTO schedule_overrides (schedule_id, occurrence_date, kind) VALUES (?, '2026-10-18', 'hidden')").run(id);
  raw.prepare("INSERT INTO schedule_overrides (schedule_id, occurrence_date, kind, patch_start_time, patch_feast) VALUES (?, '2026-10-25', 'modified', '09:00', 'St James')").run(id);
  const evs = eventsOf((await get('/sgr.ics')).text);
  const on = (d) => evs.find(e => e.UID === `${id}:${d}@orthodoxy.au`);
  assert.equal(on('2026-10-11').SUMMARY, 'Cancelled: Sunday Divine Liturgy');
  assert.equal(on('2026-10-11').TRANSP, 'TRANSPARENT');
  assert.equal(on('2026-10-18'), undefined);
  assert.equal(on('2026-10-25').SUMMARY, 'Sunday Divine Liturgy — St James');
  assert.equal(on('2026-10-25').DTSTART, '20261024T220000Z', 'moved to 9am, the same entry');
});

test('a parish’s one-offs are in it, Parish only ones too; another parish’s are not', async () => {
  const { raw, get } = fresh();
  const ev = (parish, title, start, extra = {}) => {
    const cols = ['parish_id', 'source_adapter', 'title', 'start_utc', 'end_utc', 'event_type', 'status', 'mutation_type', ...Object.keys(extra)];
    return raw.prepare(`INSERT INTO events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(parish, 'manual', title, start, null, 'social', 'approved', 'headless', ...Object.values(extra)).lastInsertRowid;
  };
  const fair = ev(SGR, 'Christmas Fair', '2026-12-05T23:00:00Z', { description: 'Stalls, food, carols' });
  ev(SGR, 'Choir dinner', '2026-10-09T08:00:00Z', { parish_scoped: 1 });
  ev(SMG, 'Youth night', '2026-10-09T08:00:00Z');
  const evs = eventsOf((await get('/sgr.ics')).text);
  const f = evs.find(e => e.UID === `${fair}@orthodoxy.au`);
  assert.equal(f.SUMMARY, 'Christmas Fair');
  assert.match(f.DESCRIPTION, /^Stalls\\, food\\, carols\\n\\nhttps:\/\/orthodoxy\.au\/\d+$/);
  assert.equal(f.DTEND, '20261206T003000Z', 'no end on file: 90 minutes');
  assert.ok(evs.some(e => e.SUMMARY === 'Choir dinner'), 'its own Parish only event');
  assert.ok(!evs.some(e => e.SUMMARY === 'Youth night'));
});

test('a timetable line’s calendar holds that line only, named for it', async () => {
  const { raw, get } = fresh();
  raw.prepare("INSERT INTO schedules (parish_id, day_of_week, start_time, title, event_type) VALUES (?, 6, '18:00', 'Vespers', 'prayer')").run(SGR);
  const all = eventsOf((await get('/sgr.ics')).text);
  assert.ok(all.some(e => e.SUMMARY === 'Vespers') && all.some(e => e.SUMMARY === 'Sunday Divine Liturgy'));
  const { text } = await get('/sgr/sat/vespers.ics');
  const evs = eventsOf(text);
  assert.ok(evs.length > 10);
  assert.ok(evs.every(e => e.SUMMARY === 'Vespers'));
  assert.match(unfold(text).find(l => l.startsWith('X-WR-CALNAME:')), /Vespers.*St George Cathedral/);
});

test('a list of parishes is all of theirs, named by their initials', async () => {
  const { get } = fresh();
  const { text } = await get('/sgr+smg.ics');
  const evs = eventsOf(text);
  assert.ok(evs.some(e => /^St George/.test(e.LOCATION)));
  assert.ok(evs.some(e => /^St Michael|^Sts\.? Michael/.test(e.LOCATION)));
  assert.ok(evs.some(e => e.SUMMARY === 'Saturday Vespers'), 'Ryde’s Saturday Vespers');
  assert.ok(unfold(text).includes('X-WR-CALNAME:SGR and SMG'));
});

test('one date is a file to open, not a subscription', async () => {
  const { raw, get } = fresh();
  const id = ruleId(raw, SGR, 'Sunday Divine Liturgy');
  const { res, text } = await get(`/${id}:2026-10-04.ics`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-disposition'), `inline; filename="orthodoxy-${id}-2026-10-04.ics"`);
  const evs = eventsOf(text);
  assert.equal(evs.length, 1);
  assert.equal(evs[0].UID, `${id}:2026-10-04@orthodoxy.au`);
  assert.ok(!text.includes('REFRESH-INTERVAL'));
  assert.equal((await get(`/${id}:2026-10-05.ics`)).res.status, 404, 'not a Sunday: no such date');
});

test('a link naming no parish here, or none at all, is no calendar', async () => {
  const { get } = fresh();
  assert.equal((await get('/nowhere.ics')).res.status, 404);
  assert.equal((await get('/sun/liturgy.ics')).res.status, 404, 'every parish in Oceania is not a calendar');
  assert.equal((await get('/sgr')), null, 'not a calendar’s address: the page goes on');
});
