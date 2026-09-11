# Adding parishes in bulk

Every adapter names a parish, and `events.parish_id` is a foreign key, so the
parish has to exist before anything can be scraped for it. With one or two
parishes that is a line in `seeds/parishes.js`. With an archdiocese directory —
a few hundred names and addresses at once — it is a pipeline, and this is what
that pipeline has to get right.

Nothing here is built yet. This is the brief, the constraints that will bite,
and the state of the database as at 11 September 2026, written down so the next
session does not have to rediscover any of it.

---

## What the job actually is

Scrape a jurisdiction's parish directory, and for each parish produce a row:

```
id  name  full_name  jurisdiction  address  lat  lng  timezone  website  languages
```

The directory gives you a name, an address and usually a website. Everything
else is derived, and each derivation has a failure mode worth planning for.

## Read the live database without credentials

Three endpoints answer unauthenticated, and between them they cover almost
every question worth asking before or after an ingestion run:

| | |
|---|---|
| `/api/parishes` | every parish row, all columns |
| `/api/bundle` | parishes, schedules, overrides, events, in one response |
| `/api/adapters/status` | per-adapter last run: status, counts, window, error |

```bash
curl -sS https://agora.orthodoxy.au/api/adapters/status
```

Reach for those before reaching for a token. A `D1:Edit` credential is only
needed to *write*.

## State as at 11 September 2026

```
10 parishes · 13 schedules · 68 events · 0 overrides
```

- **All 68 events are Good Shepherd's**, from the Google Calendar adapter.
- **`greek-gopssc-buderim` is seeded**; its adapter runs clean but yields one
  event, because the 2026 sheet that parish publishes is a list of dates with
  almost no times on it. That is the file, not a bug.
- **`greek-stparaskevi-blacktown` is NOT seeded yet.** Its adapter and source
  are on `main` (PR #22) and will fail until the parish row exists — the error
  names the missing parish and says to run the seed.
- **13 schedules live, but `d1/seed-parishes.sql` creates only 9.** Four rules
  were added after seeding, presumably accepted from */admin* → Schedules →
  *Infer rules from scraped events*. Worth knowing before anything reasons
  about drift between the seed file and production: they have already diverged,
  legitimately.

## Constraints that will bite a directory scrape

**`jurisdiction` is a CHECK constraint, not free text.**

```sql
CHECK(jurisdiction IN ('antiochian','greek','serbian','russian',
                       'romanian','macedonian','other'))
```

Coptic, Ukrainian, Georgian, Bulgarian and OCA parishes all collapse into
`other` as it stands. If a directory for one of those is in scope, widen the
CHECK deliberately *before* ingesting a few hundred rows, not after — it is a
schema change, and `other` is a one-way door once the rows are written.

**`lat` and `lng` are NOT NULL.** A parish whose address will not geocode
cannot be inserted at all. On a real directory that is a meaningful fraction of
rows, so decide up front: skip them, or stage them somewhere pending a pin. Do
not invent coordinates to satisfy the constraint.

**`id` is the primary key and must be derived, never sequential.** The seed
relies on `ON CONFLICT(id) DO NOTHING` to be safe to re-run; a scrape that
mints fresh ids inserts every parish a second time next year. The existing
convention is `<jurisdiction>-<name>-<suburb>`, e.g.
`greek-stparaskevi-blacktown`.

**`timezone` has a default and the default is usually wrong.** It is
`Australia/Sydney`. Queensland does not observe daylight saving, Perth is
+08:00, Adelaide is +09:30, Auckland switches on different dates to Sydney. A
directory covering more than one state must derive the zone from the address,
because `schedules.start_time` is local wall clock and an inherited default is
an hours-wrong service time waiting to happen.

## Geocoding: search by name first

`worker/lib/geocode.mjs` already wraps Nominatim, filtered to
`au,nz,pg,fj,nc,vu,sb`. Two things learned the hard way:

**A street address can geocode to the wrong end of a long street.** Looking up
"47-51 Balmoral St, Blacktown NSW 2148" returns a point about 730m from the
church. Searching for the parish *by name* returns the actual
`place_of_worship` node. So: try the name, fall back to the address, and treat
an address-only result as provisional rather than confirmed.

**Nominatim asks for one request per second.** Budget roughly four minutes per
200 parishes and do not parallelise it. A bulk run is also a good citizen
candidate for caching results to disk so a re-run costs nothing.

**A pin nobody has checked is worth marking as such.** `parishes` carries
`info_source_type`, `info_source_ref` and `info_verified_at` for exactly this.
Use them; a scraped pin and a confirmed one should not be indistinguishable six
months later.

## Writing the rows

Two routes, and the choice is not obvious.

**Through `seeds/parishes.js`.** Rows become reviewable code, the diff is
readable, CI checks the generated SQL matches, and history says where each
parish came from. This is what the repo is built for, and it is how the pin
error above got caught. It scales less comfortably to hundreds of rows in one
commit.

**Straight to D1** with a `D1:Edit` token, via `wrangler d1 execute agora
--remote` or the REST API. Faster for bulk, and the honest choice if the
directory is the system of record rather than the repo. Two caveats: the seed
file and production then diverge in a way nothing checks, and Cloudflare's
docs note the D1 REST API carries the global API rate limit and is "best suited
for administrative use" — fine for a batched ingestion, not for anything
per-request.

Whichever route, the write itself should be idempotent on `id` so a re-run
updates rather than duplicates.

## Credentials

A token is only needed for the write step.

- Mint at **Manage Account → API Tokens**, custom token, `Account` · `D1` ·
  **Edit**, scoped to the one account. D1 permissions are account-level: there
  is no per-database scoping, so the token can reach every D1 database on the
  account. Set a TTL and note the expiry — a token that expires mid-run looks
  like a bug rather than a credential problem.
- Set `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as **environment
  variables on the Claude Code environment**, not in a `.env` file. The
  container is ephemeral and environment variables are read at boot, so the
  file dies with the session and the environment setting does not.
- Verify scope before writing anything:

```bash
curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database"
```

The database is `agora`, `8e02890d-dc75-4dbe-a018-b64c7871dde9`, also in
`wrangler.toml`.

## Suggested order

1. Pick one jurisdiction's directory and scrape it to JSON — names, addresses,
   websites — with no geocoding and no writes. Look at what came back.
2. Geocode that JSON to a second file, name-first, and count how many resolved
   to a building rather than a street.
3. Diff the result against `/api/parishes` to see what is genuinely new.
4. Write, by whichever route above, idempotent on `id`.
5. Only then start on schedule sources: `docs/adapters.md` covers that half,
   and `worker/lib/pdf-sources.mjs` is where a parish's source is remembered.

Doing (1) and (2) as separate files that can be eyeballed is the whole point.
A directory scrape that geocodes and writes in one pass gives you a few hundred
rows and no way to tell which of them are wrong.
