# Roadmap

What to build next, in the order it pays. Each phase has a prompt to start a
fresh session with. Written October 2026, after the pilot with two admins began.

## Where things stand

The engine is done and well ahead of the content. Production has 293 parishes
and about 82 service rules, so most parish pages have no times. Everything a
parish contact needs now exists — in-place editing, a timetable mode with
"this and every following", breaks, bulletin posters over a date range, asks,
notices — and as of the claims work, so does the way in: **"Is this your
parish?"** on every parish sheet and lite card, approved by an owner under
**Asks** (docs/people-and-access.md).

So the next phases are about getting service times into the database, then
about keeping the code that renders them honest.

## 1. Bulletin ingest: an image to proposed changes

Many parishes publish one image a month (Crows Nest's bulletin is the worked
example in `docs/adapters.md`). Reading it by hand is the slowest step left.

**The first door is built:** the add-event editor reads a dropped poster with
Claude Haiku 4.5 into draft events (docs/editing.md). So is most of the
bulletin's other half: a programme's dated services are matched to their
occurrences and publish as overrides (the day's saint, a moved time, the
poster), and a photo of a church sign proposes the weekly services and the
parish's details, sourced "Church signage". What remains is a programme's
**cancellation** ("no Liturgy on the 25th") as a tombstone on that occurrence —
the reader has no field for it yet, and a false one keeps somebody from a
service that is running, so it wants its own confirm — and the WhatsApp door
below.

> *Build the bulletin ingest from docs/adapters.md ("Getting the next bulletin
> in without a VPS"). First door: an admin drops an image on a parish sheet; the
> Worker stores it in R2, asks Claude (vision) to read it against that parish's
> rules, and returns a reviewable batch — overrides (feast names, time changes,
> cancellations), one-offs, and a poster range covering the bulletin's dates.
> Approve or reject per row; nothing is written until approved. Second door,
> later: the WhatsApp webhook pointed at the Worker. Plan first.*

## 2. Tell people what happened to their claim

A claimant learns the outcome only by signing in again, and an owner learns of
a claim only from the red dot. Both want a message.

> *Send an email when a parish claim is filed (to the owners) and when it is
> decided (to the claimant), using Cloudflare Email Routing's send_email
> binding or MailChannels — whichever needs no stored credential. Keep the
> wording to one line and a link. Plan first; check what the account allows.*

## 3. One renderer for the parish card

`app.js` is about 10,000 lines that no test runs, and the lite card
(`worker/lib/lite-page.mjs`) and the app's parish sheet are two renderers of the
same thing that can drift.

> *Phase 3 of docs/lite-pages.md: move the parish card's rendering — header,
> timetable rows (with their until/from labels), event card, source line — into
> public/shared/ so the app and the lite card call the same functions, with node
> tests. No behaviour change; browser-check before and after.*

## 4. Small follow-ups

> *Small follow-ups, then PR and merge:*
> - *Rewrite VISION.md to match what Agora is now: Oceania, maintained by parish
>   contacts, ingested where possible.*
> - *A GET preview for POST /api/admin/events/:id/following, so the save dialog
>   asks about later changes without relying on a 409.*
> - *Show a parish contact's open claims and recent decisions on their own
>   account menu, not only on /admin.*

## 5. Once there is data

- **Event indexing.** When Search Console has a few weeks of queries
  (`docs/search-console.md` has the baseline), revisit
  indexing event pages: the rule, the private-rite stoplist and the admin
  in/out switch are in `docs/lite-pages.md`.
- **Which jurisdiction next.** Look at which parish pages get visits before
  choosing whose timetables to chase.

## 6. Lite pages as the landing, with the map inside them

After the phases above. The lite pages — a parish card, a timetable page — become
what anyone arriving at orthodoxy.au lands on, the home page included, and the map
becomes a live element inside them: a viewport at the top of the page rather than the
page itself. Today the home page is the app and the lite pages answer only shared
links (`docs/lite-pages.md`); this is where that ends up.

> *Make the lite pages the default landing, home page included, with the map as a live
> add-in element — a viewport at the top of the page, loaded after the page has
> painted. Keep the app for everything past the first screen. Plan first: what the
> home page's timetable shows with no filter, how the map loads without delaying first
> paint, and what returning users and admins land on.*

## If D1 reads spike again

On 10 October 2026 the account hit the Workers Free cap of 5 million D1 rows
read in a day (6.94M) and D1 refused reads until midnight UTC. The owner moved
to Workers Paid ($5/month, 25 billion rows a month), so this is no longer an
outage, only a cost — and these fixes are parked until it happens again.

What the numbers said: about 42,000 requests from France in 24 hours against a
few dozen real page views (Web Analytics, bots excluded), so a crawler, at about
165 rows a request. What it was walking: the link graph the lite and timetable
pages had just grown (PRs #75, #76) — every timetable row links a
`/<acronym>/<day>/<service>` card, every card links its events'
`/<id>:<date>` pages, and dates roll forward, so the URL space never ends. Pages
cache per URL and per hour, which a crawler visiting each URL once defeats, and
`noindex` stops indexing, not crawling.

> *D1 rows read are climbing again (docs/roadmap.md, "If D1 reads spike
> again"). First confirm the source in Security → Analytics (country, ASN, user
> agent, top paths). Then, in one PR:*
> - *`rel="nofollow"` on the variant links the lite pages write — event links,
>   timetable rows, `?app` — and a `robots.txt` Disallow for `/*:*` (event ids)
>   and `/*?app`;*
> - *the `/:slug/:link` and `/:slug/donate` routes in worker/index.mjs query D1
>   on EVERY two-segment path, before the page cache is checked: skip them for
>   paths url-state classifies as filters, and look parishes up by a stored,
>   indexed normalised acronym instead of scanning `lower(replace(acronym…))`;*
> - *build timetable pages from the cached `/api/bundle` body instead of D1;*
> - *if a single bot is the cause, a WAF rule or Bot Fight Mode first — no code.*

## Owner to-dos (not code)

- Switch Cloudflare Access to "Everyone + One-time PIN" so People is the only
  list — docs/people-and-access.md, after checking People has your own row.
- Google Places: if the Maps search still refuses, the message now quotes
  Google's reason and says where to fix it — usually the key's API restrictions.
- Search Console: export Performance in late October and add it to
  `docs/search-console.md`.
- Workers Observability: check CPU per request for the lite pages.
