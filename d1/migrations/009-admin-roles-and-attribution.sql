-- 009 — admin_roles, admin_proposals, pdf_source_overrides, and per-row attribution
--
-- WRITTEN AFTER THE FACT. All of this was applied to production on
-- 17 September 2026 from docs/admin-panel.md, one `wrangler d1 execute
-- --command` at a time, and never landed here. That is the failure this
-- directory's README names in its first paragraph: the baseline moved, the
-- live database moved with it, and the migrations directory recorded neither,
-- so a database rebuilt from 001–008 would have been three tables and five
-- columns short of the one the Worker talks to.
--
-- It is written idempotently so re-applying it is safe, and so a database that
-- already took the statements from the doc can run it and learn nothing.
--
--   npx wrangler d1 execute agora --remote --file=d1/migrations/009-admin-roles-and-attribution.sql
--
-- `ALTER TABLE ... ADD COLUMN` has no IF NOT EXISTS in SQLite, so the five
-- ALTERs below WILL fail on a database that already has them, with "duplicate
-- column name". That error means the column is there and nothing is wrong —
-- the same note the README makes about 003 and 005. Run the CREATEs first if
-- you would rather not read an error.

CREATE TABLE IF NOT EXISTS pdf_source_overrides (
  source_key  TEXT PRIMARY KEY,
  source_url  TEXT NOT NULL,
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS admin_roles (
  email      TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK(role IN ('owner','editor','parish')),
  parish_ids TEXT,
  note       TEXT,
  added_by   TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS admin_proposals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  capability  TEXT NOT NULL CHECK(capability IN ('parish.delete','parish.acronym','colors.edit')),
  subject     TEXT NOT NULL,
  payload     TEXT NOT NULL,
  reason      TEXT,
  status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','approved','declined','withdrawn')),
  proposed_by TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  decided_by  TEXT,
  decided_at  TEXT,
  decision_note TEXT
);

CREATE INDEX IF NOT EXISTS idx_admin_proposals_open ON admin_proposals(status, created_at DESC);

-- Who last touched a row, and when. The panel renders it on the Changes tab;
-- before this, an edit left no trace at all, which is tolerable with one admin
-- and not with several.
ALTER TABLE parishes ADD COLUMN updated_at TEXT;
ALTER TABLE parishes ADD COLUMN updated_by TEXT;
ALTER TABLE schedules ADD COLUMN updated_at TEXT;
ALTER TABLE schedules ADD COLUMN updated_by TEXT;
ALTER TABLE schedule_overrides ADD COLUMN updated_by TEXT;
