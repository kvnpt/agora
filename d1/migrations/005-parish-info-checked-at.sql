-- 005 — parishes.info_checked_at, and the dates to fill it with
--
-- A parish row said where its details came from and never said how old they
-- were. The sheet rendered "Info from Greek Orthodox Archdiocese of Australia
-- · unverified" for all 196 rows, which reads as a warning about the data and
-- was actually a statement about a column nobody had ever written to:
-- `info_verified_at` means "a person confirmed this against the place itself",
-- and no person has. Meanwhile the thing a reader actually wants to know —
-- when did anyone last look at the source — was known for every row and stored
-- nowhere.
--
-- So: a new column carrying exactly what `schedules.source_checked_at` carries,
-- rendered exactly the way the service-times line already renders it
-- ("Updated 3 months ago · Antiochian Archdiocese"). `info_verified_at` stays,
-- unrendered, as the import guard it always was — see d1/schema.sql on why
-- those cannot be one column.
--
--   npx wrangler d1 execute agora --remote --file=d1/migrations/005-parish-info-checked-at.sql
--
-- ADDITIVE ON PURPOSE. A rename would have broken the live site between the
-- moment it ran and the moment the deploy carrying the new column name landed:
-- the Worker selects its parish columns by name, so either order leaves one
-- side selecting a column that does not exist. Adding costs one column and no
-- outage.

ALTER TABLE parishes ADD COLUMN info_checked_at TEXT;

-- ── The dates ────────────────────────────────────────────────────────────
--
-- Every one of these is a recorded read, not an estimate. Where the scrape's
-- own `scraped_at` survives it is used verbatim; where it does not, the commit
-- that recorded the run is — an upper bound accurate to the hour, and the
-- honest reading of "when did we last look", since the write cannot predate
-- the read.

-- The Antiochian directory, 24 rows. This timestamp is the `scraped_at` of
-- cache/antiochian, and it is the same instant the 67 Antiochian service-time
-- rules carry in schedules.source_checked_at — one read of one set of pages
-- produced both, so a parish sheet showing an info line and a service-times
-- line for this jurisdiction now shows one date twice rather than two dates.
UPDATE parishes SET info_checked_at = '2026-09-12T10:42:12.084Z'
 WHERE info_source_name = 'Antiochian Orthodox Archdiocese of Australia, New Zealand and the Philippines';

-- The Greek Archdiocese directory, 133 rows. docs/parish-ingestion.md dates the
-- run 12 September 2026; c1e2d45 recorded it at 04:49Z the same day.
UPDATE parishes SET info_checked_at = '2026-09-12T04:49:25Z'
 WHERE info_source_name = 'Greek Orthodox Archdiocese of Australia';

-- The ROCOR run, 37 rows across three sources — the diocese's own directory,
-- orthodox-world.org for the addresses it does not publish, and eight parish
-- websites read in the same pass. One run, one date: 9ba6f9f, 07:24Z.
-- The four suburb-centroid rows written later (dfec2c7, 09:08Z) were scraped
-- in that same pass; only the write was deferred.
UPDATE parishes SET info_checked_at = '2026-09-12T07:24:43Z'
 WHERE jurisdiction = 'russian' AND info_checked_at IS NULL;

-- The two Greek parishes that came from their own published programme rather
-- than from the directory, seeded by hand. Each row's date is the commit that
-- wrote its website into seeds/parishes.js, which is when somebody was reading
-- that site.
UPDATE parishes SET info_checked_at = '2026-09-11T06:04:04Z' WHERE id = 'greek-gopssc-buderim';
UPDATE parishes SET info_checked_at = '2026-09-11T08:49:48Z' WHERE id = 'greek-stparaskevi-blacktown';

-- `_unassigned` keeps its NULL. It is a sentinel, not a parish, and never
-- renders — the same reason 004 left its colour alone.

-- ── One source, one name ─────────────────────────────────────────────────
--
-- The parish rows named this source in full while the 67 service-time rules
-- scraped from the same pages named it "Antiochian Archdiocese". Two spellings
-- of one source read as two sources in a sheet that shows both lines, and 74
-- characters of it wraps to three lines of 11px muted text. The short label
-- wins because it is the one already on screen.
UPDATE parishes SET info_source_name = 'Antiochian Archdiocese'
 WHERE info_source_name = 'Antiochian Orthodox Archdiocese of Australia, New Zealand and the Philippines';
