// "Suggest edits" — somebody telling whoever keeps a parish what is wrong with
// its page, or what is coming up that it does not show.
//
// THE FAST WAY IN. A claim ("let me keep this parish") asks the owner for a
// role and waits on them; most people who notice a wrong time do not want a
// role, they want the time fixed. So the parish sheet's button opens a form
// for the thing they came with — a change to something listed, or an event the
// page does not have — and becoming a parish contact is a box on the same
// form, unticked, behind which the claim's own fields wait (claims.mjs).
//
// A SUGGESTION IS A MESSAGE, NOT AN EDIT WAITING TO APPLY. Nothing here writes
// a rule, an override or an event. A person who may edit the parish reads it
// and makes the change with the tools they already have — or, for a suggested
// event, starts a draft from it, which is then an ordinary draft: checked in
// the editor and published one card at a time like any other. So this is not
// a moderation queue, and an edit by somebody who may edit is never routed
// through it.
//
// WHO HEARS IT is whoever may edit that parish: its contacts, and every editor
// and owner. The same mayTouchParish line the edit routes draw, so the list a
// contact sees is exactly the parishes they could act on.
//
// The door is the same as a claim's: Cloudflare Access verifies the address
// first, and the email on a suggestion is the one Access vouched for, never
// one typed into the form. That is what lets whoever reads it write back.
//
// Dates and times are the parish's LOCAL wall clock, as the person sees the
// page — the same as a draft's, which is what one becomes.
//
// A SUGGESTED EVENT CAN CARRY ITS POSTER. Whoever adds one has confirmed their
// address with Access like everybody else here, and Claude reads it into the
// form's EMPTY fields before they send it — the same reader the add-event
// editor uses, answered whole rather than streamed. Each upload is a row in
// suggestion_posters (d1/schema.sql has why it is a table of its own): the
// daily limit on reads, which suggestion it went with, and the sweep of
// posters added to a form nobody sent. Starting a draft from the suggestion
// hands the poster to the draft, which owns it from then on.

import checks from '../../public/shared/event-checks.js';
import { posterKeyOf } from './poster-range.mjs';

const { isLocalDate, isLocalTime } = checks;

export const KINDS = ['change', 'event'];

/** How many open suggestions one address may have waiting, across parishes. */
export const OPEN_LIMIT = 20;

/**
 * How many posters one address may add in a day. Every one is read, and every
 * read is paid for; anybody with an inbox can sign in.
 */
export const POSTER_DAILY_LIMIT = 10;

/** A poster nobody sent goes after this long — and only then does its row stop counting. */
export const POSTER_SWEEP_MS = 24 * 3600 * 1000;

const MAX = { name: 120, about: 200, body: 2000, title: 200, place: 300, link: 500 };

const clean = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

const isHttpLink = (v) => {
  try { return /^https?:$/.test(new URL(v).protocol); } catch { return false; }
};

/**
 * Check a suggestion before it is stored. Returns { ok, suggestion } or
 * { ok: false, field, error }. The email is NOT read from the body — the route
 * supplies the verified one.
 */
export function validateSuggestion(body) {
  const b = body && typeof body === 'object' ? body : {};
  const bad = (field, error) => ({ ok: false, field, error });
  const parishId = clean(b.parish_id, 200);
  if (!parishId) return bad('parish_id', 'Which parish is this about?');
  const kind = KINDS.includes(b.kind) ? b.kind : null;
  if (!kind) return bad('kind', 'Is this a change to something listed, or a new event?');

  const s = {
    parish_id: parishId,
    kind,
    name: clean(b.name, MAX.name) || null,
    about: null, body: null, title: null, date: null, start_time: null, end_time: null, place: null, poster_path: null,
    link: clean(b.link, MAX.link) || null,
  };
  if (s.link && !isHttpLink(s.link)) return bad('link', 'A link starts with https://');

  if (kind === 'change') {
    s.about = clean(b.about, MAX.about) || null;
    s.body = clean(b.body, MAX.body) || null;
    if (!s.body) return bad('body', 'Say what should change.');
    return { ok: true, suggestion: s };
  }

  // Which upload it is; the route checks it is this sender's, at this parish.
  s.poster_path = posterKeyOf(b.poster_path) ? clean(b.poster_path, 300) : null;
  s.title = clean(b.title, MAX.title) || null;
  s.date = clean(b.date, 10) || null;
  s.start_time = clean(b.start_time, 5) || null;
  s.end_time = clean(b.end_time, 5) || null;
  s.place = clean(b.place, MAX.place) || null;
  s.body = clean(b.body, MAX.body) || null;
  // With its poster, the poster says what and when: an event sent from the
  // dialog before the sign-in goes even when the read found neither, and
  // whoever keeps the parish reads it off the image.
  if (!s.poster_path) {
    if (!s.title) return bad('title', 'What is the event called?');
    if (!s.date) return bad('date', 'Which day is it?');
  }
  if (s.date && !isLocalDate(s.date)) return bad('date', 'That is not a date.');
  if (s.start_time && !isLocalTime(s.start_time)) return bad('start_time', 'Write the time like 19:30.');
  if (s.end_time && !isLocalTime(s.end_time)) return bad('end_time', 'Write the time like 21:00.');
  return { ok: true, suggestion: s };
}

/** One line for the list it lands in. */
export function describeSuggestion(s, parishName) {
  const who = s.name || 'Somebody';
  const at = parishName || s.parish_id;
  if (s.kind === 'event') {
    const when = [s.date, s.start_time].filter(Boolean).join(' ');
    return `${who} suggests an event at ${at}: ${s.title || 'see their poster'}${when ? `, ${when}` : ''}.`;
  }
  return `${who} suggests a change at ${at}${s.about ? ` — ${s.about}` : ''}.`;
}

/**
 * A suggested event as a draft card (worker/lib/drafts.mjs CARD_FIELDS), for
 * the person who starts a draft from it. A place in words is a place of its
 * own with no pin yet, which the editor offers to pin. The link goes on its
 * own line in the description, where links are drawn as links.
 */
export function cardFromSuggestion(s) {
  const description = [s.body, s.link].filter(Boolean).join('\n\n') || null;
  const card = { title: s.title, date: s.date, description };
  if (s.start_time) card.start_time = s.start_time;
  if (s.end_time) card.end_time = s.end_time;
  if (s.place) card.location_override = s.place;
  return card;
}

/**
 * What a poster read offers the suggestion form: each event as the form's own
 * fields, in the order the poster gives them. A dated regular service is an
 * event to the person sending it — the editor works out later that it is an
 * occurrence. The read is in English (the poster keeps the original).
 */
export function formFromRead(read) {
  return (read.events || []).map(e => ({
    title: e.title || '',
    date: e.date || '',
    start_time: e.start_time || '',
    end_time: e.end_time || '',
    place: e.location_override || '',
    body: e.description || '',
  })).filter(e => e.title || e.date);
}

/** An R2 key for a suggester's poster: one path segment, like a draft's. */
export function suggestionPosterKey(parishId, ext) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `posters/suggested-${parishId}-${Date.now().toString(36)}-${rand}.${ext}`;
}

/**
 * The scope clause for "suggestions this person may act on": every parish for
 * an owner or editor, their own for a contact. Bound as one JSON array so the
 * statement is the same whatever the list's length.
 *
 * @returns {{ where: string, binds: any[] }}
 */
export function scopeClause(who, column = 'parish_id') {
  if (who && who.role === 'parish') {
    return { where: `${column} IN (SELECT value FROM json_each(?))`, binds: [JSON.stringify(who.parishIds || [])] };
  }
  return { where: '1 = 1', binds: [] };
}

/**
 * The table, made on first use as well as by migration 024 — the same
 * belt-and-braces as claims.mjs. Identical DDL to d1/schema.sql; a test
 * compares them.
 */
export const SUGGESTIONS_DDL = [
  `CREATE TABLE IF NOT EXISTS parish_suggestions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  parish_id     TEXT NOT NULL REFERENCES parishes(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  name          TEXT,
  kind          TEXT NOT NULL CHECK(kind IN ('change','event')),
  about         TEXT,
  body          TEXT,
  title         TEXT,
  date          TEXT,
  start_time    TEXT,
  end_time      TEXT,
  place         TEXT,
  link          TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','dismissed','withdrawn')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  decided_by    TEXT,
  decided_at    TEXT,
  decision_note TEXT,
  draft_id      INTEGER
)`,
  'CREATE INDEX IF NOT EXISTS idx_parish_suggestions_open ON parish_suggestions(status, parish_id, created_at)',
  `CREATE TABLE IF NOT EXISTS suggestion_posters (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  parish_id     TEXT NOT NULL REFERENCES parishes(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  poster_path   TEXT,
  suggestion_id INTEGER,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
)`,
  'CREATE INDEX IF NOT EXISTS idx_suggestion_posters_email ON suggestion_posters(email, created_at)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_suggestion_posters_suggestion ON suggestion_posters(suggestion_id)',
];

// Once per database per isolate, like drafts.mjs: the reads join the posters
// table, so they make sure of it too, and a round trip each time is a cost.
const ensured = new WeakSet();
export async function ensureSuggestionsTable(db) {
  if (ensured.has(db)) return;
  await db.batch(SUGGESTIONS_DDL.map(sql => db.prepare(sql)));
  ensured.add(db);
}
