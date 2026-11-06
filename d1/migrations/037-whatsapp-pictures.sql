-- 037 — several pictures in one forward are one draft
--
-- A WhatsApp post often carries two or three pictures (a poster and its
-- second page; the same event's flyer and map), with the caption on one of
-- them. Each became a draft of its own, and only the one with the caption
-- had the words (Kevin, 6 Nov 2026). Now the whole forward is one draft: its
-- pictures are read together, the first is the draft's poster, and the rest
-- wait here until the editor joins them all, side by side, into the one
-- poster the draft publishes — what Kevin did by hand for Crows Nest, a
-- screenshot of the two posters together (public/shared/event-editor.js
-- joinPictures; PUT /api/admin/drafts/:id/poster).
--
-- drafts.images: JSON list of '/posters/<key>' paths, the pictures after the
--   first, until they are joined into poster_path. NULL when there are none.
-- drafts.sender_name: the name WhatsApp has for whoever sent it ("Kevin"),
--   which the editor shows rather than the start of their email address.
--
--   npx wrangler d1 execute agora --remote --file=d1/migrations/037-whatsapp-pictures.sql
--

ALTER TABLE drafts ADD COLUMN images TEXT;
ALTER TABLE drafts ADD COLUMN sender_name TEXT;
