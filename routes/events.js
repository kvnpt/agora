const { Router } = require('express');
const { Temporal } = require('@js-temporal/polyfill');
const { getDb } = require('../db');
const { expandWindow, expandOne, parseInstanceId } = require('../schedule-expand');

const router = Router();

const TZ = 'Australia/Sydney';
const DEFAULT_WINDOW_DAYS = 180;

// Start of today in Sydney, as a UTC ISO string (DST-correct via Temporal).
function sydneyTodayStartUtc() {
  return Temporal.Now.zonedDateTimeISO(TZ).startOfDay().toInstant()
    .toString({ smallestUnit: 'millisecond' });
}

// Canonical millisecond-ISO so a schedule instance and a one-off at the same
// instant collapse to the same dedup partition regardless of stored formatting.
function canonTime(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? String(s) : new Date(t).toISOString();
}

// Dedup partition key — mirrors the old ROW_NUMBER PARTITION BY.
// concurrent events never collapse; everything else collapses on parish+time+title.
function partitionKey(e) {
  return e.concurrent ? `id:${e.id}` : `${e.parish_id}||${canonTime(e.start_utc)}||${e.title}`;
}

// Winner ordering within a partition — mirrors the old ROW_NUMBER ORDER BY:
//   1. week_of_month-specific schedule beats generic weekly
//   2. non-schedule (adapter/one-off) beats schedule-generated
//   3. most recently updated
function preferenceCmp(a, b) {
  const womA = a.week_of_month ? 0 : 1, womB = b.week_of_month ? 0 : 1;
  if (womA !== womB) return womA - womB;
  const schA = a.source_adapter === 'schedule' ? 1 : 0, schB = b.source_adapter === 'schedule' ? 1 : 0;
  if (schA !== schB) return schA - schB;
  return Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0);
}

// GET /api/events — list events with optional geo query
router.get('/', (req, res) => {
  const db = getDb();
  const { lat, lng, radius, type, jurisdiction, from, to, status } = req.query;

  // Window bounds (server-computed default; client may still pass from/to).
  const fromUtc = from || sydneyTodayStartUtc();
  const toUtc = to || new Date(Date.parse(fromUtc) + DEFAULT_WINDOW_DAYS * 86400000).toISOString();

  // Stream 1: schedule instances expanded from rules + overrides.
  const instances = expandWindow(db, fromUtc, toUtc);

  // Stream 2: genuine one-offs (everything NOT schedule-generated). The
  // source_adapter guard also prevents double-counting any legacy generated
  // rows that linger before the v26 backfill deletes them.
  const oneOffs = db.prepare(`
    SELECT e.*, p.name as parish_name, p.jurisdiction, p.address as parish_address,
      p.website as parish_website, p.logo_path as parish_logo, p.languages as parish_languages,
      p.acronym as parish_acronym, p.color as parish_color, p.live_url as parish_live_url
    FROM events e
    JOIN parishes p ON e.parish_id = p.id
    WHERE e.source_adapter != 'schedule'
      AND e.start_utc >= ? AND e.start_utc <= ?
  `).all(fromUtc, toUtc);

  let events = [...instances, ...oneOffs];

  // Status filter. Explicit status (admin review) matches exactly; otherwise
  // show approved + cancelled + combined tombstones (hidden/pending/rejected
  // suppressed). Tombstones are scoped to the parish page client-side.
  if (status) {
    events = events.filter(e => e.status === status);
  } else {
    events = events.filter(e => e.status === 'approved' || e.status === 'cancelled' || e.status === 'combined');
  }

  if (type) events = events.filter(e => e.event_type === type);
  if (jurisdiction) events = events.filter(e => e.jurisdiction === jurisdiction);

  // De-duplicate: keep the preferred row per partition.
  const best = new Map();
  for (const e of events) {
    const k = partitionKey(e);
    const cur = best.get(k);
    if (!cur || preferenceCmp(e, cur) < 0) best.set(k, e);
  }
  events = [...best.values()];

  // Attach extra_parishes from event_parishes (cross-parish combined events).
  // Only integer-id rows (one-offs / combining events) can have these.
  const intIds = events.map(e => e.id).filter(id => typeof id === 'number' || /^\d+$/.test(String(id)));
  if (intIds.length) {
    const placeholders = intIds.map(() => '?').join(',');
    const crossRows = db.prepare(
      `SELECT event_id, parish_id FROM event_parishes WHERE event_id IN (${placeholders})`
    ).all(...intIds);
    const crossMap = {};
    for (const row of crossRows) {
      if (!crossMap[row.event_id]) crossMap[row.event_id] = [];
      crossMap[row.event_id].push(row.parish_id);
    }
    events = events.map(e => ({ ...e, extra_parishes: crossMap[e.id] || [] }));
  } else {
    events = events.map(e => ({ ...e, extra_parishes: [] }));
  }

  // Geo: compute distance, optionally filter by radius, sort by proximity+time.
  if (lat && lng) {
    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);
    const maxRadius = radius ? parseFloat(radius) : Infinity;

    events = events.map(e => {
      const distance = haversine(userLat, userLng, e.lat || 0, e.lng || 0);
      return { ...e, distance_km: Math.round(distance * 10) / 10 };
    }).filter(e => e.distance_km <= maxRadius);

    const now = Date.now();
    events.sort((a, b) => {
      const hoursA = (new Date(a.start_utc).getTime() - now) / 3600000;
      const hoursB = (new Date(b.start_utc).getTime() - now) / 3600000;
      const scoreA = a.distance_km * 0.3 + Math.max(0, hoursA) * 0.7;
      const scoreB = b.distance_km * 0.3 + Math.max(0, hoursB) * 0.7;
      return scoreA - scoreB;
    });
  } else {
    events.sort((a, b) => new Date(a.start_utc) - new Date(b.start_utc));
  }

  events = events.slice(0, 1000);

  res.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
  res.json(events);
});

// GET /api/events/:id — integer id (one-off) or "scheduleId:YYYY-MM-DD" (instance)
router.get('/:id', (req, res) => {
  const db = getDb();

  const parsed = parseInstanceId(req.params.id);
  if (parsed) {
    const inst = expandOne(db, parsed.scheduleId, parsed.date);
    if (!inst) return res.status(404).json({ error: 'Event not found' });
    return res.json(inst);
  }

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
