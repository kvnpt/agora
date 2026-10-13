-- 026 — parishes.color, dropped
--
-- A parish wears its jurisdiction's colour: /admin's override in
-- jurisdiction_colors, over public/shared/jurisdiction-colors.js. The column
-- was a copy of that, taken once (migration 004) and never refreshed, so it
-- went stale under the 49 Macedonian and Romanian parishes whose jurisdictions
-- /admin repainted, and the lite pages — the last reader — showed them in the
-- old colours. docs/architecture.md, "Parishes have no colour of their own".
--
-- THE OTHER WAY ROUND from every migration before it. Apply this AFTER the
-- deploy that stopped reading the column ("Nothing reads or writes
-- parishes.color"), never before: until that deploy, /api/bundle SELECTs
-- p.color, and dropping it first fails the site's whole feed.
-- docs/database.md, "A DROP is the other way round".
--
-- Not reversible by re-adding the column: nothing would refill it, and nothing
-- would read it.

ALTER TABLE parishes DROP COLUMN color;
