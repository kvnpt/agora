// Every link's calendar twin: the link with `.ics` on the end.
//
//   /sgr.ics                 everything at St George's, for a phone to subscribe to
//   /sgr/sun/liturgy.ics     one timetable line (a date card's "Every Sunday")
//   /sgr+smg+spp.ics         a list of parishes (Favourites)
//   /20:2026-11-22.ics       one date, a file to open ("This date")
//   /saved/<token>.ics       a person's own: what they Save, one subscription
//                            that follows them (lib/calendar-links.mjs)
//   /saved/<token>/fav.ics   their Favourites, and /saved/<token>/<list>.ics
//                            a list of theirs: its parishes as the list has
//                            them when it is fetched, so it follows the list
//
// The link is read with the page's own grammar (public/shared/url-state.js,
// through pageOf) and its dates come out of the page's own lens
// (collectionFeed: expandFrom + buildFeed and the link's filters), so a
// calendar and the card its link opens cannot disagree. lib/ics.mjs writes
// them down, one date at a time.
//
// A feed names its parishes. A link that names none (/sun/liturgy, /greek)
// is every parish in Oceania, which no calendar wants and no request should
// project, so it is not one (yet): 404.
//
// Kept at the edge under the data version, as a page is, and keyed by the
// day as well, since the window moves with it. Calendar apps ask every few
// hours; nearly every ask is answered from there.

import { pageOf, findEvent } from './pages.mjs';
import { fetchWindowRows } from '../lib/expand.mjs';
import { collectionFeed } from '../lib/lite-page.mjs';
import { crossRows, hostedDates } from '../lib/taking-part.mjs';
import { cachedHtml } from '../lib/data-version.mjs';
import { calendarText } from '../lib/ics.mjs';
import { identityOf } from '../lib/calendar-links.mjs';
import { readSaved } from '../lib/saved-items.mjs';
import { parseInstanceId } from '../../public/shared/project.mjs';
import { localDateOf } from '../../public/shared/tz.mjs';
import linkWords from '../../public/shared/link-words.js';

const DAY_MS = 86400000;
const ZONE = 'Australia/Sydney';
/** How far back a feed keeps what has happened: a fortnight, so last Sunday is still there to look at. */
export const BACK_DAYS = 14;
/** How far ahead: a season, about what a parish has decided. */
export const AHEAD_DAYS = 92;
/** The most parishes one feed names; a longer list is a link nobody made by hand. */
export const MAX_PARISHES = 40;

const TYPE = 'text/calendar; charset=utf-8';
const PARISH_COLS = 'id, name, full_name, acronym, address, lat, lng, timezone';

/** '/sgr/sun/liturgy.ics' → '/sgr/sun/liturgy'; null when it is not a calendar's address. */
export function calendarPath(pathname) {
  const m = /^(.*?)\.ics$/i.exec(pathname || '');
  if (!m) return null;
  let path;
  try { path = decodeURIComponent(m[1]); } catch { return null; }
  return path.startsWith('/') ? path : `/${path}`;
}

/** The parishes a link names, by acronym or id, in one read. */
async function findParishes(db, slugs) {
  const norm = [...new Set(slugs.map(s => String(s).toLowerCase().replace(/\s+/g, '')))];
  if (!norm.length) return [];
  const qs = norm.map(() => '?').join(', ');
  const r = await db.prepare(
    `SELECT ${PARISH_COLS} FROM parishes WHERE id != '_unassigned'
       AND (lower(replace(acronym, ' ', '')) IN (${qs}) OR lower(id) IN (${qs}))`
  ).bind(...norm, ...norm).all();
  const rows = r.results || [];
  // In the link's order, each once.
  const out = [];
  for (const s of norm) {
    const p = rows.find(x => String(x.acronym || '').toLowerCase().replace(/\s+/g, '') === s)
      || rows.find(x => String(x.id).toLowerCase() === s);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** The parishes an event's place names, beyond those already in hand. */
async function parishesFor(db, events, have) {
  const want = [...new Set(events.flatMap(e => [e.parish_id, e.location_parish_id]).filter(id => id && !have.has(id)))];
  if (!want.length) return have;
  const r = await db.prepare(`SELECT ${PARISH_COLS} FROM parishes WHERE id IN (${want.map(() => '?').join(', ')})`)
    .bind(...want).all();
  for (const p of r.results || []) have.set(p.id, p);
  return have;
}

/** What the calendar is called on the phone: the parish, or what the link asks of whom. */
export function calendarName(route, named) {
  const asks = linkWords.asksAnything(route) || route.service || route.day || route.part;
  if (named.length === 1 && !asks) return named[0].name;
  if (named.length === 1) return linkWords.shortHeadingOf(route, [{ name: named[0].name }]);
  return linkWords.shortHeadingOf(route, named);
}

/** The window a feed covers, from local midnight a fortnight back. */
export function feedWindow(now) {
  const start = Date.parse(`${localDateOf(ZONE, now)}T00:00:00Z`) - BACK_DAYS * DAY_MS;
  return {
    from: start,                                   // the `now` collectionFeed counts its days from
    fromUtc: new Date(start - DAY_MS).toISOString(),
    toUtc: new Date(start + (BACK_DAYS + AHEAD_DAYS + 1) * DAY_MS).toISOString(),
    days: BACK_DAYS + AHEAD_DAYS,
  };
}

/** A feed's text, or null when the link names no parish here. `name` overrides what the phone calls it. */
async function feedText(env, origin, route, now, name = null) {
  const slugs = route.parishSlugs || [];
  if (!slugs.length || slugs.length > MAX_PARISHES) return null;
  const named = await findParishes(env.DB, slugs);
  if (!named.length) return null;
  const ids = named.map(p => p.id);
  const w = feedWindow(now);
  const [rows, events, cross] = await Promise.all([
    // One parish's rules alone; several, every rule in the window narrowed
    // here, so the projection only ever runs over the rules it is asked for.
    fetchWindowRows(env.DB, w.fromUtc, w.toUtc, named.length === 1 ? { parishId: ids[0] } : {}),
    env.DB.prepare(
      `SELECT e.*, p.name AS parish_name, p.acronym AS parish_acronym, p.jurisdiction, p.timezone
       FROM events e JOIN parishes p ON e.parish_id = p.id
       WHERE e.source_adapter != 'schedule' AND e.start_utc >= ? AND e.start_utc <= ?`
    ).bind(w.fromUtc, w.toUtc).all(),
    crossRows(env.DB),
  ]);
  const mine = new Set(ids);
  if (named.length > 1) rows.schedules = rows.schedules.filter(s => mine.has(s.parish_id));
  // Another parish's service on a date one of these takes part in (migration
  // 041): not among their rules, so read on its own.
  const hosted = await hostedDates(env.DB, ids, w.fromUtc.slice(0, 10), w.toUtc.slice(0, 10));
  const feed = collectionFeed({
    rows,
    events: [...(events.results || []).map(({ updated_by, ...e }) => e), ...hosted],   // eslint-disable-line no-unused-vars
    cross, parishIds: ids, named: ids, route, now: w.from, days: w.days,
  });
  const parishes = await parishesFor(env.DB, feed, new Map(named.map(p => [p.id, p])));
  return calendarText({ name: name || calendarName(route, named), events: feed, parishes, origin, now });
}

/** One date's file, or null when there is no such date. */
async function dateText(env, origin, id, now) {
  const found = await findEvent(env.DB, id);
  const e = found && found.event;
  if (!e || e.status === 'hidden' || e.status === 'rejected') return null;
  const parishes = await parishesFor(env.DB, [e], new Map());
  return calendarText({ name: null, events: [e], parishes, origin, feed: false, now });
}

/** '20:2026-11-22' → 'orthodoxy-20-2026-11-22.ics'. */
export const dateFileName = (id) => `orthodoxy-${String(id).replace(/[^\w-]+/g, '-')}.ics`;

/** '/saved/<token>' → { token, list: null }; '/saved/<token>/<list>' → { token, list }; null for any other path. */
export function savedPath(path) {
  const m = /^\/saved\/([A-Za-z0-9_-]{22})(?:\/([A-Za-z0-9_-]{1,40}))?$/.exec(path || '');
  return m ? { token: m[1], list: m[2] || null } : null;
}

/** What a person's calendar is called on their phone. */
export const SAVED_NAME = 'Saved · orthodoxy.au';
const calName = (name) => `${name} · orthodoxy.au`;

/**
 * One of a person's lists of parishes, as its calendar reads it: Favourites
 * ('fav') or a list of their own, its parishes and what its card asks of
 * them ('/english'). Null when the account has no such list.
 */
export function listOf(saved, listId) {
  if (!saved) return null;
  if (listId === 'fav') return { name: 'Favourites', ids: (saved.favourites || []).map(f => f.id), filters: null };
  const l = (saved.lists || []).find(x => x.id === listId);
  return l ? { name: l.name, ids: l.ids || [], filters: l.filters || null } : null;
}

/**
 * The link a list's calendar is: its parishes, in one order whoever's list it
 * is, and its card's filters, so two people with the same parishes are one
 * feed at the edge. A parish-level combination, read as /sgr+smg.ics is.
 */
export function listPath(list) {
  const ids = [...new Set(list.ids.map(String))].sort().slice(0, MAX_PARISHES);
  if (!ids.length) return null;
  const asks = list.filters && list.filters !== '/' && list.filters.startsWith('/') ? list.filters : '';
  return `/${ids.join('+')}${asks}`;
}
/** The most single dates beyond the window read one by one. */
const MAX_LATER = 20;

const inList = (n) => Array(n).fill('?').join(', ');

/**
 * A person's calendar: every date of each service they saved whole, and each
 * date they saved, a fortnight back to a season ahead (a saved date further
 * out still comes, read on its own). The services' parishes are projected
 * whole and the saved ones picked out after, so the dedup is the page's.
 * Saving nothing is an empty calendar, never a missing one: the phone keeps
 * the subscription and fills it again at the next Save.
 */
export async function savedText(env, origin, marks, now) {
  const db = env.DB;
  const ruleIds = new Set(marks.filter(b => b.kind === 'rule').map(b => String(b.id)));
  const dateIds = new Set(marks.filter(b => b.kind === 'event').map(b => String(b.id)));
  const sids = [...new Set([...ruleIds, ...[...dateIds].map(id => parseInstanceId(id)).filter(Boolean).map(x => String(x.scheduleId))])]
    .filter(id => /^\d+$/.test(id)).slice(0, 500);
  const stored = [...dateIds].filter(id => /^\d+$/.test(id)).slice(0, 500);
  const [fromRules, fromEvents] = await Promise.all([
    sids.length ? db.prepare(`SELECT DISTINCT parish_id FROM schedules WHERE id IN (${inList(sids.length)})`).bind(...sids).all() : { results: [] },
    stored.length ? db.prepare(`SELECT DISTINCT parish_id FROM events WHERE id IN (${inList(stored.length)})`).bind(...stored).all() : { results: [] },
  ]);
  const ids = [...new Set([...(fromRules.results || []), ...(fromEvents.results || [])].map(r => r.parish_id))];
  let kept = [];
  const w = feedWindow(now);
  if (ids.length) {
    const mine = new Set(ids);
    const [rows, events, cross] = await Promise.all([
      fetchWindowRows(db, w.fromUtc, w.toUtc, ids.length === 1 ? { parishId: ids[0] } : {}),
      db.prepare(
        `SELECT e.*, p.name AS parish_name, p.acronym AS parish_acronym, p.jurisdiction, p.timezone
         FROM events e JOIN parishes p ON e.parish_id = p.id
         WHERE e.source_adapter != 'schedule' AND e.parish_id IN (${inList(ids.length)}) AND e.start_utc >= ? AND e.start_utc <= ?`
      ).bind(...ids, w.fromUtc, w.toUtc).all(),
      crossRows(db),
    ]);
    if (ids.length > 1) rows.schedules = rows.schedules.filter(s => mine.has(s.parish_id));
    const feed = collectionFeed({
      rows,
      events: (events.results || []).map(({ updated_by, ...e }) => e),   // eslint-disable-line no-unused-vars
      cross, parishIds: ids, named: ids, route: {}, now: w.from, days: w.days,
    });
    kept = feed.filter(e => (e.schedule_id != null && ruleIds.has(String(e.schedule_id))) || dateIds.has(String(e.id)));
  }
  // A date saved beyond the season, on its own.
  const have = new Set(kept.map(e => String(e.id)));
  const later = [...dateIds].filter(id => !have.has(id)).slice(0, MAX_LATER);
  const found = await Promise.all(later.map(id => findEvent(db, id).catch(() => null)));
  for (const f of found) {
    const e = f && f.event;
    if (!e || e.status === 'hidden' || e.status === 'rejected') continue;
    if (Date.parse(e.start_utc) < Date.parse(w.fromUtc)) continue;
    kept.push({ ...e, id: String(e.id) });
  }
  kept.sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
  const parishes = await parishesFor(db, kept, new Map());
  return calendarText({ name: SAVED_NAME, events: kept, parishes, origin, now });
}

/**
 * The answer to a `.ics` address, or null when it is not one (the caller
 * goes on as it would have).
 */
export async function serveCalendar(request, env, ctx, { now = Date.now() } = {}) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  const path = calendarPath(url.pathname);
  if (path == null) return null;
  const notFound = () => new Response('No calendar here.\n', {
    status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });

  // A person's own. Their saving writes no data version, so the copy kept
  // at the edge is keyed by when they last saved as well.
  const mine = savedPath(path);
  if (mine) {
    const email = await identityOf(env.DB, mine.token);
    if (!email) return notFound();
    const had = await readSaved(env.DB, email);
    const day = localDateOf(ZONE, now);
    if (!mine.list) {
      const res = await cachedHtml({
        request, env, ctx, type: TYPE,
        name: `ics-saved/${mine.token}@${day}@${had ? had.updated_at : 'none'}`,
        build: () => savedText(env, url.origin, (had && had.saved.bookmarks) || [], now),
      });
      return res || notFound();
    }
    // A list: what it holds now, kept at the edge under its parishes (and
    // its name), not under the person, so a change to the list is a new
    // feed and the same parishes are one feed for everybody.
    const list = listOf(had && had.saved, mine.list);
    const lp = list && listPath(list);
    const empty = () => calendarText({ name: list ? calName(list.name) : 'orthodoxy.au', events: [], origin: url.origin, now });
    const res = await cachedHtml({
      request, env, ctx, type: TYPE,
      // A list removed, or emptied, is an empty calendar, never a missing
      // one: the phone keeps the subscription without an error.
      name: lp ? `ics-list${encodeURI(lp.toLowerCase())}@${encodeURIComponent(list.name)}@${day}`
        : `ics-list-none/${mine.token}/${mine.list}@${had ? had.updated_at : 'none'}`,
      build: async () => {
        const route = lp && (pageOf(lp, now) || {}).route;
        return (route && await feedText(env, url.origin, route, now, calName(list.name))) || empty();
      },
    });
    return res || notFound();
  }

  const page = pageOf(path, now);
  const route = page && page.route;
  if (!route) return notFound();

  if (route.eventId && !(route.parishSlugs && route.parishSlugs.length)) {
    const res = await cachedHtml({
      request, env, ctx, type: TYPE,
      name: `ics-date${encodeURI(path.toLowerCase())}`,
      build: () => dateText(env, url.origin, route.eventId, now),
    });
    if (!res) return notFound();
    // A file to open, which a phone hands to its calendar to add. Named by
    // its id, which a cached answer still knows.
    const out = new Response(res.body, res);
    out.headers.set('content-disposition', `inline; filename="${dateFileName(route.eventId)}"`);
    return out;
  }

  const day = localDateOf(ZONE, now);
  const res = await cachedHtml({
    request, env, ctx, type: TYPE,
    name: `ics${encodeURI(path.toLowerCase())}@${day}`,
    build: () => feedText(env, url.origin, route, now),
  });
  return res || notFound();
}
