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

With a `D1:Edit` token in the environment, which is the route to prefer:

```bash
npx wrangler d1 execute agora --remote --file=d1/migrations/003-parish-source-name.sql
```

Files from 003 on are plain `.sql` with their comments intact, because wrangler
reads a file rather than a textarea.

**The console is the fallback, not the default.** 001 and 002 are
`.console.sql` — comments stripped, one statement per line — because they were
applied by pasting into **Workers & Pages → D1 → agora → Console**, which
collapses newlines and would let a leading `--` comment swallow the whole file.
That was a workaround for having no terminal and no credential, and it is worth
nobody's copy-paste when a token is available.

`ALTER TABLE ... ADD COLUMN` is not idempotent in SQLite — running it twice
errors with "duplicate column name". That error means the migration is already
applied and nothing is wrong.

`004` is the odd one out: a data transform rather than a schema change. It is
here because it has the same shape — applied once, by hand, against the live
database — and because nothing else in the repo records that it ran.

| File | Adds | For |
|---|---|---|
| `004-parish-jurisdiction-colors.sql` | Sets `parishes.color` from `jurisdiction` for every row | Two directory imports wrote `color: null`, so most of production had no colour at all; a jurisdiction baseline needs no per-parish decision |
| `003-parish-source-name.sql` | `parishes.info_source_name` | Seeing where a parish's details came from without reading a hundred-character directory URL |
| `002-adapter-settings.console.sql` | `adapter_settings` | Enabling, disabling and pacing each scrape from the admin panel, since a Cron Trigger is fixed at deploy time |
| `001-tombstone-provenance.console.sql` | `schedule_overrides.source`; `adapter_runs.window_from`, `window_to`, `tombstones_refused` | Auto-tombstoning: telling an adapter's cancellations from a person's, and recording what window a run's absence actually covered |
