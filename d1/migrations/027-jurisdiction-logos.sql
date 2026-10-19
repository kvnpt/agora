-- 027 — jurisdiction_logos
--
-- A jurisdiction's logo, uploaded in /admin (Colours), for its collection card
-- on the page and its link preview: /greek, /serbian. d1/schema.sql says what
-- the row holds.
--
-- Safe in either order with the deploy that reads it: every reader treats a
-- missing table as no logos (worker/lib/juris-logos.mjs), and only the upload
-- needs it. Apply it before the merge all the same, so the upload works the
-- moment it ships.

CREATE TABLE jurisdiction_logos (
  jurisdiction TEXT PRIMARY KEY CHECK(jurisdiction IN
                 ('antiochian','greek','serbian','russian','romanian','macedonian')),
  logo_path    TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
