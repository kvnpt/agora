const { Router } = require('express');
const { getDb, syncEventCoordsForParish } = require('../db');
const { geocode } = require('../geocode');
const { generateEvents } = require('../schedule-generator');
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
  const events = db.prepare(`
    SELECT e.id, e.title, e.start_utc, e.end_utc, e.parish_id, p.name as parish_name, e.mutation_type, e.status, e.event_type
    FROM events e
    JOIN parishes p ON e.parish_id = p.id
    WHERE e.start_utc >= ? AND e.start_utc < ?
      AND e.status NOT IN ('replaced', 'rejected', 'cancelled', 'hidden')
      AND e.id != COALESCE(?, -1)
    ORDER BY e.start_utc
  `).all(utcFrom, utcTo, exclude_id ? Number(exclude_id) : null);
  res.json(events);
});

// GET /api/admin/events/pending — list pending_review events
router.get('/events/pending', (req, res) => {
  const db = getDb();
  const events = db.prepare(`
    SELECT e.*, p.name as parish_name, p.address as parish_address, ar.input_texts
    FROM events e
    JOIN parishes p ON e.parish_id = p.id
    LEFT JOIN adapter_runs ar ON e.source_run_id = ar.id
    WHERE e.status = 'pending_review'
    ORDER BY e.start_utc ASC
    LIMIT 200
  `).all();
  res.json(events);
});

// PATCH /api/admin/events/:id — update event fields (status, title, description, times, parish, type)
router.patch('/events/:id', (req, res) => {
  const db = getDb();
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
  const replaced_events = db.prepare(`
    SELECT e.id, e.title, e.parish_id, p.name as parish_name, e.start_utc, e.end_utc
    FROM event_replaces er
    JOIN events e ON e.id = er.replaced_event_id
    JOIN parishes p ON p.id = e.parish_id
    WHERE er.replacing_event_id = ?
  `).all(req.params.id);
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
    const targetReplaces = new Set(replaced_event_ids.map(Number));
    const currentParishSet = new Set(currentParishes);
    const currentReplaceSet = new Set(currentReplaces);

    for (const pid of targetParishes) {
      if (!currentParishSet.has(pid))
        db.prepare('INSERT OR IGNORE INTO event_parishes (event_id, parish_id) VALUES (?, ?)').run(event.id, pid);
    }
    for (const pid of currentParishes) {
      if (!targetParishes.has(pid))
        db.prepare('DELETE FROM event_parishes WHERE event_id = ? AND parish_id = ?').run(event.id, pid);
    }

    for (const rid of targetReplaces) {
      if (!currentReplaceSet.has(rid)) {
        db.prepare('INSERT OR IGNORE INTO event_replaces (replacing_event_id, replaced_event_id) VALUES (?, ?)').run(event.id, rid);
        db.prepare(`UPDATE events SET status = 'replaced', mutation_type = 'replaced', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`).run(rid);
      }
    }
    for (const rid of currentReplaces) {
      if (!targetReplaces.has(rid)) {
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
  const { name, full_name, jurisdiction, address, lat, lng, website, email, phone, languages, live_url } = req.body;

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
    INSERT INTO parishes (id, name, full_name, jurisdiction, address, lat, lng, website, email, phone, languages, live_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, full_name || null, jurisdiction, address || null, lat, lng, website || null, email || null, phone || null, languages || '["English"]', live_url || null);

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

  const allowed = ['name', 'full_name', 'jurisdiction', 'address', 'website', 'email', 'phone', 'acronym', 'chant_style', 'languages', 'lat', 'lng', 'color', 'live_url'];
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
  generateEvents();
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

  // Immediately propagate schedule changes to existing generated events.
  generateEvents();

  const updated = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// DELETE /api/admin/schedules/:id — remove a schedule
router.delete('/schedules/:id', (req, res) => {
  const db = getDb();
  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

  // Clean up generated events for this schedule
  db.prepare("DELETE FROM events WHERE schedule_id = ? AND source_adapter = 'schedule'").run(req.params.id);
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

// --- Sender management ---

// GET /api/admin/senders — list all senders
router.get('/senders', (req, res) => {
  const db = getDb();
  const senders = db.prepare('SELECT * FROM senders ORDER BY last_seen_at DESC').all();
  res.json(senders);
});

// PATCH /api/admin/senders/:phone — update sender name/status
router.patch('/senders/:phone', (req, res) => {
  const db = getDb();
  const { phone } = req.params;
  const sender = db.prepare('SELECT * FROM senders WHERE phone = ?').get(phone);
  if (!sender) return res.status(404).json({ error: 'Sender not found' });

  const { name, status, role } = req.body;
  const updates = [];
  const values = [];
  if (name !== undefined) { updates.push('name = ?'); values.push(name || null); }
  if (status && ['approved', 'review', 'blocked'].includes(status)) {
    updates.push('status = ?'); values.push(status);
  }
  if (role && ['admin', 'user'].includes(role)) {
    updates.push('role = ?'); values.push(role);
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  values.push(phone);
  db.prepare(`UPDATE senders SET ${updates.join(', ')} WHERE phone = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM senders WHERE phone = ?').get(phone));
});

// GET /api/admin/sessions?phone=<phone> — active admin sessions for a sender
router.get('/sessions', (req, res) => {
  const db = getDb();
  const { phone } = req.query;
  if (!phone) return res.status(400).json({ error: 'phone required' });
  const rows = db.prepare(
    'SELECT id, phone, session_sid, created_at, last_seen_at, revoked FROM admin_sessions WHERE phone = ? ORDER BY created_at DESC'
  ).all(phone);
  res.json(rows);
});

// DELETE /api/admin/sessions/:id — revoke a session
router.delete('/sessions/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT session_sid FROM admin_sessions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Session not found' });
  db.prepare('UPDATE admin_sessions SET revoked = 1 WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM sessions WHERE sid = ?').run(row.session_sid);
  res.json({ ok: true });
});

// GET /api/admin/schedules/pending — schedules awaiting review
router.get('/schedules/pending', (req, res) => {
  const db = getDb();
  const schedules = db.prepare(`
    SELECT s.*, p.name as parish_name, ar.input_texts
    FROM schedules s
    JOIN parishes p ON s.parish_id = p.id
    LEFT JOIN adapter_runs ar ON s.source_run_id = ar.id
    WHERE s.status = 'pending_review'
    ORDER BY s.created_at ASC
  `).all();
  res.json(schedules);
});

// POST /api/admin/schedules/:id/approve
router.post('/schedules/:id/approve', (req, res) => {
  const db = getDb();
  const s = db.prepare('SELECT id FROM schedules WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Schedule not found' });
  db.prepare("UPDATE schedules SET status = 'approved', active = 1 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// POST /api/admin/schedules/:id/reject
router.post('/schedules/:id/reject', (req, res) => {
  const db = getDb();
  const s = db.prepare('SELECT id FROM schedules WHERE id = ?').get(req.params.id);
  if (!s) return res.status(404).json({ error: 'Schedule not found' });
  db.prepare("UPDATE schedules SET status = 'rejected', active = 0 WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// GET /api/admin/parish-updates — pending parish change proposals
router.get('/parish-updates', (req, res) => {
  const db = getDb();
  const updates = db.prepare(`
    SELECT pu.*, p.name as parish_name, p.address as parish_address,
           p.website as parish_website, p.email as parish_email,
           p.phone as parish_phone, p.acronym as parish_acronym,
           p.chant_style as parish_chant_style, p.languages as parish_languages,
           p.live_url as parish_live_url, p.full_name as parish_full_name,
           ar.input_texts
    FROM pending_parish_updates pu
    JOIN parishes p ON pu.parish_id = p.id
    LEFT JOIN adapter_runs ar ON pu.source_run_id = ar.id
    WHERE pu.status = 'pending'
    ORDER BY pu.created_at ASC
  `).all();
  res.json(updates);
});

// POST /api/admin/parish-updates/:id/approve — apply proposed changes to parish
router.post('/parish-updates/:id/approve', (req, res) => {
  const db = getDb();
  const pu = db.prepare('SELECT * FROM pending_parish_updates WHERE id = ?').get(req.params.id);
  if (!pu) return res.status(404).json({ error: 'Not found' });

  let changes;
  try { changes = JSON.parse(pu.proposed_changes); } catch { return res.status(400).json({ error: 'Invalid proposed_changes JSON' }); }

  // Accept new shape { sets, clears } or legacy flat blob (pre-split rows).
  // Legacy blobs mixed nulls-as-clears, but those nulls were Claude over-
  // emission not intent — strip them on apply to match the new model.
  const allowed = ['name', 'full_name', 'address', 'website', 'email', 'phone', 'acronym', 'chant_style', 'live_url', 'languages'];
  const isNewShape = changes && typeof changes === 'object' && (changes.sets || changes.clears);
  const rawSets = isNewShape ? (changes.sets || {}) : (changes || {});
  const rawClears = isNewShape ? (Array.isArray(changes.clears) ? changes.clears : []) : [];

  const updates = [];
  const values = [];
  for (const f of allowed) {
    if (f in rawSets && rawSets[f] != null && rawSets[f] !== '') {
      updates.push(`${f} = ?`);
      values.push(f === 'languages' ? JSON.stringify(rawSets[f]) : rawSets[f]);
    }
  }
  for (const f of rawClears) {
    if (typeof f === 'string' && allowed.includes(f) && !(f in rawSets)) {
      updates.push(`${f} = NULL`);
    }
  }

  if (updates.length) {
    values.push(pu.parish_id);
    db.prepare(`UPDATE parishes SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  }

  if (rawSets.address) {
    geocode(rawSets.address).then(coords => {
      if (coords) {
        getDb().prepare('UPDATE parishes SET lat = ?, lng = ? WHERE id = ?').run(coords.lat, coords.lng, pu.parish_id);
      }
    });
  }

  db.prepare("UPDATE pending_parish_updates SET status = 'approved', reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// POST /api/admin/parish-updates/:id/reject
router.post('/parish-updates/:id/reject', (req, res) => {
  const db = getDb();
  const pu = db.prepare('SELECT id FROM pending_parish_updates WHERE id = ?').get(req.params.id);
  if (!pu) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE pending_parish_updates SET status = 'rejected', reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// GET /api/admin/cancellations — pending cancellation proposals from WhatsApp
router.get('/cancellations', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT pc.*, e.title as event_title, e.start_utc as event_start_utc,
           e.event_type as event_type, e.parish_id as parish_id,
           e.status as event_status, p.name as parish_name, ar.input_texts
    FROM pending_cancellations pc
    JOIN events e ON pc.event_id = e.id
    JOIN parishes p ON e.parish_id = p.id
    LEFT JOIN adapter_runs ar ON pc.source_run_id = ar.id
    WHERE pc.status = 'pending'
    ORDER BY pc.created_at ASC
  `).all();
  res.json(rows);
});

// POST /api/admin/cancellations/:id/approve — flip the target event to cancelled
router.post('/cancellations/:id/approve', (req, res) => {
  const db = getDb();
  const pc = db.prepare('SELECT * FROM pending_cancellations WHERE id = ?').get(req.params.id);
  if (!pc) return res.status(404).json({ error: 'Not found' });
  if (pc.status !== 'pending') return res.status(400).json({ error: 'Already reviewed' });
  const event = db.prepare('SELECT id FROM events WHERE id = ?').get(pc.event_id);
  if (!event) return res.status(404).json({ error: 'Target event no longer exists' });
  const tx = db.transaction(() => {
    db.prepare(`UPDATE events SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(pc.event_id);
    db.prepare(`UPDATE pending_cancellations SET status = 'approved', reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(req.params.id);
  });
  tx();
  res.json({ ok: true });
});

// POST /api/admin/cancellations/:id/reject
router.post('/cancellations/:id/reject', (req, res) => {
  const db = getDb();
  const pc = db.prepare('SELECT id, status FROM pending_cancellations WHERE id = ?').get(req.params.id);
  if (!pc) return res.status(404).json({ error: 'Not found' });
  if (pc.status !== 'pending') return res.status(400).json({ error: 'Already reviewed' });
  db.prepare(`UPDATE pending_cancellations SET status = 'rejected', reviewed_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// GET /api/admin/runs — WhatsApp adapter_runs grouped with downstream counts.
// Powers the admin "By Message" view: one card per inbound batch, showing
// sender, confidence, and how many rows of each type the run produced.
router.get('/runs', (req, res) => {
  const db = getDb();
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const senderFilter = req.query.sender || null;
  const sql = `
    SELECT ar.id, ar.started_at, ar.finished_at, ar.status, ar.error_message,
           ar.sender_phone, ar.input_texts, ar.events_found, ar.events_created,
           ar.parish_match_confidence, ar.parish_match_question,
           s.name AS sender_name, s.status AS sender_status,
           (SELECT COUNT(*) FROM events WHERE source_run_id = ar.id) AS events_n,
           (SELECT COUNT(*) FROM events WHERE source_run_id = ar.id AND status = 'pending_review') AS pending_events_n,
           (SELECT COUNT(*) FROM schedules WHERE source_run_id = ar.id) AS schedules_n,
           (SELECT COUNT(*) FROM schedules WHERE source_run_id = ar.id AND status = 'pending_review') AS pending_schedules_n,
           (SELECT COUNT(*) FROM pending_parish_updates WHERE source_run_id = ar.id AND status = 'pending') AS pending_parish_updates_n,
           (SELECT COUNT(*) FROM pending_cancellations WHERE source_run_id = ar.id AND status = 'pending') AS pending_cancellations_n,
           (SELECT COUNT(*) FROM parishes WHERE source_run_id = ar.id) AS new_parishes_n
    FROM adapter_runs ar
    LEFT JOIN senders s ON ar.sender_phone = s.phone
    WHERE ar.adapter_id = 'whatsapp-webhook'
      ${senderFilter ? 'AND ar.sender_phone = ?' : ''}
    ORDER BY ar.started_at DESC
    LIMIT ?
  `;
  const rows = senderFilter
    ? db.prepare(sql).all(senderFilter, limit)
    : db.prepare(sql).all(limit);
  res.json(rows);
});

// GET /api/admin/runs/:id — full detail for one adapter_run, with all
// downstream rows (events/schedules/updates/cancellations/new parishes).
router.get('/runs/:id', (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid id' });
  const run = db.prepare(`SELECT * FROM adapter_runs WHERE id = ?`).get(id);
  if (!run) return res.status(404).json({ error: 'Not found' });
  const sender = run.sender_phone
    ? db.prepare(`SELECT * FROM senders WHERE phone = ?`).get(run.sender_phone)
    : null;
  const events = db.prepare(`
    SELECT e.*, p.name AS parish_name
    FROM events e JOIN parishes p ON e.parish_id = p.id
    WHERE e.source_run_id = ?
    ORDER BY e.start_utc ASC
  `).all(id);
  const schedules = db.prepare(`
    SELECT s.*, p.name AS parish_name
    FROM schedules s JOIN parishes p ON s.parish_id = p.id
    WHERE s.source_run_id = ?
    ORDER BY s.day_of_week, s.start_time
  `).all(id);
  const parish_updates = db.prepare(`
    SELECT pu.*, p.name AS parish_name, p.address AS parish_address,
           p.website AS parish_website, p.email AS parish_email,
           p.phone AS parish_phone, p.acronym AS parish_acronym,
           p.chant_style AS parish_chant_style, p.languages AS parish_languages,
           p.live_url AS parish_live_url, p.full_name AS parish_full_name
    FROM pending_parish_updates pu
    JOIN parishes p ON pu.parish_id = p.id
    WHERE pu.source_run_id = ?
    ORDER BY pu.created_at ASC
  `).all(id);
  const cancellations = db.prepare(`
    SELECT pc.*, e.title AS event_title, e.start_utc AS event_start_utc,
           e.event_type AS event_type, e.parish_id AS parish_id,
           e.status AS event_status, p.name AS parish_name
    FROM pending_cancellations pc
    JOIN events e ON pc.event_id = e.id
    JOIN parishes p ON e.parish_id = p.id
    WHERE pc.source_run_id = ?
    ORDER BY pc.created_at ASC
  `).all(id);
  const new_parishes = db.prepare(`SELECT * FROM parishes WHERE source_run_id = ?`).all(id);
  res.json({ run, sender, events, schedules, parish_updates, cancellations, new_parishes });
});

// GET /api/admin/dropped — WhatsApp runs that produced nothing (no events, schedules, or parish updates)
router.get('/dropped', (req, res) => {
  const db = getDb();
  const runs = db.prepare(`
    SELECT * FROM adapter_runs
    WHERE adapter_id = 'whatsapp-webhook'
      AND status = 'success'
      AND events_found = 0
      AND input_texts IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.source_run_id = adapter_runs.id)
      AND NOT EXISTS (SELECT 1 FROM pending_parish_updates ppu WHERE ppu.source_run_id = adapter_runs.id)
      AND NOT EXISTS (SELECT 1 FROM pending_cancellations pc WHERE pc.source_run_id = adapter_runs.id)
      AND NOT EXISTS (SELECT 1 FROM parishes p WHERE p.source_run_id = adapter_runs.id)
      AND NOT (
        json_array_length(input_texts) = 1
        AND length(json_extract(input_texts, '$[0]')) <= 20
        AND EXISTS (
          SELECT 1 FROM adapter_runs r2
          WHERE r2.adapter_id = 'whatsapp-webhook'
            AND r2.sender_phone = adapter_runs.sender_phone
            AND r2.parish_match_confidence = 'low'
            AND r2.started_at < adapter_runs.started_at
            AND r2.started_at > datetime(adapter_runs.started_at, '-24 hours')
        )
      )
    ORDER BY started_at DESC
    LIMIT 50
  `).all();
  res.json(runs);
});

// DELETE /api/admin/dropped/:id — remove a dropped run record
router.delete('/dropped/:id', (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM adapter_runs WHERE id = ? AND adapter_id = 'whatsapp-webhook'").run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
