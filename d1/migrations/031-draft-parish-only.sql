-- 031 — the Add event card's Public / Parish only pill
--
-- The edit forms have had a Parish only control all along (a tickbox, a pill
-- since #158), but a card on the Add event card had none: publishing left it
-- to the kind, so an Other went out Parish only and anything else public, with
-- no way to say otherwise until it was published and edited.
--
-- 1 or 0 once somebody taps the card's pill; NULL while nobody has, which
-- publishing still leaves to the kind. A new nullable column, appended, so
-- applying it before the merge is safe: nothing deployed names it yet.

ALTER TABLE draft_events ADD COLUMN parish_scoped INTEGER;
