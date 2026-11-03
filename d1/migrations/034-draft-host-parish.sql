-- 034 — a draft card that is another parish's event, which this one takes part in
--
-- St Andrew, Gladesville's November 2026 programme listed St Nectarios,
-- Burwood's feast on the 9th, at Burwood. Read at Gladesville it became
-- Gladesville's own event at a place called "St Nectarios Church, Burwood",
-- and was moved to Burwood by hand, with Gladesville taking part. Kevin
-- (3 Nov 2026) asked for the reader to do that itself: set the parish as
-- taking part in the event already on file there, or add it there when it
-- is not, and ask what it replaces at home.
--
-- host_parish_id: whose event it is, when not the draft's parish's.
-- host_event_id:  their event already on file that the card joins.
-- New nullable columns, appended, so applying this before the merge is safe:
-- nothing deployed names them yet. The Worker adds them itself if they are
-- missing (drafts.mjs ensureDraftTables).

ALTER TABLE draft_events ADD COLUMN host_parish_id TEXT;
ALTER TABLE draft_events ADD COLUMN host_event_id INTEGER;
