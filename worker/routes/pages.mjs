// Shared links, answered with a page.
//
// Every path now reaches the Worker (run_worker_first in wrangler.toml), and
// this decides which of them it answers itself: a link to ONE parish, with or
// without a focus (/sgr, /sgr/next-tue, /sgr/wed/liturgy), and a link to one
// event (/102, /42:2026-10-04). Those get the lite card (lib/lite-page.mjs).
// Everything else — the home page, /greek/qld, /services, a+b, unknown slugs —
// returns null and the caller hands it to the app exactly as before.
//
// It FAILS OPEN. Any error while building a page returns null, and the app
// answers the link as it always did: a lite page that cannot be built must
// never be the reason a link does not work.
//
// Two ways past it on purpose:
//   ?app               "Open this in the app", from the card's own footer.
//   agora_admin cookie set by the app while somebody holds a role, so an admin
//                      following a link lands where editing lives. It grants
//                      nothing; it only chooses which page to serve.

import urlState from '../../public/shared/url-state.js';
import slugs from '../../public/shared/slugs.js';
import { localDateOf } from '../../public/shared/tz.mjs';
import { fetchWindowRows, expandOne, parseInstanceId } from '../lib/expand.mjs';
import { cachedHtml } from '../lib/data-version.mjs';
import { liteModel, liteWindow, liteStartDate, renderLitePage } from '../lib/lite-page.mjs';
import { sitemapXml } from '../lib/seo.mjs';

const DEFAULT_ZONE = 'Australia/Sydney';

// The parish columns a page shows. Not SELECT *: `updated_by` is an admin's
// email and nothing public carries it.
const PARISH_PAGE_COLS = `id, name, full_name, jurisdiction, address, lat, lng, timezone,
  website, phone, email, logo_path, acronym, languages, live_url, donation_url,
  info_source_name, info_source_ref, info_checked_at, maps_url, updated_at`;

const SITE_PATHS = new Set(slugs.SITE_PATHS);

export const hasAdminCookie = (request) =>
  /(?:^|;\s*)agora_admin=1(?:;|$)/.test(request.headers.get('cookie') || '');

/**
 * Is this path a lite page, and of which kind? Null when it is the app's.
 *
 * Classified against Sydney's today first; the page reclassifies against the
 * parish's own once it knows which parish it is, so /next-tue at a Perth
 * parish means Perth's next Tuesday.
 */
export function liteKind(pathname, now = Date.now()) {
  const first = pathname.split('/').filter(Boolean)[0];
  if (!first || SITE_PATHS.has(first.toLowerCase())) return null;
  const r = urlState.classifyPath(pathname, { today: localDateOf(DEFAULT_ZONE, now) });
  // A part of the day too: the card does not narrow by one, and a card for
  // /sgr/evening listing the morning services would answer the wrong question.
  const appOnly = r.jurisdiction || r.location || r.services || r.socialOnly
    || r.englishOnly || r.donate || r.part;
  if (appOnly) return null;
  if (r.parishSlugs && r.parishSlugs.length === 1) return { kind: 'parish', slug: r.parishSlugs[0], route: r };
  if (!r.parishSlugs && r.eventId && !r.dateFocus && r.day == null && !r.service) {
    return { kind: 'event', route: r };
  }
  return null;
}

async function findParish(db, slug) {
  const norm = String(slug).toLowerCase().replace(/\s+/g, '');
  return (await db.prepare(
    `SELECT ${PARISH_PAGE_COLS} FROM parishes
     WHERE id != '_unassigned' AND lower(replace(acronym, ' ', '')) = ?`
  ).bind(norm).first())
    || db.prepare(`SELECT ${PARISH_PAGE_COLS} FROM parishes WHERE id != '_unassigned' AND lower(id) = ?`)
      .bind(norm).first();
}

/** The event a bare id names, and its parish. Null when neither can be found. */
async function findEvent(db, id) {
  const inst = parseInstanceId(id);
  if (inst) {
    const ev = await expandOne(db, inst.scheduleId, inst.date);
    const rule = ev ? null : await db.prepare('SELECT parish_id FROM schedules WHERE id = ?')
      .bind(inst.scheduleId).first();
    const parishId = ev ? ev.parish_id : rule && rule.parish_id;
    return parishId ? { event: ev, parishId } : null;
  }
  const ev = await db.prepare(
    `SELECT e.*, p.timezone FROM events e JOIN parishes p ON e.parish_id = p.id
     WHERE e.id = ? AND e.status NOT IN ('hidden', 'rejected')`
  ).bind(id).first();
  if (!ev) return null;
  const { updated_by, ...rest } = ev;   // eslint-disable-line no-unused-vars
  return { event: rest, parishId: ev.parish_id };
}

async function buildLite(env, url, kind, now) {
  const db = env.DB;
  let parish, pinnedEvent = null;
  if (kind.kind === 'parish') {
    parish = await findParish(db, kind.slug);
  } else {
    const found = await findEvent(db, kind.route.eventId);
    if (!found) return null;
    pinnedEvent = found.event;
    parish = await db.prepare(`SELECT ${PARISH_PAGE_COLS} FROM parishes WHERE id = ?`)
      .bind(found.parishId).first();
  }
  if (!parish) return null;

  const zone = parish.timezone || DEFAULT_ZONE;
  const route = urlState.classifyPath(url.pathname, { today: localDateOf(zone, now) });
  const { fromUtc, toUtc } = liteWindow(liteStartDate(route, zone, now));

  const [rows, events, cross, links] = await Promise.all([
    fetchWindowRows(db, fromUtc, toUtc, { parishId: parish.id }),
    db.prepare(
      `SELECT e.*, p.name AS parish_name, p.jurisdiction, p.timezone
       FROM events e JOIN parishes p ON e.parish_id = p.id
       WHERE e.source_adapter != 'schedule' AND e.start_utc >= ? AND e.start_utc <= ?
         AND (e.parish_id = ? OR e.id IN (SELECT event_id FROM event_parishes WHERE parish_id = ?))`
    ).bind(fromUtc, toUtc, parish.id, parish.id).all(),
    db.prepare('SELECT event_id, parish_id FROM event_parishes WHERE parish_id = ?').bind(parish.id).all(),
    db.prepare('SELECT slug, label, url FROM parish_links WHERE parish_id = ? ORDER BY sort_order, slug')
      .bind(parish.id).all().catch(() => ({ results: [] })),
  ]);

  const model = liteModel({
    parish, rows,
    events: (events.results || []).map(({ updated_by, ...e }) => e),   // eslint-disable-line no-unused-vars
    cross: cross.results || [],
    links: links.results || [],
    route, pinnedEvent, now, origin: url.origin,
  });
  return renderLitePage(model);
}

/**
 * The page for this request, or null for the app to answer.
 *
 * Cached at the edge per data version and per HOUR: "today" and the list's
 * first day move with the clock, and an hour is fine enough for both while
 * keeping a crawler's or a chat app's repeat fetch off D1 entirely.
 */
export async function servePage(request, env, ctx, { now = Date.now() } = {}) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);

  if (url.pathname === '/sitemap.xml') {
    return cachedHtml({
      request, env, ctx, name: 'sitemap.xml', type: 'application/xml; charset=utf-8',
      build: async () => {
        const r = await env.DB.prepare(
          `SELECT id, acronym, info_checked_at, updated_at FROM parishes
           WHERE id != '_unassigned' ORDER BY name`
        ).all();
        return sitemapXml(r.results || [], url.origin);
      },
    });
  }

  if (url.searchParams.has('app') || hasAdminCookie(request)) return null;
  const kind = liteKind(url.pathname, now);
  if (!kind) return null;

  try {
    const hour = new Date(now).toISOString().slice(0, 13);
    const res = await cachedHtml({
      request, env, ctx,
      name: `lite${encodeURI(url.pathname.toLowerCase())}@${hour}`,
      build: () => buildLite(env, url, kind, now),
    });
    if (res) res.headers.set('x-agora-page', 'lite');
    return res;
  } catch (err) {
    console.error(`[lite] ${url.pathname}: ${err && err.message}`);
    return null;
  }
}
