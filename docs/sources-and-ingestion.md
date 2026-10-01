# Sources, provenance and ingestion

Where parish details and service times come from, how competing sources are ranked, and how adapters and imports write. Split out of CLAUDE.md, which keeps the rules that bite and links here for the reasons.

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

Two derivations sit on that ladder and should not be confused. `sourceTier` is
where a row's details **came from**, and it stays honest because the sheet
renders it. `governingTier` is who a scrape must **defer to**: a parish with a
website of its own speaks at `parish` however the row was filled in, so a
jurisdiction re-read holds every such row and only the parishes without one
fall back to the directory. No script reads parish *details* off a parish site
yet, so a held row's address and phone change by hand — `heldFields` lists
them on every run.

An edit in /admin is a claim by a person, and the PATCH route records it
without being asked (`adminEditProvenance`): a save that changes a detail
makes the source that person — "Admin" for an owner or editor, "Parish
Contact" for a parish contact (`adminSourceName`; `info_source_type='person'`)
— stamps `info_checked_at` now, and pins each changed field at `admin`, unless
that same save set the source or picked a check date itself.

**A timetable has one source.** Rules still carry `source_*` columns, because
importers write them, but a parish's timetable renders ONE provenance line: the
most recent stamp among its rules. Any create, edit or delete of a rule in
/admin restamps *every* rule of that parish with the editor's name and now
(`stampTimetable`), so "Updated today · Parish Contact" is the timetable as it
stands. An import that later re-reads one rule is then the most recent change,
which is also true. Both forms post every
field, so "changed" means different from the stored row, not present. A colour
or a link says nothing about the details and leaves the provenance alone.

Served **publicly** at `/api/info-overrides`, minus `updated_by`. The importers
are scripts run from a terminal with no Cloudflare credential — the same
argument that put `pdf_source_overrides` on a public route, and a stronger one:
a ruling only the Worker could see is a ruling the import ignores.

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

**Absence is a signal, under guards.** `infer.mjs` proposes recurrence rules from
scraped occurrences, and only when a rule reproduces the observed dates exactly —
every occurrence explained and every gap explained. `reconcile.mjs` then compares
projected rules against what a source published, and `tombstone.mjs` decides
whether a gap may become a cancellation. The asymmetry drives every choice in
those files: a missed cancellation leaves a stale card the next scrape fixes; a
false one keeps someone away from a service that is running.
