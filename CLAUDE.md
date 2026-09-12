# Agora — Orthodox Event Finder for Oceania

## Project

Aggregates Orthodox parish services and events into one location-aware feed.

The core idea is the **date lens**: parishes have recurring *rules*, not stored
occurrences. "Sundays 9am" is one row. The hundreds of event cards a user scrolls are
projected at read time and never written down. Only *exceptions* — this week it's at
10am, this week it's cancelled, this week it's combined with the cathedral — are stored,
one row per exception.

## Stack

Everything runs on Cloudflare. There is no server and no build step.

| Piece | What |
|---|---|
| Frontend | `public/` — vanilla JS, MapLibre, served as Workers static assets |
| API | `worker/` — a Worker, no third-party runtime dependencies |
| Database | D1 (SQLite at the edge) |
| Tiles, logos, posters | R2, served with HTTP range support |
| Scrapes | An hourly Cron Trigger; `adapter_settings` decides which are due |
| Admin auth | Cloudflare Access (Zero Trust) |

## Run

```bash
npm install
npm run dev          # wrangler dev with local D1/R2 + the admin bypass
npm test             # node --test
```

First run needs a local database:

```bash
npx wrangler d1 execute agora --local --file=d1/schema.sql
npx wrangler d1 execute agora --local --file=d1/seed-parishes.sql
```

## Key patterns

**The lens is pure and shared.** `public/shared/` holds the projection (`project.mjs`,
`tz.mjs`, `recurrence.mjs`) and the feed assembly (`merge.mjs`). Those files are served
to the browser *and* bundled into the Worker by the same import. There is one
implementation of the projection and one of the dedup — they cannot drift.

**The client projects, not the server.** `GET /api/bundle` returns rules, overrides,
one-off events and parishes; `public/bundle.js` expands them in the browser. This keeps
the Worker's CPU near zero (it matters — Workers Free meters 10ms of CPU per request)
and makes the response cacheable, since rules change rarely while a feed is stale the
moment "now" moves.

**Synthetic ids.** A projected occurrence has the id `"<scheduleId>:YYYY-MM-DD"`, e.g.
`42:2026-09-06`. It is stable and addressable, so a deep link to a service that has never
existed as a row resolves — client-side, from rules the browser already holds.

**Nothing disappears.** Every occurrence in a window emits exactly one instance. A
cancellation is a *tombstone* that still renders, so someone who would otherwise turn up
at church sees "CANCELLED" rather than the service silently vanishing.

**Recurrence rules store LOCAL time; one-off events store UTC.** This is deliberate and
is documented at length in `d1/schema.sql`. For a recurring service the wall clock is the
invariant — a 9am liturgy stays 9am across a DST boundary — so normalising it to UTC would
make it drift an hour twice a year. Do not "fix" it.

**Parishes carry their own IANA timezone.** Oceania spans Perth (+08:00, no DST) to
Auckland (+12:00/+13:00, switching on different dates to Sydney). `parishes.timezone`
is what makes `start_time` meaningful.

**Times display in the PARISH's local time**, never the viewer's — the way a map shows a
venue's opening hours. Only "is it on right now" depends on the viewer's actual moment.

**Combine is three mechanisms**, routed by the shape of the target id
(`POST /api/admin/events/:id/escalate`):

| Capability | Mechanism | Target id |
|---|---|---|
| One event under several parishes | `event_parishes` | parish ids |
| Replace a stored one-off | `event_replaces` + `status='replaced'` | integer |
| Replace a schedule occurrence | `schedule_overrides` kind `combined` | `"sid:date"` |

`event_replaces` is described as legacy in old comments. It is pre-v26 but **not**
redundant: it is the only path for combining against a stored one-off.

**Dedup decides which of two competing rows becomes one card** (`merge.mjs`): a
`week_of_month` rule beats a generic weekly one, a stored one-off beats a schedule
instance, then most-recently-updated. That middle rule is load-bearing — it is how a
scraped event supersedes its recurring twin instead of showing twice.

**Adapters** live in `worker/lib/adapters.mjs` as a static registry (Workers have no
filesystem, so there is no directory scan). Add a parish by adding a line.
`source_hash` makes a re-scrape idempotent. `docs/adapters.md` is the guide —
the contract, what comes free, and the constraints that bite.

A parish that publishes a PDF instead of a calendar keeps its source — URL,
publishing cadence, layout quirks — in `worker/lib/pdf-sources.mjs`, which is
imported by both the registry and the GitHub Action that does the extraction, so
the two cannot disagree about what to fetch. Getting text out of a PDF happens in
that Action, never in the Worker; `scripts/extract-parish-pdf.mjs` says why at
length, and the short version is that one of the surveyed parish schedules is a
photograph of a piece of paper.

**The Cron Trigger is a heartbeat, not a schedule.** A trigger is fixed at deploy
time and a Worker cannot change its own, so `wrangler.toml` fires hourly and
`adapter_settings` decides what an hour is allowed to do — enable, disable and
pace each adapter from `/admin` with no deploy. A missing row means enabled at
the default interval, because absence should never be the thing that stops a
scrape. Pacing is measured from the last *success*: a failing adapter that reset
the clock on every attempt would wait out its whole interval before retrying.
**Run now** ignores all of it.

**Absence is a signal, under guards.** `infer.mjs` proposes recurrence rules from
scraped occurrences, and only when a rule reproduces the observed dates exactly —
every occurrence explained and every gap explained. `reconcile.mjs` then compares
projected rules against what a source published, and `tombstone.mjs` decides
whether a gap may become a cancellation. The asymmetry drives every choice in
those files: a missed cancellation leaves a stale card the next scrape fixes; a
false one keeps someone away from a service that is running.

## Deploy

Deploying is automated, because it has to be: `wrangler deploy` needs Node, and
the dashboard's inline editor cannot take the thousand-odd static assets that
ship with the code. **Cloudflare Workers Builds** does it — the repo is connected
in the Cloudflare dashboard and every push to `main` deploys.

There is no deploy workflow in `.github/workflows/`, deliberately. One existed
(`wrangler-action` behind a `CLOUDFLARE_API_TOKEN`) and was deleted rather than
kept alongside, because two deploy paths race on every push. Workers Builds needs
no credential stored anywhere, which is worth more here than the test gate it
gives up — CI still runs on every pull request, so the gate lives there instead.

```bash
npm run deploy       # the same thing, if you do have a terminal
```

`docs/deploy.md` is the runbook, written for a browser and nothing else: the
Cloudflare dashboard and the GitHub Actions tab, in order, with the check that
proves each step landed. It also covers the two things that block a *useful* site
rather than a working one — the missing basemap archive, and the one adapter
whose parish is not in the seed.

Secrets (set once, via `wrangler secret put` or the dashboard):

| Secret | For |
|---|---|
| `GOOGLE_API_KEY` | The Google Calendar adapter |
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access, e.g. `yourteam.cloudflareaccess.com` |
| `ACCESS_AUD` | The Access application's audience tag |

A secret reaches `env` as a **string** (a Worker secret) or as an **object with
`.get()`** (a Secrets Store binding). `readSecret()` in `worker/lib/auth.mjs`
takes either. Do not compare a binding for truthiness and call it configured —
an object always passes, and the value then renders as `[object Object]`.

**Admin fails closed.** With `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` unset, every
`/api/admin/*` request is refused. The Access JWT's signature is verified against the
team's published keys — a forged `Cf-Access-Jwt-Assertion` header gets nothing.

`AGORA_DEV_ADMIN=true` bypasses that, and exists only for `wrangler dev`. It is
deliberately absent from `wrangler.toml` so it cannot ship by accident.

## Database

The schema is one baseline file, `d1/schema.sql` — not a migration chain. Seven tables.

```bash
npm run db:schema    # apply to remote D1
npm run db:seed      # the dev fixture — see below
npm run db:export    # dump production to backups/ (gitignored)
```

**The seed is a dev fixture, not a picture of production.** It holds 11 parishes
and 9 rules; production serves 196 parishes and 69 schedules, because three
jurisdiction directories — Greek, ROCOR and Antiochian — were scraped and
written straight to D1 rather than through the repo.
`/api/parishes` is the answer to "what parishes exist" — `seeds/parishes.js` is
not, and cannot become one: the seed only ever inserts, so it can neither
correct an address nor move a pin. What it still earns its place doing is giving
`npm run dev` a non-empty local database and giving CI a schema smoke test.

Do not resolve that gap by making the seed authoritative. Adding deletes, or a
sync, would destroy 133 rows to match a file that never held them. The gap is
the design: rows come from scraping, and the repo does not track them. That also
means the repo is not a backup — `npm run db:export` and D1's Time Travel are.
`docs/parish-ingestion.md` is the record of how the import was done.

`d1/seed-parishes.sql` is **generated** from `seeds/parishes.js` by
`npm run gen:seed`. Edit the JS, regenerate, commit both. CI fails if they diverge.

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

## History worth knowing

Agora ran on a Sydney VM until it was decommissioned: Express + better-sqlite3 +
node-cron behind Caddy, with a WhatsApp ingestor that used Claude Vision to read parish
posters, and a moderation queue because AI-parsed content needed approval.

That is all gone. The WhatsApp and vision pipelines were cut deliberately (scope: "a
database and a website"), which also removed the entire moderation subsystem. The old
database was not recovered — parishes come from the seed, events from scraping.

Two consequences still visible in the code:

- `events.schedule_id` and the `source_adapter != 'schedule'` guard in the bundle query
  are scar tissue from a nightly generator that wrote occurrence rows. It was replaced by
  the date lens in schema v26.
- Ingestion started from **one parish** (Good Shepherd Clayton, via Google Calendar).
  Its row existed only in the lost database and was re-seeded once the address was
  confirmed, so `PENDING_PARISHES` is now empty — but the guard it feeds stays, because
  an adapter pointed at a missing parish must refuse before writing rather than throw a
  foreign-key error every four hours. Everything else used to arrive over WhatsApp.
  Two PDF parishes have since been added (Buderim and Blacktown), and writing more
  adapters is still the gap between "the port is done" and "the site is useful".

`docs/cloudflare-migration.md` is the full migration record, including the reasoning
behind decisions that look arbitrary from the outside.

`docs/parish-ingestion.md` is the brief for the step *before* adapters: adding
parishes in bulk from a jurisdiction's directory. It records the schema
constraints that bite a few hundred rows at once, the geocoding trap that put one
pin 730m off, and the three public endpoints that let you read production without
any credential at all.

`/ingest-jurisdiction <name>` (`.claude/commands/`) is that brief as a command:
the three reviewable passes, the traps in the order they cost time, and the one
rule about sources — **a jurisdiction's own site is where its parish information
comes from.** Aggregators are for finding that site and nothing else, because
`info_source_type='website'` asserts the parish told us and that should be true.
