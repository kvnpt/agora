# Lite pages: shared links answered by the Worker

A link somebody sends — `/sgr`, `/sgr/next-tue`, `/sgr/wed/liturgy`, `/sgr/evening`,
`/sgr/services`, `/102`, `/42:2026-10-04` — is answered with a **lite card**: that parish, and the event the
link names, server-rendered by the Worker. It paints at once with no map, reads with
JavaScript off, and carries its own title, description, preview image, canonical URL
and structured data. A chat app previewing the link and a search engine indexing it
get the same HTML a person does.

Before this, every such link booted the whole app — MapLibre, the full bundle for 293
parishes, tiles — behind a loading screen, and a preview got a fixed title and an
empty shell.

## How a request finds it

1. **`run_worker_first = ["/*", …negations]`** in `wrangler.toml` sends every page path
   to the Worker. The negations keep static files off it, and they are the load-bearing
   part: `*` matches across `/` and negative rules are tested first, so they must name
   directories and **text** extensions only. An image extension (`!/*.png`) would send
   `/posters/x.png` to the asset router, which has no posters.
2. The API, the R2 proxy (`/tiles`, `/logos`, `/posters`) and the payment links match
   first, as before.
3. `servePage` (`worker/routes/pages.mjs`) classifies the path with
   `public/shared/url-state.js` — **the same grammar the app parses with** — and answers
   three shapes: one parish (with any day / part of the day / service / date focus, and
   `/services` for its timetable), a bare event id, and **every other filter link** —
   the timetable page below. Everything else — the home page, a link with a date and no
   parish, `/social`, `/donate` — returns null and the app loads as it always did.
4. **It fails open.** A render that throws returns null and the app answers the link.

Two ways past it: `?app` (VIEW MAP on the hero, and the card's "Open in the app" button) and the `agora_admin`
cookie, which the app sets while somebody holds a role. The cookie grants nothing — the
API checks the Access token on every request — and it only matters at a parish or an
event link: an admin there gets the app, because the editors live in the app.

**Page mode.** So that an admin sees the page a visitor sees, with the controls on it,
the app lays that card out AS the page when it is the one answering a parish or event
link (`decidePageMode` in `app.js`, deciding by url-state's `pageKind`, the Worker's own
rule): the parish sheet full-screen and still, the map put away behind it, the same hero
on top and the same card under it with its ✕ (`placePageChrome` moves the sheet's ✕ into
the scroll, onto the card). Every in-place editor works there as it does on the sheet. The ✕ puts the card away and the map comes forward. VIEW MAP puts the page away
and opens the card again as the sheet, at half over the map with its pin centred above;
the rest of the hero reloads the app at `/`, as on a visitor's page. Only on arriving at such
a link — a parish opened from the map is still the sheet over the map, and `?app` asks
for the map app. A timetable page has nothing to edit, so admins get it like anyone.

## What it shows

`worker/lib/lite-page.mjs`, pure (rows in, HTML out; covered by `node --test`):

- the occurrences come from `expandFrom` + `buildFeed`, the same functions `bundle.js`
  runs in the browser, over one parish's rows (`fetchWindowRows({ parishId })`);
- the pin follows the app's rules (`firstEventOnDay` in `url-state.js`): an id pins its
  event, a day pins only an event ON that day, a service, weekday or part of the day
  (`/sgr/evening`, split at 2pm on the parish's clock) pins the next of its kind; a
  synthetic id lists the other dates of the same rule;
- `/sgr/services` is the timetable instead — the rules the link's day, part and service
  name, no dates and no pin — and under it **View upcoming events →**, which opens the
  app on the same link minus `/services` (`/sgr/evening/services` → `/sgr/evening?app`);
- the way into the app is a button in the parish's colour directly above the list
  (**Open in the app →**, the same link with `?app`). It used to be a line of small
  print in the footer;
- the box above is headed **"Antiochian timetable"** — what it is, not whose church —
  and the list under it **"Coming up"**, in the same shape: the rule, then what it
  projects. A focus banner ("Showing Vespers") heads the list instead when the link
  narrows it, in the app's sheet as here;
- times in the parish's zone; nothing "now"-relative is baked in — `public/lite.js`
  marks "Now" and fades past services on the viewer's clock, settles relative dates in
  the address bar (`/next-tue` → `/2026-10-06`), and puts up the app's loading screen
  when somebody asks for the app (below). It fetches nothing of the app until then.

**It wears the app's design.** The page links `/app.css` and writes the app's own class
names — `ps-header`, the `jurisdiction-box` timetable above the events, `day-section` /
`time-card` / `event-card`, the Schedules view's boxes on a timetable page — so a
visitor's page and an admin's page-mode card look the same. Each markup function in
`lite-page.mjs` names the app function it mirrors; it is copied, not shared, until roadmap
phase 3 moves the renderers into `public/shared/`. `LITE_CSS` holds only what a page
needs that a sheet does not: the card and its ✕ (to the app, where "← Back to App" was),
the column, `<details>` so an event opens with no JavaScript, and the colours.

**A hero over every page, and the page is a card over it.** The app opens on its map and
the parish sheet slides up over it; a shared link opens on a page, so something has to
stand where the map would. That is `public/og/hero.jpg`: the site's navy and every parish
on file as a point of light at its own latitude and longitude, on a faint outline of
Australia and New Zealand — Sydney and Melbourne glow where they are dense, Perth and
Auckland sit out on their own. `scripts/build-hero.mjs` draws it from the live
`/api/parishes` (re-run it after an import) and Natural Earth's land. Over it, as the
page's own text (`heroHTML`): "orthodoxy.au", small in the lower-left corner on the card's
left edge (it had a cross beside it, centred on the left, until October 2026), and
**VIEW MAP** in the middle — see the way into the app, below. It is
shown at its full height and centred, never cropped to a band — its edges are the
background's navy, so a wide screen gets plain navy either side. The content is a card
that overlaps its foot (`--hero-overlap`), rounded at the top, and behaves as the app's
parish card does: its header (the parish's, or a timetable page's title) sticks to the top
as the page scrolls, and the ✕ — sticky itself — stays on its corner. `lite.js` measures
the header into `--ps-stack-h`, as the app does, so the day headers stop under it. The
styles are app.css's `.lite-hero`, which page mode wears too, with the sheet's ✕ moved
onto the card (`placePageChrome`).

**The way into the app.** Three doors, and the app is fetched only once one is used:

| | Goes to | |
|---|---|---|
| **VIEW MAP** on the hero | this page's link in the app, `?app` | a parish or event opens its sheet over the map, flown to its pin (`appHref`); a timetable page opens the map with its filters, without `/services` (`eventsHref`) |
| the ✕, the hero's name, anywhere else on the hero | `/` | the app as it opens with no link: no filters |
| **Open in the app →**, **View upcoming events →**, the no-times count | their `?app` links | as before |

`lite.js` catches the click (a plain one: a modified or middle click is left to the
browser, for a new tab), puts up the app's own loading screen over the page at once —
`#loading-screen`, which `/app.css` already styles, with the eucalyptus index.html last
drew (`ls-tree-svg` in localStorage; with none kept it fetches one and keeps it, so the
app most likely draws the same) — then navigates in the same tab two frames later.
index.html paints the same screen first thing, so the screen carries on across the load.
A page restored by Back (`pageshow` with `persisted`) takes the screen down. Without
JavaScript the ✕, the name and VIEW MAP are plain links; the rest of the hero does nothing.

The page used to prefetch `app.js`, `app.css` and MapLibre on idle, so the way back was
quick. It no longer does: most people sent a link read it and leave, and `app.js` and MapLibre
are 1.3 MB (some 360 KB compressed) they would never use.

VIEW MAP is glass where the browser has `backdrop-filter` — the lights come through it
blurred, brightened and more saturated, under a lit top edge and a sheen — and a plain
see-through pill where it has not, or where the viewer asks for reduced transparency.
The styles are app.css's `.lite-hero-map`.

**Its colours are the app's.** `/admin`'s overrides (`jurisdiction_colors`) over the
shared table — the jurisdiction's, for the parish and its timetable box alike, since a
parish has no colour of its own — and the app's OKLab dark-mode lift — now in
`public/shared/jurisdiction-colors.js` (`liftForDark`) so the Worker can compute it. A
cached page cannot choose at render time, so it carries both as custom properties and a
`prefers-color-scheme` query picks.

## Timetable pages: a link that names no single parish

`/greek/qld`, `/liturgy`, `/wed/evening`, `/en`, `/smg+sgr`, `/services` — the
aggregated schedules, which are the way into everything else Agora does. Before these
pages every such link booted the app, map first, to show what is really a list.

`worker/lib/lite-timetable.mjs`, pure like the card:

- **Rules, not occurrences.** What each parish does week by week, so there is no
  projection and 293 parishes cost two D1 reads (parishes, active rules). A link with a
  date ("what is on next Sunday") is a list of dates, and goes to the app for now.
- **Which parishes and rules a link means is `public/shared/timetable.js`** — the same
  module the app's Schedules view (`renderServices`) filters with, so the page and the
  app cannot list different services for one link. A `parish_scoped` rule stays on its
  own card (docs/editing.md); an ended rule is off, one that starts later is marked
  "from".
- **Grouped by state, then jurisdiction, alphabetical all the way down.** Australian
  states first (by address — `locations.js` says why), then other countries by pin. A
  page already narrowed to one jurisdiction drops the jurisdiction headings.
- **Parishes with no times are a count under the timetable** (253 of 293 in October
  2026). It opens the app's Schedules view with the same filters and `#no-times`, where
  `noTimesHTML` lists them by name and the app scrolls to them once. "No times" means
  no rules at all, not none matching: under `/liturgy` a parish with only Vespers has
  times.
- **Not under a link that asks something of the rules** — a service, a day, a part
  of the day, a language (`narrowsRules` in `timetable.js`): neither the count here
  nor the app's list. Nothing on file is not "no Bible study". It was counted until
  October 2026, and `/antiochian/bible-study` read "4 parishes with times … 1 parish
  without service times on file": Howick's mission in Auckland, the one Antiochian
  parish with no rules, while the 19 with rules but no Bible study fell out at
  `ruleMatches` uncounted. The model still counts them, for the empty page's "None of
  these parishes has its service times on file yet."
- **Landing there must not leave the list dim.** The Schedules view fades its list
  while the map moves (`markEventsPending` on `movestart`) and releases it in the
  move's list phase (`onViewportListPhase`). The link lands mid-fit, and `#no-times`
  snaps the sheet to full; the list phase skips a snap's moves, and it used to skip
  the fit's too, so the view sat at a third of its brightness until the next move.
  It also never released after `renderServices`, so any pan that changed the
  parishes in view did the same. A list phase now releases whatever a real move
  marked.
- **View upcoming events →** opens the app's dated feed with the same filters.
- The canonical is the link's filters in the app's order, without `/services` — the
  page *is* the timetable — except bare `/services`, which keeps it.
- **Two languages, many spellings.** `/en`, `/english`, `/bilingual`, `/half-english`,
  `/english-half` and `/some-english` are *English services* — any service with English
  in it, alone or beside another language. `/en-only`, `/english-only` and
  `/full-english` are *fully-English services* — English and nothing else. The
  spellings live in `public/shared/slugs.js` (an acronym may not take one); a link
  writes, and a canonical names, only `/en` and `/en-only`. Any other language is
  `/in-greek`, or `/in-greek-only` for nothing but Greek, and its heading says
  "Greek-only". In the app the button reads "Any language", then the language, with
  an up-and-down segment that opens the languages on file and an "only" beside it.

## Caching

`cachedHtml` (beside `cachedJson` in `worker/lib/data-version.mjs`): the edge copy is
keyed by data version + path + UTC hour, with an ETag and `no-cache`. An admin write
moves the version, so an edit shows on the next load; the hour bounds how long "today"
can be stale. Repeat fetches by crawlers and chat apps never reach D1.

## Previews

`og:image` is the pinned event's poster, else the parish logo, else
`public/og/<jurisdiction>.jpg` — branded cards rendered once by
`scripts/build-og-images.mjs` (Playwright) and committed. JPEG because the gradient made
PNGs ~300 KB, where chat previews start dropping images.

Not done yet, pending a real WhatsApp send: a small JPEG preview variant for posters
(the Crows Nest flyer is a 986 KB PNG). If WhatsApp shows it, nothing is needed.

## Search

Only the parish pages are for indexing: `index,follow` + self-canonical on
`/<acronym>`, and `/sitemap.xml` lists them. Everything else — event pages, date, day
and service variants, and every timetable page — is `noindex,follow`; the variants are
an infinite URL space. The timetable pages are the likeliest to rank ("Greek Orthodox
service times Queensland"), and the next step is to index jurisdiction and
jurisdiction × state pages that have enough parishes with times, and list them in the
sitemap — once Search Console shows more than the home page, and not while
`/macedonian` would be an empty page.
`public/robots.txt` points at the sitemap. The owner verifies orthodoxy.au in Google
Search Console and submits the sitemap.

**Why events are not indexed yet.** Of 76 stored one-offs in production (September
2026), 68 were Good Shepherd's Google Calendar republishing its weekly Vespers,
Confession, Matins and Liturgy as single events, and posters sit on routine Sundays too
(the Crows Nest bulletin) — so neither "stored" nor "has a poster" means special. The
rule tried: *a one-off whose title does not recur at that parish within 8 weeks, or of
type feast/talk/social/youth*. It picked 11 — the Crows Nest feasts, the Conception of
St John the Baptist, a talk, the Entrance Vesperal Liturgy, St John Chrysostom Vespers,
an AGM — and two that should never be search results: a "Marriage blessing" (a private
rite) and "NATIVITY FAST" (an all-day marker). Doing it properly wants that rule, a
private-rite stoplist (wedding, marriage, baptism, funeral, memorial, trisagion) and an
admin in/out override (a nullable column on `events` and on `schedule_overrides`).
Revisit with Search Console data.

## Costs and limits

- Every page view now invokes the Worker once (Workers Free: 100k requests/day).
- An uncached render is a handful of D1 reads for one parish and a projection over
  eight weeks — estimated at a few ms of CPU against the 10 ms limit. Measure it in
  Workers Observability after a deploy rather than trusting the estimate.
- Chat apps cache previews for a long time; Facebook's Sharing Debugger can refresh
  one, WhatsApp cannot.
