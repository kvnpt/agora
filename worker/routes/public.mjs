// Public read API.
//
// The shape changed with the move to a client-side lens. The old
// GET /api/events expanded ~2,600 instances server-side and shipped them as
// ~800KB of JSON. The bundle endpoint ships the RULES instead — schedules,
// overrides and stored one-offs — and the browser projects them with the same
// worker/lib modules the Worker uses.
//
// That leaves the Worker doing two SELECTs and a serialize, which is I/O plus
// almost no CPU, and it caches far better: rules change rarely, while an
// expanded feed is stale the moment "now" moves.

import { pdfSourceOverrides, publicOverridePayload } from '../lib/pdf-source-overrides.mjs';
import { readInfoOverrides, publicOverridePayload as publicInfoOverrides }
  from '../lib/info-overrides.mjs';
import { json } from '../lib/router.mjs';
import { fetchWindowRows, expandOne, parseInstanceId } from '../lib/expand.mjs';
import { jurisdictionColorOverrides } from '../lib/juris-colors.mjs';
import { coverageState, coverageMessage } from '../lib/coverage.mjs';
import { cachedJson } from '../lib/data-version.mjs';

// A generous default. The client picks the window it actually renders; this only
// bounds how many rows travel, and rows are far cheaper than instances.
const DEFAULT_WINDOW_DAYS = 120;
const DAY_MS = 86400000;

// The default window starts at a UTC midnight, not at "now minus a day" to the
// millisecond. The bounds are part of what the edge caches the answer under,
// and a bound that moved every millisecond made every request a new key.
function windowFrom(query) {
  const dayStart = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const from = query.get('from') || new Date(dayStart - DAY_MS).toISOString();
  const to = query.get('to') || new Date(Date.parse(from) + DEFAULT_WINDOW_DAYS * DAY_MS).toISOString();
  return { from, to };
}

// Who last edited a row is an admin's email address. Admin reads carry it;
// nothing served here does — the same line /api/parishes has always drawn.
function withoutAuthor(row) {
  if (!row || !('updated_by' in row)) return row;
  const { updated_by, ...rest } = row;   // eslint-disable-line no-unused-vars
  return rest;
}

const PARISH_COLS = `id, name, full_name, jurisdiction, address, lat, lng, timezone,
  website, phone, email, logo_path, acronym, chant_style, languages, color, live_url,
  donation_url, raffle_url, payment_url, gala_url, feast_day,
  info_source_type, info_source_ref, info_source_name, info_checked_at,
  info_verified_at, maps_url`;

export function registerPublicRoutes(router) {
  // GET /api/bundle — everything the client needs to build the feed itself.
  //
  // Served through cachedJson: an ETag on every response, `no-cache` so the
  // browser asks every time, and the body kept at the edge under the data
  // version so asking rarely reaches D1. lib/data-version.mjs has the why.
  router.get('/api/bundle', async ({ env, query, request, ctx }) => {
    const { from, to } = windowFrom(query);
    return cachedJson({
      request, env, ctx,
      name: `bundle?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      build: () => buildBundle(env, from, to),
    });
  });

  async function buildBundle(env, from, to) {
    const [rows, parishes, oneOffs, cross, jurisColors, links] = await Promise.all([
      // Each rule's own columns only; the browser joins the parish back on
      // (public/shared/parish-join.mjs), from the list travelling alongside.
      fetchWindowRows(env.DB, from, to, { withParish: false }),
      env.DB.prepare(`SELECT ${PARISH_COLS} FROM parishes WHERE id != '_unassigned'`).all(),
      env.DB.prepare(
        `SELECT e.*, p.name AS parish_name, p.jurisdiction, p.address AS parish_address,
                p.website AS parish_website, p.logo_path AS parish_logo,
                p.languages AS parish_languages, p.acronym AS parish_acronym,
                p.color AS parish_color, p.live_url AS parish_live_url,
                p.timezone AS timezone
         FROM events e JOIN parishes p ON e.parish_id = p.id
         WHERE e.source_adapter != 'schedule' AND e.start_utc >= ? AND e.start_utc <= ?`
      ).bind(from, to).all(),
      env.DB.prepare('SELECT event_id, parish_id FROM event_parishes').all(),
      jurisdictionColorOverrides(env.DB),
      // A parish's own links. Small — a handful of rows in total — and needed
      // by the sheet the moment a parish is opened, so it rides along rather
      // than costing a request per parish. The catch keeps a bundle served
      // while migration 008 has not run.
      env.DB.prepare('SELECT parish_id, slug, label, url FROM parish_links ORDER BY sort_order, slug')
        .all().catch(() => ({ results: [] })),
    ]);

    return {
      // No build timestamp. The ETag is a hash of this body, and a clock in it
      // would make every rebuild look like new data and cost every browser a
      // full download for nothing.
      window: { from, to },
      parishes: parishes.results || [],
      schedules: rows.schedules.map(withoutAuthor),
      overrides: rows.overrides.map(withoutAuthor),
      // The break windows overlapping this window. Rows, like the rest of the
      // bundle — the browser decides which occurrences they silence, because
      // the browser is where the projection happens.
      breaks: (rows.breaks || []).map(withoutAuthor),
      events: (oneOffs.results || []).map(withoutAuthor),
      event_parishes: cross.results || [],
      // Carried in the bundle rather than fetched separately: every reader of a
      // jurisdiction colour runs during the first render, so a second round
      // trip would mean drawing the map once in the old colours and again in
      // the new ones.
      jurisdiction_colors: jurisColors,
      parish_links: links.results || [],
    };
  }

  // GET /api/parishes
  router.get('/api/parishes', async ({ env }) => {
    const r = await env.DB.prepare(
      `SELECT ${PARISH_COLS} FROM parishes WHERE id != '_unassigned' ORDER BY name`
    ).all();
    return json(r.results || []);
  });

  // GET /api/parishes/:id/links — a parish's own short links, for the sheet.
  router.get('/api/parishes/:id/links', async ({ env, params }) => {
    const r = await env.DB.prepare(
      'SELECT slug, label, url FROM parish_links WHERE parish_id = ? ORDER BY sort_order, slug'
    ).bind(params.id).all().catch(() => ({ results: [] }));
    return json(r.results || []);
  });

  // GET /api/parishes/:id
  router.get('/api/parishes/:id', async ({ env, params }) => {
    const row = await env.DB.prepare(`SELECT ${PARISH_COLS} FROM parishes WHERE id = ?`)
      .bind(params.id).first();
    return row ? json(row) : json({ error: 'Parish not found' }, 404);
  });

  // GET /api/jurisdiction-colors — the overrides alone, for anything that does
  // not want the whole bundle (the admin panel's colours tab).
  router.get('/api/jurisdiction-colors', async ({ env }) => {
    return json(await jurisdictionColorOverrides(env.DB));
  });

  // GET /api/schedules — the raw weekly timetable, as the services view renders it.
  router.get('/api/schedules', async ({ env, query }) => {
    const jurisdiction = query.get('jurisdiction');
    const sql = `
      SELECT s.*, p.name AS parish_name, p.full_name, p.jurisdiction, p.timezone,
             p.address AS parish_address, p.lat, p.lng, p.website AS parish_website,
             p.logo_path AS parish_logo, p.languages AS parish_languages,
             p.acronym AS parish_acronym, p.color AS parish_color
      FROM schedules s JOIN parishes p ON s.parish_id = p.id
      WHERE s.active = 1 AND p.id != '_unassigned'
      ${jurisdiction ? 'AND p.jurisdiction = ?' : ''}
      ORDER BY p.name, s.day_of_week, s.start_time`;
    const stmt = jurisdiction
      ? env.DB.prepare(sql).bind(jurisdiction)
      : env.DB.prepare(sql);
    return json(((await stmt.all()).results || []).map(withoutAuthor));
  });

  // GET /api/events/:id — integer id (stored) or "scheduleId:YYYY-MM-DD" (instance).
  //
  // The client can resolve a synthetic id from the bundle it already holds, so
  // this is for direct/API consumers. It projects exactly one instance.
  router.get('/api/events/:id', async ({ env, params }) => {
    const parsed = parseInstanceId(params.id);
    if (parsed) {
      const inst = await expandOne(env.DB, parsed.scheduleId, parsed.date);
      return inst ? json(inst) : json({ error: 'Event not found' }, 404);
    }
    const row = await env.DB.prepare(
      `SELECT e.*, p.name AS parish_name, p.jurisdiction, p.address AS parish_address,
              p.timezone, p.live_url AS parish_live_url
       FROM events e JOIN parishes p ON e.parish_id = p.id WHERE e.id = ?`
    ).bind(params.id).first();
    return row ? json(row) : json({ error: 'Event not found' }, 404);
  });

  // GET /api/pdf-sources — which parish PDF URLs have been changed from /admin.
  //
  // PUBLIC, and that is the point rather than an oversight. The extraction
  // GitHub Action has to read the same overrides the Worker does, or the URL
  // fetched and the URL believed drift apart — which is the exact failure
  // pdf-sources.mjs being imported by both consumers exists to prevent. The
  // Action has no Cloudflare credential and should not need one, so the
  // overrides are served here.
  //
  // There is nothing to withhold: these are public parish schedules, already
  // linked from the parishes' own websites. Only the overrides are served, not
  // the registry — the Action already has the file, so an unreachable endpoint
  // degrades to "no overrides" rather than to "no sources".
  router.get('/api/pdf-sources', async ({ env }) =>
    json(publicOverridePayload(await pdfSourceOverrides(env.DB))));

  // GET /api/info-overrides — which source has been ruled to win, per parish.
  //
  // PUBLIC for the same reason /api/pdf-sources is, and it is a stronger case.
  // The importers are scripts run from a terminal against production over
  // these very endpoints: scripts/build-antiochian-schedules.mjs reads
  // /api/parishes and /api/schedules and has no Cloudflare credential at all.
  // A ruling only the Worker could see would be a ruling the import ignores,
  // and the import is the thing the ruling exists to stop — the two Elimbah
  // Vespers would come straight back on the next run, which is the whole
  // problem.
  //
  // `updated_by` is withheld; nothing else is. A note saying a parish
  // confirmed by telephone that a service no longer runs is a thing readers
  // benefit from, and the admin's email address is not.
  router.get('/api/info-overrides', async ({ env, query }) =>
    json(publicInfoOverrides(await readInfoOverrides(env.DB, query.get('parish') || null))));

  // GET /api/adapters/status — is the scrape alive?
  router.get('/api/adapters/status', async ({ env }) => {
    const r = await env.DB.prepare(
      `SELECT adapter_id, started_at, finished_at, status, events_found, events_created,
              events_updated, error_message, window_from, window_to, tombstones_refused
       FROM adapter_runs r
       WHERE started_at = (SELECT MAX(started_at) FROM adapter_runs WHERE adapter_id = r.adapter_id)
       ORDER BY adapter_id`
    ).all();
    const today = new Date().toISOString().slice(0, 10);
    return json((r.results || []).map(run => {
      // Only a run that WORKED has anything to say about coverage. A failed run
      // reported no window, and calling that "out of dates" would blame the
      // source for the scraper being broken — which is precisely backwards on
      // the adapter this was written for, whose R2 object is simply missing.
      const cover = run.status === 'failed'
        ? { state: 'unknown', until: null, daysLeft: null }
        : coverageState(run.window_to, today);
      return {
        id: run.adapter_id,
        healthy: run.status !== 'failed',
        message: `Last run: ${run.status}` +
          (run.tombstones_refused ? ` (cancellations held back: ${run.tombstones_refused})` : ''),
        lastRun: run.finished_at,
        lastError: run.error_message,
        eventsFound: run.events_found,
        eventsCreated: run.events_created,
        eventsUpdated: run.events_updated,
        // What the run could speak for, and whether it was allowed to act on
        // silence. A refusal is not a failure — the scrape worked — but it is
        // the difference between "nothing was cancelled" and "nothing needed
        // cancelling", and only one of those is worth looking into.
        window: run.window_from ? { from: run.window_from, to: run.window_to } : null,
        tombstonesRefused: run.tombstones_refused,
        // How much future is left in it. Deliberately NOT folded into `healthy`:
        // a parish that has stopped publishing has not broken the scraper, and
        // a run that succeeds forever over a source that ran out in April is
        // the exact failure this reports. See worker/lib/coverage.mjs.
        coverage: { ...cover, message: coverageMessage(cover) },
      };
    }));
  });
}
