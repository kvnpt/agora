// Drafts: an event somebody is still adding.
//
// The add-event editor (public/shared/event-editor.js) keeps every card here
// as it is edited, and only Publish turns one into an `events` row. That is
// what lets a poster read by Claude be on file before anybody has looked at it
// without being on the site, and what makes closing the dialog lose nothing.
// d1/schema.sql says why these are tables of their own.
//
// Dates and times here are the parish's LOCAL wall clock — the form as the
// person sees it. Publishing converts them (localSpanToUtc in
// public/shared/tz.mjs); nothing in this file needs a zone.

import eventTypes from '../../public/shared/event-types.js';
import checks from '../../public/shared/event-checks.js';
import { isOwnVenue, matchParish } from './parish-match.mjs';

const { isEventType } = eventTypes;
const { isLocalDate, isLocalTime } = checks;

/**
 * The tables, made on first use as well as by migration 018 — the same
 * belt-and-braces as claims.mjs. Identical DDL to d1/schema.sql; the test
 * compares them. The add-event dialog depends on these, so a deploy that lands
 * before the migration must not take it down.
 */
export const DRAFTS_DDL = [
  `CREATE TABLE IF NOT EXISTS drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  parish_id   TEXT NOT NULL REFERENCES parishes(id) ON DELETE CASCADE,
  poster_path TEXT,
  read_status TEXT CHECK(read_status IN ('reading','read','failed')),
  read_kind   TEXT,
  read_notes  TEXT,
  created_by  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  read_parish TEXT
)`,
  'CREATE INDEX IF NOT EXISTS idx_drafts_parish ON drafts(parish_id)',
  `CREATE TABLE IF NOT EXISTS draft_events (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id          INTEGER NOT NULL REFERENCES drafts(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL DEFAULT 0,
  title             TEXT,
  date              TEXT,
  start_time        TEXT,
  end_time          TEXT,
  event_type        TEXT,
  description       TEXT,
  languages         TEXT,
  location_override TEXT,
  also_at           TEXT,
  replaces          TEXT,
  ask_reason        TEXT,
  printed_weekday   TEXT,
  year_printed      INTEGER,
  read_notes        TEXT,
  read_fields       TEXT,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
)`,
  'CREATE INDEX IF NOT EXISTS idx_draft_events_draft ON draft_events(draft_id, position)',
];

// Once per database per isolate: the DDL is a no-op after the first time, but
// it is still a round trip, and Workers Free counts those.
//
// read_parish came later (migration 019), and CREATE TABLE IF NOT EXISTS does
// not add a column to a table that exists — so it is looked for, and added
// when a database made before 019 lacks it. A read rather than a bare ALTER,
// so the usual answer is a query that works rather than one that errors.
const ensured = new WeakSet();
export async function ensureDraftTables(db) {
  if (ensured.has(db)) return;
  await db.batch(DRAFTS_DDL.map(sql => db.prepare(sql)));
  try {
    await db.prepare('SELECT read_parish FROM drafts LIMIT 0').all();
  } catch {
    await db.prepare('ALTER TABLE drafts ADD COLUMN read_parish TEXT').run();
  }
  ensured.add(db);
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

/** What a person can type into a card, and the shape each one is stored in. */
export const CARD_FIELDS = ['title', 'date', 'start_time', 'end_time', 'event_type', 'description',
  'languages', 'location_override', 'also_at', 'replaces', 'ask_reason'];
const JSON_FIELDS = new Set(['languages', 'also_at', 'replaces']);

/** The fields a poster read may fill — everything but the combine and the ask. */
const READ_FIELDS = ['title', 'date', 'start_time', 'end_time', 'event_type', 'description',
  'languages', 'location_override'];

const MAX_LEN = { title: 200, description: 2000, location_override: 300, ask_reason: 1000 };

/** "sid:YYYY-MM-DD" (a rule's occurrence) or an integer (a stored one-off). */
const isReplaceId = (v) => typeof v === 'string' && (/^\d+$/.test(v) || /^\d+:\d{4}-\d{2}-\d{2}$/.test(v));

const parseList = (v) => {
  if (!v) return [];
  try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; }
};
const parseObject = (v) => {
  if (!v) return null;
  try { const o = JSON.parse(v); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
};

/**
 * Check what a PATCH (or a create) wants to write, field by field.
 * Empty strings mean "cleared" and are stored as NULL.
 *
 * @returns {{ok: true, patch: object} | {ok: false, error: string, field: string}}
 */
export function validateCard(body) {
  const b = body && typeof body === 'object' ? body : {};
  const patch = {};
  const bad = (field, error) => ({ ok: false, field, error });
  for (const f of CARD_FIELDS) {
    if (!(f in b)) continue;
    let v = b[f];
    if (v === '' || v === undefined) v = null;
    if (JSON_FIELDS.has(f)) {
      if (v == null) { patch[f] = null; continue; }
      if (!Array.isArray(v) || !v.every(x => typeof x === 'string' || typeof x === 'number')) {
        return bad(f, `${f} must be a list.`);
      }
      const list = [...new Set(v.map(x => String(x).trim()).filter(Boolean))];
      if (f === 'replaces' && !list.every(isReplaceId)) return bad(f, 'That is not something an event can replace.');
      if (list.length > 400) return bad(f, 'That list is too long.');
      patch[f] = list.length ? JSON.stringify(f === 'languages' ? list.map(l => l.slice(0, 40)) : list) : null;
      continue;
    }
    if (v != null && typeof v !== 'string') return bad(f, `${f} must be text.`);
    if (v != null) v = v.trim() || null;
    if (v != null) {
      if (f === 'date' && !isLocalDate(v)) return bad(f, 'That is not a date.');
      if ((f === 'start_time' || f === 'end_time') && !isLocalTime(v)) return bad(f, 'Write the time like 19:30.');
      if (f === 'event_type' && !isEventType(v)) return bad(f, 'That is not one of the kinds of event.');
      if (MAX_LEN[f]) v = v.slice(0, MAX_LEN[f]);
    }
    patch[f] = v;
  }
  return { ok: true, patch };
}

/** A card as the editor reads it: JSON columns as lists. */
export function cardOut(r) {
  return {
    id: r.id,
    draft_id: r.draft_id,
    position: r.position,
    title: r.title, date: r.date, start_time: r.start_time, end_time: r.end_time,
    event_type: r.event_type, description: r.description,
    languages: parseList(r.languages),
    location_override: r.location_override,
    also_at: parseList(r.also_at).map(String),
    replaces: parseList(r.replaces).map(String),
    ask_reason: r.ask_reason,
    printed_weekday: r.printed_weekday,
    year_printed: r.year_printed,
    read_notes: parseList(r.read_notes),
    read_fields: parseList(r.read_fields),
    updated_at: r.updated_at,
  };
}

// A read the Worker never finished: older than this and still 'reading'.
const STALE_READ_MS = 2 * 60 * 1000;

export function draftOut(d, cards = []) {
  const stale = d.read_status === 'reading' && Date.now() - Date.parse(d.updated_at) > STALE_READ_MS;
  return {
    id: d.id,
    parish_id: d.parish_id,
    parish_name: d.parish_name,
    poster_path: d.poster_path,
    read_status: stale ? 'failed' : d.read_status,
    read_kind: d.read_kind,
    read_notes: parseList(d.read_notes),
    read_parish: parseObject(d.read_parish),
    created_by: d.created_by,
    created_at: d.created_at,
    updated_at: d.updated_at,
    cards: cards.map(cardOut),
  };
}

const DRAFT_SELECT = `SELECT d.*, p.name AS parish_name FROM drafts d JOIN parishes p ON p.id = d.parish_id`;

export async function getDraft(db, id) {
  const d = await db.prepare(`${DRAFT_SELECT} WHERE d.id = ?`).bind(id).first();
  if (!d) return null;
  const cards = await db.prepare('SELECT * FROM draft_events WHERE draft_id = ? ORDER BY position, id')
    .bind(id).all();
  return draftOut(d, cards.results || []);
}

/**
 * Every draft at the given parishes (null = every parish), newest first, with
 * their cards. Two queries, not one per draft — and filtered by parish, never
 * by a list of draft ids, because D1 binds at most 100 values and abandoned
 * drafts accumulate.
 */
export async function listDrafts(db, { parishIds = null } = {}) {
  if (parishIds && !parishIds.length) return [];
  const where = parishIds ? `WHERE d.parish_id IN (${parishIds.map(() => '?').join(',')})` : '';
  const args = parishIds || [];
  const [rows, cards] = await Promise.all([
    db.prepare(`${DRAFT_SELECT} ${where} ORDER BY d.updated_at DESC, d.id DESC`).bind(...args).all(),
    db.prepare(`SELECT c.* FROM draft_events c JOIN drafts d ON d.id = c.draft_id ${where}
      ORDER BY c.position, c.id`).bind(...args).all(),
  ]);
  const drafts = rows.results || [];
  const byDraft = new Map(drafts.map(d => [d.id, []]));
  for (const c of cards.results || []) if (byDraft.has(c.draft_id)) byDraft.get(c.draft_id).push(c);
  return drafts.map(d => draftOut(d, byDraft.get(d.id)));
}

/** A new draft with one card, holding whatever was typed first. */
export async function createDraft(db, { parishId, createdBy, card = {} }) {
  const d = await db.prepare(
    'INSERT INTO drafts (parish_id, created_by) VALUES (?, ?) RETURNING id'
  ).bind(parishId, createdBy).first();
  await insertCard(db, d.id, 0, card);
  return getDraft(db, d.id);
}

function insertStatement(db, draftId, position, fields) {
  const cols = ['draft_id', 'position', ...Object.keys(fields)];
  return db.prepare(
    `INSERT INTO draft_events (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING *`
  ).bind(draftId, position, ...Object.values(fields));
}

export async function insertCard(db, draftId, position, fields = {}) {
  const row = await insertStatement(db, draftId, position, fields).first();
  await touchDraft(db, draftId);
  return cardOut(row);
}

export const touchDraft = (db, draftId) =>
  db.prepare(`UPDATE drafts SET updated_at = ${NOW} WHERE id = ?`).bind(draftId).run();

/** The card and its draft, for scoping a card route. */
export async function cardWithDraft(db, cardId) {
  return db.prepare(
    `SELECT c.*, d.parish_id, d.poster_path FROM draft_events c JOIN drafts d ON d.id = c.draft_id WHERE c.id = ?`
  ).bind(cardId).first();
}

/**
 * Write what a person changed. A field they touch stops being "as the poster
 * read it": its mark and the model's note about it go. Touching the date also
 * drops what the poster printed beside it — the weekday and whether it had a
 * year — because the date is now theirs, and a warning about a date nobody
 * still holds would never go away.
 */
export async function updateCard(db, card, patch) {
  const set = { ...patch };
  const touched = Object.keys(patch);
  if (touched.length) {
    const marks = parseList(card.read_fields).filter(f => !touched.includes(f));
    const notes = parseList(card.read_notes).filter(n => !touched.includes(n.field));
    set.read_fields = marks.length ? JSON.stringify(marks) : null;
    set.read_notes = notes.length ? JSON.stringify(notes) : null;
    if ('date' in patch) { set.printed_weekday = null; set.year_printed = null; }
  }
  const cols = Object.keys(set);
  if (!cols.length) return cardOut(card);
  const row = await db.prepare(
    `UPDATE draft_events SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ${NOW}
     WHERE id = ? RETURNING *`
  ).bind(...Object.values(set), card.id).first();
  await touchDraft(db, card.draft_id);
  return cardOut(row);
}

const isEmpty = (v) => v == null || v === '' || v === '[]';

/** A read event's value in the column's shape. */
function readColumn(f, v) {
  if (v == null) return null;
  if (f === 'languages') return Array.isArray(v) && v.length ? JSON.stringify(v) : null;
  return v;
}

/**
 * Put a finished poster read into a draft.
 *
 * FILLS, NEVER OVERWRITES. The read's events go onto the draft's cards in
 * order, into the fields that are still empty, and whatever is left over
 * becomes new cards. So a title somebody typed before dropping the poster —
 * or while it was being read, which is why the cards are read back from D1
 * here rather than trusted from when the read began — is kept, and the read
 * fills in around it.
 *
 * Returns the draft as it now stands, or null if it was discarded mid-read.
 */
export async function mergeRead(db, draftId, read) {
  const draft = await db.prepare('SELECT id FROM drafts WHERE id = ?').bind(draftId).first();
  if (!draft) return null;
  const existing = (await db.prepare(
    'SELECT * FROM draft_events WHERE draft_id = ? ORDER BY position, id').bind(draftId).all()).results || [];
  const stmts = [];
  let nextPos = existing.reduce((m, c) => Math.max(m, c.position), -1) + 1;

  read.events.forEach((ev, i) => {
    const card = existing[i];
    const filled = [];
    const set = {};
    for (const f of READ_FIELDS) {
      const v = readColumn(f, ev[f]);
      if (v == null || (card && !isEmpty(card[f]))) continue;
      set[f] = v;
      filled.push(f);
    }
    const notes = (ev.read_notes || []).filter(n => filled.includes(n.field));
    if (filled.includes('date')) {
      set.printed_weekday = ev.printed_weekday;
      set.year_printed = ev.year_printed;
    }
    if (card) {
      if (!filled.length) return;
      const marks = [...new Set([...parseList(card.read_fields), ...filled])];
      const allNotes = [...parseList(card.read_notes), ...notes];
      set.read_fields = JSON.stringify(marks);
      set.read_notes = allNotes.length ? JSON.stringify(allNotes) : null;
      const cols = Object.keys(set);
      stmts.push(db.prepare(
        `UPDATE draft_events SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ${NOW} WHERE id = ?`
      ).bind(...Object.values(set), card.id));
    } else {
      set.read_fields = filled.length ? JSON.stringify(filled) : null;
      set.read_notes = notes.length ? JSON.stringify(notes) : null;
      stmts.push(insertStatement(db, draftId, nextPos++, set));
    }
  });
  stmts.push(db.prepare(
    `UPDATE drafts SET read_status = 'read', read_kind = ?, read_notes = ?, read_parish = ?,
       updated_at = ${NOW} WHERE id = ?`
  ).bind(read.kind, read.notes.length ? JSON.stringify(read.notes) : null,
    read.parish ? JSON.stringify(read.parish) : null, draftId));
  await db.batch(stmts);
  return getDraft(db, draftId);
}

/**
 * A finished read, squared with the parish it was read at — before it is
 * merged, so neither of these reaches a card:
 *
 *   * a venue that is only the parish's own address goes. The reader is told
 *     not to give one and does anyway ("86 Kenny St" at St Elias, whose
 *     address is 86 Kenny Street), and the card then reads as if the event
 *     were somewhere else;
 *   * "this poster is another parish's" is matched to a parish on file, and
 *     set on the read as `parish` {name, place, parish_id}. A match that is
 *     this parish after all means the reader was wrong, and is dropped.
 *
 * @param {object} read  normalizeRead()'s answer, changed in place
 * @param {{id, name, address}} parish  the draft's parish
 */
export async function placeRead(db, read, parish) {
  for (const ev of read.events) {
    if (isOwnVenue(ev.location_override, parish)) ev.location_override = null;
  }
  read.parish = null;
  if (!read.other_parish) return read;
  const list = (await db.prepare(
    "SELECT id, name, address FROM parishes WHERE id != '_unassigned'").all()).results || [];
  const venues = read.events.map(e => e.location_override).filter(Boolean);
  const id = matchParish(read.other_parish, venues, list);
  if (id !== parish.id) read.parish = { ...read.other_parish, parish_id: id };
  return read;
}

/**
 * Move a draft to another parish — the poster was dropped at the wrong one.
 *
 * The cards go as they are, less two things that only made sense where they
 * were:
 *   * a venue the read gave that is the NEW parish's own address. St Elias's
 *     address was "somewhere else" from the parish the poster was dropped at;
 *     once the draft is St Elias's, it is just the church. Only while it is
 *     still as read — a venue somebody typed is theirs;
 *   * the new parish in "also appears at": an event is not also at its own.
 * The read's "whose poster" stays when it named a parish on file — the editor
 * hides it once the draft is there, and shows it again after a wrong pick —
 * and goes when it named none: choosing a parish is the answer to it.
 *
 * @param {object} draft  getDraft()'s answer
 * @param {{id, name, address}} parish  where it goes
 */
export async function moveDraft(db, draft, parish) {
  const stmts = [];
  for (const card of draft.cards) {
    const set = {};
    if (card.also_at.includes(parish.id)) {
      const rest = card.also_at.filter(id => id !== parish.id);
      set.also_at = rest.length ? JSON.stringify(rest) : null;
    }
    if (card.read_fields.includes('location_override') && isOwnVenue(card.location_override, parish)) {
      const marks = card.read_fields.filter(f => f !== 'location_override');
      const notes = card.read_notes.filter(n => n.field !== 'location_override');
      set.location_override = null;
      set.read_fields = marks.length ? JSON.stringify(marks) : null;
      set.read_notes = notes.length ? JSON.stringify(notes) : null;
    }
    const cols = Object.keys(set);
    if (cols.length) {
      stmts.push(db.prepare(
        `UPDATE draft_events SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ${NOW} WHERE id = ?`
      ).bind(...Object.values(set), card.id));
    }
  }
  const hint = draft.read_parish && draft.read_parish.parish_id ? JSON.stringify(draft.read_parish) : null;
  stmts.push(db.prepare(
    `UPDATE drafts SET parish_id = ?, read_parish = ?, updated_at = ${NOW} WHERE id = ?`
  ).bind(parish.id, hint, draft.id));
  await db.batch(stmts);
  return getDraft(db, draft.id);
}

/** Where reading got to, when it did not finish with a read to merge. */
export const setReadStatus = (db, draftId, status) => db.prepare(
  `UPDATE drafts SET read_status = ?, updated_at = ${NOW} WHERE id = ?`
).bind(status, draftId).run();

/**
 * An R2 key for a draft's poster. One path segment, so /posters/:name serves
 * it (routes/assets.mjs), and never derived from an event id, so no single
 * event's poster delete can take it from the others it is shared with.
 */
export function draftPosterKey(parishId, ext) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `posters/${parishId}-${Date.now().toString(36)}-${rand}.${ext}`;
}

/** What a card becomes as a POST /api/admin/events body, less the instants. */
export function publishBody(card, parishId) {
  return {
    parish_id: parishId,
    title: card.title,
    event_type: card.event_type || 'other',
    description: card.description || null,
    languages: card.languages && card.languages !== '[]' ? card.languages : null,
    location_override: card.location_override || null,
    additive_parish_ids: parseList(card.also_at).map(String),
    replaced_event_ids: parseList(card.replaces).map(String),
  };
}
