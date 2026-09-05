# Deploying Agora

Everything here is done in a **browser** — the Cloudflare dashboard and the
GitHub Actions tab. No terminal, no Node, no `wrangler` on your machine. That is
deliberate: the VM is gone and nothing about running this project should require
a development environment to exist anywhere.

`docs/cloudflare-migration.md` is the *why* — the reasoning behind the shape of
the thing. This is the *how*.

Where a command appears below it is for reference, or for someone who does have
a terminal. Nothing in the deploy path needs one.

---

## Where things run

| Piece | Runs on | Deployed by |
|---|---|---|
| Frontend (`public/`) | Cloudflare's edge, as Workers static assets | the deploy workflow |
| API (`worker/`) | Cloudflare Workers | the deploy workflow |
| Database | Cloudflare D1 | pasted into the dashboard SQL console, once |
| Tiles, logos, posters | Cloudflare R2 | the basemap workflow, then the admin panel |
| Scraping | A Cron Trigger, every 4 hours | registered by the deploy workflow |
| Admin sign-in | Cloudflare Access | configured in the Zero Trust dashboard |
| Tests, builds, the basemap | GitHub Actions runners | on push, or on demand |

Nothing runs on a machine you own or maintain. The only long-lived state is D1
and R2; everything else is rebuilt from the repository on every deploy.

---

## Before you start: two things that block a useful site

Neither blocks the deploy. Both block the site being worth visiting, and both
need something this repository cannot produce on its own.

### 1. `oceania.pmtiles` has to be built

The basemap archive lived only on the VM's disk, and until now nothing in the
repo could rebuild it — `scripts/build-dark-basemap.js` bakes the *style JSON*,
which describes how to colour tiles, not the tiles themselves.

Without it the map renders empty: `map.js` asks for
`pmtiles:///tiles/oceania.pmtiles`, R2 returns 404, MapLibre shows a blank
canvas. The feed still works.

`.github/workflows/basemap.yml` is the recipe, and it runs on GitHub's machines,
not yours. See **Step 3**.

### 2. The one working adapter has no parish to write to

`ADAPTERS` contains a single Google Calendar adapter, for Good Shepherd,
Clayton. `events.parish_id` is a foreign key, and that parish is **not in the
seed** — it existed only in the old production database, created through the
admin panel, and that database was not recovered.

So the cron will fail every four hours until the parish exists. It fails
*cleanly*: `runAdapter` checks for the parish before writing and records a
message naming it in `adapter_runs`, so `/api/adapters/status` tells you exactly
this. Nothing is corrupted; nothing is scraped either.

The row cannot be generated because `parishes.lat`/`lng` are `NOT NULL` and the
address needs confirming rather than guessing — the archdiocese lists Good
Shepherd as a mission at the **Monash University Religious Centre, Clayton**,
while other directories list a **Canterbury** address. A wrong pin sends someone
to the wrong building on a Sunday morning.

Once you have confirmed the address and its coordinates, add it to
`seeds/parishes.js`:

```js
{
  id: 'antiochian-good-shepherd-antiochian-church',   // must match the adapter
  name: 'The Good Shepherd, Clayton',
  full_name: 'The Good Shepherd Antiochian Orthodox Church',
  jurisdiction: 'antiochian',
  address: '<confirmed address>',
  lat: <confirmed>, lng: <confirmed>,
  timezone: 'Australia/Melbourne',                    // NOT the Sydney default
  website: 'https://www.thegoodshepherd.org.au/',
  languages: '["English"]',
  color: '#1e3a5f'
}
```

…then remove its entry from `PENDING_PARISHES` in `worker/lib/adapters.mjs`, and
regenerate the seed with `npm run gen:seed`. **CI fails if you edit one without
the other**, so you cannot get this half-done silently. If you have no terminal,
ask for the regeneration in a session like this one.

---

## Step 1 — Database

You have probably already done this. Check first:

**Workers & Pages → D1 → agora → Console**

```sql
SELECT (SELECT COUNT(*) FROM parishes) AS parishes,
       (SELECT COUNT(*) FROM schedules) AS rules;
```

Expect `parishes = 9` (eight real ones plus the `_unassigned` sentinel) and
`rules = 9`.

If the tables do not exist, paste **`d1/schema.console.sql`**. If `rules = 0`,
paste **`d1/seed-parishes.console.sql`**.

> **Use the `.console.sql` variants, not the plain ones.** The dashboard console
> collapses newlines on paste, which turns the leading `--` comment into a single
> comment swallowing the entire file — it reports success and creates nothing.
> The console variants have comments stripped and one statement per line for
> exactly this reason.

The schema is a baseline, not a migration chain: bare `CREATE TABLE`, so it fails
loudly if run twice. The seed is safe to re-run — every statement inserts only if
the row is missing. It does **not** update rows that already exist, so editing
`seeds/parishes.js` and re-seeding changes nothing on a seeded database.

## Step 2 — R2 bucket

**R2 → Create bucket → `agora-assets`**. Location hint Asia-Pacific. Nothing else
to configure.

Logos and posters are written at runtime by the admin panel, so the bucket starts
empty apart from the basemap.

## Step 3 — Build the basemap

Three repository secrets first. In Cloudflare: **R2 → API → Manage API tokens →
Create API token**, permission *Object Read & Write*, scoped to `agora-assets`.

Then in GitHub: **Settings → Secrets and variables → Actions → New repository
secret**:

| Secret | Where it comes from |
|---|---|
| `R2_ACCOUNT_ID` | R2 overview page, right-hand sidebar |
| `R2_ACCESS_KEY_ID` | shown once when the token is created |
| `R2_SECRET_ACCESS_KEY` | same — copy it before closing the dialog |

Now **Actions → Build basemap tiles → Run workflow**, leaving **Estimate only**
ticked.

That first run downloads nothing and writes nothing. It resolves the extract
against a Protomaps daily planet build and reports the exact archive size, so you
can see what it costs before it costs anything. Read the job summary, then re-run
with the box unticked to build and upload.

Defaults are bbox `110,-50,180,0` and max zoom 12. Zoom 12 is not arbitrary — the
layers in `public/protomaps-dark.json` stop styling there, so deeper tiles are
bytes nothing would draw. The bbox covers Australia, New Zealand, PNG and Fiji
west of the antimeridian; Tonga and Samoa sit east of 180 and would need a second
extract merged in.

The job refuses to upload anything over `budget_mb` (4 GB by default), checked
twice — once against the estimate, once against the built file. R2's free tier is
10 GB in total, shared with logos and posters.

## Step 4 — Deploying the Worker

`wrangler deploy` needs Node, and the dashboard's inline editor is for
single-file Workers — it cannot take the thousand-odd static assets that ship
alongside the code. So the deploy is automated. Pick one of two ways.

### Option A — Cloudflare Workers Builds (no API token)

**Workers & Pages → agora → Settings → Build → Connect**, then choose this
repository and the branch to deploy from.

Cloudflare clones, builds and deploys on every push. Authorisation is the GitHub
app you approve in Cloudflare's own dashboard, so **no credential is ever created,
copied, or stored by you** — which is the whole argument for it.

### Option B — the deploy workflow in this repo

`.github/workflows/deploy.yml` runs the test suite and then deploys, on every
push to `main` and on demand from the Actions tab.

Two more repository secrets:

| Secret | Where it comes from |
|---|---|
| `CLOUDFLARE_API_TOKEN` | **My Profile → API Tokens → Create Token → "Edit Cloudflare Workers"** template |
| `CLOUDFLARE_ACCOUNT_ID` | Workers & Pages overview, right-hand sidebar |

Use the template rather than hand-picking permissions — a deploy touches the
script, its bindings and its triggers, and an under-scoped token fails in ways
that read like unrelated bugs. Set an expiry, and roll the token if it is ever
pasted anywhere it should not be.

Option A is fewer moving parts. Option B gives you the test gate and a deploy
history in GitHub. They are not exclusive, but running both means two deploys
per push racing each other — pick one.

Either way, the deploy ships three things: the Worker code, `public/` as static
assets, and the cron trigger from `wrangler.toml`.

## Step 5 — Custom domain

**Workers & Pages → agora → Settings → Domains & Routes → Add → Custom domain**,
`agora.orthodoxy.au`. Cloudflare provisions the certificate.

Until this is attached the site is reachable at
`agora.<your-subdomain>.workers.dev`, which is a fine place to do the checks
below.

## Step 6 — Verify

Three things, in a browser tab.

**`/health`** — queries D1, so an `ok` here proves the binding resolved *and* the
schema is applied, not merely that the Worker booted.

```
https://agora.orthodoxy.au/health
{"status":"ok","parishes":8,"timestamp":"..."}
```

**`/api/bundle`** — should return rules, overrides, one-off events and parishes.
An empty `parishes` array with a healthy `/health` means the seed did not land.

**The map.** Load the site itself. This is the one thing no status check proves:
tiles are served by byte range, and a subtly wrong range serves a broken map
rather than an error. If the map is blank but the feed works, the basemap is
missing (Step 3).

## Step 7 — Admin access

In **Zero Trust → Access → Applications → Add an application → Self-hosted**:

- Application domain `agora.orthodoxy.au`
- **Two paths: `/admin.html` and `/api/admin/*`**
- A policy allowing your own email

**Cover the page, not just the API.** Access signs a user in by redirecting them
to your identity provider, and a redirect only works on a page navigation — a
`fetch()` cannot follow one usefully. If the application covers only the API,
`/admin.html` loads for anyone, discovers it has no session, and has nowhere to
send them.

Then the Worker's secrets, in **Workers & Pages → agora → Settings → Variables
and Secrets**, type **Secret** (not plaintext):

| Secret | For |
|---|---|
| `ACCESS_TEAM_DOMAIN` | e.g. `yourteam.cloudflareaccess.com` |
| `ACCESS_AUD` | the Access application's audience tag |
| `GOOGLE_API_KEY` | the Google Calendar adapter |

**Admin fails closed.** With `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` unset, every
`/api/admin/*` request is refused — not "allowed for now", refused. The Access
JWT's RS256 signature is verified against the team's published keys, so a forged
`Cf-Access-Jwt-Assertion` header gets nothing. Deploying without these is safe;
it just means no admin panel, and the admin page says so in as many words.

`AGORA_DEV_ADMIN=true` bypasses all of it and exists only for `wrangler dev`. It
is deliberately absent from `wrangler.toml` so it cannot ship by accident.

## Step 8 — First scrape

Only meaningful once the Good Shepherd parish exists (see the second blocker
above). Until then this will record a failure naming the missing parish, which is
the correct behaviour and worth seeing once.

**There is no button for this.** `POST /api/admin/adapters/:id/run` exists in
the Worker and nothing in the admin UI calls it, so without a terminal the only
trigger is the cron — every four hours, on the hour. That is a gap worth closing
if scraping ever needs babysitting; it is not one today, with a single adapter
that cannot run yet anyway.

What you *can* open in a browser is the status, which needs no auth:

```
https://agora.orthodoxy.au/api/adapters/status
```

`adapter_runs` is the only visibility into scraping, which is why the table was
kept when the moderation queue was cut. A run that finds zero events is recorded
as `success` with `events_found: 0`, so a source going quiet is distinguishable
from a source that broke.

---

## What breaks and what it looks like

| Symptom | Cause | Fix |
|---|---|---|
| `/health` returns `status: error` | D1 binding or schema | Step 1; check `database_id` in `wrangler.toml` |
| Feed empty, `/health` fine | Seed not applied | Step 1 — paste `seed-parishes.console.sql` |
| SQL console says "Requests without any query are not supported" | You pasted a `.sql` file, not a `.console.sql` one | Step 1 |
| Map blank, everything else fine | `oceania.pmtiles` not in R2 | Step 3 |
| Map errors about content-length | Byte ranges not served | The response must be `206`, not `200` |
| Every service an hour out | Parish `timezone` wrong | `schedules.start_time` is **local** wall clock; the zone gives it meaning |
| Every service listed twice | The seed ran twice against a pre-fix build | See below — the fix stops it happening, it does not clean up |
| Admin page says "not configured" | Access secrets unset | Step 7 — this is the fail-closed path, not a bug |
| Admin page says "not signed in" | No Access session | Check the application covers `/admin.html`, not only the API |
| `/api/adapters/status` shows `failed` | Read `lastError` | A missing parish names itself there |

## If you seeded twice before this was fixed

Re-running the seed used to insert a second copy of every recurrence rule, which
renders every service twice. The seed no longer does this, but a database that
already has duplicates keeps them. Check in the D1 console:

```sql
SELECT COUNT(*) AS total,
       COUNT(DISTINCT parish_id || day_of_week || start_time || title
             || COALESCE(week_of_month, '')) AS distinct_rules
FROM schedules;
```

If those differ, keep the oldest of each set:

```sql
DELETE FROM schedules WHERE id NOT IN (
  SELECT MIN(id) FROM schedules
  GROUP BY parish_id, day_of_week, start_time, title, COALESCE(week_of_month, '')
);
```

**Do this before creating any overrides.** `schedule_overrides` references
`schedules(id)` with `ON DELETE CASCADE`, so deleting a duplicate silently takes
every override attached to it — every cancellation, time change and combine. On a database that has
only ever been seeded there is nothing to lose; on a live one, take an export
first.

## Rolling back

**Workers & Pages → agora → Deployments** lists every version with a rollback
button. It takes seconds and needs no terminal.

It does **not** roll back D1. The schema is a baseline rather than a migration
chain, so there is no down-migration: a schema change is forward-only, and wants
an export taken first.
