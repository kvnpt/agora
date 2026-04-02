const { Router } = require('express');
const { getDb } = require('../db');

const router = Router();

// GET /api/parishes — list all parishes (excluding _unassigned)
router.get('/', (req, res) => {
  const db = getDb();
  const parishes = db.prepare("SELECT * FROM parishes WHERE id != '_unassigned' ORDER BY name").all();
  res.json(parishes);
});

// GET /api/parishes/:id — parish detail with schedules and upcoming events
router.get('/:id', (req, res) => {
  const db = getDb();
  const parish = db.prepare('SELECT * FROM parishes WHERE id = ?').get(req.params.id);
  if (!parish) return res.status(404).json({ error: 'Parish not found' });

  const schedules = db.prepare(`
    SELECT * FROM schedules
    WHERE parish_id = ? AND active = 1
    ORDER BY day_of_week, start_time
  `).all(req.params.id);

  const events = db.prepare(`
    SELECT * FROM events
    WHERE parish_id = ? AND status = 'approved' AND start_utc >= datetime('now')
    ORDER BY start_utc ASC LIMIT 20
  `).all(req.params.id);

  res.json({ ...parish, schedules, events });
});

module.exports = router;
