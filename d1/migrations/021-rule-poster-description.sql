-- 021 — a rule's own poster and description
--
-- A rule had neither: "a weekly liturgy has no flyer", so a poster could only
-- sit on an occurrence (schedule_overrides.patch_poster_path) or a range of
-- them, and a description only on one date. That was right for a bulletin —
-- next month's Liturgy must not carry this month's commemorations — and wrong
-- for the flyer of something that simply happens every week: "Church Choir
-- Practice, 7pm every Tuesday, led by Simon Yazbek, all are welcome" describes
-- the RULE. Put on a range it ran out; put on one date it was gone by the next.
--
-- So a rule may carry both. Every occurrence shows them unless its own
-- override says otherwise (public/shared/project.mjs), and a poster here
-- counts as using its R2 object (worker/lib/poster-range.mjs releaseUnused).
--
-- New nullable columns, appended, so applying this before the merge is always
-- safe: nothing deployed reads them yet.

ALTER TABLE schedules ADD COLUMN poster_path TEXT;
ALTER TABLE schedules ADD COLUMN description TEXT;
