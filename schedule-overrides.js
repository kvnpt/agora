// Write-side helpers for schedule_overrides (admin edit of a schedule instance).
// Read side lives in schedule-expand.js. See docs/schedule-overrides-v26.md.

const { Temporal } = require('@js-temporal/polyfill');
const { expandOne, isValidOccurrence } = require('./schedule-expand');

const TZ = 'Australia/Sydney';

const sydHHMM = (utc) => {
  const z = Temporal.Instant.from(utc).toZonedDateTimeISO(TZ);
  return `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
};

const PATCH_COLS = [
  'patch_title', 'patch_start_time', 'patch_end_time', 'patch_event_type',
  'patch_languages', 'patch_feast', 'patch_description', 'patch_location_override',
  'patch_hide_live', 'patch_parish_scoped',
];
const DISPLAY_FIELDS = [
  'title', 'description', 'start_utc', 'end_utc', 'event_type',
  'languages', 'location_override', 'hide_live', 'parish_scoped', 'feast',
];

// For each display field PRESENT in body, compute the patch value (NULL = inherit
// from the rule, i.e. value matches the schedule). Mutates `cur` in place.
function mergePatch(s, body, cur) {
  if ('title' in body) cur.patch_title = (body.title && body.title !== s.title) ? body.title : null;
  if ('start_utc' in body && body.start_utc) {
    const hhmm = sydHHMM(body.start_utc);
    cur.patch_start_time = hhmm !== s.start_time ? hhmm : null;
  }
  if ('end_utc' in body) {
    const hhmm = body.end_utc ? sydHHMM(body.end_utc) : null;
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

const upsert = (db, scheduleId, date, kind, cur) => db.prepare(`
  INSERT INTO schedule_overrides
    (schedule_id, occurrence_date, kind, patch_title, patch_start_time, patch_end_time,
     patch_event_type, patch_languages, patch_feast, patch_description, patch_location_override,
     patch_hide_live, patch_parish_scoped, combined_into_event_id, updated_at)
  VALUES (@schedule_id, @occurrence_date, @kind, @patch_title, @patch_start_time, @patch_end_time,
     @patch_event_type, @patch_languages, @patch_feast, @patch_description, @patch_location_override,
     @patch_hide_live, @patch_parish_scoped, @combined_into_event_id, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
  ON CONFLICT(schedule_id, occurrence_date) DO UPDATE SET
    kind=excluded.kind,
    patch_title=excluded.patch_title, patch_start_time=excluded.patch_start_time, patch_end_time=excluded.patch_end_time,
    patch_event_type=excluded.patch_event_type, patch_languages=excluded.patch_languages, patch_feast=excluded.patch_feast,
    patch_description=excluded.patch_description, patch_location_override=excluded.patch_location_override,
    patch_hide_live=excluded.patch_hide_live, patch_parish_scoped=excluded.patch_parish_scoped,
    combined_into_event_id=excluded.combined_into_event_id,
    updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
`).run({
  schedule_id: scheduleId, occurrence_date: date, kind,
  patch_title: cur.patch_title ?? null, patch_start_time: cur.patch_start_time ?? null,
  patch_end_time: cur.patch_end_time ?? null, patch_event_type: cur.patch_event_type ?? null,
  patch_languages: cur.patch_languages ?? null, patch_feast: cur.patch_feast ?? null,
  patch_description: cur.patch_description ?? null, patch_location_override: cur.patch_location_override ?? null,
  patch_hide_live: cur.patch_hide_live ?? null, patch_parish_scoped: cur.patch_parish_scoped ?? null,
  combined_into_event_id: cur.combined_into_event_id ?? null,
});

// Apply an admin PATCH against a schedule instance. body mirrors PATCH /events/:id.
// Returns { instance } on success or { error, code }.
function applyAdminEdit(db, scheduleId, date, body) {
  const s = db.prepare('SELECT * FROM schedules WHERE id=?').get(scheduleId);
  if (!s) return { error: 'Schedule not found', code: 404 };
  if (!isValidOccurrence(s, date)) return { error: 'Not a valid occurrence of this schedule', code: 400 };
  if (body.parish_id && body.parish_id !== s.parish_id) {
    return { error: 'Edit the schedule to move a recurring service to another parish', code: 400 };
  }

  const existing = db.prepare(
    'SELECT * FROM schedule_overrides WHERE schedule_id=? AND occurrence_date=?'
  ).get(scheduleId, date);
  const cur = existing ? { ...existing } : {};
  const hasDisplay = DISPLAY_FIELDS.some(f => f in body);
  mergePatch(s, body, cur);

  const status = body.status;
  if (status && !['approved', 'cancelled', 'hidden'].includes(status)) {
    return { error: 'Unsupported status for a scheduled instance (use approved/cancelled/hidden)', code: 400 };
  }

  let kind;
  if (status === 'cancelled') kind = 'cancelled';
  else if (status === 'hidden') kind = 'hidden';
  else if (status === 'approved') kind = hasContent(cur) ? 'modified' : '__revert__'; // uncancel/unhide
  else kind = hasDisplay ? 'modified' : null;                                          // no status given

  // A 'modified' write that nets no actual patch (e.g. edited back to the rule's
  // values) is equivalent to having no override — drop it so the instance is
  // cleanly 'scheduled' again, not a no-op 'adapted'.
  if (kind === 'modified' && !hasContent(cur)) kind = '__revert__';

  if (kind === null) return { error: 'No changes', code: 400 };

  const tx = db.transaction(() => {
    if (kind === '__revert__') {
      db.prepare('DELETE FROM schedule_overrides WHERE schedule_id=? AND occurrence_date=?').run(scheduleId, date);
    } else {
      upsert(db, scheduleId, date, kind, cur);
    }
  });
  tx();

  return { instance: expandOne(db, scheduleId, date) };
}

// DELETE of a schedule instance => suppress it with a 'hidden' override
// (the rule still exists; this just removes this occurrence from view).
function hideInstance(db, scheduleId, date) {
  const s = db.prepare('SELECT * FROM schedules WHERE id=?').get(scheduleId);
  if (!s) return { error: 'Schedule not found', code: 404 };
  if (!isValidOccurrence(s, date)) return { error: 'Not a valid occurrence of this schedule', code: 400 };
  const existing = db.prepare(
    'SELECT * FROM schedule_overrides WHERE schedule_id=? AND occurrence_date=?'
  ).get(scheduleId, date);
  upsert(db, scheduleId, date, 'hidden', existing ? { ...existing } : {});
  return { ok: true };
}

// Mark a schedule instance as combined into a one-off event (deanery/feast).
function setCombined(db, scheduleId, date, combiningEventId) {
  const s = db.prepare('SELECT * FROM schedules WHERE id=?').get(scheduleId);
  if (!s) return { error: 'Schedule not found', code: 404 };
  if (!isValidOccurrence(s, date)) return { error: 'Not a valid occurrence of this schedule', code: 400 };
  const existing = db.prepare(
    'SELECT * FROM schedule_overrides WHERE schedule_id=? AND occurrence_date=?'
  ).get(scheduleId, date);
  const cur = existing ? { ...existing } : {};
  cur.combined_into_event_id = combiningEventId;
  upsert(db, scheduleId, date, 'combined', cur);
  return { ok: true };
}

// Un-combine: drop the combined override (the instance returns to the feed).
function clearCombined(db, scheduleId, date) {
  db.prepare("DELETE FROM schedule_overrides WHERE schedule_id=? AND occurrence_date=? AND kind='combined'")
    .run(scheduleId, date);
  return { ok: true };
}

module.exports = { applyAdminEdit, hideInstance, setCombined, clearCombined };
