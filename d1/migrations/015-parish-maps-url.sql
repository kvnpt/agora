-- 015 — a parish's Google Maps entry
--
-- The parish sheet's Directions button became "Google Maps", opening the place
-- rather than starting navigation. A picked place entry (name, photos, the
-- entrance Google routes to) beats the bare pin it sits on, so it is stored when
-- somebody chooses one; NULL keeps the old behaviour of opening lat/lng.
--
-- Additive and nullable: the deployed code does not read it until the branch
-- that adds it is merged, so this is safe to apply first — and must be, because
-- the parish PATCH names it.

ALTER TABLE parishes ADD COLUMN maps_url TEXT;
