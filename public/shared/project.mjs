// The date lens, PURE HALF — no database, no runtime specifics.
//
// Served to the browser from /shared/ AND bundled into the Worker, so the two
// cannot drift. Expand recurring `schedules` into instances at query time,
// applying `schedule_overrides`. Ported from schedule-expand.js.
//
// Nothing is stored. Every (schedule, date) in the window emits exactly one
// instance with a stable synthetic id "scheduleId:YYYY-MM-DD", which round-trips
// through expandOne() so a deep link resolves without a row existing.
//
// Overrides only change how an instance renders:
//   modified  -> patched instance, mutation_type 'adapted'
//   cancelled -> CANCELLED tombstone, still visible
//   combined  -> tombstone linking to the combining event
//   hidden    -> dropped from the default filter; NOT a tombstone
//
// THREE CHANGES FROM THE EXPRESS VERSION:
//   1. async — D1's API is promise-based.
//   2. Per-parish timezone. The old code hardcoded Australia/Sydney in a module
//      constant; parishes now carry an IANA zone, so the date index is built per
//      distinct zone.
//   3. Overrides are window-filtered. The old query was a bare
//      `SELECT * FROM schedule_overrides` that loaded every override ever
//      written, on every request.

import { OffsetCache, localDateOf } from './tz.mjs';
import { matchesWeekOfMonth } from './recurrence.mjs';

const DAY_MS = 86400000;

// Every local date in [fromUtc, toUtc] for one zone, bucketed by day-of-week
// (0=Sun..6=Sat, matching schedules.day_of_week).
function dateIndexFor(zone, fromMs, toMs) {
  const start = localDateOf(zone, fromMs);
  const end = localDateOf(zone, toMs);
  const byDow = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  let t = Date.parse(start + 'T00:00:00Z');
  const endT = Date.parse(end + 'T00:00:00Z');
  while (t <= endT) {
    const d = new Date(t);
    byDow[d.getUTCDay()].push(d.toISOString().slice(0, 10));
    t += DAY_MS;
  }
  return byDow;
}

// Project one occurrence of a schedule (with optional override) into the shape
// the API and frontend already expect.
export function project(s, date, o, cache) {
  const zone = s.p_timezone || 'Australia/Sydney';
  const kind = o ? o.kind : null;
  const startTime = (o && o.patch_start_time) || s.start_time;
  const endTime = (o && o.patch_end_time != null) ? o.patch_end_time : s.end_time;
  const isTombstone = kind === 'cancelled' || kind === 'combined';
  return {
    id: `${s.id}:${date}`,                  // stable synthetic id (doubles as service_key)
    parish_id: s.parish_id,
    schedule_id: s.id,
    source_adapter: 'schedule',
    title: (o && o.patch_title) || s.title,
    description: (o && o.patch_description) || null,
    feast: (o && o.patch_feast) || null,
    start_utc: cache.toUtcISO(zone, date, startTime),
    end_utc: endTime ? cache.toUtcISO(zone, date, endTime) : null,
    // Local wall clock and zone, so the client renders parish-local time without
    // converting back from UTC — and without knowing the viewer's location.
    start_local: `${date}T${startTime}`,
    end_local: endTime ? `${date}T${endTime}` : null,
    timezone: zone,
    location_override: (o && o.patch_location_override) || null,
    lat: s.p_lat,
    lng: s.p_lng,
    event_type: (o && o.patch_event_type) || s.event_type,
    languages: (o && o.patch_languages != null) ? o.patch_languages : s.languages,
    hide_live: (o && o.patch_hide_live != null) ? o.patch_hide_live : (s.hide_live || 0),
    parish_scoped: (o && o.patch_parish_scoped != null) ? o.patch_parish_scoped : (s.parish_scoped || 0),
    source_url: null,
    source_hash: `schedule-${s.id}-${date}`,
    confidence: 'schedule',
    mutation_type: kind === 'modified' ? 'adapted' : 'scheduled',
    // 'hidden' is still projected; the default API filter drops it. Not a tombstone.
    status: kind === 'cancelled' ? 'cancelled'
          : kind === 'combined'  ? 'combined'
          : kind === 'hidden'    ? 'hidden'
          : 'approved',
    is_tombstone: isTombstone ? 1 : 0,
    combined_into_event_id: (o && o.combined_into_event_id) || null,
    created_at: s.created_at,
    updated_at: o ? o.updated_at : s.created_at,
    parish_name: s.parish_name,
    jurisdiction: s.parish_jurisdiction,
    parish_address: s.parish_address,
    parish_website: s.parish_website,
    parish_logo: s.parish_logo,
    parish_languages: s.parish_languages,
    parish_acronym: s.parish_acronym,
    parish_color: s.parish_color,
    parish_live_url: s.parish_live_url,
    // dedup inputs (see partitionKey/preferenceCmp in the events route)
    concurrent: s.concurrent || 0,
    week_of_month: s.week_of_month || null,
  };
}

/** Does `date` (local 'YYYY-MM-DD') fall on an occurrence the rule produces? */
export function isValidOccurrence(s, date) {
  const dow = new Date(date + 'T00:00:00Z').getUTCDay();
  if (dow !== s.day_of_week) return false;
  if (!matchesWeekOfMonth(date, s.week_of_month)) return false;
  if (s.effective_from && date < s.effective_from) return false;
  if (s.effective_to && date > s.effective_to) return false;
  return true;
}

/**
 * PURE expansion — no database. Given rows already in hand, project every
 * occurrence in [fromUtc, toUtc].
 *
 * This is the half that runs in the BROWSER. The client fetches the bundle
 * (schedules + overrides, already joined to parish columns) and calls this;
 * the Worker calls it too, via expandWindow below. One implementation, so the
 * two can't drift — which was the standing objection to moving the lens
 * client-side.
 */
export function expandFrom({ schedules, overrides }, fromUtc, toUtc, { cache = new OffsetCache() } = {}) {
  const fromMs = Date.parse(fromUtc);
  const toMs = Date.parse(toUtc);

  const ov = {};
  for (const r of overrides || []) ov[`${r.schedule_id}:${r.occurrence_date}`] = r;

  // One date index per distinct zone — a handful across Oceania, not one per rule.
  const indexes = new Map();
  const out = [];
  for (const s of schedules || []) {
    const zone = s.p_timezone || 'Australia/Sydney';
    let byDow = indexes.get(zone);
    if (!byDow) { byDow = dateIndexFor(zone, fromMs, toMs); indexes.set(zone, byDow); }

    for (const date of byDow[s.day_of_week] || []) {
      if (!matchesWeekOfMonth(date, s.week_of_month)) continue;
      if (s.effective_from && date < s.effective_from) continue;
      if (s.effective_to && date > s.effective_to) continue;
      const inst = project(s, date, ov[`${s.id}:${date}`], cache);
      const startMs = Date.parse(inst.start_utc);
      if (startMs < fromMs || startMs > toMs) continue;
      out.push(inst);
    }
  }
  return out;
}


/** Parse a synthetic instance id. Returns { scheduleId, date } or null. */
export function parseInstanceId(id) {
  const str = String(id);
  const i = str.indexOf(':');
  if (i === -1) return null;
  const scheduleId = Number(str.slice(0, i));
  const date = str.slice(i + 1);
  if (!Number.isInteger(scheduleId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { scheduleId, date };
}
