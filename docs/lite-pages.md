# Shared links: the page, with its head and card

A link somebody sends — `/sgr`, `/sgr/next-tue`, `/sgr/wed/liturgy`, `/sgr/evening`,
`/sgr/timetables`, `/102`, `/42:2026-10-04`, `/en`, `/greek/qld` — is answered with the
page: v3, one page that reads its own address (`public/index.html`,
`public/next/next.js`). A chat app previewing the link and a search engine reading it run
no JavaScript, so the Worker writes what the link is into the page before it leaves —
its title, description, preview image, canonical URL, robots line and structured data —
and paints the card the link opens (the parish's, the event's, the collection's) into it.
A person sees that card at once, before the bundle has arrived; next.js takes its place
the moment it opens its own.

Until October 2026 these links were answered with **lite pages**: a separate
server-rendered card over a hero picture (`public/og/hero.jpg`), wearing the old app's
`/app.css`, with `?app` and an `agora_admin` cookie as ways past it into the app, and
**page mode** for an admin, the app laying its sheet out as that page so the editors
were there. v3 replaced both the app and the lite pages: every link gets the one page,
which edits in place for whoever may, so there is nothing to step past and no cookie to
read. The lite pages' models stayed (`lite-page.mjs`, `lite-timetable.mjs`); their
markup went.

## How a request finds it

1. **`run_worker_first = ["/*", …negations]`** in `wrangler.toml` sends every page path
   to the Worker. The negations keep static files off it, and they are the load-bearing
   part: `*` matches across `/` and negative rules are tested first, so they must name
   directories and **text** extensions only. An image extension (`!/*.png`) would send
   `/posters/x.png` to the asset router, which has no posters.
2. The API, the R2 proxy (`/tiles`, `/logos`, `/posters`) and the payment links
   (`/smg/donate`) match first. `/next/…`, where v3 was built, is sent to the same path
   without it, for good (`nextRedirect` in `worker/index.mjs`); so are the old service
   names (`renamedPath` in `url-state.js`).
3. `servePage` (`worker/routes/pages.mjs`) classifies the path with
   `public/shared/url-state.js` — **the same grammar the page parses with** — in
   `pageOf`: one parish (with any day / part of the day / service / date focus, and
   `/timetables`), a bare event id, a collection or any other filter link (a
   timetable), the home page, and anything else (`/2026-10-25`, `/donate`). A site path
   or a file is not a page and goes to the assets.
4. It fetches the page as deployed (`SHELL`, `/`, from `ASSETS`) and fills its marks: `<!--page:head-->…<!--/page:head-->` with the link's head
   (`worker/lib/page-head.mjs`), and `<!--page:card-->` inside `#sheets` with its card
   (`worker/lib/page-card.mjs`). `withPage` does both.
5. **It fails open.** A read that throws serves the page as deployed, whose own head is
   the home page's, noindex and with no canonical, so a failure never tells a search
   engine that one link is another. A parish or an event that is not there is a 404
   with the home page's words.

## What the head says

- **A parish** (`/sgr` and every focus on it): its name, its address and its next
  services as the description, its logo as the preview, its Church structured data
  (`churchJsonLd`). Indexable at its plain link alone; `/greek/sgr` and `/sgr/en` open
  the same card under the same canonical, and are not offered to a search engine.
- **An event** (`/102`, `/42:2026-10-04`): its title, when and where, its poster as the
  preview. Never indexed (below).
- **A filter link**: the timetable's heading (`timetableHeading`, whose words are
  `public/shared/link-words.js`, which the page's parishes in view read too), a collection
  indexable once its page lists somebody, every other mix noindex.
- **The home page**: the site's own words. **Anything else**: the home page's words,
  noindex.

The words come from the models: `liteMeta` for a parish or an event, `timetableMeta`
for a filter link. `page-head.mjs` writes them.

## The card painted in

`worker/lib/page-card.mjs`, pure (models in, markup out; covered by `node --test`).
The same sheet next.js draws, in the same class names (`public/next/next.css`), with
what a first paint needs: a parish's names and address, its buttons (Google Maps,
Website, the stream, Donate, its own links), its service times, what is coming up and
its details; an event's when and where, its poster and its description with its links
as links (`public/shared/linkify.js`); a collection's parishes and their times. Nothing
on it is a control that needs the page's script, except Close, which is a link home.
While it is up the page's scrim shows under it (`.ssr` in `next.css`), and next.js
replaces it with its own sheet (`pushSheet`) with no slide.

What the two cards read is shared: the timetable's lines are
`public/shared/timetable-lines.js`, the source lines `source-line.js`, a collection's
look `collections.js`. The markup is written twice, in `page-card.mjs` and `next.js`;
keep them saying the same thing.

**What a parish's or an event's card holds** is `worker/lib/lite-page.mjs`
(`liteModel`), pure:

- the occurrences come from `expandFrom` + `buildFeed`, the same functions `bundle.js`
  runs in the browser, over one parish's rows (`fetchWindowRows({ parishId })`);
- the pin follows the page's rules (`firstEventOnDay` in `url-state.js`): an id pins its
  event, a day pins only an event ON that day, a service, weekday or part of the day
  (`/sgr/evening`, split at 2pm on the parish's clock) pins the next of its kind; a
  synthetic id lists the other dates of the same rule;
- times in the parish's zone. An event over more than one day reads as its span ("Fri 13
  Nov 6pm – Sun 15 Nov 4pm"); one that only runs past midnight keeps its day ("Saturday
  14 Nov · 11pm–3am").

**Its colours are the page's.** `/admin`'s overrides (`jurisdiction_colors`) over the
shared table — the jurisdiction's, since a parish has no colour of its own — and the
OKLab dark-mode lift in `public/shared/jurisdiction-colors.js` (`liftForDark`).

## Timetables: a link that names no single parish

`/greek/qld`, `/liturgy`, `/wed/evening`, `/en`, `/smg+sgr`, `/timetables` — the
aggregated schedules. A collection among them (`/en`, `/greek`, `/sun/liturgy`, the list
in `public/shared/collections.js`) opens its card, painted from the model
(`collectionCardHTML`): the parishes, those with times first, each with its times,
folded to the first few lines until Show timetables (a checkbox in its label, so it
opens with no script); the page adds a Today box of theirs above the timetables and
what is coming up at them underneath. Any
other mix of filters is the page itself, filtered, and gets only its head.

`worker/lib/lite-timetable.mjs` (`timetableModel`), pure like the card's:

- **Rules, not occurrences.** What each parish does week by week, so there is no
  projection and 293 parishes cost two D1 reads (parishes, active rules). A link with a
  date ("what is on next Sunday") is a list of dates, and is left to the page.
- **Which parishes and rules a link means is `public/shared/timetable.js`** — the same
  module the page's collections ask, so the painted card and the page cannot list
  different services for one link. A `parish_scoped` rule stays on its own card
  (docs/editing.md); an ended rule is off, one that starts later is marked "from".
- **Grouped by state, then jurisdiction, alphabetical all the way down.** Australian
  states first (by address — `locations.js` says why), then other countries by pin.
- **A link that asks nothing of the rules lists every parish** (`/timetables`, `/greek`,
  `/qld`): one with no times on file is listed too, after those with times, as "No
  service times on file yet." "No times" means no rules at all, not none matching.
- **A link that asks something of the rules lists only those it found an answer at** —
  a service, a day, a part of the day, a language (`narrowsRules` in `timetable.js`).
  Nothing on file is not "no Bible study": until October 2026 `/antiochian/bible-study`
  read "4 parishes with times … 1 parish without service times on file", Howick's
  mission in Auckland, while the 19 with rules but no Bible study fell out uncounted.
  The model still counts them (`withoutTimes`), for the empty page's words.
- The canonical is the link's filters in the page's order, without `/timetables`,
  except bare `/timetables`, which keeps it; a collection's is its own link, however
  this one spelt it (`/liturgy/sun` is `/sun/liturgy`).
- **Two languages, many spellings.** `/en`, `/english`, `/bilingual`, `/half-english`,
  `/english-half` and `/some-english` are *English services* — any service with English
  in it, alone or beside another language. `/en-only`, `/english-only` and
  `/full-english` are *fully-English services* — English and nothing else. The
  spellings live in `public/shared/slugs.js` (an acronym may not take one); a link
  writes, and a canonical names, only `/en` and `/en-only`. Any other language is
  `/in-greek`, or `/in-greek-only` for nothing but Greek, and its heading says
  "Greek-only". The server and the page do not yet count `/en` alike: for a rule
  that names no language the server takes English anywhere in the parish's languages,
  the page only English first there or on a rule (`speaksEnglish` in `next.js`, since
  English is on nearly every parish's list). So `/en` paints more parishes than the
  page then draws (8 and 4 locally, October 2026); one of the two should give way.

## Caching

`cachedText` (beside `cachedJson` in `worker/lib/data-version.mjs`) keeps what D1 said
about a link — its head and its card, as JSON — at the edge, keyed by data version +
path + UTC hour. An admin write moves the version, so an edit shows on the next load;
the hour bounds how long "today" can be stale. Repeat fetches by crawlers and chat apps
never reach D1. The page around them is read from the assets on every request, so a
deploy is live at once; the finished page carries an ETag and `no-cache`. A head or
card whose markup a deploy changed can stay the old one for up to ten minutes (the
edge copy's life, `BODY_TTL`), or until the data moves. `/sitemap.xml` is `cachedHtml`, the same way.

## Previews

`og:image` is the pinned event's poster, else the parish logo, else
`public/og/<jurisdiction>.jpg` — branded cards rendered once by
`scripts/build-og-images.mjs` (Playwright) and committed. JPEG because the gradient made
PNGs ~300 KB, where chat previews start dropping images.

Not done yet, pending a real WhatsApp send: a small JPEG preview variant for posters
(the Crows Nest flyer is a 986 KB PNG). If WhatsApp shows it, nothing is needed.

## Search

The parish pages and the collections are for indexing: `index,follow` + self-canonical
on `/<acronym>`, and on each collection's own link — `/en`, `/sun/liturgy`,
`/greek`, `/in-arabic`, `/monasteries`, the list in `public/shared/collections.js` —
once its page lists somebody. `/sitemap.xml` lists both. A collection is what a link
*means*, so `/liturgy/sunday` is `/sun/liturgy` and canonicalises to it. Everything
else — event pages, date, day and service variants, a list picked by hand
(`/smg+sgr`), every other mix of filters (`/greek/qld`) — is `noindex,follow`; the
variants are an infinite URL space, and the collections are the ones somebody chose.
That was the owner's ruling for v3 (October 2026); before it, only the parish pages
were indexed, and the timetable pages waited on Search Console.

**Each collection previews with its own card**, `public/og/c-<id>.jpg`, drawn by
`scripts/build-og-images.mjs c-` in the colour of its card on the page's shelves. A
jurisdiction's is its card (`/og/greek.jpg`) until `/admin` has a logo for it
(Colours → Jurisdiction logos; table `jurisdiction_logos`, migration 027), and then
the logo, as a parish previews with its own — except an SVG, which no chat app draws.
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
