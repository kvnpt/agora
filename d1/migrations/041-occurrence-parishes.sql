-- 041 — other parishes at one date of a service
--
-- A combine used to hang on a stored event only (event_parishes, and a
-- 'combined' override's combined_into_event_id). A date of a service is
-- projected from its rule and never stored, so nothing could say that St
-- Spyridon takes part in St Catherine's Sunday Liturgy on the 25th, or that
-- St Spyridon's own Liturgy that morning is held there instead.
--
--   occurrence_parishes         the parishes taking part in one date of a
--                               rule, as event_parishes is for an event
--   combined_into_schedule_id   a 'combined' override pointing at a date of
--   combined_into_date          a service rather than at an event
--
-- Applying this before the merge is safe: nothing deployed names the table or
-- the two columns yet. Both columns are appended, as ALTER appends, and
-- d1/schema.sql has them last.

CREATE TABLE IF NOT EXISTS occurrence_parishes (
  schedule_id     INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  occurrence_date TEXT NOT NULL,
  parish_id       TEXT NOT NULL REFERENCES parishes(id),
  PRIMARY KEY (schedule_id, occurrence_date, parish_id)
);
CREATE INDEX IF NOT EXISTS idx_occurrence_parishes_parish ON occurrence_parishes(parish_id);

ALTER TABLE schedule_overrides ADD COLUMN combined_into_schedule_id INTEGER REFERENCES schedules(id) ON DELETE CASCADE;
ALTER TABLE schedule_overrides ADD COLUMN combined_into_date TEXT;
CREATE INDEX IF NOT EXISTS idx_overrides_combined_occ ON schedule_overrides(combined_into_schedule_id, combined_into_date);
