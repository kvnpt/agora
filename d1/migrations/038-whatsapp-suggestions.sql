-- 038 — suggesting on WhatsApp alone, with no email
--
-- Linking a phone needs an account first, and an account needs an email
-- (Kevin, 6 Nov 2026: "what if they just solely used WhatsApp for their
-- verification and suggestion flow?"). Now a phone nobody linked is a sender
-- of its own: a poster it forwards, or words naming a parish, become a
-- suggestion to whoever keeps that parish, and the Suggest dialog's "Confirm
-- on WhatsApp" files what was typed there once its code arrives from the
-- phone (worker/routes/ingest.mjs). Its suggestions are filed as
-- "wa:<number>" where an emailed one has the address Access verified.
--
-- parish_suggestions.images: a forward's pictures after the first (the
--   poster), as a JSON list of '/posters/<key>' paths, NULL when none —
--   handed to the draft started from it, like drafts.images (037).
-- whatsapp_messages.suggestion_id: the suggestion a message went into, as
--   draft_id is the draft.
-- whatsapp_tickets: what the dialog sent, waiting for its code.
--
--   npx wrangler d1 execute agora --remote --file=d1/migrations/038-whatsapp-suggestions.sql
--

ALTER TABLE parish_suggestions ADD COLUMN images TEXT;
ALTER TABLE whatsapp_messages ADD COLUMN suggestion_id INTEGER;

CREATE TABLE whatsapp_tickets (
  code          TEXT PRIMARY KEY,
  secret        TEXT NOT NULL UNIQUE,
  parish_id     TEXT NOT NULL,
  about         TEXT,
  body          TEXT,
  name          TEXT,
  poster_path   TEXT,
  ip            TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  expires_at    TEXT NOT NULL,
  phone         TEXT,
  suggestion_id INTEGER,
  outcome       TEXT
);
CREATE INDEX idx_whatsapp_tickets_ip ON whatsapp_tickets(ip, created_at);
