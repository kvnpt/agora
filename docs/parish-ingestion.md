# Adding parishes in bulk

Every adapter names a parish, and `events.parish_id` is a foreign key, so the
parish has to exist before anything can be scraped for it. With one or two
parishes that is a line in `seeds/parishes.js`. With an archdiocese directory —
a few hundred names and addresses at once — it is a pipeline, and this is what
that pipeline has to get right.

This began as a brief for work that had not been done. Six directories have
since been ingested — the Greek Archdiocese (135), the ROCOR Australian and New
Zealand Diocese (37), the Antiochian Archdiocese (24), the Serbian
Metropolitanate (all 49), the Romanian Diocese (21) and the Macedonians (27
across two dioceses) — so the constraints below are now field notes rather than
predictions, and the sections at the end record what each run actually cost.
They cost different things: the Greek directory published addresses that were
sometimes wrong, the Russian one publishes no addresses at all, the Antiochian
site cannot be fetched by anything automated, the Serbian one publishes
everything and names no suburbs, the Romanian one publishes its own
coordinates, and the Macedonians publish the same church twice because there
are two dioceses claiming it.

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

## State as at 13 September 2026

```
293 parishes · 82 schedules · 68 events · 0 overrides
```

135 of those parishes are the Greek Archdiocese import, 49 the Serbian one, 37
the ROCOR one, 27 the Macedonian one, 24 the Antiochian one and 21 the Romanian
one. Every one carries an acronym — its short link, `orthodoxy.au/<acronym>` —
and a recorded read date (`info_checked_at`), which is what the parish sheet
renders as "Updated 3 months ago". Service times are thinner than parishes by an
order of magnitude: the Antiochian directory publishes them, five Romanian
parish websites publish a standing weekly timetable, and nothing else does, so
adapters remain the only route to the rest.

The Greek service-times run at the end of this file adds 17 more, across 8
parishes, and corrects 19 parish websites — which takes the table to 99
schedules and leaves the largest jurisdiction still the thinnest, for reasons
that section sets out.

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
- **68 schedules live, but `d1/seed-parishes.sql` creates only 9.** 67 of them
  are the Antiochian service-time import described at the end of this file; of
  the rest, four
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
`info_source_type`, `info_source_ref`, `info_source_name` and `info_checked_at`
for exactly this. Use all four; a scraped pin and a confirmed one should not be
indistinguishable six months later. `info_source_type` is a CHECK too —
`'website'`, `'person'` or `'import'` — and a directory scrape is `'import'`.

`info_checked_at` is the moment the scrape **read** the source, and the only one
of the four a re-run must rewrite. It is the same field `schedules` carries as
`source_checked_at` and it renders the same way, so a parish's details and its
service times both say how old they are in the same words. A fifth column,
`info_verified_at`, looks like it and is not: it means a *person* confirmed the
row against the place itself, it is what the upsert's guard reads, and a scrape
never writes it. Guarding on the checked date instead would freeze every row
the moment it was first imported.

`info_source_name` is what to CALL the source, because the ref is a URL and a
URL is not a name: an imported parish's ref is a hundred characters of directory
path, which answers "where did this come from" only for somebody who reads URLs
for a living. Name the source, not the parish, so a jurisdiction's whole import
shares one label — "Greek Orthodox Archdiocese of Australia", "Parish website",
"OpenStreetMap" — which makes the import legible at a glance and a stale source
findable in one query. Keep it SHORT: the parish sheet renders it under the
address as "Updated 3 months ago · Antiochian Archdiocese", linked to the ref
when the ref is a URL, in the same 11px muted line the service times use. The
Antiochian import's 74-character official title had to be cut back to the short
label its own service-time rules already carried, because one source spelled two
ways reads as two sources.

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
Russian Orthodox Church Outside Russia, geocoded, and written to D1 — 33 on the
first pass and the remaining four as suburb centroids on the second, for their
owner to verify. Three scripts, run in order, each writing a file that can be
read before the next one runs:

```bash
node scripts/scrape-rocor.mjs   cache/ rocor-scraped.json
node scripts/geocode-rocor.mjs  rocor-scraped.json cache/geo/ rocor-geocoded.json
node scripts/build-rocor-sql.mjs rocor-geocoded.json rocor-parishes.sql
```

The third step refuses to write a row whose pin is only a suburb centroid.
`--include-suburb` overrides that, and is how the last four got in — it is a
deliberate act with a person's name on it, not a default:

```bash
node scripts/build-rocor-sql.mjs rocor-geocoded.json rocor-all37.sql --include-suburb
```

Re-running it against a database that already holds the rows is safe and is
worth doing: `reconcile` matched all 33 back to their existing ids with no
derivation mismatch, so the second pass inserted four rows and corrected
twenty-two rather than duplicating anything. Diff the regenerated SQL against
what was applied before running it — that diff is what caught the provenance
bug below.

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

**Final confidence: 15 pins on a building, 18 street-level, 4 suburb centroids.**
`info_verified_at` is NULL on all 37 — these are researched, not confirmed.

The four centroids were held back on the first pass and written on the second,
at the owner's direction and for him to check. They are the parishes with no
published address anywhere, so the pin is the middle of the locality and there
is demonstrably no church at it. `address` is left NULL on exactly those four,
which is the only signal the schema has to offer: there is no column for how
good a pin is, so an absent address is what marks one as unchecked. Write a
street into it and the row becomes indistinguishable from the 33 that were
actually placed.

| suburb centroid | why there is nothing better | pin |
|---|---|---|
| Sts Cyril & Methodius / St Xenia, Tweed Heads | moved to South Tweed Heads; no address published for the new site | -28.178664, 153.536999 |
| Holy Trinity, Hobart | in the Huon district, an hour from Hobart, on family land; no address published | -42.882509, 147.328123 |
| Holy Ascension Mission, Williamstown | in no directory | -37.861179, 144.889857 |
| St Mary's, Bunbury | in no directory; its website is a JavaScript shell | -33.326780, 115.636698 |

Tweed Heads is the one to look at first. Its centroid is Tweed Heads proper and
the parish has moved to South Tweed Heads, so the pin is a couple of kilometres
out — but it is in New South Wales, which is the part that decides the timezone.

**`info_source_type` and `info_source_ref` describe one fact and must move
together.** This run wrote `'website'` for addresses it had taken from a
third-party directory, which asserts the parish told us something it had not.
The classification was corrected in the same session — and the correction could
not reach the rows, because `info_source_type` was missing from the upsert's
refreshable columns while `info_source_ref` was in it. Twenty-two rows sat in
production quietly overstating their own provenance until the pair was refreshed
as a pair. Leaving it out was safe-looking and wrong: the `WHERE
info_verified_at IS NULL` guard is what protects a human's answer here, exactly
as it does for the address and the pin beside it.

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


---

## What the Antiochian run actually cost

24 places of worship — 20 parishes, 6 missions and a monastery, of which two are
both — scraped from the Antiochian Orthodox Archdiocese of Australia, New
Zealand and the Philippines, geocoded, and written to D1. Unlike the two
previous runs this one was mostly an **update**: nine of the 24 were already in
the database, seeded by hand before any scraping existed.

```bash
node scripts/scrape-antiochian.mjs    cache/antiochian antiochian-scraped.json
node scripts/geocode-antiochian.mjs   antiochian-scraped.json cache/geo-antiochian antiochian-geocoded.json
node scripts/build-antiochian-sql.mjs antiochian-geocoded.json antiochian-parishes.sql --include-suburb
```

**The site cannot be fetched by anything automated, and that is the headline.**
`antiochian.org.au` sits behind a Cloudflare managed challenge that answers 403
to every path for every client tried: curl with browser headers, Node's fetch,
a headless Chromium through the environment's proxy, and the harness's own
fetcher. `robots.txt` is behind it too, so there is not even a published policy
to read. A human browser loads the site normally. The responses were therefore
fetched **by a person** and pasted in, and `scripts/scrape-antiochian.mjs` only
ever parses what is already in `cache/antiochian/` — it has no fetching code at
all. That is not a workaround to be improved on later; it is the shape this
particular directory forces, and it still satisfies what the caching rule is
for, because a re-parse costs the site nothing.

**The taxonomy is a checksum, and it is what made the scrape provably
complete.** The directory is an Avada `avada_portfolio` post type with about 900
posts, 838 of them daily scripture bulletins, the rest mixing churches with two
childcare centres, two archdiocesan departments, a homeless charity and two
catechism articles. `portfolio_category` separates them, and
`/wp-json/wp/v2/portfolio_category` publishes a count per term. Selecting the
thirteen place-of-worship terms and checking the selection against those counts —
`parishes` 20/20, `nsw-parishes` 11/11, `missions` 6/6, `monastery` 1/1 and so
on, all thirteen — proved nothing was hiding behind the listing's pagination
without fetching page two at all. **Ask a WordPress directory for its term
counts before walking its pages.**

**One directory, two page layouts.** Most parishes use a tabbed template with
the address under `<h3>Location</h3>`; Mays Hill uses an older one with
`<h2>Parish &amp; Location</h2>` and no Location heading anywhere. Keying on the
heading found 23 of 24. What found all of them was recognising the address by
its **shape** — it ends with the country, or with a state and a postcode — which
also handled St John the Baptist, whose address is split across a `<br>` and
names no country, and would otherwise have lost its street number.

**Avada renders each tab's title between the panes.** Left in, every address on
the site ends `, PRAYER SERVICES`. Strip `<ul class="nav-tabs">` before reading
anything.

**Several pages percent-obfuscate their mailto links** — Mays Hill publishes
`smmh@an%74iochian.or%67.a%75` — so an email stored verbatim is one that
bounces. Decode the href.

**Search by name FIRST. The brief says so and this run is the proof.** Six
parishes were upgraded from a street-level pin to the building itself by asking
Nominatim for "<dedication> Orthodox Church <suburb>", and the cathedral is the
clearest case: its published address is `Cnr Walker & Cooper Sts`, which geocodes
to nothing at all, while its name returns `Antiochian Orthodox Cathedral of St
George` as a building. A name search has to be guarded — a result naming another
jurisdiction is refused, and it must share a token with the dedication — but it
is the cheapest good pin available.

**A corner is resolvable without the geometry.** `Cnr A & B` fails as an address
but both streets geocode alone, so their closest approach is the junction, near
enough, and much nearer than the locality centroid. That is how the Auckland
mission got a pin.

**OSM knows almost nothing about this jurisdiction.** One single building in all
of Oceania is tagged `denomination=antiochian_orthodox` (Doonside). The
Oceania-wide bbox query is still worth running — it is cheap and the tag asserts
the jurisdiction — but it answered one parish out of 24, where the same query
answered 15 of 37 for ROCOR. Radius queries to `overpass.kumi.systems` were
**unreachable throughout this run**, timing out at 70s even over rural
Queensland, so the per-suburb tier was not available at all.

**The directory is wrong about three of its suburbs, in the now-familiar way.**

| the directory says | the address says |
|---|---|
| Melbourne North | Kalkallo |
| Auckland | Howick |
| Dunedin | South Dunedin |

The address wins, and it must also win in the stored **name**, not just the id:
`reconcile` recovers a parish's suburb from the comma in its name, so a row
called "Holy Cross Mission, Melbourne North" with an id saying `kalkallo` would
fail to match itself next time and mint a duplicate. Name and id have to agree
about where the parish is.

**`reconcile` earned its existence four times over.** Nine rows already existed;
for four of them derivation would have minted a different id and inserted a
duplicate beside the original:

| existing id | derivation would have minted |
|---|---|
| `antiochian-good-shepherd-antiochian-church` | `antiochian-goodshepherd-clayton` |
| `antiochian-stgeorge-redfern` | `antiochian-stgeorgeredfern-redfern` |
| `antiochian-stmichaelgabriel-ryde` | `antiochian-stsmichael-ryde` |
| `antiochian-stmary-mayshill` | `antiochian-stmarys-mayshill` |

The first is the one that matters most: all 68 events in the database belong to
Good Shepherd via the Google Calendar adapter, which names the old id. A
duplicate would have left every event on the old row with an empty second Good
Shepherd beside it. After the write there is still exactly one, and the bundle
still reports 68 events against it.

**A scrape must not ERASE what it merely failed to find.** The directory links
some parishes' own websites and not others, so writing the scraped value
straight through would have blanked seven working websites and downgraded three
more from `https` to `http`. A null from the scrape now defers to the stored
value, and a URL differing only by scheme or `www.` leaves the stored form
alone. This is the same family of error as the ROCOR provenance bug: the upsert
exists to refresh what nobody has checked, not to lose what is known.

**Provenance was deliberately downgraded on eight rows, and that is worth
knowing.** They read `info_source_type='website'` with `info_source_name='Parish
website'`, because a person had entered them from each parish's own site. Their
addresses now come from the Archdiocese's directory, so the pair moves to
`'import'` with the parish's own directory page as the ref. The brief is
explicit that a directory scrape is `'import'`, and the 135 Greek rows record
their own archdiocese the same way — but it does trade a stronger claim for a
more accurate one, and reverting it is a one-line change if that is the wrong
call.

**Final confidence: 9 pins on a building, 13 street-level, 2 locality
centroids.** `info_verified_at` is NULL on all 24 — these are researched, not
confirmed. Three pins moved by more than 100m and all three were checked by hand
against an independent lookup: Wollongong moved **553m onto Kenny Street**,
where its published address actually is and where the seeded pin was not;
Redfern moved 110m onto the named cathedral building; Mays Hill moved 259m
sideways along the same street, neither better nor worse.

| centroid | why there is nothing better |
|---|---|
| Holy Cross Mission, Kalkallo | publishes no address: *"Temporary place of worship in Kalkallo, VIC, Australia (contact the clergy)"*. `address` is left NULL. |
| St Mary Magdalene, Elimbah | publishes `Coronation Street, Elimbah`, which is in neither Nominatim nor OSM. |

Elimbah is the case that refines the ROCOR rule rather than repeating it. That
run nulled `address` on every centroid row, because there the address was
genuinely unknown and an absent address is the only signal the schema has for a
coarse pin. Elimbah *did* publish a street, which is real and is how somebody
would actually find the church — so throwing it away to flag the pin would lose
true information to record a caveat. **A vague address is nulled; a real one
that merely fails to geocode is kept, and the pin quality is reported instead.**

**The weakest pin is St Ignatius, Darraweit Guim**, 7km from the town centroid.
Its address, `1478 Bolinda Darraweit Road`, resolves only to the road — a long
rural road running to Bolinda — and no house-number match exists. The road is
certainly right and the locality centroid would be no closer, so it stands as
street-level, but it is the first row to check if somebody visits.

**Two published details are wrong and were kept verbatim anyway**, because
normalising an address a parish typed is how the Greek run invented errors:
Mays Hill gives postcode 2150, which is Parramatta's — Mays Hill is 2145 — and
Darraweit Guim gives 3756 where OSM says 3432.

**These pages carry service times, and nothing was done with them.** 22 of the
24 publish a PRAYER SERVICES tab with real detail — *"9:00AM Matins (Arabic),
10:00AM Liturgy (Mostly Arabic), 6:00 PM Liturgy (English)"* — along with
languages for all 24 and a patronal feast for 18. The languages and feast days
were written; the service times are parsed and kept in
`antiochian-scraped.json` but deliberately unused, because turning them into
recurrence rules is an adapter's job and `docs/adapters.md` is where it belongs.
This is the largest block of schedule data any jurisdiction has published so far
and it is sitting there already fetched.


---

## What the Antiochian SERVICE TIMES run cost

The same 24 pages carry a PRAYER SERVICES tab, and it is the largest block of
schedule data any jurisdiction has published. 67 recurrence rules were imported
from it, taking the table from 13 schedules to 69.

```bash
node scripts/build-antiochian-schedules.mjs antiochian-scraped.json cache/antiochian/index.json antiochian-schedules.sql
```

**It is a script, not an adapter, and it has to be.** `docs/adapters.md` is the
usual home for service times, and an adapter is right when a source can be
re-fetched on a schedule. This one cannot: the site answers 403 to every
automated client, so a Worker adapter would fail every four hours forever. The
pages are fetched by a person and imported once — which is exactly why the rules
had to start carrying their own provenance.

**`schedules` gained `source_name`, `source_ref` and `source_checked_at`.** A
recurrence rule is a claim about the FUTURE and, unlike a scraped event, never
expires on its own: "Sundays 9am" keeps projecting cards forever and looks
exactly as current on the day the parish changes its times as it did the day it
was entered. Nothing in the row said how old the claim was. The three columns
answer three different questions — who says so, where to check, and how long ago
we looked — and the parish sheet renders them under the timetable as
*"Updated 3 months ago · Antiochian Archdiocese ↗"*.

**The timestamp is OUR READ, not the source's own last-modified date.** The
first cut of this stored the page's published modified date, on the reasoning
that re-reading an unchanged page proves nothing. That is true and it is the
wrong conclusion: a publisher's modified date is an assertion about itself, and
a parish that changes its service times without touching the page carries a date
saying the times are current. The column takes on **freshness, not veracity** —
when we last looked is a fact we can actually vouch for, and how long ago that
was is the question a reader is really asking. It is named `source_checked_at`
so it cannot be read as the other thing.

**Match on parish + weekday + time, never on title.** The nine rules seeded by
hand before any scraping are all called "Sunday Divine Liturgy" with no
languages. Matching on title would have left every one of them in place with the
directory's version inserted beside it — two cards for one service. Updating in
place also keeps the row id, which matters because `events.schedule_id` and
`schedule_overrides` both point at it; neither does today, but a rule that is
deleted and reinserted breaks those silently the first time one does.

**One of the seeded rules was simply wrong.** It said Sts Michael & Gabriel's
09:00 Sunday service is the Divine Liturgy. The parish says 09:00 is Matins and
the Liturgy is at 10:00 — so that row's title, type and languages were all
corrected, and a second rule inserted for the Liturgy it had displaced.

**A rule the directory does not mention is left alone.** A page omitting a
service is weak evidence that it has stopped, so Ryde's Saturday Vespers and
Good Shepherd's Confession both survived the import untouched. Review then
settled the two in OPPOSITE directions, which is the argument for leaving them
to a person rather than to a rule about absence:

- **Ryde do not hold Saturday Vespers.** That rule came from the hand-written
  seed, not from the parish, and has been deleted. The directory's silence
  turned out to be right; it still was not evidence.
- **Good Shepherd's Confession is real**, and was inferred from the parish's
  Google Calendar — so it cites that calendar rather than nothing.

**And all four of Good Shepherd's rules cite the calendar, not just the one.**
The import had overwritten the other three with the Archdiocese page because
that page publishes the same three times — but **corroborating a time is not
being the source of it**. All four were inferred from the calendar, which is
also the *live* source: the adapter re-reads it every four hours where the
directory was read once, by hand, and cannot be re-read automatically at all.
The build script now defers any parish that has an adapter, so a re-run leaves
those rows alone instead of quietly reclaiming them — which is the general rule,
not a special case for this parish: a live source beats a hand-pasted page.

**Two parishes hold genuinely simultaneous services and the dedup nearly ate
one.** Punchbowl runs an Arabic liturgy in the church and an English one in the
hall, both at 09:30 on first Sundays; Kirrawee does the same at 10:00. The
read-path dedup partitions on parish, time and TITLE, and a `week_of_month` rule
beats a generic weekly one — so two rules both called "Liturgy" at 09:30 would
have left the Arabic one hidden on exactly the Sunday both are held. Two things
fix it: the three words "in the hall" are kept out of the tail and put in the
title, and `concurrent` is set on any rules sharing a parish, day and hour.
Distinct titles alone would have worked, but only until somebody edited one.

**A rule with no time is never invented.** Four lines were dropped: Redfern
publishes a Friday Compline with a day but no hour, and a Thursday continuation
line, and Elimbah notes Vespers "as per arrangement" in two other towns. A time
guessed for any of them would put a card on the map at an hour nobody stated.

**The test caught a widening bug before it shipped.** Redfern's Friday service
runs "every 2nd last Friday", which `week_of_month` cannot express — and the
guard meant to refuse it checked for the words "week" or "month" first, neither
of which that phrase contains. It therefore returned null, and null does not
mean "unknown" in that column, it means EVERY Friday. Refusing an inexpressible
pattern has to be checked before anything else.

**Services held somewhere else keep the address in their title.** St Mary
Magdalene serves Pomona and Gympie from Elimbah, and `schedules` has no location
column, so "Vespers at 23 Hill Street POMONA QLD 4568" is the title. Dropping it
would put those services at the wrong church.

**Inference now records its own provenance too.** */admin* → Schedules → *Infer
rules from scraped events* was writing rules with all three columns null, which
on the parish sheet reads as "nobody knows" rather than "a calendar said so". It
now asks the ADAPTER for the source — not the events, because an event's
`source_url` is a deep link to one occurrence, and a rule inferred from dozens of
them would cite an arbitrary Sunday instead of the calendar that says it happens
every Sunday. Adapters therefore carry `sourceName` and `sourceUrl`: the Google
Calendar one derives its public calendar page from the id it already holds, and
the PDF ones return the URL `pdf-sources.mjs` already remembers. Accepting a
proposal that is already on file re-stamps `source_checked_at` rather than
skipping silently — a person has just confirmed the source still publishes it,
which is exactly what the column records.

**Final: 68 schedules** — 64 from the directory across 22 parishes and 4 from
Good Shepherd's calendar; 36 liturgies, 32 offices, 1 other; 4 lines dropped.
Every rule in the table carries a source. St George Mission, Auckland is the twenty-fourth parish and publishes no
times at all, which is not an error and is reported as zero rather than skipped
silently.

---

## What the Serbian run actually cost

49 places of worship — 45 parishes and 4 monasteries — scraped from the Serbian
Orthodox Metropolitanate of Australia and New Zealand, geocoded, and written to
D1. 44 of them; five are held back, and the reasons are below.

```bash
node scripts/scrape-serbian.mjs     cache/serbian serbian-scraped.json
node scripts/geocode-serbian.mjs    serbian-scraped.json cache/geo-serbian serbian-geocoded.json
node scripts/build-serbian-sql.mjs  serbian-geocoded.json serbian-parishes.sql
```

**The first directory that needs no aggregator at all.** `soc.org.au` is the
Metropolitanate's own site, it exposes the real post types through the
WordPress REST API (`/wp-json/wp/v2/parish`, `monastery`, `state`), and it
publishes a street address for 45 of 49. Every field written here came from the
jurisdiction itself, which is what the rule about sources asks for and what the
ROCOR run could not do.

**`per_page` defaults to 2.** The list endpoint answers `x-wp-total: 45` and
returns two rows. A run that trusts the default imports two parishes and
reports success.

**The titles carry no suburb, and that shapes everything.** Five parishes are
"ST SAVA SERBIAN ORTHODOX CHURCH" and four are "ST NICHOLAS"; the ids that
separate them are their suburbs, and the suburb only exists inside the address
on each parish's page. So the address is not just the pin here — it is the
identity. A page that failed to parse would not produce a badly named parish,
it would produce a collision.

**Four PO boxes.** Cairns, Canberra, Mawson and Moree publish a postal address
and nothing else. They are marked `address_vague` by the scrape, which keeps
them away from the geocoder and out of the stored `address` — a PO box pins the
post office and says nothing. Canberra was then found by name anyway; the other
three were not.

**Two localities in one address.** "852 Caoura Rd, Tallong, Marulan NSW 2579"
is the monastery at Tallong written with the larger town beside it, and the
Australia Post shape — street, suburb, state, postcode — reads Marulan as the
suburb. The title says Tallong and so does the address, so the component both
sources name wins. Two sources agreeing beats a positional rule.

**One building, two parishes, again.** Keysborough and Carrum Downs are 10km
apart and their dedications share the word Stephen, so the first one asked took
the church that is 400m from the second — the Croydon/Strathfield error from
the ROCOR run, in a new suburb. The fix is in `scripts/geocode-parish.mjs`:
OSM buildings are now assigned **globally**, every (parish, building) pair
scored and sorted by score then distance, rather than parish by parish in
directory order. "Best building for this parish" and "best parish for this
building" are different questions and only the second one is safe to answer
greedily.

**A church OSM knows by its jurisdiction and not its dedication.** The monastery
at Wallaroo is in OSM as "Free Serbian Orthodox Church - Diocese For Australia
& New Zealand" — not one token of "St Sava – New Kalenich" in it, so neither the
dedication match nor the name search can see it. A tier that asks for
"<Jurisdiction> Orthodox Church, <suburb>" and accepts the answer **only when
the suburb has exactly one** found it and two others. Where a suburb has two
parishes of the same jurisdiction the query cannot tell them apart, so it must
answer neither.

**`dormitionmost`.** Four Serbian dedications are long enough that the 16-char
id cap cut "Most Holy" in half: "Dormition of the Most Holy Theotokos" minted
`serbian-dormitionmost-arundel`, which reads as a typo and says nothing
`dormition` does not. `parishId` now drops a qualifier the cap stranded, the
same way it already dropped a stranded honorific. Four existing production ids
would derive differently under the new rule — `reconcile` matches on content,
not derivation, so they still pin to themselves.

**Where the pins came from:**

| | |
|---|---|
| 26 | a building — 13 from the Oceania-wide `denomination=serbian_orthodox` query, 9 by name, 3 by jurisdiction |
| 18 | street level, from the published address, structured |
| 1 | street level, free-form |
| 5 | a locality centroid, and **not written** |

OSM knows this jurisdiction far better than it knows the Antiochians: 18
buildings tagged `serbian_orthodox` across Oceania, against one. Three of them
are named nothing more specific than "Serbian Orthodox Church", which is what
the jurisdiction tier is for.

**The five held back**, all for the same reason — no church in OSM, and no
street that geocodes. Three were resolved the next day; see below.

| | |
|---|---|
| St Elijah the Prophet, Cairns | PO box only |
| Entrance of the Most Holy Theotokos, Mawson | PO box only |
| Sts Simeon and Ana, Moree | PO box only |
| St John the Baptist, Dapto | "20 Dale St, Penrose, Dapto NSW 2530" — no Dale St in OSM near Dapto |
| Nativity of the Most Holy Theotokos Skete, Inglewood | "61 Chapmans Rd, Inglewood SA 5133" — no Chapmans Rd in OSM |

`--include-suburb` writes them as locality centroids with a NULL address, which
is a deliberate act with a person's name on it rather than a default.

---

## A parish's address is where the service is

This is the rule the held-back five turned into a principle, and it governs
every import from here.

**Agora exists to answer "which parish is near me, and when is the service".**
So a parish's stored address is the place somebody walks into. Not its mailbox,
and not the priest's house. Three of the five publish a PO box and nothing
else; a fourth publishes a postal address on one street while meeting in a
chapel 240m away on another.

**A `schedules.location_override` is NOT the mechanism for this.** That column
is for the exception — the one Sunday a service moves to the cathedral. Where a
parish meets every week is the parish's address, full stop. Putting a permanent
venue in an override would leave the map pin on a post office and the truth in
a footnote under a timetable.

**The field that answers it is free text on the parish's own page.** "Services
held at: St John the Baptist Greek Orthodox Church" — five of the 49 Serbian
entries have one, and for the PO-box parishes it is the only location the
directory publishes at all. `venueOf()` in scrape-serbian.mjs reads it.

**And the venue is usually a parish we already hold.** A congregation without a
building lodges in somebody else's, and somebody else is often already in the
table on a confirmed pin. So the geocoder's first tier after the suburb is now
`venueMatcher` against `/api/parishes`, and it inverts two rules of the
dedication match on purpose:

| dedication match | venue match |
|---|---|
| a candidate naming another jurisdiction is always wrong | it is usually right — that is whose building this is |
| the jurisdiction word is noise to be stripped | it is the strongest signal, and is required of the candidate's `jurisdiction` column |

It also excludes the jurisdiction being imported, which is not fussiness: on a
re-run the row being placed is itself in the table, and Holy Cross, Lenah Valley
shares a dedication with the Exaltation of the Holy Cross church it meets in to
within one letter. Without that rule the parish matches itself and the
tie-break, correctly, refuses to choose.

**Two parishes in one building get pins ten metres apart.** Exactly on top of
each other, one of them cannot be tapped. Ten metres is far enough to separate
the dots and near enough that the address stays true; 1° of latitude is ~111.32km
everywhere, so it needs no cosine. Asking the database for exact coordinate
collisions found two more pairs nobody had noticed — the Hobart one above, and
St John the Baptist and St Elias at 82 and 86 Kenny St, Wollongong, which a
street-level geocode had resolved to one point.

**What that recovered, 13 September:**

| | |
|---|---|
| St Elijah the Prophet, **Redlynch** | its page names the Greek parish's church; that row's pin, +10m. Renamed from Cairns, because the address won |
| St Nicholas, Christchurch | already on the right building and exactly on top of the ROCOR parish; +10m |
| St Basil of Ostrog, Waterford | moved off the Manning Rd postal address to the Clontarf College chapel |
| Holy Cross, Lenah Valley | +10m off the Russian-Serbian church it shares |
| St John the Baptist, Dapto | Dale Street is in **Avondale**, the locality next door; "Penrose" is a stray |
| Nativity of the Most Holy Theotokos Skete, Inglewood | the road is **Chapman** Road, not Chapmans — the same class of error as the Greek run's Holterman/Holtermann |

**Two are on the map as locality centroids, deliberately.** Sts Simeon and Ana,
Moree and the Entrance of the Most Holy Theotokos, Mawson publish a PO box, a
phone number and an administering priest, and no venue anywhere — not on the
Metropolitanate's site, not on the priests' own pages (Moree's priest is at
Lightning Ridge, 250km away; Mawson's own address is the same PO box), and not
on any aggregator. A phone call settles both; a geocoder cannot.

They were written anyway, at the owner's request, because a row he can see and
correct beats a row he has to remember exists. Both carry a **NULL address**,
which is the whole convention: the schema has no column for pin quality, so an
absent address is the only mark a row has saying nobody has checked where this
is. Filling one in is what marks it done — the same signal the ROCOR run's four
centroid rows carry.

**Which needed a guard, because `lat` and `lng` are refreshable.** Six of these
49 were placed by hand after the import, and a second run offering only a
centroid would have walked every one of them back to the middle of a suburb.
`mergeWithExisting` in build-serbian-sql.mjs now keeps the pin already on file
whenever this run can only offer a centroid AND the row has an address — one
way, so a re-scrape that finds a real address still wins, and a centroid row
with its NULL address is still free to be placed properly later. It is the same
sentence as the rest of that function, applied to the field that had been left
out of it: a scrape that found nothing must not erase something.

**One parish is not Serbian-speaking.** St Ignatius of Antioch and St Aidan of
Lindisfarne, Wendouree, is the Metropolitanate's Western Rite parish and the
only entry whose title omits the word "Serbian" — which is what the import keys
on to give it `["English"]` where every other row gets `["Serbian", "English"]`.

**New rows carry their jurisdiction's colour.** The Greek, ROCOR and Antiochian
imports wrote `color: null` on the reasoning that a colour is a person's choice,
and migration 004 then had to paint 51 rows that had been rendering grey. It is
a person's choice, but the jurisdiction's colour is the baseline every card
already draws, so the import writes it and `color` stays out of `REFRESHABLE` —
the insert sets it, a re-run never touches it.

**What was written, 12 September 2026.** 44 rows, taking production from 196
parishes to 240: `changes: 45`, no conflicts, nothing pinned (production held no
Serbian parish at all, so every row was an insert). Then
`scripts/parish-acronyms.mjs` against the live endpoint, which gave the 232
parishes without one a short link — the Serbian 44 included — and left the eight
typed by hand alone.

**Regenerate before writing, even hours later.** The acronym file built that
morning would have given `SGR` to St George, Robinvale; between generating it
and applying it somebody had typed `SGR` on the Redfern cathedral. Re-running
against `/api/parishes` seeded the taken-set from the live rows and moved
Robinvale to `SRO`. The generated SQL is not the artefact — the script is.

---

## What the Romanian run actually cost

21 places of worship — 20 parishes and the diocesan monastery — read from the
Romanian Orthodox Diocese of Australia and New Zealand and written to D1. All
21 were written; none was held back.

**This one was done inline rather than as three scripts**, at the owner's
direction: collect, parse, write. The shape the brief asks for is still there —
a scraped file, a geocoded file, then SQL, each read before the next ran — but
it lives in the session's scratchpad instead of `scripts/scrape-romanian.mjs`.
The reusable parts were reused, which is the half that matters:
`geocodeAll()` did the tiering and `parish-import.mjs` minted the ids and the
guarded upsert. What is *not* reproducible from the repo is the fetching, and
the endpoint below is the whole of it.

**The directory is a JSON API and nobody had to parse a page.** `roeanz.com.au`
is a React app that renders nothing without JavaScript, so the parish pages are
empty to a fetcher — but `https://roeanz.com.au/api/parish` answers 21 complete
rows: name in Romanian and English, address, city, priest, phone, email,
website, slug, deanery, history, and **latitude and longitude**. The site's own
route table (`/assets/index-*.js`) names `/harta-parohiilor`, its parish map;
the API behind it is one guess away. **Look for the SPA's API before deciding a
site cannot be scraped.**

**The first jurisdiction to publish its own pins, and they are good.** Where OSM
independently knows the church the two agree to within two metres — Berhampore
0m, Matangi 2m — which is the check that decided the rest: for the fifteen
street-level rows the diocese's marker beats a Nominatim house-number
interpolation, and the two disagree by more than 450m five times (South Windsor
1258m, Glenfield 1096m, Riverview 960m, Carlton 538m, Koondoola 497m). OSM has
no church at either point in any of those five, so it cannot arbitrate; the
diocese's own answer wins on the strength of the two it can.

**Four parishes publish no address at all** — Cairns, Canberra, Ashburton and
Gore — and for those the published coordinate is a city centroid, not a church.
They are written anyway, as the Serbian centroids were, with a **NULL address**,
which is the only mark the schema has for a pin nobody has checked. Ashburton's
own history says why the address is missing and does not supply one: *"The
Divine Liturgy is celebrated in an Anglican church rented by the Romanian
community."* Canberra's centroid is Civic, 3.3km from wherever that parish
actually meets.

**Three parishes are filed under a city they do not meet in**, which is the
suburb error every run has now hit, in its Romanian spelling:

| the diocese's name says | the address and the pin say |
|---|---|
| St Thomas the Apostle, **Dandenong** | Narre Warren North |
| St Philothea of Argeș, **Bayswater** | Canterbury |
| St Andrew the Apostle, **Newcastle** | Wallsend |

The address wins, in the stored name as well as the id — Antiochian run, same
rule, same reason: `reconcile` recovers a parish's suburb from its name, so a
row called "…, Dandenong" with an id saying `narrewarren` fails to match itself
next time and mints a duplicate.

**Two published postcodes are wrong and are kept verbatim**: St Philip the
Apostle gives Beenleigh as 4000, which is Brisbane's CBD, and St John the
Baptist gives South Windsor as 2761. Normalising an address a parish typed is
how the Greek run invented errors; the pin comes from the street and the suburb,
which are right.

**A published website can be dead.** `sfdimitrie.org.au`, the Brisbane parish's
site, no longer resolves in DNS at all. It is stored as published — the diocese
is the source and a scrape's job is to record what the source says — but it is
the first row to fix if somebody checks. Two more, `sftreimeperth.org` and
`saintapostlethomas.com.au`, 503 on HTTPS and answer normally over plain HTTP —
the diocese publishes both as `http://` and they are stored that way, which is
the accident of a directory being older than the web's move to TLS.

**Final confidence: 2 pins on a building, 15 street-level, 4 locality
centroids.** `info_verified_at` is NULL on all 21.

---

## What the Macedonian run actually cost

27 places of worship — 23 parishes and 4 monasteries — read from **two**
diocesan websites and written to D1.

**The jurisdiction is split, and that is the headline.** The Macedonian Orthodox
Church has two dioceses in this territory and each publishes its own directory:
`mocdanz.org.au` (Australia and New Zealand, 13 churches and 3 monasteries) and
`macedonianorthodoxdiocese.org.au`, also reachable as `mpcaus.org`
(Australia–Sydney, 11 churches and 1 monastery). Both are the jurisdiction's own
sites, so both are sources, and the import carries two `info_source_name`
labels where every previous one carried a single label. That is not the same
mistake as spelling one source two ways: these are two bodies, and a row cites
the one that published it.

**28 entries, 27 rows, because one church is on both lists.** The two dioceses
each claim a St Nikola in North Perth — one at 69 Angove St, one at 8 Macedonia
Place, 481m apart. The only place of worship OSM knows in North Perth sits on
Angove Street; Macedonia Place is a residential cul-de-sac with nothing on it.
One congregation gets one row, pinned on the building, citing the diocese whose
address matches it. **`buildUpsert` would have caught this anyway** — both
entries derive the same id and it refuses a duplicate id in a batch — which is
the argument for the check being in the builder rather than in each caller.

**Two cathedrals in one suburb are NOT a duplicate.** Sydenham, Victoria has the
Nativity of the Most Holy Theotokos at 1 Pecks Road and the Dormition of the
Mother of God at 340 Sydenham Road, 990m apart, one per diocese. Same suburb,
same city, different buildings, different dedications.

**OSM knows this jurisdiction well.** Ten places of worship tagged
`denomination=macedonian_orthodox` across Oceania, and with the name search on
top of them 13 rows pin to an actual building without any research at all — the
second-best coverage of any run so far, after the Serbians' 18. North Perth is a
fourteenth, found by hand while settling the duplicate above.

**The dedications needed their own synonyms.** Clement is Kliment on every
Macedonian parish sign, Demetrius is Dimitrija, St Nedela is Holy Sunday
translated, and Romanian writes Dumitru, Gheorghe and Ioan. Those groups are now
in `SYNONYM` in `scripts/geocode-parish.mjs` with a test, because without them
the right building sits in the results with no token in common.

**A one-letter street name and a postcode from another suburb.**

| the directory says | it is |
|---|---|
| 219 **Banyla** Drive, Gaven | Banyula Drive — the Chapmans/Chapman error again |
| Macedonian Park, National Rd, Kinglake West **3065** | 387 National Park Rd, 3757; 3065 is Fitzroy's |
| **12 – 514** High St, Epping | 512 High Street — a mangled 512-514 |
| 18-26 Nyanza St, **Woodrige** | Woodridge |
| 100 Goyder St, Narrabundah **2601** | 2604 |
| 83-85 Victoria Street, **West Seddon** | Seddon; "West Seddon" is not a suburb |

The first three moved a pin and are corrected; the last three are cosmetic and
kept verbatim. Kinglake and Epping were settled by `mocmv.org.au` — the
Macedonian Orthodox Community of Victoria, which *owns* both properties, so it
is not an aggregator standing in for the jurisdiction but the freeholder
correcting its own diocese's typing.

**One parish publishes a PO box and nothing else**: the Synaxis of All
Macedonian Saints in Auckland, served by visiting clergy, with no venue named
anywhere. It is written as an Auckland centroid with a NULL address, like the
Romanian four.

**The Fitzroy question answers itself.** Third-party lists still name a St George
in Fitzroy; MOCMV's own history says it was relocated to Epping in 1995 and
rebuilt as St George and St Mary Mother of God. Four entries on those lists —
Rosebery, Broadmeadow, New Farm and Balcatta — appear on **neither** diocesan
site, so they are not imported: the rule is that a jurisdiction's own site is the
source, and an aggregator is a signpost. They are the first thing to ask a
Macedonian priest about.

**Final confidence: 14 pins on a building, 12 street-level, 1 locality
centroid.** `info_verified_at` is NULL on all 27. The weakest of the twelve
street pins is Gaven, which is Banyula Drive itself rather than number 219 —
the road is right and no house number resolves on it.

---

## What the Romanian SERVICE TIMES run cost

Seven recurrence rules across five parishes, taking the table from 75 schedules
to 82. Neither diocesan directory publishes a service time — the Macedonian
pages publish office hours, which is not the same thing and must not be read as
one — so every rule here came from a **parish's own website**, and each cites
that page with `source_name = 'Parish website'`.

| parish | rule |
|---|---|
| St Mary, Croydon Park | Sun 09:00–10:00 Matins; Sun 10:00–12:00 Liturgy |
| St George, Matangi | Sun 09:00 Matins; Sun 10:00–12:30 Divine Liturgy |
| Holy Brâncoveanu Martyrs, Glenfield | Sun 09:00–12:00 Matins & Liturgy |
| St Thomas the Apostle, Narre Warren North | Sun 10:00 Divine Liturgy |
| Holy Trinity, Koondoola | Sun 10:00 Sunday Service |

**A dated programme is not a rule.** Three of the Romanian parishes — Auckland,
Wellington and Christchurch — publish a month of services at a time, with real
dates and times. That is an adapter's output, not something to hand-write:
`infer.mjs` exists to turn scraped occurrences into rules and it will only do so
when a rule reproduces the observed dates exactly. Hand-writing "Sundays 9am"
from a March calendar asserts something the calendar does not.

**Glenfield is one rule and not two** because that is how the parish publishes
it: "UTRENIA ȘI SFÂNTA LITURGHIE … 09:00am to 12:00pm", one block, one span.
Splitting it into Matins and Liturgy would need a boundary nobody stated.

**Koondoola's title is "Sunday Service" on purpose.** The parish says *"Slujbele
se tin cu regularitate in fiecare duminica, incepand cu ora 10"* — the services
are held every Sunday from 10 — and names a day and an hour but not which
service. A Sunday morning at ten is almost certainly the Divine Liturgy, and
"almost certainly" is not what a card should say.

**What was dropped, and why:** St George Matangi's third Sunday line, "Sermon &
Holy Unction from 12:30 PM", which is the tail of the Liturgy rather than a
service somebody arrives for; the Kinglake monastery's "services most feast days
and Weekends from 9:00am", where *most* and *weekends* are both unexpressible in
`week_of_month` and a rule would put a card on two days the monastery did not
promise; and Epping's "always open on Sundays from 9am", which is an opening
time, not a service.

**The match is on parish + weekday + time, never on title**, so a re-run cannot
insert a second copy of a rule somebody has since renamed in */admin*. Seven
rules in the table already carry no source at all — one Antiochian and six
Serbian, all entered by hand through */admin* over the last two days — and they
are left exactly as they are.

---

## What the Greek SERVICE TIMES run cost

**17 recurrence rules, across 8 of 135 parishes.** That ratio is the finding,
not a shortfall in the scraping, and it is worth writing down plainly because
the next person to look at the Greek rows will assume somebody gave up.

```
135  Greek parishes in production
  0  for which the Archdiocese publishes a service time
 38  with a readable website of their own
  4  whose website exists and cannot be opened from a scraping environment
 14  searched by name and suburb, and found to publish nowhere at all
  9  publishing something that is deliberately NOT a rule
  8  publishing a standing weekly timetable  ->  17 rules
```

The gap between 38 readable sites and 8 usable ones is the shape of the whole
run: a Greek parish in Australia that has a website mostly uses it for a history,
a priest's photograph and a dated programme.

**The Archdiocese publishes no service time at all.** Not "publishes them
inconsistently" — publishes none. All 135 church pages at
`greekorthodox.org.au/churches/<slug>/` are one template, and the template has
rows for address, phone, fax, feast day, parish email, website, priest, deacon,
mobile and confessor. There is no row for a service. So unlike the Antiochian
run, where the same 24 pages that gave the addresses also gave 67 rules, this
run could not start from the directory at all: every Greek time has to come
from a parish's own site, which makes *finding the sites* the first pass rather
than a footnote.

**And the directory links to a site for only a quarter of them.** 34 of 135
carry a website; 101 carry nothing. Eleven of the 34 links no longer answer.

```bash
node scripts/scrape-greek-sites.mjs     cache/greek/       greek-sites.json
node scripts/scrape-greek-schedules.mjs greek-sites.json   cache/greek-sites/ greek-pages.json
node scripts/check-greek-quotes.mjs     greek-pages.json
node scripts/build-greek-schedules.mjs  greek-sites.json   greek-schedules.sql greek-websites.sql
```

### A hundred sites, a hundred layouts

`antiochian-schedules.mjs` is a line parser because that directory is one
template. Nothing here is. The readable Greek sites are WordPress, Wix,
Squarespace, two Blogspots and one hand-written table, and what they have in
common is not a layout — it is a **sentence**:

> Matins and Liturgy take place every Sunday morning from 7:30am-10:30am.

> Vespers take place every Saturday at 3pm.

> …to perform the Divine Liturgy in English on the last Saturday morning of
> every month. The Liturgy begins at 9:00am.

So the pipeline splits differently from the Antiochian one. `greek-crawl.mjs`
finds the page, `greek-schedules.mjs` parses English prose narrowly, and
`greek-service-times.mjs` holds the sentences a person selected — quoted
verbatim, with the URL they are on. **The test parses every quote and asserts
the rule claimed beside it**, so a mistyped hour fails the suite instead of
reaching D1. That is the check that makes a hand-curated file safe; without it
the file is just numbers somebody typed.

**And a second check proves the sentence is really on the page it cites.**
`check-greek-quotes.mjs` is not in CI — it needs the crawl output — and it
earned its keep on the first run: three of the first thirteen entries cited a
page that did not carry their sentence. One URL was invented outright
(`/sunday-services`, when All Saints publishes its times on `/sacraments`), one
cited a homepage when the text was on `/whats-on`, and one quoted across a
paragraph break so the hour and the week were never on the same line. All three
would have shipped a `source_ref` that a reader clicking *"Updated 2 days ago ·
Parish website"* would have found nothing on. Run it after every re-crawl: a
parish rewording its page is itself a finding, because the times may have moved
too.

That check is also why `context` and `note` are separate fields. `context` is
adjacent text copied off the same page and is verified like the quote; `note` is
the curator's own explanation and is never checked, because it is not something
the parish said. Collapsing the two meant the checker either had to sniff for
prose that "looks like a note" or stop checking headings at all.

### The traps, in the order they cost time

**A link crawler alone under-reports, and under-reporting here is a false
claim.** This run's headline is how many parishes publish nothing, so a page
that exists and was never fetched is not a gap — it is a wrong answer. St
Nicholas Marrickville publishes at `/general/serviceschedule.html`, linked only
from a submenu built by script and therefore absent from the HTML. Hence
`WELL_KNOWN_PATHS`: after ranking the links, try `/services`, `/programme`,
`/church-program` and a dozen others regardless. A 404 costs one request.

**Half the sites have no server-rendered text.** Wix and Squarespace return a
shell; `goacathedral.org.au` returns literally zero characters of body text to
`fetch`, and its only standing weekly rule is in that unrendered footer. Those
were fetched with a real browser into `cache/`, which is the same escape hatch
the Antiochian run used for a site that 403s robots — the repo scripts stay
dependency-free and read whatever is in the cache.

**A browser pass must not overwrite a good cache entry with a failed one.**
Merging the rendered pages back in clobbered Coburg's `/our-programs` — the
fullest Greek timetable in the country — with a 174-byte transient 502, and the
only reason it did not silently vanish from the import is that
`check-greek-quotes.mjs` reported five sentences citing a page that was no
longer in the crawl. Losing a page and losing a parish's rules look identical
from downstream, which is the argument for the check rather than for trusting
the merge.

**Three hosts cannot be reached from a scraping environment at all**, and that
is a third state which must not be collapsed into the other two. SiteGround's
captcha (`hcwa.org`, `gocna.com.au`) does not yield to a real browser either,
and two hosts are refused at the egress gateway. `greek-site-overrides.mjs`
records `unreachable` separately from `website: null`, because "nobody can read
it from here" and "this parish has no site" are different facts and only the
second one belongs in a count of parishes that publish nothing.

**Transient failures look exactly like dead sites.** The same host answered a
121-byte `upstream connect error` on one attempt and 200 on the next; an early
pass declared `dormition.org.au` and `axionestin.org.au` dead on that basis and
both are alive. Anything that is not a clean HTTP answer is retried with
backoff, and both the bare host and the `www.` host are tried, because about
half of these serve only one of the two.

**A candidate has to be confirmed against the dedication, not just the suburb.**
Australia has nine Greek parishes called St Nicholas and five called St George.
The aggregator offers `orthodoxtoowoomba.com` for St Nicholas Toowoomba; that
domain belongs to **St John the Baptist Orthodox Mission, a ROCOR community**.
Every discovered URL in `greek-site-overrides.mjs` was fetched and checked for
the parish's own suburb *and* its dedication *and* the word Orthodox before it
was written down, and that check is what caught this one.

### The rule about sources held, and it cost the run rules

`orthodoxyinaustralia.com` publishes a service time for most of these parishes.
None of them is used. It is an aggregator, and `docs/parish-ingestion.md` has
said since the ROCOR run that an aggregator is a signpost and not a source — so
it was read for its outbound links and closed. It is worth being explicit that
this was expensive: taking its word would have roughly tripled the rule count,
and the rules would have asserted `Parish website` about a page no parish wrote.

**A community that runs a parish IS that parish's publisher, though.** The Greek
Community of Melbourne runs five of these churches outright and publishes a page
for each; so do the Greek Community of Tasmania, of Geelong and of Northern
Australia. Those are first-party and are used as such. (The five Melbourne pages
carry an address, a priest and a long parish history, and not one service time —
which is a finding, not a reason to have skipped them.)

### What was refused, and why

**A dated programme is not a rule** — the Romanian run's finding, and three more
parishes fall under it. Perth's Evangelismos publishes every service for weeks
ahead with real dates; Templestowe publishes a "calendar of services"; Geelong
publishes a monthly programme. `infer.mjs` exists to turn observed occurrences
into rules and will only do so when a rule reproduces the dates exactly. Those
three want an adapter, and hand-writing "Sundays 8am" off a September calendar
asserts something the calendar does not.

**A parish that contradicts itself is not a source for either hour.** Coburg
publishes its timetable twice, at `/our-programs` and `/liturgical-programs`,
and the two disagree: Small Compline is Tuesdays 7pm on one page and Tuesdays
5pm on the other, and the Paraklesis to St John the Russian is Tuesday mornings
on one and Thursday mornings from 7am on the other. Both were dropped. The nine
rules that page *does* agree with itself about were taken.

**"Alternates" is a fortnight, and `week_of_month` has no spelling for it.**
Coburg's Compline and its Youth Group both rotate between that parish and St
Vasilios Brunswick. `week_of_month` NULL does not mean "unknown", it means every
matching weekday — so the widened rule would put a service at Coburg on the
Tuesdays it is at Brunswick. `parseWeekOfMonth` refuses the pattern *before* it
checks for the words "week" or "month", which is the same ordering bug the
Antiochian run shipped a test for and the same reason.

**An availability is not a service.** St Vasilios Brunswick publishes only that
a priest is "available at the Church every Monday to Friday between 4.00 -
6.00pm for Holy Confession". Mt Gravatt publishes administration office hours.
Templestowe publishes church opening hours. None is something somebody arrives
at, and the Romanian run drew the same line at Epping's "always open on Sundays
from 9am".

**A broadcast is not a service either.** St Nektarios Dianella publishes two
firmly recurring times — "Thursdays from 1:30pm of the recorded English liturgy
from the previous Saturday" and the same for the Greek liturgy on Sundays — and
both are radio programmes. They parse perfectly and mean nothing to somebody
deciding which church to go to. The liturgies themselves appear on that site
only inside a newsletter dated 2022.

**The one heading that was overruled, and why it is written down.** The Redfern
Cathedral states, in its site footer under a heading reading *Opening Hours*,
"Sunday / Divine Liturgy: 7:30 AM - 11:00 AM" — directly beneath "Mon - Fri:
8:00 AM - 3:30 PM", which is a genuine opening time and was not taken. The
heading is exactly what `NOT_A_SERVICE` refuses elsewhere, so taking the line
under it needs saying out loud: it names a service, a weekday and a span, and
every dated Sunday in the programme higher up the page starts at 7:30 am. The
programme corroborates the rule; it is not its source.

### The parish rows this corrected

The run re-read all 135 directory pages, so every Greek row's `info_checked_at`
is re-stamped — the column records when we last looked, and looking and finding
nothing new is still looking. Nineteen rows also had their `website` changed:
dead links cleared, missing ones filled in from the parish's own site or from
the community that runs it.

`info_source_name` and `info_source_ref` were deliberately **not** touched. The
address on these rows still came from the Archdiocese directory, and finding a
parish's website by search does not change where the rest of the row came from.
`info_verified_at` was not touched either, for the reason it exists: a scrape is
not a person standing in front of the building.

One row is worth naming. `greek-ladyaxionestin-northcote` pointed at
`greekorthodox.org.au/monasteries/holy-monastery-of-axion-estin`, which is a
404 — the Archdiocese moved it under `/churches/`. The column was **cleared**
rather than repointed at the new directory page: that page is the directory, not
a parish site, and `info_source_ref` already says the directory is where the row
came from. Storing it as the parish's website would claim the parish publishes
somewhere it does not.

### The rules, in full

| parish | rule |
|---|---|
| All Saints, Belmore | Sun 07:30–10:30 Matins & Divine Liturgy |
| Cathedral of the Annunciation, Redfern | Sun 07:30–11:00 Divine Liturgy |
| The Presentation of Our Lord, Coburg | Sun & Tue 06:30 Midnight Service; 07:00 Matins; 09:00 Divine Liturgy · Tue 19:00 Catechism · Fri 18:00 Liturgy (English) · Sat 15:00 Vespers |
| St Anna, Bundall | Sun 07:30–10:30 Matins & Divine Liturgy |
| St George, South Hobart | Sun 08:30 Matins & Divine Liturgy |
| Sts Raphael, Nicholas & Irene, Liverpool | Sun 07:30 Matins & Divine Liturgy |
| St Sophia, Taylor Square | Sat 09:00 Divine Liturgy in English, **last Saturday of the month** |
| St Sophrony, Hectorville | Sun 08:00–09:00 Matins; Sun 09:00–10:30 Divine Liturgy |

Nine of the seventeen are Coburg's. Every rule carries
`source_name = 'Parish website'`, the page it was read on, and the date it was
read — deliberately not "Greek Archdiocese", which publishes none of them and
should not be credited under a timetable.

### What to do next

**Four parishes want an adapter, not a curator.** Perth's Evangelismos, St
Spyridon Kingsford, Templestowe and the Redfern Cathedral all publish a full
dated programme — real dates, real times, weeks ahead. That is precisely
`infer.mjs`'s input, and an adapter over any one of them would produce more
rules than this entire run did, with tombstoning for free. Evangelismos is the
best first target: it publishes an "ALL SERVICES" list with start and end times
and a stable per-event URL.

**Two things block parishes this run could otherwise read.** `hcwa.org` and
`gocna.com.au` sit behind SiteGround's captcha, which a real browser does not
clear either; between them they cover Perth's Sts Constantine & Helen and
Darwin's St Nicholas. `saintnicholascanberra.org.au` and
`stsophiaadelaide.org.au` are refused at the egress gateway, not by the sites —
St Nicholas Canberra publishes a Church Program page that is very likely rule
material to anyone who can open it.

**And most of the jurisdiction is on Facebook.** Of the parishes searched by
hand, the commonest outcome by a wide margin was a Facebook page and nothing
else — St Nectarios Burwood, the Three Hierarchs Clayton, St Eustathios South
Melbourne, Sts Constantine & Helen Newtown, Holy Cross Wollongong, the
Transfiguration Earlwood, Sts Anargiri Oakleigh. Facebook is deliberately not
recorded in `parishes.website`: it cannot be crawled, cannot be re-read on a
schedule, and a `source_ref` pointing at a page nothing can fetch is worse than
an empty column. If Greek service times are ever going to be more than a
footnote in this database, that is the wall to get past, and it is a product
decision rather than a scraping one.
