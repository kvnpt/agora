-- 033 — the bin on a draft card's row
--
-- A poster's cards were removed one at a time with "Remove this event", which
-- deleted the card there and then. Kevin (3 Nov 2026) asked for a bin on the
-- collapsed row instead that marks a card to be thrown away and can unmark
-- it, with a date that has already passed marked from the start.
--
-- 1 marked, 0 kept, NULL while nobody has tapped it (the editor then marks it
-- if its date has passed). A new nullable column, appended, so applying it
-- before the merge is safe: nothing deployed names it yet. The Worker adds it
-- itself if it is missing (drafts.mjs ensureDraftTables).

ALTER TABLE draft_events ADD COLUMN discard INTEGER;
