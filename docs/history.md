# History worth knowing

Split out of CLAUDE.md.

Agora ran on a Sydney VM until it was decommissioned: Express + better-sqlite3 +
node-cron behind Caddy, with a WhatsApp ingestor that used Claude Vision to read parish
posters, and a moderation queue because AI-parsed content needed approval.

That is all gone. The WhatsApp and vision pipelines were cut deliberately (scope: "a
database and a website"), which also removed the entire moderation subsystem. The old
database was not recovered — parishes come from the seed, events from scraping.

Two consequences still visible in the code:

- `events.schedule_id` and the `source_adapter != 'schedule'` guard in the bundle query
  are scar tissue from a nightly generator that wrote occurrence rows. It was replaced by
  the date lens in schema v26.
- Ingestion started from **one parish** (Good Shepherd Clayton, via Google Calendar).
  Its row existed only in the lost database and was re-seeded once the address was
  confirmed, so `PENDING_PARISHES` is now empty — but the guard it feeds stays, because
  an adapter pointed at a missing parish must refuse before writing rather than throw a
  foreign-key error every four hours. Everything else used to arrive over WhatsApp.
  Two PDF parishes have since been added (Buderim and Blacktown), and writing more
  adapters is still the gap between "the port is done" and "the site is useful".

`docs/cloudflare-migration.md` is the full migration record, including the reasoning
behind decisions that look arbitrary from the outside.

`docs/parish-ingestion.md` is the brief for the step *before* adapters: adding
parishes in bulk from a jurisdiction's directory. It records the schema
constraints that bite a few hundred rows at once, the geocoding trap that put one
pin 730m off, and the three public endpoints that let you read production without
any credential at all.

`/ingest-jurisdiction <name>` (`.claude/commands/`) is that brief as a command:
the three reviewable passes, the traps in the order they cost time, and the one
rule about sources — **a jurisdiction's own site is where its parish information
comes from.** Aggregators are for finding that site and nothing else, because
`info_source_type='website'` asserts the parish told us and that should be true.
