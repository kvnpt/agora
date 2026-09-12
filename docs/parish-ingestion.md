# Adding parishes in bulk

Every adapter names a parish, and `events.parish_id` is a foreign key, so the
parish has to exist before anything can be scraped for it. With one or two
parishes that is a line in `seeds/parishes.js`. With an archdiocese directory —
a few hundred names and addresses at once — it is a pipeline, and this is what
that pipeline has to get right.

This began as a brief for work that had not been done. Two directories have
since been ingested — the Greek Archdiocese, 135 parishes, and the ROCOR
Australian and New Zealand Diocese, 33 of 37 — so the constraints below are now
field notes rather than predictions, and the two sections at the end record what
each run actually cost. They cost different things: the Greek directory
published addresses that were sometimes wrong, and the Russian one publishes no
addresses at all.

---

## What the job actually is

Scrape a jurisdiction's parish directory, and for each parish produce a row:

```
id  name  full_name  jurisdiction  address  lat  lng  timezone  website  languages
      feast_day
```

The directory gives you a name, an address and usually a website. Everything
else is derived, and each derivation has a failure mode worth planning for.

## Read the live database without credentials

Three endpoints answer unauthenticated, and between them they cover almost
every question worth asking before or after an ingestion run:

| | |
|---|---|
| `/api/parishes` | every real parish, all columns (`_unassigned` is excluded) |
| `/api/bundle` | parishes, schedules, overrides, events, in one response |
| `/api/adapters/status` | per-adapter last run: status, counts, window, error |

```bash
curl -sS https://agora.orthodoxy.au/api/adapters/status
```

Reach for those before reaching for a token. A `D1:Edit` credential is only
needed to *write*.

## State as at 12 September 2026

```
177 parishes · 13 schedules · 68 events · 0 overrides
```

135 of those parishes are the Greek Archdiocese import, 33 the ROCOR one, and 9
the Antiochian seed. Schedules and events are untouched by both — neither
directory publishes service times at all, so adapters remain the only route to
those.

The notes below describe the database *before* both imports, and are kept
because the reasoning attached to them still holds.

Those are the numbers `/api/bundle` returns, and the endpoint is a view rather
than a row count — worth keeping straight before anything diffs against it.
`parishes` hides `_unassigned`, which `d1/schema.sql` inserts itself, so the
table holds eleven rows and ten real parishes. `events` is windowed and
filtered to `source_adapter != 'schedule'`. `schedules` is `active = 1` and
inside its effective dates; `overrides` is window-scoped.

- **All 68 events in the window are Good Shepherd's**, from the Google Calendar
  adapter.
- **`greek-gopssc-buderim` is seeded**; its adapter runs clean but yields one
  event, because the 2026 sheet that parish publishes is a list of dates with
  almost no times on it. That is the file, not a bug. The event is Holy
  Thursday, 2026-04-09, which is behind the bundle's window — hence 68 above
  and 69 rows in the table.
- **`greek-stparaskevi-blacktown` is in the seed but not in production.**
  `seeds/parishes.js` and `d1/seed-parishes.sql` both carry it, and
  `PENDING_PARISHES` is empty with a test asserting that every adapter's parish
  is seeded. What has not happened is `npm run db:seed` against remote D1. Add
  the row a second time and you have a conflict to unpick, not a fix.
- **Seeding it will not by itself make its adapter green.** Today
  `pdf-stparaskevi-blacktown` fails on *No extracted text at
  `pdf-schedules/stparaskevi-blacktown.json`*, because `fetchEvents()` runs
  before the missing-parish guard and never reaches it. The extraction Action
  (`.github/workflows/parish-pdf.yml`) has to run as well.
- **13 schedules live, but `d1/seed-parishes.sql` creates only 9.** The four
  extra are all Good Shepherd's, for which the seed writes no rules at all —
  accepted from */admin* → Schedules → *Infer rules from scraped events*, and
  it is the only parish with scraped events to infer from. Worth knowing before
  anything reasons about drift between the seed file and production: they have
  already diverged, legitimately.

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
months later. `info_source_type` is a CHECK too — `'website'`, `'person'` or
`'import'` — and a directory scrape is `'import'`.

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

## Doing this again

The fetching and parsing is written fresh per jurisdiction — every directory is
a different site. Everything after parsing is not: `scripts/parish-import.mjs`
holds the three parts that repeat, with `scripts/parish-import.test.mjs` pinning
the conventions to real cases from the Greek run.

```js
parishId(jurisdiction, name, suburb)  // <jurisdiction>-<name>-<suburb>
reconcile(scraped, existing)          // -> { pinned, fresh, ambiguous }
buildUpsert(rows)                     // the guarded ON CONFLICT
```

**`reconcile` is not optional, and its output is meant to be read.** A scrape
mints ids by derivation, and derivation cannot reproduce an id somebody typed:
`antiochian-good-shepherd-antiochian-church` is hyphenated inside its name,
names its jurisdiction twice, and does not contain its suburb. Trusting
derivation there inserts a second Good Shepherd, and because the Google Calendar
adapter names the old id, every event stays on the old row while an empty
duplicate appears beside it.

The trap is that the mismatch is *partial*. Of the nine Antiochian rows, "St
John the Baptist" and "Sts Peter & Paul" happen to derive back to their existing
ids while "St Mary's" and "Sts Michael & Gabriel" do not — so some rows update,
some duplicate, and the result is much harder to spot than a clean failure. So
match on content, print the pin list, and look at it before writing. `ambiguous`
is never resolved automatically: a scraped parish matching two existing rows is
a question for a person.

One live id will never derive, and it is correct as it is: `greek-gopssc-buderim`
is an acronym somebody typed, which is precisely what `reconcile` is for.

There was a second. The first run's trailing-honorific trim ran against the
joined string rather than its tokens, so any name ending in a word ending in
"st" lost its tail — `stjohnbaptist` became `stjohnbapti`, and Port Adelaide was
written as `greek-nativitychri-portadelaide`. The module trims tokens now, a
test covers it, and that row has been renamed to
`greek-nativitychrist-portadelaide`. Renaming was safe only because nothing
referenced it: `parish_id` is a foreign key from `events`, `schedules` and
`event_parishes`, so check all three are empty before touching a parish id, and
expect that to stop being true as soon as a parish has an adapter.

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

---

## What the Greek Archdiocese run actually cost

135 parishes, scraped from `greekorthodox.org.au`, geocoded, and written
straight to D1. Notes worth keeping for the next jurisdiction:

**The directory is a WordPress site whose church post type is not in the REST
API.** Only the `churches_locations` taxonomy is exposed, so the listing pages
have to be walked. Caching every page to disk first made the parsing iterative
and cost the site exactly one pass.

**Field labels are not a schema.** 43 distinct labels across 135 pages, for
about a dozen real fields: `Website` / `Parish Website` / `Church Website`,
nine spellings of email, and typos (`Parish Deason`, `Parish Email:`). Keep
every label verbatim alongside the normalised view; the normalisation will be
wrong somewhere.

**Timezone must come from the address, never the region.** The Archdiocese's
own regions span zones — "Adelaide & Darwin" covers SA and NT, "Canberra &
Tasmania" covers ACT, NSW and TAS. Derived from the address the 135 parishes
land in seven zones, and `Australia/Sydney` would have been wrong for 92.

**Geocoding took three passes and the addresses were the problem, not the
geocoder.** Free-form Nominatim left 28 parishes unplaced: `St` reads as Saint,
house-number ranges miss, `Cnr X & Y` is not an address, and several addresses
carry PO boxes, parentheticals or dotted `N.S.W`. Structured queries recovered
25. Of the nine that needed research, *seven had something wrong in the
published address* — a street spelled `Holterman` for Holtermann and `McAlister`
for Macalister, and four parishes filed under a suburb they are not in
(Willesden Rd is in Hughesdale, O'Connell Rd in Merrimu, the Tamworth church in
North Tamworth, the "Noarlunga" parish in Christie Downs). Budget for research,
not just for rate limits.

**Re-geocoding a parish that already had a confirmed pin moved it 784m.** The
same class of error as the 730m one above, on the same parish. It is the reason
the write leaves rows with `info_verified_at` set alone: `ON CONFLICT(id) DO
UPDATE ... WHERE parishes.info_verified_at IS NULL`. A re-run refreshes what
nobody has checked and cannot overwrite what somebody has.

**Final confidence: 37 pins on a building, 95 street-level, 2 previously
verified, 1 suburb-level.** `info_verified_at` is NULL on all 135 — these are
researched, not confirmed. The one suburb-level pin is St Athanasios inside
Rookwood Necropolis, which is absent from OSM along with the necropolis's
internal roads; the locality centroid at least falls inside the cemetery.

**OSM is a better source than Nominatim for a known church.** Overpass found
buildings tagged `denomination=greek_orthodox` that a name search could not,
including one OSM files under its parish rather than its dedication. Expect the
tunnel to drop on long Overpass queries and keep them small.

---

## What the ROCOR run actually cost

37 places of worship, scraped from the Australian and New Zealand Diocese of the
Russian Orthodox Church Outside Russia, geocoded, and written to D1 — 33 of
them; the other four are held back below. Three scripts, run in order, each
writing a file that can be read before the next one runs:

```bash
node scripts/scrape-rocor.mjs   cache/ rocor-scraped.json
node scripts/geocode-rocor.mjs  rocor-scraped.json cache/geo/ rocor-geocoded.json
node scripts/build-rocor-sql.mjs rocor-geocoded.json rocor-parishes.sql
```

**The diocese's homepage is compromised; the diocese is fine.** `rocor.org.au/`
serves cloaked Turkish casino spam to some user agents. Everything else on the
site — the directory page, the REST API, every parish page — is intact and
current. A scrape that checks the front door and stops will conclude the
jurisdiction has vanished. Fetch the pages, not the homepage, and do not reach
for an archive.

**The directory the diocese points at is dead.** 31 of its 39 links go to
`directory.stinnocentpress.com/viewparish.cgi?Uid=NNN`, the ROCOR-wide directory
that used to carry every parish's address, phone and clergy. Every one of those
URLs now 404s and the directory root answers 403. So the diocese publishes, for
most of its parishes, a name and a suburb and nothing else.

**Which made a second source the whole job.** `orthodox-world.org` lists the same
diocese — 43 entries across Australia and New Zealand — with a street address on
every one. It is a third party, so parish-published addresses win over it and
disagreements are recorded rather than resolved
(`scripts/rocor-addresses.mjs`). Matching is on state plus dedication and never
on suburb, because the suburb is the field the two sources disagree about.

**And the disagreements are the useful part.** The diocese's own suburbs are
wrong more often than a wrong address would have been:

| the diocese says | it is actually in |
|---|---|
| Woollongong *(sic)* | Corrimal |
| Bombala | Gunningrah |
| Canberra | Narrabundah |
| Hobart | New Town |
| Christchurch | Sydenham |
| Brisbane | Woolloongabba |
| Auckland | Mount Eden |

Every one of those would have pinned in the right region and the wrong place.

**One of them is wrong about the STATE, and that is an hour twice a year.** The
directory files Tweed Heads under Queensland. Tweed Heads is in New South Wales,
which observes daylight saving; Queensland does not. Worse, constraining
Nominatim to the directory's state does not fail — it answers "Tweed Heads,
Queensland" with **Tweed Heads Avenue**, a residential street 80km away in North
Tamborine, and a run that takes `results[0]` pins the parish in the wrong state
and never says so. So a locality result is now checked: the first component of
its display name must name the suburb, compared as a sorted set of words
("East Brunswick" and "Brunswick East" are one place), and a result that names
something else is treated as no result and the question asked again without the
state.

**The ACT has no `state`.** Nominatim returns Canberra's parish under
`address.territory`, so reading `address.state` left it with no timezone at all.
The zone now comes from `ISO3166-2-lvl4`, which is always present.

**Overpass, again.** `overpass-api.de` is unreachable from this environment
entirely — every query, however small, closes mid-exchange — and
`overpass.kumi.systems` answers in about a second but returns 504 on a 6km
radius over inner Sydney or Melbourne. What works is *one* Oceania-wide query
for `denomination~russian`: 15 buildings, 37 seconds, and it answers more
parishes than the per-suburb search does. The per-suburb pass is kept as a
best-effort tier with one attempt and a short deadline.

**Matching on the dedication alone hands one church to several parishes.**
Croydon is 2.4km from Strathfield and took the cathedral; Fairfield is 1.5km
from Cabramatta and took its church. Both looked completely confident. A
building is now claimed by at most one parish, and the tier that accepted a
church on proximity alone was removed rather than tuned — it was the source of
both errors.

**A dedication is not a jurisdiction.** Brisbane's Russian cathedral and the
Serbian St Nicholas sit 500m apart, and OSM tags the Serbian one
`denomination=greek_orthodox` for good measure. A name match against another
jurisdiction's denomination is now refused outright, whatever the name says.

**Two of the OSM buildings are named for their city and one for nothing at all**
("Geelong Russian Orthodox Church", "Warrnambool Orthodox Church", and an
Adelaide building tagged only "Russian Orthodox"), so no token will ever match
the dedication. Those four are pinned by hand in `scripts/rocor-addresses.mjs`,
with the reason written next to each — including the one that matters most, the
Melbourne cathedral, which has a same-dedication namesake 8km away that the
matcher preferred.

**The first jurisdiction with monasteries.** `parishId` spent its whole length
cap on the word every monastery shares and minted `russian-monastery-...`, so
monastery, convent, skete, chapel, mission and institute joined `church` and
`cathedral` as generic. A second rule stops the cap reducing a name to a bare
qualifier — "Holy Transfiguration Monastery" was becoming `holy`.

**Final confidence: 15 pins on a building, 18 street-level, 4 held back.**
`info_verified_at` is NULL on all of them — these are researched, not confirmed. The four held back are the ones with
no published address anywhere, and they are held back on purpose: `lat` and
`lng` are NOT NULL, so the temptation is to drop a pin in the middle of the
suburb, and a marker where there is no church is worse than an absent parish.

| held back | why |
|---|---|
| Sts Cyril & Methodius / St Xenia, Tweed Heads | moved to South Tweed Heads; no address published for the new site |
| Holy Trinity, Hobart | in the Huon district, an hour from Hobart, on family land; no address published |
| Holy Ascension Mission, Williamstown | in no directory |
| St Mary's, Bunbury | in no directory; its website is a JavaScript shell |

**Two entries in the directory are not places of worship** — the Diocesan
Administration at Croydon and the Sts Cyril and Methodius Orthodox Institute —
and are dropped. Monasteries, convents, sketes, missions and chapels are kept:
they hold public services, which is the only test that matters for a feed of
services.

**The diocese publishes a Google Calendar.** `rocor.org.au` page 19167 is an
"ANZ Diocese Event Calendar" embed, and the monastery page carries service times
in prose ("Services daily at 0500 and 1700, Divine Liturgy on Sunday at 0900").
Neither is touched by this import, which is parishes only — but `docs/adapters.md`
is the next step and that calendar is the obvious place to start.
