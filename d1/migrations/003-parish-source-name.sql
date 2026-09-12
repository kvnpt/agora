-- 003 — parishes.info_source_name
--
-- A URL is not a name. `info_source_ref` already records where a parish's
-- details came from, but for an imported parish it is a hundred characters of
-- directory path, which answers "where did this come from" only for somebody
-- who reads URLs for a living. This is the short label to show instead.
--
-- Applied with wrangler, not pasted into the dashboard console:
--
--   npx wrangler d1 execute agora --remote --file=d1/migrations/003-parish-source-name.sql
--
-- which is why this one is a plain .sql with its comments intact, unlike 001
-- and 002. See README.md.

ALTER TABLE parishes ADD COLUMN info_source_name TEXT;
