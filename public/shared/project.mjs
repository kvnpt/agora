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
import { matchesWeekOfMonth, matchesWeekParity } from './recurrence.mjs';

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
  // A break is a tombstone like the other two: the service is not running and
  // somebody who would have turned up is told so, rather than finding the card
  // quietly absent. It is the only kind that arrives without a row of its own
  // in schedule_overrides — expandFrom synthesises it from the break window.
  const isTombstone = kind === 'cancelled' || kind === 'combined' || kind === 'break';
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
    // Three places a service can say where it is, most specific first: this
    // occurrence's override, the rule's own address, the parish's address
    // (which the client falls back to when this is null).
    location_override: (o && o.patch_location_override) || s.location_override || null,
    lat: s.p_lat,
    lng: s.p_lng,
    event_type: (o && o.patch_event_type) || s.event_type,
    languages: (o && o.patch_languages != null) ? o.patch_languages : s.languages,
    hide_live: (o && o.patch_hide_live != null) ? o.patch_hide_live : (s.hide_live || 0),
    parish_scoped: (o && o.patch_parish_scoped != null) ? o.patch_parish_scoped : (s.parish_scoped || 0),
    // A rule has no poster, so this is the override's or nothing — see
    // schedule_overrides.patch_poster_path in d1/schema.sql.
    poster_path: (o && o.patch_poster_path) || null,
    source_url: null,
    source_hash: `schedule-${s.id}-${date}`,
    confidence: 'schedule',
    mutation_type: kind === 'modified' ? 'adapted' : 'scheduled',
    // 'hidden' is still projected; the default API filter drops it. Not a tombstone.
    status: kind === 'cancelled' ? 'cancelled'
          : kind === 'combined'  ? 'combined'
          : kind === 'hidden'    ? 'hidden'
          : kind === 'break'     ? 'break'
          : 'approved',
    is_tombstone: isTombstone ? 1 : 0,
    combined_into_event_id: (o && o.combined_into_event_id) || null,
    // Only set on a break, and carried so the card can say WHY and the
    // timetable can say when the service comes back. A break is a statement
    // about a stretch of dates, and an instance inside it that could not name
    // its own stretch would be a tombstone with nothing to explain it.
    break_from: (o && o.break_from) || null,
    break_until: (o && o.break_until) || null,
    break_note: (o && o.break_note) || null,
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
  if (!matchesWeekParity(date, s.week_parity)) return false;
  if (s.effective_from && date < s.effective_from) return false;
  if (s.effective_to && date > s.effective_to) return false;
  return true;
}

/**
 * Break windows that speak for this rule, soonest first.
 *
 * A row with no `schedule_id` is the whole parish — the case that is actually
 * common, since a parish shutting for Christmas shuts all of it and naming
 * every rule would be a row per service and one of them forgotten.
 */
export function breaksFor(s, breaks) {
  return (breaks || [])
    .filter(b => (b.schedule_id != null
      ? String(b.schedule_id) === String(s.id)
      : b.parish_id === s.parish_id))
    .sort((a, b) => String(a.from_date).localeCompare(String(b.from_date)));
}

/** The break covering this date, or null. */
export function breakCovering(s, date, breaks) {
  return breaksFor(s, breaks).find(b => date >= b.from_date && date <= b.to_date) || null;
}

/**
 * The first date this rule runs again on or after `date`, skipping its breaks.
 *
 * Bounded rather than open-ended: a rule whose break runs to 2030 is a rule
 * somebody should fix, not a loop this should spend a year finding the end of.
 * Null means "not within the horizon", and the caller says "on a break" without
 * naming a date rather than inventing one.
 */
export function nextOccurrenceAfterBreak(s, date, breaks, { horizonDays = 400 } = {}) {
  const start = Date.parse(date + 'T00:00:00Z');
  if (Number.isNaN(start)) return null;
  for (let i = 0; i <= horizonDays; i++) {
    const d = new Date(start + i * DAY_MS).toISOString().slice(0, 10);
    if (!isValidOccurrence(s, d)) continue;
    if (breakCovering(s, d, breaks)) continue;
    return d;
  }
  return null;
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
export function expandFrom({ schedules, overrides, breaks }, fromUtc, toUtc, { cache = new OffsetCache() } = {}) {
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

    // Narrowed once per rule rather than once per date: a parish-wide break is
    // a row every rule at that parish has to consider.
    const mine = breaksFor(s, breaks);

    for (const date of byDow[s.day_of_week] || []) {
      if (!matchesWeekOfMonth(date, s.week_of_month)) continue;
      if (!matchesWeekParity(date, s.week_parity)) continue;
      if (s.effective_from && date < s.effective_from) continue;
      if (s.effective_to && date > s.effective_to) continue;

      // An explicit override beats the break, always. A break says "nothing
      // this fortnight"; an override on one of those dates is somebody having
      // said something about that date in particular, and the narrower
      // statement is the later thought. It is also how a single service is
      // reinstated mid-break without cutting the break in two.
      let o = ov[`${s.id}:${date}`];
      if (!o) {
        const b = mine.find(x => date >= x.from_date && date <= x.to_date);
        if (b) {
          o = {
            kind: 'break',
            break_from: b.from_date,
            break_until: b.to_date,
            break_note: b.note || null,
            updated_at: b.updated_at || null,
          };
        }
      }
      const inst = project(s, date, o, cache);
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
