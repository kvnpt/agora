-- 029 — what a signed-in person keeps
--
-- Favourites, lists of parishes, bookmarks and saved views lived only in the
-- browser's localStorage. Signed in, they are kept on the account too: one row
-- per address Access verified (lower-cased), the four parts as one JSON
-- document. public/shared/saved.js says what a valid one is;
-- worker/lib/saved-items.mjs has the why.
--
-- A new table, so it is safe to apply before the merge — nothing deployed
-- reads it yet. The Worker also creates it IF NOT EXISTS on first use, with
-- this same DDL, so applying it late fails nothing either.

CREATE TABLE IF NOT EXISTS saved_items (
  email      TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
