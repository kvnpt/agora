// Materialize-on-read: expand recurring `schedules` into event instances at
// query time, applying `schedule_overrides` (modified / cancelled / combined).
// Replaces the write half of schedule-generator.js. See docs/schedule-overrides-v26.md.
//
// Nothing disappears: every (schedule, date) in the window emits exactly one
// instance. Overrides only change how it renders:
//   modified  -> the modified instance (a real, globally-visible event)
//   cancelled -> a CANCELLED tombstone (status='cancelled')
//   combined  -> a "Combined" tombstone (status='combined', links to combining event)
// Tombstones are scoped to the parish page client-side (public/app.js).

const { Temporal } = require('@js-temporal/polyfill');
const { matchesWeekOfMonth } = require('./schedule-generator');

const TZ = 'Australia/Sydney';

// Sydney local date+time -> UTC ISO string (millisecond precision, matching the
// legacy toISOString() format already stored on one-off rows). DST handled by
// the IANA database, not hand-rolled offsets.
function localToUtc(dateStr, timeStr) {
  return Temporal.PlainDateTime.from(`${dateStr}T${timeStr}`)
    .toZonedDateTime(TZ)
    .toInstant()
    .toString({ smallestUnit: 'millisecond' });
}

// Parish columns to mirror the joins in routes/events.js GET /.
const PARISH_COLS = `
  p.lat AS p_lat, p.lng AS p_lng,
  p.name AS parish_name, p.jurisdiction AS parish_jurisdiction,
  p.address AS parish_address, p.website AS parish_website,
  p.logo_path AS parish_logo, p.languages AS parish_languages,
  p.acronym AS parish_acronym, p.color AS parish_color, p.live_url AS parish_live_url
`;

// Map Temporal dayOfWeek (1=Mon..7=Sun) to the schedule convention (0=Sun..6=Sat).
function toScheduleDow(temporalDow) {
  return temporalDow === 7 ? 0 : temporalDow;
}

// Does `date` (YYYY-MM-DD, Sydney local) fall on an occurrence the rule produces?
function isValidOccurrence(s, date) {
  const pd = Temporal.PlainDate.from(date);
  if (toScheduleDow(pd.dayOfWeek) !== s.day_of_week) return false;
  if (!matchesWeekOfMonth(date, s.week_of_month)) return false;
  if (s.effective_from && date < s.effective_from) return false;
  if (s.effective_to && date > s.effective_to) return false;
  return true;
}

// Build, once per window, an index of Sydney-local date strings bucketed by
// day-of-week, plus the window's start/end date strings (for effective-range SQL).
function buildDateIndex(fromUtc, toUtc) {
  const start = Temporal.Instant.from(fromUtc).toZonedDateTimeISO(TZ).toPlainDate();
  const end = Temporal.Instant.from(toUtc).toZonedDateTimeISO(TZ).toPlainDate();
  const byDow = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  let d = start;
  while (Temporal.PlainDate.compare(d, end) <= 0) {
    byDow[toScheduleDow(d.dayOfWeek)].push(d.toString());
    d = d.add({ days: 1 });
  }
  return { byDow, startStr: start.toString(), endStr: end.toString() };
}

// Project one occurrence of a schedule (with optional override) into the event
// shape the API/frontend already expect.
function project(s, date, o) {
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
    start_utc: localToUtc(date, startTime),
    end_utc: endTime ? localToUtc(date, endTime) : null,
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
    // hidden: still computed, but status drops it from the default API filter
    // everywhere (admin can fetch with ?status=hidden). Not a tombstone.
    status: kind === 'cancelled' ? 'cancelled'
          : kind === 'combined'  ? 'combined'
          : kind === 'hidden'    ? 'hidden'
          : 'approved',
    is_tombstone: isTombstone ? 1 : 0,
    combined_into_event_id: (o && o.combined_into_event_id) || null,
    created_at: s.created_at,
    updated_at: o ? o.updated_at : s.created_at,
    // parish passthrough (mirror routes/events.js GET / joins)
    parish_name: s.parish_name,
    jurisdiction: s.parish_jurisdiction,
    parish_address: s.parish_address,
    parish_website: s.parish_website,
    parish_logo: s.parish_logo,
    parish_languages: s.parish_languages,
    parish_acronym: s.parish_acronym,
    parish_color: s.parish_color,
    parish_live_url: s.parish_live_url,
    // dedup metadata (mirrors the old ROW_NUMBER inputs in events.js)
    concurrent: s.concurrent || 0,
    week_of_month: s.week_of_month || null,
  };
}

// Expand all active schedules into instances within [fromUtc, toUtc].
function expandWindow(db, fromUtc, toUtc, { scheduleId = null } = {}) {
  const { byDow, startStr, endStr } = buildDateIndex(fromUtc, toUtc);

  const schedules = db.prepare(`
    SELECT s.*, ${PARISH_COLS}
    FROM schedules s JOIN parishes p ON s.parish_id = p.id
    WHERE s.active = 1 ${scheduleId ? 'AND s.id = ?' : ''}
      AND (s.effective_from IS NULL OR s.effective_from <= ?)
      AND (s.effective_to   IS NULL OR s.effective_to   >= ?)
  `).all(...(scheduleId ? [scheduleId] : []), endStr, startStr);

  const ov = {};
  const ovRows = scheduleId
    ? db.prepare('SELECT * FROM schedule_overrides WHERE schedule_id = ?').all(scheduleId)
    : db.prepare('SELECT * FROM schedule_overrides').all();
  for (const r of ovRows) ov[`${r.schedule_id}:${r.occurrence_date}`] = r;

  const fromMs = Date.parse(fromUtc);
  const toMs = Date.parse(toUtc);
  const out = [];
  for (const s of schedules) {
    for (const date of byDow[s.day_of_week] || []) {
      if (!matchesWeekOfMonth(date, s.week_of_month)) continue;
      const inst = project(s, date, ov[`${s.id}:${date}`]);
      const startMs = Date.parse(inst.start_utc);
      if (startMs < fromMs || startMs > toMs) continue;
      out.push(inst);
    }
  }
  return out;
}

// Resolve a single synthetic instance id "scheduleId:YYYY-MM-DD" (for GET /:id).
function expandOne(db, scheduleId, date) {
  const s = db.prepare(`
    SELECT s.*, ${PARISH_COLS}
    FROM schedules s JOIN parishes p ON s.parish_id = p.id
    WHERE s.id = ?
  `).get(scheduleId);
  if (!s || !s.active) return null;
  if (!isValidOccurrence(s, date)) return null;

  const o = db.prepare(
    'SELECT * FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?'
  ).get(scheduleId, date);
  return project(s, date, o);
}

// Parse a synthetic instance id. Returns { scheduleId, date } or null.
function parseInstanceId(id) {
  const str = String(id);
  const i = str.indexOf(':');
  if (i === -1) return null;
  const scheduleId = Number(str.slice(0, i));
  const date = str.slice(i + 1);
  if (!Number.isInteger(scheduleId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { scheduleId, date };
}

module.exports = { expandWindow, expandOne, parseInstanceId, project, localToUtc, isValidOccurrence };
