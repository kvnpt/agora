# Adding parishes in bulk

Every adapter names a parish, and `events.parish_id` is a foreign key, so the
parish has to exist before anything can be scraped for it. With one or two
parishes that is a line in `seeds/parishes.js`. With an archdiocese directory —
a few hundred names and addresses at once — it is a pipeline, and this is what
that pipeline has to get right.

This began as a brief for work that had not been done. Two directories have
since been ingested — the Greek Archdiocese, 135 parishes, and the ROCOR
Australian and New Zealand Diocese, all 37 — so the constraints below are now
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
196 parishes · 68 schedules · 68 events · 0 overrides
```

135 of those parishes are the Greek Archdiocese import, 37 the ROCOR one, and 24
the Antiochian one. Schedules and events are untouched by both — neither
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
