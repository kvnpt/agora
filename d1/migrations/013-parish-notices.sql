-- 013 — a parish contact learns what was done to their parish
--
-- A combine is the one write whose target is not the parish in the URL: an
-- `event_parishes` row lists another parish's event at your church, and a
-- 'combined' override turns your Sunday into a tombstone pointing at it. An
-- owner may do both without asking. The parish it happens to should still find
-- out from the panel rather than from noticing their own Sunday struck through.
--
-- The notice is DERIVED from the rows that already exist — nothing is written
-- when a combine happens. The only thing that cannot be derived is whether a
-- person has looked, which is what this table holds.
--
--   npx wrangler d1 execute agora --remote --file=d1/migrations/013-parish-notices.sql
--
-- `CREATE TABLE` without IF NOT EXISTS, so a second run errors with "table
-- already exists" — which means it is applied.

CREATE TABLE parish_notices_seen (
  parish_id TEXT NOT NULL REFERENCES parishes(id) ON DELETE CASCADE,
  event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  seen_by   TEXT NOT NULL,
  seen_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (parish_id, event_id, seen_by)
);
