// Merging the two streams — projected schedule instances and stored one-off
// events — and reducing them to one card per real-world service.
//
// PURE. No database, no runtime specifics. Ported from routes/events.js, where
// it was the JS successor to the nightly generator's SQL ROW_NUMBER dedup, and
// factored out here so the browser can run it over a fetched bundle and the
// Worker can run it for the admin paths. One implementation, no drift.

const HOUR_MS = 3600000;

// Canonical millisecond-ISO, so a schedule instance and a one-off at the same
// instant land in the same partition regardless of how each was formatted.
export function canonTime(s) {
  const t = Date.parse(s);
  return Number.isNaN(t) ? String(s) : new Date(t).toISOString();
}

// Dedup partition. `concurrent` rules never collapse into anything — genuinely
// simultaneous services at one parish are not duplicates of each other.
export function partitionKey(e) {
  return e.concurrent ? `id:${e.id}` : `${e.parish_id}||${canonTime(e.start_utc)}||${e.title}`;
}

// Winner within a partition:
//   1. a week_of_month-specific rule beats a generic weekly one
//   2. a stored one-off beats a schedule instance  <- the load-bearing rule:
//      a scraped or hand-entered event supersedes its recurring twin
//   3. most recently updated
export function preferenceCmp(a, b) {
  const womA = a.week_of_month ? 0 : 1, womB = b.week_of_month ? 0 : 1;
  if (womA !== womB) return womA - womB;
  const schA = a.source_adapter === 'schedule' ? 1 : 0, schB = b.source_adapter === 'schedule' ? 1 : 0;
  if (schA !== schB) return schA - schB;
  return Date.parse(b.updated_at || 0) - Date.parse(a.updated_at || 0);
}

/** Keep the preferred row per partition. */
export function dedupe(events) {
  const best = new Map();
  for (const e of events) {
    const k = partitionKey(e);
    const cur = best.get(k);
    if (!cur || preferenceCmp(e, cur) < 0) best.set(k, e);
  }
  return [...best.values()];
}

/**
 * Default visibility. An explicit status matches exactly (admin review);
 * otherwise show approved plus the cancelled/combined tombstones, and suppress
 * hidden/replaced/rejected. Tombstones are scoped to the parish page by the UI.
 */
export function filterByStatus(events, status) {
  if (status) return events.filter(e => e.status === status);
  return events.filter(e =>
    e.status === 'approved' || e.status === 'cancelled' || e.status === 'combined');
}

/** Attach cross-parish links. Only integer-id rows (stored events) can have them. */
export function attachExtraParishes(events, crossRows) {
  const map = {};
  for (const row of crossRows || []) {
    (map[row.event_id] ||= []).push(row.parish_id);
  }
  return events.map(e => ({ ...e, extra_parishes: map[e.id] || [] }));
}

export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Order the feed. With a location, blend proximity and imminence (the weighting
 * the Express feed used); without one, plain chronological.
 */
export function sortFeed(events, { lat = null, lng = null, radiusKm = Infinity, now = Date.now() } = {}) {
  if (lat == null || lng == null) {
    return [...events].sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
  }
  const withDistance = events
    .map(e => ({ ...e, distance_km: Math.round(haversineKm(lat, lng, e.lat || 0, e.lng || 0) * 10) / 10 }))
    .filter(e => e.distance_km <= radiusKm);
  return withDistance.sort((a, b) => {
    const hoursA = (Date.parse(a.start_utc) - now) / HOUR_MS;
    const hoursB = (Date.parse(b.start_utc) - now) / HOUR_MS;
    return (a.distance_km * 0.3 + Math.max(0, hoursA) * 0.7)
         - (b.distance_km * 0.3 + Math.max(0, hoursB) * 0.7);
  });
}

/**
 * The whole read pipeline over rows already in hand. This is what the browser
 * calls after fetching the bundle.
 */
export function buildFeed({ instances, oneOffs, crossRows }, opts = {}) {
  let events = filterByStatus([...instances, ...oneOffs], opts.status);
  if (opts.type) events = events.filter(e => e.event_type === opts.type);
  if (opts.jurisdiction) events = events.filter(e => e.jurisdiction === opts.jurisdiction);
  events = dedupe(events);
  events = attachExtraParishes(events, crossRows);
  return sortFeed(events, opts);
}
