# Database

The schema, the seed, and migrations. Split out of CLAUDE.md.

The schema is one baseline file, `d1/schema.sql` — not a migration chain.

```bash
npm run db:schema    # apply to remote D1
npm run db:seed      # the dev fixture — see below
npm run db:export    # dump production to backups/ (gitignored)
```

**The seed is a dev fixture, not a picture of production.** It holds 11 parishes
and 9 rules; production serves 293 parishes and 82 schedules, because six
jurisdiction directories — Greek, ROCOR, Antiochian, Serbian, Romanian and
Macedonian — were scraped and written straight to D1 rather than through the
repo.
`/api/parishes` is the answer to "what parishes exist" — `seeds/parishes.js` is
not, and cannot become one: the seed only ever inserts, so it can neither
correct an address nor move a pin. What it still earns its place doing is giving
`npm run dev` a non-empty local database and giving CI a schema smoke test.

Do not resolve that gap by making the seed authoritative. Adding deletes, or a
sync, would destroy 234 rows to match a file that never held them. The gap is
the design: rows come from scraping, and the repo does not track them. That also
means the repo is not a backup — `npm run db:export` and D1's Time Travel are.
`docs/parish-ingestion.md` is the record of how the import was done.

`d1/seed-parishes.sql` is **generated** from `seeds/parishes.js` by
`npm run gen:seed`. Edit the JS, regenerate, commit both. CI fails if they diverge.

**A schema change is two files, and CI now says so.** The baseline cannot
rebuild a live database, so anything structural needs a matching file in
`d1/migrations/`. `npm run check:migrations` builds a database from the previous
baseline, applies the migrations this branch adds, and diffs it against a fresh
one — columns *and their order*, CHECK constraints, indexes. It runs on every
pull request. A comment-only edit to the baseline passes without a migration,
which is most of the edits it gets.

**Apply the migration to production BEFORE merging, not after.** Merging is
deploying, and both orderings of the mistake fail quietly:

- deploy first, and a column named in an `INSERT (cols…)` fails **every** write
  to that table until the migration lands — adding `patch_poster_path` would
  have broken cancel, modify, combine and hide, not just posters;
- migrate first and it is always safe, because the deployed code does not
  reference the new column yet.

CI catches the two files disagreeing. It cannot catch production being behind,
so check it: `npx wrangler d1 execute agora --remote --command "SELECT …"`
before the merge.

Two features also create their tables on first use, with the same DDL, so a
deploy that beats its migration does not take them down: `parish_claims`
(016, `worker/lib/claims.mjs`) and `drafts` / `draft_events` (018,
`worker/lib/drafts.mjs` — the add-event editor depends on them). A test
compares that DDL with the baseline. `CREATE TABLE IF NOT EXISTS` cannot add a
column to a table that exists, so `drafts.read_parish` (019) is looked for and
added the same way when it is missing — one cheap read per isolate, which a
test runs against a database made before 019.

The seed is safe to re-run — every statement inserts only if the row is missing.
Parishes get `ON CONFLICT(id) DO NOTHING`; schedules have an AUTOINCREMENT id and
no natural key, so they use `WHERE NOT EXISTS` instead. A unique index would be
the tidier guard and is the wrong one: `week_of_month` makes "1st Saturday 9am
Liturgy" and "3rd Saturday 9am Liturgy" distinct rules that agree on parish,
weekday, time and title. Re-running creates missing rows; it never updates
existing ones.

The `*.console.sql` variants exist because the Cloudflare dashboard's SQL console
collapses newlines on paste, which turns a leading `--` comment into one comment
swallowing the whole file. Those have comments stripped and one statement per line.
