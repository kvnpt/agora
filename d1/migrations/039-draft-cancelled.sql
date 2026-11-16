-- 039 — a draft card that calls a date of a regular service off
--
-- The last piece of the bulletin ingest (docs/roadmap.md, phase 1): a
-- programme's "No Liturgy on Sunday 25 January". The reader had no field for
-- it, so it came back as a note, or as nothing, and the Liturgy stayed on the
-- page for somebody to turn up to. Now the card is that service on that date
-- with `cancelled` set, and publishing writes the tombstone on the occurrence.
--
-- cancelled: 1 as the poster was read — which nothing publishes, because a
--            false one keeps somebody from a service that is running;
--            2 once a person has confirmed it; 0 when they say it is on.
-- A new nullable column, appended, so applying this before the merge is safe:
-- nothing deployed names it yet. The Worker adds it itself if it is missing
-- (drafts.mjs ensureDraftTables).

ALTER TABLE draft_events ADD COLUMN cancelled INTEGER;
