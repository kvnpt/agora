-- 024 — "Suggest edits"
--
-- Somebody signed in (Cloudflare Access verified the address) telling whoever
-- keeps a parish that something on its page is wrong, or that an event is
-- coming up it does not show. A message for a person to act on, never an edit
-- waiting to apply. See worker/lib/suggestions.mjs.
--
-- A new table, so it is safe to apply before the merge — nothing deployed
-- reads it yet. The Worker also creates it IF NOT EXISTS on first use, with
-- this same DDL, so applying it late fails nothing either.

CREATE TABLE IF NOT EXISTS parish_suggestions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  parish_id     TEXT NOT NULL REFERENCES parishes(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  name          TEXT,
  kind          TEXT NOT NULL CHECK(kind IN ('change','event')),
  about         TEXT,
  body          TEXT,
  title         TEXT,
  date          TEXT,
  start_time    TEXT,
  end_time      TEXT,
  place         TEXT,
  link          TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','dismissed','withdrawn')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  decided_by    TEXT,
  decided_at    TEXT,
  decision_note TEXT,
  draft_id      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_parish_suggestions_open ON parish_suggestions(status, parish_id, created_at);
