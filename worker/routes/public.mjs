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

import { json } from '../lib/router.mjs';
import { fetchWindowRows, expandOne, parseInstanceId } from '../lib/expand.mjs';

// A generous default. The client picks the window it actually renders; this only
// bounds how many rows travel, and rows are far cheaper than instances.
const DEFAULT_WINDOW_DAYS = 120;
const DAY_MS = 86400000;

function windowFrom(query) {
  const from = query.get('from') || new Date(Date.now() - DAY_MS).toISOString();
  const to = query.get('to') || new Date(Date.parse(from) + DEFAULT_WINDOW_DAYS * DAY_MS).toISOString();
  return { from, to };
}

const PARISH_COLS = `id, name, full_name, jurisdiction, address, lat, lng, timezone,
  website, phone, email, logo_path, acronym, chant_style, languages, color, live_url,
  donation_url, raffle_url, payment_url, gala_url,
  info_source_type, info_source_ref, info_verified_at`;

export function registerPublicRoutes(router) {
  // GET /api/bundle — everything the client needs to build the feed itself.
  router.get('/api/bundle', async ({ env, query }) => {
    const { from, to } = windowFrom(query);

    const [rows, parishes, oneOffs, cross] = await Promise.all([
      fetchWindowRows(env.DB, from, to),
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
    ]);

    return json({
      window: { from, to },
      generated_at: new Date().toISOString(),
      parishes: parishes.results || [],
      schedules: rows.schedules,
      overrides: rows.overrides,
      events: oneOffs.results || [],
      event_parishes: cross.results || [],
    }, 200, {
      // Rules change rarely. The client re-derives "now" locally, so a stale-ish
      // bundle is still correct — only newly-added events are missed, briefly.
      'cache-control': 'public, max-age=60, stale-while-revalidate=600',
    });
  });

  // GET /api/parishes
  router.get('/api/parishes', async ({ env }) => {
    const r = await env.DB.prepare(
      `SELECT ${PARISH_COLS} FROM parishes WHERE id != '_unassigned' ORDER BY name`
    ).all();
    return json(r.results || []);
  });

  // GET /api/parishes/:id
  router.get('/api/parishes/:id', async ({ env, params }) => {
    const row = await env.DB.prepare(`SELECT ${PARISH_COLS} FROM parishes WHERE id = ?`)
      .bind(params.id).first();
    return row ? json(row) : json({ error: 'Parish not found' }, 404);
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
    return json((await stmt.all()).results || []);
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

  // GET /api/adapters/status — is the scrape alive?
  router.get('/api/adapters/status', async ({ env }) => {
    const r = await env.DB.prepare(
      `SELECT adapter_id, started_at, finished_at, status, events_found, events_created,
              events_updated, error_message
       FROM adapter_runs r
       WHERE started_at = (SELECT MAX(started_at) FROM adapter_runs WHERE adapter_id = r.adapter_id)
       ORDER BY adapter_id`
    ).all();
    return json((r.results || []).map(run => ({
      id: run.adapter_id,
      healthy: run.status !== 'failed',
      message: `Last run: ${run.status}`,
      lastRun: run.finished_at,
      lastError: run.error_message,
      eventsFound: run.events_found,
      eventsCreated: run.events_created,
      eventsUpdated: run.events_updated,
    })));
  });
}
