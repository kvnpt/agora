-- 006 — jurisdiction_colors
--
-- Six jurisdiction colours were chosen one at a time, in code, and had never
-- been looked at together. /admin grows a tab that shows them side by side and
-- lets them be adjusted against each other, which needs somewhere to keep an
-- adjustment that is not a deploy.
--
-- It is an OVERRIDE table, not the colour table. public/shared/
-- jurisdiction-colors.js is still where a colour is written down, still what
-- the seed and the tests read, and still what a row's absence here means. Same
-- shape as adapter_settings: the file is the default, the row is a decision.
--
--   npx wrangler d1 execute agora --remote --file=d1/migrations/006-jurisdiction-colors.sql
--
-- Nothing is inserted. An empty table is the correct starting state — every
-- jurisdiction renders the file's colour until somebody changes one — and it
-- also means this migration can be applied before or after the deploy that
-- reads it, in either order, with no window where the site is wrong. The
-- Worker treats a missing table as no overrides for the same reason.

CREATE TABLE IF NOT EXISTS jurisdiction_colors (
  jurisdiction TEXT PRIMARY KEY CHECK(jurisdiction IN
                 ('antiochian','greek','serbian','russian','romanian','macedonian','other')),
  color        TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
