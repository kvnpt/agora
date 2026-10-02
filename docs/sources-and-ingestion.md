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

**One setting per parish says where it is read from.** `parishes.read_from`
(`public/shared/read-from.js`) is one of three values, and it is the only thing
an import asks before writing:

| `read_from` | Who may write the parish's details and rules |
|---|---|
| `directory` | the jurisdiction directory imports — the stopgap for a parish nobody looks after yet |
| `website` | a reader of the parish's own site, PDF or calendar; the directory leaves it alone |
| `hand` | nobody automated — a parish contact or the owner keeps it |

A website import may also take over a `directory` parish, and its SQL sets
`read_from = 'website'` as it writes: finding a parish's own site is exactly
what ends the stopgap. The directory never takes back a `website` parish, and
nothing writes a `hand` one. Approving a claim sets `hand`, and an adapter
refuses to run against a `hand` parish.

The first hand edit at a parish that is still read from a source asks, once:
**keep it by hand from now on, or keep reading it?** (`ensureKeptByHand` in
`app.js`; in /admin the delete dialog offers the same, ticked). "Keep reading"
is remembered per browser. A contact may switch the setting for their own
parish in its details edit mode; /admin's parish card has it too.

**What this replaced, and why.** Until October 2026 sources were refereed fact
by fact: a five-rung ladder (`source-tiers.js`: admin > the parish's site >
its directory > search > aggregator), `info_overrides` rulings that pinned a
field or suppressed a weekday-and-time slot, `governingTier`, `heldFields`, and
a "why is it gone?" prompt on every delete. The case that built it was real —
St Mary Magdalene, Elimbah's directory page lists two Vespers that do not run,
and deleting them did not survive the next import, because `planWrite` pairs a
scraped rule with an *existing* row and a deleted row is not one.

It was the wrong shape for a site maintained by parish contacts. Scraping is
only ever a stopgap until somebody owns the parish, and a parish whose source
turned out to be wrong is not one to keep scraping around the errors — it is one
to keep by hand. A slot ruling also refuses a *time*, not a service, so it
locked the survivor of a double-tapped Add at St George (October 2026). Now
Elimbah would simply be kept by hand. `source-tiers.js` survives for display
only (`sourceTier` labels where a row's details came from); `info_overrides`
is unread and stays in the schema until a later cleanup.

An edit in /admin is a claim by a person, and the PATCH route records it
without being asked (`adminEditProvenance`): a save that changes a detail
makes the source that person — "Admin" for an owner or editor, "Parish
Contact" for a parish contact (`adminSourceName`; `info_source_type='person'`)
— and stamps `info_checked_at` now, unless that same save set the source or
picked a check date itself (`worker/lib/provenance.mjs`). It pins nothing:
whether imports may still write the parish is `read_from`'s question.

**A timetable has one source.** Rules still carry `source_*` columns, because
importers write them, but a parish's timetable renders ONE provenance line: the
most recent stamp among its rules. Any create, edit or delete of a rule in
/admin restamps *every* rule of that parish with the editor's name and now
(`stampTimetable`), so "Updated today · Parish Contact" is the timetable as it
stands. An import that later re-reads one rule is then the most recent change,
which is also true. Both forms post every
field, so "changed" means different from the stored row, not present. A colour
or a link says nothing about the details and leaves the provenance alone.

`read_from` is served **publicly** in `/api/parishes`, because the importers
are scripts run from a terminal with no Cloudflare credential — the same
argument that put `pdf_source_overrides` on a public route. The directory
import's SQL also checks it (`WHERE parishes.read_from = 'directory'`), so a
parish taken over after the plan was read is not written.

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
