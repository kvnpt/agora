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

### 2. Where is the data?

This plan assumes there is a database to migrate. Production data lived at
`/opt/agora/data/agora.db` with nightly backups to `/opt/agora/backups/` — both on
the VM that is gone. Confirm an off-box copy exists before starting.

Fallback if none does: `seeds/parishes.js` still holds the parish list; schedules and
one-off events would need re-entering by hand.

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
| `parishes` | ALTER | Core. Drop `source_run_id` if `adapter_runs` goes; keep the four payment-link columns |
| `schedules` | ALTER | Core. Drop `status`, `source_run_id` — both for WhatsApp-submitted schedules awaiting approval |
| `events` | ALTER | Core. Drop `confidence`, `source_run_id`; `status` collapses to approved/hidden — `pending_review` has no producer |
| `schedule_overrides` | KEEP | The v26 materialize-on-read model. Central, 14 refs |
| `event_parishes` | KEEP | Read by the **public feed** (`routes/events.js:90`), not just admin |
| `adapter_runs` | ALTER | Still used by `base.js` for gcal runs. Drop 5 WhatsApp-only columns: `input_texts`, `claude_response`, `sender_phone`, `parish_match_confidence`, `parish_match_question` |
| `event_replaces` | DROP | Admin-only, marked "legacy", reachable only from the escalate/combine UI |
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

### Import shape

Surviving tables lose columns rather than gain them, so the import is a
column-projected copy, not a schema transform:

```bash
# against the recovered agora.db, per table
sqlite3 agora.db ".mode insert parishes" \
  "SELECT id, name, full_name, jurisdiction, address, lat, lng,
          website, phone, email, logo_path, acronym, chant_style,
          languages, color, live_url, donation_url, raffle_url,
          payment_url, gala_url
   FROM parishes;" > parishes.sql

# then, per file
wrangler d1 execute agora --remote --file=parishes.sql
```

`events` is the one to watch: `source_hash` carries a UNIQUE index, so a partial or
twice-run import fails loudly rather than duplicating. That is the desired behaviour —
let it fail and re-run cleanly.

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

### Phase 0 — Recover the database

- Find any off-VM copy of `agora.db`.
- Open it locally, check row counts for parishes, schedules, events.
- If nothing surfaces, decide now whether to rebuild from `seeds/parishes.js`.

**Done when:** a `.db` file opens locally with row counts you recognise.

### Phase 1 — Prune, still on Node

- Delete the WhatsApp and Vision files; strip 22 moderation endpoints from
  `routes/admin.js` and matching tabs from `admin.html`.
- Salvage `matchesWeekOfMonth` from `schedule-generator.js`, delete the rest.
- Remove `@anthropic-ai/sdk` from `package.json`.
- Run locally against the recovered DB, click through the real site.

**Done when:** `node server.js` boots, `/health` 200, map + feed + admin CRUD all work
with WhatsApp gone. Last checkpoint where the old stack proves the new scope.

### Phase 2 — Baseline schema into D1

- Write `schema.sql`: the 7 surviving tables at final shape, with the indexes that
  matter (`source_hash` unique, events date/parish/status, override join keys).
- `wrangler d1 create agora`, apply schema, import column-projected rows.
- Compare row counts table by table against the source.

**Done when:** counts match and a hand-written `SELECT` returns a parish with its schedules.

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
- Trigger manually once, confirm a row lands in `adapter_runs`.

**Done when:** a scheduled run completes unattended and its events appear in the feed.

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

**The three unmerged June branches are abandoned.** `feat/event-edit-address`,
`fix/save-event-rerender` and `fix/save-event-cache-bypass` are all admin inline-editing
fixes on `public/app.js`. None will be merged: the behaviour they patch — cache bypass
after a mutation, re-render of an open event detail after Save — is exactly what the
port changes underneath. Diagnosing it against the Worker/D1 data path gives a more
accurate answer than carrying forward a fix written for the synchronous Express one.

The branches stay on the remote as reference. Nothing merges them, and Phase 1 does not
wait on them.

## Open questions

- **Does a database backup exist?** Everything downstream of Phase 0 assumes yes.
- **Keep `adapter_runs` at all?** With one adapter left, run history may not earn its
  table. Dropping it also lets `source_run_id` go from three other tables.
- **Do the combine/cross-parish features stay?** `event_parishes` is read by the public
  feed, so the display side stays regardless — but the admin UI for creating those links
  came from the WhatsApp escalation flow. Keeping the read path while dropping the write
  path is a coherent middle position.

---

*Assessed against `kvnpt/agora` at `main`, schema `user_version = 29`. Line counts and
reference counts are from the working tree, not estimates.*
