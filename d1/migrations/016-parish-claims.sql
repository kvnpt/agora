-- 016 — "Is this your parish?" claims
--
-- A signed-in person (Cloudflare Access verified the address) asking to keep
-- one parish's page right; an owner approving it grants a parish role in
-- admin_roles. See worker/lib/claims.mjs.
--
-- A new table, so it is safe to apply before the merge — nothing deployed
-- reads it yet. The Worker also creates it IF NOT EXISTS on first use, with
-- this same DDL, so applying it late fails nothing either.

CREATE TABLE IF NOT EXISTS parish_claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  parish_id     TEXT NOT NULL REFERENCES parishes(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  name          TEXT NOT NULL,
  relation      TEXT,
  phone         TEXT,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','approved','declined','withdrawn')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  decided_by    TEXT,
  decided_at    TEXT,
  decision_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_parish_claims_open ON parish_claims(status, created_at);
