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
failed` in `adapter_runs` tells you nothing. Add the parish to `seeds/parishes.js`,
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
npm test                     # node --test, ~125 tests
npm run dev                  # wrangler dev, local D1 and R2, admin bypass
```

Build a fixture from real published data — `worker/lib/infer.fixture.mjs` is the
pattern — and test the parser against it. For the end-to-end path, seed a local
D1 and call `runAdapter` directly; `worker/lib/adapters.test.mjs` has a D1 shim
over `better-sqlite3` you can reuse.

## Constraints that will bite

**No third-party runtime dependencies.** `package.json` has none outside
`devDependencies`, and the deployed bundle is ~85 KB. This is a real constraint,
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

A parish publishing a monthly PDF of services is the second common shape, and it
converges on the same `fetchEvents`. The table looks like this — real, from Good
Shepherd's published listing:

```
12
SEP, SAT
5pm     Vespers             Religious Centre, 38 Exhibition Walk, Clayton VIC 3168
6pm     Confession          Religious Centre, 38 Exhibition Walk, Clayton VIC 3168
13
SEP, SUN
9am     Matins (Orthros)    Monash Orthodox Chaplaincy, 38 Exhibition Walk…
10am    Divine Liturgy      Monash Orthodox Chaplaincy, 38 Exhibition Walk…
12:30pm FOUNDATIONS Course  Religious Centre…
```

A day number, a month/weekday header, then time / title / location rows until the
next date. Parsing that text is straightforward and testable.

## The part that needs deciding first

**Getting text out of a PDF inside a Worker is the problem, not parsing it.**
`pdf.js` and friends are far larger than this entire bundle and would blow the
CPU limit besides. Do not start by npm-installing one.

Three shapes that fit the constraints, roughly in order of preference:

1. **A GitHub Action extracts, the Worker reads.** The basemap workflow is the
   precedent: a scheduled Action fetches the PDF, extracts text with whatever
   heavy tool it likes, and uploads the result to R2 as JSON. The adapter then
   fetches that JSON — small, fast, dependency-free. Keeps the Worker clean and
   puts the fragile part somewhere with a full toolchain and visible logs.
2. **The parish publishes HTML too.** Many do, and it is usually the same table.
   Check before building anything: an HTML source makes this a normal adapter.
3. **An extraction service.** A fetch to something that returns text. Adds a
   dependency on someone else's uptime and possibly a key; weigh against (1).

**Verify the PDF actually changes month to month** before automating. If it is
published once and edited rarely, a manual upload through the admin panel may be
the honest answer, and a scraper is elaborate machinery for a file that changes
eleven times a year.

## Suggested order

1. Look at two or three real parish PDFs. Confirm the shape is stable across
   parishes, or find out how it differs.
2. Write the text → occurrences parser as a pure function with a fixture. No
   network, no PDF handling.
3. Decide the extraction route above, with the evidence from (1).
4. Wire `fetchEvents`, returning the month the PDF covers as the window.
5. Seed the parish, run it, accept the inferred rules, confirm the feed.
