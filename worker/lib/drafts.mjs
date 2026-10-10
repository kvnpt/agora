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
import { isValidOccurrence } from '../../public/shared/project.mjs';

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
  read_parish TEXT,
  read_language TEXT,
  read_services TEXT,
  read_details TEXT
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
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  occurrence        TEXT,
  feast             TEXT
)`,
  'CREATE INDEX IF NOT EXISTS idx_draft_events_draft ON draft_events(draft_id, position)',
];

// Once per database per isolate: the DDL is a no-op after the first time, but
// it is still a round trip, and Workers Free counts those.
//
// Columns came later (019: read_parish; 020: what a sign or a programme is
// read into), and CREATE TABLE IF NOT EXISTS does not add a column to a table
// that exists — so they are looked for, and added when a database made before
// the migration lacks them. A read rather than a bare ALTER, so the usual
// answer is a query that works rather than one that errors.
const LATER_COLUMNS = {
  drafts: ['read_parish', 'read_language', 'read_services', 'read_details'],
  draft_events: ['occurrence', 'feast'],
};
const ensured = new WeakSet();
export async function ensureDraftTables(db) {
  if (ensured.has(db)) return;
  await db.batch(DRAFTS_DDL.map(sql => db.prepare(sql)));
  for (const [table, cols] of Object.entries(LATER_COLUMNS)) {
    try {
      await db.prepare(`SELECT ${cols.join(', ')} FROM ${table} LIMIT 0`).all();
    } catch {
      const have = new Set(((await db.prepare(`PRAGMA table_info(${table})`).all()).results || []).map(c => c.name));
      for (const c of cols) {
        if (!have.has(c)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${c} TEXT`).run();
      }
    }
  }
  ensured.add(db);
}

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";

/**
 * What a person can type into a card, and the shape each one is stored in.
 *
 * `occurrence` is "sid:YYYY-MM-DD" when the card is a regular service on its
 * own date — a programme's Sunday with its saint — rather than an event of its
 * own: publishing writes it onto that occurrence (an override), not beside it.
 * `feast` is the commemoration such a card carries.
 */
export const CARD_FIELDS = ['title', 'feast', 'date', 'start_time', 'end_time', 'event_type', 'description',
  'languages', 'location_override', 'also_at', 'replaces', 'ask_reason', 'occurrence'];
const JSON_FIELDS = new Set(['languages', 'also_at', 'replaces']);

/** The fields a poster read may fill — everything but the combine and the ask. */
const READ_FIELDS = ['title', 'feast', 'date', 'start_time', 'end_time', 'event_type', 'description',
  'languages', 'location_override', 'occurrence'];

const MAX_LEN = { title: 200, feast: 200, description: 2000, location_override: 300, ask_reason: 1000 };

/** A rule's occurrence: "sid:YYYY-MM-DD". */
const OCCURRENCE = /^\d+:\d{4}-\d{2}-\d{2}$/;

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
      if (f === 'occurrence' && !OCCURRENCE.test(v)) return bad(f, 'That is not a service on the timetable.');
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
    title: r.title, feast: r.feast || null, date: r.date, start_time: r.start_time, end_time: r.end_time,
    event_type: r.event_type, description: r.description,
    languages: parseList(r.languages),
    location_override: r.location_override,
    also_at: parseList(r.also_at).map(String),
    replaces: parseList(r.replaces).map(String),
    ask_reason: r.ask_reason,
    occurrence: r.occurrence || null,
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
    // What the image was written in, when it was not English — and what a
    // sign said: weekly services to add to the timetable and the parish's
    // details, both proposals until a person adds them (public/shared/signs.js).
    read_language: d.read_language || null,
    read_services: parseList(d.read_services),
    read_details: parseObject(d.read_details),
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
       read_language = ?, read_services = ?, read_details = ?, updated_at = ${NOW} WHERE id = ?`
  ).bind(read.kind, read.notes.length ? JSON.stringify(read.notes) : null,
    read.parish ? JSON.stringify(read.parish) : null,
    read.language || null,
    read.services && read.services.length ? JSON.stringify(read.services) : null,
    read.details ? JSON.stringify(read.details) : null, draftId));
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

/** "Orthros & Divine Liturgy" and "ORTHROS AND DIVINE LITURGY" are one service. */
const titleKey = (t) => String(t || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z]+/g, ' ').trim();

/**
 * Which of a read's events are a regular service on its own date.
 *
 * A month's programme lists every Sunday's Liturgy with that Sunday's saint.
 * Published as events, each would be a second card beside the service it
 * describes — the duplicate the combine exists to prevent. So an event that is
 * an occurrence of one of the parish's rules gets `occurrence` ("sid:date"),
 * and publishing writes it onto that occurrence instead (an override, the way
 * an admin's edit of one Sunday is written).
 *
 * An occurrence of a rule ON that date that starts at the same time, or else
 * the one occurrence that day with the same service name (a programme that
 * moves it). Never a guess between two, and never one occurrence twice. A
 * matched event takes the rule's own title when it names the same service,
 * and the rule's kind, so the override carries only what the programme
 * actually changes — the saint, a time — and not "and" for "&".
 *
 * @param {object} read   normalizeRead()'s answer, changed in place
 * @param {Array} rules   the parish's active rules (schedules rows)
 */
export function matchOccurrences(read, rules) {
  const used = new Set();
  for (const ev of read.events) {
    ev.occurrence = null;
    if (!ev.date || !ev.start_time) continue;
    const that = (rules || []).filter(r => r.active !== 0 && isValidOccurrence(r, ev.date));
    const same = (r) => titleKey(r.title) === titleKey(ev.title);
    const at = that.filter(r => r.start_time === ev.start_time);
    const named = that.filter(same);
    const hit = at.length === 1 ? at[0]
      : at.length > 1 ? (at.filter(same).length === 1 ? at.find(same) : null)
        : named.length === 1 ? named[0] : null;
    if (!hit || used.has(`${hit.id}:${ev.date}`)) continue;
    used.add(`${hit.id}:${ev.date}`);
    ev.occurrence = `${hit.id}:${ev.date}`;
    if (same(hit)) ev.title = hit.title;
    if (hit.event_type) ev.event_type = hit.event_type;
  }
  return read;
}

/**
 * Move a draft to another parish — the poster was dropped at the wrong one.
 *
 * The cards go as they are, less three things that only made sense where they
 * were:
 *   * a venue the read gave that is the NEW parish's own address. St Elias's
 *     address was "somewhere else" from the parish the poster was dropped at;
 *     once the draft is St Elias's, it is just the church. Only while it is
 *     still as read — a venue somebody typed is theirs;
 *   * the new parish in "also appears at": an event is not also at its own;
 *   * the service a card was matched to (`occurrence`): that rule is the old
 *     parish's, so the card is an event of its own again until it is matched
 *     at the new one (a read again does that).
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
    if (card.occurrence) set.occurrence = null;
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

/**
 * A card's title as an event's. An event has no feast of its own — only an
 * occurrence of a rule does (`patch_feast`) — so a one-off that carries one
 * says it in its title, as the editor's hint tells the person.
 */
export function oneOffTitle(card) {
  const title = String(card.title || '').trim();
  const feast = String(card.feast || '').trim();
  if (!feast || titleKey(title).includes(titleKey(feast))) return title;
  return `${title} — ${feast}`.slice(0, 200);
}

/** What a card becomes as a POST /api/admin/events body, less the instants. */
export function publishBody(card, parishId) {
  return {
    parish_id: parishId,
    title: oneOffTitle(card),
    event_type: card.event_type || 'other',
    description: card.description || null,
    languages: card.languages && card.languages !== '[]' ? card.languages : null,
    location_override: card.location_override || null,
    additive_parish_ids: parseList(card.also_at).map(String),
    replaced_event_ids: parseList(card.replaces).map(String),
  };
}

/**
 * What an occurrence card writes onto its service, as an applyAdminEdit body
 * (lib/overrides.mjs), less the instants.
 *
 * Only what the card SAYS. An empty field on the card is not "clear it": the
 * occurrence may already carry a note or a poster somebody put there, and a
 * programme that does not mention it has not removed it — the same rule as
 * "a poster read only ever fills empty fields". A field equal to the rule's is
 * written as no patch at all (mergePatch compares).
 */
export function occurrenceBody(card, posterPath) {
  const body = {};
  const has = (v) => v != null && String(v).trim() !== '' && v !== '[]';
  if (has(card.title)) body.title = card.title;
  if (has(card.feast)) body.feast = card.feast;
  if (has(card.description)) body.description = card.description;
  if (has(card.event_type)) body.event_type = card.event_type;
  if (has(card.languages)) body.languages = card.languages;
  if (has(card.location_override)) body.location_override = card.location_override;
  if (posterPath) body.poster_path = posterPath;
  return body;
}
