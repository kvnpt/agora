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

## The rules that bite

Each line is a rule somebody broke once. The reasons, and the bugs that paid
for them, are in the doc it links to — read that before changing the area.

**The data model** — [docs/architecture.md](docs/architecture.md)
- Rules are projected, never stored as occurrences. `public/shared/` holds the
  one projection and the one dedup; the Worker imports the same files.
- Recurrence rules store LOCAL wall-clock time; one-off events store UTC. Do not
  "fix" it. Times display in the PARISH's zone, never the viewer's.
- `/api/bundle` is `no-cache` + ETag, cached at the edge under the data version
  every admin write and cron run bumps. A rule on the wire carries its own
  columns only; the browser joins the parish back on.
- A shared parish or event link gets a server-rendered lite card. In
  `run_worker_first`, **a negation must never name an image extension**.
- A synthetic id is `"<scheduleId>:YYYY-MM-DD"`. The feed widens, never shrinks.
  A date segment is a FROM, never a single day.

**Editing** — [docs/editing.md](docs/editing.md)
- **Nothing disappears**: a cancellation is a tombstone. Editing a field keeps
  what an occurrence already is; only `status: 'approved'` revives.
- "This and every following" ends or splits a rule with its own
  `effective_from`/`effective_to` — never edits it in place. Ending is the one
  deliberate exception to *nothing disappears*.
- A poster belongs to an occurrence (or a range of them), never to a rule.
- `hidden` hides; `hide_live` and `parish_scoped` do not. Cancel and Suppress are
  confirmed because they look alike and are not.
- Combine is three mechanisms routed by the target id's shape, scoped per target.
- Signed in is not editing: each surface has its own mode behind its own pencil.

**Sources** — [docs/sources-and-ingestion.md](docs/sources-and-ingestion.md)
- A parish's address is where the service is.
- A source line says when we last looked, never that it is right.
  `info_verified_at` is a person's check and nothing renders it.
- `source-tiers.js` is the one ladder; `outranks` is the only comparison, and it
  is strict. `info_overrides` holds rulings, never values.
- An admin edit records its own provenance; a timetable shows ONE source line.
- Adapters are a static registry; absence becomes a cancellation only under the
  guards in `tombstone.mjs`.

**People** — [docs/people-and-access.md](docs/people-and-access.md)
- Access says who you are; `admin_roles` says what you may do. Routes name a
  capability, never a role. An EMPTY table makes everyone an owner.
- Admin fails closed. `AGORA_DEV_ADMIN` is for `wrangler dev` only.
- A refusal with somewhere to go becomes an ask; "Is this your parish?" becomes
  a claim. Neither is a moderation queue.

**Shipping** — [docs/deploy-and-ci.md](docs/deploy-and-ci.md), [docs/database.md](docs/database.md)
- Every push to `main` deploys (Workers Builds). Green CI is the merge gate.
- CI runs none of `app.js`, `filters.js`, `bundle.js`, `map.js`: a change there
  is checked in a browser ([docs/browser-checks.md](docs/browser-checks.md)) and
  the PR says how. Check the way in, not just the behaviour.
- A schema change is two files (baseline + `d1/migrations/`), and the migration
  is applied to production **before** the merge.
- The seed is a dev fixture, not production; never make it authoritative.
  `d1/seed-parishes.sql` is generated — `npm run gen:seed`.
- A Secrets Store binding is an object; read it with `readSecret()`.

## Where things are written down

| Doc | What |
|---|---|
| [docs/architecture.md](docs/architecture.md) | The lens, the bundle, lite pages, dates, time zones, dedup, colours, the cron |
| [docs/editing.md](docs/editing.md) | Occurrences, series, posters, combines, modes, the three "hides" |
| [docs/sources-and-ingestion.md](docs/sources-and-ingestion.md) | Addresses, provenance, the source ladder, rulings, adapters |
| [docs/people-and-access.md](docs/people-and-access.md) | Roles, asks, claims, notices, and setting up Cloudflare Access |
| [docs/deploy-and-ci.md](docs/deploy-and-ci.md) | Workers Builds, the CI gate, secrets |
| [docs/database.md](docs/database.md) | Schema, seed, migrations |
| [docs/history.md](docs/history.md) | The VM, the WhatsApp pipeline, scar tissue |
| [docs/roadmap.md](docs/roadmap.md) | What to build next, with prompts to start each phase |
| `docs/deploy.md` | The runbook, for a browser |
| `docs/browser-checks.md` | Driving the app with Playwright |
| `docs/adapters.md` | Writing an adapter |
| `docs/lite-pages.md` | Shared links, previews, search |
| `docs/parish-ingestion.md` | Importing a jurisdiction's directory (`/ingest-jurisdiction`) |
