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
Claude Haiku 4.5 into draft events (docs/editing.md). What remains is the
bulletin's other half — a changed Sunday as an override of its rule rather
than a one-off — and the WhatsApp door below.

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

## Owner to-dos (not code)

- Switch Cloudflare Access to "Everyone + One-time PIN" so People is the only
  list — docs/people-and-access.md, after checking People has your own row.
- Google Places: if the Maps search still refuses, the message now quotes
  Google's reason and says where to fix it — usually the key's API restrictions.
- Search Console: export Performance in late October and add it to
  `docs/search-console.md`.
- Workers Observability: check CPU per request for the lite pages.
