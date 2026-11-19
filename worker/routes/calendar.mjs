// Every link's calendar twin: the link with `.ics` on the end.
//
//   /sgr.ics                 everything at St George's, for a phone to subscribe to
//   /sgr/sun/liturgy.ics     one timetable line (a date card's "Every Sunday")
//   /sgr+smg+spp.ics         a list of parishes (Favourites)
//   /20:2026-11-22.ics       one date, a file to open ("This date")
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
import { cachedHtml } from '../lib/data-version.mjs';
import { calendarText } from '../lib/ics.mjs';
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

/** A feed's text, or null when the link names no parish here. */
async function feedText(env, origin, route, now) {
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
    env.DB.prepare('SELECT event_id, parish_id FROM event_parishes').all().catch(() => ({ results: [] })),
  ]);
  const mine = new Set(ids);
  if (named.length > 1) rows.schedules = rows.schedules.filter(s => mine.has(s.parish_id));
  const feed = collectionFeed({
    rows,
    events: (events.results || []).map(({ updated_by, ...e }) => e),   // eslint-disable-line no-unused-vars
    cross: cross.results || [], parishIds: ids, named: ids, route, now: w.from, days: w.days,
  });
  const parishes = await parishesFor(env.DB, feed, new Map(named.map(p => [p.id, p])));
  return calendarText({ name: calendarName(route, named), events: feed, parishes, origin, now });
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

/**
 * The answer to a `.ics` address, or null when it is not one (the caller
 * goes on as it would have).
 */
export async function serveCalendar(request, env, ctx, { now = Date.now() } = {}) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  const path = calendarPath(url.pathname);
  if (path == null) return null;
  const page = pageOf(path, now);
  const route = page && page.route;
  const notFound = () => new Response('No calendar here.\n', {
    status: 404, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'public, max-age=300' },
  });
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
