-- 022 — draft_events.end_date: one event over several days
--
-- An event had a date and two times, and an end before its start was read as
-- "after midnight". A festival from Friday 6pm to Sunday 4pm could not be
-- typed at all. A draft card now has a last day; the end time applies to it,
-- and publishing writes the later end_utc it makes (localSpanToUtc). `events`
-- needs nothing: end_utc was always an instant.
--
-- A nullable column, appended, so applying this before the merge is always
-- safe; worker/lib/drafts.mjs also adds it on first use when it is missing.

ALTER TABLE draft_events ADD COLUMN end_date TEXT;
