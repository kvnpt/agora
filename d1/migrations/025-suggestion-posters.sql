-- 025 — a poster on a suggested event
--
-- Somebody suggesting an event under "Suggest edits" can add its poster, and
-- Claude reads it into the form. One row per upload: the daily limit on reads,
-- which suggestion it went with, and the sweep of posters nobody sent. See
-- worker/lib/suggestions.mjs and the comment in d1/schema.sql.
--
-- A new table, so it is safe to apply before the merge — nothing deployed
-- reads it yet. The Worker also creates it IF NOT EXISTS on first use, with
-- this same DDL, so applying it late fails nothing either.

CREATE TABLE IF NOT EXISTS suggestion_posters (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  parish_id     TEXT NOT NULL REFERENCES parishes(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  poster_path   TEXT,
  suggestion_id INTEGER,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_suggestion_posters_email ON suggestion_posters(email, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_suggestion_posters_suggestion ON suggestion_posters(suggestion_id);
