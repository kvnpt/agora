-- 042 — groups, and rows with no place to visit
--
-- Agora's rows were all places: a dot on the map, a distance, a city. Some
-- things people look for are not. The Orthodox Run Club, ACOY and the uni
-- groups have a card, links and events, and meet wherever each event says;
-- the Monastery of the Archangel Michael, Marrickville takes no visitors and
-- has a PO Box for an address.
--
--   kind        'parish' (default) or 'body'
--   body_type   for a body: 'youth', 'campus' or 'community'
--   has_place   0 = no pin in public: pinSql in public/shared/parish-join.mjs
--
-- Why not NULL lat/lng: SQLite cannot drop a NOT NULL without rebuilding the
-- table, and dropping `parishes` cascade-deletes every parish_links row
-- (README.md: a rebuild of this table is a larger risk than what it fixes).
-- So the point stays stored and nothing public reads it.
--
-- Safe before the merge: three appended columns with defaults, which nothing
-- deployed names. The UPDATE marks the run club, the first body; deployed
-- code ignores it until this branch ships.
--
-- Not idempotent: a second run fails on `duplicate column name`, which
-- means it has already been applied. The UPDATE is safe to re-run.

ALTER TABLE parishes ADD COLUMN kind TEXT NOT NULL DEFAULT 'parish';
ALTER TABLE parishes ADD COLUMN body_type TEXT;
ALTER TABLE parishes ADD COLUMN has_place INTEGER NOT NULL DEFAULT 1;

UPDATE parishes SET kind = 'body', body_type = 'community', has_place = 0
WHERE id = 'other-orthodox-run-club' AND kind = 'parish';
