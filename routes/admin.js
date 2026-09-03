const { Router } = require('express');
const { getDb, syncEventCoordsForParish } = require('../db');
const { geocode } = require('../geocode');
const { parseInstanceId, expandWindow, expandOne } = require('../schedule-expand');
const { applyAdminEdit, hideInstance, setCombined, clearCombined } = require('../schedule-overrides');
const path = require('path');
const fs = require('fs');

const router = Router();

// Auth is handled by Caddy forward_auth to keycard — only Tailnet users reach /api/admin/*
// Do NOT add Express-level auth middleware here; it would block the keycard flow.

// GET /api/admin/ping — lightweight check for admin access
router.get('/ping', (req, res) => res.json({ ok: true }));

// GET /api/admin/events/candidates — events on a Sydney local date for escalation picker
// date param is YYYY-MM-DD in Sydney local time (not UTC).
// Sydney is UTC+10 (AEST) or UTC+11 (AEDT). A UTC range of [prev-day 13:00, day 14:00]
// covers the full 24h local day regardless of DST.
router.get('/events/candidates', (req, res) => {
  const db = getDb();
  const { date, exclude_id } = req.query;
  if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD)' });
  const [y, m, d] = date.split('-').map(Number);
  const utcFrom = new Date(Date.UTC(y, m - 1, d - 1, 13, 0, 0)).toISOString();
  const utcTo   = new Date(Date.UTC(y, m - 1, d,     14, 0, 0)).toISOString();
  // One-off events on the day…
  const oneOffs = db.prepare(`
    SELECT e.id, e.title, e.start_utc, e.end_utc, e.parish_id, p.name as parish_name, e.mutation_type, e.status, e.event_type
    FROM events e
    JOIN parishes p ON e.parish_id = p.id
    WHERE e.source_adapter != 'schedule'
      AND e.start_utc >= ? AND e.start_utc < ?
      AND e.status NOT IN ('replaced', 'rejected', 'cancelled', 'hidden')
      AND e.id != COALESCE(?, -1)
    ORDER BY e.start_utc
  `).all(utcFrom, utcTo, exclude_id && /^\d+$/.test(String(exclude_id)) ? Number(exclude_id) : null);
  // …plus schedule instances on the day (synthetic ids), excluding tombstones/hidden.
  const instances = expandWindow(db, utcFrom, utcTo)
    .filter(e => e.id !== exclude_id && e.status === 'approved')
    .map(e => ({ id: e.id, title: e.title, start_utc: e.start_utc, end_utc: e.end_utc,
      parish_id: e.parish_id, parish_name: e.parish_name, mutation_type: e.mutation_type,
      status: e.status, event_type: e.event_type }));
  const events = [...oneOffs, ...instances].sort((a, b) => new Date(a.start_utc) - new Date(b.start_utc));
  res.json(events);
});

// PATCH /api/admin/events/:id — update event fields (status, title, description, times, parish, type)
router.patch('/events/:id', (req, res) => {
  const db = getDb();

  // Schedule instance (synthetic id "scheduleId:YYYY-MM-DD") -> write an override
  // instead of mutating a stored row. See docs/schedule-overrides-v26.md.
  const inst = parseInstanceId(req.params.id);
  if (inst) {
    const result = applyAdminEdit(db, inst.scheduleId, inst.date, req.body);
    if (result.error) return res.status(result.code || 400).json({ error: result.error });
    return res.json(result.instance);
  }

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const { status, parish_id, title, description, start_utc, end_utc, event_type, languages, location_override, hide_live, parish_scoped } = req.body;

  if (status && !['approved', 'rejected', 'pending_review', 'cancelled', 'hidden'].includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }

  const updates = [];
  const values = [];

  if (status) { updates.push('status = ?'); values.push(status); }
  if (title) { updates.push('title = ?'); values.push(title); }
  if (description !== undefined) { updates.push('description = ?'); values.push(description || null); }
  if (start_utc) { updates.push('start_utc = ?'); values.push(start_utc); }
  if (end_utc !== undefined) { updates.push('end_utc = ?'); values.push(end_utc || null); }
  if (event_type) { updates.push('event_type = ?'); values.push(event_type); }
  if (languages !== undefined) { updates.push('languages = ?'); values.push(languages || null); }
  if (location_override !== undefined) { updates.push('location_override = ?'); values.push(location_override || null); }
  if (hide_live !== undefined) { updates.push('hide_live = ?'); values.push(hide_live ? 1 : 0); }
  if (parish_scoped !== undefined) { updates.push('parish_scoped = ?'); values.push(parish_scoped ? 1 : 0); }

  // If admin edits display fields of a schedule-generated event, promote to 'adapted'
  // so the nightly generator no longer overwrites these fields
  const displayFieldEdited = title !== undefined || description !== undefined ||
    start_utc !== undefined || end_utc !== undefined ||
    event_type !== undefined || languages !== undefined;
  if (displayFieldEdited && event.source_adapter === 'schedule' && event.mutation_type === 'scheduled') {
    updates.push('mutation_type = ?');
    values.push('adapted');
  }

  if (parish_id && parish_id !== event.parish_id) {
    const parish = db.prepare('SELECT id, lat, lng FROM parishes WHERE id = ?').get(parish_id);
    if (!parish) return res.status(400).json({ error: 'Invalid parish_id' });
    updates.push('parish_id = ?', 'lat = ?', 'lng = ?');
    values.push(parish_id, parish.lat, parish.lng);
  }

  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')");
  values.push(req.params.id);
  db.prepare(`UPDATE events SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  // Auto-geocode if location_override changed
  if (location_override) {
    geocode(location_override).then(coords => {
      if (coords) {
        db.prepare('UPDATE events SET lat = ?, lng = ? WHERE id = ?').run(coords.lat, coords.lng, req.params.id);
        console.log(`[admin] Geocoded event ${req.params.id}: ${coords.lat}, ${coords.lng}`);
      }
    });
  } else if (location_override === '') {
    // Cleared override — reset to parish coords
    const parish = db.prepare('SELECT lat, lng FROM parishes WHERE id = ?').get(event.parish_id);
    if (parish) {
      db.prepare('UPDATE events SET lat = ?, lng = ? WHERE id = ?').run(parish.lat, parish.lng, req.params.id);
    }
  }

  const updated = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// DELETE /api/admin/events/:id — permanently remove an event
router.delete('/events/:id', (req, res) => {
  const db = getDb();

  // Schedule instance -> suppress with a 'hidden' override (the rule lives on).
  const inst = parseInstanceId(req.params.id);
  if (inst) {
    const result = hideInstance(db, inst.scheduleId, inst.date);
    if (result.error) return res.status(result.code || 400).json({ error: result.error });
    return res.json({ ok: true });
  }

  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });
  db.prepare('DELETE FROM events WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/admin/events/:id/escalation — current escalation state for an event
router.get('/events/:id/escalation', (req, res) => {
  const db = getDb();
  const additive_parish_ids = db.prepare(
    'SELECT parish_id FROM event_parishes WHERE event_id = ?'
  ).all(req.params.id).map(r => r.parish_id);
  // Legacy one-off bases (event_replaces) …
  const replaced_events = db.prepare(`
    SELECT e.id, e.title, e.parish_id, p.name as parish_name, e.start_utc, e.end_utc
    FROM event_replaces er
    JOIN events e ON e.id = er.replaced_event_id
    JOIN parishes p ON p.id = e.parish_id
    WHERE er.replacing_event_id = ?
  `).all(req.params.id);
  // …plus schedule instances combined into this event (v26 override model).
  const combinedRows = db.prepare(
    "SELECT schedule_id, occurrence_date FROM schedule_overrides WHERE combined_into_event_id = ? AND kind = 'combined'"
  ).all(req.params.id);
  for (const r of combinedRows) {
    const inst = expandOne(db, r.schedule_id, r.occurrence_date);
    if (inst) replaced_events.push({ id: inst.id, title: inst.title, parish_id: inst.parish_id,
      parish_name: inst.parish_name, start_utc: inst.start_utc, end_utc: inst.end_utc });
  }
  res.json({ additive_parish_ids, replaced_events });
});

// POST /api/admin/events/:id/escalate — set desired escalation state (idempotent)
// Body: { additive_parish_ids: string[], replaced_event_ids: number[], approve: boolean }
router.post('/events/:id/escalate', (req, res) => {
  const db = getDb();
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const { additive_parish_ids = [], replaced_event_ids = [], approve = false } = req.body;

  const tx = db.transaction(() => {
    if (approve) {
      db.prepare(`UPDATE events SET status = 'approved', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`).run(event.id);
    }

    const currentParishes = db.prepare('SELECT parish_id FROM event_parishes WHERE event_id = ?').all(event.id).map(r => r.parish_id);
    const currentReplaces = db.prepare('SELECT replaced_event_id FROM event_replaces WHERE replacing_event_id = ?').all(event.id).map(r => r.replaced_event_id);

    const targetParishes = new Set(additive_parish_ids.filter(pid => typeof pid === 'string' && pid !== event.parish_id));
    // Replaced/combined targets: one-off integer ids (legacy event_replaces) or
    // schedule-instance synthetic ids "sid:date" (v26 combined overrides).
    const synthTargets = new Set();
    const intTargets = new Set();
    for (const rid of replaced_event_ids) {
      if (parseInstanceId(rid)) synthTargets.add(String(rid));
      else if (/^\d+$/.test(String(rid))) intTargets.add(Number(rid));
    }
    const currentParishSet = new Set(currentParishes);
    const currentReplaceSet = new Set(currentReplaces);
    const currentCombinedSet = new Set(db.prepare(
      "SELECT schedule_id, occurrence_date FROM schedule_overrides WHERE combined_into_event_id = ? AND kind = 'combined'"
    ).all(event.id).map(r => `${r.schedule_id}:${r.occurrence_date}`));

    for (const pid of targetParishes) {
      if (!currentParishSet.has(pid))
        db.prepare('INSERT OR IGNORE INTO event_parishes (event_id, parish_id) VALUES (?, ?)').run(event.id, pid);
    }
    for (const pid of currentParishes) {
      if (!targetParishes.has(pid))
        db.prepare('DELETE FROM event_parishes WHERE event_id = ? AND parish_id = ?').run(event.id, pid);
    }

    // Integer one-off bases -> legacy event_replaces (status flip).
    for (const rid of intTargets) {
      if (!currentReplaceSet.has(rid)) {
        db.prepare('INSERT OR IGNORE INTO event_replaces (replacing_event_id, replaced_event_id) VALUES (?, ?)').run(event.id, rid);
        db.prepare(`UPDATE events SET status = 'replaced', mutation_type = 'replaced', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`).run(rid);
      }
    }
    for (const rid of currentReplaces) {
      if (!intTargets.has(rid)) {
        db.prepare('DELETE FROM event_replaces WHERE replacing_event_id = ? AND replaced_event_id = ?').run(event.id, rid);
        // Restore status; infer mutation_type from schedule linkage
        db.prepare(`
          UPDATE events
          SET status = 'approved',
              mutation_type = CASE WHEN schedule_id IS NOT NULL THEN 'scheduled' ELSE 'headless' END,
              updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE id = ? AND mutation_type = 'replaced'
        `).run(rid);
      }
    }
    // Schedule instances -> v26 combined overrides.
    for (const sid of synthTargets) {
      if (!currentCombinedSet.has(sid)) { const p = parseInstanceId(sid); setCombined(db, p.scheduleId, p.date, event.id); }
    }
    for (const sid of currentCombinedSet) {
      if (!synthTargets.has(sid)) { const p = parseInstanceId(sid); clearCombined(db, p.scheduleId, p.date); }
    }
  });
  tx();

  const addedP = additive_parish_ids.length, addedR = replaced_event_ids.length;
  console.log(`[admin] Event ${event.id} escalation set: ${addedP} parishes, ${addedR} replacements${approve ? ', approved' : ''}`);
  const updated = db.prepare('SELECT * FROM events WHERE id = ?').get(event.id);
  const additional_parishes = db.prepare('SELECT parish_id FROM event_parishes WHERE event_id = ?').all(event.id).map(r => r.parish_id);
  const replaces = db.prepare('SELECT replaced_event_id FROM event_replaces WHERE replacing_event_id = ?').all(event.id).map(r => r.replaced_event_id);
  res.json({ ...updated, additional_parishes, replaces });
});

// POST /api/admin/parishes — create a new parish
router.post('/parishes', (req, res) => {
  const db = getDb();
  const { name, full_name, jurisdiction, address, lat, lng, website, email, phone, languages, live_url, donation_url, raffle_url, payment_url, gala_url } = req.body;

  if (!name || !jurisdiction || lat == null || lng == null) {
    return res.status(400).json({ error: 'name, jurisdiction, lat, and lng are required' });
  }

  const id = jurisdiction + '-' + name.toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const existing = db.prepare('SELECT id FROM parishes WHERE id = ?').get(id);
  if (existing) return res.status(409).json({ error: 'Parish already exists', id });

  db.prepare(`
    INSERT INTO parishes (id, name, full_name, jurisdiction, address, lat, lng, website, email, phone, languages, live_url, donation_url, raffle_url, payment_url, gala_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, full_name || null, jurisdiction, address || null, lat, lng, website || null, email || null, phone || null, languages || '["English"]', live_url || null, donation_url || null, raffle_url || null, payment_url || null, gala_url || null);

  // Seed a generic inactive schedule so the parish appears in the schedules list
  db.prepare(`
    INSERT INTO schedules (parish_id, day_of_week, start_time, title, event_type, active)
    VALUES (?, 0, '09:00', 'Divine Liturgy', 'liturgy', 0)
  `).run(id);

  const parish = db.prepare('SELECT * FROM parishes WHERE id = ?').get(id);
  res.status(201).json(parish);
});

// PATCH /api/admin/parishes/:id — update parish fields
router.patch('/parishes/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  if (id === '_unassigned') return res.status(400).json({ error: 'Cannot edit sentinel parish' });

  const parish = db.prepare('SELECT * FROM parishes WHERE id = ?').get(id);
  if (!parish) return res.status(404).json({ error: 'Parish not found' });

  const allowed = ['name', 'full_name', 'jurisdiction', 'address', 'website', 'email', 'phone', 'acronym', 'chant_style', 'languages', 'lat', 'lng', 'color', 'live_url', 'donation_url', 'raffle_url', 'payment_url', 'gala_url'];
  const updates = [];
  const values = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(req.body[key]);
    }
  }

  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

  values.push(id);
  db.prepare(`UPDATE parishes SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  // If lat/lng were updated directly, resync dependent events immediately.
  if (req.body.lat !== undefined || req.body.lng !== undefined) {
    syncEventCoordsForParish(db, id);
  }

  // Auto-geocode if address changed and lat/lng weren't explicitly provided
  if (req.body.address && req.body.lat === undefined) {
    geocode(req.body.address).then(coords => {
      if (coords) {
        db.prepare('UPDATE parishes SET lat = ?, lng = ? WHERE id = ?').run(coords.lat, coords.lng, id);
        syncEventCoordsForParish(db, id);
        console.log(`[admin] Geocoded parish ${id}: ${coords.lat}, ${coords.lng}`);
      }
    });
  }

  const updated = db.prepare('SELECT * FROM parishes WHERE id = ?').get(id);
  res.json(updated);
});

// DELETE /api/admin/parishes/:id — remove a parish
// Query params: ?transfer_to=<parish_id> to move events, or ?delete_events=1 to delete them
router.delete('/parishes/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const transferTo = req.query.transfer_to;
  const deleteEvents = req.query.delete_events === '1';

  if (id === '_unassigned') return res.status(400).json({ error: 'Cannot delete sentinel parish' });

  const parish = db.prepare('SELECT id FROM parishes WHERE id = ?').get(id);
  if (!parish) return res.status(404).json({ error: 'Parish not found' });

  const eventCount = db.prepare('SELECT COUNT(*) as n FROM events WHERE parish_id = ?').get(id).n;
  if (eventCount > 0 && !transferTo && !deleteEvents) {
    return res.status(400).json({ error: `${eventCount} events reference this parish`, event_count: eventCount });
  }

  if (transferTo) {
    const target = db.prepare('SELECT id FROM parishes WHERE id = ?').get(transferTo);
    if (!target) return res.status(400).json({ error: 'Transfer target parish not found' });
    db.prepare('UPDATE events SET parish_id = ? WHERE parish_id = ?').run(transferTo, id);
    db.prepare('UPDATE schedules SET parish_id = ? WHERE parish_id = ?').run(transferTo, id);
  } else if (deleteEvents) {
    db.prepare('DELETE FROM events WHERE parish_id = ?').run(id);
  }

  db.prepare('DELETE FROM schedules WHERE parish_id = ?').run(id);
  db.prepare('DELETE FROM parishes WHERE id = ?').run(id);
  res.json({ ok: true });
});

// --- Schedule CRUD ---

// GET /api/admin/schedules — list all schedules
router.get('/schedules', (req, res) => {
  const db = getDb();
  const schedules = db.prepare(`
    SELECT s.*, p.name as parish_name, p.jurisdiction as parish_jurisdiction
    FROM schedules s
    JOIN parishes p ON s.parish_id = p.id
    ORDER BY s.parish_id, s.day_of_week, s.start_time
  `).all();
  res.json(schedules);
});

// POST /api/admin/schedules — create a schedule
router.post('/schedules', (req, res) => {
  const db = getDb();
  const { parish_id, day_of_week, start_time, end_time, title, event_type, languages, week_of_month, hide_live, parish_scoped } = req.body;

  if (!parish_id || day_of_week == null || !start_time || !title) {
    return res.status(400).json({ error: 'parish_id, day_of_week, start_time, and title are required' });
  }

  const VALID_WEEKS = new Set(['first', 'second', 'third', 'fourth', 'last']);
  if (week_of_month) {
    const parts = week_of_month.split(',').map(s => s.trim());
    if (parts.some(p => !VALID_WEEKS.has(p))) {
      return res.status(400).json({ error: 'week_of_month values must be: first, second, third, fourth, last' });
    }
  }

  const parish = db.prepare('SELECT id FROM parishes WHERE id = ?').get(parish_id);
  if (!parish) return res.status(400).json({ error: 'Invalid parish_id' });

  const result = db.prepare(`
    INSERT INTO schedules (parish_id, day_of_week, start_time, end_time, title, event_type, languages, week_of_month, hide_live, parish_scoped)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(parish_id, day_of_week, start_time, end_time || null, title, event_type || 'liturgy', languages || null, week_of_month || null, hide_live ? 1 : 0, parish_scoped ? 1 : 0);

  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(result.lastInsertRowid);
  // v26: no generation — instances are computed on read by schedule-expand.js.
  res.status(201).json(schedule);
});

// PATCH /api/admin/schedules/:id — update a schedule
router.patch('/schedules/:id', (req, res) => {
  const db = getDb();
  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

  const allowed = ['day_of_week', 'start_time', 'end_time', 'title', 'event_type', 'active', 'languages', 'week_of_month', 'concurrent', 'hide_live', 'parish_scoped'];
  const boolFields = new Set(['active', 'concurrent', 'hide_live', 'parish_scoped']);
  const updates = [];
  const values = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(boolFields.has(key) ? (req.body[key] ? 1 : 0) : req.body[key]);
    }
  }

  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

  values.push(req.params.id);
  db.prepare(`UPDATE schedules SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  // v26: the edit is now reflected instantly on read — no regeneration, no
  // orphaned old-slot rows (this is the duplicate-bug fix).

  const updated = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// DELETE /api/admin/schedules/:id — remove a schedule
router.delete('/schedules/:id', (req, res) => {
  const db = getDb();
  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

  // v26: no generated events to clean; schedule_overrides cascade via FK.
  db.prepare('DELETE FROM schedules WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// POST /api/admin/parishes/:id/logo — upload parish logo
router.post('/parishes/:id/logo', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const parish = db.prepare('SELECT id FROM parishes WHERE id = ?').get(id);
  if (!parish) return res.status(404).json({ error: 'Parish not found' });

  const chunks = [];
  req.on('data', chunk => chunks.push(chunk));
  req.on('end', () => {
    const buf = Buffer.concat(chunks);
    if (!buf.length) return res.status(400).json({ error: 'No data received' });

    const logoDir = path.join(__dirname, '..', 'data', 'logos');
    if (!fs.existsSync(logoDir)) fs.mkdirSync(logoDir, { recursive: true });

    const ext = (req.headers['content-type'] || '').includes('png') ? 'png' : 'jpg';
    const filename = `${id}.${ext}`;
    fs.writeFileSync(path.join(logoDir, filename), buf);

    db.prepare('UPDATE parishes SET logo_path = ? WHERE id = ?').run(`/logos/${filename}`, id);
    res.json({ logo_path: `/logos/${filename}` });
  });
});

// POST /api/admin/adapters/:id/run — manually trigger an adapter (Caddy-gated)
const registry = require('../adapters/registry');
router.post('/adapters/:id/run', async (req, res) => {
  const adapter = registry.get(req.params.id);
  if (!adapter) return res.status(404).json({ error: 'Adapter not found' });
  try {
    const result = await adapter.run();
    res.json({ status: 'success', ...result });
  } catch (err) {
    res.status(500).json({ status: 'failed', error: err.message });
  }
});

module.exports = router;
