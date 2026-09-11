# Adding an adapter

An adapter is the only source-specific part of ingestion. Everything after it is
shared, so the whole job is: **fetch, and return occurrences with the window you
asked about.**

```
source-specific:   fetchEvents(env) → { events, window }
                            │
shared, already built:
                   ├── written to `events`, idempotent on source_hash
                   ├── infer.mjs       → proposed recurrence rules
                   ├── reconcile.mjs   → what the source stopped publishing
                   ├── tombstone.mjs   → whether absence may cancel anything
                   └── adapter_settings → enable / disable / pace, from /admin
```

## The contract

```js
class MySourceAdapter {
  constructor({ parishId, ... }) {
    this.id = `mysource-${parishId}`;   // unique; appears in adapter_runs
    this.parishId = parishId;           // must exist in `parishes`
    this.sourceType = 'my-source';      // shown in the admin panel
    this.schedule = '0 */4 * * *';      // informational only — see Pacing
  }

  async fetchEvents(env) {
    return {
      events: [{
        title: 'Divine Liturgy',
        start_utc: '2026-09-13T23:00:00.000Z',  // a real instant
        end_utc: null,
        event_type: 'liturgy',
        location_override: 'Religious Centre, 38 Exhibition Walk…',  // or null
        description: null,
        source_url: null,
        source_hash: await sha256Hex(`mysource-${id}`),  // stable per occurrence
        hide_live: 0,
        parish_scoped: 0,
      }],
      window: { from: '<ISO>', to: '<ISO>' },   // what you actually asked for
    };
  }
}
```

Register it in `ADAPTERS` at the bottom of `worker/lib/adapters.mjs`. There is no
directory scan — Workers have no filesystem.

### `window` is not optional in spirit

Returning a bare array still works, and the adapter simply gets no tombstoning.
But the window is what lets absence mean anything: `reconcile` only judges dates
the source was actually asked about, and `coveredLocalDates()` narrows an instant
range to the whole local days it covers, because naming the dates at each end
*widens* it and every widened day reads as a cancelled service. That bug shipped
once and cancelled two real services on a clean scrape. Report the window.

### `source_hash` is the idempotency key

`events` has `UNIQUE(source_hash)` and the write is an upsert, so a re-scrape
updates rather than duplicates. Make it stable for the same real-world
occurrence and different for different ones. A hash of the source's own id is
usually right; a hash of the title and time is not, because both change.

### The parish must exist first

`events.parish_id` is a foreign key. `runAdapter` checks before writing and fails
with a message naming the missing parish, because a bare `FOREIGN KEY constraint
failed` in `adapter_runs` tells you nothing. Adding parishes in bulk — a whole
jurisdiction's directory at once — is its own job with its own traps, and
`docs/parish-ingestion.md` covers it. For one parish: add it to `seeds/parishes.js`,
run `npm run gen:seed`, and paste `d1/seed-parishes.console.sql` into the D1
console. If the address genuinely cannot be confirmed, add the adapter to
`PENDING_PARISHES` so the panel disables it with a reason rather than failing
every four hours.

## What you get for free

**Rules from occurrences.** `/admin` → Schedules → *Infer rules from scraped
events* proposes recurrence rules, and only when a rule reproduces the observed
dates exactly — every occurrence explained and every gap explained. Fortnightly
series are withheld on purpose: `schedules` has no interval column, and the
month-position rule that fits the sample is wrong the first time a month has five
of the weekday.

**Cancellations.** Once rules exist, a service that disappears from the source
inside the covered window is tombstoned automatically, withdrawn if it comes
back, and never written over a human's override. A run that would cancel more
than half the parish is refused and says so in `adapter_runs.tombstones_refused`.

**Pacing.** `adapter_settings` decides how often each adapter runs; the Cron
Trigger is an hourly heartbeat. No settings row means enabled at four-hourly.

## Testing

Nothing needs the network:

```bash
npm test                     # node --test, ~171 tests
npm run dev                  # wrangler dev, local D1 and R2, admin bypass
```

Build a fixture from real published data — `worker/lib/infer.fixture.mjs` is the
pattern — and test the parser against it. For the end-to-end path, seed a local
D1 and call `runAdapter` directly; `worker/lib/adapters.test.mjs` has a D1 shim
over `better-sqlite3` you can reuse.

## Constraints that will bite

**No third-party runtime dependencies.** `package.json` has none outside
`devDependencies`, and the deployed bundle is ~101 KB. This is a real constraint,
not a preference: see the PDF note below.

**10ms CPU per invocation on Workers Free.** The date lens is client-side for
exactly this reason. Do not parse anything large in the request path.

**Parish-local time, not UTC.** `parishes.timezone` is what makes a service time
meaningful; Oceania spans Perth to Auckland. A Melbourne Sunday 10:00 in daylight
time is the *previous day* in UTC — compare local dates, never instants, when the
question is "which day is this on".

**`run_worker_first` in `wrangler.toml`.** Static assets answer before the Worker
unless a path is listed there. Add any new Worker-owned path to it, or a browser
navigating to it gets the app instead.

---

# The PDF case, specifically

A parish publishing its schedule as a PDF is the second common shape, and it
converges on the same `fetchEvents`. It is **built** — `worker/lib/pdf-schedule.mjs`
is the parser, `worker/lib/pdf-sources.mjs` is the list of parishes, and
`.github/workflows/parish-pdf.yml` does the extraction. What follows is what the
survey found and why the pieces sit where they do.

## A parish's source is remembered, not discovered

Nobody crawls a parish website looking for a link. Somebody who knows the parish
supplies the URL once and it lives in `worker/lib/pdf-sources.mjs`, next to
everything else specific to reading that parish's file:

```js
{
  key: 'gopssc-buderim',                       // adapter id and R2 object name
  parishId: 'greek-gopssc-buderim',
  sourceUrl: 'https://…/Liturgy%20Dates%20-%202026%20GOPSSC.pdf',
  timezone: 'Australia/Brisbane',
  publishes: 'yearly, revised in place',       // observed, and why the cron is weekly
  extract: 'layout',                           // or 'grid' — see below
  parse: { defaultLocation: "St Mark's…", locationColumn: false },
  notes: '…',
}
```

That list is imported by **two** things — the adapter registry and the GitHub
Action that does the extraction — so the URL the Action downloads and the URL the
adapter believes it is reading cannot drift apart. Same trick as `public/shared/`.
Adding a parish is adding an entry.

Deriving next year's URL from last year's is not an option, and that is
measured rather than assumed: the Sunshine Coast parish's 2025 sheet is
`2025 GOP SSC Service Sheet Eng|Gr.pdf` and its 2026 sheet is
`Liturgy Dates - 2026 GOPSSC.pdf`. The parish at Blacktown publishes
`programme_july_2026_en.pdf` — and `programme_june_2026_en.pdf` is a 404,
because that month was never posted.

## What five real parish schedules actually look like

The shape is **not** stable across parishes. This was the question worth
answering first, and the answer changed the design.

| Parish | Shape | Text layer | Outcome |
|---|---|---|---|
| Good Shepherd, Clayton | listing, time first | — | publishes a **Google Calendar**; the gcal adapter already covers it |
| Sunshine Coast, 2025 | listing, time last | subsetted fonts + ToUnicode | 23 liturgies |
| Sunshine Coast, 2026 | listing, time last | same | 26 Sundays, 3 with a clock, 1 parsable |
| St Paraskevi, Blacktown | bordered grid | clean | 75–78 services a month, via the grid extractor |
| St Nicholas, Wallsend | scan | **none at all** | needs OCR |

Two things in that table decide everything else.

**The Wallsend schedule has no text in it.** It is a single 2480×3504 JPEG — a
photograph of a printed sheet — and the parish has published them that way since
2003. `pdftotext` returns zero characters. No parser reaches that file; only OCR
does.

**Even the readable ones are not readable cheaply.** Every PDF with a text layer
used subsetted fonts, where `<0033>` is a glyph id in that font's own numbering
and means "P" only after its `/ToUnicode` CMap is resolved. One file surveyed
(orthodox.net) ships no such map at all, so the embedded font *program* has to be
parsed to recover the characters.

## The extraction route, decided

**A GitHub Action extracts, the Worker reads.** `.github/workflows/parish-pdf.yml`
installs poppler and mupdf, reads each source's PDF with whichever of the two its
`extract` mode calls for, and puts the text in R2 as `pdf-schedules/<key>.json`.
The adapter fetches that — small, fast, dependency-free — and hands the text to
the pure parser.

The other two options were weighed against what the survey found:

- *The parish publishes HTML too.* Checked, and for one parish it is the right
  answer: Good Shepherd's "events calendar" page is a Google Calendar embed
  pointing at the calendar `gcal-…` already reads. There was no PDF adapter to
  write there. The other parishes publish PDFs and nothing else.
- *An extraction service.* Rejected. It buys nothing the Action does not, and
  costs a key and somebody else's uptime.

Doing it inside the Worker was never on: `pdf.js` is larger than this entire
bundle before it opens a file, Workers Free meters 10ms of CPU per invocation,
and none of it would read the scan.

Putting the fragile half in an Action has a second benefit that was not the
reason for it but matters: the parish's own server is hit on the **Action's**
weekly schedule, not on the Worker's. An hourly heartbeat never touches anybody's
website.

## Was it worth automating at all?

The doc's own advice is to check, because "a scraper is elaborate machinery for a
file that changes eleven times a year". The check:

- Blacktown publishes monthly, **irregularly** — May and July 2026 exist, June
  and August do not, and the page still linked July in September.
- The Sunshine Coast publishes **yearly**.

So: barely, on republication alone. What tips it is the **revision in place**.
The current Sunshine Coast sheet is titled *"REVISED LIST INCLUDING DETAILS FOR
HOLY WEEK"* — the same URL, edited. That is precisely the change a person
re-uploading by hand never notices, and a weekly re-fetch catches for free. The
cron is weekly for that reason and not a shorter one.

## The grid, and where it is actually solved

`parseSchedulePdfText` reads a **listing**: a date header owns every service row
beneath it until the next date header. Both column orders are handled, because
both are real — Good Shepherd writes `5pm  Vespers  Religious Centre…` and the
Sunshine Coast writes `Liturgy of John Chrysostom      11.30 am`.

A `DATE | FEAST | SERVICE | TIME` grid is a different problem, and the parser
**refuses** one rather than guessing at it. In the Blacktown file the date cell is
drawn **once and centred** over its block of services, so once the layout is
flattened to lines the date lands in the middle of its own block:

```
  01/07      Cosmas & Damian     Vespers & Paraklesis…      5:00-6:00 pm
                                 Matins & Divine Liturgy    7:30-9:30 am   <- 2 July
              Deposition of the
 Thursday
            Robe of the Most     Vespers & Paraklesis…      5:00-6:00 pm
  02/07
```

That "Matins" belongs to 2 July and sits three lines *above* the `02/07` cell.
Attaching it to the nearest date above advertises a liturgy on the wrong morning
**and** tells `reconcile.mjs` the right one was cancelled — both halves of the
asymmetry in one mistake. Nothing left in the text can tell you otherwise.

**But the information is not gone.** It is in the ruled lines, which live in the
PDF's vector layer where no text extractor looks. So the grid is solved in the
**extractor**, where the geometry still exists, and the parser stays a pure
text-to-occurrences function that never guesses:

```
extract: 'grid'   →   mutool draw -F trace   →   scripts/pdf-grid.mjs   →   a listing
```

`mutool` reports the drawn paths alongside the glyphs, in one coordinate system.
`scripts/pdf-grid.mjs` reads the rules back into a table and emits the listing the
parser already understands. Nothing is inferred.

The observation that makes it general: **a merged cell has no rule across it, so
a column's rule count is its granularity.** In the Blacktown file DATE and FEAST
have 19 boundaries per page and SERVICE and TIME have 39–48. The coarse columns
describe a day, the fine ones describe a service, and no part of this needs to
know that a column is called "FEAST". The table's own header row is dropped
because its first cell has no digits in it; the letterhead is kept, because
"JULY 2026" is the only thing in the file that says which year `01/07` is in.

The result on the real files: **78 services for July, 75 for May, none skipped,
every day of the month covered** — where the same files flattened to text are
refused outright. `worker/lib/pdf-schedule.fixture.mjs` holds both forms of the
same page so the contrast stays tested.

Two things this does not reach. A PDF whose table is drawn without rules has
nothing to read, and a scan has nothing at all — that one needs OCR, which is a
tool the Action could gain and the Worker never will.


## What the parser will not invent

- A date with no time yields **nothing**. Most of the 2026 Sunshine Coast sheet is
  dates only, and that parish's usual hour is well known — but writing 11.30am
  onto a date the parish did not put a time against is how someone ends up
  outside a locked church.
- A time whose service is on a *different* line yields nothing. Holy Week in that
  same sheet puts the service above its time on 10 April and below it on
  11 April; either guess is wrong half the time.
- `NO SERVICE AT BUDERIM` yields nothing — deliberately. The occurrence is then
  simply absent from the window, `reconcile.mjs` notices, and `tombstone.mjs`
  decides with all its guards whether that absence may become a visible
  CANCELLED card. An adapter has no way to write a tombstone directly and should
  not have one.

## Coverage, and why it is clamped

The window an adapter reports decides which dates a missing service is allowed to
be read as a cancellation on, which makes it the most dangerous value here.

It is clamped to the dates actually parsed, never widened to the period the file
declares. A monthly programme really does cover its whole month, so clamping
gives up real signal at the edges. That is the cheap direction. The expensive one
is claiming a month, having extraction quietly deliver half of it, and cancelling
every service in the half nobody saw — and that is not hypothetical when one of
the files in the corpus yields zero characters.

If nothing parses, the adapter reports **no window at all**, which costs it
tombstoning and is exactly the trade the contract describes above.

## Adding the next parish

1. Confirm the parish exists in `seeds/parishes.js` with a real address, a
   confirmed pin and the right IANA timezone. Queensland is `Australia/Brisbane`,
   not `Australia/Sydney` — no daylight saving, so the default is an hour out for
   half the year.
2. Add an entry to `PDF_SOURCES` in `worker/lib/pdf-sources.mjs` with the URL
   somebody has actually opened, and whatever `parse` options its layout needs.
   Leave `extract` alone for a listing; set it to `'grid'` for a bordered table.
3. Run the workflow with **Dry run** ticked. The log reports occurrences, skips
   and coverage per source, so a layout the parser cannot read shows up there
   rather than when the feed empties — a `REFUSED column-grid` in that log
   usually just means the source wants `extract: 'grid'`.
4. Untick it and run for real, then **Run now** in `/admin` → Adapters.
5. `/admin` → Schedules → *Infer rules from scraped events* to turn the
   occurrences into recurrence rules.
