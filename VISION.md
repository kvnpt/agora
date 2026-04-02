# Agora — Vision

## What Agora Is

A window into the time-stream of Orthodox parish gatherings in Sydney. A muted, monochrome, low-res echo of parish life — enough to save research time, not enough to replace going there.

## Who It's For

1. **Inquirers** — people exploring Orthodoxy in Sydney who need to find what's happening across parishes and jurisdictions without navigating a dozen different parish websites, Facebook pages, and WhatsApp groups.

2. **Naturalised parishioners** — Orthodox Christians who already know their own parish but want to explore events at other parishes. They have the knowledge to bridge any gaps in what Agora shows; they just need the search time saved.

## Two Event Streams

### The Rhythm (Recurring Schedules)
Every parish has a predictable weekly pattern: Sunday Divine Liturgy, Saturday Vespers, Wednesday evening services. These are defined once and generate forward-looking event instances automatically. They are the base layer — always present, always reliable.

### The Chaos (Ingested Events)
Festivals, youth nights, feast day celebrations, fundraisers, Lenten lecture series — announced via WhatsApp posters, Google Calendars, and parish websites. These arrive through adapters and are reviewed before publishing.

### Stacking, Not Replacing
Seasonal events (Great Lent, Holy Week, Pascha) overlay onto the base schedule. They don't cancel the underlying rhythm — they add to it or transform it. A Lenten service schedule stacks on top of the regular schedule, providing additional detail. If the overlay is incomplete (missing a time, missing a description), the base schedule fills the gap. The viewer always sees the richest available version.

When multiple parishes cancel their individual services for a combined hierarchical service at one location, that combined event overlays onto each parish's regular schedule.

## Parish Data Philosophy

Agora is not a directory and not a CMS. Parish profiles are intentionally thin:

- **Name, location, jurisdiction** — the minimum for event display and map placement.
- **Logo, acronym, chant style, languages** — enough to make cards recognisable and help users self-select.
- **Website as primary CTA** — for parishes with websites, Agora's design leads users there. The parish website is the door; Agora is the hallway.
- **Contact fallback** — parishes without websites get address, phone, and email displayed prominently, because Agora is the only online presence they have.

We store these unchanging details locally. They don't need a CMS because they don't change — a parish's address, jurisdiction, and chant style are stable facts. This avoids the CMS trap entirely.

## What Agora Is Not

- **Not a parish management tool** — no attendance tracking, no volunteer scheduling, no giving platforms. That's Breeze/Elvanto/PlanningCenter territory.
- **Not a replacement for parish formation** — Agora doesn't teach liturgical rhythms, explain feast days, or provide spiritual content. Only by venturing into the parishes does the inquirer see the life and colour they have.
- **Not a comprehensive liturgical calendar** — different jurisdictions follow different calendars (Old/New). Agora doesn't resolve this — it just shows what each parish is doing.
- **Not a social network** — no comments, no likes, no user profiles beyond admin roles.

## Design Principles

1. **Drive traffic to parishes, not away from them.** Every design decision should make the user want to visit the parish, not feel like they already know enough.
2. **Prefer ingestion over input.** Events should flow in from existing sources (WhatsApp, Google Calendar) rather than requiring manual data entry.
3. **Understandable code over clever code.** The codebase should be readable by a vibe-coder. No premature abstractions, no framework magic.
4. **Stable facts, not managed content.** Parish details are set-and-forget. Event details flow through automatically. Nothing in the system requires ongoing content management.
