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

In the timetable's edit mode, rules that have ended are listed under
**Ended services** with **Bring back**, which clears the end date. The bundle
does not carry them (it drops a rule that ended before its window), so they are
fetched from `GET /api/admin/schedules?parish=` when the mode is entered.

**A poster belongs to an occurrence, not to a rule.** `events.poster_path` is
the last working piece of the WhatsApp ingestor and is still rendered on feasts,
talks, socials and youth events. A rule has no poster — a weekly liturgy has no
flyer — so `schedule_overrides.patch_poster_path` is the only place a projected
instance can hold one, and it is the one `patch_*` where NULL means "there
isn't one" rather than "inherit". `POST /api/admin/events/:id/poster` takes both
id shapes and routes on the shape, like every other event route.

What a parish sends is a bulletin for a **period**, so the same route takes
`?scope=rule|parish&from=&until=` and points every occurrence in the range — of
that rule, or of every rule at the parish plus its one-offs — at **one** object
under a key of its own (`worker/lib/poster-range.mjs`). Still not the rule:
next month's Liturgy must not carry this month's commemorations. A range skips
a date a break silences (an override beats a break, so writing one there would
bring the service back) and a hidden one, and keeps every other occurrence what
it is. An object is deleted only once no event and no override names it, so
taking a bulletin off one Sunday leaves the others; `DELETE …/poster?everywhere`
takes it off the whole parish.

**Combine is three mechanisms**, routed by the shape of the target id
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

**Signed in is not the same as editing.** A parish sheet has two modes, each
behind its own pencil. `state.parishEditMode` is the parish's DETAILS: each
thing the sheet shows turns into the field that edits it, in place, and each
action pill gains a pencil for the link behind it — there is no form under the
sheet. `state.scheduleEditMode` is its TIMETABLE, entered from the pencil in
the timetable's own head; only then are rules editable (on the sheet or the
main services panel) and adding a service sits behind a +. Until either is on
the sheet is the sheet a visitor sees: no schedule pencils, no logo button, no
form in the DOM behind `display:none`.

The sheet's first button is **Google Maps**, and it opens the place, not a
route: `parishes.maps_url` when somebody picked the parish's Maps entry (a
Places search through `POST /api/admin/places`, or a pasted link), the pin
otherwise. `state.eventEditMode` is the same thing for the event drawer: one
pencil until somebody says they are editing, then Cancel, Suppress, Delete,
Combine and the form. `hideAdminControls` is **gone** — it was a remembered
preference for making tools go away, which is what a mode does by default, and
two modes now cover everything it did.

**Three different things are called "hide", and only one of them hides an
event.** Worth knowing before reaching for one:

| | Where | What it does |
|---|---|---|
| `status='hidden'`, override `kind='hidden'` | the row, or the override | Drops it from the feed entirely. **Not a tombstone** — no card, no "CANCELLED", gone |
| `hide_live` | `events`/`schedules`, patchable per occurrence | Nothing to do with hiding. Suppresses the **Watch Live** badge for that one service |
| `parish_scoped` | same | Shows only on its parish's own card, never in the main feed |

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

The parish sheet's **add-an-event button** is the one control outside that
mode, and deliberately: the mode exists so a signed-in person reads the sheet a
visitor reads, and this alters nothing the sheet is showing — it makes a
one-off that is not on the sheet at all yet, from a circle floating clear of
the content rather than a pencil sitting in it. What it *is* gated on is the
capability, per parish, which is why `state.adminWho` now keeps the whole
`/api/admin/ping` answer and not just "signed in": `adminMay('event.edit', pid)`
asks the two questions the Worker asks, in the order it asks them, so a button
that is absent and a route that refuses cannot disagree. An owner and an editor
see it on every sheet; a parish contact sees it on their own parishes only.
