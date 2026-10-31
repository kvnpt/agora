# Editing: occurrences, series, posters, combines

What the editing controls do to the data, and the bugs that shaped them. Split out of CLAUDE.md, which keeps the rules that bite and links here for the reasons.

**Nothing disappears.** Every occurrence in a window emits exactly one instance. A
cancellation is a *tombstone* that still renders, so someone who would otherwise turn up
at church sees "CANCELLED" rather than the service silently vanishing.

A corollary that cost a bug: editing a field on an occurrence **keeps whatever
that occurrence already is**. `applyAdminEdit` used to set `kind='modified'` for
any edit naming a display field, so correcting the title of a cancelled service
— or putting a poster on it — dropped the tombstone and put the service back on
the feed. Reviving is `status: 'approved'` and nothing else should do it.

**A repeating service is asked the calendar question.** Cancel and Save on a
projected occurrence ask "only this date, or this and every following one",
because the pilot's admins opened one Sunday and looked for the series there.
"Following" never edits the rule in place — that would rewrite every past
Sunday — it uses the rule's own `effective_from`/`effective_to`
(`POST /api/admin/events/:id/following`, `worker/lib/series.mjs`):

- **End** sets `effective_to` to the day before. Later dates are not
  tombstones — a service that has stopped is not "cancelled" every week
  forever — which is the one deliberate exception to *nothing disappears*, so
  the timetable says "until 5 Oct" in advance and the confirm points at Break
  for a pause. Clearing the end date brings the rule and its overrides back.
- **Split** closes the old rule the day before and opens a new one on the
  day. Overrides and breaks on later dates hang off the OLD rule and would
  silently stop showing, so the route answers 409 with the list and the panel
  asks: keep them on the new rule (those whose date it still produces) or
  discard them.

The bundle carries a rule that starts after its window ("from 1 Nov" is how a
new or seasonal service is announced) and drops one that has ended. The
importers pair a scraped rule with the current row of a slot before an ended
one, and never write an end date, so an ended rule is not revived by a re-read.

At the foot of the **Add schedule** dialog, rules that have ended are listed
under **Ended services** with **Bring back**, which clears the end date — the
service somebody is about to type may be the one that ended. The bundle does
not carry them (it drops a rule that ended before its window), so they are
fetched from `GET /api/admin/schedules?parish=` when the dialog opens.

**A poster belongs to an occurrence — or, for something held every week, to
its rule.** `events.poster_path` is the last working piece of the WhatsApp
ingestor and is still rendered on feasts, talks, socials and youth events. A
weekly Liturgy has no flyer, but a weekly choir practice does: "Church Choir
Practice, 7pm every Tuesday, led by Simon Yazbek, all are welcome" describes the
RULE, and put on one date it was gone by the next. So a rule may carry its own
`poster_path` and `description` (migration 021), which every occurrence shows
unless its own override says otherwise (`project.mjs`: the date's
`patch_poster_path`, else the rule's). An occurrence edit compares against the
rule's, so saving a date with the inherited text writes nothing, and the
occurrence's poster control says when what it shows is the rule's and sends
changes to the series. The rule's poster is set from its form (the pencil on
its row) or "Put it on: every … — the service's own" on any of its dates, via
`POST|DELETE /api/admin/schedules/:id/poster`, and `releaseUnused` counts it.
`POST /api/admin/events/:id/poster` takes both id shapes and routes on the
shape, like every other event route.

What a parish sends is a bulletin for a **period**, so the same route takes
`?scope=rule|parish&from=&until=` and points every occurrence in the range — of
that rule, or of every rule at the parish plus its one-offs — at **one** object
under a key of its own (`worker/lib/poster-range.mjs`). A bulletin is never
the rule's own poster: next month's Liturgy must not carry this month's
commemorations. A range skips
a date a break silences (an override beats a break, so writing one there would
bring the service back) and a hidden one, and keeps every other occurrence what
it is. An object is deleted only once no event, no override and no draft names it, so
taking a bulletin off one Sunday leaves the others; `DELETE …/poster?everywhere`
takes it off the whole parish.

**Combine is three mechanisms** — "Include other parishes…" on an event's
pencil — routed by the shape of the target id
(`POST /api/admin/events/:id/escalate`, and `POST /api/admin/events`, which
takes the same two lists so a one-off entered *because* it replaces something
never exists for a round trip beside the thing it replaces):

| Capability | Mechanism | Target id |
|---|---|---|
| One event under several parishes | `event_parishes` | parish ids |
| Replace a stored one-off | `event_replaces` + `status='replaced'` | integer |
| Replace a schedule occurrence | `schedule_overrides` kind `combined` | `"sid:date"` |

`event_replaces` is described as legacy in old comments. It is pre-v26 but **not**
redundant: it is the only path for combining against a stored one-off.

**Shown at a parish that is only taking part**, a combined event is framed in the
Combined badge's colour (`--combined-fg` / `--combined-bg`) in the app v3
replaced, so it does not read as that parish's own; in v3 its row there names the
host, with its logo (`eventRow`), as any other parish's event does. At its venue — the
parish whose church it is in, the host's own when it is held at home — it is not.
Its participating parishes are a button of their logos ("+ ◯◯◯", up to eight, then
an ellipsis), and the list it opens names the venue as such.

A combine is the one write whose target is **not** the parish in the URL, which
makes it the one a parish contact can use to reach out of their own scope. So
it is scoped per target, and the refusal is not a dead end: the same request
with `propose` set applies the half that IS theirs and files the rest as an
`event.combine` row in `admin_proposals` — their parish's side of a deanery
liturgy should not wait on an owner, and the other parish's side should not
happen because somebody ticked a box. The ask carries the **whole** desired
state, because `writeCombine` is a target state and removes what it is not
told; a payload holding only the refused half would strip the applied half on
approval.

**Signed in is not the same as editing.** A card reads as a visitor's for
everybody; what may be changed opens behind its own control, for whoever has the
capability at that parish, and a form is built when its control is pressed — never
in the DOM behind `display:none` (`public/next/editing.js`). The parish's DETAILS
open from a pencil on the card's **Details** heading (`editDetails`, for
`parish.edit`): the logo (with the app's cropper), the names and jurisdiction, then
each line of Details as its field (phone, website, email, address), the pin
(Locate, or Move on a map of its own, which every venue's "Move the pin" uses too),
the Google Maps place its Google Maps button opens, languages, the short link, the live
stream, the links (their own dialog), and where the parish is read from. The short
link is an owner's (`parish.acronym`); anybody else sees it with **Ask an owner to
change it**, which files the same ask /admin's does. Delete parish is at the foot of
the form, for `parish.delete`.

The TIMETABLE has no mode: for whoever may change it, each line carries a small
pencil at its right edge, always there, that opens its rule's form (`editLine`; a
line that is several rules offers all its days together first, or one of them), and the dotted **Add +** under it opens **Add
schedule** (`addService`, for `schedule.create`) — every field a rule has, the
poster included (times from quarter-hours or typed, `public/shared/time-field.js`,
and dates from a month grid, never the system pickers). The line itself still
focuses the rule, for an admin as for anybody. The app v3 replaced had a mode,
entered from a pencil in the head, and the owner found the step in the way: nobody
opens a parish's timetable meaning to read it as an admin.

**A new parish is finished on its card.** /admin's **New parish** asks only
what the row needs to exist — the names, the short link, the jurisdiction, the
time zone, the pin — and on Add goes to the parish's card with its details
open (`agora-edit-parish` in `sessionStorage`, read once on load), where
the logo, the buttons, the links and the Maps place are. The short link is
suggested from the names as they are typed (`POST
/api/admin/acronym-suggestion`, `worker/lib/acronym-suggest.mjs`: Claude Haiku
with the site's own acronyms as its examples, or the initials rule — "St George,
Yellow Rock" → `sgy` — without a key), and only ever fills an empty field or
one still holding its own suggestion; the details dialog does the same for a
parish with none, for whoever may set one. Every candidate passes the checks a
save does, so what fills the field can be saved. The parish is added kept by
hand (docs/sources-and-ingestion.md).

**Forms open over the page, never inside it.** Every edit — a parish's details,
a rule, a new rule, an event — is a dialog, because a form spread through the
timetable or under a card pushed what it was editing off the screen on a phone,
and the save landed somewhere the person could no longer see. Each is a dialog
over the page (`frame` in `public/next/editing.js`), and the dialogs a form
opens in turn (Combine, Break, "which dates", the logo editor) stack above it.
Saving closes it, the page re-reads the bundle fresh and repaints what is open.

**Google Maps** opens the parish's place there — `parishes.maps_url` when
somebody picked its Maps entry (a Places search through `POST
/api/admin/places`, or a pasted link) — and its pin otherwise: the place,
never a route to it (October 2026, the owner's ruling; it was Directions to
`/maps/dir/` before). An event's opens its own pin, or its venue's.

**Three different things are called "hide", and only one of them hides an
event.** Worth knowing before reaching for one:

| | Where | What it does |
|---|---|---|
| `status='hidden'`, override `kind='hidden'` | the row, or the override | Drops it from the feed entirely. **Not a tombstone** — no card, no "CANCELLED", gone |
| `hide_live` | `events`/`schedules`, patchable per occurrence | Nothing to do with hiding. Suppresses the **Watch Live** badge for that one service |
| `parish_scoped` | same | **Parish only**: on its parish's card, a list or link naming the parish, and for whoever starred it; off the feed for everyone else |

**Parish only is for the parish's own people** (Kevin, 30 Oct 2026). A rule's or
an event's form has a pill at the end of Kind's line, on and reading *Public*,
tapped off to *Parish only*; so do the Add event card and each regular service a
sign or a flyer proposes there. A Parish only row shows where its parish is named:
its own card, a list of parishes holding it (Favourites, a list somebody made,
`/sgr+snb`); and to whoever has starred the parish it is as if it were public,
everywhere: Today, the feed, What's on, search, every collection's timetables.
Anybody else does not see it outside the parish's card. One test decides it:
`scopedOpen` in `public/next/next.js`. The Worker's painted cards know no stars,
so they keep only the naming half: `ruleMatches` (timetable.js),
`collectionCardHTML` (page-card.mjs) and `collectionFeed` (lite-page.mjs).

**"Other" is Parish only until somebody says otherwise.** A council meeting or a
working bee is the parish's own business, so picking Other in a rule's or an
event's form turns the pill to *Parish only*, and `createOneOff` stores an Other
with no `parish_scoped` in the body as parish-scoped. Tap it back to Public and
it is in the feed like anything else; the pill is the decision, the default
only a guess. On the Add event card the pill is `draft_events.parish_scoped`
(migration 031): NULL until somebody taps it or picks Other, when Publish leaves
it to `createOneOff`'s default; a card published onto an occurrence starts from
its rule's. A proposed regular service carries it in `read_services` and is
added with it, an untapped Other as Parish only, as the rule form would.

`filterByStatus` in `merge.mjs` passes `approved`, `cancelled` and `combined` —
the last two still render, as tombstones, because nothing disappears.
`hidden` is the deliberate exception and is for something that should never
have been published: a duplicate, a mistake. It is **not** for a service that is
not running. `DELETE` on a projected occurrence writes a `hidden` override, not
a delete; the rule and the other weeks survive.

**Cancel and Suppress are confirmed, because they look like neighbours and
behave nothing alike.** A cancellation stays on the feed as a tombstone so
somebody who would have turned up sees it is off; a suppression takes the
service off the site with no notice at all. Reaching for the wrong one sends
somebody to a locked church, so each says which it is before it does it.

An event card's pencil (**Edit** beside its Parish button, and again on its
floating toolbar beside the bookmark, for whoever may edit the event; a
visitor's card has Suggest an edit at its foot instead) opens the same toolkit and fields
(`editEvent`, `public/next/editing.js`), and Suppress and Delete each offer
Cancel instead. A date of a service also takes its **Commemoration** (the saint,
as `patch_feast`), and its card follows the date onto the new rule after
"this and every following". A cancelled, combined or on-break date stays on its
parish's Coming up, struck through with its word; the open feeds leave all three
out for now, where the app v3 replaced showed a break.
**Break…** (a date of a service) and **Include other parishes…** (a one-off)
open their own dialogs in place of the form. The combine is the add-event
editor's lists (nearest first, "needs an owner"), so a tick that is not the
person's own becomes an ask, as it does there. A timetable line on a break
today says when it is back, and a combined date's card names what is in its
place.

The dotted **Add +** under a card's Coming up alters nothing the card is
showing — it makes a one-off that is not there yet — and what it is gated on is
the capability, per parish: `may('event.edit', pid)` in `next.js` asks the two
questions the Worker asks, in the order it asks them, from the whole
`/api/admin/ping` answer, so a button that is there and a route that refuses
cannot disagree. An owner and an editor get the editor on every card; a parish
contact on their own parishes only; anybody else gets **Suggest**, the same box.

**Adding an event is a draft until Publish.** The add-event editor
(`public/shared/event-editor.js`) is one component with two hosts — **Events** in
/admin, and the dotted **Add +** under a card's Coming up for whoever may add one
there (`public/next/editing.js`) — because the app's old dialog was its own and
/admin had none, and two forms would drift. It saves every
card a moment after the typing stops into `drafts` / `draft_events`
(`worker/lib/drafts.mjs`), so closing it loses nothing and **Save draft** is
just closing it. A draft is made by the first thing typed or by a dropped
poster, never by opening the editor. It is the parish's, not the person's:
anybody who may edit that parish can continue or discard it.

Why tables of their own, and not a status on `events`: that CHECK would need a
rebuild, and every reader of `events` — the bundle, the painted cards, the
candidates list, reconcile — would have to learn to skip a row that is not real
yet. A table nothing public reads cannot leak a half-typed event. Not an
`admin_proposals` row either: that is an ask an owner decides. Draft writes do
not move the public data version for the same reason (`isDataWrite`);
publishing does.

**A draft holds the parish's LOCAL wall clock**, like a rule — the form as the
person sees it. Publishing converts it with the parish's zone
(`localSpanToUtc` in `public/shared/tz.mjs`, which also holds the rule that an
end before the start is the next morning), so a published one-off still stores
UTC.

**Publish is one card per request** (`POST /api/admin/draft-events/:id/publish`),
through `createOneOff` — the same code as `POST /api/admin/events` — with the
combine and the ask exactly as the old dialog sent them. Workers Free allows
fifty subrequests a request, D1 queries among them, and a combine costs several
per target, so a poster of eight events in one call could run out halfway. The
editor publishes the cards in order; one refused for scope stays a draft with
the ask open while the rest go ahead. **Every card carries "also appears at" and
"replaces"**, because an event entered because it replaces the 9am liturgy
should never exist for a round trip beside it.

**A poster is read into the draft, never into the feed.** Dropped, pasted or
chosen, the image is shrunk in the browser to 2048px, stored once in R2 under a
key of its own (one object for every event published from it, like a bulletin
range), and read by Claude Haiku 4.5 (`worker/lib/poster-read.mjs`). The read
streams back as Server-Sent Events and the cards fill as it is written; a
poster with several events becomes several cards, each collapsed to its row as
the feed will draw it (time and day, the kind's roundel, title, subtitle) so
they can be checked at a glance. A collapsed card still shows what needs a
person (`refreshPeek`): a one-off service's first two languages, to tap, and
every field its checks stop or doubt — a missing time, a date the poster's
weekday disagrees with — answered right there without opening it.
**The read fills only empty fields** — in the
editor and again when the Worker merges it — so nothing a person typed, before
the drop or during the read, is overwritten. It runs under `waitUntil`, so
closing the dialog mid-read still leaves the cards filled next time. Without
`ANTHROPIC_API_KEY` the poster is still stored and attached and the fields are
typed by hand.

The same reader fills in **Suggest edits** for somebody with no role who adds a
suggested event's poster (docs/people-and-access.md). That is a message, not a
draft: nothing is written but the suggestion, and **Start a draft** from it
opens this editor with the poster attached, to read again or publish with.

The review is the editor: a model read the date off a photograph, and a misread
7:30 sends somebody to a locked church. Each field the read filled says **from
poster** until a person edits it (kept in `read_fields`, so a draft continued
tomorrow still shows what nobody has looked at), the model's own doubts sit
under their field, and one shared checker (`public/shared/event-checks.js`)
says what is worth a look — above all a printed weekday that disagrees with the
date, which is how a misread date usually shows itself. Missing title, date or
start time blocks Publish; the Worker runs the same checker before it writes.

**A draft can change parish until it is published.** The editor's first row is
a **Parish** picker — the parishes this person may publish at, by name — in both
hosts; /admin's own select, which fixed the parish once a draft existed, is
gone. It exists because of the usual mistake: St Elias, Wollongong's youth night
dropped while another parish's sheet was open, read perfectly, and then
uncorrectable except by discarding it. So the reader answers **whose poster it
is** in a field of its own (`other_parish`, the name and suburb as printed, only
when it is not the parish the draft is at), the Worker matches that to a parish
on file (`matchParish` in `worker/lib/parish-match.mjs` — the dedication and the
suburb, with a venue's street address as a third witness, and nothing at all on
a tie, because "St Nicholas" alone is twenty parishes) and keeps it on the draft
(`drafts.read_parish`). The editor then says *This poster looks like it is from
St Elias, Wollongong* with **Move it there** — or, when it is not one of this
person's parishes, says whose it is and offers nothing; or names it as printed
when no parish clearly matches. Nothing moves a draft but a person.

Moving is `PATCH /api/admin/drafts/:id {parish_id}`, scoped on **both** parishes
— a contact moves drafts between their own and nowhere else — and refused while
the poster is still being read (409). The cards go as they are, less two things
that only made sense where they were (`moveDraft`): the new parish in "also
appears at", and a venue the read gave that is **only the new parish's own
address** — St Elias's address was rightly "elsewhere" from the parish the poster
was dropped at, and is just the church once the draft is St Elias's. A venue
somebody typed, or one naming a room at that address ("Parish hall, 86 Kenny
St"), stays. The same test (`isOwnVenue`) runs on every read, because the reader
gives a parish its own address as a venue even when told not to, and the card
then reads as if the event were somewhere else. In the editor, "replaces" starts
again for the new parish, and a tick on a service the list no longer shows is
dropped rather than left to combine invisibly on Publish.

**A programme's Sundays are the Sundays on file.** A month's programme — St
Athanasios, Rookwood prints one in Greek, every Saturday and Sunday of October
with that day's saint — is not nine events: each line is a service the
timetable already projects, on its own date. Published as one-offs they would
be nine cards beside nine cards, the duplicate the combine exists to stop. So
when the Worker reads an image it matches each dated event to an occurrence of
the parish's rules (`matchOccurrences` in `worker/lib/drafts.mjs`): the rule
that runs that day at that time, or else the one occurrence that day with the
same service name (a programme that moves it) — never a guess between two. A
matched card keeps `occurrence` ("sid:date") and the day's `feast`, takes the
rule's own title and kind (so "and" for "&" is not an override), and publishes
**onto** that occurrence through `applyAdminEdit`, with the poster as its
`patch_poster_path`: the saint becomes the "✛" line under the service, which is
what `patch_feast` is for — not a new title, because the service is still the
Liturgy. The usual rules hold: the occurrence keeps what it already is (a
cancelled Sunday that the programme gives a saint stays cancelled), and a field
the card leaves empty is not "clear it" — a note somebody put on that Sunday
survives (`occurrenceBody`). The card says which service it changes where the
combine would be, and **Make it a separate event instead** unlinks it; so does
changing its date, and so does moving the draft, since the rule was the old
parish's. Publish checks the link again — the date is still the occurrence's
and the rule still the parish's — and refuses otherwise.

**A subtitle is the line under the title** — the field is `feast` everywhere,
for history, and the forms call it Subtitle. It is the saint or feast of the
day, or a talk's topic: "Matins and Divine Liturgy" over "Holy Protection of
the Theotokos", "Men's Group" over "St Joseph the Betrothed". A date of a rule
has it as `patch_feast`; a one-off as `events.feast`, and a rule as
`schedules.feast`, every date showing the rule's unless it has its own
(migration 030, `project.mjs`). Until 030 a one-off had no such column, so
publishing glued the two into one title with an em dash; `oneOffFeast` now
writes it where it belongs, and leaves it out when the title already says it
("Feast of St Nicholas"). A "this and every following" edit keeps the drawer's
subtitle on its own date (`alignAnchor`): one Sunday's saint is no rule's
subtitle, and the rule's own is edited behind the timetable's pencil.

**A sign is read into the timetable, not into events.** The board out the front
gives a parish's weekly services and its details. The reader calls that image a
`timetable` and returns `services` (day, times, weeks of the month, languages)
and `details` (address, phone, email, website), which the draft keeps as
`read_services` / `read_details` — proposals, which nothing public reads. The
editor sets each beside what is on file (`public/shared/signs.js`): a service
already there says so (and offers what the sign adds that the rule leaves
empty — an end time, its languages); one on file for other weeks of the month
offers to correct the weeks rather than add a second rule on top; a new one is
**Add to timetable**, after the person has opened it and checked it against the
photo. The services on file that the sign does not mention are listed and
nothing is offered for them: a sign lists Sundays and leaves out the weekday
Vespers more often than the Vespers have stopped. A sign that agrees with the
timetable can still mark it checked. Details fill an empty field or, where they
differ, offer **Use the sign's**; an address is changed in the parish's details,
where the pin moves with it.

The timetable has its own way in: **Add schedule** (the dotted **Add +**
under the service times) opens a dialog with **Add an image** (a photo of the sign) above
the fields for typing a service. The fields are `public/shared/rule-form.js`,
and the pencil is on each line of the grouped timetable.

A rule is one weekday, but the form's **Days** are ticked, with **Every day**
and **Mon–Fri** beside them: Compline every night was seven forms until 26 Oct
2026. Add sends them as `days`, and the route writes a rule for each (skipping
any already there). A line that is several rules ("Tue, Wed 6pm Vespers")
offers **All N days together** first, which is one form for every rule of it
(`editRules`): Save sends each rule only the fields that changed, so one day's
own description or poster stays; a day ticked is a new rule, a day moved to
another moves its rule, and a day unticked is asked about and then ended the
day before today (deleted, if it had not started), so it waits under Ended
services. Ticking it again later adds a fresh rule for the day (Bring back
instead revives the old one, with what its later dates held). One day of the line can still be picked and edited on its own.

**Add an image** (a photo of the sign) is the add-event editor and the same read, opened expecting a timetable (`intent:
'timetable'`): its empty event card stays out of the way and the dialog says
"Add to the timetable". A photo that turns out not to be a sign is **caught**
rather than trusted — a poster for a one-off, or a month's programme, says so in
words ("This looks like a poster for an event, not the parish's timetable, so
nothing has been added to the timetable") and its events wait below as the
draft they are, to publish or discard. Nothing from a photo reaches the
timetable but a service a person adds from the review.

**Two categories, whatever the image is.** Everything a photo announces is a
REGULAR SERVICE — held on a weekday every week or on some weeks of the month,
perhaps only for a period — which goes on the timetable, or a ONE-OFF EVENT —
on a date, or a run of dates — which goes in the feed; and a regular service's
dated change (a saint, a new time, a cancellation) is an override, read as a
dated entry and matched to its occurrence. The reader returns both lists for
any image (`services`, `events`); its `kind` only says what the image IS:
`timetable` (the sign out the front), `poster`, or `not_an_event`. It was five
kinds of poster, and St John the Baptist, Croydon Park's "Church Choir Practice,
7:00 pm every Tuesday" fitted none — read as one event with no date, which
nobody could publish, and caught at the timetable as "a poster for an event".

**Regular means the image says it repeats.** For each service the reader gives
`every`, the words that say so ("every Tuesday", "Sundays", "2nd Wednesday of
the month"). A weekday beside a time does not: Archangel Michael, Crows Nest's
feast-day poster ("Sunday November 8 … Vespers 7pm Sat, Matins 7.30am Sun,
Divine Liturgy 9am Sun, Paniyiri 11am onwards") was read as that Sunday's
schedule and then offered as four weekly services. Now a poster's service with
no such words is dated from the poster's own occasion — its dated events, all
within a week — on the nearest day of its weekday (the Saturday before a
Sunday), and becomes an event with a note saying so. With no occasion to date
it from it stays a service, with a note that the poster does not say it is
weekly. A sign's services are regular by being on the sign.

**A person can move a card up to the timetable.** The reader still gets it
wrong the other way: St Paul, Dandenong's weekday posters (31 Oct 2026), each
headed only "Sunday", "Saturday" or "Thursday", gave Matins, the Liturgy and
Vespers as events on the coming Sunday and Saturday. A card read off a poster
has a **Convert to weekly** pill at the end of Date's label line, where the
date shows it is not a one-off (Kevin, 31 Oct 2026). It moves the card into
the services above on its date's weekday (or the one printed), open to
check, keeping its times, kind, words, languages, subtitle, place and Public /
Parish only; its date and the doubts about it stay behind
(`serviceFromCard`). Nothing is on the timetable until it is added from there,
with the poster, like any service the reader gave. Not offered on a
programme's date of a service on file, a run of days, a combine, or to someone
who cannot add to the timetable.

The kind decides one thing: how a regular service is added. A sign's name the
sign as the timetable's source ("Church signage"). A poster's carry the poster
as the rule's own and their description, with the period it gives (**From** /
**Until**: "every Friday in November"), and name no source — one flyer is not
where the rest of the timetable came from, and a timetable has one source line.
A service already on file is offered **Put this poster on it**. The editor
shows the services' review above the event cards, headed "Held regularly — for
the timetable", and the dialog is "Add from the poster" when there are both.

**One event can run over several days.** A card has **Multi-day** under its
times: ticked, a **Last day** appears, and the end time is the time it ends on
that day (`draft_events.end_date`, migration 022; `localSpanToUtc` takes it).
Without the tick an end earlier than the start is still "after midnight". The
reader gives `end_date` for one event over several days — a festival Friday to
Sunday is ONE entry — and never matches one to a Sunday's service. Published
it is only a later `end_utc`; the page calls an event multi-day when it ends on a
later day of the parish's calendar and lasts at least twelve hours, says its span
on the card ("Fri 13 Nov 6pm – Sun 15 Nov 4pm", painted and drawn alike),
and keeps it in the feed after its first day: the bundle and the projection
take a one-off whose `end_utc` reaches into the window, and Today puts one
that began earlier and is still running under **Happening now**. The app v3
replaced also listed it under every later day it covers (`multiDayContinuations`);
v3 does not yet. The edit dialog has the same Date / Starts / Ends / Multi-day /
Last day.

**A combined event says where it is.** At a parish other than its host — that
parish's card, the page filtered to it — its row names the host, with its logo
(`eventRow`), and its card says where it is held. The app v3 replaced wrote it
into the title instead ("Deanery Vespers @ St George, Redfern", `setCombinedContext`).

**Somewhere else is one of two places, picked, not typed.** A one-off, a rule
and one date of a rule each have a **Where** control (`public/shared/venue-picker.js`,
in every form that asks: a rule's form, Add schedule, an event's edit dialog,
the add-event editor's cards). **At the parish** is nothing set. **Another
parish** is one parish on file, picked from a list nearest-first and searched by
name or suburb, the way Combine picks them — `location_parish_id`, whose name,
address and pin it is. **Somewhere else** is the place in words
(`location_override`) and a pin (`location_lat`/`lng`): looked up from the
address through the parish form's own geocoder, or put on the door by hand with
the parish form's own pin mover. Typing new words drops a looked-up pin (it
described the old address) but never a hand-placed one.

The four fields are **one unit** everywhere (`worker/lib/venues.mjs`): naming
any part of a place writes all four, a parish venue keeps no words or pin of its
own, and naming the host itself is "at home". One date's override holds the
place as a unit too (`mergePatch`), and a date put back at the rule's own place
stores nothing. A date put back **at home under a rule held elsewhere** stores
the host's own id as its venue — "nothing named" would read as "where the rule
says" — and `placeOf` (`project.mjs`) reads that as its own church.

`events.lat`/`lng` stays the distance pin, and follows the place: the venue
parish's pin, the place's own, the words looked up when no pin came with them,
or the host's again once it is home. An event at another parish is **on at that
parish too**: `attachExtraParishes` lists the venue in `extra_parishes`, so it is
in the venue's sheet and its filters, and in `combined_parishes` only if a
combine put it there — the COMBINED badge and "@ host" read that one. Cards say
"@ St Nicholas, Bankstown" or "@ Antiochian Village" (the place's first words)
everywhere but the venue's own sheet; the drawer gives the name and address and
sends Google Maps to the venue's pin; a timetable row says "At St Nicholas,
Bankstown". On the map a place of its own is a **square** — see
[architecture.md](architecture.md).

**A poster shows at the row's right edge.** Collapsed, an event with a poster
has a thumbnail beside it and the row a little taller; open, the drawer shows it
full size. Everything but the liturgical services shows one (a feast's poster is
its own; a Sunday's is usually the month's bulletin).

Each of these is a write a person makes, through the route they would use by
hand (`POST /api/admin/schedules`, `PATCH …/schedules/:id`,
`PATCH …/parishes/:id`), so the first one at a parish still read from a source
asks whether to keep it by hand, as every hand edit does. They name their
source: **"Church signage"**, with the photo's `/posters/` path as the ref, and
since a timetable has one source line, that is the line — "Updated today ·
Church signage ↗", linking to the photo. The
sign's draft is then closed with **Done**; the photo stays, because
`releaseUnused` counts a rule's or a parish's source ref as using it.

**Reads are written in English.** Agora is read in English, so the reader
translates a Greek or Arabic poster's titles, saints and descriptions, and
gives saints the names English-speaking Orthodox use. The owner's call, made for
St Athanasios's Greek programme: the language of the land on the card, the
original one tap away, because every card published from a poster carries it.
The read records what it translated from (`drafts.read_language`) and the
editor says so beside the poster.

