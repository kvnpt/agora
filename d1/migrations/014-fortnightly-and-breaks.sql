-- 014 — the fortnight, and the break
--
-- TWO things a recurring service does that the schema had no way to say.
--
-- ── schedules.week_parity ────────────────────────────────────────────────
--
-- A fortnightly service. `week_of_month` is the only qualifier a rule has had,
-- and it cannot spell one: docs/parish-ingestion.md records Coburg's Compline
-- and its Youth Group, which both alternate with St Vasilios Brunswick, being
-- DROPPED during ingestion rather than written as month positions that would
-- put a service at Coburg on the Tuesdays it is at Brunswick. infer.mjs makes
-- the same argument from the other end: it detects a fortnightly series, finds
-- that 'second,last' fits the observed dates exactly, and withholds the rule
-- anyway, because that spelling omits the 22 November Good Shepherd's
-- FOUNDATIONS course actually runs and invents two in December.
--
-- 'a' or 'b' — which of the two alternating weeks. NOT a start date. The only
-- date-ish field on the row is `effective_from`, which is a validity window,
-- and making it double as the fortnight's phase would mean recording a rule's
-- history silently moved which week the service falls on. All 103 rules in
-- production have it NULL, so they would have had no phase at all.
--
-- Which weeks are A is public/shared/recurrence.mjs's table, per ISO year
-- through 2126, generated so the alternation carries across a 53-week year —
-- 3 January 2027 is 2026-W53 and 10 January is 2027-W01, both odd, and a bare
-- "odd weeks" reading gives a fortnightly service a seven-day gap there.
--
-- NOT CHECK-constrained, deliberately, and neither is its exclusivity with
-- week_of_month. SQLite cannot add a CHECK without rebuilding the table, and
-- `schedules` must not be rebuilt: schedule_overrides.schedule_id references it
-- ON DELETE CASCADE, so dropping it would cascade-delete every override on the
-- way through. Migration 011 did rebuild a table and its README entry says in
-- terms that it is not a precedent. The routes validate instead, the way
-- VALID_WEEKS already does for week_of_month.
--
-- ── schedule_breaks ──────────────────────────────────────────────────────
--
-- A stretch of dates a service is not running: a parish shut between Christmas
-- and Theophany, a hall closed for works, a priest away for a month.
--
-- One row per decision, not one per date. A six-week break on a daily rule
-- would be forty-two schedule_overrides rows, editing the window would mean
-- deleting and rewriting them, UNIQUE(schedule_id, occurrence_date) would
-- clobber any per-date override already there, and nothing would record that
-- the forty-two were one decision with one reason. It is to a RANGE what
-- schedule_overrides is to a DATE.
--
-- Its own table rather than a new schedule_overrides.kind for two reasons: that
-- CHECK cannot be extended without the rebuild above, and tombstone.mjs
-- withdraws an adapter's cancellation when a service reappears in a scrape. A
-- break is a person's decision about the future and must not be withdrawable by
-- a scrape that cannot see it — living outside that table makes it immune by
-- construction rather than by a guard somebody has to remember.
--
-- `schedule_id` NULL means EVERY rule at the parish, which is the common case:
-- a parish shutting for Christmas shuts all of it, and naming each rule would
-- be a row per service and one of them forgotten.
--
--   npx wrangler d1 execute agora --remote --file=d1/migrations/014-fortnightly-and-breaks.sql
--
-- `ALTER TABLE ... ADD COLUMN` is not idempotent in SQLite — a second run
-- errors with "duplicate column name", which means it is already applied.

ALTER TABLE schedules ADD COLUMN week_parity TEXT;

CREATE TABLE IF NOT EXISTS schedule_breaks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  parish_id   TEXT NOT NULL REFERENCES parishes(id),

  -- NULL = every rule at this parish. Set = that one rule.
  schedule_id INTEGER REFERENCES schedules(id) ON DELETE CASCADE,

  -- 'YYYY-MM-DD' LOCAL to the parish, inclusive at both ends — the same date
  -- space schedule_overrides.occurrence_date joins on.
  from_date   TEXT NOT NULL,
  to_date     TEXT NOT NULL,

  -- Why. NOT NULL for the reason info_overrides.note is: a service that is off
  -- with no reason given is indistinguishable from a mistake, and this one is
  -- rendered on the card a visitor reads, so it is the whole of what they are
  -- told.
  note        TEXT NOT NULL,

  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_by  TEXT,

  CHECK (to_date >= from_date)
);

CREATE INDEX IF NOT EXISTS idx_breaks_parish   ON schedule_breaks(parish_id);
CREATE INDEX IF NOT EXISTS idx_breaks_schedule ON schedule_breaks(schedule_id);
CREATE INDEX IF NOT EXISTS idx_breaks_window   ON schedule_breaks(from_date, to_date);
