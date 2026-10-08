-- 018 — drafts: an event somebody is still adding
--
-- The add-event editor saves every edit as a draft, and only Publish writes
-- `events`. A poster read by Claude lands here too, so it is on file before
-- anybody has checked it without being on the site. d1/schema.sql says why
-- these are tables of their own rather than a status on `events`.
--
-- New tables, so applying this before the merge is always safe: nothing
-- deployed reads them yet. worker/lib/drafts.mjs also creates them IF NOT
-- EXISTS on first use, with this same DDL, so applying it late fails nothing.

CREATE TABLE IF NOT EXISTS drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  parish_id   TEXT NOT NULL REFERENCES parishes(id) ON DELETE CASCADE,
  poster_path TEXT,
  read_status TEXT CHECK(read_status IN ('reading','read','failed')),
  read_kind   TEXT,
  read_notes  TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_drafts_parish ON drafts(parish_id);

CREATE TABLE IF NOT EXISTS draft_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id          INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL DEFAULT 0,
  title             TEXT,
  date              TEXT,
  start_time        TEXT,
  end_time          TEXT,
  event_type        TEXT,
  description       TEXT,
  languages         TEXT,
  location_override TEXT,
  also_at           TEXT,
  replaces          TEXT,
  ask_reason        TEXT,
  printed_weekday   TEXT,
  year_printed      INTEGER,
  read_notes        TEXT,
  read_fields       TEXT,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_draft_events_draft ON draft_events(draft_id, position);
