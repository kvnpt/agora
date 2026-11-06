-- 036 — a poster forwarded to Agora's WhatsApp number becomes a draft
--
-- Copying a WhatsApp poster into the editor and then copying its caption is
-- two trips (Kevin, 6 Nov 2026). Forwarding the post to Agora's number is
-- one: the Worker reads the image and its words into a draft at the sender's
-- parish, replies with the link, and the app shows it on the parish's + and
-- on the sender's home page until somebody opens it
-- (worker/routes/ingest.mjs, worker/lib/whatsapp.mjs).
--
-- whatsapp_links: a phone that may send posters, and whose account they are
--   drafted as. Made by sending the code the account menu's "Link WhatsApp"
--   shows; the address is the one Access verified, as admin_roles keys it.
-- whatsapp_codes: those codes, one per account, for 15 minutes.
-- whatsapp_messages: every message the number received, by WhatsApp's own
--   id — so a webhook delivered twice is read once, a poster and a text sent a
--   moment apart are read together, and a phone can be held to 30 a day.
--   Rows older than 30 days are deleted as new ones arrive.
-- drafts.source / message_text / seen_at: 'whatsapp' for those drafts, what
--   was sent with the image, and when somebody first opened it.
--
--   npx wrangler d1 execute agora --remote --file=d1/migrations/036-whatsapp.sql
--

CREATE TABLE whatsapp_links (
  phone      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  name       TEXT,
  linked_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_whatsapp_links_email ON whatsapp_links(email);

CREATE TABLE whatsapp_codes (
  code       TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL
);

CREATE TABLE whatsapp_messages (
  id          TEXT PRIMARY KEY,
  phone       TEXT NOT NULL,
  type        TEXT NOT NULL,
  body        TEXT,
  media_id    TEXT,
  media_type  TEXT,
  sent_at     INTEGER NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  draft_id    INTEGER,
  outcome     TEXT
);
CREATE INDEX idx_whatsapp_messages_phone ON whatsapp_messages(phone, sent_at);

ALTER TABLE drafts ADD COLUMN source TEXT;
ALTER TABLE drafts ADD COLUMN message_text TEXT;
ALTER TABLE drafts ADD COLUMN seen_at TEXT;
