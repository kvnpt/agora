-- 040 — a person's own calendar link
--
-- One private link per account (/saved/<token>.ics), which a phone subscribes
-- to once and which follows what the person Saves (worker/lib/calendar-links.mjs).
-- A new table, so applying this before the merge is safe: nothing deployed
-- names it yet. The Worker also creates it IF NOT EXISTS on first use.

CREATE TABLE IF NOT EXISTS calendar_links (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
