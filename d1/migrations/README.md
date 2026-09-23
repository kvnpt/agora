# Migrations

`d1/schema.sql` is a **baseline**, not a migration chain: it is what a fresh
database gets, and it fails loudly if run against one that already has tables.
That is deliberate and documented in the schema itself.

A live database cannot be rebuilt from it, so a column added to the baseline
needs a matching `ALTER TABLE` here, applied once by hand.

The rule is that both change together. A baseline the live database does not
match is worse than no baseline, because everything downstream — the seed, the
tests, a new contributor's local copy — trusts it.

**CI enforces it now.** `npm run check:migrations` builds a database from the
previous baseline, applies the migrations the branch adds, and diffs it against
a fresh one — columns and their ORDER, CHECK constraints (which `PRAGMA
table_info` cannot see, and which migration 011 changed), and indexes (which a
table rebuild drops, so a rebuild has to recreate them). Run it locally before
committing; it reads uncommitted migration files too.

**Apply the migration to production before the merge.** Merging is deploying.
Deploy-first fails quietly and broadly — a column named in an `INSERT (cols…)`
fails every write to that table, not just the new feature's. Migrate-first is
always safe, because the deployed code does not reference the new column yet.

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
database — and because nothing else in the repo records that it ran. `005` is
both at once: a column, and the dates to fill it with.

**Column order is part of the contract, and two tables are already out of it.**
`ALTER TABLE ... ADD COLUMN` can only append, so a column added here has to be
appended in `d1/schema.sql` too — otherwise a database migrated forward and one
built from the baseline differ, and the baseline stops being what it claims to
be. The check is mechanical: build a database from the previous baseline, apply
the new files, and diff `sqlite_master` against a fresh one. `009` and `010`
pass it, and writing `009` is what turned up the drift below.

Measured against **production** on 17 September 2026, 12 of the 14 tables match
the baseline exactly. Two do not, in ORDER only — same columns, same types:

| Table | Where they differ | From |
|---|---|---|
| `parishes` | `feast_day`, `info_source_name`, `info_checked_at` sit at the end in production and in the identity block in the baseline; `info_verified_at` sits earlier | `003`, `005` |
| `schedules` | `location_override` is last-but-two in production and before `source_*` in the baseline | `007` |

Nothing reads a column by position — every query in `worker/` names its columns
and there are no column-less `INSERT`s — so this costs nothing today. It is
recorded because a `SELECT *` written against the baseline's order, or a
positional insert, would be wrong against the live database and right in every
test. **Fix it in the baseline if you fix it at all.** Reordering a live table
means rebuilding it, and that is a far larger risk than the one it removes.

**A column a live Worker selects by name cannot simply be renamed.** The
Worker lists its parish columns explicitly, so a rename breaks every read
either side of the deploy — the old code asking for the old name against a
renamed table, or the new code asking for the new name before the migration
runs. `005` adds instead, which costs one column and no window.

| File | Adds | For |
|---|---|---|
| `014-fortnightly-and-breaks.sql` | `schedules.week_parity`; `schedule_breaks` | A fortnightly service, which `week_of_month` has no spelling for — Coburg's Compline and its Youth Group were dropped during ingestion rather than written as month positions that would put a service at Coburg on the Tuesdays it is at Brunswick. And a stretch of dates a service is not running, which renders as a BREAK tombstone rather than a gap. ALTER + CREATE only: `schedules` must NOT be rebuilt, because `schedule_overrides` references it ON DELETE CASCADE and a rebuild would cascade-delete every override — which is why neither `week_parity`'s values nor its exclusivity with `week_of_month` is a CHECK, and the routes validate instead. **Applied to production 2026-09-23** (103 schedules, 294 parishes and 2 overrides unchanged; `week_parity` appended as column 23 after `updated_by`, matching the baseline's tail). |
| `013-parish-notices.sql` | `parish_notices_seen` | A parish contact hears what another parish's event is doing at theirs, and can take their parish back out. The notice is derived from `event_parishes` and the `combined` overrides; the only thing that cannot be derived is whether a person has looked, which is all this holds. |
| `012-occurrence-poster.sql` | `schedule_overrides.patch_poster_path` | A poster on ONE occurrence. `events.poster_path` outlived the WhatsApp ingestor and is still rendered; a projected instance had nowhere to put one, because a rule has no flyer. Appended, and a database migrated forward diffs identical to a fresh baseline. **Applied to production 2026-09-22** |
| `011-event-combine-proposals.sql` | `'event.combine'` on `admin_proposals.capability`'s CHECK | A parish contact may combine at their own parish and nobody else's; this lets the refusal become an ask instead of a dead end. **Rebuilds the table** — SQLite cannot alter a CHECK — which is safe here for the reasons the file argues and is not a precedent for `parishes`. **Applied to production 2026-09-22** (0 rows to move). |
| `010-info-overrides.sql` | `info_overrides` | Which source wins when several describe the same parish, and the rulings made against that ladder — the two Elimbah Vespers a re-import would otherwise have recreated. Empty table = every import behaves exactly as before. **Applied to production 2026-09-17** |
| `009-admin-roles-and-attribution.sql` | `admin_roles`, `admin_proposals`, `pdf_source_overrides`; `updated_at`/`updated_by` on `parishes` and `schedules`; `updated_by` on `schedule_overrides` | Written after the fact. All of it was applied to production on 17 September 2026 one `--command` at a time from `docs/admin-panel.md` and never recorded here, which is the failure the top of this file describes. **Applied to production 2026-09-17** |
| `008-parish-links.sql` | `parish_links` | A parish's own short links beyond the four it has columns for — a festival, a building fund, a bookstall. **Applied to production 2026-09-12** |
| `007-schedule-location.sql` | `schedules.location_override` | A recurring service that meets somewhere other than the parish's address — a borrowed church, a hall, a cemetery chapel. NULL keeps the parish address. **Applied to production 2026-09-12** |
| `006-jurisdiction-colors.sql` | `jurisdiction_colors` | Adjusting the six archdiocese colours against each other from */admin* instead of one at a time in code. Empty table = every jurisdiction keeps the shared file's colour, so the order against the deploy does not matter. **Applied to production 2026-09-12** |
| `005-parish-info-checked-at.sql` | `parishes.info_checked_at`, plus the recorded read date for all 196 rows | A parish's details said where they came from and never how old they were, so every row rendered "unverified" — a statement about a column no scrape ever writes. **Applied to production 2026-09-12** |
| `004-parish-jurisdiction-colors.sql` | Sets `parishes.color` from `jurisdiction` for every row | 51 parishes had no colour at all and 135 carried a Greek blue the app never drew; a jurisdiction baseline needs no per-parish decision. **Applied to production 2026-09-12** |
| `003-parish-source-name.sql` | `parishes.info_source_name` | Seeing where a parish's details came from without reading a hundred-character directory URL |
| `002-adapter-settings.console.sql` | `adapter_settings` | Enabling, disabling and pacing each scrape from the admin panel, since a Cron Trigger is fixed at deploy time |
| `001-tombstone-provenance.console.sql` | `schedule_overrides.source`; `adapter_runs.window_from`, `window_to`, `tombstones_refused` | Auto-tombstoning: telling an adapter's cancellations from a person's, and recording what window a run's absence actually covered |
