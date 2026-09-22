-- 011 — a combine can be asked for
--
-- `admin_proposals.capability` carries a CHECK naming the three things an
-- editor may not do. A parish contact wanting to list their event at another
-- parish, or absorb another parish's Sunday, is a fourth ask with nowhere else
-- to go, so the constraint has to learn 'event.combine'.
--
-- WHY THIS ONE REBUILDS A TABLE. SQLite cannot alter a CHECK: there is no
-- `ALTER TABLE ... DROP CONSTRAINT`, so widening one means a new table, a copy,
-- a drop and a rename. README.md says a live rebuild is a far larger risk than
-- the thing it fixes, and that judgement was about `parishes` — 293 rows read
-- by every request, with a column order the Worker depends on. This table is
-- different in every way that made the warning apply:
--
--   * nothing has a foreign key into it, so nothing is orphaned by the drop;
--   * no public route reads it — `/api/admin/proposals` is behind Access, and
--     a moment where it 500s costs an owner one refresh;
--   * it holds the asks made since 17 September, which is a handful of rows;
--   * the columns are copied by NAME below, so a production table whose order
--     drifted (see README.md) copies correctly anyway.
--
-- The alternative was dropping the CHECK entirely and trusting
-- worker/lib/proposals.mjs, which validates on the way in regardless. That is
-- the constraint the schema comment says exists so a row "can never ask for
-- something the approving route does not know how to do" — a guarantee worth
-- keeping precisely because the approving route reads `capability` to decide
-- which irreversible thing to carry out.
--
--   npx wrangler d1 execute agora --remote --file=d1/migrations/011-event-combine-proposals.sql
--
-- Not idempotent: a second run fails on `table admin_proposals_new already
-- exists` or, past the rename, on the copy from a table that is already the
-- new one. Either error means it has already been applied.
--
-- Reversible only from a backup. `npm run db:export` first, or lean on D1's
-- Time Travel.

CREATE TABLE admin_proposals_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  capability  TEXT NOT NULL
                CHECK(capability IN ('parish.delete','parish.acronym','colors.edit','event.combine')),
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

-- By name, not by position: two production tables already differ from the
-- baseline in column ORDER, and a bare `INSERT INTO ... SELECT *` is exactly
-- the positional read README.md warns about.
INSERT INTO admin_proposals_new
  (id, capability, subject, payload, reason, status, proposed_by, created_at,
   decided_by, decided_at, decision_note)
SELECT
   id, capability, subject, payload, reason, status, proposed_by, created_at,
   decided_by, decided_at, decision_note
FROM admin_proposals;

DROP TABLE admin_proposals;

ALTER TABLE admin_proposals_new RENAME TO admin_proposals;

-- The drop took the index with it.
CREATE INDEX idx_admin_proposals_open ON admin_proposals(status, created_at DESC);
