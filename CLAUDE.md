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
| Scrapes | A Cron Trigger every 4 hours |
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
`source_hash` makes a re-scrape idempotent.

## Deploy

```bash
npm run deploy
```

`docs/deploy.md` is the runbook for a first live deploy — the commands in order,
the check that proves each one landed, and the two things that block a *useful*
site rather than a working one (the missing basemap archive, and the one adapter
whose parish is not in the seed).

Secrets (set once, via `wrangler secret put`):

| Secret | For |
|---|---|
| `GOOGLE_API_KEY` | The Google Calendar adapter |
| `ACCESS_TEAM_DOMAIN` | Cloudflare Access, e.g. `yourteam.cloudflareaccess.com` |
| `ACCESS_AUD` | The Access application's audience tag |

**Admin fails closed.** With `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` unset, every
`/api/admin/*` request is refused. The Access JWT's signature is verified against the
team's published keys — a forged `Cf-Access-Jwt-Assertion` header gets nothing.

`AGORA_DEV_ADMIN=true` bypasses that, and exists only for `wrangler dev`. It is
deliberately absent from `wrangler.toml` so it cannot ship by accident.

## Database

The schema is one baseline file, `d1/schema.sql` — not a migration chain. Seven tables.

```bash
npm run db:schema    # apply to remote D1
npm run db:seed      # parishes + starting rules
```

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
- Ingestion currently covers **one parish** (Good Shepherd Clayton, via Google Calendar),
  and even that one cannot run yet: its parish row existed only in the lost database, so
  it is listed in `PENDING_PARISHES` until someone confirms the address. Everything else
  used to arrive over WhatsApp. Writing more adapters is the gap between "the port is
  done" and "the site is useful".

`docs/cloudflare-migration.md` is the full migration record, including the reasoning
behind decisions that look arbitrary from the outside.
