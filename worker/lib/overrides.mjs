// Write-side helpers for schedule_overrides — the admin edit of a single
// schedule occurrence. Read side is expand.mjs. Ported from schedule-overrides.js.
//
// CHANGES FROM THE EXPRESS VERSION:
//   1. async, and binds positionally — D1 has no named parameters.
//   2. The UTC -> local 'HH:MM' conversion uses the parish's own zone rather
//      than a hardcoded Australia/Sydney.
//   3. No db.transaction(). Each path here is a single statement, so there is
//      nothing to wrap; D1 offers batch() for the cases that need atomicity.
//
// findInstanceOccurrence() is not ported — its only caller was the WhatsApp
// webhook, which is gone.

import { OffsetCache, offsetAt } from '../../public/shared/tz.mjs';
import { expandOne, isValidOccurrence } from './expand.mjs';

const PATCH_COLS = [
  'patch_title', 'patch_start_time', 'patch_end_time', 'patch_event_type',
  'patch_languages', 'patch_feast', 'patch_description', 'patch_location_override',
  'patch_hide_live', 'patch_parish_scoped',
];
const DISPLAY_FIELDS = [
  'title', 'description', 'start_utc', 'end_utc', 'event_type',
  'languages', 'location_override', 'hide_live', 'parish_scoped', 'feast',
];

// A UTC instant -> 'HH:MM' on the parish's wall clock.
function localHHMM(zone, utc) {
  const ms = Date.parse(utc);
  const mins = ((ms + offsetAt(zone, ms) * 60000) % 86400000 + 86400000) % 86400000 / 60000;
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
}

// For each display field PRESENT in body, compute the patch value. NULL means
// "inherit from the rule" — i.e. the submitted value equals the schedule's.
function mergePatch(s, zone, body, cur) {
  if ('title' in body) cur.patch_title = (body.title && body.title !== s.title) ? body.title : null;
  if ('start_utc' in body && body.start_utc) {
    const hhmm = localHHMM(zone, body.start_utc);
    cur.patch_start_time = hhmm !== s.start_time ? hhmm : null;
  }
  if ('end_utc' in body) {
    const hhmm = body.end_utc ? localHHMM(zone, body.end_utc) : null;
    cur.patch_end_time = (hhmm || null) !== (s.end_time || null) ? hhmm : null;
  }
  if ('event_type' in body) cur.patch_event_type = (body.event_type && body.event_type !== s.event_type) ? body.event_type : null;
  if ('languages' in body) cur.patch_languages = ((body.languages || null) !== (s.languages || null)) ? (body.languages || null) : null;
  if ('feast' in body) cur.patch_feast = body.feast || null;
  if ('description' in body) cur.patch_description = body.description || null;
  if ('location_override' in body) cur.patch_location_override = body.location_override || null;
  if ('hide_live' in body) cur.patch_hide_live = ((body.hide_live ? 1 : 0) !== (s.hide_live || 0)) ? (body.hide_live ? 1 : 0) : null;
  if ('parish_scoped' in body) cur.patch_parish_scoped = ((body.parish_scoped ? 1 : 0) !== (s.parish_scoped || 0)) ? (body.parish_scoped ? 1 : 0) : null;
}

const hasContent = (cur) =>
  PATCH_COLS.some(c => cur[c] != null) || cur.combined_into_event_id != null;

function upsert(db, scheduleId, date, kind, cur) {
  return db.prepare(`
    INSERT INTO schedule_overrides
      (schedule_id, occurrence_date, kind, patch_title, patch_start_time, patch_end_time,
       patch_event_type, patch_languages, patch_feast, patch_description, patch_location_override,
       patch_hide_live, patch_parish_scoped, combined_into_event_id, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(schedule_id, occurrence_date) DO UPDATE SET
      kind=excluded.kind,
      patch_title=excluded.patch_title, patch_start_time=excluded.patch_start_time,
      patch_end_time=excluded.patch_end_time, patch_event_type=excluded.patch_event_type,
      patch_languages=excluded.patch_languages, patch_feast=excluded.patch_feast,
      patch_description=excluded.patch_description,
      patch_location_override=excluded.patch_location_override,
      patch_hide_live=excluded.patch_hide_live, patch_parish_scoped=excluded.patch_parish_scoped,
      combined_into_event_id=excluded.combined_into_event_id,
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
  `).bind(
    scheduleId, date, kind,
    cur.patch_title ?? null, cur.patch_start_time ?? null, cur.patch_end_time ?? null,
    cur.patch_event_type ?? null, cur.patch_languages ?? null, cur.patch_feast ?? null,
    cur.patch_description ?? null, cur.patch_location_override ?? null,
    cur.patch_hide_live ?? null, cur.patch_parish_scoped ?? null,
    cur.combined_into_event_id ?? null,
  ).run();
}

const loadSchedule = (db, scheduleId) => db.prepare(
  `SELECT s.*, p.timezone AS p_timezone FROM schedules s
   JOIN parishes p ON s.parish_id = p.id WHERE s.id = ?`
).bind(scheduleId).first();

const loadOverride = (db, scheduleId, date) => db.prepare(
  'SELECT * FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?'
).bind(scheduleId, date).first();

/**
 * Apply an admin PATCH against a schedule instance. `body` mirrors PATCH /events/:id.
 * Returns { instance } or { error, code }.
 */
export async function applyAdminEdit(db, scheduleId, date, body, cache = new OffsetCache()) {
  const s = await loadSchedule(db, scheduleId);
  if (!s) return { error: 'Schedule not found', code: 404 };
  if (!isValidOccurrence(s, date)) return { error: 'Not a valid occurrence of this schedule', code: 400 };
  if (body.parish_id && body.parish_id !== s.parish_id) {
    return { error: 'Edit the schedule to move a recurring service to another parish', code: 400 };
  }

  const zone = s.p_timezone || 'Australia/Sydney';
  const existing = await loadOverride(db, scheduleId, date);
  const cur = existing ? { ...existing } : {};
  const hasDisplay = DISPLAY_FIELDS.some(f => f in body);
  mergePatch(s, zone, body, cur);

  const status = body.status;
  if (status && !['approved', 'cancelled', 'hidden'].includes(status)) {
    return { error: 'Unsupported status for a scheduled instance (use approved/cancelled/hidden)', code: 400 };
  }

  let kind;
  if (status === 'cancelled') kind = 'cancelled';
  else if (status === 'hidden') kind = 'hidden';
  else if (status === 'approved') kind = hasContent(cur) ? 'modified' : '__revert__'; // uncancel/unhide
  else kind = hasDisplay ? 'modified' : null;                                          // no status given

  // A 'modified' write that nets no actual patch (edited back to the rule's own
  // values) is equivalent to having no override — drop it, so the instance is
  // cleanly 'scheduled' again rather than a no-op 'adapted'.
  if (kind === 'modified' && !hasContent(cur)) kind = '__revert__';
  if (kind === null) return { error: 'No changes', code: 400 };

  if (kind === '__revert__') {
    await db.prepare('DELETE FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?')
      .bind(scheduleId, date).run();
  } else {
    await upsert(db, scheduleId, date, kind, cur);
  }

  return { instance: await expandOne(db, scheduleId, date, { cache }) };
}

/** DELETE of a schedule instance: suppress it with a 'hidden' override. The rule lives on. */
export async function hideInstance(db, scheduleId, date) {
  const s = await loadSchedule(db, scheduleId);
  if (!s) return { error: 'Schedule not found', code: 404 };
  if (!isValidOccurrence(s, date)) return { error: 'Not a valid occurrence of this schedule', code: 400 };
  const existing = await loadOverride(db, scheduleId, date);
  await upsert(db, scheduleId, date, 'hidden', existing ? { ...existing } : {});
  return { ok: true };
}

/** Mark a schedule instance as combined into a one-off event (deanery, feast). */
export async function setCombined(db, scheduleId, date, combiningEventId) {
  const s = await loadSchedule(db, scheduleId);
  if (!s) return { error: 'Schedule not found', code: 404 };
  if (!isValidOccurrence(s, date)) return { error: 'Not a valid occurrence of this schedule', code: 400 };
  const existing = await loadOverride(db, scheduleId, date);
  const cur = existing ? { ...existing } : {};
  cur.combined_into_event_id = combiningEventId;
  await upsert(db, scheduleId, date, 'combined', cur);
  return { ok: true };
}

/** Un-combine: drop the override so the instance returns to the feed. */
export async function clearCombined(db, scheduleId, date) {
  await db.prepare(
    "DELETE FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ? AND kind = 'combined'"
  ).bind(scheduleId, date).run();
  return { ok: true };
}
