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
reaches D1 and an edit is what the admin's next load of the page gets. It was
`max-age=60, stale-while-revalidate=600` until an edit in /admin kept not
showing on the way back to the app it was then. The version is in R2 rather than D1 so that
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

**Every link is the page.** v3 is one page that reads its own address
(`public/index.html`, `public/next/next.js`): the home page, a parish (`/sgr`,
`/sgr/next-tue`), an event (`/102`, `/42:2026-10-04`), a collection (`/en`,
`/sun/liturgy`) and any other filter link (`/greek/qld`). Every page path reaches
the Worker (`worker/routes/pages.mjs`), which writes what the link is into the
page's head — title, description, canonical, robots, preview, JSON-LD — and paints
the card it opens (`worker/lib/page-card.mjs`), so a chat preview, a search engine
and a reader with no JavaScript get it, and a person sees the card before the
bundle lands. It reads the link with the page's grammar
(`public/shared/url-state.js`) and the page's lens (`expandFrom` + `buildFeed`), and
fails open to the page as deployed. `run_worker_first` is `/*` with negations to
make this possible, and **a negation must never name an image extension** —
negatives are tested first, and `!/*.png` would send `/posters/*.png` past the
Worker's R2 proxy. Parish pages and the collections are indexable;
[lite-pages.md](lite-pages.md) records why events wait. Until October 2026 the
Worker answered these links with separate lite pages and the app sat at `/`;
v3 replaced both ([history.md](history.md)).

**Synthetic ids.** A projected occurrence has the id `"<scheduleId>:YYYY-MM-DD"`, e.g.
`42:2026-09-06`. It is stable and addressable, so a deep link to a service that has never
existed as a row resolves — client-side, from rules the browser already holds.

**The feed has no last page.** The page has no feed of its own: Today's button
opens the In view card (or the one parish in view), and a card's Calendar grows a
fortnight at a time as it is scrolled (`moreIO` in `next.js`, to a year), and
nothing takes it away: the new days are added under the ones on screen
(`growComingUp`), never the whole list drawn again, which flashed every
picture in it (Kevin, 7 Nov 2026). A wait for days the bundle lacks leaves
what is on screen and fades it a little after a moment (`loadQuietly`). The step
costs a request only for what is genuinely window-bound — the overrides and
stored one-offs in the new stretch — because the rules that produce the
occurrences are already in the browser, which is the whole point of the lens.
`agoraBundle.load()` therefore takes a window and *widens*, never replaces:
a parish card asking for its weeks must not shrink what the stream has grown
to.

**Month is the same Calendar as a grid.** The list was a calendar app's agenda
view all along, and a card's Calendar is headed as one (Kevin, 7 Nov 2026): one
row with the month's name for its title (an up-and-down chevron beside it),
**Today** when the list is on another day, and the card's Filters; under it
S M T W T F S over a week of days, Sunday first, with up to four dots a day in
the colour of each one's kind and a + from the fifth. The whole head is held
under the card's bar while the list scrolls under it, as Fantastical's week
drawer was, and each day's header is held under the head till the next one
comes up. No day is marked in the week or the month: the day headers say
where the list is. The week swipes a week at a time and follows the list; a
tapped day has the list go to it, as Tomorrow does in Today, growing the list
in place when it has not got that far (`goToDay` in `next.js`). The way back
up to the rest of the card is the card's ↑ (placed between the name and
Today while the head is held), or scrolling up past the Calendar. The month's
name opens the whole month (`public/next/month.js` and `month.css`, loaded on
the first tap as `editing.js` is, and kept by `sw.js`); it reads what the
list reads (`cardList`, the card's filters included) and stores nothing. On a
phone the month opens in the week's place, months swiped like a gallery, and
the name, or a day tapped in it, closes it back to the week; on a laptop
(≥1080px) the grid takes the map's place beside the card, titles in the cells
(their lines the jurisdiction's, as the list's), while the week stays in the
card, and **Map** has the map back. There is no Date button, no Month button
and no X. A card of more than four parishes marks only **Notices** (each
day's one-offs, changes and cancellations, with a grey count of its regular
services, in the month), and a card of a few can switch each parish off and
on, as a calendar app's calendars, until the month closes. Neither is
remembered. A re-drawn list waits for its logos to decode before it swaps in
(`swapDecoded`), so nothing flashes. The Worker's first paint titles the
Calendar with its month too (`page-card.mjs` `calHeadHTML`).

**A date segment says where the stream starts.** `/smg/2026-07`,
`/next-thursday`, `/liturgy/wednesday/march` — `public/shared/dates.js` resolves
them, and a focus is a *from*, never a single day: a parish does not publish a
month at a time, and a picked day with nothing on it should show the next thing
that is. A month-shaped slug keeps its shape through the round trip (`2026-07`
does not read back as `2026-07-01`); a relative one resolves to the day it meant
and the URL settles on that. A date beside a parish is that card's; beside a
collection, that collection card's; on its own (`/2026-11-05`), the In view
card's (`openPageCard`), because the URL carries one date segment and two
would immediately disagree. Three-letter month abbreviations are deliberately NOT slugs — `sep` is
a parish, the acronym resolves last, and reserving it would not raise a clash but
silently take that parish's link away.

**`/this-week` is the next seven days**, from today, and `/this-month` the
month from today; `/next-week`, `/in-3-weeks`, `/last-week`, `/2-weeks-ago`
name the others (`weekSegment` / `weekOffsetOf` in `url-state.js`). A date segment
and a period do not stand together: a date ends the week.

**What is on the map is what the lists hold.** The page's lists — Today, What's
on, the stream, a collection's count — are the parishes and events in the map's
view (`S.inView`, `inViewEvent`), and the chip under the map counts them and
says where the map is looking ("Sydney", "Near you", "Oceania" zoomed out); with
one parish in view it is that parish, by its full name, and opens its card.
With more, it opens them as a card named for what it holds: "64 parishes in
Sydney", "8 parishes near you", over the filters said as a link's preview says
them ("Antiochian Orthodox Liturgies in English near you",
`public/shared/link-words.js`), and a list saved from it keeps both.
Scrolled past it and the filters, both ride in the dock at the top of the page
(`syncDock`), and the filters opened from there open under it. A link that
names a region or parishes frames them (`frameRegion`, `fitTo`), so it lands
showing everything it means. It is not in the URL.

On a phone the tabs, the map, Today and What's on are one card (`.vc-shell`,
Kevin, 12 and 13 Nov 2026), the phone's full width with its corners still
rounded. The jurisdiction tabs keep their look as the card's head, so with the
card's edge they frame the map; Full screen and Filters are on the map under
them, and the map has the card's old top margin, so Today starts where it did.
The chip is a button on the map's foot, three
logos at most in a box of one size and the count ("63 parishes ›"); one parish
is its name across the map, over Near me. Today is on the map's plane under
it, a pin on the edge between them on a blue edge, because Today is what is on
where the map is looking; What's on is under Today, a hairline between them,
because it follows the map too (with no Today it takes the edge and the pin).
The page's Today is the whole day, cut off under a fade where it runs long
(`clipToday`), and Show all opens the rest in place with Tomorrow at its
foot. Its buttons on the right, a bookmark and a star, each there only once
you have some, make the page yours instead (`S.todayMode`, `todayMine`,
`mineOf`): Today, titled Saved or Favourites, is all of what you
saved or what is on at your favourites, wherever the map is and
whatever its filters ask; the map shows only their places (`syncMap`), and
the parishes button counts those in view or takes the map out to them. The
pin goes and the edge is the card's own outline, and Tomorrow goes on in
your Saved or Favourites card. Each Today row has the Calendar's line in the colour of
the jurisdiction it is held in (a parish card's in the parish's). Wide (1080px
and up), Today heads the left column, What's on the right, and the chip is the
page's heading under the map (`placeToday` in `next.js`), as before.
`index.html` has them where a phone does.

**Several jurisdictions, or several days, are one segment**: `/antiochian+greek`,
`/wed+fri`, written in the tabs' order and from Sunday; `/greek/antiochian` and
`/fri/wed` read the same. A filter holds one as its key or its number, as every
older link means, and several as a list (`jurisdictionValue` in `url-state.js`,
`dayValue` in `services.js`); a `+` segment that is not all jurisdictions or all
days is a list of parishes, as it always was. The map's tabs are one
jurisdiction at a time; the filters' panel takes as many as you like, and each
is a chip in its colour.

**What kind of event, and in what language, are segments too.** `/services` is
Services (liturgy, prayer, feast), with one of them as `/liturgy`, `/prayer`
or `/feast`; `/talks` is talks, with Bible studies as `/bible-study`;
`/social` is socials and youth, `/social-gatherings` or `/youth` one of
the two. `/talk`, `/socials` and the older `/social-youth` are read as people type
them and never written (`KIND_ALIASES`).
`/liturgy`, `/feast` and `/bible-study` are service slugs as well
(services.js), and across the page they read as the kind (`kindOfService`).
Beside a parish (`/smg/feast`) they are the service, and a feast is what the
day is: a row typed Feast is one whatever it is called (Great Vespers, the
Archangels its subtitle), and still the service it is called (`anyTitle`).

**Beside one parish, a filter is about that parish, not the page.** A link
(`/sgr/talk`, `/sgr/wed/liturgy`, `/sgr/evening`, `/sgr/en`) opens the first that
answers it as an event's card, in front of St George's own plain card (`openMatch`
in next.js): a step back, or the event's Parish, is the parish. Under the event,
its Calendar: that event first, outlined, then the others that answer, a season
ahead at most (`calendarHTML`). A date of a regular service has one however its
card was reached: that date, then its timetable line's dates after it (Kevin,
9 Nov 2026), and the Worker's first paint of its card has the same.
The event's card keeps the link followed (`segsFor({ parish, focus })`), so sharing
it shares that. With none on file, the parish's plain card is all there is, at
`/sgr`, as if the link had named only the parish. A card's own Filters focus it
(`/sgr/talks`): every line and date still on it, what answers lit (the next of it in
Today under its day's name) and the rest dimmed, never hidden; its × in Today lets
it go, back to `/sgr` (`focusOf`, `rowAnswers`, `parishTodayHTML`).

**A card's filters are that card's** (Kevin, 5 Nov 2026). A link that opens a
card (`/sun/liturgy`, `/smg+smk/feast`, `/greek`, a date, a search's words) gives
its filters to the card it opens and never to the page (`opensCard`, `openRoute`
in next.js): the page under it is plain, and closing it is `/`. A link with no
card (`/greek/qld`, `/nsw`) is a view of the map (`applyPage`); a city's own page
(`/sydney`, `/english/syd`; `PLACES` in `collections.js`) is a card of its
parishes over the map framed on it, so that a search engine has a list to read
(Kevin, 10 Nov 2026). A history entry
with no card (`depth` 0) is the map's filters; one with a card reopens the card.
A card opened from another card, or from the map, starts plain: no parish card
takes the focus of what was under it; a link that finds one parish opens as that
parish's own link would (`/smg+smk/feast` with only SMK's ahead is `/smk/feast`).
The map's own Filters and tabs are the map's, and its Today's, What's on's and
the In view card's (Kevin, 6 Nov 2026), and no one else's. They are a button on
the map with how many are on (`syncCounts`), never a row of chips, and What's
on comes before what does not follow them. Every Filters (the map's, the dock's,
a card's) pops out of its button as the toolbar's ⋯ does (`openFilters`): a
heading per question saying what it is set to, one open at a time. The map's
button goes where the map goes, and in a card it asks the card's. Collections and Languages are every
jurisdiction's whatever the map says; `/greek` is the Greek card. A collection's own Filters ask what its link does not
(`ownAsks`): Sunday Liturgy's offer time of day, language and jurisdiction but
no What or days, so it stays Sunday Liturgy; a language's offers "only"; Clear
all is the collection as its link has it. A jurisdiction is narrowed inside a
collection's card (`jurisOffer`). In view, a link's card and a list ask
everything. Every card of parishes (a collection, a jurisdiction's, a list,
a saved view, a link's, a search's, In view) has the page's one map at its
top, showing its parishes and no others (`mapFollow`, `mapToCard`): there is
no Show on map (Kevin, 6 Nov 2026). It is framed near where you are or where
the page's map was looking; closing the card or the back button puts it back
on the page as it was (`mapToPage`), and the page's map, filters and shelves
never see the card's. On a wide screen the card is a panel and the map stays
on the page beside it, in front of the scrim, its buttons clear of the panel
(`beside`). A saved view from Your lists opens its card (`openView`): the one
its link opens, or for jurisdictions or a place alone (`/greek+serbian`) a
card of every parish it means, wherever they are. A timetable line opens
its own card (`openLine`): the line's next date with its later dates under it,
over the card it was tapped on, which stays as it was. Its link asks what the
line is (`lineFocus`: `/smg/sun/liturgy`, `/spp/sun/liturgy/en-only` where the
parish holds that service in another language too), or is its date's own where
no link can ask for it (a choir practice).

**A word nothing else claims, beside one parish, is a search of it** (Kevin,
28 Oct 2026). `/smmp/disco` is "disco" asked of St Mary's, read as the search
box reads it (`public/shared/search-words.js`, which the box reads too): each
word in what a row says (its title, subtitle or description) or in where it is
(its parishes' names, initials, addresses and jurisdictions, and a place of its
own), and a kind, day or language word as intent. A word is found wherever it
is: "antiochian michael" is Kirrawee's Feast of St Michael, though only its
parish's jurisdiction says "Antiochian" (Kevin, 2 Nov 2026; it used to need
every word in the title, or every word in the parish's name). The box lists
what says the words itself first, then what is found by where it is. It is a focus like `/sgr/talks`, so the soonest match opens over the
parish and "More “disco”" lists the rest, a season ahead; nothing matching is the
parish's plain card. Everything the grammar already knows comes first: the
parish's own links and payment links (the Worker's redirects), the words above,
then acronyms (`url-state.js` keeps the rest as `words`; `parishNamed` reads
`/disco/smmp` as `/smmp/disco` once the reader has found the parish). Such a
link is never indexed.

**Words that name no parish are a search of the site** (Kevin, 28 Oct 2026):
`/village`, `/vigil`, `/antiochian/festival`. They are read the same way, under
whatever else the link says (its jurisdiction, region, kind or day), and one
verdict (`findAcross` in `search-words.js`) decides what opens, on the page
(`openWords`) and in the Worker's preview (`wordsPage` in `routes/pages.mjs`).
One parish by its name, with nothing found elsewhere, is its card. All that is
found at one parish is its first, over that parish's card, as at `/smmp/disco`;
and words that name a parish ask the rest of themselves of it, as the box does
with "smg feast", so `/smg-feast` is `/smg/feast` (Kevin, 1 Nov 2026). A parish
named is there for itself and finds nothing elsewhere (`/kirrawee` is Kirrawee,
not every Vespers it takes part in); what is found at one parish only through
where it is asks that parish what it says (`/ryde-vespers` is `/smg/vespers`).
Several places are a Search card of them, by distance, the parish named beside
the rest ("list both", 28 Oct): its timetables keep the lines that answer and a
named parish's whole week, and its link is the words'. Nothing is the search box
with the words in it, and a 404. A Parish only row is its parish's own business
and is not found from here. Never indexed, as above.

A collection's
timetables do the opposite: they keep only the lines that answer what it asks
(`/services` its services, `/sun/liturgy` its Sunday Liturgies), as its head counts
them, and a collection that asks nothing of them (`/greek`) shows each whole week. The timetable is
`/timetables` (or `/parishes`), because it lists more than services; a lone
`/services` is the timetable page of services for a crawler. The old
`/worship…`, `/services-liturgy…` and `/studies` links get a 301 to their name
now (`renamedPath`). One kind at a time: a later kind segment replaces an
earlier one, and the timetable wins over all of them. A language is
`/in-greek`, or `/in-greek-only` for nothing but Greek; English keeps `/en` and
`/en-only`. An acronym cannot start `in-` or name a week
(`reservedSlugReason`). The kind and the language narrow the timetable too —
`kindMatches` and `langsMatch` in `public/shared/timetable.js`, read by the page
and the Worker's painted cards alike. `KIND_SEGMENTS` and `SERVICE_KINDS` in
`url-state.js` are the table.

**What this browser keeps** — favourite parishes, bookmarked events, saved
filters — lives in `localStorage` and nowhere else. Nobody signs in to read
the site, so there is no account to hang them on, and none of it is ever sent:
a saved filter is a link, and a bookmark is an id. A bookmark is an event (a
stored one, or one date of a rule by its synthetic id) or a whole rule, which
covers every date of it. The stores are the ones the old app wrote
(`agora-favourites`, `agora-bookmarks`, `agora-saved-filters`), so nothing kept
in a browser was lost when v3 replaced it; v3 adds `agora-lists`, lists of
parishes. Favourites are open on the page under Today once a parish is
starred, each with what is on next there; the other lists, bookmarks and saved
views are rows under them (Your lists), once there are any. Bookmarks are
called Save and Saved on the page, never "bookmark" (Kevin, 12 Nov 2026); the
code and the stores keep the old word, so nothing kept had to move. They are
not a segment: a link to what you saved would mean nothing in another browser. Every read and
write survives storage being refused; the controls come back empty.

**Saved to a Home Screen, the page is an app.** Since iOS 26 every site added
to an iPhone's Home Screen opens full screen, so what the page owes it is an
icon, a name and an answer with no signal. `public/manifest.webmanifest` names
it (`orthodoxy.au`, opening `/`), `apple-touch-icon.png` and the `icon-*.png`
sizes are its icon, and `public/sw.js` is the answer: network first for every
request, keeping what came back and handing it out only when the network
fails, so it never serves a stale page to anybody online. A first visit loads
before `sw.js` is there to keep anything, so the page then sends it the
addresses it loaded (`performance` entries), once. The bundle is kept
under one key whatever its window; tiles, posters, `/admin` and the rest of
`/api/` are never kept. The icon is a placeholder (the map's grape bunch over
the land of `oceania.pmtiles`, `public/icon.svg`); the PNGs are renders of
that SVG, made again whenever it changes. Every file sits at the root, so a
PNG goes through the Worker and back out of the assets (`pageOf` reads a
dotted last segment as a file), as `/apple-touch-icon.png` always did.

**`/morning` and `/evening` split the day at 2pm**, on the parish's own clock — the
line the feed already drew its Morning and Evening cards on, so a link and the
cards it lands on agree. `partOfDayOf` in `public/shared/services.js` is the one
reading; the cards use it too (they used to read Sydney's clock, which put a 1pm
Perth liturgy under Evening). Like a day or a service, a part of the day is a feed
filter on its own (`/antiochian/evening`, written day–part–service:
`/wed/evening/vespers`) and a card's focus beside one parish (`/sgr/evening`).
The page's day lists split there too (`isEvening` in
`public/shared/timetable-lines.js`).

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
`week_of_month` rule beats a generic weekly one (and of two, the one naming fewer
weeks: a 4th Sunday that is also the last goes to the "last Sundays" rule), a stored
one-off beats a schedule instance, then most-recently-updated. That middle rule is load-bearing — it is how a
scraped event supersedes its recurring twin instead of showing twice. A week a
service is held otherwise is not a second rule for the dedup to pair: it is an
exception on the one rule, projected with it (`schedule_week_exceptions`,
`project.mjs withException`, [editing.md](editing.md)), and the bundle carries
those rows beside the rules as `week_exceptions`.

**A jurisdiction's colour is written down once**, in
`public/shared/jurisdiction-colors.js`, which the page, the map and the seed all
read — it exists because that table was three tables and two of them disagreed
about Greek. `jurisdiction_colors` in D1 does not make it four: it holds only
the rows */admin* → Colours has deliberately changed, absence means the file's
value, and a reset deletes the row rather than writing the default into it.

**Two blues, one job each.** The app's own blue is the user's: the electric
blue phones use for where you are. It marks you and what you do (`--accent` in
`next.css`: links, buttons) and how far things are from you (`--dist`: the
distances, the edge between the map and Today and its pin, your dot in
`map.js`), so the app reads as an extension of you. Greek's flag blue is one
jurisdiction among six, kept apart from it in both schemes. The six jurisdictions, the event types
(`event-types.js`) and these two were chosen together in November 2026, at
least 10 apart (OKLab ΔE×100) where they sit side by side; a change to one is
checked against the rest.

**Parishes have no colour of their own.** `public/bundle.js` puts the
jurisdiction's colour on every parish as `color` the moment the bundle lands —
before the join copies it onto rules and events as `parish_color` — so every
reader draws the jurisdiction's without being taught to. Where the Worker joins
a parish in SQL (a rule projected for a link's painted card, `/api/schedules`, a one-off
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

**Every halo frame is a draw of the whole map**, basemap and all, so the loop
runs only while it shows: something lit, the page visible, the map's box on
screen, and a lit marker in or near the view, at 15 frames a second. Two
MapLibre behaviours had turned 30 halo steps a second into 120 full draws a
second, forever, even with the map scrolled away: any paint change restarts
the default 300 ms ease on everything that eases (the style's sky included),
and any change at all re-places the labels and then draws every frame for the
300 ms label fade. So the style's own `transition` is none, and the label fade
is off while the map is still and back as soon as it moves (`setupStillLabels`).
Measured 30 Oct 2026: a still map with a halo in view draws ~29 times a second,
and otherwise not at all.

**The map waits on as little as it can.** The parishes go on at `style.load`,
not `load` (which waits for every tile and font); a parish's logo becomes its
map sprite only when it is picked; the label fonts the first view needs are
preloaded as the map starts, served compressed and kept a week
(`public/_headers`), and in two weights, not three (the theme's italic water
names are set upright); the canvas draws at most two device pixels to a CSS
pixel; and the editor's scripts load only for somebody who may edit
(`EDITING_SCRIPTS`, `next.js`). On a slow-4G, 4x-CPU phone profile this took
the map's first full draw from ~9.8 s to ~5.3 s.

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
