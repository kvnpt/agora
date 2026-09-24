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

**The bundle is asked for every time, and asking is cheap.** `/api/bundle`
is `Cache-Control: no-cache` with an ETag that is a hash of the body, so a
browser never answers from its own copy and an unchanged bundle is a bodiless
304. The body is kept in the edge cache under a *data version* — one small R2
object, `meta/data-version` — that every successful write under `/api/admin/`
and every cron run bumps (`worker/lib/data-version.mjs`), so asking rarely
reaches D1 and an edit is what the admin's next load of the app gets. It was
`max-age=60, stale-while-revalidate=600` until an edit in /admin kept not
showing on the way back to the app. The version is in R2 rather than D1 so that
no migration has to land first. A write that bypasses the Worker (an import
from a terminal) does not bump it and shows within ten minutes, when the edge
copy expires.

On the wire a schedule rule carries **its own columns only**: `languages` and
`location_override` are its to set, and where either is null the parish's is
what shows. Everything else — name, pin, zone, website — is the parish's, and
the browser joins it back from the parish list in the same response
(`public/shared/parish-join.mjs`, the one list the Worker's SQL join is also
built from). Nothing public carries `updated_by`; it is an admin's email.

**Synthetic ids.** A projected occurrence has the id `"<scheduleId>:YYYY-MM-DD"`, e.g.
`42:2026-09-06`. It is stable and addressable, so a deep link to a service that has never
existed as a row resolves — client-side, from rules the browser already holds.

**The feed has no last page.** `state._horizonDays` is how far forward the
window reaches; **Load more** adds to it and nothing takes it away. The step
costs a request only for what is genuinely window-bound — the overrides and
stored one-offs in the new stretch — because the rules that produce the
occurrences are already in the browser, which is the whole point of the lens.
`agoraBundle.load()` therefore takes a window and *widens*, never replaces:
the parish sheet asking for its month must not shrink what the main feed has
grown to.

**A date segment says where the stream starts.** `/smg/2026-07`,
`/next-thursday`, `/liturgy/wednesday/march` — `public/shared/dates.js` resolves
them, and a focus is a *from*, never a single day: a parish does not publish a
month at a time, and a picked day with nothing on it should show the next thing
that is. A month-shaped slug keeps its shape through the round trip (`2026-07`
does not read back as `2026-07-01`); a relative one resolves to the day it meant
and the URL settles on that. One focus, shared by the main feed and the parish
card, because the URL carries one date segment and two would immediately
disagree. Three-letter month abbreviations are deliberately NOT slugs — `sep` is
a parish, the acronym resolves last, and reserving it would not raise a clash but
silently take that parish's link away.

**A parish's address is where the service is.** Not its mailbox and not the
priest's house: Agora answers "which parish is near me and when", so the stored
address is the door somebody walks through. A parish that meets in another
parish's church gets that church's address and its pin, ten metres off so both
dots can be tapped — `scripts/geocode-parish.mjs` reads the "Services held at:"
line for this and matches it against the parishes already in the table.
`schedules.location_override` is NOT this: that is for the one Sunday a service
moves, and a permanent venue hidden there would leave the map pin on a post
office.

**A source line says when we last looked, never that it is right.** A parish's
details and a parish's service times are the same kind of claim — something a
source published, which nothing in the row expires — so both carry
name/ref/checked_at (`info_source_*`/`info_checked_at`, `source_*`) and both
render through one function as "Updated 3 months ago · Antiochian Archdiocese".
No date renders no date. `info_verified_at` looks like the same field and is
not: it means a *person* confirmed the row against the place itself, nothing
renders it, and it is what stops a re-import moving a pin somebody checked. A
scrape stamps the first and never the second — a guard on the checked date
would freeze every row at its first import.

**Sources compete, and the ladder decides.** A parish is described by several
sources at once and they disagree, so `public/shared/source-tiers.js` writes the
order down once — **admin > the parish's own site or social feed > its
jurisdiction's directory > a search engine > a third-party aggregator > null**
— and `outranks` is the only comparison anyone makes. It is *strict*: two
sources at one tier disagreeing is not something a rank settles, so the later
read does not win by being later.

Tiers are **derived, not stored**. `parishes.info_source_type` has three values
against the ladder's five and 281 of 293 rows say `import`, which is true and
says nothing; the URL already in `info_source_ref` says whether that import read
the jurisdiction's own directory or an aggregator.

`info_overrides` holds the rulings made against that ladder — one row per
parish per fact, and only where somebody has deliberately decided something, so
absence means every import behaves exactly as before. It is to *information*
what `schedule_overrides` is to an *occurrence*. A ruling stores no value: the
parish row is the value, and a second copy is a way to drift. `note` is NOT
NULL, because an import refusing half a page is indistinguishable from a broken
one unless it says why — which is also why the refusal is rendered on the parish
card, on the jurisdiction card and in the import's own plan.

The case that paid for it: St Mary Magdalene, Elimbah publishes two Vespers on
its Antiochian directory page, neither runs, and both rules were deleted in
`/admin`. Nothing recorded that. `planWrite` pairs a scraped rule with an
*existing* row on parish + weekday + time, a deleted row is not one, and the
insert guard only asks whether the rule is there now — so a re-run put both
back. A deactivated rule fared worse: it matched, got updated, and `active=1`
switched it on again. `info_verified_at` is the parish-side equivalent and is
all-or-nothing; a pin is per field, so holding that parish's address does not
also stop a re-run correcting the phone number nobody has looked at.

Served **publicly** at `/api/info-overrides`, minus `updated_by`. The importers
are scripts run from a terminal with no Cloudflare credential — the same
argument that put `pdf_source_overrides` on a public route, and a stronger one:
a ruling only the Worker could see is a ruling the import ignores.

**Nothing disappears.** Every occurrence in a window emits exactly one instance. A
cancellation is a *tombstone* that still renders, so someone who would otherwise turn up
at church sees "CANCELLED" rather than the service silently vanishing.

A corollary that cost a bug: editing a field on an occurrence **keeps whatever
that occurrence already is**. `applyAdminEdit` used to set `kind='modified'` for
any edit naming a display field, so correcting the title of a cancelled service
— or putting a poster on it — dropped the tombstone and put the service back on
the feed. Reviving is `status: 'approved'` and nothing else should do it.

**A poster belongs to an occurrence, not to a rule.** `events.poster_path` is
the last working piece of the WhatsApp ingestor and is still rendered on feasts,
talks, socials and youth events. A rule has no poster — a weekly liturgy has no
flyer — so `schedule_overrides.patch_poster_path` is the only place a projected
instance can hold one, and it is the one `patch_*` where NULL means "there
isn't one" rather than "inherit". `POST /api/admin/events/:id/poster` takes both
id shapes and routes on the shape, like every other event route.

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
(`POST /api/admin/events/:id/escalate`, and `POST /api/admin/events`, which
takes the same two lists so a one-off entered *because* it replaces something
never exists for a round trip beside the thing it replaces):

| Capability | Mechanism | Target id |
|---|---|---|
| One event under several parishes | `event_parishes` | parish ids |
| Replace a stored one-off | `event_replaces` + `status='replaced'` | integer |
| Replace a schedule occurrence | `schedule_overrides` kind `combined` | `"sid:date"` |

`event_replaces` is described as legacy in old comments. It is pre-v26 but **not**
redundant: it is the only path for combining against a stored one-off.

A combine is the one write whose target is **not** the parish in the URL, which
makes it the one a parish contact can use to reach out of their own scope. So
it is scoped per target, and the refusal is not a dead end: the same request
with `propose` set applies the half that IS theirs and files the rest as an
`event.combine` row in `admin_proposals` — their parish's side of a deanery
liturgy should not wait on an owner, and the other parish's side should not
happen because somebody ticked a box. The ask carries the **whole** desired
state, because `writeCombine` is a target state and removes what it is not
told; a payload holding only the refused half would strip the applied half on
approval.

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
the two cannot disagree about what to fetch. The **URL alone** may be changed
from /admin, because a parish republishing under a new path is the commonest
maintenance act there is and needs no review; `pdf_source_overrides` holds only
what was deliberately changed, exactly as `jurisdiction_colors` does. That
override is served *publicly* at `/api/pdf-sources` and read by the Action too —
an override only the Worker could see would break the very invariant the shared
module exists for. Getting text out of a PDF happens in
that Action, never in the Worker; `scripts/extract-parish-pdf.mjs` says why at
length, and the short version is that one of the surveyed parish schedules is a
photograph of a piece of paper.

**A jurisdiction's colour is written down once**, in
`public/shared/jurisdiction-colors.js`, which the app, the map and the seed all
read — it exists because that table was three tables and two of them disagreed
about Greek. `jurisdiction_colors` in D1 does not make it four: it holds only
the rows */admin* → Colours has deliberately changed, absence means the file's
value, and a reset deletes the row rather than writing the default into it.
Changing a jurisdiction's colour does not touch `parishes.color`, which is a
per-parish identity mark; the panel offers that as a separate, counted repaint
of the rows still carrying the old colour.

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

**Green CI is the merge gate, not a human.** A pull request whose checks pass may
be merged without waiting for a review, Claude's own included. It is the same
reasoning that deleted the deploy workflow: the gate that actually catches things
here is the machine one, and a review step nobody is reliably awake for is a
queue rather than a safeguard. Merging is deploying, so it is the check being
*green* that earns the merge — a red or still-running one waits, every time, and
"probably a flake" is not a reason to merge past it.

What that buys has a limit worth naming, and it is not "CI cannot see the
frontend". `public/shared/` is covered well — the projection, the timezone maths,
the dedup and the slug tables are imported by the suite directly, which is half
the point of the modules being shared. What nothing *executes* is the app built
on top of them: `app.js`, `filters.js`, `bundle.js`, `map.js`. A few tests read
those as text, to assert they reach for the shared table rather than keeping a
private copy, and that is not the same as running them.

So a change to rendering, filtering or wiring merges on the strength of whatever
its author did to check it, and the PR should say what that was. Reproducing the
fault against the old code first and then re-measuring is the honest version.
"Tests pass" is not, when no test ran the line that changed.

**`docs/browser-checks.md` is how to do that here** — driving the app with
Playwright, the console noise that is environmental rather than yours, and the
way `/api/bundle` is cached, which used to make a write you had just made
look like it never happened.

It also records where the risk actually sits, which is not where it feels like
it sits. Two bugs shipped in one week with full test coverage of their logic and
a broken **way in**: a combine ask whose parish list came back empty for the
only role that needed it, and a notices panel whose render was unreachable
behind an early return. Neither was a logic error; neither could fail a test.
Test the behaviour, then open the thing and check the door is there.

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

**Told, not asked.** An owner may combine across parishes without waiting on
the parishes it touches, because a quorum of contacts who mostly do not exist
would mean a deanery liturgy never gets published. The parish it happens TO
still hears about it: `/api/admin/parish-notices` reads `event_parishes` and the
`combined` overrides back for the parishes an account holds, and **Take my
parish out** is a veto after the fact — fast to act on, impossible to deadlock.
The notice is *derived*, like the feed and the source tiers; `parish_notices_seen`
holds only the one thing that cannot be, which is whether a person has looked.

**An ask is a refusal with somewhere to go.** `admin_proposals` holds the four
things somebody was refused and the panel could carry for them — a parish
delete, an acronym, a jurisdiction colour, and a combine reaching another
parish. The first three are *capability* refusals and the fourth is a *scope*
refusal, which is why nothing in `roles.mjs` grants `event.combine` and the
events routes raise it themselves. An owner decides; `/api/admin/ping` counts
what is open and the main app puts a red dot on the account icon, for a
decider only — a dot on somebody who can only look at it is noise. It is still
**not a moderation queue**: ordinary edits are never proposed, they just
happen.

**Who may do what lives in `admin_roles`.** Cloudflare Access decides who
reaches `/admin`; that table decides what they may touch once inside —
owner, editor, or a parish contact scoped to their own parishes. Routes name
a *capability*, never a role, so a control the panel greys out and a route
that refuses read the same map. **An empty table means every authenticated
user is an owner**, which is exactly the behaviour before roles existed, so
the deploy cannot lock anybody out; the first row flips it and absence then
means no access. That is the opposite of `adapter_settings`, where absence
must never stop a scrape, and deliberately so: a missed scrape is fixed by
the next one, a wrongly-granted delete is not.

**Signed in is not the same as editing.** On the main app a parish sheet has
one pencil, and `state.parishEditMode` holds the single parish it turns on.
Until then the sheet is the sheet a visitor sees: no schedule pencils, no logo
button, no form in the DOM behind `display:none`. Edit mode covers everything
on that sheet including the service times, and a rule is editable wherever it
renders — the sheet or the main services panel — exactly when its own parish is
the one open. `state.eventEditMode` is the same thing for the event drawer: one
pencil until somebody says they are editing, then Cancel, Suppress, Delete,
Combine and the form. `hideAdminControls` is **gone** — it was a remembered
preference for making tools go away, which is what a mode does by default, and
two modes now cover everything it did.

**Three different things are called "hide", and only one of them hides an
event.** Worth knowing before reaching for one:

| | Where | What it does |
|---|---|---|
| `status='hidden'`, override `kind='hidden'` | the row, or the override | Drops it from the feed entirely. **Not a tombstone** — no card, no "CANCELLED", gone |
| `hide_live` | `events`/`schedules`, patchable per occurrence | Nothing to do with hiding. Suppresses the **Watch Live** badge for that one service |
| `parish_scoped` | same | Shows only on its parish's own card, never in the main feed |

`filterByStatus` in `merge.mjs` passes `approved`, `cancelled` and `combined` —
the last two still render, as tombstones, because nothing disappears.
`hidden` is the deliberate exception and is for something that should never
have been published: a duplicate, a mistake. It is **not** for a service that is
not running. `DELETE` on a projected occurrence writes a `hidden` override, not
a delete; the rule and the other weeks survive.

**Cancel and Suppress are confirmed, because they look like neighbours and
behave nothing alike.** A cancellation stays on the feed as a tombstone so
somebody who would have turned up sees it is off; a suppression takes the
service off the site with no notice at all. Reaching for the wrong one sends
somebody to a locked church, so each says which it is before it does it.

The parish sheet's **add-an-event button** is the one control outside that
mode, and deliberately: the mode exists so a signed-in person reads the sheet a
visitor reads, and this alters nothing the sheet is showing — it makes a
one-off that is not on the sheet at all yet, from a circle floating clear of
the content rather than a pencil sitting in it. What it *is* gated on is the
capability, per parish, which is why `state.adminWho` now keeps the whole
`/api/admin/ping` answer and not just "signed in": `adminMay('event.edit', pid)`
asks the two questions the Worker asks, in the order it asks them, so a button
that is absent and a route that refuses cannot disagree. An owner and an editor
see it on every sheet; a parish contact sees it on their own parishes only.

**Admin fails closed.** With `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` unset, every
`/api/admin/*` request is refused. The Access JWT's signature is verified against the
team's published keys — a forged `Cf-Access-Jwt-Assertion` header gets nothing.

`AGORA_DEV_ADMIN=true` bypasses that, and exists only for `wrangler dev`. It is
deliberately absent from `wrangler.toml` so it cannot ship by accident.

## Database

The schema is one baseline file, `d1/schema.sql` — not a migration chain. Ten tables.

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
