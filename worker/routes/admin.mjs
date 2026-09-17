// Admin API. Ported from routes/admin.js, which was 847 lines and 32 endpoints
// before phase 1 removed the WhatsApp moderation queues.
//
// Every route is behind requireAdmin (Cloudflare Access). The Express version
// carried a comment warning NOT to add Express-level auth because Caddy's
// forward_auth handled it — that hook died with the VM, so the guard lives here
// now and fails closed.

import { json, readJson } from '../lib/router.mjs';
import { requireAdmin, adminIdentity } from '../lib/auth.mjs';
import { geocode } from '../lib/geocode.mjs';
import { expandWindow, expandOne, parseInstanceId } from '../lib/expand.mjs';
import { applyAdminEdit, hideInstance, setCombined, clearCombined } from '../lib/overrides.mjs';
import { PENDING_PARISHES, ADAPTERS, getAdapter, runAdapter,
         adapterPacing, isDue, DEFAULT_INTERVAL_MINUTES } from '../lib/adapters.mjs';
import { inferSchedules } from '../lib/infer.mjs';
import { pdfSourceStatus, fileIsNewerThanRun } from '../lib/pdf-status.mjs';
import { dispatchExtraction, recentExtractionRuns } from '../lib/github-actions.mjs';
import { pdfSourceOverrides, applyOverride, isHttpUrl } from '../lib/pdf-source-overrides.mjs';
import { resolveRole, can, mayTouchParish, denial, rolePayload, ROLES, parseParishIds } from '../lib/roles.mjs';
import { validateProposal, describeProposal, readPayload, PROPOSABLE, isOpen } from '../lib/proposals.mjs';
import { JURISDICTION_SOURCES, getJurisdiction, isRerunnable, automationNote,
         daysSince, staleness } from '../lib/jurisdictions.mjs';
import { jurisdictionColorOverrides, JURISDICTIONS, HEX } from '../lib/juris-colors.mjs';
import slugs from '../../public/shared/slugs.js';
import timezones from '../../public/shared/timezones.js';

const { normaliseSlug, reservedSlugReason } = slugs;
const { isResolvableTimezone, DEFAULT_TIMEZONE } = timezones;

// A zone the runtime cannot resolve makes every one of that parish's service
// times meaningless, and the row looks fine. Refused rather than stored,
// because `schedules.start_time` is LOCAL to this column and there is nothing
// downstream that can notice.
const timezoneProblem = (tz) => (tz === undefined || isResolvableTimezone(tz))
  ? null
  : `"${tz}" is not a timezone this runtime knows. Use an IANA name like Australia/Brisbane.`;

// The four links that are columns on `parishes`. A parish_links row may not
// take one of these slugs: /smg/donate has to keep answering from the column,
// and two places to set one link is how they come to disagree.
const PAY_KINDS = new Set(['donate', 'raffle', 'payment', 'gala']);

// An acronym is a URL segment, so saving one is a namespace change.
//
// Enforced here rather than in either editor: the in-app parish form and
// /admin both PATCH this endpoint, so a rule that lives here is a rule both
// obey and neither can be updated out of step with. Two ways it can collide —
// with a reserved link (/greek, /qld, /services, /42), and with another
// parish that already answers to it.
async function acronymConflict(db, acronym, parishId) {
  const slug = normaliseSlug(acronym);
  if (!slug) return null;   // clearing it is always allowed
  const reserved = reservedSlugReason(slug);
  if (reserved) return reserved;
  // Compare the way index.mjs resolves a payment deep link, so "St M G" and
  // "stmg" are recognised as the same link rather than saved as two.
  const clash = await db.prepare(
    `SELECT id, name FROM parishes
     WHERE id != '_unassigned' AND id != ? AND lower(replace(acronym, ' ', '')) = ?`
  ).bind(parishId || '', slug).first();
  return clash ? `"${slug}" is already the acronym for ${clash.name}.` : null;
}

// Wrap a handler so the guard runs first.
//
// TWO GATES, not one. requireAdmin is Cloudflare Access: who got through the
// door. `capability` is this codebase's own question: what they may touch now
// that they are inside. That was a single boolean until roles existed, so
// everybody who could sign in could delete any parish.
//
// The capability is named at the route, never a role — a route that asked for
// "owner" would have to be revisited every time the role table changed, and the
// panel could not grey out the same control the API refuses.
//
// Omitting the capability means "any recognised role", which is right for the
// reads: a parish contact needs the parish list to render their own card.
const guarded = (capability, fn) => {
  // Called as guarded(fn) by every route that predates roles.
  if (typeof capability === 'function') { fn = capability; capability = null; }

  return async (c) => {
    const denied = await requireAdmin(c);
    if (denied) return denied;

    const identity = await adminIdentity(c);
    const who = await resolveRole(c.env.DB, identity);
    // Stash it: handlers need the role for parish scoping and for the audit
    // line, and resolving it twice is a second query for the same answer.
    c.who = { ...who, identity };

    if (!who.role) return json({ error: denial(null, capability), role: null }, 403);
    if (capability && !can(who.role, capability)) {
      // A refusal that offers the way forward. These three are exactly the
      // capabilities an owner keeps, and exactly the ones with nowhere else to
      // go — so rather than ending at "you cannot", the panel turns this into
      // an ask the owner sees with its reason attached.
      return json({
        error: denial(who.role, capability),
        role: who.role,
        proposable: PROPOSABLE.includes(capability),
        capability,
      }, 403);
    }
    return fn(c);
  };
};

// A parish-scoped person acting on somebody else's parish.
//
// Separate from the capability check because it is a different question — the
// verb is allowed, the object is not — and because the answer needs the row,
// which only the handler has.
const outOfScope = (c, parishId) => mayTouchParish(c.who, parishId)
  ? null
  : json({
      error: 'That parish is not one of yours. Ask an owner if you need it added.',
      role: c.who.role,
    }, 403);

// Who to attribute an edit to. Null under the dev bypass is fine — the column
// is nullable and "dev" is not a person.
const editor = async (c) => (await adminIdentity(c)) || null;
const NOW = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

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
  // Answers "am I signed in", and now also "as whom". The panel prints it in
  // the header: with one admin that was noise, but the moment a second person
  // has a login, "which account am I editing as" is a question worth being able
  // to answer without opening a Cloudflare dashboard.
  router.get('/api/admin/ping', guarded(async (c) => json({
    ok: true,
    identity: await adminIdentity(c),
    // The panel renders itself from this: a control it greys out and a route
    // that refuses consult the same capability map, so a disabled button and a
    // 403 cannot disagree. It is convenience, never enforcement — every guard
    // above re-checks server-side.
    ...rolePayload(c.who),
  })));

  // ── people ──
  //
  // Who may sign in and what they may do. Owner-only, because an editor who
  // could edit this table could make themselves an owner.
  router.get('/api/admin/people', guarded('people.manage', async ({ env }) => {
    const r = await env.DB.prepare(
      'SELECT email, role, parish_ids, note, added_by, created_at FROM admin_roles ORDER BY role, email'
    ).all().catch(() => ({ results: [] }));
    return json((r.results || []).map(row => ({
      email: row.email,
      role: row.role,
      parishIds: parseParishIds(row.parish_ids),
      note: row.note || null,
      addedBy: row.added_by || null,
      createdAt: row.created_at,
    })));
  }));

  router.put('/api/admin/people/:email', guarded('people.manage', async (c) => {
    const { env, params, request } = c;
    // Whatever adminIdentity() returns is what this table is keyed on, and that
    // is NOT always an email: the claims fall back to `sub` when the identity
    // provider supplies no address, and the dev bypass returns 'dev'. Requiring
    // an '@' would make exactly those accounts unaddable, so the check is that
    // it is a plausible single identifier rather than that it is an email.
    const email = decodeURIComponent(params.email).trim().toLowerCase();
    if (!email || /\s/.test(email) || email.length > 320) {
      return json({ error: 'An identity is required — the email or subject Access signs in with.' }, 400);
    }

    const b = await readJson(request);
    if (!ROLES.includes(b.role)) {
      return json({ error: `role must be one of ${ROLES.join(', ')}.`, field: 'role' }, 400);
    }
    const parishIds = Array.isArray(b.parishIds) ? b.parishIds.filter(x => typeof x === 'string' && x) : [];
    // A parish contact with no parishes can touch nothing, which is a role
    // that looks granted and is not. Refuse it here rather than let somebody
    // discover it from a 403 on their own parish.
    if (b.role === 'parish' && !parishIds.length) {
      return json({ error: 'A parish contact needs at least one parish.', field: 'parishIds' }, 400);
    }

    // The last owner cannot demote themselves, because the table would then
    // have rows and no one able to edit it — locked out with no way back in
    // except SQL.
    const lastOwner = await wouldStrandTheTable(env.DB, email, b.role);
    if (lastOwner) return json({ error: lastOwner }, 409);

    await env.DB.prepare(
      `INSERT INTO admin_roles (email, role, parish_ids, note, added_by)
       VALUES (?,?,?,?,?)
       ON CONFLICT(email) DO UPDATE SET
         role = excluded.role, parish_ids = excluded.parish_ids, note = excluded.note`
    ).bind(email, b.role, parishIds.length ? JSON.stringify(parishIds) : null,
           (b.note || '').trim() || null, await editor(c)).run();

    return json({ email, role: b.role, parishIds, note: b.note || null });
  }));

  router.delete('/api/admin/people/:email', guarded('people.manage', async ({ env, params }) => {
    const email = decodeURIComponent(params.email).trim().toLowerCase();
    const stranded = await wouldStrandTheTable(env.DB, email, null);
    if (stranded) return json({ error: stranded }, 409);
    await env.DB.prepare('DELETE FROM admin_roles WHERE lower(email) = ?').bind(email).run();
    return json({ email, removed: true });
  }));

  /**
   * Would changing this person's role leave the table with no owner?
   *
   * Returns a sentence when it would, null when it is fine. The failure it
   * prevents is total: with rows present and no owner, nobody can edit
   * admin_roles and nobody can be added, so the only way back is SQL against
   * production.
   */
  async function wouldStrandTheTable(db, email, newRole) {
    let owners = [];
    try {
      const r = await db.prepare("SELECT email FROM admin_roles WHERE role = 'owner'").all();
      owners = (r.results || []).map(x => String(x.email).toLowerCase());
    } catch { return null; }
    if (!owners.includes(email)) return null;      // not an owner; nothing to strand
    if (newRole === 'owner') return null;          // still an owner afterwards
    if (owners.length > 1) return null;            // somebody else can still get in
    return 'This is the only owner. Make somebody else an owner first, or the '
      + 'admin list becomes uneditable by anyone.';
  }

  // ── "I have stood in front of this place" ──
  //
  // info_verified_at is the one field that stops a re-import moving a pin
  // somebody checked: scripts/parish-import.mjs guards its UPDATE on it. It
  // was in PARISH_EDITABLE and in no form, so the only way to set it was SQL
  // against production.
  //
  // Its own endpoint rather than a field on the edit form, because it is not a
  // value somebody types — it is an assertion about having been there, and it
  // is stamped with who made it.
  router.post('/api/admin/parishes/:id/verify', guarded('parish.edit', async (c) => {
    const { env, params } = c;
    const scoped = outOfScope(c, params.id);
    if (scoped) return scoped;
    if (!await env.DB.prepare('SELECT id FROM parishes WHERE id = ?').bind(params.id).first()) {
      return json({ error: 'Parish not found' }, 404);
    }
    const who = await editor(c);
    const now = NOW();
    await env.DB.prepare(
      `UPDATE parishes SET info_verified_at = ?, updated_at = ?, updated_by = ? WHERE id = ?`
    ).bind(now, now, who, params.id).run();
    return json({ id: params.id, info_verified_at: now, verified_by: who });
  }));

  router.delete('/api/admin/parishes/:id/verify', guarded('parish.edit', async (c) => {
    const { env, params } = c;
    const scoped = outOfScope(c, params.id);
    if (scoped) return scoped;
    await env.DB.prepare(
      `UPDATE parishes SET info_verified_at = NULL, updated_at = ?, updated_by = ? WHERE id = ?`
    ).bind(NOW(), await editor(c), params.id).run();
    return json({ id: params.id, info_verified_at: null });
  }));

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
  router.patch('/api/admin/events/:id', guarded('event.edit', async ({ env, params, request }) => {
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
  router.delete('/api/admin/events/:id', guarded('event.edit', async ({ env, params }) => {
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
  router.post('/api/admin/events/:id/escalate', guarded('event.edit', async ({ env, params, request }) => {
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

  // ── a parish's own links ──
  //
  // The four payment kinds are columns on `parishes` and stay there; these are
  // the ones it does not have a column for. Both editors show them in one
  // place, because "where do I change the raffle link" should have one answer.

  // Every parish's links in one response, so the admin list can show a count
  // per parish without a request each.
  router.get('/api/admin/parish-links', guarded(async ({ env }) => {
    const r = await env.DB.prepare(
      'SELECT parish_id, slug, label, url, sort_order FROM parish_links ORDER BY parish_id, sort_order, slug'
    ).all().catch(() => ({ results: [] }));
    return json(r.results || []);
  }));

  router.get('/api/admin/parishes/:id/links', guarded(async ({ env, params }) => {
    const r = await env.DB.prepare(
      'SELECT slug, label, url, sort_order FROM parish_links WHERE parish_id = ? ORDER BY sort_order, slug'
    ).bind(params.id).all().catch(() => ({ results: [] }));
    return json(r.results || []);
  }));

  // PUT the whole set for one parish. A link list is short, is edited as a
  // list, and is saved by one button — so a replace is what the editor
  // actually does, and a per-row API would make the UI reconstruct it anyway.
  router.put('/api/admin/parishes/:id/links', guarded('links.edit', async (c) => {
    const { env, params, request } = c;
    const scoped = outOfScope(c, params.id);
    if (scoped) return scoped;
    const id = params.id;
    if (!await env.DB.prepare('SELECT id FROM parishes WHERE id = ?').bind(id).first()) {
      return json({ error: 'Parish not found' }, 404);
    }
    const b = await readJson(request);
    const links = Array.isArray(b && b.links) ? b.links : null;
    if (!links) return json({ error: 'links must be an array' }, 400);

    const seen = new Set();
    const clean = [];
    for (const l of links) {
      const slug = normaliseSlug(l && l.slug);
      const url = String((l && l.url) || '').trim();
      if (!slug || !url) continue;                       // a blank row is a deletion
      // The slug is a URL segment in the same namespace as an acronym, a
      // jurisdiction, a location and a service. /smg/liturgy means the service
      // and must keep meaning it, so the same list refuses it here.
      const reserved = reservedSlugReason(slug);
      if (reserved) return json({ error: reserved, field: slug }, 409);
      if (PAY_KINDS.has(slug)) {
        return json({ error: `"${slug}" is one of the four built-in links — set it on the parish itself.`, field: slug }, 409);
      }
      if (seen.has(slug)) return json({ error: `"${slug}" is listed twice`, field: slug }, 409);
      if (!/^https?:\/\//i.test(url)) {
        return json({ error: `"${slug}" needs a full http(s) URL`, field: slug }, 400);
      }
      seen.add(slug);
      clean.push({ slug, url, label: (l.label || '').trim() || null, sort_order: clean.length });
    }

    const stmts = [env.DB.prepare('DELETE FROM parish_links WHERE parish_id = ?').bind(id)];
    for (const l of clean) {
      stmts.push(env.DB.prepare(
        `INSERT INTO parish_links (parish_id, slug, label, url, sort_order, updated_at)
         VALUES (?,?,?,?,?,?)`
      ).bind(id, l.slug, l.label, l.url, l.sort_order, new Date().toISOString()));
    }
    await env.DB.batch(stmts);
    return json(clean);
  }));

  // ── jurisdiction colours ──
  //
  // Six colours chosen one at a time, in code, that had never been looked at
  // together. The admin panel shows them side by side; these two endpoints are
  // what lets an adjustment be a save rather than a deploy.

  // PATCH /api/admin/jurisdiction-colors
  //
  // Body { colors: { greek: '#00508f', russian: null, ... } }. A hex sets an
  // override; null clears one, and clearing is how a jurisdiction goes back to
  // the colour in public/shared/jurisdiction-colors.js — that file stays the
  // default table and this endpoint never writes to it.
  //
  // PATCH and not PUT, and the distinction is the point: only named keys are
  // written. Two admins with the page open would each send the six colours
  // they last loaded, and a whole-table replace would let the second silently
  // undo the first's change to a jurisdiction they never touched.
  router.patch('/api/admin/jurisdiction-colors', guarded('colors.edit', async ({ env, request }) => {
    const b = await readJson(request);
    const colors = b && b.colors;
    if (!colors || typeof colors !== 'object') return json({ error: 'colors is required' }, 400);

    const stmts = [];
    for (const [jurisdiction, value] of Object.entries(colors)) {
      if (!JURISDICTIONS.has(jurisdiction)) {
        return json({ error: `Not a jurisdiction: ${jurisdiction}` }, 400);
      }
      if (value === null || value === '') {
        stmts.push(env.DB.prepare('DELETE FROM jurisdiction_colors WHERE jurisdiction = ?')
          .bind(jurisdiction));
        continue;
      }
      const hex = String(value).trim();
      if (!HEX.test(hex)) return json({ error: `Not a colour: ${value}`, field: jurisdiction }, 400);
      stmts.push(env.DB.prepare(
        `INSERT INTO jurisdiction_colors (jurisdiction, color, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(jurisdiction) DO UPDATE SET color = excluded.color, updated_at = excluded.updated_at`
      ).bind(jurisdiction, hex, new Date().toISOString()));
    }
    if (!stmts.length) return json({ error: 'No colours to write' }, 400);
    await env.DB.batch(stmts);
    return json(await jurisdictionColorOverrides(env.DB));
  }));

  // POST /api/admin/parishes/repaint
  //
  // A jurisdiction's colour and a parish's own colour are different things —
  // the map draws the first, a card draws the second — so changing one does
  // not change the other, and migration 004 is the only reason they currently
  // agree for almost every row.
  //
  // This is that migration as an explicit, counted action: only rows still
  // carrying the colour being replaced are repainted, so a parish somebody
  // gave its own hue keeps it. `from` is what the admin panel just had on
  // screen, which is why it is a parameter rather than something re-derived
  // here: the answer to "what am I replacing" belongs to the page that showed
  // it, and a mismatch repaints nothing rather than the wrong rows.
  router.post('/api/admin/parishes/repaint', guarded('colors.edit', async ({ env, request }) => {
    const b = await readJson(request);
    const { jurisdiction, from, to } = b || {};
    if (!JURISDICTIONS.has(jurisdiction)) return json({ error: 'jurisdiction is required' }, 400);
    if (!HEX.test(String(from || '')) || !HEX.test(String(to || ''))) {
      return json({ error: 'from and to must both be colours' }, 400);
    }
    const r = await env.DB.prepare(
      `UPDATE parishes SET color = ?
       WHERE jurisdiction = ? AND id != '_unassigned' AND lower(color) = lower(?)`
    ).bind(to, jurisdiction, from).run();
    return json({ jurisdiction, from, to, repainted: r.meta ? r.meta.changes : 0 });
  }));

  // ── parishes ──

  // The panel's own read of the parish table.
  //
  // It used to use the PUBLIC /api/parishes, which was fine until rows started
  // carrying `updated_by` — an admin's email address, which has no business on
  // an endpoint anybody can curl. The public list stays exactly as it was; this
  // one is behind the guard and carries the whole row.
  //
  // Not scoped to a parish contact's own parishes: everything here is already
  // on the public site, minus the audit line, and every admin is trusted with
  // that. Scoping happens where it matters, on the writes.
  router.get('/api/admin/parishes', guarded(async ({ env }) => {
    const r = await env.DB.prepare(
      "SELECT * FROM parishes WHERE id != '_unassigned' ORDER BY name"
    ).all();
    return json(r.results || []);
  }));


  router.post('/api/admin/parishes', guarded('parish.create', async ({ env, request }) => {
    const b = await readJson(request);
    const { name, jurisdiction, lat, lng } = b;
    if (!name || !jurisdiction || lat == null || lng == null) {
      return json({ error: 'name, jurisdiction, lat, and lng are required' }, 400);
    }
    const tzBad = timezoneProblem(b.timezone);
    if (tzBad) return json({ error: tzBad, field: 'timezone' }, 400);
    const id = jurisdiction + '-' + name.toLowerCase()
      .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

    if (await env.DB.prepare('SELECT id FROM parishes WHERE id = ?').bind(id).first()) {
      return json({ error: 'Parish already exists', id }, 409);
    }
    if (b.acronym !== undefined) {
      const conflict = await acronymConflict(env.DB, b.acronym, id);
      if (conflict) return json({ error: conflict, field: 'acronym' }, 409);
    }

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO parishes (id, name, full_name, jurisdiction, address, lat, lng, timezone,
          website, email, phone, acronym, languages, live_url, donation_url, raffle_url, payment_url, gala_url,
          info_source_type, info_source_ref, info_source_name, info_checked_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        id, name, b.full_name || null, jurisdiction, b.address || null, lat, lng,
        b.timezone || DEFAULT_TIMEZONE,
        // Was accepted and dropped — the column was missing from the INSERT,
        // so a create that set an acronym came back without one.
        b.website || null, b.email || null, b.phone || null, b.acronym || null,
        b.languages || '["English"]',
        b.live_url || null, b.donation_url || null, b.raffle_url || null,
        b.payment_url || null, b.gala_url || null,
        b.info_source_type || null, b.info_source_ref || null, b.info_source_name || null,
        // Adding a parish by hand IS reading its source, so the row is stamped
        // now unless the caller says when they actually looked. It stamps the
        // CHECK, never info_verified_at — nobody has stood in front of the
        // place because somebody typed its address into a form.
        b.info_checked_at || new Date().toISOString(),
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
    'info_source_type', 'info_source_ref', 'info_source_name', 'info_checked_at',
    'info_verified_at',
  ];

  router.patch('/api/admin/parishes/:id', guarded('parish.edit', async (c) => {
    const { env, params, request } = c;
    const id = params.id;
    if (id === '_unassigned') return json({ error: 'Cannot edit sentinel parish' }, 400);
    const parish = await env.DB.prepare('SELECT * FROM parishes WHERE id = ?').bind(id).first();
    if (!parish) return json({ error: 'Parish not found' }, 404);

    const b = await readJson(request);

    const scoped = outOfScope(c, id);
    if (scoped) return scoped;

    // Only when it actually changes. The in-app form posts every field on
    // every save, so checking on presence alone would block an edit to the
    // phone number of a parish whose acronym predates a slug that now exists.
    if (b.acronym !== undefined && normaliseSlug(b.acronym) !== normaliseSlug(parish.acronym)) {
      // An acronym is a URL segment, so changing one takes a link away from
      // everybody holding it. That is a different act from editing a phone
      // number, and it is the reason `parish.edit` is not enough on its own.
      if (!can(c.who.role, 'parish.acronym')) {
        return json({ error: denial(c.who.role, 'parish.acronym'), field: 'acronym', role: c.who.role }, 403);
      }
      const conflict = await acronymConflict(env.DB, b.acronym, id);
      if (conflict) return json({ error: conflict, field: 'acronym' }, 409);
    }
    const tzBad = timezoneProblem(b.timezone);
    if (tzBad) return json({ error: tzBad, field: 'timezone' }, 400);

    const sets = [], vals = [];
    for (const k of PARISH_EDITABLE) {
      if (b[k] !== undefined) { sets.push(`${k} = ?`); vals.push(b[k]); }
    }
    if (!sets.length) return json({ error: 'No valid fields to update' }, 400);

    // Who typed this, and when. Appended rather than offered as an editable
    // field: an audit line somebody can set is not an audit line.
    sets.push('updated_at = ?', 'updated_by = ?');
    vals.push(NOW(), await editor(c));

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

  // What deleting this parish would take with it.
  //
  // A GET, deliberately, rather than a `dry_run=1` on the DELETE. The delete
  // route removes a parish outright when nothing references it, so a dry run
  // expressed as a flag on that verb is one dropped query parameter away from
  // being the real thing. A GET that loses its parameters is still a GET.
  router.get('/api/admin/parishes/:id/deletion', guarded(async ({ env, params }) => {
    const parish = await env.DB.prepare('SELECT id, name FROM parishes WHERE id = ?')
      .bind(params.id).first();
    if (!parish) return json({ error: 'Parish not found' }, 404);
    const [{ n: events }, { n: schedules }] = await Promise.all([
      env.DB.prepare('SELECT COUNT(*) AS n FROM events WHERE parish_id = ?').bind(params.id).first(),
      env.DB.prepare('SELECT COUNT(*) AS n FROM schedules WHERE parish_id = ?').bind(params.id).first(),
    ]);
    return json({ id: parish.id, name: parish.name, event_count: events, schedule_count: schedules });
  }));

  router.delete('/api/admin/parishes/:id', guarded('parish.delete', async ({ env, params, query }) => {
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

  router.post('/api/admin/parishes/:id/schedule-proposals/accept', guarded('schedule.create', async (c) => {
    const { env, params, request } = c;
    const scoped = outOfScope(c, params.id);
    if (scoped) return scoped;
    if (!await env.DB.prepare('SELECT id FROM parishes WHERE id = ?').bind(params.id).first()) {
      return json({ error: 'Parish not found' }, 404);
    }
    const { rules } = await readJson(request);
    if (!Array.isArray(rules) || !rules.length) return json({ error: 'rules[] is required' }, 400);

    // Where these rules came from. An inferred rule IS a claim about the
    // future, exactly like an imported one, so it needs the same three columns
    // — otherwise the parish sheet shows a timetable with no provenance beside
    // the ones that have it, which reads as "nobody knows" rather than "a
    // calendar said so".
    //
    // The adapter is asked, not the events: an event's own source_url is a
    // deep link to ONE occurrence, and a rule inferred from dozens of them
    // would end up citing an arbitrary Sunday instead of the calendar that
    // says it happens every Sunday.
    //
    // `source_checked_at` is now, because accepting a proposal IS the read:
    // a person has just looked at what the source published and said yes.
    const adapter = ADAPTERS.find(a => a.parishId === params.id);
    const source = {
      name: adapter?.sourceName || null,
      ref: adapter?.sourceUrl || null,
    };
    const checkedAt = new Date().toISOString();

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
      if (dup) {
        // Already on file — but the person has just confirmed the source still
        // publishes it, which is precisely what this timestamp records. Leaving
        // it stale would make re-running the inference look like it did
        // nothing, when what it actually did was re-check.
        await env.DB.prepare(
          'UPDATE schedules SET source_name = ?, source_ref = ?, source_checked_at = ? WHERE id = ?'
        ).bind(source.name, source.ref, checkedAt, dup.id).run();
        skipped.push({ title: r.title, existing_schedule_id: dup.id, rechecked: true });
        continue;
      }

      const row = await env.DB.prepare(
        `INSERT INTO schedules (parish_id, day_of_week, start_time, end_time, title,
           event_type, week_of_month, languages,
           source_name, source_ref, source_checked_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING *`
      ).bind(
        params.id, r.day_of_week, r.start_time, r.end_time || null, r.title,
        r.event_type || 'liturgy', r.week_of_month || null, r.languages || null,
        source.name, source.ref, checkedAt,
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

  router.post('/api/admin/schedules', guarded('schedule.create', async (c) => {
    const { env, request } = c;
    const b = await readJson(request);
    const { parish_id, day_of_week, start_time, title } = b;
    if (!parish_id || day_of_week == null || !start_time || !title) {
      return json({ error: 'parish_id, day_of_week, start_time, and title are required' }, 400);
    }
    // Scoped on the parish being written TO, which for a create is the only
    // place the scope can be checked — there is no existing row to read it off.
    const scoped = outOfScope(c, parish_id);
    if (scoped) return scoped;
    if (b.week_of_month && b.week_of_month.split(',').some(w => !VALID_WEEKS.has(w.trim()))) {
      return json({ error: 'week_of_month values must be: first, second, third, fourth, last' }, 400);
    }
    if (!await env.DB.prepare('SELECT id FROM parishes WHERE id = ?').bind(parish_id).first()) {
      return json({ error: 'Invalid parish_id' }, 400);
    }
    const row = await env.DB.prepare(
      `INSERT INTO schedules (parish_id, day_of_week, start_time, end_time, title, event_type,
        languages, week_of_month, hide_live, parish_scoped, location_override)
       VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING *`
    ).bind(
      parish_id, day_of_week, start_time, b.end_time || null, title,
      b.event_type || 'liturgy', b.languages || null, b.week_of_month || null,
      b.hide_live ? 1 : 0, b.parish_scoped ? 1 : 0, b.location_override || null,
    ).first();
    return json(row, 201);
  }));

  // `source_*` joins the list. A recurrence rule is a claim about the FUTURE
  // that never expires on its own — "Sundays 9am" keeps projecting cards
  // forever, looking as current on the day the parish changes its times as it
  // did the day it was typed. schema.sql calls these three the only signal that
  // anybody has looked since, and until now the API refused them, so the field
  // the schema treats as load-bearing could not be filled in from anywhere.
  const SCHEDULE_EDITABLE = ['day_of_week', 'start_time', 'end_time', 'title', 'event_type',
    'active', 'languages', 'week_of_month', 'concurrent', 'hide_live', 'parish_scoped',
    'effective_from', 'effective_to', 'location_override',
    'source_name', 'source_ref', 'source_checked_at'];
  const BOOL_FIELDS = new Set(['active', 'concurrent', 'hide_live', 'parish_scoped']);

  router.patch('/api/admin/schedules/:id', guarded('schedule.edit', async (c) => {
    const { env, params, request } = c;
    const row = await env.DB.prepare('SELECT id, parish_id FROM schedules WHERE id = ?')
      .bind(params.id).first();
    if (!row) return json({ error: 'Schedule not found' }, 404);
    const scoped = outOfScope(c, row.parish_id);
    if (scoped) return scoped;
    const b = await readJson(request);
    const sets = [], vals = [];
    for (const k of SCHEDULE_EDITABLE) {
      if (b[k] !== undefined) {
        sets.push(`${k} = ?`);
        vals.push(BOOL_FIELDS.has(k) ? (b[k] ? 1 : 0) : b[k]);
      }
    }
    if (!sets.length) return json({ error: 'No valid fields to update' }, 400);
    sets.push('updated_at = ?', 'updated_by = ?');
    vals.push(NOW(), await editor(c));
    // v26: the edit shows up on the next read. No regeneration, no orphaned rows.
    await env.DB.prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`)
      .bind(...vals, params.id).run();
    return json(await env.DB.prepare('SELECT * FROM schedules WHERE id = ?').bind(params.id).first());
  }));

  router.delete('/api/admin/schedules/:id', guarded('schedule.delete', async (c) => {
    const { env, params } = c;
    const row = await env.DB.prepare('SELECT id, parish_id FROM schedules WHERE id = ?')
      .bind(params.id).first();
    if (!row) return json({ error: 'Schedule not found' }, 404);
    const scoped = outOfScope(c, row.parish_id);
    if (scoped) return scoped;
    // schedule_overrides cascade via FK.
    await env.DB.prepare('DELETE FROM schedules WHERE id = ?').bind(params.id).run();
    return json({ ok: true });
  }));

  // Every extension a logo has ever been stored under. A re-upload that
  // changes format writes a new key, so the old one has to go — otherwise
  // /logos/<id>.jpg lingers in R2 after the parish moved to PNG, paid for
  // and served to anyone who still holds the old path.
  const LOGO_EXTS = ['png', 'jpg', 'svg', 'webp'];
  const logoKeys = (id) => LOGO_EXTS.map(e => `logos/${id}.${e}`);

  // POST /api/admin/parishes/:id/logo — raw image body, stored in R2.
  //
  // The Express version wrote to /opt/agora/data/logos on the VM's disk. The
  // stored logo_path stays '/logos/<id>.<ext>', so nothing downstream changes.
  router.post('/api/admin/parishes/:id/logo', guarded('logo.edit', async (c) => {
    const { env, params, request } = c;
    const scoped = outOfScope(c, params.id);
    if (scoped) return scoped;
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
    const stale = logoKeys(id).filter(k => k !== key);
    if (stale.length) await env.ASSETS_BUCKET.delete(stale);

    // ?v= is a cache buster, not part of the R2 key. assets.mjs caches logos
    // for a day and a replacement usually overwrites the same key, so without
    // this an admin who changes a logo keeps seeing yesterday's for 24 hours
    // and so does everyone else. The router matches on pathname, so the query
    // never reaches the bucket — see registerAssetRoutes.
    const logoPath = `/${key}?v=${Date.now()}`;
    await env.DB.prepare('UPDATE parishes SET logo_path = ? WHERE id = ?').bind(logoPath, id).run();
    return json({ logo_path: logoPath });
  }));

  // DELETE /api/admin/parishes/:id/logo — back to the coloured initial.
  //
  // Clearing has to drop the objects as well as the column: a logo put up by
  // mistake (the wrong parish's crest, someone's face) should stop being
  // served, and nulling logo_path alone leaves it fetchable at a URL that is
  // guessable from the parish id.
  router.delete('/api/admin/parishes/:id/logo', guarded('logo.edit', async (c) => {
    const { env, params } = c;
    const scoped = outOfScope(c, params.id);
    if (scoped) return scoped;
    const id = params.id;
    if (!await env.DB.prepare('SELECT id FROM parishes WHERE id = ?').bind(id).first()) {
      return json({ error: 'Parish not found' }, 404);
    }
    // The column clears whether or not R2 is bound — a Worker without the
    // binding should still be able to take a wrong logo off the site.
    if (env.ASSETS_BUCKET) await env.ASSETS_BUCKET.delete(logoKeys(id));
    await env.DB.prepare('UPDATE parishes SET logo_path = NULL WHERE id = ?').bind(id).run();
    return json({ logo_path: null });
  }));

  // ── jurisdictions ──
  //
  // WHAT THIS ANSWERS. Six directories were scraped into D1 over four days and
  // then nothing watched them. Parishes move, close, build a website and change
  // their service times, and the only signal would be somebody noticing a wrong
  // card. `info_checked_at` and `source_checked_at` have recorded when we last
  // looked all along; nothing ever read them back, so "which of these is most
  // overdue" had no answer short of a SQL console.
  //
  // Everything here is computed from rows that already exist. It is useful
  // before any re-scrape has ever run, which is the point — the re-scrape is
  // the action this prompts, not the thing it reports.
  //
  // Owner-only: it names every jurisdiction, so it is not a parish contact's
  // screen, and it is the doorway to a job that rewrites a few hundred rows.
  router.get('/api/admin/jurisdictions', guarded('people.manage', async ({ env }) => {
    const now = Date.now();

    // Two grouped queries rather than one per jurisdiction. Both scan small
    // tables — 293 parishes and 97 rules — and the panel asks for all six at
    // once, so there is nothing to gain by splitting them.
    const [{ results: pRows = [] }, { results: sRows = [] }] = await Promise.all([
      env.DB.prepare(
        `SELECT jurisdiction,
                COUNT(*)                                                   AS parishes,
                SUM(CASE WHEN website IS NULL OR website = '' THEN 1 ELSE 0 END)   AS no_website,
                SUM(CASE WHEN address IS NULL OR address = '' THEN 1 ELSE 0 END)   AS no_address,
                SUM(CASE WHEN info_verified_at IS NOT NULL THEN 1 ELSE 0 END)      AS verified,
                MIN(info_checked_at)                                       AS oldest_check,
                MAX(info_checked_at)                                       AS newest_check
         FROM parishes WHERE id != '_unassigned' GROUP BY jurisdiction`
      ).all(),
      env.DB.prepare(
        `SELECT p.jurisdiction,
                COUNT(*)                                                   AS rules,
                COUNT(DISTINCT s.parish_id)                                AS parishes_with_rules,
                SUM(CASE WHEN s.active = 1 THEN 1 ELSE 0 END)              AS active_rules,
                SUM(CASE WHEN s.source_name IS NULL OR s.source_name = '' THEN 1 ELSE 0 END) AS no_source,
                MIN(s.source_checked_at)                                   AS oldest_check,
                MAX(s.source_checked_at)                                   AS newest_check
         FROM schedules s JOIN parishes p ON s.parish_id = p.id
         GROUP BY p.jurisdiction`
      ).all(),
    ]);

    // Which page a jurisdiction's rules actually cite. The distinction the
    // owner asked for: a rule citing the ARCHDIOCESE means one directory page
    // changing can move a whole jurisdiction's timetable, while a rule citing a
    // parish website has to be re-read one parish at a time.
    const { results: srcRows = [] } = await env.DB.prepare(
      `SELECT p.jurisdiction, s.source_name, COUNT(*) AS n
       FROM schedules s JOIN parishes p ON s.parish_id = p.id
       GROUP BY p.jurisdiction, s.source_name`
    ).all();

    const byJ = (rows) => new Map(rows.map(r => [r.jurisdiction, r]));
    const parishBy = byJ(pRows);
    const schedBy = byJ(sRows);

    return json(JURISDICTION_SOURCES.map(j => {
      const p = parishBy.get(j.slug) || {};
      const s = schedBy.get(j.slug) || {};
      const parishDays = daysSince(p.oldest_check, now);
      // The SCHEDULE staleness is measured from the OLDEST rule, not the
      // newest: one rule re-read yesterday says nothing about the sixty beside
      // it that nobody has looked at since September.
      const ruleDays = daysSince(s.oldest_check, now);

      const sources = srcRows
        .filter(r => r.jurisdiction === j.slug)
        .map(r => ({ name: r.source_name || null, count: r.n }))
        .sort((a, b) => b.count - a.count);

      const parishes = p.parishes || 0;
      return {
        slug: j.slug,
        label: j.label,
        directory: j.directory || null,
        notes: j.notes,
        automation: j.automation,
        automationNote: automationNote(j),
        rerunnable: isRerunnable(j),
        parishScripts: j.parishScripts,
        scheduleScripts: j.scheduleScripts,
        scheduleSource: j.scheduleSource || null,

        parishes: {
          total: parishes,
          noWebsite: p.no_website || 0,
          noAddress: p.no_address || 0,
          verified: p.verified || 0,
          lastChecked: p.oldest_check || null,
          daysSinceChecked: parishDays,
          staleness: staleness(parishDays),
        },
        rules: {
          total: s.rules || 0,
          active: s.active_rules || 0,
          // The ratio docs/parish-ingestion.md calls a finding rather than a
          // shortfall: 8 of 135 Greek parishes publish a service time anywhere.
          parishesWithRules: s.parishes_with_rules || 0,
          parishesWithoutRules: Math.max(0, parishes - (s.parishes_with_rules || 0)),
          // Rules typed by hand in /admin cite nothing, and a re-run must leave
          // them alone — a scrape has nothing to say about a claim it did not
          // make.
          noSource: s.no_source || 0,
          sources,
          lastChecked: s.oldest_check || null,
          daysSinceChecked: ruleDays,
          staleness: s.rules ? staleness(ruleDays) : null,
        },
      };
    }));
  }));

  // ── proposals ──
  //
  // A refusal that offers to carry the ask. An editor who needs a parish
  // deleted has nowhere to put that request except some other channel, where it
  // arrives without the context that produced it; this keeps the ask, the exact
  // change and the reason together, and lets the owner act on it in one press.
  //
  // Anybody with a role may propose. Only an owner may decide — which is the
  // same boundary the three capabilities already draw, expressed once more.
  router.get('/api/admin/proposals', guarded(async ({ env, query, ...c }) => {
    const status = query.get('status') || 'open';
    const r = await env.DB.prepare(
      `SELECT * FROM admin_proposals WHERE status = ? ORDER BY created_at DESC LIMIT 200`
    ).bind(status).all().catch(() => ({ results: [] }));

    const parishes = new Map(((await env.DB.prepare(
      "SELECT id, name FROM parishes").all().catch(() => ({ results: [] }))).results || [])
      .map(p => [p.id, p.name]));

    return json((r.results || []).map(row => {
      const payload = readPayload(row.payload);
      return {
        id: row.id,
        capability: row.capability,
        subject: row.subject,
        subjectName: parishes.get(row.subject) || row.subject,
        payload,
        // Null when the row is unreadable — the list still renders, and that
        // one proposal simply cannot be approved.
        summary: payload
          ? describeProposal(row.capability, payload, {
              subject: parishes.get(row.subject) || row.subject,
              transferTo: parishes.get(payload.transferTo) || payload.transferTo,
            })
          : null,
        reason: row.reason || null,
        status: row.status,
        proposedBy: row.proposed_by,
        createdAt: row.created_at,
        decidedBy: row.decided_by || null,
        decidedAt: row.decided_at || null,
        decisionNote: row.decision_note || null,
        // Whether the person reading this is the one who can act on it.
        mine: row.proposed_by === c.who.identity,
      };
    }));
  }));

  router.post('/api/admin/proposals', guarded(async (c) => {
    const { env, request } = c;
    const b = await readJson(request);

    // Proposing something you could simply do is a confusing dead end: the ask
    // would sit waiting for an owner to approve what the proposer could have
    // pressed themselves.
    if (can(c.who.role, b.capability)) {
      return json({
        error: `You can do that yourself — no need to propose it.`,
        capability: b.capability,
      }, 400);
    }
    const v = validateProposal(b);
    if (!v.ok) return json({ error: v.error }, 400);

    // A parish contact may only propose about their own parishes, for the same
    // reason they may only edit them.
    if (b.capability !== 'colors.edit') {
      const scoped = outOfScope(c, b.subject);
      if (scoped) return scoped;
    }

    const who = await editor(c);
    const row = await env.DB.prepare(
      `INSERT INTO admin_proposals (capability, subject, payload, reason, proposed_by)
       VALUES (?,?,?,?,?) RETURNING id`
    ).bind(b.capability, b.subject.trim(), JSON.stringify(v.payload),
           (b.reason || '').trim() || null, who).first();

    return json({ id: row.id, status: 'open' }, 201);
  }));

  // Withdraw your own. Not a decision — it is the proposer saying never mind,
  // and it needs no owner.
  router.post('/api/admin/proposals/:id/withdraw', guarded(async (c) => {
    const { env, params } = c;
    const row = await env.DB.prepare('SELECT * FROM admin_proposals WHERE id = ?')
      .bind(params.id).first();
    if (!row) return json({ error: 'Proposal not found' }, 404);
    if (!isOpen(row)) return json({ error: `That proposal is already ${row.status}.` }, 409);

    const who = await editor(c);
    if (row.proposed_by !== who && !can(c.who.role, 'people.manage')) {
      return json({ error: 'You can only withdraw your own proposals.' }, 403);
    }
    await env.DB.prepare(
      `UPDATE admin_proposals SET status='withdrawn', decided_by=?, decided_at=? WHERE id=?`
    ).bind(who, NOW(), params.id).run();
    return json({ id: Number(params.id), status: 'withdrawn' });
  }));

  router.post('/api/admin/proposals/:id/decide', guarded('people.manage', async (c) => {
    const { env, params, request } = c;
    const b = await readJson(request);
    const approve = b.decision === 'approve';
    if (!approve && b.decision !== 'decline') {
      return json({ error: "decision must be 'approve' or 'decline'." }, 400);
    }

    const row = await env.DB.prepare('SELECT * FROM admin_proposals WHERE id = ?')
      .bind(params.id).first();
    if (!row) return json({ error: 'Proposal not found' }, 404);
    if (!isOpen(row)) return json({ error: `That proposal is already ${row.status}.` }, 409);

    const who = await editor(c);
    const close = async (status, note) => {
      await env.DB.prepare(
        `UPDATE admin_proposals SET status=?, decided_by=?, decided_at=?, decision_note=? WHERE id=?`
      ).bind(status, who, NOW(), (note || '').trim() || null, params.id).run();
    };

    if (!approve) {
      await close('declined', b.note);
      return json({ id: Number(params.id), status: 'declined' });
    }

    // ── approving ──
    //
    // RE-VALIDATE EVERYTHING. This row may have been sitting for a week: the
    // parish could have been renamed, deleted, or given the very acronym being
    // asked for, and the transfer target could be gone. Trusting a stored
    // payload is how an approval quietly does something nobody asked for.
    const payload = readPayload(row.payload);
    if (!payload) return json({ error: 'This proposal is unreadable and cannot be approved.' }, 422);

    const applied = await applyProposal(env, row, payload, who);
    if (applied.error) return json({ error: applied.error }, applied.status || 409);

    await close('approved', b.note);
    return json({ id: Number(params.id), status: 'approved', ...applied });
  }));

  /** Carry out an approved proposal, re-checking the world as it is now. */
  async function applyProposal(env, row, payload, who) {
    const now = NOW();

    if (row.capability === 'colors.edit') {
      if (!HEX.test(payload.color)) return { error: 'That is no longer a valid colour.' };
      if (!JURISDICTIONS.has(row.subject)) return { error: `${row.subject} is not a jurisdiction.` };
      await env.DB.prepare(
        `INSERT INTO jurisdiction_colors (jurisdiction, color) VALUES (?,?)
         ON CONFLICT(jurisdiction) DO UPDATE SET color = excluded.color,
           updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`
      ).bind(row.subject, payload.color).run();
      return { applied: 'colour changed' };
    }

    const parish = await env.DB.prepare('SELECT id, name FROM parishes WHERE id = ?')
      .bind(row.subject).first();
    if (!parish) return { error: 'That parish no longer exists.', status: 410 };

    if (row.capability === 'parish.acronym') {
      // The clash check deliberately happens HERE and not when the proposal was
      // made: another parish may have taken that acronym in the meantime, and
      // the reserved-slug list can change with a deploy.
      const conflict = await acronymConflict(env.DB, payload.acronym, row.subject);
      if (conflict) return { error: `Cannot approve: ${conflict}` };
      await env.DB.prepare(
        'UPDATE parishes SET acronym = ?, updated_at = ?, updated_by = ? WHERE id = ?'
      ).bind(payload.acronym || null, now, who, row.subject).run();
      return { applied: 'acronym changed' };
    }

    // parish.delete
    const { n: eventCount } = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM events WHERE parish_id = ?').bind(row.subject).first();
    const stmts = [];
    if (payload.disposition === 'transfer') {
      const target = await env.DB.prepare('SELECT id FROM parishes WHERE id = ?')
        .bind(payload.transferTo).first();
      if (!target) return { error: 'The parish those events were to move to no longer exists.' };
      stmts.push(env.DB.prepare('UPDATE events SET parish_id = ? WHERE parish_id = ?')
        .bind(payload.transferTo, row.subject));
      stmts.push(env.DB.prepare('UPDATE schedules SET parish_id = ? WHERE parish_id = ?')
        .bind(payload.transferTo, row.subject));
    } else {
      stmts.push(env.DB.prepare('DELETE FROM events WHERE parish_id = ?').bind(row.subject));
    }
    stmts.push(env.DB.prepare('DELETE FROM schedules WHERE parish_id = ?').bind(row.subject));
    stmts.push(env.DB.prepare('DELETE FROM parishes WHERE id = ?').bind(row.subject));
    await env.DB.batch(stmts);
    return { applied: 'parish deleted', events: eventCount };
  }

  // ── overrides ──
  //
  // WHAT THIS EXISTS FOR. Every exception to the rhythm is a row in
  // schedule_overrides — this Sunday cancelled, moved to 10am, combined with the
  // cathedral — and nothing anywhere listed them. There was no way to answer
  // "what have we cancelled", no way to find a tombstone set by mistake, and no
  // way to see what the machine decided on its own: applyTombstones writes
  // cancellations from ABSENCE, which is the most consequential thing in this
  // codebase that happens without anybody pressing a button.
  //
  // `source` is what tells those apart. A human edit writes 'human'; a scrape
  // writes the adapter's own id. Both are shown, because a person looking for a
  // wrong cancellation does not know in advance which kind it is.
  router.get('/api/admin/overrides', guarded(async ({ env, query, ...c }) => {
    // Default to a window around now rather than the whole table: the useful
    // question is almost always "what is in force", and a cancellation from
    // 2024 is history rather than something to act on.
    const from = query.get('from') || new Date(Date.now() - 14 * 86400000).toISOString().slice(0, 10);
    const to = query.get('to') || new Date(Date.now() + 120 * 86400000).toISOString().slice(0, 10);

    const r = await env.DB.prepare(
      `SELECT o.*, s.title AS schedule_title, s.start_time, s.day_of_week,
              s.parish_id, p.name AS parish_name, p.timezone
       FROM schedule_overrides o
       JOIN schedules s ON o.schedule_id = s.id
       JOIN parishes p ON s.parish_id = p.id
       WHERE o.occurrence_date BETWEEN ? AND ?
       ORDER BY o.occurrence_date, s.start_time`
    ).bind(from, to).all();

    const rows = (r.results || [])
      // A parish contact sees their own parishes here too, for the same reason
      // the other lists are scoped: it is their parish's exceptions they are
      // responsible for.
      .filter(row => mayTouchParish(c.who, row.parish_id))
      .map(row => ({
        id: row.id,
        scheduleId: row.schedule_id,
        // The synthetic id the public site addresses an occurrence by, so the
        // panel can link straight at the card rather than describing where it is.
        instanceId: `${row.schedule_id}:${row.occurrence_date}`,
        date: row.occurrence_date,
        kind: row.kind,
        note: row.note || null,
        // 'human', or the adapter id that wrote it. The distinction is the
        // whole point of the list.
        source: row.source,
        byMachine: row.source !== 'human',
        updatedBy: row.updated_by || null,
        updatedAt: row.updated_at || null,
        createdAt: row.created_at,
        parishId: row.parish_id,
        parishName: row.parish_name,
        title: row.schedule_title,
        startTime: row.start_time,
        // Only the patches that actually say something, so the panel can render
        // "10:00 instead of 09:00" without inspecting fourteen null columns.
        patch: Object.fromEntries(Object.entries({
          title: row.patch_title,
          start_time: row.patch_start_time,
          end_time: row.patch_end_time,
          event_type: row.patch_event_type,
          languages: row.patch_languages,
          feast: row.patch_feast,
          description: row.patch_description,
          location_override: row.patch_location_override,
        }).filter(([, v]) => v != null && v !== '')),
        combinedIntoEventId: row.combined_into_event_id || null,
      }));

    return json({ from, to, overrides: rows });
  }));

  // Undo one.
  //
  // Deleting the row IS the undo: the lens projects from rules, so removing an
  // exception restores whatever the rule always said. Nothing to regenerate.
  router.delete('/api/admin/overrides/:id', guarded('override.edit', async (c) => {
    const { env, params } = c;
    const row = await env.DB.prepare(
      `SELECT o.id, s.parish_id FROM schedule_overrides o
       JOIN schedules s ON o.schedule_id = s.id WHERE o.id = ?`
    ).bind(params.id).first();
    if (!row) return json({ error: 'Override not found' }, 404);
    const scoped = outOfScope(c, row.parish_id);
    if (scoped) return scoped;

    await env.DB.prepare('DELETE FROM schedule_overrides WHERE id = ?').bind(params.id).run();
    return json({ id: Number(params.id), removed: true });
  }));

  // ── adapters ──

  // `pending` is why the panel can say "this cannot run" before you click Run,
  // instead of letting you discover it from a failed run's error message.
  router.get('/api/admin/adapters', guarded(async ({ env }) => {
    const pacing = await adapterPacing(env.DB);
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);
    const overrides = await pdfSourceOverrides(env.DB);

    // The last run of ANY status, which is not what pacing tracks — pacing
    // measures from the last SUCCESS so a broken adapter retries soon. Here the
    // question is different: is the file in R2 newer than our last attempt to
    // read it, whatever that attempt did?
    const { results: lastRuns = [] } = await env.DB.prepare(
      `SELECT adapter_id, MAX(started_at) AS last_run FROM adapter_runs GROUP BY adapter_id`
    ).all();
    const lastRunById = new Map(lastRuns.map(r => [r.adapter_id, r.last_run]));

    // One R2 read per PDF adapter, in parallel. These are admin-only requests
    // over a handful of small objects; pdfSourceStatus never throws, so a bad
    // object costs one card its detail rather than the whole list.
    const sources = new Map(await Promise.all(
      ADAPTERS.filter(a => a.sourceType === 'parish-pdf').map(async (a) => {
        // The EFFECTIVE source: the file's URL, or whatever /admin changed it
        // to. applyOverride returns a copy — PDF_SOURCES is module state shared
        // across every request in the isolate and must not be written to.
        const resolved = applyOverride(a.source, overrides);
        const status = await pdfSourceStatus(env.ASSETS_BUCKET, resolved, today);
        return [a.id, {
          ...status,
          sourceKey: a.source.key,
          // What the next fetch will ask for, which is not necessarily what
          // the last one did — the extracted document reports that separately.
          willFetch: resolved.sourceUrl,
          overridden: resolved.overridden,
          overrideUpdatedAt: resolved.overrideUpdatedAt || null,
          overrideUpdatedBy: resolved.overrideUpdatedBy || null,
          // The file's own value, so a reset has something to say.
          fileUrl: a.source.sourceUrl,
          followsIndex: !!a.source.indexUrl,
        }];
      })
    ));

    return json(ADAPTERS.map(a => {
      const setting = pacing.setting(a.id);
      const source = sources.get(a.id) || null;
      return {
        id: a.id, parishId: a.parishId, sourceType: a.sourceType, schedule: a.schedule,
        pending: PENDING_PARISHES.get(a.id) || null,
        // No row means enabled at the default. Absence should never be the
        // thing that stops a scrape happening.
        enabled: setting ? setting.enabled === 1 : true,
        intervalMinutes: setting?.interval_minutes ?? DEFAULT_INTERVAL_MINUTES,
        next: isDue(setting, pacing.lastSuccess(a.id), now).why,
        // What the parish's FILE says, as opposed to what our last read of it
        // said. Null for an adapter that does not read a file.
        source,
        // The Blacktown case: a card reporting a failure that a later
        // extraction has already overtaken. Computed here rather than in the
        // browser so the comparison lives with its test.
        sourceNewerThanRun: source?.present
          ? fileIsNewerThanRun(source.fetchedAt, lastRunById.get(a.id))
          : false,
      };
    }));
  }));

  // ── a PDF parish's source URL ──
  //
  // The one thing about a PDF source that /admin may change. Same contract as
  // the jurisdiction colours: absence means the file's value, a PUT writes an
  // override, a DELETE removes it and the file's URL comes back. Changing this
  // takes effect on the next extraction, not the next adapter run, because it
  // is the Action that does the fetching.
  router.put('/api/admin/pdf-sources/:key', guarded('adapter.source', async (c) => {
    const { env, params, request } = c;
    const adapter = ADAPTERS.find(a => a.source?.key === params.key);
    if (!adapter) return json({ error: 'No PDF source with that key' }, 404);

    const b = await readJson(request);
    const url = typeof b.source_url === 'string' ? b.source_url.trim() : '';
    if (!isHttpUrl(url)) {
      return json({ error: 'source_url must be an http or https URL.', field: 'source_url' }, 400);
    }

    // Setting it back to what the file already says is a reset, not an
    // override. Otherwise the row would sit there claiming somebody changed
    // something, and a later edit to pdf-sources.mjs would be silently ignored
    // in favour of a row that agrees with its old value.
    if (url === adapter.source.sourceUrl) {
      await env.DB.prepare('DELETE FROM pdf_source_overrides WHERE source_key = ?')
        .bind(params.key).run();
      return json({ key: params.key, source_url: url, overridden: false });
    }

    const who = await adminIdentity(c);
    await env.DB.prepare(
      `INSERT INTO pdf_source_overrides (source_key, source_url, updated_by)
       VALUES (?,?,?)
       ON CONFLICT(source_key) DO UPDATE SET
         source_url = excluded.source_url,
         updated_by = excluded.updated_by,
         updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')`
    ).bind(params.key, url, who).run();

    return json({ key: params.key, source_url: url, overridden: true, updated_by: who });
  }));

  router.delete('/api/admin/pdf-sources/:key', guarded('adapter.source', async ({ env, params }) => {
    const adapter = ADAPTERS.find(a => a.source?.key === params.key);
    if (!adapter) return json({ error: 'No PDF source with that key' }, 404);
    await env.DB.prepare('DELETE FROM pdf_source_overrides WHERE source_key = ?')
      .bind(params.key).run();
    return json({ key: params.key, source_url: adapter.source.sourceUrl, overridden: false });
  }));

  // The state of the extraction workflow itself — the half of a PDF parish's
  // pipeline that /admin could not see at all. Separate from the adapter list
  // because it is one call to GitHub for every PDF adapter rather than one
  // each, and because a card should still render when GitHub is unreachable.
  router.get('/api/admin/pdf-workflow', guarded(async ({ env }) =>
    json(await recentExtractionRuns(env))));

  // Go and look at the parish's website again.
  //
  // THE DISTINCTION THIS ENDPOINT EXISTS FOR. `/run` re-reads an R2 object; it
  // cannot make that object newer, because only the Action writes it. So a card
  // warning "out of dates" had exactly one button and it was the wrong one.
  // This is the right one.
  router.post('/api/admin/adapters/:id/refresh-source', guarded('adapter.run', async ({ env, params }) => {
    const adapter = getAdapter(params.id);
    if (!adapter) return json({ error: 'Adapter not found' }, 404);
    if (adapter.sourceType !== 'parish-pdf' || !adapter.source?.key) {
      return json({
        error: 'This adapter reads its source directly, so there is nothing to re-fetch. Use Run now.',
      }, 400);
    }

    const r = await dispatchExtraction(env, adapter.source.key);
    if (r.started) return json({ started: true, dispatchUrl: r.dispatchUrl }, 202);

    // 501 when the deployment simply has no token: that is a configuration
    // gap, not a bad request, and the panel turns it into a link rather than
    // an error. A genuine refusal from GitHub is a 502 — we asked and were
    // turned down.
    return json({ error: r.error, configured: r.configured, dispatchUrl: r.dispatchUrl },
      r.configured ? 502 : 501);
  }));

  // Pacing lives in the database because a Cron Trigger cannot be changed by
  // the Worker that it fires. wrangler.toml ticks hourly; this decides what an
  // hour is allowed to do.
  const MIN_INTERVAL = 60;      // the heartbeat — asking for less has no effect
  const MAX_INTERVAL = 20160;   // a fortnight; past that, the adapter is off

  router.patch('/api/admin/adapters/:id/settings', guarded('adapter.pace', async ({ env, params, request }) => {
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

  router.post('/api/admin/adapters/:id/run', guarded('adapter.run', async ({ env, params }) => {
    const adapter = getAdapter(params.id);
    if (!adapter) return json({ error: 'Adapter not found' }, 404);
    try {
      return json({ status: 'success', ...(await runAdapter(adapter, env)) });
    } catch (err) {
      return json({ status: 'failed', error: err.message }, 500);
    }
  }));
}
