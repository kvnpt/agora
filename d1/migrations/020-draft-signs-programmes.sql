-- 020 — drafts: what a church sign or a month's programme is read into
--
-- The poster reader read only events. Two images it is now given are not:
--
--   * the sign out the front of a church ("Saturdays 8.00–10.00 am, Sundays
--     8.00–11.00 am, Orthros & Divine Liturgy", with the phone number) — the
--     parish's regular services and its details. Read into read_services and
--     read_details as proposals, which a person adds one by one;
--   * a month's programme that gives every Saturday's and Sunday's Liturgy
--     with its saint — changes to those services' own dates, not new events.
--     A card matched to one carries its `occurrence` and the `feast`, and
--     publishing it writes an override.
--
-- read_language records what the image was written in when it was not
-- English: the read is in English, and the editor says it translated.
--
-- New nullable columns, appended, so applying this before the merge is always
-- safe: nothing deployed reads them yet. worker/lib/drafts.mjs also adds them
-- on first use when they are missing, so applying it late fails nothing either.

ALTER TABLE drafts ADD COLUMN read_language TEXT;
ALTER TABLE drafts ADD COLUMN read_services TEXT;
ALTER TABLE drafts ADD COLUMN read_details TEXT;
ALTER TABLE draft_events ADD COLUMN occurrence TEXT;
ALTER TABLE draft_events ADD COLUMN feast TEXT;
