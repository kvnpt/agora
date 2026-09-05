# Deploying Agora

The commands for a first live deploy, in the order they have to run, with the
check that proves each step landed.

`docs/cloudflare-migration.md` is the *why* — the reasoning behind the shape of
the thing. This is the *how*, for someone standing at a terminal.

Everything here needs `wrangler` authenticated against the account that owns the
`agora` D1 database:

```bash
npx wrangler login
npx wrangler whoami        # confirm the account before touching anything
```

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

`.github/workflows/basemap.yml` is the recipe. It runs `pmtiles extract`
against a Protomaps daily planet build — which downloads only the bytes inside
the bounding box, so no planet file ever touches a disk you own — and streams
the result into R2. See **Step 2**.

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

Once you have confirmed the address and its coordinates:

```js
// seeds/parishes.js
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

Then remove its entry from `PENDING_PARISHES` in `worker/lib/adapters.mjs` and:

```bash
npm run gen:seed && npm test
```

The suite enforces both halves: every adapter targets a seeded parish unless
it is explicitly listed as pending, and nothing stays on the pending list once
its parish exists.

---

## Step 1 — Confirm the build is sound

Never deploy something you have not built locally. This is what CI runs:

```bash
npm ci
npm test
npx wrangler deploy --dry-run --outdir=/tmp/agora-build
```

The dry run is the load-bearing one: it bundles the Worker and resolves every
binding in `wrangler.toml`. A missing D1 database or R2 bucket surfaces here
rather than in production.

## Step 2 — R2 and the basemap

```bash
npx wrangler r2 bucket create agora-assets
```

Logos and posters are written at runtime by the admin panel, so the bucket
starts empty apart from the basemap.

The basemap is built by **Actions → Build basemap tiles → Run workflow**. It
needs three repository secrets (Settings → Secrets and variables → Actions),
from an R2 API token scoped to *Object Read & Write* on `agora-assets`:

| Secret | |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare account id |
| `R2_ACCESS_KEY_ID` | the token's access key |
| `R2_SECRET_ACCESS_KEY` | the token's secret |

**Run it once with "Estimate only" left ticked.** That resolves the extract and
reports the exact archive size without downloading a tile or writing anything,
so you can see what it will cost before it costs anything. Then untick and
re-run to build and upload.

The defaults — bbox `110,-50,180,0`, max zoom 12 — cover Australia, New Zealand,
PNG and Fiji west of the antimeridian. Zoom 12 is not arbitrary: the layers in
`public/protomaps-dark.json` stop styling there, so deeper tiles are bytes
nothing would draw. Tonga and Samoa sit east of 180 and would need a second
extract merged in with `pmtiles merge`.

The job refuses to upload anything over `budget_mb` (4 GB by default), checked
twice — once against the estimate, once against the built file. R2's free tier
is 10 GB in total, shared with logos and posters.

Uploading uses R2's S3 API rather than `wrangler r2 object put`, which caps out
around 300 MiB; the AWS CLI does multipart automatically at any size.

```bash
npx wrangler r2 object get agora-assets/tiles/oceania.pmtiles --file=/dev/null   # exists?
```

## Step 3 — Schema and seed

```bash
npm run db:schema     # d1/schema.sql   — 7 tables, applied once
npm run db:seed       # d1/seed-parishes.sql — 8 parishes, 9 recurrence rules
```

Both are idempotent-ish rather than idempotent: the schema uses bare
`CREATE TABLE` and will fail loudly on a second run (which is the point — it is
a baseline, not a migration), while the seed's inserts are
`ON CONFLICT(id) DO NOTHING` and can be re-run safely.

```bash
npx wrangler d1 execute agora --remote --command \
  "SELECT COUNT(*) parishes FROM parishes; SELECT COUNT(*) rules FROM schedules;"
```

> If you are pasting into the Cloudflare dashboard's SQL console instead of
> using wrangler, use `d1/schema.console.sql` and `d1/seed-parishes.console.sql`.
> The console collapses newlines on paste, which turns the leading `--` comment
> into one comment swallowing the entire file — it reports success and creates
> nothing. The `.console.sql` variants have comments stripped and one statement
> per line for exactly this reason.

## Step 4 — Secrets

Three, none of them in `wrangler.toml`:

```bash
npx wrangler secret put GOOGLE_API_KEY        # Google Calendar, for the adapter
npx wrangler secret put ACCESS_TEAM_DOMAIN    # e.g. yourteam.cloudflareaccess.com
npx wrangler secret put ACCESS_AUD            # the Access application's audience tag
```

**Admin fails closed.** With `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` unset, every
`/api/admin/*` request is refused — not "allowed for now", refused. The Access
JWT's RS256 signature is verified against the team's published keys, so a forged
`Cf-Access-Jwt-Assertion` header gets nothing. Deploying without these secrets
is safe; it just means no admin panel.

You also need the Access application itself, in the Zero Trust dashboard: a
self-hosted application covering `agora.orthodoxy.au/api/admin/*` (and the admin
UI path), with a policy allowing your own identity. `ACCESS_AUD` is that
application's audience tag.

`AGORA_DEV_ADMIN=true` bypasses all of it and exists only for `wrangler dev`. It
is deliberately absent from `wrangler.toml` so it cannot ship by accident — it
is passed on the command line by `npm run dev`.

## Step 5 — Deploy

```bash
npm run deploy
```

This ships the Worker, the `public/` directory as static assets, and registers
the cron trigger.

```bash
curl -s https://agora.<subdomain>.workers.dev/health
# {"status":"ok","parishes":8,"timestamp":"..."}
```

`/health` queries D1, so an `ok` proves the binding resolves and the schema
applied. Then check the two things `/health` does not cover:

```bash
curl -s ".../api/bundle" | head -c 400          # rules, overrides, events, parishes
curl -sI ".../tiles/oceania.pmtiles" -H "Range: bytes=0-99"   # expect 206 Partial Content
```

That `206` is worth checking explicitly. PMTiles reads a multi-hundred-megabyte
archive a few kilobytes at a time over HTTP byte serving; a `200` with the whole
body means the map will fail with a content-length error rather than a useful one.

## Step 6 — First scrape

Don't wait four hours for the cron. Trigger it through the admin endpoint:

```bash
curl -X POST ".../api/admin/adapters/gcal-antiochian-good-shepherd-antiochian-church/run" \
  -H "Cf-Access-Jwt-Assertion: <token>"
```

Then confirm it was recorded — this endpoint needs no auth:

```bash
curl -s ".../api/adapters/status"
```

`adapter_runs` is the only visibility into scraping, which is why the table was
kept when the moderation queue was cut. A run that finds zero events is recorded
as `success` with `events_found: 0`, so a source going quiet is distinguishable
from a source that broke.

## Step 7 — DNS

Point `agora.orthodoxy.au` at the Worker: **Workers & Pages → agora → Settings →
Domains & Routes → Add custom domain**. Cloudflare provisions the certificate.

Re-run the Step 5 checks against the real hostname, and load the site in a
browser — the feed, a parish sheet, and the map, which is the one thing no curl
proves.

---

## What breaks and what it looks like

| Symptom | Cause | Fix |
|---|---|---|
| `/health` returns `status: error` | D1 binding or schema | Step 3; check `database_id` in `wrangler.toml` |
| Feed empty, `/health` fine | Seed not applied | `npm run db:seed` |
| Map blank, everything else fine | `oceania.pmtiles` not in R2 | Step 2 — run the basemap workflow |
| Map errors about content-length | Range requests not served | Check for `206`, not `200` |
| Every service an hour out | Parish `timezone` wrong | `schedules.start_time` is **local** wall clock; the zone gives it meaning |
| Admin returns 503 "not configured" | Access secrets unset | Step 4 — this is the fail-closed path, not a bug |
| Admin returns 401/403 with a token | `ACCESS_AUD` mismatch | Compare against the Access application's audience tag |
| `/api/adapters/status` shows `failed` | Read `lastError` | A missing parish names itself there |

## Rolling back

`wrangler deployments list` and `wrangler rollback [id]` revert the Worker in
place, within seconds.

They do **not** revert D1. The schema is a baseline rather than a migration
chain, so there is no down-migration: a schema change is a forward-only edit and
wants a `wrangler d1 export` first.
