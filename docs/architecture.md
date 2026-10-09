# How the feed is built

The date lens, the bundle, shared links, dates, time zones and dedup — how rules become the cards people scroll. Split out of CLAUDE.md, which keeps the rules that bite and links here for the reasons.

**The lens is pure and shared.** `public/shared/` holds the projection (`project.mjs`,
`tz.mjs`, `recurrence.mjs`) and the feed assembly (`merge.mjs`). Those files are served
to the browser *and* bundled into the Worker by the same import. There is one
implementation of the projection and one of the dedup — they cannot drift.

**The client projects, not the server.** `GET /api/bundle` returns rules, overrides,
one-off events and parishes; `public/bundle.js` expands them in the browser. This keeps
the Worker's CPU near zero (it matters — Workers Free meters 10ms of CPU per request)
and makes the response cacheable, since rules change rarely while a feed is stale the
moment "now" moves.

**The bundle is asked for every time, and asking is cheap.** `/api/bundle`
is `Cache-Control: no-cache` with an ETag that is a hash of the body, so a
browser never answers from its own copy and an unchanged bundle is a bodiless
304. The body is kept in the edge cache under a *data version* — one small R2
object, `meta/data-version` — that every successful write under `/api/admin/`
(except a draft's, which nothing public reads; publishing one does bump) and
every cron run bumps (`worker/lib/data-version.mjs`), so asking rarely
reaches D1 and an edit is what the admin's next load of the app gets. It was
`max-age=60, stale-while-revalidate=600` until an edit in /admin kept not
showing on the way back to the app. The version is in R2 rather than D1 so that
no migration has to land first. A write that bypasses the Worker (an import
from a terminal) does not bump it and shows within ten minutes, when the edge
copy expires.

On the wire a schedule rule carries **its own columns only**: `languages` and
`location_override` are its to set, and where either is null the parish's is
what shows. Everything else — name, pin, zone, website — is the parish's, and
the browser joins it back from the parish list in the same response
(`public/shared/parish-join.mjs`, the one list the Worker's SQL join is also
built from). Nothing public carries `updated_by`; it is an admin's email.

**A shared link is answered by the Worker, not the app.** A link to one
parish or one event (`/sgr`, `/sgr/next-tue`, `/102`, `/42:2026-10-04`) gets
a **lite card** — server-rendered by `worker/routes/pages.mjs` +
`worker/lib/lite-page.mjs`, with its own title, preview image, canonical and
JSON-LD — instead of the app booting behind a loading screen. It uses the
app's lens and the app's grammar (`public/shared/url-state.js`, which
`detectUrlState()` now calls too), fails open to the app, and is skipped for
`?app` and for the `agora_admin` cookie the app sets while someone holds a
role. `run_worker_first` is `/*` with negations to make this possible, and
**a negation must never name an image extension** — negatives are tested
first, and `!/*.png` would send `/posters/*.png` past the Worker's R2 proxy.
Only parish pages are indexable for now; `docs/lite-pages.md` records why
events wait.

**Synthetic ids.** A projected occurrence has the id `"<scheduleId>:YYYY-MM-DD"`, e.g.
`42:2026-09-06`. It is stable and addressable, so a deep link to a service that has never
existed as a row resolves — client-side, from rules the browser already holds.

**The feed has no last page.** `state._horizonDays` is how far forward the
window reaches; **Load more** adds to it and nothing takes it away. The step
costs a request only for what is genuinely window-bound — the overrides and
stored one-offs in the new stretch — because the rules that produce the
occurrences are already in the browser, which is the whole point of the lens.
`agoraBundle.load()` therefore takes a window and *widens*, never replaces:
the parish sheet asking for its month must not shrink what the main feed has
grown to.

**A date segment says where the stream starts.** `/smg/2026-07`,
`/next-thursday`, `/liturgy/wednesday/march` — `public/shared/dates.js` resolves
them, and a focus is a *from*, never a single day: a parish does not publish a
month at a time, and a picked day with nothing on it should show the next thing
that is. A month-shaped slug keeps its shape through the round trip (`2026-07`
does not read back as `2026-07-01`); a relative one resolves to the day it meant
and the URL settles on that. One focus, shared by the main feed and the parish
card, because the URL carries one date segment and two would immediately
disagree. Three-letter month abbreviations are deliberately NOT slugs — `sep` is
a parish, the acronym resolves last, and reserving it would not raise a clash but
silently take that parish's link away.

**`/morning` and `/evening` split the day at 2pm**, on the parish's own clock — the
line the feed already drew its Morning and Evening cards on, so a link and the
cards it lands on agree. `partOfDayOf` in `public/shared/services.js` is the one
reading; the cards use it too (they used to read Sydney's clock, which put a 1pm
Perth liturgy under Evening). Like a day or a service, a part of the day is a feed
filter on its own (`/antiochian/evening`, written day–part–service:
`/wed/evening/vespers`) and a schedule focus beside one parish (`/sgr/evening`).
Whenever the feed is narrowed by a service, a day or a part of the day, a banner at
the top of the list says so in a sentence ("Showing Antiochian evening Liturgies in
Queensland"), as the parish card's does; its × drops those three and keeps the
jurisdiction and region, which have controls of their own.

**Recurrence rules store LOCAL time; one-off events store UTC.** This is deliberate and
is documented at length in `d1/schema.sql`. For a recurring service the wall clock is the
invariant — a 9am liturgy stays 9am across a DST boundary — so normalising it to UTC would
make it drift an hour twice a year. Do not "fix" it.

**Parishes carry their own IANA timezone.** Oceania spans Perth (+08:00, no DST) to
Auckland (+12:00/+13:00, switching on different dates to Sydney). `parishes.timezone`
is what makes `start_time` meaningful.

**Times display in the PARISH's local time**, never the viewer's — the way a map shows a
venue's opening hours. Only "is it on right now" depends on the viewer's actual moment.

**Dedup decides which of two competing rows becomes one card** (`merge.mjs`): a
`week_of_month` rule beats a generic weekly one, a stored one-off beats a schedule
instance, then most-recently-updated. That middle rule is load-bearing — it is how a
scraped event supersedes its recurring twin instead of showing twice.

**A jurisdiction's colour is written down once**, in
`public/shared/jurisdiction-colors.js`, which the app, the map and the seed all
read — it exists because that table was three tables and two of them disagreed
about Greek. `jurisdiction_colors` in D1 does not make it four: it holds only
the rows */admin* → Colours has deliberately changed, absence means the file's
value, and a reset deletes the row rather than writing the default into it.

**Parishes have no colour of their own.** `parishes.color` is still a column and
still in the payload, and `public/bundle.js` overwrites it with the
jurisdiction's colour the moment the bundle lands — before the join copies it
onto rules and events as `parish_color` — so every reader draws the
jurisdiction's without being taught to. The panel no longer offers a parish
colour or a repaint.

**The Cron Trigger is a heartbeat, not a schedule.** A trigger is fixed at deploy
time and a Worker cannot change its own, so `wrangler.toml` fires hourly and
`adapter_settings` decides what an hour is allowed to do — enable, disable and
pace each adapter from `/admin` with no deploy. A missing row means enabled at
the default interval, because absence should never be the thing that stops a
scrape. Pacing is measured from the last *success*: a failing adapter that reset
the clock on every attempt would wait out its whole interval before retrying.
**Run now** ignores all of it.
