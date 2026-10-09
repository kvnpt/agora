-- 019 — drafts.read_parish: whose poster the reader says it is
--
-- A poster dropped at the wrong parish — St Elias, Wollongong's youth night,
-- dropped while the editor had another parish open — was read correctly, and
-- the reader said so in a note, but the draft could not be moved. The reader
-- now answers "whose poster is this" in its own field; this column keeps the
-- answer (JSON {name, place, parish_id}) so the editor can offer to move the
-- draft there, today and when the draft is continued later.
--
-- A new nullable column, appended, so applying this before the merge is always
-- safe: nothing deployed reads it yet. worker/lib/drafts.mjs also adds it on
-- first use when it is missing, so applying it late fails nothing either.

ALTER TABLE drafts ADD COLUMN read_parish TEXT;
