-- 010 — info_overrides
--
-- Which source wins when several of them describe the same parish. The ladder
-- itself lives in public/shared/source-tiers.js:
--
--   admin > parish site/social > jurisdiction directory > search > directory
--
-- and this table holds the rulings made against it — one row per parish per
-- fact, and only where somebody has deliberately decided something.
--
-- WHAT IT FIXES TODAY. St Mary Magdalene, Elimbah has two Vespers on its
-- Antiochian directory page that have not run for years, confirmed by
-- telephone, and both rules were deleted in /admin. Re-running
-- scripts/build-antiochian-schedules.mjs would have recreated them: it pairs a
-- scraped rule to an existing row on parish + weekday + time, a deleted row
-- has nothing to pair with, and the insert guard only asks whether the rule
-- exists now. The deletion had nowhere to live. Now it does, and the panel and
-- the import plan both say so out loud.
--
--   npx wrangler d1 execute agora --remote --file=d1/migrations/010-info-overrides.sql
--
-- Empty means nothing has been decided and every import behaves exactly as it
-- did before, so the order against the deploy does not matter — the same
-- property jurisdiction_colors and pdf_source_overrides have, and for the same
-- reason: the table holds exceptions, never defaults.

CREATE TABLE IF NOT EXISTS info_overrides (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  parish_id    TEXT NOT NULL REFERENCES parishes(id) ON DELETE CASCADE,
  target       TEXT NOT NULL CHECK(target IN ('field','schedule')),
  subject      TEXT NOT NULL,
  decision     TEXT NOT NULL CHECK(decision IN ('pin','suppress')),
  tier         TEXT NOT NULL CHECK(tier IN ('admin','parish','jurisdiction','search','directory')),
  source_label TEXT,
  source_name  TEXT,
  source_ref   TEXT,
  checked_at   TEXT,
  note         TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_by   TEXT,
  UNIQUE(parish_id, target, subject),
  CHECK(decision = 'pin' OR target = 'schedule')
);

CREATE INDEX IF NOT EXISTS idx_info_overrides_parish ON info_overrides(parish_id, target);
