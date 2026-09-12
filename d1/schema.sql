-- Agora — D1 baseline schema
--
-- Replaces the 29 sequential user_version migrations in db.js with the end
-- state they arrived at, minus everything the WhatsApp ingestor and the AI
-- vision pipeline needed. Seven tables survive; two have since been added,
-- for the jurisdiction colour overrides and a parish's own short links.
--
-- Apply with:
--   wrangler d1 execute agora --remote --file=d1/schema.sql
--
-- DESIGN NOTE — local time vs UTC. This split is deliberate; see
-- docs/cloudflare-migration.md. Recurrence rules (schedules.start_time,
-- schedule_overrides.patch_*_time) store LOCAL wall-clock time plus the
-- parish's IANA zone, because for a recurring service the wall clock is the
-- invariant — a 9am liturgy stays 9am across a DST boundary. One-off events
-- store UTC, because there the instant is the intent. Do not "fix" the former
-- into the latter; it introduces an hour of drift twice a year.

-- ─────────────────────────────────────────────────────────────────────────
-- parishes
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE parishes (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  full_name        TEXT,
  jurisdiction     TEXT NOT NULL CHECK(jurisdiction IN
                     ('antiochian','greek','serbian','russian','romanian','macedonian','other')),
  address          TEXT,
  lat              REAL NOT NULL,
  lng              REAL NOT NULL,

  -- IANA zone. orthodoxy.au covers Oceania, where offsets and DST rules differ
  -- per state: Perth +08:00 no DST, Brisbane +10:00 no DST, Adelaide +09:30/
  -- +10:30, Auckland +12:00/+13:00 switching on different dates to Sydney.
  -- start_time on a schedule is meaningless without this.
  timezone         TEXT NOT NULL DEFAULT 'Australia/Sydney',

  website          TEXT,
  phone            TEXT,
  email            TEXT,
  logo_path        TEXT,
  acronym          TEXT,
  chant_style      TEXT,

  -- Patronal feast, as the parish itself states it ("26th October"). Free text
  -- on purpose: jurisdictions split across Old and New Calendar, so this is the
  -- parish's own answer, not a date Agora computes or resolves to a year.
  feast_day        TEXT,
  languages        TEXT NOT NULL DEFAULT '["English"]',
  color            TEXT,
  live_url         TEXT,

  -- Payment deep links: /<acronym>/donate|raffle|payment|gala 302 to these.
  -- Any OTHER short link a parish hands out is a `parish_links` row instead —
  -- these four have columns because they were the four every parish was asked
  -- for, not because the list is closed.
  donation_url     TEXT,
  raffle_url       TEXT,
  payment_url      TEXT,
  gala_url         TEXT,

  -- Provenance: where this parish's details came from, when WE last read that
  -- source, and — separately — whether a person has ever confirmed the row.
  -- The first three are the same trio `schedules` carries, and are shown the
  -- same way: see info_checked_at below.
  info_source_type TEXT CHECK(info_source_type IN ('website','person','import')),
  info_source_ref  TEXT,   -- the URL, or a person as "First L."

  -- What to CALL that source, because a URL is not a name. The ref for a
  -- directory-imported parish is a hundred characters of path
  -- ("orthodox-world.org/en/i/24479/australia/new-south-wales/croydon/..."),
  -- which answers "where did this come from" only if you read URLs for a
  -- living. This is the short label to show instead: "Greek Orthodox
  -- Archdiocese of Australia", "Parish website", "OpenStreetMap".
  --
  -- It names the SOURCE, not the parish, so parishes from one directory share
  -- one name — that is the point, since it makes a jurisdiction's whole import
  -- legible at a glance and a stale source findable in one query.
  info_source_name TEXT,

  -- When WE last read that source. Not when the source last changed, and not a
  -- claim that the details are right — `schedules.source_checked_at` carries the
  -- same reasoning at length, and this is deliberately the same field for the
  -- same reason. A parish's address is a claim about the present that nothing
  -- in the row expires: an address entered in 2019 renders exactly as
  -- confidently as one read this morning unless something says how old it is.
  -- This is that something, and the sheet renders it as "Updated 3 months ago
  -- · Greek Archdiocese" under the parish's details.
  --
  -- Every writer stamps it: a directory import writes the moment it read the
  -- directory, and an admin editing the source in the parish sheet writes the
  -- date they looked.
  info_checked_at TEXT,

  -- When a PERSON confirmed this row against the place itself — not a scrape,
  -- however recent. It is deliberately NOT info_checked_at: every import
  -- stamps that one, so a guard on it would freeze every row after the first
  -- run. This is the guard scripts/parish-import.mjs uses to refuse to move a
  -- pin somebody has stood in front of, which is what stopped a re-geocode
  -- shifting a confirmed parish 784m (docs/parish-ingestion.md).
  --
  -- Nothing renders it. It is a fact about the row, not about the source, and
  -- the provenance line above speaks only for the source.
  info_verified_at TEXT
);

-- Sentinel parish for events whose parish is unknown.
INSERT INTO parishes (id, name, jurisdiction, address, lat, lng, info_source_type, info_source_ref)
VALUES ('_unassigned', 'Unassigned / Unknown Parish', 'other', 'Sydney NSW',
        -33.8688, 151.2093, 'import', 'schema baseline');

-- ─────────────────────────────────────────────────────────────────────────
-- schedules — recurrence RULES, never occurrences
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE schedules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  parish_id      TEXT NOT NULL REFERENCES parishes(id),
  day_of_week    INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),  -- 0=Sun
  start_time     TEXT NOT NULL,   -- 'HH:MM' LOCAL to parishes.timezone
  end_time       TEXT,            -- 'HH:MM' LOCAL
  title          TEXT NOT NULL,
  event_type     TEXT NOT NULL DEFAULT 'liturgy',
  active         INTEGER NOT NULL DEFAULT 1,
  languages      TEXT,

  -- NULL = every matching weekday. Otherwise a comma-separated subset of
  -- first,second,third,fourth,last — see recurrence.js.
  week_of_month  TEXT,

  -- Genuinely simultaneous services never collapse into one another in the
  -- read-path dedup (routes/events.js partitionKey).
  concurrent     INTEGER NOT NULL DEFAULT 0,

  hide_live      INTEGER NOT NULL DEFAULT 0,
  parish_scoped  INTEGER NOT NULL DEFAULT 0,
  effective_from TEXT,   -- 'YYYY-MM-DD' local; NULL = open-ended
  effective_to   TEXT,

  -- Where this rule meets, when that is not the parish's own address.
  --
  -- NULL means the parish address, which is the usual case and the reason this
  -- is not NOT NULL. A parish without its own building is the reason it exists
  -- at all: Good Shepherd serves in a university religious centre and the
  -- Sunshine Coast parish in a borrowed Anglican church, and a parish that has
  -- a building still holds a weekday service in a hall down the road, a
  -- monthly liturgy at a cemetery chapel, or a Vespers at another parish.
  --
  -- It is the same field `events.location_override` is, and an occurrence-level
  -- `schedule_overrides.patch_location_override` still wins over it: the rule
  -- says where the service normally is, the override says where it is this
  -- once. project.mjs resolves the three in that order.
  --
  -- Text, not coordinates. The pin stays the parish's — an address here is for
  -- a reader to find the door, and geocoding every rule would put a second
  -- class of unverified pin on the map for no gain.
  location_override TEXT,

  -- Where this rule came from, and when we last read it there.
  --
  -- A recurrence rule is a claim about the FUTURE, and unlike a scraped event it
  -- never expires on its own: "Sundays 9am" keeps projecting cards forever,
  -- looking exactly as current on the day the parish changes its times as it did
  -- the day it was entered. There is no signal in the row itself that anyone has
  -- looked since. These three are that signal, and each answers a different
  -- question: the name is who says so, the ref is where to check, and the
  -- timestamp is how long ago we looked.
  --
  -- `source_checked_at` is OUR READ, not the source's own last-modified date.
  -- That is the weaker claim and the only honest one: a page's modified date is
  -- the publisher's assertion about itself, and a parish that changes its times
  -- without touching the page would carry a date saying the times are current.
  -- What we can actually vouch for is when we looked. This records freshness,
  -- never veracity.
  --
  -- Parishes carry the same three as info_source_name/_ref/_verified_at. They
  -- are separate here on purpose: a parish's address and its service times go
  -- stale independently and are very often published in different places.
  source_name       TEXT,
  source_ref        TEXT,
  source_checked_at TEXT,   -- ISO 8601 UTC, when WE last read the source

  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE INDEX idx_schedules_parish ON schedules(parish_id);
CREATE INDEX idx_schedules_active ON schedules(active);

-- ─────────────────────────────────────────────────────────────────────────
-- events — one-off, stored occurrences (adapter-scraped or hand-entered)
--
-- Schedule occurrences are NOT stored here. They are projected at read time by
-- schedule-expand.js and carry synthetic ids of the form "scheduleId:YYYY-MM-DD".
-- routes/events.js guards this table with `source_adapter != 'schedule'`.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  parish_id         TEXT NOT NULL REFERENCES parishes(id),
  source_adapter    TEXT NOT NULL,
  schedule_id       INTEGER REFERENCES schedules(id),
  title             TEXT NOT NULL,
  description       TEXT,
  start_utc         TEXT NOT NULL,   -- a real instant; the intent IS the moment
  end_utc           TEXT,
  location_override TEXT,
  lat               REAL,
  lng               REAL,
  event_type        TEXT NOT NULL DEFAULT 'other',
  source_url        TEXT,
  source_hash       TEXT,            -- dedup key; UNIQUE below makes re-scrapes idempotent

  -- 'replaced' is set by the combine flow, not by moderation. 'pending_review'
  -- is gone with the AI pipeline that was its only producer.
  status            TEXT NOT NULL DEFAULT 'approved'
                      CHECK(status IN ('approved','replaced','cancelled','hidden','rejected')),
  mutation_type     TEXT NOT NULL DEFAULT 'scheduled',

  languages         TEXT,
  poster_path       TEXT,
  hide_live         INTEGER NOT NULL DEFAULT 0,
  parish_scoped     INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Multiple NULLs are permitted by SQLite, so hand-entered events without a
-- source_hash don't collide. Re-running a scrape updates rather than duplicates.
CREATE UNIQUE INDEX idx_events_source_hash ON events(source_hash);
CREATE INDEX idx_events_parish   ON events(parish_id);
CREATE INDEX idx_events_start    ON events(start_utc);
CREATE INDEX idx_events_status   ON events(status);
CREATE INDEX idx_events_schedule ON events(schedule_id);

-- ─────────────────────────────────────────────────────────────────────────
-- schedule_overrides — the exception store for the date lens
--
-- One row per (schedule, occurrence date) that departs from the rule. Nothing
-- disappears: every occurrence in a window still emits exactly one instance,
-- and an override only changes how it renders.
--   modified  -> patched instance (mutation_type 'adapted')
--   cancelled -> CANCELLED tombstone, still visible
--   combined  -> tombstone linking to the combining event
--   hidden    -> dropped from the default filter; not a tombstone
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE schedule_overrides (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id             INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  occurrence_date         TEXT NOT NULL,   -- 'YYYY-MM-DD' LOCAL to the parish; join key
  kind                    TEXT NOT NULL CHECK(kind IN ('modified','cancelled','combined','hidden')),

  patch_title             TEXT,
  patch_start_time        TEXT,            -- 'HH:MM' LOCAL
  patch_end_time          TEXT,            -- 'HH:MM' LOCAL
  patch_event_type        TEXT,
  patch_languages         TEXT,
  patch_feast             TEXT,
  patch_description       TEXT,
  patch_location_override TEXT,
  patch_hide_live         INTEGER,
  patch_parish_scoped     INTEGER,

  combined_into_event_id  INTEGER REFERENCES events(id) ON DELETE CASCADE,

  note                    TEXT,

  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),

  -- Who decided this. 'human' or 'adapter:<id>'.
  --
  -- An adapter may cancel an occurrence a source has stopped publishing, and
  -- must withdraw that cancellation when it reappears — so its own rows have to
  -- be findable. A person's never are: UNIQUE below means writing over one
  -- replaces it, and a deliberate cancellation silently undone by a scrape is
  -- the worst outcome this table has.
  --
  -- Last, not beside the other metadata, because ALTER TABLE ADD COLUMN can
  -- only append: a database migrated with d1/migrations/001 and one created
  -- from this file must come out identical, down to column order.
  source                  TEXT NOT NULL DEFAULT 'human',

  UNIQUE(schedule_id, occurrence_date)
);

CREATE INDEX idx_overrides_schedule ON schedule_overrides(schedule_id);
CREATE INDEX idx_overrides_combined ON schedule_overrides(combined_into_event_id);
CREATE INDEX idx_overrides_date     ON schedule_overrides(occurrence_date);

-- ─────────────────────────────────────────────────────────────────────────
-- Combine / cross-parish
--
-- Three mechanisms, routed by the shape of the target id
-- (routes/admin.js POST /events/:id/escalate):
--   event_parishes                    additive — one event under several parishes
--   event_replaces                    replace a stored one-off      (integer id)
--   schedule_overrides kind=combined  replace a schedule occurrence ("sid:date")
--
-- event_replaces is pre-v26 but NOT redundant: it is the only path for
-- combining against a stored one-off. Both run in the same transaction.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE event_parishes (
  event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  parish_id TEXT NOT NULL REFERENCES parishes(id),
  PRIMARY KEY (event_id, parish_id)
);

CREATE TABLE event_replaces (
  replacing_event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  replaced_event_id  INTEGER NOT NULL REFERENCES events(id),
  PRIMARY KEY (replacing_event_id, replaced_event_id)
);

CREATE INDEX idx_event_replaces_replaced ON event_replaces(replaced_event_id);

-- ─────────────────────────────────────────────────────────────────────────
-- adapter_runs — scrape history
--
-- With scraping as the primary ingestion path this is the only record that a
-- run happened and what it produced; the failure mode that matters is a scrape
-- silently returning zero events, which errors nowhere. Read by
-- BaseAdapter.healthCheck() behind GET /api/adapters/status.
-- ─────────────────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────────────────
-- parish_links — a parish's own short links, beyond the four it has columns for
--
-- /<acronym>/donate|raffle|payment|gala are columns on `parishes` because they
-- are the four every parish was asked for. They are not the four every parish
-- HAS: a festival, a building fund, a bookstall, a Facebook group, a form for
-- a baptism enquiry. A column each would be a migration each, and the answer
-- would still be no the next time somebody asks.
--
-- So: one row per extra link, resolved by worker/index.mjs after the four
-- fixed kinds. `slug` is the second segment of the URL and shares a namespace
-- with everything else the router reads, so it is checked against the same
-- reserved list an acronym is (public/shared/slugs.js) — /smg/liturgy has to
-- keep meaning the service.
--
-- `label` is what the parish sheet calls the link; a slug is a URL, not a name.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE parish_links (
  parish_id  TEXT NOT NULL REFERENCES parishes(id) ON DELETE CASCADE,
  slug       TEXT NOT NULL,
  label      TEXT,
  url        TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (parish_id, slug)
);

-- ─────────────────────────────────────────────────────────────────────────
-- jurisdiction_colors — what /admin has changed about the colour table
--
-- public/shared/jurisdiction-colors.js holds the colours, is read by the app,
-- the map, the seed and this repo's tests, and stays the one place a colour is
-- WRITTEN DOWN. This table is not a second copy of it: it holds only the rows
-- somebody deliberately changed, and absence means the file's value — the same
-- arrangement adapter_settings has, for the same reason. A jurisdiction's hue
-- is a judgement made by looking at six of them side by side against a map,
-- and a deploy per adjustment is how that never gets done.
--
-- `color` is validated as #rgb or #rrggbb on the way in AND on the way out:
-- the value is painted into inline styles and into a MapLibre paint
-- expression, so a malformed row falls back to the file rather than reaching
-- either. See setJurisdictionColors() in the shared file.
--
-- Changing a jurisdiction's colour here does NOT rewrite parishes.color, which
-- is a per-parish identity mark that a jurisdiction-wide choice has no business
-- overwriting — the admin panel offers that as a separate, counted action, and
-- only for rows still carrying the colour being replaced.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE jurisdiction_colors (
  jurisdiction TEXT PRIMARY KEY CHECK(jurisdiction IN
                 ('antiochian','greek','serbian','russian','romanian','macedonian','other')),
  color        TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Per-adapter scrape control.
--
-- Cloudflare's Cron Trigger is fixed at deploy time and cannot be changed by
-- the Worker, so wrangler.toml fires hourly and this table decides what that
-- hour is allowed to do. An adapter runs when it is enabled and its last
-- success is older than interval_minutes; otherwise the tick passes it by.
--
-- A missing row means enabled at the default interval, so adding an adapter
-- needs no accompanying row and forgetting one cannot silently disable a
-- scrape.
--
-- "Run now" in the admin panel ignores all of this. Asking explicitly is not
-- the same as a timer going off.
CREATE TABLE adapter_settings (
  adapter_id       TEXT PRIMARY KEY,
  enabled          INTEGER NOT NULL DEFAULT 1,
  interval_minutes INTEGER NOT NULL DEFAULT 240,
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE adapter_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  adapter_id     TEXT NOT NULL,
  started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  finished_at    TEXT,
  status         TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','success','failed')),
  events_found   INTEGER NOT NULL DEFAULT 0,
  events_created INTEGER NOT NULL DEFAULT 0,
  events_updated INTEGER NOT NULL DEFAULT 0,
  error_message  TEXT,

  -- What the run actually asked the source about, as local dates.
  --
  -- Absence is only evidence inside this. Without it a later run cannot tell
  -- whether a date was reported missing or simply never requested, and every
  -- tombstone written from absence becomes unauditable.
  window_from    TEXT,
  window_to      TEXT,

  -- Set when the guards refused to act on absence: 'empty-scrape',
  -- 'too-many'. A refusal is a result, not a failure — status stays 'success'
  -- because the scrape worked; this says why nothing was cancelled.
  tombstones_refused TEXT
);

-- healthCheck() reads the newest run for one adapter.
CREATE INDEX idx_adapter_runs_lookup ON adapter_runs(adapter_id, started_at DESC);
