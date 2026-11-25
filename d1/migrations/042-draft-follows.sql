-- 042 — what a draft card follows, kept
--
-- An event "after the Liturgy" starts when that Liturgy ends, and is never
-- that Sunday's Liturgy (drafts.mjs afterServices). The reader says what it
-- follows, but nothing kept it once the read was merged into the cards. A
-- draft whose parish is picked by hand — a WhatsApp forward that started at
-- no parish, or a poster dropped at the wrong one — is now squared with the
-- parish it moves to (draft-read.mjs squareMoved), and needs it: to work the
-- time out from that parish's timetable, and to keep the card off that
-- service's date.
--
-- A new nullable column, appended, so applying this before the merge is safe:
-- nothing deployed names it yet. The Worker adds it itself if it is missing
-- (drafts.mjs ensureDraftTables).

ALTER TABLE draft_events ADD COLUMN follows TEXT;
