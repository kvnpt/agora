---
description: Scrape a jurisdiction's parish directory into D1, in the three reviewable passes docs/parish-ingestion.md asks for
argument-hint: <jurisdiction> — one of serbian, romanian, macedonian, antiochian, other
---

Ingest the parish directory for: **$ARGUMENTS**

Read `docs/parish-ingestion.md` before touching anything. It is the brief, and
the two "what the run actually cost" sections at the end are field notes from
imports that have already happened — the Greek Archdiocese (135 parishes) and
ROCOR Australia & New Zealand (37). Everything below is the part that generalises.

## The one rule about sources

**The jurisdiction's own website is the source of parish information.** Names,
addresses, suburbs, phones, websites: all of it comes from the people who run
the parishes, because `info_source_type='website'` is an assertion that they
told us, and it should be true.

Third-party aggregators — `orthodox-world.org`, `orthodoxyinaustralia.com`,
church-directory sites — are for **finding the jurisdiction's site and nothing
else.** They are a signpost, not a source. `orthodox-world.org/en/c/13/australia`
lists every Australian diocese with a link to each one's official site, which is
the fastest way to find a jurisdiction you cannot otherwise locate.

The ROCOR run broke this rule and it is the one thing about it to not copy. That
diocese genuinely publishes no addresses — the ROCOR-wide directory its own
links point at is dead — so addresses came from `orthodox-world.org`, and the
rows had to be relabelled `'import'` when the provenance was thought through. If
the jurisdiction publishes addresses, use theirs. If it does not, prefer each
parish's own site, then research with the source recorded per row; reach for an
aggregator last and label it `'import'` when you do.

## Three passes, three files

Never geocode and write in one go. A directory scrape that does gives you a few
hundred rows and no way to tell which are wrong.

```bash
node scripts/scrape-<jurisdiction>.mjs   cache/ scraped.json
node scripts/geocode-<jurisdiction>.mjs  scraped.json cache/geo/ geocoded.json
node scripts/build-<jurisdiction>-sql.mjs geocoded.json parishes.sql
```

Read each file before running the next. The ROCOR equivalents
(`scripts/scrape-rocor.mjs`, `geocode-rocor.mjs`, `build-rocor-sql.mjs`) are
worth copying as a shape — the fetching and parsing is written fresh per
jurisdiction because every site differs, but the tiering, the caching and the
reports transfer directly.

Cache every HTTP response to disk on the first fetch. It makes the parsing
iterative, costs the site one pass, and makes a re-run free.

## Do not rewrite these

`scripts/parish-import.mjs` holds the parts that repeat, with
`scripts/parish-import.test.mjs` pinning them to real cases:

- `parishId(jurisdiction, name, suburb)` — `<jurisdiction>-<name>-<suburb>`
- `reconcile(scraped, existing)` — `{ pinned, fresh, ambiguous }`
- `buildUpsert(rows)` — the guarded `ON CONFLICT`

**`reconcile` is not optional and its output is meant to be read.** Derivation
cannot reproduce an id somebody typed by hand, and the mismatch is partial —
some rows update, some duplicate, which is far harder to spot than a clean
failure. Print the pin list and look at it. `ambiguous` is a question for a
person and is never resolved automatically.

## The traps, in the order they will cost you

**Timezone comes from the geocoded ISO code, never from the directory's own
heading.** ROCOR files Tweed Heads under Queensland; it is in New South Wales,
which observes daylight saving. That is every service there an hour out for half
the year. Read `ISO3166-2-lvl4` from Nominatim, not `address.state` — the ACT
arrives under `address.territory` and leaves Canberra with no zone at all.

**A state-constrained locality query fails by returning the wrong place, not
nothing.** `"Tweed Heads, Queensland"` answers with *Tweed Heads Avenue*, a
street 80km away. Require the first component of the display name to name the
suburb, compared as a sorted set of words so "East Brunswick" matches "Brunswick
East"; treat anything else as no result and ask again without the state.

**Nominatim answers a suburb with the council that contains it.** "Blacktown"
returns Blacktown City Council's centroid, 5.3km from the church. Prefer a
`class=place` result.

**One OSM building belongs to one parish.** Matching on the dedication alone
gave Croydon the Strathfield cathedral and Fairfield the Cabramatta church,
both 100% confidently. Claim each building exclusively.

**A dedication is not a jurisdiction.** Brisbane's Russian and Serbian
St Nicholas sit 500m apart and OSM tags the Serbian one `greek_orthodox`.
Refuse any denomination naming another jurisdiction outright, whatever the
name says. This matters *more* for $ARGUMENTS than it did for ROCOR if the
jurisdiction's parishes share dedications with their neighbours.

**Overpass:** `overpass-api.de` is unreachable from this environment; use
`https://overpass.kumi.systems/api/interpreter`. It 504s on a 6km radius over
inner Sydney or Melbourne. One bbox-wide `denomination~<jurisdiction>` query
over Oceania (`-48,112,-9,180`) is the best single source — cheap, and the tag
asserts the jurisdiction for you. Node's `fetch` has no default timeout and
Overpass holds a connection it dislikes open, so give every request an
`AbortSignal.timeout` or the run stops dead with nothing to read.

**"Postal address" is not a location.** ROCOR's Marrickville monastery
publishes a PO box. A postal address that is a PO box cannot be pinned; treat
it as no address rather than geocoding it.

**`lat` and `lng` are NOT NULL, and that is not a reason to invent a pin.** Hold
back a parish you cannot place, list it, and say why. A marker where there is no
church is worse than an absent parish — the absent one is obviously missing.
`--include-suburb` exists for when the owner decides otherwise, and when it is
used, leave `address` NULL on those rows: there is no column for pin quality, so
an absent address is the only thing marking a row as unchecked.

**Check the jurisdiction is in the CHECK constraint** before ingesting hundreds
of rows. `jurisdiction IN ('antiochian','greek','serbian','russian','romanian',
'macedonian','other')` — Coptic, Ukrainian, Georgian, Bulgarian and OCA all
collapse to `other`, and `other` is a one-way door once written. Widen the
schema deliberately and first, or not at all.

## Writing

```bash
npm test                       # must be green before any write
npm run db:export              # back up production first
npx wrangler d1 execute agora --remote --file=parishes.sql
curl -sS https://agora.orthodoxy.au/api/parishes   # verify
```

`/api/parishes`, `/api/bundle` and `/api/adapters/status` answer without any
credential. Use them to see production before and after; a token is only needed
to write.

**Diff the regenerated SQL against whatever was applied before re-running it.**
On the ROCOR follow-up that diff was the only thing that surfaced 22 rows whose
`info_source_type` was wrong and which a re-run could not have fixed, because
the column was missing from `REFRESHABLE` while `info_source_ref` was in it.
Provenance columns describe one fact and move together.

The upsert is guarded by `WHERE parishes.info_verified_at IS NULL`, so a re-run
refreshes what nobody has checked and cannot overwrite what somebody has. Do not
stamp `info_verified_at` yourself — a scrape has not verified anything.

Do not make `seeds/parishes.js` authoritative. It is a dev fixture; adding
deletes or a sync would destroy rows it never held. See CLAUDE.md.

## A head start on the Serbians

Verified while writing this, so it should still hold:

- **`soc.org.au`** is the Metropolitanate of Australia and New Zealand's own
  site, and it is self-sufficient — no aggregator needed.
- Its **WordPress REST API exposes the real post types**, which neither previous
  jurisdiction did: `/wp-json/wp/v2/parish` (`x-wp-total: 45`),
  plus `monastery` and `clergy`. Paginate with `per_page`; the default of 2 will
  mislead you.
- `/wp-json/wp/v2/state` resolves the **state taxonomy** each parish carries —
  NSW 14, Victoria 15, ACT 16, NT 17, QLD 18, TAS 19, WA 20, NZ 21, SA 22. The
  `count` on each is across *all* post types, not parishes, so it will not sum
  to 45.
- The REST payload carries identity — title, slug, link, `state` — but **not the
  address**: `content` is absent and `acf` comes back empty. Addresses are on
  the parish page, `/parish/<slug>/`, labelled `Postal address:` with phone and
  clergy beside them. So: REST for the list and the state, the page for the
  address.
- 45 parishes, 42 in Australia and 3 in New Zealand, plus monasteries listed
  separately. Decide whether monasteries are in scope — ROCOR's were, on the
  grounds that they hold public services, which is the only test that matters
  for a feed of services.

## Done means

- Every row has a pin, an IANA timezone derived from its geocoded location, and
  a recorded source — `info_source_type`, `info_source_ref` **and**
  `info_source_name`. The name is what the parish sheet actually shows, so a row
  without one is a row whose provenance nobody can see. Name the *source*, not
  the parish, so a jurisdiction's whole import shares one label.
- `reconcile`'s pin list has been read by a person; nothing ambiguous was
  resolved automatically.
- Parishes that could not be placed are listed with the reason, not guessed.
- `npm test` green, `docs/parish-ingestion.md` carries a "what the run actually
  cost" section for this jurisdiction, and the confidence split is written down
  honestly.
