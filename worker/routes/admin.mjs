// Admin API. Ported from routes/admin.js, which was 847 lines and 32 endpoints
// before phase 1 removed the WhatsApp moderation queues.
//
// Every route is behind requireAdmin (Cloudflare Access). The Express version
// carried a comment warning NOT to add Express-level auth because Caddy's
// forward_auth handled it — that hook died with the VM, so the guard lives here
// now and fails closed.

import { json, readJson } from '../lib/router.mjs';
import { requireAdmin } from '../lib/auth.mjs';
import { geocode } from '../lib/geocode.mjs';
import { expandWindow, expandOne, parseInstanceId } from '../lib/expand.mjs';
import { applyAdminEdit, hideInstance, setCombined, clearCombined } from '../lib/overrides.mjs';
import { PENDING_PARISHES, ADAPTERS, getAdapter, runAdapter,
         adapterPacing, isDue, DEFAULT_INTERVAL_MINUTES } from '../lib/adapters.mjs';
import { inferSchedules } from '../lib/infer.mjs';

// Wrap a handler so the guard runs first.
const guarded = (fn) => async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  return fn(c);
};

// Keep an event's coordinates in step with its parish, unless it has an override.
async function syncEventCoordsForParish(db, parishId) {
  if (!parishId || parishId === '_unassigned') return;
  const p = await db.prepare('SELECT lat, lng FROM parishes WHERE id = ?').bind(parishId).first();
  if (!p || p.lat == null) return;
  await db.prepare(
    `UPDATE events SET lat = ?, lng = ? WHERE parish_id = ?
     AND (location_override IS NULL OR location_override = '')`
  ).bind(p.lat, p.lng, parishId).run();
}

export function registerAdminRoutes(router) {
  // ── liveness ──
  router.get('/api/admin/ping', guarded(async () => json({ ok: true })));

  // ── events ──

  // Candidates for a combine, on one Sydney-local date: stored one-offs plus
  // schedule instances. A UTC range of [prev-day 13:00, day 14:00] covers the
  // full local day regardless of DST.
  router.get('/api/admin/events/candidates', guarded(async ({ env, query }) => {
    const date = query.get('date');
    const excludeId = query.get('exclude_id');
    if (!date) return json({ error: 'date required (YYYY-MM-DD)' }, 400);
    const [y, m, d] = date.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, d - 1, 13, 0, 0)).toISOString();
    const to = new Date(Date.UTC(y, m - 1, d, 14, 0, 0)).toISOString();

    const oneOffs = await env.DB.prepare(
      `SELECT e.id, e.title, e.start_utc, e.end_utc, e.parish_id, p.name AS parish_name,
              e.mutation_type, e.status, e.event_type
       FROM events e JOIN parishes p ON e.parish_id = p.id
       WHERE e.source_adapter != 'schedule' AND e.start_utc >= ? AND e.start_utc < ?
         AND e.status NOT IN ('replaced','rejected','cancelled','hidden')
         AND e.id != COALESCE(?, -1)
       ORDER BY e.start_utc`
    ).bind(from, to, /^\d+$/.test(String(excludeId)) ? Number(excludeId) : null).all();

    const instances = (await expandWindow(env.DB, from, to))
      .filter(e => e.id !== excludeId && e.status === 'approved')
      .map(e => ({
        id: e.id, title: e.title, start_utc: e.start_utc, end_utc: e.end_utc,
        parish_id: e.parish_id, parish_name: e.parish_name,
        mutation_type: e.mutation_type, status: e.status, event_type: e.event_type,
      }));

    return json([...(oneOffs.results || []), ...instances]
      .sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc)));
  }));

  // PATCH an event. A synthetic id writes an override instead of mutating a row.
  router.patch('/api/admin/events/:id', guarded(async ({ env, params, request }) => {
    const body = await readJson(request);

    const inst = parseInstanceId(params.id);
    if (inst) {
      const r = await applyAdminEdit(env.DB, inst.scheduleId, inst.date, body);
      return r.error ? json({ error: r.error }, r.code || 400) : json(r.instance);
    }

    const event = await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(params.id).first();
    if (!event) return json({ error: 'Event not found' }, 404);

    const {
      status, parish_id, title, description, start_utc, end_utc, event_type,
      languages, location_override, hide_live, parish_scoped,
    } = body;

    if (status && !['approved', 'rejected', 'cancelled', 'hidden'].includes(status)) {
      return json({ error: 'Invalid status' }, 400);
    }

    const sets = [], vals = [];
    const put = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
    if (status) put('status', status);
    if (title) put('title', title);
    if (description !== undefined) put('description', description || null);
    if (start_utc) put('start_utc', start_utc);
    if (end_utc !== undefined) put('end_utc', end_utc || null);
    if (event_type) put('event_type', event_type);
    if (languages !== undefined) put('languages', languages || null);
    if (location_override !== undefined) put('location_override', location_override || null);
    if (hide_live !== undefined) put('hide_live', hide_live ? 1 : 0);
    if (parish_scoped !== undefined) put('parish_scoped', parish_scoped ? 1 : 0);

    if (parish_id && parish_id !== event.parish_id) {
      const p = await env.DB.prepare('SELECT id, lat, lng FROM parishes WHERE id = ?').bind(parish_id).first();
      if (!p) return json({ error: 'Invalid parish_id' }, 400);
      put('parish_id', parish_id); put('lat', p.lat); put('lng', p.lng);
    }
    if (!sets.length) return json({ error: 'No fields to update' }, 400);

    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')");
    await env.DB.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...vals, params.id).run();

    if (location_override) {
      const coords = await geocode(location_override);
      if (coords) {
        await env.DB.prepare('UPDATE events SET lat = ?, lng = ? WHERE id = ?')
          .bind(coords.lat, coords.lng, params.id).run();
      }
    } else if (location_override === '') {
      const p = await env.DB.prepare('SELECT lat, lng FROM parishes WHERE id = ?').bind(event.parish_id).first();
      if (p) {
        await env.DB.prepare('UPDATE events SET lat = ?, lng = ? WHERE id = ?')
          .bind(p.lat, p.lng, params.id).run();
      }
    }

    return json(await env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(params.id).first());
  }));

  // DELETE. A synthetic id is suppressed with a 'hidden' override — the rule lives on.
  router.delete('/api/admin/events/:id', guarded(async ({ env, params }) => {
    const inst = parseInstanceId(params.id);
    if (inst) {
      const r = await hideInstance(env.DB, inst.scheduleId, inst.date);
      return r.error ? json({ error: r.error }, r.code || 400) : json({ ok: true });
    }
    const event = await env.DB.prepare('SELECT id FROM events WHERE id = ?').bind(params.id).first();
    if (!event) return json({ error: 'Event not found' }, 404);
    await env.DB.prepare('DELETE FROM events WHERE id = ?').bind(params.id).run();
    return json({ ok: true });
  }));

  // ── combine ──

  router.get('/api/admin/events/:id/escalation', guarded(async ({ env, params }) => {
    const additive = await env.DB.prepare('SELECT parish_id FROM event_parishes WHERE event_id = ?')
      .bind(params.id).all();
    // Stored one-off bases (event_replaces)…
    const replaced = (await env.DB.prepare(
      `SELECT e.id, e.title, e.parish_id, p.name AS parish_name, e.start_utc, e.end_utc
       FROM event_replaces er JOIN events e ON e.id = er.replaced_event_id
       JOIN parishes p ON p.id = e.parish_id WHERE er.replacing_event_id = ?`
    ).bind(params.id).all()).results || [];
    // …plus schedule instances combined into this event (the v26 override path).
    const combined = await env.DB.prepare(
      "SELECT schedule_id, occurrence_date FROM schedule_overrides WHERE combined_into_event_id = ? AND kind = 'combined'"
    ).bind(params.id).all();
    for (const r of combined.results || []) {
      const inst = await expandOne(env.DB, r.schedule_id, r.occurrence_date);
      if (inst) replaced.push({
        id: inst.id, title: inst.title, parish_id: inst.parish_id,
        parish_name: inst.parish_name, start_utc: inst.start_utc, end_utc: inst.end_utc,
      });
    }
    return json({
      additive_parish_ids: (additive.results || []).map(r => r.parish_id),
      replaced_events: replaced,
    });
  }));

  // Set the desired combine state. Idempotent: the body is the target state,
  // and anything not named is removed.
  router.post('/api/admin/events/:id/escalate', guarded(async ({ env, params, request }) => {
    const db = env.DB;
    const event = await db.prepare('SELECT * FROM events WHERE id = ?').bind(params.id).first();
    if (!event) return json({ error: 'Event not found' }, 404);

    const body = await readJson(request);
    const { additive_parish_ids = [], replaced_event_ids = [], approve = false } = body;

    // Targets split by id shape: integers are stored one-offs (event_replaces),
    // "sid:date" are schedule instances (v26 combined overrides).
    const synthTargets = new Set(), intTargets = new Set();
    for (const rid of replaced_event_ids) {
      if (parseInstanceId(rid)) synthTargets.add(String(rid));
      else if (/^\d+$/.test(String(rid))) intTargets.add(Number(rid));
    }
    const targetParishes = new Set(
      additive_parish_ids.filter(pid => typeof pid === 'string' && pid !== event.parish_id)
    );

    const [curP, curR, curC] = await Promise.all([
      db.prepare('SELECT parish_id FROM event_parishes WHERE event_id = ?').bind(event.id).all(),
      db.prepare('SELECT replaced_event_id FROM event_replaces WHERE replacing_event_id = ?').bind(event.id).all(),
      db.prepare("SELECT schedule_id, occurrence_date FROM schedule_overrides WHERE combined_into_event_id = ? AND kind = 'combined'").bind(event.id).all(),
    ]);
    const currentParishes = (curP.results || []).map(r => r.parish_id);
    const currentReplaces = (curR.results || []).map(r => r.replaced_event_id);
    const currentCombined = (curC.results || []).map(r => `${r.schedule_id}:${r.occurrence_date}`);

    const stmts = [];
    if (approve) {
      stmts.push(db.prepare(
        "UPDATE events SET status='approved', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?"
      ).bind(event.id));
    }

    // Additive parishes.
    for (const pid of targetParishes) {
      if (!currentParishes.includes(pid)) {
        stmts.push(db.prepare('INSERT OR IGNORE INTO event_parishes (event_id, parish_id) VALUES (?,?)').bind(event.id, pid));
      }
    }
    for (const pid of currentParishes) {
      if (!targetParishes.has(pid)) {
        stmts.push(db.prepare('DELETE FROM event_parishes WHERE event_id=? AND parish_id=?').bind(event.id, pid));
      }
    }

    // Stored one-off bases.
    for (const rid of intTargets) {
      if (!currentReplaces.includes(rid)) {
        stmts.push(db.prepare('INSERT OR IGNORE INTO event_replaces (replacing_event_id, replaced_event_id) VALUES (?,?)').bind(event.id, rid));
        stmts.push(db.prepare(
          "UPDATE events SET status='replaced', mutation_type='replaced', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?"
        ).bind(rid));
      }
    }
    for (const rid of currentReplaces) {
      if (!intTargets.has(rid)) {
        stmts.push(db.prepare('DELETE FROM event_replaces WHERE replacing_event_id=? AND replaced_event_id=?').bind(event.id, rid));
        stmts.push(db.prepare(
          `UPDATE events SET status='approved',
             mutation_type = CASE WHEN schedule_id IS NOT NULL THEN 'scheduled' ELSE 'headless' END,
             updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
           WHERE id=? AND mutation_type='replaced'`
        ).bind(rid));
      }
    }

    // One batch, so a bad parish id rolls the whole change back rather than
    // leaving half a combine behind.
    if (stmts.length) await db.batch(stmts);

    // Schedule instances go through the override helpers (multi-step each).
    for (const sid of synthTargets) {
      if (!currentCombined.includes(sid)) {
        const p = parseInstanceId(sid);
        await setCombined(db, p.scheduleId, p.date, event.id);
      }
    }
    for (const sid of currentCombined) {
      if (!synthTargets.has(sid)) {
        const p = parseInstanceId(sid);
        await clearCombined(db, p.scheduleId, p.date);
      }
    }

    const [updated, addl, repl] = await Promise.all([
      db.prepare('SELECT * FROM events WHERE id = ?').bind(event.id).first(),
      db.prepare('SELECT parish_id FROM event_parishes WHERE event_id = ?').bind(event.id).all(),
      db.prepare('SELECT replaced_event_id FROM event_replaces WHERE replacing_event_id = ?').bind(event.id).all(),
    ]);
    return json({
      ...updated,
      additional_parishes: (addl.results || []).map(r => r.parish_id),
      replaces: (repl.results || []).map(r => r.replaced_event_id),
    });
  }));

  // ── parishes ──

  router.post('/api/admin/parishes', guarded(async ({ env, request }) => {
    const b = await readJson(request);
    const { name, jurisdiction, lat, lng } = b;
    if (!name || !jurisdiction || lat == null || lng == null) {
      return json({ error: 'name, jurisdiction, lat, and lng are required' }, 400);
    }
    const id = jurisdiction + '-' + name.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

    if (await env.DB.prepare('SELECT id FROM parishes WHERE id = ?').bind(id).first()) {
      return json({ error: 'Parish already exists', id }, 409);
    }

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO parishes (id, name, full_name, jurisdiction, address, lat, lng, timezone,
          website, email, phone, languages, live_url, donation_url, raffle_url, payment_url, gala_url,
          info_source_type, info_source_ref, info_source_name, info_verified_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        id, name, b.full_name || null, jurisdiction, b.address || null, lat, lng,
        b.timezone || 'Australia/Sydney',
        b.website || null, b.email || null, b.phone || null, b.languages || '["English"]',
        b.live_url || null, b.donation_url || null, b.raffle_url || null,
        b.payment_url || null, b.gala_url || null,
        b.info_source_type || null, b.info_source_ref || null, b.info_source_name || null,
        b.info_verified_at || new Date().toISOString(),
      ),
      // A generic inactive rule so the parish shows up in the schedules list.
      env.DB.prepare(
        `INSERT INTO schedules (parish_id, day_of_week, start_time, title, event_type, active)
         VALUES (?, 0, '09:00', 'Divine Liturgy', 'liturgy', 0)`
      ).bind(id),
    ]);

    return json(await env.DB.prepare('SELECT * FROM parishes WHERE id = ?').bind(id).first(), 201);
  }));

  const PARISH_EDITABLE = [
    'name', 'full_name', 'jurisdiction', 'address', 'website', 'email', 'phone',
    'acronym', 'chant_style', 'languages', 'lat', 'lng', 'color', 'live_url',
    'donation_url', 'raffle_url', 'payment_url', 'gala_url', 'timezone',
    'info_source_type', 'info_source_ref', 'info_source_name', 'info_verified_at',
  ];

  router.patch('/api/admin/parishes/:id', guarded(async ({ env, params, request }) => {
    const id = params.id;
    if (id === '_unassigned') return json({ error: 'Cannot edit sentinel parish' }, 400);
    const parish = await env.DB.prepare('SELECT * FROM parishes WHERE id = ?').bind(id).first();
    if (!parish) return json({ error: 'Parish not found' }, 404);

    const b = await readJson(request);
    const sets = [], vals = [];
    for (const k of PARISH_EDITABLE) {
      if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k]); }
    }
    if (!sets.length) return json({ error: 'No valid fields to update' }, 400);

    await env.DB.prepare(`UPDATE parishes SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...vals, id).run();

    if (b.lat !== undefined || b.lng !== undefined) await syncEventCoordsForParish(env.DB, id);

    if (b.address && b.lat === undefined) {
      const coords = await geocode(b.address);
      if (coords) {
        await env.DB.prepare('UPDATE parishes SET lat = ?, lng = ? WHERE id = ?')
          .bind(coords.lat, coords.lng, id).run();
        await syncEventCoordsForParish(env.DB, id);
      }
    }
    return json(await env.DB.prepare('SELECT * FROM parishes WHERE id = ?').bind(id).first());
  }));

  router.delete('/api/admin/parishes/:id', guarded(async ({ env, params, query }) => {
    const id = params.id;
    if (id === '_unassigned') return json({ error: 'Cannot delete sentinel parish' }, 400);
    if (!await env.DB.prepare('SELECT id FROM parishes WHERE id = ?').bind(id).first()) {
      return json({ error: 'Parish not found' }, 404);
    }
    const transferTo = query.get('transfer_to');
    const deleteEvents = query.get('delete_events') === '1';

    const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE parish_id = ?').bind(id).first();
    if (n > 0 && !transferTo && !deleteEvents) {
      return json({ error: `${n} events reference this parish`, event_count: n }, 400);
    }

    const stmts = [];
    if (transferTo) {
      if (!await env.DB.prepare('SELECT id FROM parishes WHERE id = ?').bind(transferTo).first()) {
        return json({ error: 'Transfer target parish not found' }, 400);
      }
      stmts.push(env.DB.prepare('UPDATE events SET parish_id = ? WHERE parish_id = ?').bind(transferTo, id));
      stmts.push(env.DB.prepare('UPDATE schedules SET parish_id = ? WHERE parish_id = ?').bind(transferTo, id));
    } else if (deleteEvents) {
      stmts.push(env.DB.prepare('DELETE FROM events WHERE parish_id = ?').bind(id));
    }
    stmts.push(env.DB.prepare('DELETE FROM schedules WHERE parish_id = ?').bind(id));
    stmts.push(env.DB.prepare('DELETE FROM parishes WHERE id = ?').bind(id));
    await env.DB.batch(stmts);
    return json({ ok: true });
  }));

  const VALID_WEEKS = new Set(['first', 'second', 'third', 'fourth', 'last']);

  // ── schedule proposals ──
  //
  // Scraped events say what is on inside whatever window the source covered.
  // Rules say what is on afterwards. This is the bridge, and it is deliberately
  // two endpoints rather than one: inference proposes, a person accepts.
  //
  // Nothing here writes on its own. A proposal that turns out wrong becomes a
  // rule the feed projects indefinitely and — once reconciliation lands —
  // absence from a scrape starts marking real services cancelled. That is not
  // a decision to make on a cron.

  router.get('/api/admin/parishes/:id/schedule-proposals', guarded(async ({ env, params, query }) => {
    const parish = await env.DB.prepare(
      'SELECT id, name, timezone FROM parishes WHERE id = ?'
    ).bind(params.id).first();
    if (!parish) return json({ error: 'Parish not found' }, 404);

    // Only what was ingested. source_adapter='schedule' is scar tissue from the
    // nightly generator: those rows ARE projections, so inferring rules from
    // them would be reading our own output back in.
    const where = ["parish_id = ?", "source_adapter != 'schedule'", "status = 'approved'"];
    const binds = [params.id];
    if (query.get('from')) { where.push('start_utc >= ?'); binds.push(query.get('from')); }
    if (query.get('to'))   { where.push('start_utc <= ?'); binds.push(query.get('to')); }

    const { results: events = [] } = await env.DB.prepare(
      `SELECT title, start_utc, end_utc, event_type, location_override
       FROM events WHERE ${where.join(' AND ')} ORDER BY start_utc`
    ).bind(...binds).all();

    const { proposals, unexplained } = inferSchedules(events, {
      timezone: parish.timezone || 'Australia/Sydney',
      minSupport: Number(query.get('min_support')) || 3,
    });

    // Flag anything already on file. Rules have an AUTOINCREMENT id and no
    // natural key, so accepting twice would silently double a parish's feed —
    // the same trap the seed had before WHERE NOT EXISTS.
    const { results: existing = [] } = await env.DB.prepare(
      'SELECT id, day_of_week, start_time, title, week_of_month FROM schedules WHERE parish_id = ?'
    ).bind(params.id).all();
    const key = (r) => `${r.day_of_week}|${r.start_time}|${r.title}|${r.week_of_month || ''}`;
    const onFile = new Map(existing.map(r => [key(r), r.id]));

    return json({
      parish: { id: parish.id, name: parish.name, timezone: parish.timezone },
      events_considered: events.length,
      proposals: proposals.map(p => ({ ...p, existing_schedule_id: onFile.get(key(p.rule)) ?? null })),
      unexplained,
    });
  }));

  router.post('/api/admin/parishes/:id/schedule-proposals/accept', guarded(async ({ env, params, request }) => {
    if (!await env.DB.prepare('SELECT id FROM parishes WHERE id = ?').bind(params.id).first()) {
      return json({ error: 'Parish not found' }, 404);
    }
    const { rules } = await readJson(request);
    if (!Array.isArray(rules) || !rules.length) return json({ error: 'rules[] is required' }, 400);

    const created = [], skipped = [];
    for (const r of rules) {
      if (r.day_of_week == null || !r.start_time || !r.title) {
        return json({ error: 'each rule needs day_of_week, start_time and title' }, 400);
      }
      if (r.week_of_month && !r.week_of_month.split(',').every(w => VALID_WEEKS.has(w.trim()))) {
        return json({ error: `invalid week_of_month: ${r.week_of_month}` }, 400);
      }

      // Idempotent by the same identity the seed uses. `x IS NULL` rather than
      // `x = NULL`, which is never true in SQL — get that wrong and every rule
      // looks absent, so accepting twice doubles the feed.
      const dup = await env.DB.prepare(
        `SELECT id FROM schedules WHERE parish_id = ? AND day_of_week = ? AND start_time = ?
           AND title = ? AND (week_of_month IS ? OR week_of_month = ?)`
      ).bind(params.id, r.day_of_week, r.start_time, r.title,
             r.week_of_month || null, r.week_of_month || '').first();
      if (dup) { skipped.push({ title: r.title, existing_schedule_id: dup.id }); continue; }

      const row = await env.DB.prepare(
        `INSERT INTO schedules (parish_id, day_of_week, start_time, end_time, title,
           event_type, week_of_month, languages)
         VALUES (?,?,?,?,?,?,?,?) RETURNING *`
      ).bind(
        params.id, r.day_of_week, r.start_time, r.end_time || null, r.title,
        r.event_type || 'liturgy', r.week_of_month || null, r.languages || null,
      ).first();
      created.push(row);
    }
    return json({ created, skipped }, created.length ? 201 : 200);
  }));

  // ── schedules ──

  router.get('/api/admin/schedules', guarded(async ({ env }) => {
    const r = await env.DB.prepare(
      `SELECT s.*, p.name AS parish_name, p.jurisdiction AS parish_jurisdiction, p.timezone
       FROM schedules s JOIN parishes p ON s.parish_id = p.id
       ORDER BY s.parish_id, s.day_of_week, s.start_time`
    ).all();
    return json(r.results || []);
  }));

  router.post('/api/admin/schedules', guarded(async ({ env, request }) => {
    const b = await readJson(request);
    const { parish_id, day_of_week, start_time, title } = b;
    if (!parish_id || day_of_week == null || !start_time || !title) {
      return json({ error: 'parish_id, day_of_week, start_time, and title are required' }, 400);
    }
    if (b.week_of_month && b.week_of_month.split(',').some(w => !VALID_WEEKS.has(w.trim()))) {
      return json({ error: 'week_of_month values must be: first, second, third, fourth, last' }, 400);
    }
    if (!await env.DB.prepare('SELECT id FROM parishes WHERE id = ?').bind(parish_id).first()) {
      return json({ error: 'Invalid parish_id' }, 400);
    }
    const row = await env.DB.prepare(
      `INSERT INTO schedules (parish_id, day_of_week, start_time, end_time, title, event_type,
        languages, week_of_month, hide_live, parish_scoped)
       VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`
    ).bind(
      parish_id, day_of_week, start_time, b.end_time || null, title,
      b.event_type || 'liturgy', b.languages || null, b.week_of_month || null,
      b.hide_live ? 1 : 0, b.parish_scoped ? 1 : 0,
    ).first();
    return json(row, 201);
  }));

  const SCHEDULE_EDITABLE = ['day_of_week', 'start_time', 'end_time', 'title', 'event_type',
    'active', 'languages', 'week_of_month', 'concurrent', 'hide_live', 'parish_scoped',
    'effective_from', 'effective_to'];
  const BOOL_FIELDS = new Set(['active', 'concurrent', 'hide_live', 'parish_scoped']);

  router.patch('/api/admin/schedules/:id', guarded(async ({ env, params, request }) => {
    if (!await env.DB.prepare('SELECT id FROM schedules WHERE id = ?').bind(params.id).first()) {
      return json({ error: 'Schedule not found' }, 404);
    }
    const b = await readJson(request);
    const sets = [], vals = [];
    for (const k of SCHEDULE_EDITABLE) {
      if (b[k] !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(BOOL_FIELDS.has(k) ? (b[k] ? 1 : 0) : b[k]);
      }
    }
    if (!sets.length) return json({ error: 'No valid fields to update' }, 400);
    // v26: the edit shows up on the next read. No regeneration, no orphaned rows.
    await env.DB.prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...vals, params.id).run();
    return json(await env.DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(params.id).first());
  }));

  router.delete('/api/admin/schedules/:id', guarded(async ({ env, params }) => {
    if (!await env.DB.prepare('SELECT id FROM schedules WHERE id = ?').bind(params.id).first()) {
      return json({ error: 'Schedule not found' }, 404);
    }
    // schedule_overrides cascade via FK.
    await env.DB.prepare('DELETE FROM schedules WHERE id = ?').bind(params.id).run();
    return json({ ok: true });
  }));

  // POST /api/admin/parishes/:id/logo — raw image body, stored in R2.
  //
  // The Express version wrote to /opt/agora/data/logos on the VM's disk. The
  // stored logo_path stays '/logos/<id>.<ext>', so nothing downstream changes.
  router.post('/api/admin/parishes/:id/logo', guarded(async ({ env, params, request }) => {
    if (!env.ASSETS_BUCKET) return json({ error: 'Asset storage not configured' }, 503);
    const id = params.id;
    if (!await env.DB.prepare('SELECT id FROM parishes WHERE id = ?').bind(id).first()) {
      return json({ error: 'Parish not found' }, 404);
    }

    const contentType = request.headers.get('content-type') || '';
    const ext = contentType.includes('png') ? 'png'
              : contentType.includes('svg') ? 'svg'
              : contentType.includes('webp') ? 'webp' : 'jpg';

    const body = await request.arrayBuffer();
    if (!body.byteLength) return json({ error: 'No data received' }, 400);
    if (body.byteLength > 5 * 1024 * 1024) return json({ error: 'Logo too large (5 MB max)' }, 413);

    const key = `logos/${id}.${ext}`;
    await env.ASSETS_BUCKET.put(key, body, {
      httpMetadata: { contentType: contentType || 'image/jpeg', cacheControl: 'public, max-age=86400' },
    });

    const logoPath = `/${key}`;
    await env.DB.prepare('UPDATE parishes SET logo_path = ? WHERE id = ?').bind(logoPath, id).run();
    return json({ logo_path: logoPath });
  }));

  // ── adapters ──

  // `pending` is why the panel can say "this cannot run" before you click Run,
  // instead of letting you discover it from a failed run's error message.
  router.get('/api/admin/adapters', guarded(async ({ env }) => {
    const pacing = await adapterPacing(env.DB);
    const now = Date.now();
    return json(ADAPTERS.map(a => {
      const setting = pacing.setting(a.id);
      return {
        id: a.id, parishId: a.parishId, sourceType: a.sourceType, schedule: a.schedule,
        pending: PENDING_PARISHES.get(a.id) || null,
        // No row means enabled at the default. Absence should never be the
        // thing that stops a scrape happening.
        enabled: setting ? setting.enabled === 1 : true,
        intervalMinutes: setting?.interval_minutes ?? DEFAULT_INTERVAL_MINUTES,
        next: isDue(setting, pacing.lastSuccess(a.id), now).why,
      };
    }));
  }));

  // Pacing lives in the database because a Cron Trigger cannot be changed by
  // the Worker that it fires. wrangler.toml ticks hourly; this decides what an
  // hour is allowed to do.
  const MIN_INTERVAL = 60;      // the heartbeat — asking for less has no effect
  const MAX_INTERVAL = 20160;   // a fortnight; past that, the adapter is off

  router.patch('/api/admin/adapters/:id/settings', guarded(async ({ env, params, request }) => {
    if (!getAdapter(params.id)) return json({ error: 'Adapter not found' }, 404);
    const b = await readJson(request);

    let interval;
    if (b.intervalMinutes !== undefined) {
      interval = Number(b.intervalMinutes);
      if (!Number.isInteger(interval) || interval < MIN_INTERVAL || interval > MAX_INTERVAL) {
        return json({ error: `intervalMinutes must be between ${MIN_INTERVAL} and ${MAX_INTERVAL}` }, 400);
      }
    }
    if (b.enabled === undefined && interval === undefined) {
      return json({ error: 'enabled or intervalMinutes is required' }, 400);
    }

    const row = await env.DB.prepare(
      'SELECT enabled, interval_minutes FROM adapter_settings WHERE adapter_id = ?'
    ).bind(params.id).first();

    const enabled = b.enabled === undefined ? (row ? row.enabled : 1) : (b.enabled ? 1 : 0);
    const minutes = interval ?? (row ? row.interval_minutes : DEFAULT_INTERVAL_MINUTES);

    await env.DB.prepare(
      `INSERT INTO adapter_settings (adapter_id, enabled, interval_minutes)
       VALUES (?,?,?)
       ON CONFLICT(adapter_id) DO UPDATE SET
         enabled = excluded.enabled,
         interval_minutes = excluded.interval_minutes,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`
    ).bind(params.id, enabled, minutes).run();

    const pacing = await adapterPacing(env.DB);
    return json({
      id: params.id,
      enabled: enabled === 1,
      intervalMinutes: minutes,
      next: isDue(pacing.setting(params.id), pacing.lastSuccess(params.id), Date.now()).why,
    });
  }));

  router.post('/api/admin/adapters/:id/run', guarded(async ({ env, params }) => {
    const adapter = getAdapter(params.id);
    if (!adapter) return json({ error: 'Adapter not found' }, 404);
    try {
      return json({ status: 'success', ...(await runAdapter(adapter, env)) });
    } catch (err) {
      return json({ status: 'failed', error: err.message }, 500);
    }
  }));
}
