-- 028 — languages keep to the fixed list
--
-- Every languages column is a JSON array of the names in
-- public/shared/languages.js. Production held two that are not: "Russian"
-- (what the ROCOR import wrote for every Russian parish) and "Slavonic". The
-- Russian parishes pray in Church Slavonic, so both become "Church Slavonic".
-- And the arrays are written as JSON.stringify writes them, without the space
-- after a comma, so one language list is one string wherever it is compared.
--
-- Data only; no column changes. Safe in either order with the deploy: the
-- page reads "Russian" and "Slavonic" as Church Slavonic too.

UPDATE parishes SET languages =
  replace(replace(replace(languages, '", "', '","'), '"Russian"', '"Church Slavonic"'), '"Slavonic"', '"Church Slavonic"');

UPDATE schedules SET languages =
  replace(replace(replace(languages, '", "', '","'), '"Russian"', '"Church Slavonic"'), '"Slavonic"', '"Church Slavonic"')
  WHERE languages IS NOT NULL;

UPDATE events SET languages =
  replace(replace(replace(languages, '", "', '","'), '"Russian"', '"Church Slavonic"'), '"Slavonic"', '"Church Slavonic"')
  WHERE languages IS NOT NULL;

UPDATE schedule_overrides SET patch_languages =
  replace(replace(replace(patch_languages, '", "', '","'), '"Russian"', '"Church Slavonic"'), '"Slavonic"', '"Church Slavonic"')
  WHERE patch_languages IS NOT NULL;

UPDATE draft_events SET languages =
  replace(replace(replace(languages, '", "', '","'), '"Russian"', '"Church Slavonic"'), '"Slavonic"', '"Church Slavonic"')
  WHERE languages IS NOT NULL;
