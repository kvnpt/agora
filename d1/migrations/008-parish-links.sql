-- 008 — parish_links
--
-- A parish gets four short links because `parishes` has four columns for them:
-- /<acronym>/donate, /raffle, /payment, /gala. Those are the four every parish
-- was asked for and not the four every parish has — a festival, a building
-- fund, a bookstall, a form for a baptism enquiry — and a column each is a
-- migration each, with the answer still no the next time somebody asks.
--
-- One row per extra link instead. worker/index.mjs resolves it after the four
-- fixed kinds, and the slug is checked against the same reserved list an
-- acronym is, because /smg/liturgy has to keep meaning the service.
--
--   npx wrangler d1 execute agora --remote --file=d1/migrations/008-parish-links.sql
--
-- Nothing is inserted: an empty table means every parish has exactly the links
-- it has today, and the four columns are untouched.

CREATE TABLE IF NOT EXISTS parish_links (
  parish_id  TEXT NOT NULL REFERENCES parishes(id) ON DELETE CASCADE,
  slug       TEXT NOT NULL,
  label      TEXT,
  url        TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (parish_id, slug)
);
