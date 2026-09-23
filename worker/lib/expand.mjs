// The date lens, DATABASE HALF.
//
// The projection itself lives in public/shared/project.mjs, served to the
// browser and bundled here — one implementation for both. These wrappers just
// fetch rows. Only the admin write-path needs server-side expansion now; the
// public feed ships rows and the browser expands them.

import { OffsetCache } from '../../public/shared/tz.mjs';
import {
  expandFrom, project, isValidOccurrence, parseInstanceId,
  breaksFor, breakCovering, nextOccurrenceAfterBreak,
} from '../../public/shared/project.mjs';

export {
  expandFrom, project, isValidOccurrence, parseInstanceId,
  breaksFor, breakCovering, nextOccurrenceAfterBreak,
};

const DAY_MS = 86400000;
const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);

const PARISH_COLS = `
  p.lat AS p_lat, p.lng AS p_lng, p.timezone AS p_timezone,
  p.name AS parish_name, p.jurisdiction AS parish_jurisdiction,
  p.address AS parish_address, p.website AS parish_website,
  p.logo_path AS parish_logo, p.languages AS parish_languages,
  p.acronym AS parish_acronym, p.color AS parish_color, p.live_url AS parish_live_url
`;

/**
 * Fetch the rows a window needs. Returns what expandFrom consumes, and is also
 * exactly what the bundle endpoint ships to the client.
 */
export async function fetchWindowRows(db, fromUtc, toUtc, { scheduleId = null } = {}) {
  // Widen by a day so no zone's local date is excluded by UTC skew (max real
  // offset is under 15 hours).
  const startStr = isoDate(Date.parse(fromUtc) - DAY_MS);
  const endStr = isoDate(Date.parse(toUtc) + DAY_MS);

  const schedSql = `
    SELECT s.*, ${PARISH_COLS}
    FROM schedules s JOIN parishes p ON s.parish_id = p.id
    WHERE s.active = 1 ${scheduleId ? 'AND s.id = ?' : ''}
      AND (s.effective_from IS NULL OR s.effective_from <= ?)
      AND (s.effective_to   IS NULL OR s.effective_to   >= ?)
  `;
  const schedArgs = scheduleId ? [scheduleId, endStr, startStr] : [endStr, startStr];

  // Window-filtered, unlike the Express version which loaded every override row.
  const ovSql = scheduleId
    ? 'SELECT * FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date BETWEEN ? AND ?'
    : 'SELECT * FROM schedule_overrides WHERE occurrence_date BETWEEN ? AND ?';
  const ovArgs = scheduleId ? [scheduleId, startStr, endStr] : [startStr, endStr];

  // Breaks overlapping the window. Ranges, so the test is an overlap rather
  // than a BETWEEN — a break that started in December and runs into February is
  // the whole point and would fall out of a containment test.
  //
  // Not narrowed by scheduleId even when one is given: a parish-wide break
  // (schedule_id NULL) speaks for that rule too, and narrowing on the column
  // would drop exactly the row that silences it.
  const brSql = `
    SELECT b.* FROM schedule_breaks b
    WHERE b.from_date <= ? AND b.to_date >= ?
      ${scheduleId ? 'AND (b.schedule_id = ? OR b.schedule_id IS NULL)' : ''}
  `;
  const brArgs = scheduleId ? [endStr, startStr, scheduleId] : [endStr, startStr];

  const [schedules, overrides, breaks] = await Promise.all([
    db.prepare(schedSql).bind(...schedArgs).all(),
    db.prepare(ovSql).bind(...ovArgs).all(),
    // Catch, so a bundle is still served while migration 014 has not run — the
    // same guard the parish_links read carries in the bundle route.
    db.prepare(brSql).bind(...brArgs).all().catch(() => ({ results: [] })),
  ]);
  return {
    schedules: schedules.results || [],
    overrides: overrides.results || [],
    breaks: breaks.results || [],
  };
}

/**
 * Server-side expansion. Only the admin write-path needs this now — the public
 * feed ships rows and expands in the browser.
 */
export async function expandWindow(db, fromUtc, toUtc, { scheduleId = null, cache = new OffsetCache() } = {}) {
  const rows = await fetchWindowRows(db, fromUtc, toUtc, { scheduleId });
  if (!rows.schedules.length) return [];
  return expandFrom(rows, fromUtc, toUtc, { cache });
}

/** Resolve a single synthetic instance id — the deep-link path. */
export async function expandOne(db, scheduleId, date, { cache = new OffsetCache() } = {}) {
  const s = await db.prepare(
    `SELECT s.*, ${PARISH_COLS} FROM schedules s JOIN parishes p ON s.parish_id = p.id WHERE s.id = ?`
  ).bind(scheduleId).first();
  if (!s || !s.active) return null;
  if (!isValidOccurrence(s, date)) return null;

  const o = await db.prepare(
    'SELECT * FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?'
  ).bind(scheduleId, date).first();
  if (o) return project(s, date, o, cache);

  // No override — but a break may still speak for this date, and a deep link
  // into one has to resolve to the tombstone rather than to the service. Same
  // precedence as expandFrom: the explicit row wins, the window fills the gaps.
  const b = await db.prepare(
    `SELECT * FROM schedule_breaks
     WHERE from_date <= ? AND to_date >= ?
       AND (schedule_id = ? OR (schedule_id IS NULL AND parish_id = ?))
     ORDER BY from_date LIMIT 1`
  ).bind(date, date, scheduleId, s.parish_id).first().catch(() => null);

  return project(s, date, b ? {
    kind: 'break',
    break_from: b.from_date,
    break_until: b.to_date,
    break_note: b.note || null,
    updated_at: b.updated_at || null,
  } : null, cache);
}
