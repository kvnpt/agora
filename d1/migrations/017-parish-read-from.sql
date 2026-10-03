-- 017 — one setting per parish for where its details and times come from
--
-- Replaces the info_overrides rulings (source tiers, field pins, slot
-- suppressions) as what an import asks before writing. See
-- public/shared/read-from.js and docs/sources-and-ingestion.md.
--
-- Additive, with a default: safe to apply before the merge — the deployed code
-- does not read it yet, and the import scripts only start honouring it when
-- the branch that adds it is merged.

ALTER TABLE parishes ADD COLUMN read_from TEXT NOT NULL DEFAULT 'directory'
  CHECK(read_from IN ('directory','website','hand'));

-- Starting values, from what the rows already say.

-- A parish whose details came from its own website: the directory had already
-- stopped writing to these (governingTier), so keep that.
UPDATE parishes SET read_from = 'website' WHERE info_source_type = 'website';

-- A person has already taken them over: details edited in /admin, a pin or a
-- ruling on file, a timetable last stamped by a person, or a parish contact.
UPDATE parishes SET read_from = 'hand' WHERE info_source_type = 'person';
UPDATE parishes SET read_from = 'hand' WHERE id IN (SELECT parish_id FROM info_overrides);
UPDATE parishes SET read_from = 'hand' WHERE id IN (
  SELECT parish_id FROM schedules WHERE source_name IN ('Admin', 'Parish Contact'));
UPDATE parishes SET read_from = 'hand' WHERE id IN (
  SELECT j.value FROM admin_roles r, json_each(r.parish_ids) j
  WHERE r.role = 'parish' AND json_valid(r.parish_ids));
