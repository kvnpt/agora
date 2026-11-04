-- 035 — a service that differs on some weeks of the month
--
-- Mount Pritchard's 9am Matins & Liturgy is in Arabic and English every
-- Sunday but the last, which is in English and ends at 11:30. St Sava,
-- Homebush West holds its 10am Liturgy in Serbian, and in English on the 1st
-- Sunday. Both were written as two rules sharing a time (34 + 185, 117 + 119),
-- which only worked while the two kept the same title and time, and at
-- Homebush West, where they did not, the 1st Sunday showed two Liturgies.
--
-- `schedule_week_exceptions` is to a WEEK OF THE MONTH what schedule_overrides
-- is to a DATE: one row, on one rule, that changes how its dates on those
-- weeks are held ("modified": the patch_* fields, NULL for "as the service"),
-- or says they are not held at all ("not_held"). Projected like the rule it
-- belongs to (public/shared/project.mjs), never written out per date. A
-- date's own override still wins on its date.
--
-- `weeks` is week_of_month's vocabulary (first,second,third,fourth,last;
-- recurrence.mjs). Its own table, not schedule_overrides with no date, for
-- the reason schedule_breaks is: that table's UNIQUE(schedule_id,
-- occurrence_date) and its CHECK on kind cannot change without a rebuild, and
-- tombstone.mjs withdraws adapter rows there, which a person's pattern must
-- never be.
--
--   npx wrangler d1 execute agora --remote --file=d1/migrations/035-week-exceptions.sql
--

CREATE TABLE schedule_week_exceptions (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id              INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  weeks                    TEXT NOT NULL,
  kind                     TEXT NOT NULL CHECK(kind IN ('modified','not_held')),
  patch_title              TEXT,
  patch_start_time         TEXT,
  patch_end_time           TEXT,
  patch_languages          TEXT,
  patch_feast              TEXT,
  patch_description        TEXT,
  patch_location_override  TEXT,
  patch_location_parish_id TEXT,
  patch_location_lat       REAL,
  patch_location_lng       REAL,
  created_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at               TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_by               TEXT
);

CREATE INDEX idx_week_exceptions_schedule ON schedule_week_exceptions(schedule_id);
