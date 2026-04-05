const { Router } = require('express');
const { getDb } = require('../db');
const path = require('path');
const fs = require('fs');

const router = Router();

// Auth is handled by Caddy forward_auth to keycard — only Tailnet users reach /api/admin/*
// Do NOT add Express-level auth middleware here; it would block the keycard flow.

// GET /api/admin/ping — lightweight check for admin access
router.get('/ping', (req, res) => res.json({ ok: true }));

// GET /api/admin/events/pending — list pending_review events
router.get('/events/pending', (req, res) => {
  const db = getDb();
  const events = db.prepare(`
    SELECT e.*, p.name as parish_name, p.address as parish_address
    FROM events e
    JOIN parishes p ON e.parish_id = p.id
    WHERE e.status = 'pending_review'
    ORDER BY e.created_at DESC
    LIMIT 200
  `).all();
  res.json(events);
});

// PATCH /api/admin/events/:id — update event fields (status, title, description, times, parish, type)
router.patch('/events/:id', (req, res) => {
  const db = getDb();
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(req.params.id);
  if (!event) return res.status(404).json({ error: 'Event not found' });

  const { status, parish_id, title, description, start_utc, end_utc, event_type } = req.body;

  if (status && !['approved', 'rejected', 'pending_review'].includes(status)) {
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

// POST /api/admin/parishes — create a new parish
router.post('/parishes', (req, res) => {
  const db = getDb();
  const { name, full_name, jurisdiction, address, lat, lng, website, email, phone, languages } = req.body;

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
    INSERT INTO parishes (id, name, full_name, jurisdiction, address, lat, lng, website, email, phone, languages)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, name, full_name || null, jurisdiction, address || null, lat, lng, website || null, email || null, phone || null, languages || '["English"]');

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

  const allowed = ['name', 'full_name', 'address', 'website', 'email', 'phone', 'acronym', 'chant_style', 'languages', 'lat', 'lng', 'color'];
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

  const updated = db.prepare('SELECT * FROM parishes WHERE id = ?').get(id);
  res.json(updated);
});

// DELETE /api/admin/parishes/:id — remove a parish
router.delete('/parishes/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;

  if (id === '_unassigned') return res.status(400).json({ error: 'Cannot delete sentinel parish' });

  const parish = db.prepare('SELECT id FROM parishes WHERE id = ?').get(id);
  if (!parish) return res.status(404).json({ error: 'Parish not found' });

  const eventCount = db.prepare('SELECT COUNT(*) as n FROM events WHERE parish_id = ?').get(id).n;
  if (eventCount > 0) {
    return res.status(400).json({ error: `Cannot delete: ${eventCount} events reference this parish` });
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
    SELECT s.*, p.name as parish_name
    FROM schedules s
    JOIN parishes p ON s.parish_id = p.id
    ORDER BY s.parish_id, s.day_of_week, s.start_time
  `).all();
  res.json(schedules);
});

// POST /api/admin/schedules — create a schedule
router.post('/schedules', (req, res) => {
  const db = getDb();
  const { parish_id, day_of_week, start_time, end_time, title, event_type, languages } = req.body;

  if (!parish_id || day_of_week == null || !start_time || !title) {
    return res.status(400).json({ error: 'parish_id, day_of_week, start_time, and title are required' });
  }

  const parish = db.prepare('SELECT id FROM parishes WHERE id = ?').get(parish_id);
  if (!parish) return res.status(400).json({ error: 'Invalid parish_id' });

  const result = db.prepare(`
    INSERT INTO schedules (parish_id, day_of_week, start_time, end_time, title, event_type, languages)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(parish_id, day_of_week, start_time, end_time || null, title, event_type || 'liturgy', languages || null);

  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(result.lastInsertRowid);
  res.status(201).json(schedule);
});

// PATCH /api/admin/schedules/:id — update a schedule
router.patch('/schedules/:id', (req, res) => {
  const db = getDb();
  const schedule = db.prepare('SELECT * FROM schedules WHERE id = ?').get(req.params.id);
  if (!schedule) return res.status(404).json({ error: 'Schedule not found' });

  const allowed = ['day_of_week', 'start_time', 'end_time', 'title', 'event_type', 'active', 'languages'];
  const updates = [];
  const values = [];
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      updates.push(`${key} = ?`);
      values.push(req.body[key]);
    }
  }

  if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

  values.push(req.params.id);
  db.prepare(`UPDATE schedules SET ${updates.join(', ')} WHERE id = ?`).run(...values);

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

  const { name, status } = req.body;
  const updates = [];
  const values = [];
  if (name !== undefined) { updates.push('name = ?'); values.push(name || null); }
  if (status && ['approved', 'review', 'blocked'].includes(status)) {
    updates.push('status = ?'); values.push(status);
  }
  if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

  values.push(phone);
  db.prepare(`UPDATE senders SET ${updates.join(', ')} WHERE phone = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM senders WHERE phone = ?').get(phone));
});

module.exports = router;
