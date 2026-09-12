-- 004 — every parish takes its jurisdiction's colour
--
-- A one-time transform, not a rule the database enforces. `parishes.color`
-- stays writable and per-parish; this is a baseline for the ~200 rows that
-- never had one set.
--
-- What production actually held the moment before this ran, measured rather
-- than assumed — the guess going in was wrong in an instructive way:
--
--    135  greek       #0d5eaf     the seed's Greek, not the app's
--     37  russian     NULL
--     14  antiochian  NULL
--      9  antiochian  #1e3a5f     the seeded rows, already correct
--      1  antiochian  #000000     one row set to black by hand
--
-- Two things to fix, then. Fifty-one parishes had no colour at all: the ROCOR
-- and Antiochian directory imports wrote `color: null` on the reasoning in
-- scripts/parish-import.mjs that a colour is set by people and not by a
-- scrape, which was right about provenance and left those cards falling back
-- to grey. And the 135 Greek rows carried #0d5eaf while the app drew #00508f
-- from its own table — the same drift that put the colour table in one file
-- (public/shared/jurisdiction-colors.js), visible here at scale.
--
-- Filling every row in by jurisdiction settles both, needs no per-parish
-- decision, and is already what the map draws. The seed reads that shared
-- table now, so a fresh database and this one agree by construction.
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
