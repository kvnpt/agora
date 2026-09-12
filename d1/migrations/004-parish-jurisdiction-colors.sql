-- 004 — every parish takes its jurisdiction's colour
--
-- A one-time transform, not a rule the database enforces. `parishes.color`
-- stays writable and per-parish; this is a baseline for the ~200 rows that
-- never had one set.
--
-- Two directory imports wrote `color: null` for every parish they added
-- (scripts/build-antiochian-sql.mjs, scripts/build-rocor-sql.mjs), on the
-- reasoning in scripts/parish-import.mjs that a colour is set by people and
-- not by a scrape. That was right about provenance and wrong about the
-- result: production's 196 parishes came from those imports, so almost every
-- parish card and feed line has been falling back to a grey default. Filling
-- them in by jurisdiction is the answer that needs no per-parish decision and
-- is already what the map draws.
--
-- The seeded rows are updated too. Their colours were close but not equal to
-- the app's table — the seed's Greek was #0d5eaf, the app's #00508f — and
-- after this the two agree by construction, since the seed now reads the
-- shared table (public/shared/jurisdiction-colors.js).
--
-- THE HEXES BELOW ARE A SNAPSHOT of that table as of this migration. They are
-- not a second source of truth: a later change to a jurisdiction's colour
-- edits the table and, if existing rows should follow, gets its own migration.
-- This file is history and stays as it is.
--
--   npx wrangler d1 execute agora --remote --file=d1/migrations/004-parish-jurisdiction-colors.sql
--
-- Reversible only from a backup — the previous values are mostly NULL, but the
-- eleven seeded rows had colours. `npm run db:export` before running it, or
-- lean on D1 Time Travel.

UPDATE parishes SET color = CASE jurisdiction
  WHEN 'antiochian' THEN '#1e3a5f'
  WHEN 'greek'      THEN '#00508f'
  WHEN 'serbian'    THEN '#b22234'
  WHEN 'russian'    THEN '#c8a951'
  WHEN 'romanian'   THEN '#002b7f'
  WHEN 'macedonian' THEN '#d20000'
  -- 'other' — the neutral grey the app already falls back to, rather than a
  -- colour invented for a jurisdiction that has no flag of its own.
  ELSE '#888888'
END
-- The sentinel row events fall back to when they have no parish. It is not a
-- parish and never renders as one, so it keeps its NULL.
WHERE id != '_unassigned';
