-- Agora — D1 baseline schema
--
-- Replaces the 29 sequential user_version migrations in db.js with the end
-- state they arrived at, minus everything the WhatsApp ingestor and the AI
-- vision pipeline needed. Seven tables survive.
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
  languages        TEXT NOT NULL DEFAULT '["English"]',
  color            TEXT,
  live_url         TEXT,

  -- Payment deep links: /<acronym>/donate|raffle|payment|gala 302 to these.
  donation_url     TEXT,
  raffle_url       TEXT,
  payment_url      TEXT,
  gala_url         TEXT,

  -- Provenance: where this parish's details came from, and when they were last
  -- checked. verified_at tracks the CHECK, not the row's creation — a parish
  -- added years ago but re-checked last month is fresh; one added last week off
  -- a stale website is not. NULL = never verified since import.
  info_source_type TEXT CHECK(info_source_type IN ('website','person','import')),
  info_source_ref  TEXT,   -- the URL, or a person as "First L."
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
CREATE TABLE adapter_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  adapter_id     TEXT NOT NULL,
  started_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  finished_at    TEXT,
  status         TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','success','failed')),
  events_found   INTEGER NOT NULL DEFAULT 0,
  events_created INTEGER NOT NULL DEFAULT 0,
  events_updated INTEGER NOT NULL DEFAULT 0,
  error_message  TEXT
);

-- healthCheck() reads the newest run for one adapter.
CREATE INDEX idx_adapter_runs_lookup ON adapter_runs(adapter_id, started_at DESC);
