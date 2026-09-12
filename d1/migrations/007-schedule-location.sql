-- 007 — schedules.location_override
--
-- A recurrence rule could say when a service is and not where. The parish's
-- address was the only answer available, which is wrong whenever a service is
-- somewhere else: a parish without its own building (Good Shepherd meets in a
-- university religious centre, the Sunshine Coast parish in a borrowed
-- Anglican church), a weekday service in a hall down the road, a monthly
-- liturgy at a cemetery chapel, a Vespers hosted by the parish next door.
--
-- `events.location_override` has always been able to say this for a one-off,
-- and `schedule_overrides.patch_location_override` for a single occurrence.
-- This is the missing middle: where the rule normally meets.
--
--   npx wrangler d1 execute agora --remote --file=d1/migrations/007-schedule-location.sql
--
-- NULL on every existing row, which means what it has always meant — the
-- parish's address — so this changes nothing until somebody fills one in.

ALTER TABLE schedules ADD COLUMN location_override TEXT;
