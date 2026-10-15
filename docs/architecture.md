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
its place (`location_override`, `location_parish_id`, `location_lat`/`lng` —
[editing.md](editing.md)) are its to set, and where they are null the parish's
is what shows. Everything else — name, pin, zone, website — is the parish's, and
the browser joins it back from the parish list in the same response
(`public/shared/parish-join.mjs`, the one list the Worker's SQL join is also
built from). Nothing public carries `updated_by`; it is an admin's email.

**A shared link is answered by the Worker, not the app.** A link to one
parish or one event (`/sgr`, `/sgr/next-tue`, `/102`, `/42:2026-10-04`) gets
a **lite card** — server-rendered by `worker/routes/pages.mjs` +
`worker/lib/lite-page.mjs`, with its own title, preview image, canonical and
JSON-LD — instead of the app booting behind a loading screen. Every other
filter link (`/greek/qld`, `/liturgy`, `/timetables`) gets a **timetable page**
(`worker/lib/lite-timetable.mjs`): the matching parishes' rules by state and
jurisdiction, filtered by `public/shared/timetable.js` as the app's Schedules
view is. The home page is still the app. It uses the
app's lens and the app's grammar (`public/shared/url-state.js`, which
`detectUrlState()` now calls too), fails open to the app, and is skipped for
`?app`, and for the `agora_admin` cookie at a parish or event link — where
the app answers instead and lays that card out as the same page, with its
editors (page mode). The pages wear `/app.css` and the app's own markup. `run_worker_first` is `/*` with negations to make this possible, and
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

**`/this-week` is the next seven days**, from today, and `/this-month` the
month from today. The toolbar's When control cycles Today → This week → This
month → Today; a week wears chevrons either side, to `/next-week`,
`/in-3-weeks`, `/last-week`, `/2-weeks-ago` (`weekSegment` / `weekOffsetOf`).
A date from its calendar takes the period's place, and like a date a period is
shared by the feed and the parish card. A date segment and a period do not
stand together: picking a date ends the week. Under Today the feed is endless —
reaching its foot loads the next stretch; a week ends in a "Next week" button.

**Where is the map, but only once it is asked.** The feed and the timetable
start at any location: the map's view narrows nothing. A pan or a zoom by the
person (a gesture, not a fit or a fly-to: map.js checks `originalEvent`) turns
on area search — the toolbar's "Searching this area" pill — and the lists are
then the parishes in view (`areaIds()`); the pill's ×, Clear all, or the empty
feed's "Search any location" turn it off. It is not in the URL. A week's list
runs on past its week: ‹ › scroll to the week before or after within it, and
the label follows the week at the top as the list scrolls.

**What kind of event, and in what language, are segments too.** `/services` is
Services (liturgy, prayer, feast), with one of them as `/liturgy`, `/prayer`
or `/feast`; `/talks` is talks, with Bible studies as `/bible-study`;
`/social` is socials and youth, `/social-gatherings` or `/social-youth` one of
the two. `/liturgy`, `/feast` and `/bible-study` are service slugs as well
(services.js): beside a parish they focus its timetable, and across the feed
the app reads them as the kind (`kindOfService`). The timetable is
`/timetables` (or `/parishes`), because it lists more than services; a lone
`/services` is the timetable page of services for a crawler. The old
`/worship…`, `/services-liturgy…` and `/studies` links get a 301 to their name
now (`renamedPath`). One kind at a time: a later kind segment replaces an
earlier one, and the timetable wins over all of them. A language is
`/in-greek`, or `/in-greek-only` for nothing but Greek; English keeps `/en` and
`/en-only`. An acronym cannot start `in-` or name a week
(`reservedSlugReason`). The kind and the language narrow the timetable too —
`kindMatches` and `langsMatch` in `public/shared/timetable.js`, read by the app
and the timetable pages alike. `KIND_SEGMENTS` and `SERVICE_KINDS` in
`url-state.js` are the table.

**One set of controls for both toolbars.** The main sheet's toolbar and the
parish card's are painted by the same builders (`renderFilterSlots` in
`app.js`) over two filter sets: `state.filters` for the feed,
`state.parishFilters` for the card, which narrows the card's timetable as well
as its events. The When control is the one they share, because the date is.

**What this browser keeps** — favourite parishes, bookmarked events, saved
filters — lives in `localStorage` and nowhere else. Nobody signs in to read
the app, so there is no account to hang them on, and none of it is ever sent:
a saved filter is a link, and a bookmark is an id. A bookmark is an event (a
stored one, or one date of a rule by its synthetic id) or a whole rule, which
covers every date of it. Bookmarks are a toolbar filter but not a segment: a
link to "my bookmarks" would mean nothing in another browser. Every read and
write survives storage being refused; the controls come back empty.

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

**Parishes have no colour of their own.** `public/bundle.js` puts the
jurisdiction's colour on every parish as `color` the moment the bundle lands —
before the join copies it onto rules and events as `parish_color` — so every
reader draws the jurisdiction's without being taught to. Where the Worker joins
a parish in SQL (a rule projected for a lite page, `/api/schedules`, a one-off
event), it selects the same colour as `parish_color` with `PARISH_COLOR_SQL`
(`worker/lib/juris-colors.mjs`): the override where there is a valid one, the
table's otherwise. There was a `parishes.color`, dropped in migration 026: it
had gone stale under 49 Macedonian and Romanian parishes when /admin repainted
their jurisdictions, and the lite pages, the last thing still drawing it, showed
those parishes in the old colours.

**The map marks time with halos, not colour.** Three of them, under the dot,
all one design: a ring with a thin white ring just inside it. A parish with a
service on now has a green one that breathes — a little bigger and smaller, a
little brighter and fainter; one with something still to come today, in its own
zone, tolls — a neutral ring that spreads out of the dot at a steady pace and
fades, without first shrinking (the paint transitions are off — `NO_EASE` —
because MapLibre's default 300 ms eased every frame's step back towards the
last); one whose own event is on now **somewhere else** breathes in the toll's
neutral colour, because the parish is running something and the green belongs
where the people are. An event held at another parish (`location_parish_id`)
lights both: both toll on the day, and once it starts the venue breathes green
and the host neutral. Where a parish has more than one thing on, green beats the
neutral breath beats the toll. The dot keeps its jurisdiction colour either way,
and a grape carries the halos of the parishes in it (`now_count`, `away_count`,
`today_count`). The flags come from the events the feed shows (its content
filters) and are worked out again every minute. The motion is CONSTANT paint
values stepped each frame, one layer per marker size, because a data-driven paint
property that changes re-tiles the source — `map.js`, "Halos".

**A place of its own is a square.** An event held "Somewhere else" with a pin is
the first marker on the map that is not a parish: a square in its host's
jurisdiction colour, labelled with the event, with the venue's halo under it.
One square per place per host (a weekly class at one hall is one square), ended
events draw none, and a tap opens the soonest of them — the one on, if one is —
in the event sheet, expanded, without moving the map: the square is already
where the reader is looking. The event's parish button hands over to that
parish's card with the event pinned at its head, collapsed; tapping it there
opens the event sheet again and puts the card away. The square is one SDF image built
from raw pixels, so `icon-color` paints it any colour and the vm test can build
it — `map.js`, "Places". It is also where a group with events and no church of
its own will sit on the map.

**A favourite wears a star**, gold, at its dot's shoulder (`parish-fav-star`,
another SDF image) and before its acronym in the pill row. The star is this
browser's, so it is a feature property rebuilt with the rest, not data.

**The Cron Trigger is a heartbeat, not a schedule.** A trigger is fixed at deploy
time and a Worker cannot change its own, so `wrangler.toml` fires hourly and
`adapter_settings` decides what an hour is allowed to do — enable, disable and
pace each adapter from `/admin` with no deploy. A missing row means enabled at
the default interval, because absence should never be the thing that stops a
scrape. Pacing is measured from the last *success*: a failing adapter that reset
the clock on every attempt would wait out its whole interval before retrying.
**Run now** ignores all of it.
