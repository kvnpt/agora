# Agora Edge Migration — VM to Cloudflare

Moving Agora from the decommissioned Sydney VM to Cloudflare Pages, Workers, D1 and
R2, while stripping the app back to essentials: a database and a website.

Scope decision: **no WhatsApp ingestor, no Claude Vision poster pipeline.** That
removes not just two adapters but the entire moderation subsystem, which existed
because AI-parsed content needed human approval.

| | Before | After |
|---|---|---|
| DB call sites | 198 | ~65 |
| Admin endpoints | 32 | 9 |
| Tables | 19 | 7 |
| Running cost | a VPS | $0 (within free tiers at this scale) |

---

## Two things to settle first

Neither is a code problem, and both block the work.

### 1. Admin login has no surviving path

Admin auth rests on three legs, and the migration removes all three:

- **Tailscale IP allowlist** — `magic-auth.js` allows any client in `100.64.0.0/10`.
  Tailscale ran on the VM.
- **Caddy `forward_auth`** — `GET /auth/check` exists purely as Caddy's auth hook.
  Caddy ran on the VM.
- **WhatsApp-delivered magic links** — tokens are keyed by *phone number* and sent
  through the bot. The expired-link page reads "Text the bot **admin** to request a
  new one." Dropping WhatsApp removes the only delivery channel.

**Recommendation: Cloudflare Access** (Zero Trust, free up to 50 users). Gates
`/admin` and the admin API at the edge with Google sign-in or emailed one-time PINs,
before a request reaches the Worker. Deletes `auth.js`, `routes/magic-auth.js`, the
`express-session` dependency and four tables outright — the biggest single
simplification available here.

### 2. Where is the data? — settled

The old database is not being recovered. Production data lived at
`/opt/agora/data/agora.db` with nightly backups to `/opt/agora/backups/`, both on the
VM that is gone.

**Decision: start fresh.** `seeds/parishes.js` seeds the parish list, and events are
rebuilt by scraping. This removes Phase 0's dependency on finding a backup and makes
the adapter path load-bearing from day one — see the note on `adapter_runs` below.

---

## Where each piece lands

| Job | Was | Becomes | Notes |
|---|---|---|---|
| Static frontend | `express.static` | Cloudflare Pages | 16 MB, 795 files, no build step |
| HTTP API | `server.js` + `routes/` | Worker (Hono) | ~6 public routes, 9 admin routes |
| Database | better-sqlite3 | D1 | Native addon can't run in Workers. D1 *is* SQLite — SQL ports near-verbatim |
| Uploads | `/opt/agora/data` | R2 | Parish logos, event posters |
| Map tiles | `/opt/agora/tiles` | R2 | R2 serves HTTP range requests natively — what PMTiles needs |
| Scheduled polling | node-cron | Cron Trigger | One trigger, 4-hourly, Google Calendar adapter |
| Admin auth | Tailscale + WhatsApp | Cloudflare Access | See blocker above |

---

## Schema diff

Nineteen tables at `user_version = 29`. Seven survive. Do **not** replay 29 migrations
into D1 — write one clean baseline schema for the end state, then import surviving rows.

| Table | Fate | Reason |
|---|---|---|
| `parishes` | ALTER | Core. Drop `source_run_id` (see below); keep the four payment-link columns |
| `schedules` | ALTER | Core. Drop `status`, `source_run_id` — both for WhatsApp-submitted schedules awaiting approval |
| `events` | ALTER | Core. Drop `confidence`, `source_run_id`. `status` loses `pending_review` (no producer) but **keeps `replaced`** — the combine flow sets it. `mutation_type` enum preserved as-is |
| `schedule_overrides` | KEEP | The v26 materialize-on-read model, and half the combine feature. Central, 14 refs |
| `event_parishes` | KEEP | Additive cross-parish combine. Read by the **public feed** (`routes/events.js:90`) |
| `event_replaces` | KEEP | Combine-against-a-one-off-event. **Not** redundant with the v26 override path — see the combine contract below |
| `adapter_runs` | ALTER | Keep slimmed. Only surviving reader is `healthCheck()` → `/api/adapters/status`. Drop 5 WhatsApp-only columns: `input_texts`, `claude_response`, `sender_phone`, `parish_match_confidence`, `parish_match_question` |
| `senders` | DROP | WhatsApp phone identity + 4-tier role model. Access replaces the concept |
| `sessions` | DROP | express-session store |
| `admin_magic_tokens` | DROP | Magic links delivered over WhatsApp |
| `admin_sessions` | DROP | Phone-keyed session tracking |
| `pending_parish_updates` | DROP | Moderation queue for AI-parsed parish edits |
| `pending_cancellations` | DROP | Moderation queue for AI-parsed cancellations |
| `wa_seen_message_ids` | DROP | WhatsApp delivery de-duplication |
| `rep_parishes` | DROP | Already dead — created v24, zero refs in app code |
| `audit_log` | DROP | Already dead — created v24, zero refs |
| `channels` | DROP | Already dead — created v1, never used |
| `users` | DROP | Already dropped in v24 (OAuth retirement) |
| `event_submissions` | DROP | Already dropped in v24 |

### The `source_run_id` columns go unconditionally

This is not a judgement call. `adapters/base.js:53-65` — the upsert every adapter run
goes through — **never writes `source_run_id`**. That column was only ever populated by
the WhatsApp webhook path. Post-cut it would be `NULL` on every row of `parishes`,
`schedules`, `events` and `schedule_overrides` forever. Drop it from all four,
independently of what happens to `adapter_runs` itself.

### The combine contract

Combining is a key feature and the most expensive thing in the schema to rebuild if
lost. It is **three** mechanisms, not one, and the escalate endpoint routes between them
by the shape of the target id (`routes/admin.js:189-264`). All three must survive the
port:

| Capability | Mechanism | Target id shape |
|---|---|---|
| Additive cross-parish (one event under several parishes) | `event_parishes` | n/a — parish ids |
| Replace a stored one-off event | `event_replaces` + `events.status='replaced'` + `mutation_type='replaced'` | integer |
| Replace a materialized schedule occurrence | `schedule_overrides.kind='combined'` + `combined_into_event_id` | synthetic `"sid:date"` |

`event_replaces` is described as "legacy" in the code, which is misleading: it is
pre-v26, but it remains the **only** path for combining against a stored one-off event.
The v26 override model handles schedule instances only. Dropping it removes half the
feature. Both paths are live in the same transaction.

Read side: `routes/events.js:90` attaches `extra_parishes` to every integer-id event in
the public feed. That runs for anonymous visitors, so it survives regardless of what
happens to the admin write UI.

### Seeding and first scrape

No import — the database starts empty and is rebuilt:

```bash
wrangler d1 create agora
wrangler d1 execute agora --remote --file=schema.sql
wrangler d1 execute agora --remote --file=seed-parishes.sql   # from seeds/parishes.js
```

Events then arrive by scraping. `source_hash` carries a UNIQUE index, so re-running a
scrape is idempotent by design — a second run updates rather than duplicates.

---

## File by file

4,880 lines of backend today; roughly 2,600 is deleted rather than ported.

| File | Lines | Fate | Notes |
|---|---|---|---|
| `routes/webhook.js` | 835 | DROP | WhatsApp ingestion endpoint |
| `adapters/whatsapp-poster.js` | 371 | DROP | Claude Vision poster parsing |
| `adapters/whatsapp-send.js` | 67 | DROP | Outbound WhatsApp, incl. magic-link delivery |
| `routes/admin.js` | 847 | REWRITE | Keep 9 CRUD endpoints, delete 22 moderation ones. ~250 lines out the other side |
| `db.js` | 552 | REWRITE | 29 migrations collapse to one baseline. Driver becomes D1; every call gains `await` |
| `schedule-generator.js` | 205 | SALVAGE | Generator half died at v26. Only `matchesWeekOfMonth` still live (used by `schedule-expand.js`). Extract it, delete the rest. `localToUtc` dies with the WhatsApp adapter |
| `routes/magic-auth.js` | 209 | DROP | Replaced by Cloudflare Access |
| `auth.js` | 64 | DROP | express-session + SQLite session store |
| `schedule-expand.js` | 179 | PORT | Core read model. Pure logic + Temporal polyfill (pure JS, Workers-safe). Only DB calls change |
| `schedule-overrides.js` | 172 | PORT | Core v26 logic, async-ify the DB layer |
| `routes/events.js` | 170 | PORT | 2 public endpoints |
| `server.js` | 130 | REWRITE | Becomes the Worker entry. Payment deep-links + SPA fallback need re-homing (below) |
| `adapters/base.js` | 125 | PORT | Async-ify; drop the `adapter_runs` columns that go |
| `adapters/google-calendar.js` | 104 | PORT | Pure `fetch` + `crypto`. Most Workers-ready file in the repo |
| `adapters/registry.js` | 42 | REWRITE | `fs.readdirSync` can't work in Workers. Becomes a static two-line import list |
| `scheduler.js` | 41 | REWRITE | node-cron loop becomes a `scheduled()` export |
| `geocode.js` | 38 | PORT | fetch-based, portable as-is |
| `seeds/parishes.js` | 145 | KEEP | Also the data-recovery fallback |
| `routes/parishes.js` | 34 | PORT | Straight port |
| `routes/schedules.js` | 33 | PORT | Straight port |
| `routes/adapters.js` | 19 | PORT | Status endpoint |
| `instrument.js` | 15 | REWRITE | `@sentry/node` → `@sentry/cloudflare`, or drop for now |
| `public/**` | — | KEEP | No hardcoded hosts; every call relative. One change: `map.js` PMTiles URL |
| `public/admin.html` | — | TRIM | Delete moderation tabs (senders, sessions, runs, dropped, pending queues) |
| `Dockerfile` | — | DROP | No container in the target architecture |
| `docker-compose.yml` | — | DROP | Pinned to the dead `homelab` network and VM bind-mounts |
| `.github/workflows/ci.yml` | — | REWRITE | Smoke-boots `server.js`. Becomes `wrangler deploy --dry-run` + D1 schema check |
| `scripts/backfill-v26.js` | 158 | DROP | One-shot migration, already applied |
| `scripts/build-dark-basemap.js` | 283 | KEEP | Build-time tooling, runs locally |
| `CLAUDE.md` | — | REWRITE | Every deployment instruction describes infrastructure that no longer exists |

### Three server behaviours that need re-homing

- **SPA fallback.** `app.get('*')` becomes a `_redirects` line: `/* /index.html 200`,
  ordered *after* the API proxy rules so it doesn't swallow `/api/*`.
- **Payment deep links.** `/:slug/donate|raffle|payment|gala` does a DB lookup then a
  302. Must stay server-side — becomes a Worker route matched before the static handler.
- **Logo and poster URLs.** `logo_path` / `poster_path` are stored in the DB as
  root-relative paths and rendered straight into `<img src>`. Keep them relative and
  route `/logos/*` and `/posters/*` to R2 — avoids rewriting stored data and leaves the
  frontend untouched.

---

## Deployment order

Sequenced so something is verifiable at every step, and the largest rewrite happens
against data already proven to import cleanly. Pruning comes first for a reason: every
file deleted in Phase 1 is a file not ported in Phase 3.

### Phase 0 — (removed)

Was "recover the database". Settled: the old data is not being recovered, so there is
nothing to find. Parishes come from `seeds/parishes.js`, events from scraping. Start at
Phase 1.

### Phase 1 — Prune, still on Node

- Delete the WhatsApp and Vision files; strip 22 moderation endpoints from
  `routes/admin.js` and matching tabs from `admin.html`.
- Keep the escalate/combine endpoints — they are the combine feature's write path, not
  moderation. Only their *entry points* were WhatsApp-driven.
- Salvage `matchesWeekOfMonth` from `schedule-generator.js`, delete the rest.
- Remove `@anthropic-ai/sdk` from `package.json`.
- Run locally against a freshly seeded DB, click through the real site.

**Done when:** `node server.js` boots, `/health` 200, map + feed + admin CRUD all work
with WhatsApp gone — **and a combine still round-trips**, both against a one-off event
and against a schedule instance. Last checkpoint where the old stack proves the new scope.

### Phase 2 — Baseline schema into D1

- Write `schema.sql`: the 8 surviving tables at final shape, with the indexes that
  matter (`source_hash` unique, events date/parish/status, override join keys, the two
  combine join tables).
- `wrangler d1 create agora`, apply schema, load the parish seed.

**Done when:** a hand-written `SELECT` returns a seeded parish, and the combine tables
exist with their foreign keys intact.

### Phase 3 — Port the API to a Worker

- Hono for routing; one `db` helper wrapping the D1 binding so call sites stay close
  to their current shape.
- Port in dependency order: `schedule-expand` → `schedule-overrides` → public routes
  → admin routes.
- Every `.prepare().get()/.all()/.run()` becomes `await`. Nothing catches a missed one —
  a forgotten `await` yields a Promise where a row was expected, which reads as "no
  data" rather than an error. Grep `.prepare(` at the end and check each has an `await`.
- Run against local D1 with `wrangler dev`, pointing the existing frontend at it.

**Done when:** the untouched frontend, served locally, renders the real feed and map
from the Worker.

### Phase 4 — Assets into R2

- Upload `oceania.pmtiles`, existing logos and posters.
- Route `/tiles/*`, `/logos/*`, `/posters/*` from the Worker to R2, paths identical to today.
- Repoint the admin logo-upload handler at R2's API instead of the filesystem.

**Done when:** map renders tiles and parish avatars load, with no change to any stored
`logo_path` value.

### Phase 5 — Frontend to Pages

- New Pages project: root directory `public/`, no build command.
- `_redirects` for SPA fallback, ordered after the API routes.
- Put the Worker and Pages on the **same** custom domain so the browser sees one
  origin — this keeps every relative `fetch` working and sidesteps CORS and cross-site
  cookies entirely.

**Done when:** the Pages preview URL serves a fully working site against the real
Worker and D1.

### Phase 6 — Lock down admin

- Cloudflare Access policy over `/admin` and `/api/admin/*`, your email the only
  allowed identity.
- Verify the Worker rejects admin routes when the Access header is absent — Access is
  the gate, but the Worker shouldn't trust an unauthenticated path either.

**Done when:** a logged-out private window gets the Access challenge on `/admin`, and a
direct `curl` to an admin API route is refused.

### Phase 7 — Re-arm the scheduler

- Cron Trigger at `0 */4 * * *` calling the Google Calendar adapter through the
  Worker's `scheduled()` handler.
- Fix the run counters while porting `base.js`. `events_updated` is declared
  (`base.js:47`), passed to the UPDATE (line 100) and **never incremented** — always 0.
  `events_created` counts updates too, because `result.changes > 0` is true for the
  `ON CONFLICT DO UPDATE` branch. So "created" currently means "touched". D1 returns a
  different result shape (`meta.changes`), so the port is the moment to make both
  counters mean what they say — they are the scrape-health signal now.
- Trigger manually once, confirm a row lands in `adapter_runs`.

**Done when:** a scheduled run completes unattended, its events appear in the feed, and
the run row shows honest created/updated counts.

### Phase 8 — Cut over and clean up

- Point `agora.orthodoxy.au` at Pages.
- Replace the CI smoke-boot with a Wrangler dry-run.
- Rewrite `CLAUDE.md` — Docker, Caddy, Tailscale and webhook-deploy sections all
  describe infrastructure that no longer exists.
- Delete `Dockerfile` and `docker-compose.yml`.

**Done when:** the live domain serves from Pages and no file in the repo references the
old VM.

---

## Decided

**Start the database fresh.** No recovery of the old `agora.db`. Parishes from
`seeds/parishes.js`, events from scraping. Phase 0 is struck.

**Combine / cross-parish is preserved in full.** All three mechanisms survive —
`event_parishes`, `event_replaces`, and the v26 `schedule_overrides` combined path. An
earlier draft of this plan proposed dropping `event_replaces` as legacy; that was wrong
and would have removed combining against one-off events. See the combine contract above.

**`adapter_runs` stays, slimmed.** Two separate calls, resolved separately:

- *The `source_run_id` columns go* from `parishes`, `schedules`, `events` and
  `schedule_overrides`. `base.js` never writes them; only the WhatsApp webhook did. They
  would be `NULL` forever.
- *The table stays*, minus the five WhatsApp columns. With scraping as the primary
  ingestion path it is the only record that a scrape ran and what it produced — the
  failure mode being a scrape that silently starts returning zero events, which errors
  nowhere. A cron Worker has no `docker logs` to tail; free-tier dashboard logs are
  short-retention and not queryable from the app. Cost is ~12 writes/day against D1's
  100k/day. And its only reader, `healthCheck()` → `/api/adapters/status`, is code that
  stays.

**The three unmerged June branches are abandoned.** `feat/event-edit-address`,
`fix/save-event-rerender` and `fix/save-event-cache-bypass` are all admin inline-editing
fixes on `public/app.js`. None will be merged: the behaviour they patch — cache bypass
after a mutation, re-render of an open event detail after Save — is exactly what the
port changes underneath. Diagnosing it against the Worker/D1 data path gives a more
accurate answer than carrying forward a fix written for the synchronous Express one.

The branches stay on the remote as reference. Nothing merges them, and Phase 1 does not
wait on them.

## Open question: what actually scrapes?

Rebuilding by scraping assumes there are scrapers. There is currently **one** working
adapter — `google-calendar.js`, instantiated once, for Good Shepherd Clayton
(`gcal-good-shepherd-clayton.js`). Everything else came in through WhatsApp posters.

So on the far side of this migration, ingestion covers one parish. The schema, the cron
trigger and `adapter_runs` all support more, and `adapters/_template.js` exists for
exactly this — but writing the additional adapters is work this plan does not cost, and
it sits between "the port is done" and "the site is useful again".

Worth deciding early, because it shapes how much the admin CRUD path matters in the
interim: if adapters lag, manual entry through `/admin` is the only way events reach the
site, which raises the priority of Phase 6 (Access) rather than lowering it.

---

*Assessed against `kvnpt/agora` at `main`, schema `user_version = 29`. Line counts and
reference counts are from the working tree, not estimates.*
