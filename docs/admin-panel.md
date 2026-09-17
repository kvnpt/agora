# The admin panel, read as if somebody else had the key

An assessment of `/admin` against the thing it has never had to be: a screen a
second person uses. Written 16 September 2026, against production.

`/admin` today has exactly one user, who also wrote it. Every affordance assumes
that. The copy is terse because the reader already knows; the destructive
actions are unguarded because the reader would not click them by accident; and
the half of the system that is not on the screen is not missing, it is in the
author's head.

A sub-admin has none of that. This document is what breaks when they arrive,
what it would cost to fix, and in which order.

The short version: the panel's weakest surface is the one that most needs a
second pair of hands, which is the PDF scrapers — because the PDF pipeline is
five systems and `/admin` shows one of them, and the only button on the card
does not do what the card's own warning asks for.

---

## What is on the screen now

Four tabs, one global jurisdiction filter, one privilege level.

| Tab | What it edits | API |
|---|---|---|
| Parishes | the `parishes` row, logo, short links | `/api/admin/parishes*` |
| Schedules | recurrence rules, and *Infer rules from scraped events* | `/api/admin/schedules*`, `…/schedule-proposals` |
| Adapters | per-adapter enable/pace/run-now | `/api/admin/adapters*` |
| Colours | the `jurisdiction_colors` override rows | `/api/admin/jurisdiction-colors` |

And a fifth surface that is not here at all. Editing a single occurrence —
cancel this Sunday, move it to 10am, combine it with the cathedral — lives in
`public/app.js`, inline on the public site, gated on `state.isAdmin`. It is the
most frequent admin act and the one a parish contact would actually be given.
`/admin` neither contains it nor mentions it.

Production, as of today: **293 parishes across 8 timezones**, 82 schedules, 3
adapters.

---

## What is actually broken right now

Not hypothetically. `GET /api/adapters/status`, today:

| Adapter | `healthy` | Coverage | Reality |
|---|---|---|---|
| `gcal-…-good-shepherd` | true | to 2026-12-09 | fine |
| `pdf-gopssc-buderim` | **true** | expired 2026-04-09 | one event, 160 days in the past |
| `pdf-stparaskevi-blacktown` | **false** | unknown | "No extracted text … Run the GitHub Action" |

Now the other half, which `/admin` cannot see. The "Extract parish PDFs" Action
ran on 2026-09-13 and **succeeded**. Its log:

```
[gopssc-buderim]        1 occurrences,  2 skipped, covering 2026-04-09..2026-04-09
[stparaskevi-blacktown] 78 occurrences, 0 skipped, covering 2026-07-01..2026-07-31
2/2 sources extracted.
```

Both files uploaded to R2. So:

- Blacktown's card shows a failure from 2026-09-12 whose cause was fixed on
  2026-09-13. The adapter has not run since, so the panel's freshest word on it
  is four days old and **nothing on the card says the word is stale**.
- Buderim is green with one service in April.
- The newest Blacktown text covers July — 47 days ago — and that is the *best*
  case: the extraction worked perfectly.
- The workflow reported success for both.

Two of three scrapers are delivering nothing current. The panel summarises this
as one OK, one "Out of dates", one "Failed — go run a GitHub Action". Only the
middle one is informative, and that is the new coverage work in
`worker/lib/coverage.mjs` doing exactly its job.

One contributing cause is in `scripts/extract-parish-pdf.mjs`:

```js
if (failures === sources.length) process.exit(1);
```

Green means *at least one* source extracted. With two sources, one success is a
green tick. At ten PDF parishes, nine failures is a green tick. The per-parish
signal is a `::error::` line inside a step summary nobody opens on a passing
run. The "never let one parish stop the others" instinct is right — but that is
about whether to *continue*, not about what to report at the end.

---

## The PDF pipeline, as a sub-admin meets it

```
parish website → GitHub Action (poppler/mutool) → R2 JSON → Worker adapter → D1 events → Infer → rules
                 ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~   ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                 invisible in /admin, and where every fix is  all /admin shows
```

The card shows one link in the chain. Every remedy is upstream of it.

| What they will ask | On the card? |
|---|---|
| Which PDF is this reading? | No. `sourceUrl` exists on the adapter, is never rendered |
| When was the PDF last fetched from the parish? | No. `fetched_at` is in the R2 doc, never read |
| Is it the same file as last time? | No. `pdf_sha256` is in the R2 doc, never read |
| Which month does it cover? | Only via `window`, and only after a run |
| Has the parish published a newer one? | No |
| **Does "Run now" fetch the PDF?** | **No — and nothing says so** |
| Then how do I get the new PDF in? | "Run the GitHub Action", which they cannot |
| Can I add a PDF parish? | No — code change, review, deploy |

### The worst single thing in the panel

On a PDF adapter, **Run now** re-reads an R2 object that only the Action can
change. The card says "Out of dates: the source covers nothing after
2026-04-09, 160 days ago". There is one button. A sub-admin will press it, get
`1 found, 0 new, 1 updated`, and have learned nothing — because re-reading the
same April text is guaranteed to produce the same April event.

The button looks like the fix and cannot be the fix. That is worse than having
no button, and it is the first thing to change.

`worker/lib/adapters.mjs` knows this — the comment on `ParishPdfAdapter.schedule`
says the Worker is "reading an R2 object that only changes when the Action runs".
The knowledge is in the code and not on the screen, which is the pattern for
most of what follows.

---

## The rest of the panel

Ordered by how much worse each gets when a second person arrives.

### A. Correctness, not polish

**1. There is no timezone field anywhere, and 64% of parishes are not Sydney.**

`POST /api/admin/parishes` defaults `timezone` to `'Australia/Sydney'`.
`PARISH_EDITABLE` includes `timezone`. Neither the Add form nor the parish edit
card exposes it. Production:

```
Sydney 105 · Melbourne 88 · Adelaide 33 · Brisbane 27 · Auckland 16
Perth 15 · Hobart 6 · Darwin 3
```

188 of 293 are not Sydney. `parishes.timezone` is what makes `start_time` an
instant — it is the invariant CLAUDE.md names twice and `docs/adapters.md` opens
its checklist with ("Queensland is `Australia/Brisbane` … the default is an hour
out for half the year"). A sub-admin adding a Perth parish through the panel
silently gets Sydney, and every service is two or three hours wrong. There is no
way to fix it afterwards through the panel either.

**2. The Add Schedule form says "Start (Sydney)" and "End (Sydney)".**

`d1/schema.sql`: `start_time TEXT NOT NULL, -- 'HH:MM' LOCAL to parishes.timezone`.
The label is wrong for two-thirds of the table, and worse than wrong: it invites
a sub-admin to *convert* a Perth parish's 9am into Sydney time. It should read
the selected parish's zone — "Start (Perth)".

**3. Deleting a parish is one unguarded click.**

`deleteParish()` fires `DELETE` immediately. If the parish has no events it is
gone, with a toast reading "Removed". Deleting a *schedule* asks for
confirmation; deleting a parish does not. When it does have events the guard is
a `prompt()` in which typing a parish name transfers and typing `DELETE`
destroys — free-text with two destructive branches, which is a pattern for
someone who wrote it, not someone who was handed it.

Worth stating plainly because CLAUDE.md does: the repo is not a backup. Recovery
is `npm run db:export` or D1 Time Travel.

**4. The Adapters tab describes a cron that does not exist.**

> "The cron runs them all every four hours"

`wrangler.toml` is `crons = ["0 * * * *"]` — hourly, with `adapter_settings`
deciding the rest. It is one sentence, but it is *the* sentence explaining the
model to a newcomer, and the section comment above it repeats the error.

### B. Provenance — the highest-leverage gap

**5. Neither editor can set a source, and nothing can set `info_verified_at`.**

- Parishes: `info_source_type`, `info_source_ref`, `info_source_name`,
  `info_checked_at`, `info_verified_at` are all in `PARISH_EDITABLE`. None are in
  the UI.
- Schedules: `source_name`, `source_ref`, `source_checked_at` are not even in
  `SCHEDULE_EDITABLE` — the API refuses them.

CLAUDE.md makes this a first-class principle: *"A source line says when we last
looked, never that it is right."* And `info_verified_at` is specifically the
field that "stops a re-import moving a pin somebody checked" — the one guard
protecting a human's careful work from the next bulk import. **It can only be
set by hand in SQL.** `scripts/parish-import.mjs` guards on it; nothing can
write it.

With one admin this is a rough edge. With five it is the difference between a
row you can trust and a row you cannot, because "is this address newer than the
scrape, and who says so" becomes the question you ask about every field.

**6. No identity on screen, no identity in the data.**

`adminIdentity()` in `worker/lib/auth.mjs` returns the Access email and is
documented "for audit lines". It is **called from nowhere**. Every row in D1 is
anonymous; the header shows a Log out button and never says who you are. "Who
changed St George's address" has no answer at any layer.

### C. Authorisation is a single boolean

`state.isAdmin`. Anyone Cloudflare Access lets through can delete any parish,
change any acronym — a URL namespace change, so `/smg` stops resolving for
everyone holding that link — repaint every jurisdiction site-wide, pause every
scraper, and delete any rule.

VISION.md already anticipates the answer: *"no user profiles beyond admin
roles."* Roles were always in the plan; they have simply never been needed.

### D. It does not scale to 293

**7. The parish list is flat, unsearchable and fully rendered.**

Every card carries a complete expandable form — roughly sixteen inputs — and all
293 are built on load. About 4,700 form controls in the DOM, filterable only by
jurisdiction, and Greek alone is 135. There is no text search, and no filter for
the questions an editor actually has: *no schedules*, *no address*, *no
acronym*, *not checked in six months*.

For the author, who knows which parish is which, this is friction. For a
sub-admin asked to fix one parish's phone number, finding the parish **is** the
task.

### E. Dead ends

**8.** Occurrence editing is on the public site, not here (above). A sub-admin
sent to `/admin` will not find the thing they were asked to do.

**9.** There is no view of `schedule_overrides` at all. No list of what has been
cancelled, moved or combined; no way to find a tombstone set by mistake. And
`applyTombstones` writes cancellations *automatically* from absence — the panel
cannot show what the machine decided on its own.

**10.** *Infer rules from scraped events* is good, and it is hidden behind a
collapsed disclosure on the Schedules tab with its own parish dropdown. It is
step 5 of the PDF onboarding flow; it belongs on the adapter card, as the
obvious next thing after "78 occurrences read".

**11.** Geocoding in the panel calls Nominatim from the browser and writes 4
decimal places in the Add form against 6 in the edit card. All the real logic —
the "Services held at:" venue rule, the ten-metre offset for a shared church,
the trap that put a pin 730m off — lives in `scripts/geocode-parish.mjs` and is
not reachable from the panel. A sub-admin geocoding a parish that meets in
another parish's church will put the pin on the wrong building, which is the
exact failure CLAUDE.md documents at length.

**12.** Nothing cross-links. The adapter card names a parish without linking to
it; a parish card never mentions that a scraper feeds it.

---

## What to do

### Tier 0 — before anyone else gets a login

Small, mechanical, and each one prevents a wrong row rather than an annoyance.

- A timezone select on both parish forms, required, no silent default.
- Label the schedule time fields from the selected parish's zone.
- `confirm()` on Delete Parish; replace the `prompt()` with a dialog whose
  transfer branch is a `<select>` and whose destroy branch needs the parish name
  typed.
- Correct the cron copy to hourly.
- Return `adminIdentity()` from `/api/admin/ping` and show "signed in as …".

### Tier 1 — make the PDF pipeline answerable and finishable

**(a) Make the card tell the truth about the file.** Everything needed is
already written to R2 by the extractor — `fetched_at`, `source_url`,
`discovered_from`, `pdf_sha256`, `pdf_bytes`, `extractor`. Have
`GET /api/admin/adapters` read that object for `parish-pdf` adapters and return
it. The card becomes:

> **Sts Paraskevi & Barbara, Blacktown** · parish-pdf
> Covers 1–31 July 2026 — **out of dates, 47 days ago**
> PDF fetched 3 days ago · `programme_july_2026_en.pdf` · same file as last time
> Found via church-programme.html · 78 services read
> [ Re-fetch from the parish ] [ Re-read the last fetch ] [ Propose rules → ]

**(b) Split the button.** "Re-fetch from the parish" and "Re-read the last
fetch" are different acts with different costs, and today only the second one
exists while the first one is what the warning asks for. This is the fix for the
worst problem in the panel and it is mostly a labelling change once (a) is done.

**(c) Let the panel actually re-fetch.** The workflow already takes
`inputs.key`. A `POST /api/admin/adapters/:id/refresh-source` that dispatches it
for that one key — fine-grained GitHub token as a Worker secret, `actions: write`
on this repo only — and then polls the run, closes the loop without a GitHub
account.

If a token in the Worker is unwelcome, the cheap 80% is a deep link to
`…/actions/workflows/parish-pdf.yml` plus the last workflow run's conclusion and
time rendered on the card. It still needs a GitHub login, but it stops being a
treasure hunt, and it makes the four-day-stale Blacktown card legible.

**(d) Make the Action's green mean all of them.** `process.exit(failures > 0)`.
A run that extracted one of two is not a success. Continuing past a failure is
right; reporting it as a pass is not.

**(e) Read coverage from the R2 doc, not only from the last run.** Coverage is
computed from `adapter_runs.window_to`, so a stuck or paused adapter's coverage
freezes with it — which is exactly why Blacktown's card says "unknown" while a
July file sits in R2. A card should be able to say "the newest file we hold
covers July" without an adapter run.

**(f) Optional, and the one that changes who can do the work:** move the PDF
*URL* out of code. `PDF_SOURCES` is code for good reasons — `parse`, `extract`
and `linkPattern` want review. But `sourceUrl` is the field that changes yearly,
is the most common maintenance act, and needs no review at all: Buderim
republishes under a new path every January and the file itself says a person
must edit that line. A `pdf_source_overrides` table holding only
`{key, source_url, updated_at, updated_by}`, read in preference to the file,
follows the `jurisdiction_colors` pattern exactly — file is the default, D1
holds only deliberate changes, reset deletes the row. It is what makes
pdf-sources.mjs's own promise — *"somebody who knows the parish supplies the URL
once"* — true for somebody who is not you.

### Tier 2 — provenance and scale

- Search box and saved filters on Parishes; build the edit form on expand rather
  than on load.
- A source block on both editors: name, ref, checked-at, plus an explicit
  "I have verified this in person" that stamps `info_verified_at` with the
  signed-in email. Add `source_name`/`source_ref`/`source_checked_at` to
  `SCHEDULE_EDITABLE` and render the same control on a rule.
- `updated_by` from `adminIdentity()` on parishes, schedules and overrides,
  rendered as "edited by … , 3 days ago".

### Tier 3 — roles

Role from an Access group claim:

- **owner** — everything, including colours, acronyms and deletes.
- **editor** — parishes, schedules, overrides; no delete, no colours, no acronym.
- **parish** — scoped to a list of parish ids; the tabs contain their parishes
  and nothing else.

Where a ban would be too blunt, propose instead: an acronym change or a parish
delete becomes a request the owner sees.

### Tier 4 — the missing surfaces

- An Overrides tab: live cancellations, moves and combines, including the ones
  `applyTombstones` wrote by itself, each with who, when and an undo.
- Link the two admin surfaces in both directions, so "edit this Sunday's
  liturgy" is reachable from `/admin` and the inline editor points back.

---

## The one-line version

Tier 0 stops a sub-admin creating wrong rows. Tier 1 is the real work, and its
core is that a PDF adapter card should describe **the parish's file** rather
than the Worker's last read of a copy of it — because the file is what goes
stale, and the file is the only thing a person can do anything about.
