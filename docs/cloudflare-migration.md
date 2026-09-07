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
| `events` | ALTER | Core. Drop `confidence`, `source_run_id`. `status` loses `pending_review` (no producer) but **keeps `replaced`** — the combine flow sets it. `mutation_type` enum preserved as-is. **Phase 3 must drop `confidence` from `adapters/base.js`'s upsert** (`base.js:54,84`), which still writes it |
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

### New in this version: parish provenance

Parish records historically came from three places — hand-added via Claude Code, added
over WhatsApp, and one bulk scrape of the Greek parishes — with no record of which. This
version records it. Three columns on `parishes`, to go into `schema.sql` from the start:

| Column | Type | Purpose |
|---|---|---|
| `info_source_type` | TEXT | `'website'` \| `'person'` \| `'import'` |
| `info_source_ref` | TEXT | the URL, or a person as First name + last initial (`"Kevin P."`) |
| `info_verified_at` | TEXT | ISO timestamp of the last *check*, not the row's creation |

`info_verified_at` deliberately tracks verification rather than creation: a parish added
two years ago but re-checked last month should read as fresh, and one added last week
from a stale website should not.

Frontend renders it as relative age ("checked 3 months ago") on the parish card, tappable:
a `website` source opens the source; a `person` source shows attribution and offers a
correction. Staleness becomes the invitation to contribute rather than a defect to hide.

### Oceania: parishes need their own timezone

`orthodoxy.au` covers Oceania, but the app is structurally single-timezone.
`Australia/Sydney` is a hardcoded module constant in **five files** —
`schedule-expand.js:15`, `schedule-overrides.js:7`, `routes/events.js:8`,
`public/app.js:1`, `scripts/backfill-v26.js:20` — and `parishes` has **no timezone
column**.

That is fine for Sydney and wrong for the region:

| Zone | Offset | DST |
|---|---|---|
| Australia/Perth | +08:00 | none |
| Australia/Brisbane | +10:00 | none |
| Australia/Adelaide | +09:30 / +10:30 | first Sun Oct → first Sun Apr |
| Australia/Sydney | +10:00 / +11:00 | first Sun Oct → first Sun Apr |
| Pacific/Auckland | +12:00 / +13:00 | late Sep → early Apr |

Sydney and Auckland do not switch on the same dates, so they are 2 hours apart for part
of the year and 3 for the rest. No fixed offset works, and no single "start of today"
exists across the region — which makes `sydneyTodayStartUtc()` (`routes/events.js:12`)
ambiguous the moment a non-Sydney parish exists.

**Add `parishes.timezone` (IANA name, `NOT NULL DEFAULT 'Australia/Sydney'`) to
`schema.sql` at baseline.** Free now; later it is a migration, a backfill, and an audit
of every date path that assumed one zone.

### Design principle: what gets stored local, what gets stored UTC

Recorded because it looks like legacy cruft and is not. The next person to read
`schedules.start_time` will assume it should have been UTC all along and "fix" it into a
DST bug.

| Table / column | Stores | Why |
|---|---|---|
| `schedules.start_time` | `'09:00'` local + parish zone | Recurrence rule — the **wall clock is the invariant** |
| `schedule_overrides.patch_start_time` | `'10:00'` local + parish zone | "This week it's an hour later" — same reasoning |
| `events.start_utc` | UTC instant | A one-off happens at a specific moment; the instant *is* the intent |

**Why a recurring rule must not be normalised to UTC.** Store "Sundays 9am Sydney" as
"Sundays 23:00Z" and on the first Sunday in October, when Sydney shifts to AEDT, the
liturgy silently becomes 10am local. It would drift twice a year, forever. The parish
does not reschedule in April; the clock moves under it.

This is why iCal's `RRULE` pairs `DTSTART` with a `TZID` instead of normalising, and why
Outlook and Apple Calendar store recurring events as zoned local time — a 9am standup
stays 9am across the boundary. Only single instances get normalised.

**The decisive reason is that the rule table is political, not astronomical.** A stored
local time plus an IANA zone stays correct when a government changes the rules; you
update tzdata and the projection yields new instants. A stored UTC instant computed
against yesterday's rules becomes silently wrong, and every future row needs rewriting.
This is not hypothetical — Fiji suspended DST, Turkey and Brazil abolished it, NSW
shifted its boundary early for the 2000 Olympics, Lord Howe Island runs a 30-minute
shift, and Samoa skipped a calendar day crossing the date line. Storing local + zone puts
that volatility in a library you upgrade. Storing UTC puts it in your database as a
migration.

This is also the same decision as materialize-on-read, seen twice: because occurrences are
projected at read time rather than written to rows, a tzdata change is absorbed
automatically. The old nightly generator, writing UTC rows ahead of time, would have
silently corrupted every future occurrence the next time a legislature moved a boundary.

**What is missing is not UTC — it is the explicit zone.** `'09:00'` is meaningless alone;
`'09:00' + 'Pacific/Auckland'` is a complete fact. `parishes.timezone` completes a value
that is currently half-written, hardcoded across five files.

**Admin input is a separate question, and should be local.** An admin types `9:00am`
against a zone the form fills in from the parish — the Outlook/Apple model. Nobody enters
offsets by hand. That is UX, independent of storage.

### Display time vs. comparison time

These are different needs and only one of them requires timezone maths. Worth being
explicit, because the current code conflates them.

- **Display** wants parish-local wall time — and that is already stored.
  `schedules.start_time` is `'09:00'`; the date is `'2026-09-07'`. `project()` currently
  converts that to UTC and the frontend converts it back to Sydney to render it: a round
  trip returning the string it started from. Emit `start_local` plus the parish's zone
  and the render path needs no conversion at all.
- **Comparison** wants a real instant: stream ordering, current/future filtering, and
  "happening now" all compare against `Date.now()`. This is the only consumer of the
  offset, and it is what fix 1's per-date hoist (now keyed per *zone* and date) serves.

The user's own location never enters either path. Times are shown in the parish's local
time the way a map shows a venue's opening hours — a viewer in Perth reading about an
Auckland liturgy sees Auckland time. Only "is it on right now" depends on the actual
current moment, and the client is the party that knows it.

Under a client-side lens this falls out cleanly: ship rules + overrides + one-offs with
each parish's IANA zone attached, keep the window a generous UTC range, and let the
client evaluate "now" per event against that event's own zone.

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
wrangler d1 execute agora --remote --file=d1/schema.sql
wrangler d1 execute agora --remote --file=d1/seed-parishes.sql
```

**Pasting into the dashboard console instead?** Use the `*.console.sql` siblings, not
the files above. SQL `--` comments run to end of line, so a paste that collapses
newlines — which the dashboard textarea does — turns the leading comment block into one
comment swallowing the entire file. D1 then parses zero statements and returns
*"Requests without any query are not supported"*. The console files are generated by
`node scripts/sql-for-console.js`: comments stripped, one statement per line, verified to
build a structurally identical database even with every newline removed.

```bash
d1/schema.console.sql          # 20 statements
d1/seed-parishes.console.sql   # 17 statements
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

> The operational companion to this section is `docs/deploy.md`: the same order,
> as commands, with the check that proves each step landed. This section is the
> reasoning; that one is the runbook.

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

- Write `d1/schema.sql`: the **7** surviving tables at final shape, with the indexes
  that matter (`source_hash` unique, events date/parish/status, override join keys, the
  two combine join tables). (An earlier draft said 8 — miscounted.)
- Generate `d1/seed-parishes.sql` from `seeds/parishes.js` via
  `node scripts/gen-seed-sql.js`, so the D1 seed can't drift from the list the Node app
  seeds.
- `wrangler d1 create agora`, apply schema, load the parish seed.

**Done when:** a hand-written `SELECT` returns a seeded parish, and the combine tables
exist with their foreign keys intact.

**Status: done, pending an actual D1 database.** Both files are written and validated
against a fresh SQLite database — `foreign_key_check` and `integrity_check` clean, 8
parishes and 9 rules seeded, and the real `schedule-expand.js` run against the new shape
projects 36 instances over 30 days with all four override kinds resolving correctly
(including `hidden` not being a tombstone). Deleting a combining event cascades
`event_parishes`, `event_replaces` and the combined override with no orphans. Only the
`wrangler` calls remain, and those need Cloudflare credentials.

### Phase 3 — Port the API to a Worker

- Hono for routing; one `db` helper wrapping the D1 binding so call sites stay close
  to their current shape.
- Port in dependency order: `schedule-expand` → `schedule-overrides` → public routes
  → admin routes.
- **The date lens will not fit in 10ms as written. Fix it during the port.** See the
  section below — this is the one piece of the migration where the target platform
  forces a code change rather than a port.
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

**Status: code done; the tiles archive itself is missing.** `/tiles/*`, `/logos/*` and
`/posters/*` serve from R2 with full HTTP range support, and the logo upload writes there.
But `oceania.pmtiles` lived only on the VM, and nothing in the repo can regenerate it —
`scripts/build-dark-basemap.js` bakes the *style JSON*, not the tile archive. It has to be
sourced again (a Protomaps extract, or built with the `pmtiles` CLI from a Protomaps daily
build) and uploaded:

```bash
wrangler r2 bucket create agora-assets
wrangler r2 object put agora-assets/tiles/oceania.pmtiles --file=oceania.pmtiles
```

Until then the map requests ranges correctly and fails on the archive's magic number —
transport working, content absent.

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

## The date lens vs. the 10ms ceiling

Workers Free allows **10ms of CPU per invocation** (I/O wait is never counted; a slow D1
query or external fetch costs nothing). Exceeding it throws Error 1102. This is the one
place where the platform forces a real code change rather than a port.

### The arithmetic

A 180-day window gives each weekly schedule ~26 occurrences. At ~25 parishes × ~4
schedules ≈ 100 rules, that is **~2,600 projected instances** per cold request.

The cost is not the object count. `project()` calls `localToUtc()` for the start time and
again for the end time, and each call is a four-step **Temporal polyfill** chain doing a
real IANA timezone resolution:

```js
Temporal.PlainDateTime.from(`${dateStr}T${timeStr}`)
  .toZonedDateTime(TZ).toInstant().toString({ smallestUnit: 'millisecond' })
```

That is ~**5,200 polyfill timezone conversions in the innermost loop**. The polyfill is
pure JS resolving tz rules — tens of microseconds each. At an optimistic 5µs that is
~26ms; at a realistic 20µs, ~100ms. Then dedup, sort, and `JSON.stringify` over a payload
`CLAUDE.md` records at ~800KB, itself low-single-digit ms.

Estimated **3-10× over budget** on a cold miss. Edge caching does not rescue this: a 60s
TTL makes misses rarer, but every miss must still clear 10ms or throw.

### Fix 1 — hoist the timezone work out of the loop

The real fix, and it leaves the architecture untouched. Sydney has exactly two offsets.
Resolve the UTC offset **once per date** in `buildDateIndex()` — 180 lookups instead of
5,200 — and carry it alongside the date string. `project()` then becomes string
concatenation plus one cheap `Date` parse:

```js
// per date, once: offset = '+10:00' | '+11:00'
`${date}T${time}:00.000${offset}`  →  new Date(...).toISOString()
```

Correctness holds because the offset is still IANA-derived; it simply stops re-deriving
5,200 times what has 180 distinct answers. Roughly a 30× cut in the dominant cost, and a
straight win on any hardware, metered or not.

With `parishes.timezone` in play the cache key becomes (zone, date) rather than date
alone — still trivial, since Oceania is a handful of distinct zones: ~5 zones × 35 days
≈ 175 lookups. And per **Display time vs. comparison time** above, only the ordering path
consumes these at all; rendering uses the stored wall time directly.

### Fix 2 — shrink the default window

`DEFAULT_WINDOW_DAYS = 180` (`routes/events.js:9`) is far more liturgy than anyone
scrolls, and the client's own parish sheet already fetches 28 days (`app.js:4017`).
Dropping the default to ~35 days cuts instances ~5× *and* shrinks the payload, which cuts
the serialize cost too. A product call as much as a technical one, and the cheapest single
lever available.

Fixes 1 and 2 compose, and together should bring an estimated ~100ms comfortably under
10ms. Measure with `wrangler dev --remote` before assuming.

### Resolved: the lens moved to the client

Elected during phase 3c. The Worker ships RULES, not instances: `GET /api/bundle`
returns schedules, overrides, stored one-offs and parishes, and the browser projects
them. Server-side projection does not disappear but shrinks to single-instance
resolution — `applyAdminEdit` returns the edited occurrence, and `isValidOccurrence`
must be checked server-side because a client cannot be trusted to assert that a date is
a legal occurrence of a rule. That is two timezone conversions, not 5,200.

The standing objection to this — two implementations that drift — is eliminated
structurally rather than argued away. `expandFrom()` and the whole of `merge.mjs` are
pure: no database, no runtime specifics. The Worker and the browser import the same
modules. There is one implementation.

Measured under real workerd with real D1, at 100 rules and 60 one-offs:

| | |
|---|---|
| Bundle response | 121 KB raw, **4.7 KB gzipped**, 20ms total (mostly I/O) |
| Worker CPU | two SELECTs and a serialize — the projection is gone |
| Browser, 35-day window | 501 instances → 555 cards in 11.4ms |
| Browser, 120-day window | 1,715 instances → 1,769 cards in 33.2ms |

At today's 9 rules the bundle is 11.7 KB raw. For comparison the old `/api/events`
shipped ~800 KB of expanded instances, and had to rebuild them on every request because
the feed is stale as soon as "now" moves — whereas rules cache well.

Fix 2 (shrinking the default window) is consequently moot for the Worker. The window now
only bounds how many ROWS travel, and rows are far cheaper than instances; the client
picks whatever window it renders.

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
