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
import langList from '../../public/shared/languages.js';
import checks from '../../public/shared/event-checks.js';
import { isOwnVenue, matchParish } from './parish-match.mjs';
import { isValidOccurrence } from '../../public/shared/project.mjs';
import { localPartsOf } from '../../public/shared/tz.mjs';
import { endOf, lengthText, toMinutes, fromMinutes, servicesNamed } from './durations.mjs';

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
  feast             TEXT,
  end_date          TEXT,
  location_parish_id TEXT,
  location_lat      REAL,
  location_lng      REAL,
  parish_scoped     INTEGER,
  discard           INTEGER,
  host_parish_id    TEXT,
  host_event_id     INTEGER
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
  draft_events: ['occurrence', 'feast', 'end_date', 'location_parish_id', 'location_lat', 'location_lng', 'parish_scoped', 'discard',
    'host_parish_id', 'host_event_id'],
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
        // A pin is a number, the pill and the bin a 0 or 1, an event an id; everything else these add is text.
        const type = /_(lat|lng)$/.test(c) ? 'REAL' : FLAG_FIELDS.has(c) || c === 'host_event_id' ? 'INTEGER' : 'TEXT';
        if (!have.has(c)) await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${c} ${type}`).run();
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
 * `feast` is the subtitle such a card carries: the commemoration, or the topic.
 * `parish_scoped` is its Public / Parish only pill: 1 or 0 once tapped, null
 * while nobody has, which publishing leaves to the kind (createOneOff).
 * `discard` is the bin on its row (Kevin, 3 Nov 2026): 1 marked to be thrown
 * away at Publish, 0 kept, null while nobody has tapped it — which the editor
 * reads as marked when the date has passed. Nothing publishes a marked card.
 * `host_parish_id` is set when the event is ANOTHER parish's, which this one
 * takes part in (Kevin, 3 Nov 2026: St Andrew, Gladesville's programme lists
 * St Nectarios, Burwood's feast): publishing puts it at that parish with this
 * one taking part — or, with `host_event_id`, the event of theirs already on
 * file, adds this parish to it and makes nothing new.
 */
export const CARD_FIELDS = ['title', 'feast', 'date', 'end_date', 'start_time', 'end_time', 'event_type', 'description',
  'languages', 'location_override', 'also_at', 'replaces', 'ask_reason', 'occurrence',
  'location_parish_id', 'location_lat', 'location_lng', 'parish_scoped', 'discard',
  'host_parish_id', 'host_event_id'];
/** A pin's two halves: numbers, where every other field here is text. */
const NUMBER_FIELDS = new Set(['location_lat', 'location_lng']);
/** The pill and the bin: yes, no, or not said. */
const FLAG_FIELDS = new Set(['parish_scoped', 'discard']);
const JSON_FIELDS = new Set(['languages', 'also_at', 'replaces']);

/**
 * The fields a poster read may fill — everything but the ask. The combine only
 * for an event at another parish (placeHosts): whose it is, and this parish's
 * own service the poster puts it at the time of, which it takes the place of.
 */
const READ_FIELDS = ['title', 'feast', 'date', 'end_date', 'start_time', 'end_time', 'event_type', 'description',
  'languages', 'location_override', 'occurrence', 'host_parish_id', 'host_event_id', 'replaces'];

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
    if (FLAG_FIELDS.has(f)) {
      if (v != null && ![true, false, 0, 1].includes(v)) return bad(f, `${f} is yes or no.`);
      patch[f] = v == null ? null : v ? 1 : 0;
      continue;
    }
    if (NUMBER_FIELDS.has(f)) {
      const n = v == null ? null : Number(v);
      if (n != null && !Number.isFinite(n)) return bad(f, 'A pin is two numbers.');
      if (n != null && Math.abs(n) > (f === 'location_lat' ? 90 : 180)) return bad(f, 'That pin is not on the map.');
      patch[f] = n;
      continue;
    }
    if (JSON_FIELDS.has(f)) {
      if (v == null) { patch[f] = null; continue; }
      if (!Array.isArray(v) || !v.every(x => typeof x === 'string' || typeof x === 'number')) {
        return bad(f, `${f} must be a list.`);
      }
      const list = [...new Set(v.map(x => String(x).trim()).filter(Boolean))];
      if (f === 'replaces' && !list.every(isReplaceId)) return bad(f, 'That is not something an event can replace.');
      if (list.length > 400) return bad(f, 'That list is too long.');
      patch[f] = f === 'languages' ? langList.clean(list) : (list.length ? JSON.stringify(list) : null);
      continue;
    }
    if (f === 'host_event_id') {
      const n = v == null ? null : Number(v);
      if (n != null && !(Number.isInteger(n) && n > 0)) return bad(f, 'That is not an event on file.');
      patch[f] = n;
      continue;
    }
    if (v != null && typeof v !== 'string') return bad(f, `${f} must be text.`);
    if (v != null) v = v.trim() || null;
    if (v != null) {
      if ((f === 'date' || f === 'end_date') && !isLocalDate(v)) return bad(f, 'That is not a date.');
      if ((f === 'start_time' || f === 'end_time') && !isLocalTime(v)) return bad(f, 'Write the time like 19:30.');
      if (f === 'event_type' && !isEventType(v)) return bad(f, 'That is not one of the kinds of event.');
      if (f === 'occurrence' && !OCCURRENCE.test(v)) return bad(f, 'That is not a service on the timetable.');
      if (f === 'host_parish_id' && !/^[a-z0-9_-]{1,120}$/.test(v)) return bad(f, 'That is not a parish.');
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
    title: r.title, feast: r.feast || null, date: r.date, end_date: r.end_date || null,
    start_time: r.start_time, end_time: r.end_time,
    event_type: r.event_type, description: r.description,
    languages: parseList(r.languages),
    location_override: r.location_override,
    also_at: parseList(r.also_at).map(String),
    replaces: parseList(r.replaces).map(String),
    ask_reason: r.ask_reason,
    occurrence: r.occurrence || null,
    location_parish_id: r.location_parish_id || null,
    location_lat: r.location_lat != null ? r.location_lat : null,
    location_lng: r.location_lng != null ? r.location_lng : null,
    parish_scoped: r.parish_scoped == null ? null : r.parish_scoped ? 1 : 0,
    discard: r.discard == null ? null : r.discard ? 1 : 0,
    host_parish_id: r.host_parish_id || null,
    host_event_id: r.host_event_id != null ? Number(r.host_event_id) : null,
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
    // Five kinds of poster became one (poster-read.mjs READ_KINDS); a draft read
    // before that says which of the five, and is a poster.
    read_kind: d.read_kind == null ? null : (['timetable', 'not_an_event'].includes(d.read_kind) ? d.read_kind : 'poster'),
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
    // Made another parish's event by hand ("It is their event"): the same
    // question the read asks of one it made theirs (placeHosts).
    // Not when it is this parish's own, on file here: nothing is replaced by
    // an event that is already what it is.
    if (patch.host_parish_id && patch.host_parish_id !== card.parish_id
        && !('replaces' in patch) && !notes.some(n => n.field === 'replaces')) {
      notes.push({ field: 'replaces', text: REPLACES_PROMPT });
    }
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
  if (f === 'languages') return Array.isArray(v) ? langList.clean(v) : null;
  if (f === 'replaces') return Array.isArray(v) && v.length ? JSON.stringify(v.map(String)) : null;
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
    // A note goes with the field it is about — and "check what it replaces"
    // with whose event it is, since nothing need be ticked for it to stand.
    // A time the read left empty, where nobody has typed one, keeps the note
    // that says why: "After the 6:00pm Liturgy … fill in when this starts".
    const noTime = ev.start_time == null && (!card || isEmpty(card.start_time));
    const notes = (ev.read_notes || []).filter(n => filled.includes(n.field)
      || (n.field === 'replaces' && filled.includes('host_parish_id')) || (n.field === 'start_time' && noTime));
    if (filled.includes('date')) {
      set.printed_weekday = ev.printed_weekday;
      set.year_printed = ev.year_printed;
    }
    // A suggestion (suggestLanguages) is not "from poster": the poster did not say it.
    const read = filled.filter(f => !(ev.suggested || []).includes(f));
    if (card) {
      if (!filled.length) return;
      const marks = [...new Set([...parseList(card.read_fields), ...read])];
      const allNotes = [...parseList(card.read_notes), ...notes];
      set.read_fields = JSON.stringify(marks);
      set.read_notes = allNotes.length ? JSON.stringify(allNotes) : null;
      const cols = Object.keys(set);
      stmts.push(db.prepare(
        `UPDATE draft_events SET ${cols.map(c => `${c} = ?`).join(', ')}, updated_at = ${NOW} WHERE id = ?`
      ).bind(...Object.values(set), card.id));
    } else {
      set.read_fields = read.length ? JSON.stringify(read) : null;
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

/** The words of a name that say which service it is: not "the", "and", "service", or a time's "pm". */
const SMALL_WORDS = new Set(['a', 'an', 'the', 'and', 'of', 'in', 'at', 'on', 'for', 'with', 'to', 'service', 'services',
  'am', 'pm']);
const nameWords = (t) => titleKey(t).split(' ').filter(w => w && !SMALL_WORDS.has(w));

/**
 * The words of a name that say WHICH service, less those that only say what
 * kind of one: "Divine", "English", "Great". So "Liturgy" and "Matins &
 * Divine Liturgy" are kin (relatedName), and "English Divine Liturgy" and
 * "Divine Liturgy" are too, but "Great Vespers" and "Great Compline" are not.
 */
const QUALIFIERS = new Set(['divine', 'holy', 'great', 'small', 'little', 'english', 'greek', 'arabic', 'slavonic',
  'church', 'serbian', 'romanian', 'macedonian', 'morning', 'evening', 'online', 'weekly', 'monthly', 'parish',
  'orthodox', 'sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']);
const whichWords = (t) => new Set(nameWords(t).map(w => (w === 'orthros' ? 'matins' : w)).filter(w => !QUALIFIERS.has(w)));
const relatedName = (a, b) => { const x = whichWords(a); return [...whichWords(b)].some(w => x.has(w)); };
/** Does `inner` say nothing `outer` does not? "Liturgy" is within "Matins & Divine Liturgy". */
const nameWithin = (inner, outer) => { const x = whichWords(outer); return [...whichWords(inner)].every(w => x.has(w)); };

/**
 * Does what an event follows, as printed, name this service? "English
 * Liturgy" names "Liturgy" and "Orthros & Divine Liturgy" — a word in common —
 * and "the service" names any.
 */
function namesService(after, title) {
  const said = nameWords(after);
  if (!said.length) return true;
  const its = new Set(nameWords(title));
  return said.some(w => its.has(w));
}

/** The time printed in what an event follows: "English Liturgy at 6pm" -> "18:00". */
function timeIn(text) {
  const t = String(text || '');
  const ampm = /\b(\d{1,2})(?:[:.](\d{2}))?\s*([ap])\.?m\b/i.exec(t);
  if (ampm) {
    const h = Number(ampm[1]) % 12 + (ampm[3].toLowerCase() === 'p' ? 12 : 0);
    return Number(ampm[1]) <= 12 ? fromMinutes(h * 60 + Number(ampm[2] || 0)) : null;
  }
  const h24 = /\b([01]?\d|2[0-3])[:.]([0-5]\d)\b/.exec(t);
  return h24 ? `${h24[1].padStart(2, '0')}:${h24[2]}` : null;
}

/** A card or rule that is a service: a Liturgy, a Vespers, a feast's services. */
const isServiceKind = (x) => SERVICE_KINDS.has(x && x.event_type);

/**
 * An event held after a service starts when that service ends — never when it
 * starts.
 *
 * Sts Peter & Paul, Doonside's youth poster (3 Nov 2026): "Outdoor Movie
 * Night", "Following English Liturgy at 6pm, Sunday 22 November". The reader
 * gave the movie night 6pm, the Liturgy's time; the 22nd is a fourth Sunday,
 * when Doonside's English Liturgy is at 6pm, so matchOccurrences took the card
 * for that Liturgy and gave it the Liturgy's kind. The reader now says what an
 * event follows (`after`, poster-read.mjs), with the service's time when one
 * is printed ("English Liturgy at 6pm").
 *
 * Which service: the one `after` names that day ON THE POSTER, else on the
 * timetable — at the time `after` prints, or at the start the reader gave the
 * event, when a service it names starts then (that was the service's time,
 * not the event's). When it ends: the end printed or on file, else its start
 * and its usual length (durations.mjs: a Liturgy 1½ hours), which is a
 * suggestion and says so. Nothing it names, or two at different times, and
 * the time is left as the reader gave it, or empty with a note.
 *
 * An event with no time at all, on a day the poster gives one service for,
 * follows that service whether or not it says so. St John the Baptist,
 * Croydon Park's Christmas Fair poster (4 Nov 2026): "Sunday 13th Dec,
 * Liturgy 10AM", then "a day of delicious food, fun & festivities". The fair
 * starts when that Liturgy ends, 11:30am (Kevin).
 *
 * matchOccurrences never makes such a card the service's own date. Before
 * placeHosts and matchOccurrences, which go by the time.
 *
 * @param {object} read   normalizeRead()'s answer, changed in place
 * @param {Array} rules   the parish's active rules (schedules rows)
 */
export function afterServices(read, rules) {
  const sameDay = (ev, o) => o !== ev && !o.after && o.date === ev.date && !o.end_date && isLocalTime(o.start_time);
  for (const ev of read.events) {
    if (!ev.date || ev.end_date) continue;
    let implied = false;
    if (!ev.after && !ev.start_time && !isServiceKind(ev)) {
      const day = read.events.filter(o => sameDay(ev, o) && isServiceKind(o));
      if (day.length !== 1) continue;
      ev.after = day[0].title;
      implied = true;
    }
    if (!ev.after) continue;
    const printed = timeIn(ev.after);
    // A start of its own: after says so only when there is none, but a
    // reader that gives both has given the event's.
    if (ev.start_time && printed && ev.start_time !== printed) continue;
    const when = printed || ev.start_time;
    const which = (list) => list.filter(s => namesService(ev.after, s.title) && (!when || s.start_time === when));
    let services = which(read.events.filter(o => sameDay(ev, o)));
    if (!services.length) {
      services = which((rules || []).filter(r => r.active !== 0 && isValidOccurrence(r, ev.date)));
    }
    if (!services.length) continue;
    const was = ev.start_time;
    const not = was ? `, not ${clockText(was)}` : '';
    const starts = [...new Set(services.map(s => s.start_time))].sort();
    const ends = services.map(s => endOf(s));
    const end = new Set(ends.map(e => e && e.end)).size === 1 ? ends[0] && ends[0].end : null;
    const what = `${clockText(services[0].start_time)} ${services[0].title}`;
    const lead = implied ? `No time printed, so after the ${what} that day` : `After the ${what}`;
    let text;
    ev.start_time = null;
    if (starts.length > 1) {
      text = `After the ${services[0].title}, but there is more than one that day (${starts.map(clockText).join(', ')}): fill in when this starts.`;
    } else if (!end || (was && end <= was)) {
      text = `${lead}${was ? `, so not ${clockText(was)}` : ''}: nothing gives when that ends, so fill in when this starts.`;
    } else if (ends[0].usual) {
      ev.start_time = end;
      text = `${lead}, which usually runs ${lengthText(ends[0].usual.minutes)}: from ${clockText(end)}${not}. Check it.`;
    } else {
      ev.start_time = end;
      text = `${lead}, so from when that ends, ${clockText(end)}${was ? `; not ${clockText(was)}` : ''}.`;
    }
    // Worked out here, not printed: no "from poster" mark (mergeRead).
    if (ev.start_time && (implied || ends[0].usual)) ev.suggested = [...(ev.suggested || []), 'start_time'];
    ev.read_notes = [...(ev.read_notes || []).filter(n => n.field !== 'start_time'), { field: 'start_time', text }];
  }
  return read;
}

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
 * occurrenceOf says which. Cards at a rule's own start go first, so a
 * feast's early Liturgy at 7am cannot take the 8am one a later card gives at
 * 8am. A matched event takes the rule's own title when it names the same
 * service, and the rule's kind, so the override carries only what the
 * programme actually changes — the saint, a time — and not "and" for "&".
 *
 * And a card that is only a later part of its rule keeps the rule's time
 * (Kevin, 4 Nov 2026): St John the Baptist, Croydon Park's "Liturgy 10AM" is
 * the Liturgy of its 9:00–12:00 Matins & Divine Liturgy, the hour of Matins
 * before it. That Sunday stays 9:00 Matins & Divine Liturgy, with the poster.
 *
 * @param {object} read   normalizeRead()'s answer, changed in place
 * @param {Array} rules   the parish's active rules (schedules rows)
 */
export function matchOccurrences(read, rules) {
  const used = new Set();
  // Another parish's event is not one of this parish's services (placeHosts),
  // and one held after a service is not that service (afterServices).
  const cards = read.events.filter(ev => !ev.host_parish_id && !ev.after);
  for (const ev of read.events) ev.occurrence = null;
  for (const exact of [true, false]) {
    for (const ev of cards) {
      if (ev.occurrence) continue;
      const hit = occurrenceOf(ev, rules, used, { exact });
      if (!hit) continue;
      used.add(`${hit.id}:${ev.date}`);
      ev.occurrence = `${hit.id}:${ev.date}`;
      if (partOf(hit, ev)) {
        const was = `${clockText(ev.start_time)} ${ev.title}`;
        ev.read_notes = [...(ev.read_notes || []).filter(n => n.field !== 'start_time'), { field: 'start_time',
          text: `The poster’s ${was} is part of the regular ${clockText(hit.start_time)} ${hit.title}, so it stays at ${clockText(hit.start_time)}. Change it if the poster moves the whole service.` }];
        ev.start_time = hit.start_time;
        ev.end_time = null;
        ev.suggested = [...(ev.suggested || []), 'start_time'];
        if (nameWithin(ev.title, hit.title)) ev.title = hit.title;
      } else if (sameTitle(hit, ev)) ev.title = hit.title;
      if (hit.event_type) ev.event_type = hit.event_type;
    }
  }
  return read;
}

const sameTitle = (r, ev) => titleKey(r.title) === titleKey(ev.title);

/** The kinds that are services. A Liturgy, a Vespers and a feast's services are one sort; a talk, a youth night, a meal are another. */
const SERVICE_KINDS = new Set(['liturgy', 'prayer', 'feast']);
/**
 * Are a rule and a card the same sort of thing — both services, or both not?
 * A time alone never takes a card across: Sts Peter & Paul, Doonside's
 * "Outdoor Movie Night" at 6pm on the 22nd (3 Nov 2026) was taken for that
 * Sunday's 6pm English Liturgy, and given its kind. A card or rule with no
 * kind says nothing either way.
 */
const sameSort = (r, ev) => !r.event_type || !ev.event_type
  || SERVICE_KINDS.has(r.event_type) === SERVICE_KINDS.has(ev.event_type);

/**
 * When something runs, in minutes of its day: { s, e }, e === s when nothing
 * says how long (its end, or its usual length: durations.mjs).
 */
const spanOf = (x) => {
  const s = toMinutes(x.start_time);
  const end = endOf(x);
  return { s, e: end ? toMinutes(end.end) : s };
};
/** Do two spans share a minute? One with no length shares its start's. */
const overlaps = (a, b) => {
  if (a.s == null || b.s == null) return false;
  if (a.e > a.s && b.e > b.s) return a.s < b.e && b.s < a.e;
  if (a.e > a.s) return a.s <= b.s && b.s < a.e;
  if (b.e > b.s) return b.s <= a.s && a.s < b.e;
  return a.s === b.s;
};

/**
 * Is a card only a later part of its rule — the Liturgy of a Matins &
 * Liturgy, starting inside it? Then the poster is giving when that part
 * starts, not moving the service.
 */
function partOf(r, ev) {
  const t = toMinutes(ev.start_time);
  const span = spanOf(r);
  if (t == null || !(span.s < t && t < span.e)) return false;
  const mine = servicesNamed(ev.title);
  const its = servicesNamed(r.title);
  return mine.length > 0 && mine.length < its.length && mine.every(w => its.includes(w));
}

/**
 * The rule whose occurrence a dated event is, or null — never one already
 * `used`, never for a run of days, and never a guess between two. In order:
 *
 *   1. a rule that day starting when it does, of the same name or a kin one
 *      ("English Divine Liturgy" and "Liturgy"; relatedName);
 *   2. one whose time it falls in, or that falls in its time, of the same name
 *      or a kin one of the same sort. A poster's "Liturgy 10AM" is the 9:00–
 *      12:00 Matins & Divine Liturgy; until 4 Nov 2026 only the same start
 *      counted, and Croydon Park's 10am Liturgy was taken by name for its
 *      6pm English one instead. A rule or card with no end runs its usual
 *      length (durations.mjs);
 *   3. one starting when it does, of the same sort: a games night is the
 *      youth group's evening, a Vespers never is (sameSort);
 *   4. a programme that moves it: the one rule that day of the same name,
 *      when no other that day is kin to it — never the 6pm "Liturgy" for a
 *      10am one when there is a morning Liturgy too.
 * Two in a step are told apart by the same name, then by which the card
 * starts inside; else none. `exact` asks only the first: a kin rule at its
 * own start.
 */
function occurrenceOf(ev, rules, used = new Set(), { exact = false } = {}) {
  if (!ev.date || !ev.start_time || ev.end_date) return null;
  const that = (rules || []).filter(r => r.active !== 0 && isValidOccurrence(r, ev.date));
  const same = (r) => sameTitle(r, ev);
  const kin = (r) => same(r) || (sameSort(r, ev) && relatedName(r.title, ev.title));
  const span = spanOf(ev);
  const steps = [
    that.filter(r => r.start_time === ev.start_time && kin(r)),
    ...(exact ? [] : [
      that.filter(r => kin(r) && overlaps(spanOf(r), span)),
      that.filter(r => r.start_time === ev.start_time && sameSort(r, ev)),
    ]),
  ];
  const step = steps.find(list => list.length);
  let hit = null;
  if (step) hit = oneOf(step, ev);
  else if (!exact) {
    const named = that.filter(same);
    if (named.length === 1 && that.filter(kin).length === 1) hit = named[0];
  }
  return hit && !used.has(`${hit.id}:${ev.date}`) ? hit : null;
}

/** One rule of several for a card: the one of its name, else the one it starts inside; else none. */
function oneOf(list, ev) {
  if (list.length === 1) return list[0];
  const named = list.filter(r => sameTitle(r, ev));
  if (named.length === 1) return named[0];
  const t = toMinutes(ev.start_time);
  const inside = list.filter(r => { const sp = spanOf(r); return sp.s <= t && t < sp.e; });
  return inside.length === 1 ? inside[0] : null;
}

/**
 * An end for each card the poster gives none, from how long such a thing
 * usually runs (durations.mjs: a Liturgy 1½ hours, Matins 1, Vespers 1½, a
 * Bible study 1½, a fair or festival 4). Kevin, 4 Nov 2026: "I do want more
 * ending times inferred in general." A suggestion: never marked "from
 * poster", and said in a note to check. Not for a date of a regular service
 * (`occurrence`), which has its service's end, nor one on file already
 * (`host_event_id`), which has its own; nothing that would run past midnight,
 * and nothing for a name that gives nothing to go by.
 *
 * After afterServices and matchOccurrences: a fair after the Liturgy starts
 * when that ends, then runs its four hours.
 *
 * @param {object} read   normalizeRead()'s answer; changed in place
 */
export function suggestEnds(read) {
  for (const ev of read.events || []) {
    if (!ev.date || !isLocalTime(ev.start_time) || ev.end_time || ev.end_date || ev.occurrence || ev.host_event_id) continue;
    const e = endOf(ev);
    if (!e || !e.usual) continue;
    ev.end_time = e.end;
    ev.suggested = [...(ev.suggested || []), 'end_time'];
    ev.read_notes = [...(ev.read_notes || []), { field: 'end_time',
      text: `No end printed, and ${e.usual.what} usually runs ${lengthText(e.usual.minutes)}: until ${clockText(e.end)}. Check it.` }];
  }
  return read;
}

/**
 * The note that asks what another parish's event replaces here, until a person
 * ticks, unticks or says nothing is (touching `replaces` drops it). The editor
 * asks in words of its own, naming the parish; this marks it unanswered.
 */
export const REPLACES_PROMPT = 'Check replaced services: does this take the place of anything here that day?';

/** "07:30" -> "7:30am", for a note. */
const clockText = (t) => {
  const h = Number(String(t).slice(0, 2));
  return `${h % 12 || 12}:${String(t).slice(3, 5)}${h < 12 ? 'am' : 'pm'}`;
};

/**
 * The parish a venue names, when it is a church on file: "St Nectarios
 * Church, Burwood" is St Nectarios, Burwood. Read as matchParish reads a
 * poster's own parish — the words before the last comma as the name, after
 * it as the place, and the venue itself as the address — so the same three
 * witnesses and the same "nothing on a tie" decide it.
 */
export function venueParish(venue, parishes) {
  const v = String(venue || '').trim();
  if (!v) return null;
  const i = v.lastIndexOf(',');
  const other = i < 0 ? { name: v, place: '' } : { name: v.slice(0, i), place: v.slice(i + 1) };
  return matchParish(other, [v], parishes);
}

/**
 * Events the poster puts at ANOTHER parish's church, as that parish's events
 * with this one taking part (Kevin, 3 Nov 2026).
 *
 * St Andrew, Gladesville's November programme gave "Feast of St Nectarios, at
 * St Nectarios Church, Burwood" on the 9th; read at Gladesville it became
 * Gladesville's event at a place of its own called that, and was moved by
 * hand to Burwood with Gladesville taking part. Now a venue that names a
 * parish on file (venueParish) makes the card that parish's
 * (`host_parish_id`) and drops the venue's words, which named its own church.
 * Then:
 *
 *   * the event already on file there that day (sameEventOnFile in
 *     public/shared/event-checks.js) is `host_event_id`: publishing adds this
 *     parish to it, and makes nothing new;
 *   * else, when their regular service that day is this event, it is ticked
 *     under "replaces", so publishing puts the event there once, not beside it;
 *   * this parish's own service at the time (or of the name) the poster gives
 *     is ticked too: the poster has the parish at the other church instead;
 *   * and every such card asks to have what it replaces here checked — a note
 *     on `replaces` that goes once somebody ticks or unticks anything, or says
 *     nothing is. A parish that closes for another's feast says so in a line
 *     a reader cannot be trusted to turn into the right tick.
 *
 * A venue that is this parish (its own church by name) is left as it is, and
 * so is one at the parish the whole poster is from (placeRead's `parish`):
 * St Elias's youth night, dropped at Punchbowl, is St Elias's own event at
 * its own church, and the answer is to move the draft there — Punchbowl takes
 * no part in it.
 *
 * @param {object} read   normalizeRead()'s answer, after placeRead; changed in place
 * @param {{id, name}} parish  the draft's parish
 * @param {Array} ownRules     its active rules, as readContext gives them
 */
export async function placeHosts(db, read, parish, ownRules = []) {
  const at = read.events.filter(ev => ev.location_override);
  if (!at.length) return read;
  const list = (await db.prepare(
    "SELECT id, name, address, timezone FROM parishes WHERE id != '_unassigned'").all()).results || [];
  const byId = new Map(list.map(p => [p.id, p]));
  const postersOwn = read.parish && read.parish.parish_id;
  for (const ev of at) {
    const id = venueParish(ev.location_override, list);
    // Its own church by name ("St Nectarios Church, Burwood" on Burwood's
    // poster): at home, as its address is (placeRead).
    if (id && id === parish.id) { ev.location_override = null; continue; }
    if (!id || id === postersOwn) continue;
    ev.host_parish_id = id;
    ev.read_notes = [...(ev.read_notes || []).filter(n => n.field !== 'location_override'),
      { field: 'host_parish_id', text: `Printed as at “${ev.location_override}”.` }];
    ev.location_override = null;
  }
  const hosted = read.events.filter(ev => ev.host_parish_id);
  if (!hosted.length) return read;

  const hosts = [...new Set(hosted.map(ev => ev.host_parish_id))];
  const marks = hosts.map(() => '?').join(',');
  const dates = hosted.map(ev => ev.date).filter(Boolean).sort();
  let theirEvents = [], theirRules = [];
  if (dates.length) {
    // A day either side: a local date is never more than that from UTC's.
    const day = 86400000;
    const from = new Date(Date.parse(`${dates[0]}T00:00:00Z`) - day).toISOString();
    const to = new Date(Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) + 2 * day).toISOString();
    [theirEvents, theirRules] = await Promise.all([
      db.prepare(
        `SELECT id, parish_id, title, feast, start_utc, event_type FROM events
         WHERE parish_id IN (${marks}) AND source_adapter != 'schedule' AND start_utc >= ? AND start_utc < ?
           AND status NOT IN ('replaced','rejected','cancelled','hidden')`).bind(...hosts, from, to).all(),
      db.prepare(
        `SELECT id, parish_id, day_of_week, start_time, end_time, title, event_type, active, week_of_month,
                week_parity, effective_from, effective_to FROM schedules
         WHERE parish_id IN (${marks}) AND active = 1`).bind(...hosts).all(),
    ]).then(rs => rs.map(r => r.results || []));
  }

  const usedOwn = new Set();
  for (const ev of hosted) {
    const host = byId.get(ev.host_parish_id);
    const zone = host.timezone || 'Australia/Sydney';
    const replaces = [];
    const notes = [];
    if (ev.date) {
      const onFile = theirEvents.filter(e => e.parish_id === host.id).map(e => {
        const p = localPartsOf(zone, Date.parse(e.start_utc));
        return { ...e, date: p.date, time: p.time };
      }).filter(e => e.date === ev.date);
      const hit = checks.sameEventOnFile(ev, onFile);
      if (hit != null) ev.host_event_id = Number(hit);
      else {
        const theirs = occurrenceOf(ev, theirRules.filter(r => r.parish_id === host.id));
        if (theirs) {
          replaces.push(`${theirs.id}:${ev.date}`);
          notes.push(`Ticked: ${host.name}’s regular ${clockText(theirs.start_time)} ${theirs.title} that day is this, so it shows once.`);
        }
      }
      const mine = occurrenceOf(ev, ownRules, usedOwn);
      if (mine) {
        usedOwn.add(`${mine.id}:${ev.date}`);
        replaces.push(`${mine.id}:${ev.date}`);
        notes.push(`Ticked: ${parish.name}’s own ${clockText(mine.start_time)} ${mine.title} that day — the poster has this at ${host.name} instead. Untick it if it still goes ahead.`);
      }
    }
    if (replaces.length) ev.replaces = replaces;
    if (!notes.length) notes.push(REPLACES_PROMPT);
    ev.read_notes = [...ev.read_notes, ...notes.map(text => ({ field: 'replaces', text }))];
  }
  return read;
}

/**
 * Which of a parish's OWN one-offs on file a poster's event already is.
 *
 * St Nectarios, Burwood's November poster gives its feast on the 9th, which
 * Burwood already has on file — put up by hand, or published from an earlier
 * read of the same poster. Read again, it would have been a second feast
 * beside the first. A card that IS one on file says so: whose event it is
 * (`host_parish_id`, this parish's own) and which (`host_event_id`), and
 * publishing adds the poster to it, and whatever it is missing, rather than
 * making another (routes/admin.mjs publishOnFile). The same check as an event
 * at another parish's church (placeHosts, event-checks.js sameEventOnFile), so
 * the two cannot disagree about what "the same event" is.
 *
 * After matchOccurrences: a card that is a date of a regular service is that,
 * not a one-off. Not a card already another parish's (placeHosts). One card
 * to an event: two cards are two events, even when they share a saint.
 *
 * @param {object} read    normalizeRead()'s answer; changed in place
 * @param {{id, timezone}} parish  the draft's parish
 */
export async function matchOnFile(db, read, parish) {
  const cards = (read.events || []).filter(ev => ev.date && !ev.occurrence && !ev.host_parish_id);
  if (!cards.length) return read;
  const zone = parish.timezone || 'Australia/Sydney';
  const dates = cards.map(ev => ev.date).sort();
  const day = 86400000;
  const from = new Date(Date.parse(`${dates[0]}T00:00:00Z`) - day).toISOString();
  const to = new Date(Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) + 2 * day).toISOString();
  const rows = (await db.prepare(
    `SELECT id, title, feast, start_utc, event_type FROM events
     WHERE parish_id = ? AND source_adapter != 'schedule' AND start_utc >= ? AND start_utc < ?
       AND status NOT IN ('replaced','rejected','cancelled','hidden')`
  ).bind(parish.id, from, to).all()).results || [];
  if (!rows.length) return read;
  const onFile = rows.map(e => {
    const p = localPartsOf(zone, Date.parse(e.start_utc));
    return { ...e, date: p.date, time: p.time };
  });
  const used = new Set();
  for (const ev of cards) {
    const hit = checks.sameEventOnFile(ev, onFile.filter(e => e.date === ev.date && !used.has(e.id)));
    if (hit == null) continue;
    const e = onFile.find(x => x.id === hit);
    used.add(e.id);
    ev.host_parish_id = parish.id;
    ev.host_event_id = Number(e.id);
    const notes = [`Already on file here: ${clockText(e.time)} ${e.title}.`];
    if (checks.isLocalTime(ev.start_time) && ev.start_time !== e.time) {
      notes.push(`The poster has it at ${clockText(ev.start_time)}. Publishing keeps ${clockText(e.time)} — change it on the event if the poster is right.`);
    }
    ev.read_notes = [...(ev.read_notes || []), ...notes.map(text => ({ field: 'host_event_id', text }))];
  }
  return read;
}

/** A card that is this parish's own event already on file (matchOnFile). */
export const onFileHere = (card) => !!card.host_event_id && card.host_parish_id === card.parish_id;

// The kinds that are services: only a service is held in a language
// (public/shared/timetable.js isService).
const SERVICE_TYPES = new Set(['liturgy', 'prayer', 'feast', 'vespers', 'matins']);

/**
 * A language for each one-off service the poster gives none for.
 *
 * A one-off service must say its language to be published (event-checks.js),
 * and posters often do not ("Vespers and Liturgy, 6pm"). So the read suggests
 * one from the parish itself: the languages most of its services of the same
 * kind are tagged with, else most of its tagged services, its timetable first
 * and then its past one-offs. Said as a note on the field and never marked
 * "from poster", so the person sees it is a guess and checks it. Not for a date
 * of a regular service (`occurrence`), which has its service's, and nothing
 * for what is not a service: a talk or a social carries no language.
 *
 * @param {object} read   normalizeRead()'s answer, after matchOccurrences; changed in place
 * @param {Array} rules   the parish's active rules, with `languages`
 * @param {Array} past    the parish's past one-off events, with `languages`
 */
export function suggestLanguages(read, rules = [], past = []) {
  const tagged = [...(rules || []), ...(past || [])]
    .filter(r => SERVICE_TYPES.has(r.event_type))
    .map(r => ({ type: r.event_type, langs: langList.names(parseList(r.languages)) }))
    .filter(r => r.langs.length);
  const commonest = (rows) => {
    const n = new Map();
    for (const r of rows) { const k = JSON.stringify(r.langs); n.set(k, (n.get(k) || 0) + 1); }
    let best = null;
    for (const [k, c] of n) if (!best || c > best[1]) best = [k, c];
    return best ? JSON.parse(best[0]) : null;
  };
  for (const ev of read.events || []) {
    if (!SERVICE_TYPES.has(ev.event_type)) { ev.languages = null; continue; }
    // Another parish's: theirs to say, not guessed from here.
    if ((ev.languages && ev.languages.length) || ev.occurrence || ev.host_parish_id) continue;
    const pick = commonest(tagged.filter(r => r.type === ev.event_type)) || commonest(tagged);
    if (!pick) continue;
    ev.languages = pick;
    ev.suggested = [...(ev.suggested || []), 'languages'];
    ev.read_notes = [...(ev.read_notes || []),
      { field: 'languages', text: 'The poster does not say. Suggested from the parish’s other services: check it.' }];
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
 *     at the new one (a read again does that);
 *   * whose event it is (`host_parish_id`), when that is the new parish: it
 *     is the new parish's own event now, not one it takes part in — and,
 *     when it was one on file there, that one on file (matchOnFile). When it
 *     was the OLD parish's own on file, it goes: found there, not here.
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
    // Whose event it is. The old parish's own, found on file there: not
    // this parish's, and nothing said it is. The new parish's, not on file:
    // its own new event now. The new parish's, on file: that event, which is
    // now its own on file (publishing fills it in, not a second).
    if (card.host_parish_id === draft.parish_id
        || (card.host_parish_id === parish.id && !card.host_event_id)) {
      set.host_parish_id = null; set.host_event_id = null;
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

/**
 * A card's subtitle as an event's (events.feast, migration 030): the line
 * under the title. Until 030 a one-off had none, and publishing glued it on —
 * "Matins and Divine Liturgy — Holy Protection of the Theotokos". A subtitle
 * the title already says ("Feast of St Nicholas", "St Nicholas") is none.
 */
export function oneOffFeast(card) {
  const title = String(card.title || '').trim();
  const feast = String(card.feast || '').trim();
  if (!feast || titleKey(title).includes(titleKey(feast))) return null;
  return feast.slice(0, 200);
}

/** What a card becomes as a POST /api/admin/events body, less the instants. */
export function publishBody(card, parishId) {
  return {
    parish_id: parishId,
    title: String(card.title || '').trim(),
    feast: oneOffFeast(card),
    event_type: card.event_type || 'other',
    description: card.description || null,
    languages: card.languages && card.languages !== '[]' ? card.languages : null,
    location_override: card.location_override || null,
    location_parish_id: card.location_parish_id || null,
    location_lat: card.location_lat != null ? card.location_lat : null,
    location_lng: card.location_lng != null ? card.location_lng : null,
    additive_parish_ids: parseList(card.also_at).map(String),
    replaced_event_ids: parseList(card.replaces).map(String),
    // The pill, once somebody tapped it; untapped, createOneOff goes by the kind.
    ...(card.parish_scoped != null ? { parish_scoped: !!card.parish_scoped } : {}),
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
  // A place, whole (lib/venues.mjs): another parish, or words and a pin.
  if (has(card.location_parish_id) || has(card.location_override) || card.location_lat != null) {
    body.location_parish_id = card.location_parish_id || null;
    body.location_override = card.location_parish_id ? null : (card.location_override || null);
    body.location_lat = card.location_parish_id ? null : card.location_lat ?? null;
    body.location_lng = card.location_parish_id ? null : card.location_lng ?? null;
  }
  // The pill, once tapped; equal to the rule's, it is no patch (mergePatch).
  if (card.parish_scoped != null) body.parish_scoped = !!card.parish_scoped;
  if (posterPath) body.poster_path = posterPath;
  return body;
}
