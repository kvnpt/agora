-- 030 — a subtitle for one-off events and for rules
--
-- Only a date of a regular service had a line under its title
-- (schedule_overrides.patch_feast): the saint of that Sunday. A one-off had
-- none, so publishing a poster's "Matins and Divine Liturgy" with its
-- commemoration glued the two together — "Matins and Divine Liturgy — Holy
-- Protection of the Theotokos" — and a rule had none either, so St John the
-- Baptist's men's group was titled "Men's Group - St. Joseph the Betrothed".
--
-- The column is called `feast`, as draft_events' and the override's are, but
-- it is any subtitle: the saint or feast of the day, or the week's topic.
-- A date's patch_feast wins over its rule's (public/shared/project.mjs).
--
-- New nullable columns, appended, so applying this before the merge is always
-- safe: nothing deployed reads them yet, and the bundle's `e.*`/`s.*` only
-- carry one more null.

ALTER TABLE schedules ADD COLUMN feast TEXT;
ALTER TABLE events ADD COLUMN feast TEXT;
