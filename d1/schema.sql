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
  info_verified_at TEXT,

  -- Who last edited this row, and when.
  --
  -- Anonymous rows were fine while one person had a login. With several, "is
  -- this address newer than the scrape, and who says so" becomes the question
  -- asked of every field, and nothing could answer it — adminIdentity() existed
  -- and was called from nowhere.
  --
  -- Distinct from info_source_*, which is about the SOURCE: that says a parish
  -- website published this and when we last read it. This says which of us
  -- typed it in. A scrape writes the first and never the second, because a
  -- scrape is not a person.
  updated_at  TEXT,
  updated_by  TEXT
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

  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),

  -- As on parishes: which of US last edited the rule, as opposed to which
  -- source the rule came from. source_* is the claim's origin; these two are
  -- the edit's author.
  --
  -- After created_at rather than beside the other metadata, for the reason
  -- schedule_overrides.source gives at length: these arrived by ALTER TABLE
  -- (d1/migrations/009) and ALTER can only append, so a database migrated
  -- forward and one built from this file have to agree down to column order.
  updated_at        TEXT,
  updated_by        TEXT,

  -- The fortnight. NULL = not a fortnightly rule, and every week that
  -- week_of_month allows. 'a' or 'b' = alternate weeks, forever.
  --
  -- `week_of_month` was the only qualifier a rule had and it cannot spell a
  -- fortnight. docs/parish-ingestion.md records the cost: Coburg's Compline and
  -- its Youth Group both alternate with St Vasilios Brunswick, and both rules
  -- were dropped rather than written as month positions that would put a
  -- service at Coburg on the Tuesdays it is at Brunswick.
  --
  -- A PARITY, NOT A START DATE. Calendar apps anchor a fortnight to its first
  -- occurrence; there is nowhere here to put one. `effective_from` is a
  -- validity window — "this rule has been true since" — and making it double as
  -- the phase would mean recording a rule's history moved which week the
  -- service falls on. A parity is a property of the date instead, which is what
  -- the lens wants: no anchor, and right looking backwards as well as forwards,
  -- which a deep link to a date years ago needs.
  --
  -- Which weeks are A is public/shared/recurrence.mjs, per ISO year through
  -- 2126 and generated so the alternation carries across a 53-week year. It is
  -- mutually exclusive with week_of_month — the two together over-constrain —
  -- and that is enforced in the routes, not by a CHECK, because adding one
  -- would mean rebuilding `schedules` and schedule_overrides references it ON
  -- DELETE CASCADE. See d1/migrations/014.
  week_parity       TEXT     -- NULL | 'a' | 'b'
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

  -- Which person, when `source` is 'human'. Null for one the machine wrote:
  -- applyTombstones cancels services from absence, and attributing that to
  -- whoever happened to be signed in would be a lie.
  --
  -- After `source` for the same reason `source` is after `updated_at`: it
  -- arrived later, by ALTER (d1/migrations/009), and ALTER appends.
  updated_by              TEXT,

  -- A poster for THIS occurrence, as '/posters/<key>' in R2.
  --
  -- Unlike every other patch_* above it has nothing to fall back to: a RULE has
  -- no poster, because a weekly liturgy does not have a flyer. So this is not
  -- "the rule's value, overridden" — it is the only place an occurrence's
  -- poster can live, and NULL means there isn't one rather than "inherit".
  --
  -- Last, by the same append rule as `source` and `updated_by` above: it
  -- arrived by ALTER (d1/migrations/012) and ALTER appends.
  patch_poster_path       TEXT,

  UNIQUE(schedule_id, occurrence_date)
);

CREATE INDEX idx_overrides_schedule ON schedule_overrides(schedule_id);
CREATE INDEX idx_overrides_combined ON schedule_overrides(combined_into_event_id);
CREATE INDEX idx_overrides_date     ON schedule_overrides(occurrence_date);

-- ─────────────────────────────────────────────────────────────────────────
-- schedule_breaks — a stretch of dates a service is not running
--
-- A parish shut between Christmas and Theophany, a hall closed for works, a
-- priest away for a month. This is to a RANGE what schedule_overrides is to a
-- DATE, and the reason it is not just a range of those rows: a six-week break
-- on a daily rule would be forty-two of them, editing the window would mean
-- deleting and rewriting them, UNIQUE(schedule_id, occurrence_date) would
-- clobber any per-date override already there, and nothing would record that
-- the forty-two were ONE decision with one reason.
--
-- It renders. project.mjs gives a covered occurrence status 'break' and
-- is_tombstone 1, filterByStatus passes it, and the card reads BREAK with the
-- note under it — the same bargain cancellation makes, for the same reason:
-- somebody who would otherwise turn up at church is told, rather than finding
-- the service quietly absent. It is NOT 'hidden', which is for something that
-- should never have been published.
--
-- Living outside schedule_overrides also makes it immune to tombstone.mjs,
-- which withdraws an adapter's cancellation when a service reappears in a
-- scrape. A break is a person's decision about the future, and a scrape that
-- cannot see it must not be able to lift it.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE schedule_breaks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  parish_id   TEXT NOT NULL REFERENCES parishes(id),

  -- NULL = every rule at this parish, which is the common case: a parish
  -- shutting for Christmas shuts all of it, and naming each rule would be a row
  -- per service and one of them forgotten. Set = that one rule.
  schedule_id INTEGER REFERENCES schedules(id) ON DELETE CASCADE,

  -- 'YYYY-MM-DD' LOCAL to the parish, inclusive at both ends — the same date
  -- space schedule_overrides.occurrence_date joins on.
  from_date   TEXT NOT NULL,
  to_date     TEXT NOT NULL,

  -- Why. NOT NULL for the reason info_overrides.note is NOT NULL: a service
  -- that is off with no reason given is indistinguishable from a mistake. This
  -- one is also rendered to a visitor, so it is the whole of what they are told.
  note        TEXT NOT NULL,

  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_by  TEXT,

  CHECK (to_date >= from_date)
);

CREATE INDEX idx_breaks_parish   ON schedule_breaks(parish_id);
CREATE INDEX idx_breaks_schedule ON schedule_breaks(schedule_id);
CREATE INDEX idx_breaks_window   ON schedule_breaks(from_date, to_date);

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

-- ─────────────────────────────────────────────────────────────────────────
-- pdf_source_overrides — where a PDF parish's file is, when it has moved
-- ─────────────────────────────────────────────────────────────────────────
--
-- Same shape and the same reasoning as jurisdiction_colors: the DEFAULT lives
-- in code (worker/lib/pdf-sources.mjs), this table holds only what somebody
-- deliberately changed, absence means the file's value, and a reset DELETEs the
-- row rather than writing the default into it.
--
-- WHAT IT IS FOR. A parish republishes its schedule under a new path — the
-- Sunshine Coast sheet is a new URL every January and shares no pattern with
-- last year's — and until now the only way to follow it was a pull request and
-- a deploy. That is the single most common maintenance act on a PDF parish, it
-- needs no review, and it was the one thing a sub-admin could not do.
--
-- WHAT IT IS NOT FOR. Only the URL. `parse`, `extract` and `linkPattern` stay
-- in code because they are judgements about how to read a document, and a wrong
-- one silently mis-reads every service rather than failing.
--
-- THE INVARIANT THIS HAS TO KEEP. pdf-sources.mjs is imported by the Worker AND
-- by the GitHub Action precisely so the URL fetched and the URL believed cannot
-- drift. An override only the Worker could see would break that: the panel
-- would show a new URL, the Action would keep fetching the old file, and
-- nothing would change. So the overrides are served publicly at
-- /api/pdf-sources and the Action reads them too — the same trick as the shared
-- modules, one source of truth with two consumers.
CREATE TABLE pdf_source_overrides (
  -- The PDF_SOURCES key, e.g. 'gopssc-buderim'. Not a foreign key: the source
  -- list is code, and a row for a key that has since been removed should be
  -- inert rather than un-deletable.
  source_key  TEXT PRIMARY KEY,
  source_url  TEXT NOT NULL,
  -- Who moved it and when. The first per-row audit line in this schema, and
  -- the reason is the same one that put an identity in the admin header: a
  -- URL somebody typed is a claim, and a claim wants an author.
  updated_by  TEXT,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ─────────────────────────────────────────────────────────────────────────
-- admin_roles — what an authenticated person may do
-- ─────────────────────────────────────────────────────────────────────────
--
-- Cloudflare Access decides who gets through the door. This decides what they
-- may touch once inside, which was previously a single boolean: anyone who got
-- in could delete any parish, change any acronym, or repaint every jurisdiction.
--
-- NOT an Access group claim, deliberately. That would need the identity
-- provider to emit groups and the Access application to forward them, neither
-- of which the Worker can check; it would put "who is a sub-admin" in a
-- Cloudflare dashboard rather than in the panel the owner already uses; and it
-- could not be tested. A table is the shape every other piece of configuration
-- here already has.
--
-- THE BOOTSTRAP RULE, which is the whole reason this is safe to deploy:
-- an EMPTY table means every authenticated user is an owner. That reproduces
-- exactly the behaviour before roles existed, so the deploy cannot lock the
-- existing admin out of their own panel. The moment any row exists, absence
-- stops meaning owner and starts meaning no access.
--
-- Note the asymmetry with adapter_settings, where a missing row deliberately
-- means "carry on at the default" — absence must never be the thing that stops
-- a scrape. Here absence must stop a delete. A missed scrape is fixed by the
-- next one; a wrongly-granted delete is not.
CREATE TABLE admin_roles (
  -- The Access identity, lower-cased on the way in. Matching is
  -- case-insensitive at read time too, because an identity provider may hand
  -- back a different casing than whoever typed the row.
  email       TEXT PRIMARY KEY,

  -- owner   — everything, including deletes, acronyms, colours and this table
  -- editor  — the day-to-day work across every parish, minus those four
  -- parish  — the same verbs as editor, but only for parish_ids below
  role        TEXT NOT NULL CHECK(role IN ('owner','editor','parish')),

  -- A JSON array of parish ids. Only read for role='parish'; an empty list
  -- there can touch nothing, which is the right reading of "scoped to these
  -- parishes" and is why the panel refuses to save that combination.
  parish_ids  TEXT,

  -- A human note: which parish they are the contact for, who vouched for them.
  note        TEXT,

  added_by    TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ─────────────────────────────────────────────────────────────────────────
-- admin_proposals — the asks an editor cannot carry out themselves
-- ─────────────────────────────────────────────────────────────────────────
--
-- Roles draw three hard lines: an editor may not delete a parish, change an
-- acronym, or repaint a jurisdiction. Each of those is the right call — a
-- delete is unrecoverable, an acronym takes a public link away from everybody
-- holding it, and a colour applies site-wide — but a bare refusal turns the
-- owner into a help desk reached by some other channel, and the request arrives
-- without the context that produced it.
--
-- So the refusal offers to carry the ask instead. The editor says what they
-- wanted and why; the owner sees it in the panel, with the parish and the exact
-- change already attached, and approves or declines in one press.
--
-- WHAT THIS IS NOT. Not a general approval queue, and deliberately not a way to
-- moderate ordinary edits — the WhatsApp moderation subsystem was deleted with
-- the VM and is not coming back. Only an ask with nowhere else to go becomes a
-- proposal.
--
-- 'event.combine' is the fourth and is a different shape from the other three.
-- Those are CAPABILITY refusals: an editor may not delete a parish anywhere.
-- This one is a SCOPE refusal — a parish contact may combine all day at their
-- own parish, and a combine is the one write whose target is somebody else's.
-- The ask is the same shape either way ("I cannot do this, here is what I
-- wanted and why"), so it lives in the same table rather than growing a second
-- one that would need its own panel and its own red dot.
--
-- The payload is JSON because the shapes have nothing in common: a delete
-- carries what to do with the events, an acronym carries the new slug, a colour
-- carries a hex, a combine carries the two target lists. Reading it is the
-- approving route's job, and it re-validates everything rather than trusting a
-- row that has been sitting in a table.
--
-- A combine's payload is the WHOLE desired state, not the part that was
-- refused. `applyEscalation` is idempotent on a target state — anything not
-- named is removed — so a payload holding only the out-of-scope half would
-- strip the half that was applied at once, the moment it was approved.
CREATE TABLE admin_proposals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,

  -- What the proposer was refused. Checked against this list on the way in, so
  -- a row can never ask for something the approving route does not know how to
  -- do. The first three are capabilities an editor lacks; 'event.combine' is a
  -- scope refusal — see the note above.
  capability  TEXT NOT NULL
                CHECK(capability IN ('parish.delete','parish.acronym','colors.edit','event.combine')),

  -- What it is about: a parish id, a jurisdiction for a colour, or the id of
  -- the event being combined. Only a parish subject is scoped on the way in,
  -- which is why the combine's own scoping reads the event's parish instead.
  subject     TEXT NOT NULL,

  -- The change itself, shaped by `capability`.
  payload     TEXT NOT NULL,

  -- Why. Free text from the proposer, and the reason this beats an email: the
  -- ask and its justification arrive together and stay attached to the record.
  reason      TEXT,

  status      TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','approved','declined','withdrawn')),

  proposed_by TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),

  -- Who closed it and what they said. A decline with no note is a refusal the
  -- proposer cannot learn anything from.
  decided_by  TEXT,
  decided_at  TEXT,
  decision_note TEXT
);

CREATE INDEX idx_admin_proposals_open ON admin_proposals(status, created_at DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- parish_notices_seen — which cross-parish listings a contact has looked at
-- ─────────────────────────────────────────────────────────────────────────
--
-- A combine writes rows about a parish that is not the event's own: an
-- `event_parishes` row lists somebody else's event at your church, and a
-- 'combined' override turns your Sunday into a tombstone pointing at it. An
-- owner may do both without asking, which is the right call — waiting on a
-- quorum of parish contacts, most of whom do not exist, would mean a deanery
-- liturgy never gets published.
--
-- But the parish it happens TO should not find out by noticing their own
-- Sunday struck through. So the involvements are shown back to them, and they
-- can take their parish out of one. That is a veto after the fact rather than a
-- gate before it: fast to act on, impossible to deadlock.
--
-- THE NOTICE ITSELF IS DERIVED and not stored. It is whatever `event_parishes`
-- and `schedule_overrides` currently say about your parishes — the same reason
-- the feed is projected from rules and the source tiers are computed from the
-- URL. A stored copy would be a second answer to a question the rows already
-- answer, and it would go stale the moment somebody withdrew.
--
-- What CANNOT be derived is whether a person has looked, so that is all this
-- table holds. One row per (parish, event, person): a parish with two contacts
-- does not mark the other's notice read.
CREATE TABLE parish_notices_seen (
  parish_id TEXT NOT NULL REFERENCES parishes(id) ON DELETE CASCADE,
  event_id  INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  seen_by   TEXT NOT NULL,
  seen_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  PRIMARY KEY (parish_id, event_id, seen_by)
);

-- ─────────────────────────────────────────────────────────────────────────
-- info_overrides — which source wins, per parish, per fact
-- ─────────────────────────────────────────────────────────────────────────
--
-- `schedule_overrides` above rules on an OCCURRENCE: this Sunday's liturgy is
-- at ten, or cancelled, or combined. This table rules on the INFORMATION
-- itself — the address, the phone number, whether a Vespers exists at all —
-- and it exists because a parish has several sources and they disagree.
--
-- The ladder is written down once, in public/shared/source-tiers.js:
--
--   admin > parish site/social > jurisdiction directory > search > directory > null
--
-- and `outranks` there is the only comparison anyone makes. This table stores
-- the rulings; that file stores the order.
--
-- THE CASE THAT PAID FOR IT. St Mary Magdalene, Elimbah publishes two Vespers
-- on its Antiochian directory page. Neither has run for years — confirmed by
-- telephone — so both rules were deleted in /admin. Nothing recorded that.
-- `planWrite` in scripts/antiochian-schedules.mjs pairs a scraped rule with an
-- existing row on parish + weekday + time; a deleted row has nothing to pair
-- with, so it became an insert, and `buildScheduleSql`'s WHERE NOT EXISTS
-- guard only asks whether the rule is there NOW. Re-running the import would
-- have put both back, silently, and the next person to notice would have
-- deleted them again. A deletion is a claim, and a claim needs somewhere to
-- live.
--
-- WHY IT IS NOT A VALUE STORE. A pinned field's value stays in `parishes`,
-- where every reader already looks. Copying it here would give one fact two
-- homes and a way to drift, which is the failure jurisdiction-colors.js was
-- written to end. A row here says only "hands off from below this tier", plus
-- enough about the losing source to explain itself on screen.
--
-- Absence means no ruling has been made and the newest read wins, exactly as
-- before. That is the same shape as jurisdiction_colors and
-- pdf_source_overrides: the table holds deliberate exceptions and nothing
-- else, and a reset DELETEs the row rather than writing a default into it.
--
-- SERVED PUBLICLY at /api/info-overrides, minus `updated_by`. The importers
-- are scripts run from a terminal with no Access token, and an override only
-- the Worker could see would be an override the import ignores — the same
-- argument that put pdf_source_overrides on a public route.
CREATE TABLE info_overrides (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  parish_id    TEXT NOT NULL REFERENCES parishes(id) ON DELETE CASCADE,

  -- What kind of claim is being ruled on.
  --   'field'     a column on parishes; `subject` names it
  --   'schedule'  a recurrence rule; `subject` is its slot
  target       TEXT NOT NULL CHECK(target IN ('field','schedule')),

  -- The key, shaped by `target`:
  --   field     'address', 'phone', 'website', …
  --   schedule  '<weekday>|<HH:MM>' in the parish's LOCAL time, e.g. '0|18:00'
  --
  -- The schedule form is the slot every importer already treats as a rule's
  -- identity, deliberately: a suppression keyed differently from the match it
  -- has to beat is a suppression that misses. It carries no title, so renaming
  -- "Vespers" to "Great Vespers" upstream does not slip a refused service back
  -- in. `source_label` keeps the title for the panel to quote.
  subject      TEXT NOT NULL,

  -- The ruling.
  --   'pin'       what is stored is right. A source at or below `tier` may not
  --               change it. An emptied field is a pin like any other — "there
  --               is no good phone number, stop filling one in".
  --   'suppress'  the source publishes this rule and it does not happen. Never
  --               create it, never revive it. Schedules only: for a field,
  --               "suppress" and "pin an empty value" are the same act, and one
  --               way to say a thing beats two.
  decision     TEXT NOT NULL CHECK(decision IN ('pin','suppress')),

  -- Where the BETTER information came from — one of source-tiers.js. Not the
  -- tier being refused: a scrape may write here only if it outranks this.
  tier         TEXT NOT NULL CHECK(tier IN ('admin','parish','jurisdiction','search','directory')),

  -- What the losing source says, kept so the panel can quote it: "the
  -- Archdiocese lists a 6pm Vespers here". Display only, stamped when the
  -- ruling was made, never read back as truth.
  source_label TEXT,

  -- Where the better information came from, in the same shape as
  -- parishes.info_source_* — a name, a reference, and when it was read. The
  -- reference is a URL where there is one and free text where there is not:
  -- a telephone call is a source, and it is the one that settled Elimbah.
  source_name  TEXT,
  source_ref   TEXT,
  checked_at   TEXT,

  -- Why. NOT NULL, and the whole point of the table being visible. An
  -- unexplained suppression is worse than none: the next admin sees an import
  -- refusing to apply half a page and has no way to tell a decision from a bug.
  note         TEXT NOT NULL,

  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_by   TEXT,

  -- One ruling per fact. Writing a second replaces the first, because two
  -- rulings that disagree about the same field is the condition this table
  -- was built to remove.
  --
  -- Table constraints, and everything after this point has to be one: SQLite
  -- stops accepting column definitions the moment the first table constraint
  -- appears.
  UNIQUE(parish_id, target, subject),
  CHECK(decision = 'pin' OR target = 'schedule')
);

CREATE INDEX idx_info_overrides_parish ON info_overrides(parish_id, target);
