# People, roles and access

Who can get in (Cloudflare Access), what they may do once in (admin_roles), and how somebody asks. Split out of CLAUDE.md, which keeps the rules that bite and links here for the reasons.

**Who may do what lives in `admin_roles`.** Cloudflare Access decides who
reaches `/admin`; that table decides what they may touch once inside —
owner, editor, or a parish contact scoped to their own parishes. Routes name
a *capability*, never a role, so a control the panel greys out and a route
that refuses read the same map. **An empty table means every authenticated
user is an owner**, which is exactly the behaviour before roles existed, so
the deploy cannot lock anybody out; the first row flips it and absence then
means no access. That is the opposite of `adapter_settings`, where absence
must never stop a scrape, and deliberately so: a missed scrape is fixed by
the next one, a wrongly-granted delete is not.

**Told, not asked.** An owner may combine across parishes without waiting on
the parishes it touches, because a quorum of contacts who mostly do not exist
would mean a deanery liturgy never gets published. The parish it happens TO
still hears about it: `/api/admin/parish-notices` reads `event_parishes` and the
`combined` overrides back for the parishes an account holds, and **Take my
parish out** is a veto after the fact — fast to act on, impossible to deadlock.
The notice is *derived*, like the feed and the source tiers; `parish_notices_seen`
holds only the one thing that cannot be, which is whether a person has looked.

**An ask is a refusal with somewhere to go.** `admin_proposals` holds the four
things somebody was refused and the panel could carry for them — a parish
delete, an acronym, a jurisdiction colour, and a combine reaching another
parish. The first three are *capability* refusals and the fourth is a *scope*
refusal, which is why nothing in `roles.mjs` grants `event.combine` and the
events routes raise it themselves. An owner decides; `/api/admin/ping` counts
what is open and the main app puts a red dot on the account icon, for a
decider only — a dot on somebody who can only look at it is noise. It is still
**not a moderation queue**: ordinary edits are never proposed, they just
happen.

**Admin fails closed.** With `ACCESS_TEAM_DOMAIN` or `ACCESS_AUD` unset, every
`/api/admin/*` request is refused. The Access JWT's signature is verified against the
team's published keys — a forged `Cf-Access-Jwt-Assertion` header gets nothing.

`AGORA_DEV_ADMIN=true` bypasses that, and exists only for `wrangler dev`. It is
deliberately absent from `wrangler.toml` so it cannot ship by accident.

**"Suggest edits" is the way in.** Coverage is the bottleneck — far more
parishes than timetables — and the person who notices a wrong time is most
likely to be reading the page. The parish sheet and the lite card both carry a
**Suggest edits** button under the parish's source line — where the page says
where its details came from and how old they are, so the natural place to offer
to put them right. It began as "Is this your parish?" under the timetable, where
it read as a note about the service times alone, and then became "Become a
contributor", which asked for a role before anybody could say what was wrong:
most people who spot a mistake want it fixed, not a login to fix it. It is
shown to anybody who cannot already edit the parish, and links to
`/admin?suggest=<parish id>` (`?claim=` still works), which is behind Access,
so the person signs in first and what they send carries the address Access
verified — never one typed into the form. The page is answered before the
panel, because the person arriving usually has no role at all.

The form is for what they came with: **Fix something** (optionally naming one
of the parish's service times, then what it should say) or **Add an event** (a
title, the parish's local date and times, a place in words, details, a link —
no poster; reading posters is an editor's tool). **Become a parish contact** is
a box on the same form, unticked; ticking it shows the claim's own fields (role
at the parish, phone, a note for the owner) and sends a claim beside the
suggestion — or alone, when there is nothing to suggest.

**A suggestion is a message, not an edit waiting to apply.** It lives in
`parish_suggestions` (migration 024; `worker/lib/suggestions.mjs`) and nothing
reads it into the feed. It shows under **Asks** for everybody who may edit that
parish — its contacts, and every editor and owner, by the same `mayTouchParish`
line the edit routes draw — and counts towards the red dot for them, since
unlike an ask a contact can act on it. Whoever reads it makes the change with
the usual tools and presses **Done**, or **Dismiss**es it with a word; a
suggested event can **Start a draft**, which is an ordinary draft from then on,
holding the parish's local wall clock until somebody publishes it. The sender
sees each one back on the same page with what became of it and any note. One
address may leave 20 open at a time. It is not a moderation queue: an edit by
somebody who may edit never goes through it, and nothing in it is applied by
pressing a button.

Claims live in `parish_claims` (migration 016; `worker/lib/claims.mjs`), not
`admin_proposals`: that table's capability CHECK would need a rebuild to widen,
and a stranger asking to be let in is not an ask an editor was refused. Three
routes are reachable WITHOUT a role — `GET /api/admin/whoami`,
`POST /api/admin/suggestions` and `POST /api/admin/claims` (plus withdrawing
your own) — through `signedIn`, which is `guarded` minus the "and you are on the
list" half. Everything else still refuses a role-less person.

An owner sees open claims at the top of **Asks**, and they count towards the
red dot. Approving writes `admin_roles` and **only ever grants**: no row
becomes a parish contact for that parish, a contact gains it beside the ones
they hold, an owner or editor is left as they are. With an empty People list
(the bootstrap rule) a claim is refused — there is no list to approve it onto,
and the first row would lock everybody else out.

A newly approved contact sees a one-time guide on their own parish's sheet —
details, service times, one-week changes, one-offs, a monthly bulletin — kept
per browser in localStorage, since it is a convenience.

## Setting up Cloudflare Access so People is the only list

Access answers **who are you**; `admin_roles` (the **People** tab) answers
**what may you do**. Since a signed-in person with no row is refused by every
guarded route, Access does not need its own list of people — keeping one there
too means every new person is two edits in two places, and the one in the
Zero Trust dashboard is the awkward one.

So, once, in **Zero Trust → Access → Applications → (the orthodoxy.au app)**:

1. **Login methods**: enable **One-time PIN** (a code emailed to the address —
   it works for anybody with an inbox, no account needed). Keep Google too if
   you like.
2. **Policies → edit the Allow policy → Include: "Everyone"**, replacing the
   list of emails. Save.

From then on, adding a person is: they sign in (or tick **Become a parish
contact** under **Suggest edits** on their parish), and an owner gives them a
role under **People** or approves their claim under **Asks**. Removing one is deleting their People row.

Before you switch, check **People has rows** — at least your own, as owner.
An EMPTY table means every authenticated user is an owner (the bootstrap rule
above), which with "Everyone" would be everybody with an email address. The
People tab shows a loud notice while the table is empty.

Two costs to know. Each person who signs in takes an Access **seat**, and the
free plan has 50; a seat can be removed under **Zero Trust → Users**. And the
`/admin` page itself loads for anybody signed in — it holds no data, every
request it makes is refused without a role, and it tells them so.

The alternative considered and not built: the Worker editing an Access group
through the Cloudflare API on approval. It would need an Access-editing API
token stored as a secret, and it would keep two lists that can disagree — the
thing this setup exists to stop.
