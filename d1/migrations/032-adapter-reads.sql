-- 032 — adapter_reads: what Claude said about a source's entry, kept
--
-- An adapter now pairs a source's dated entries with the parish's rules
-- (worker/lib/pairing.mjs), and asks Claude Haiku only what name and time
-- cannot settle. Each answer is kept here so it is asked once, not every run.
-- d1/schema.sql has the why.
--
-- A new table, so applying it before the merge is safe: nothing deployed names
-- it yet. The Worker also makes it on first use (pairing-read.mjs), the same
-- belt-and-braces as parish_suggestions, so a run never fails for want of it.

CREATE TABLE adapter_reads (
  question_hash TEXT PRIMARY KEY,
  adapter_id    TEXT NOT NULL,
  question      TEXT NOT NULL,
  answer        TEXT NOT NULL,
  model         TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
