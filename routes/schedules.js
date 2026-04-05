const { Router } = require('express');
const { getDb } = require('../db');

const router = Router();

// GET /api/schedules — public schedules with parish info
router.get('/', (req, res) => {
  const db = getDb();
  const { jurisdiction } = req.query;

  let query = `
    SELECT s.*, p.name as parish_name, p.full_name, p.jurisdiction,
      p.address as parish_address, p.lat, p.lng,
      p.website as parish_website, p.logo_path as parish_logo,
      p.languages as parish_languages, p.acronym as parish_acronym, p.color as parish_color
    FROM schedules s
    JOIN parishes p ON s.parish_id = p.id
    WHERE s.active = 1 AND p.id != '_unassigned'
  `;
  const params = [];

  if (jurisdiction) {
    query += ' AND p.jurisdiction = ?';
    params.push(jurisdiction);
  }

  query += ' ORDER BY p.name, s.day_of_week, s.start_time';

  const schedules = db.prepare(query).all(...params);
  res.json(schedules);
});

module.exports = router;
