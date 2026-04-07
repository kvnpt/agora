const { Router } = require('express');
const { getDb } = require('../db');

const router = Router();

// GET /api/events — list events with optional geo query
router.get('/', (req, res) => {
  const db = getDb();
  const { lat, lng, radius, type, jurisdiction, from, to, status } = req.query;

  // De-duplicate: for each (parish, time, title), prefer:
  //   1. Schedule with week_of_month (more specific override) over generic weekly
  //   2. Non-schedule adapter over schedule-generated
  //   3. Most recently updated
  let query = `
    SELECT * FROM (
      SELECT e.*, p.name as parish_name, p.jurisdiction, p.address as parish_address,
        p.website as parish_website, p.logo_path as parish_logo, p.languages as parish_languages,
        p.acronym as parish_acronym, p.color as parish_color, p.live_url as parish_live_url,
        ROW_NUMBER() OVER (
          PARTITION BY e.parish_id, e.start_utc, e.title
          ORDER BY
            CASE WHEN s.week_of_month IS NOT NULL THEN 0 ELSE 1 END,
            CASE WHEN e.source_adapter = 'schedule' THEN 1 ELSE 0 END,
            e.updated_at DESC
        ) as rn
      FROM events e
      JOIN parishes p ON e.parish_id = p.id
      LEFT JOIN schedules s ON e.schedule_id = s.id
      WHERE e.status = ?
  `;
  const params = [status || 'approved'];

  // Only future events by default
  const fromDate = from || new Date().toISOString();
  query += ' AND e.start_utc >= ?';
  params.push(fromDate);

  if (to) {
    query += ' AND e.start_utc <= ?';
    params.push(to);
  }

  if (type) {
    query += ' AND e.event_type = ?';
    params.push(type);
  }

  if (jurisdiction) {
    query += ' AND p.jurisdiction = ?';
    params.push(jurisdiction);
  }

  query += ') WHERE rn = 1 ORDER BY start_utc ASC LIMIT 200';

  let events = db.prepare(query).all(...params).map(({ rn, ...rest }) => rest);

  // If lat/lng provided, compute distance and optionally filter by radius
  if (lat && lng) {
    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);
    const maxRadius = radius ? parseFloat(radius) : Infinity;

    events = events.map(e => {
      const eLat = e.lat || 0;
      const eLng = e.lng || 0;
      const distance = haversine(userLat, userLng, eLat, eLng);
      return { ...e, distance_km: Math.round(distance * 10) / 10 };
    }).filter(e => e.distance_km <= maxRadius);

    // Sort by combined proximity + time score
    const now = Date.now();
    events.sort((a, b) => {
      const hoursA = (new Date(a.start_utc).getTime() - now) / 3600000;
      const hoursB = (new Date(b.start_utc).getTime() - now) / 3600000;
      const scoreA = a.distance_km * 0.3 + Math.max(0, hoursA) * 0.7;
      const scoreB = b.distance_km * 0.3 + Math.max(0, hoursB) * 0.7;
      return scoreA - scoreB;
    });
  }

  res.json(events);
});

// GET /api/events/:id
router.get('/:id', (req, res) => {
  const db = getDb();
  const event = db.prepare(`
    SELECT e.*, p.name as parish_name, p.jurisdiction, p.address as parish_address,
      p.live_url as parish_live_url
    FROM events e
    JOIN parishes p ON e.parish_id = p.id
    WHERE e.id = ?
  `).get(req.params.id);

  if (!event) return res.status(404).json({ error: 'Event not found' });
  res.json(event);
});

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

module.exports = router;
