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

import checks from '../../public/shared/event-checks.js';

const { isLocalDate, isLocalTime } = checks;

export const KINDS = ['change', 'event'];

/** How many open suggestions one address may have waiting, across parishes. */
export const OPEN_LIMIT = 20;

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
    about: null, body: null, title: null, date: null, start_time: null, end_time: null, place: null,
    link: clean(b.link, MAX.link) || null,
  };
  if (s.link && !isHttpLink(s.link)) return bad('link', 'A link starts with https://');

  if (kind === 'change') {
    s.about = clean(b.about, MAX.about) || null;
    s.body = clean(b.body, MAX.body) || null;
    if (!s.body) return bad('body', 'Say what should change.');
    return { ok: true, suggestion: s };
  }

  s.title = clean(b.title, MAX.title) || null;
  s.date = clean(b.date, 10) || null;
  s.start_time = clean(b.start_time, 5) || null;
  s.end_time = clean(b.end_time, 5) || null;
  s.place = clean(b.place, MAX.place) || null;
  s.body = clean(b.body, MAX.body) || null;
  if (!s.title) return bad('title', 'What is the event called?');
  if (!s.date) return bad('date', 'Which day is it?');
  if (!isLocalDate(s.date)) return bad('date', 'That is not a date.');
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
    return `${who} suggests an event at ${at}: ${s.title}${when ? `, ${when}` : ''}.`;
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
];

export async function ensureSuggestionsTable(db) {
  await db.batch(SUGGESTIONS_DDL.map(sql => db.prepare(sql)));
}
