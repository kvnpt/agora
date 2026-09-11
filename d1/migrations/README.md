# Migrations

`d1/schema.sql` is a **baseline**, not a migration chain: it is what a fresh
database gets, and it fails loudly if run against one that already has tables.
That is deliberate and documented in the schema itself.

A live database cannot be rebuilt from it, so a column added to the baseline
needs a matching `ALTER TABLE` here, applied once by hand.

The rule is that both change together. A baseline the live database does not
match is worse than no baseline, because everything downstream — the seed, the
tests, a new contributor's local copy — trusts it.

## Applying one

D1 console (**Workers & Pages → D1 → agora → Console**), paste the file. These
are `.console.sql` for the same reason the seed is: the console collapses
newlines on paste, so a leading `--` comment would swallow the whole file.

`ALTER TABLE ... ADD COLUMN` is not idempotent in SQLite — running it twice
errors with "duplicate column name". That error means the migration is already
applied and nothing is wrong.

| File | Adds | For |
|---|---|---|
| `001-tombstone-provenance.console.sql` | `schedule_overrides.source`; `adapter_runs.window_from`, `window_to`, `tombstones_refused` | Auto-tombstoning: telling an adapter's cancellations from a person's, and recording what window a run's absence actually covered |
