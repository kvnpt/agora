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
   exactly two shapes: one parish (with any day / part of the day / service / date
   focus, and `/services` for its timetable), or a bare event id. Everything else —
   `/services` with no parish among them — returns null and the app loads as it always
   did.
4. **It fails open.** A render that throws returns null and the app answers the link.

Two ways past it: `?app` (the card's "Open in the app" button) and the `agora_admin`
cookie, which the app sets while somebody holds a role so an admin lands where editing
lives. The cookie grants nothing — the API checks the Access token on every request.

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
- times in the parish's zone; nothing "now"-relative is baked in — `public/lite.js`
  marks "Now" and fades past services on the viewer's clock, settles relative dates in
  the address bar (`/next-tue` → `/2026-10-06`), and prefetches the app on idle.

The markup is NOT the app's sheet (app.js is a classic script the Worker cannot import),
so the two can drift in look. They share the lens, the grammar and the wording.

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
and service variants — is `noindex,follow`; the variants are an infinite URL space.
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
