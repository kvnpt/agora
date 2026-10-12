-- 023 — venues: an event or a service somewhere other than its parish
--
-- Somewhere else used to be words: location_override, "Antiochian Village,
-- 3 Hall Rd, Kangaroo Valley". The pin stayed the parish's (a rule's on
-- purpose, an event's geocoded when it could be), so the map could not say
-- where anything was happening but at home.
--
-- Now a place is one of two things. Another parish on file —
-- location_parish_id, whose own name, address and pin it is. Or a place of
-- its own: location_override's words and a pin, looked up from the address or
-- put on the door by hand, which the map draws as a square marker of its own.
-- On the day, both the parish running it and the venue toll; once it starts
-- the venue is live and the host shows it is on elsewhere (public/map.js).
--
-- On rules, on one date's override (as a unit with patch_location_override),
-- on events, and on draft cards. New nullable columns, appended, so applying
-- this before the merge is always safe; worker/lib/drafts.mjs adds the draft
-- ones on first use when they are missing.

ALTER TABLE schedules ADD COLUMN location_parish_id TEXT;
ALTER TABLE schedules ADD COLUMN location_lat REAL;
ALTER TABLE schedules ADD COLUMN location_lng REAL;

ALTER TABLE schedule_overrides ADD COLUMN patch_location_parish_id TEXT;
ALTER TABLE schedule_overrides ADD COLUMN patch_location_lat REAL;
ALTER TABLE schedule_overrides ADD COLUMN patch_location_lng REAL;

ALTER TABLE events ADD COLUMN location_parish_id TEXT;
ALTER TABLE events ADD COLUMN location_lat REAL;
ALTER TABLE events ADD COLUMN location_lng REAL;

ALTER TABLE draft_events ADD COLUMN location_parish_id TEXT;
ALTER TABLE draft_events ADD COLUMN location_lat REAL;
ALTER TABLE draft_events ADD COLUMN location_lng REAL;

-- What was already somewhere else with a pin of its own keeps that pin as the
-- place's, and so gets its square: an event whose words name a place and whose
-- pin is not its parish's was geocoded there (the Monash chaplaincy's
-- services, a camp at the Antiochian Village). Words still on the parish's
-- pin stay words, as does every rule — a rule's pin was always the parish's.
UPDATE events SET location_lat = lat, location_lng = lng
WHERE location_override IS NOT NULL AND location_override != ''
  AND lat IS NOT NULL AND lng IS NOT NULL
  AND location_lat IS NULL AND location_parish_id IS NULL
  AND NOT EXISTS (SELECT 1 FROM parishes p WHERE p.id = events.parish_id
                  AND abs(p.lat - events.lat) < 1e-6 AND abs(p.lng - events.lng) < 1e-6);
