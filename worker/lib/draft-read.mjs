// Reading a poster into a draft: the one pipeline, wherever the poster came from.
//
// Two ways in. The add-event editor drops a poster on a draft and streams the
// read back as it is written (POST /api/admin/drafts/:id/poster). A poster
// forwarded to Agora's WhatsApp number is read into a draft with nobody
// watching (routes/ingest.mjs). Both want the same answer — the read squared
// with the parish, its services and its events on file — so both come here.
//
// lib/poster-read.mjs is the model side; lib/drafts.mjs has every step below.

import { readPoster, posterContext, noteParts } from './poster-read.mjs';
import { placeRead, afterServices, placeHosts, matchOccurrences, matchOnFile, suggestEnds, suggestLanguages,
  mergeRead, setReadStatus, splitDraft, cardsAsRead, writeSquared, getDraft } from './drafts.mjs';
import { localDateOf } from '../../public/shared/tz.mjs';
import timezones from '../../public/shared/timezones.js';
import whatsappWords from '../../public/shared/whatsapp-words.js';

const { DEFAULT_TIMEZONE } = timezones;
const { plainWords } = whatsappWords;

/**
 * What the poster reader needs about a parish that is not on the poster: the
 * parish, its zone, its own today, and the services it holds every week.
 */
export async function readContext(db, parishId) {
  const parish = await db.prepare('SELECT id, name, address, timezone FROM parishes WHERE id = ?')
    .bind(parishId).first();
  const zone = (parish && parish.timezone) || DEFAULT_TIMEZONE;
  const today = localDateOf(zone, Date.now());
  // Whole rows: the context names them, and a programme's dated services
  // are matched to their occurrences (matchOccurrences) — which needs the
  // weeks and the dates a rule runs between, not just its day and time.
  const rules = (await db.prepare(
    `SELECT id, day_of_week, start_time, end_time, title, event_type, languages, active, week_of_month,
            week_parity, effective_from, effective_to FROM schedules
     WHERE parish_id = ? AND active = 1 AND (effective_to IS NULL OR effective_to >= ?)
     ORDER BY day_of_week, start_time`
  ).bind(parishId, today).all()).results || [];
  return { parish, zone, today, rules };
}

/**
 * Read a poster — or a message of words only — into a draft, and merge it.
 *
 * @param {object} env
 * @param {{id, parish_id}} draft
 * @param {object} o
 * @param {string} o.apiKey
 * @param {ArrayBuffer|null} o.bytes   the image; null for words only
 * @param {string} [o.mediaType]
 * @param {{bytes, mediaType}[]} [o.images]  several pictures sent as one announcement, read together
 *                                     (in place of bytes; a WhatsApp forward's)
 * @param {string} [o.note]            words sent with it: a suggestion's note, a WhatsApp caption
 * @param {boolean} [o.whatsapp]       the note came with the image on WhatsApp
 * @param {boolean} [o.split]          several pictures may be several posters, each a draft of its
 *                                     own (a WhatsApp forward's, as it came: poster-read.mjs splitRead)
 * @param {Function} [o.send]          the editor's stream: 'kind', 'field', 'item' as they are written
 * @param {(read) => string|null} [o.choose]
 *   For a draft whose parish was only a guess (a WhatsApp sender's): the
 *   parish it should be at, given whose poster the read says it is — or null
 *   to stay. The draft moves BEFORE its read is squared with a parish, so the
 *   services and events it is matched to are the right parish's.
 * @returns {Promise<{ok: true, draft: object|null, read: object, moved: boolean, drafts?: object[]}
 *                   |{ok: false, error: string, retry: boolean}>}
 *   `draft` null when it was discarded while it was being read. `drafts`, when
 *   it was several posters: each one's {id, draft, read, moved, pictures},
 *   the first this draft.
 */
export async function readIntoDraft(env, draft, { apiKey, bytes, mediaType, images = null, note = '', whatsapp = false, split = false, send = () => {}, choose = null }) {
  const db = env.DB;
  await setReadStatus(db, draft.id, 'reading');
  const context = await readContext(db, draft.parish_id);
  const { parish, zone, today, rules } = context;

  const pictures = images && images.length ? images : (bytes ? [{ bytes, mediaType }] : []);
  const apart = split && pictures.length > 1;
  const words = noteParts(note);
  const read = await readPoster({
    apiKey,
    baseUrl: env.ANTHROPIC_BASE_URL,
    images: pictures,
    split: apart,
    words: words.parts.length,
    today,
    context: posterContext({ ...parish, timezone: zone }, today, rules, note,
      { image: pictures.length > 0, whatsapp, pictures: pictures.length, split: apart }),
  }, send);
  // One line per read, for Workers Observability: what it cost and how long.
  console.log(JSON.stringify({ poster_read: {
    draft: draft.id, parish: draft.parish_id, ok: read.ok, ms: read.ms, ...(whatsapp ? { whatsapp: true } : {}),
    ...(pictures.length > 1 ? { pictures: pictures.length } : {}),
    ...(read.parts ? { posters: read.parts.length } : {}),
    ...(read.usage || {}), ...(read.ok ? { events: read.read.events.length } : { error: read.error }),
  } }));
  if (!read.ok) {
    await setReadStatus(db, draft.id, 'failed');
    return { ok: false, error: read.error, retry: read.retry };
  }

  // The words on WhatsApp are the parish's own, and are what a card says
  // (public/shared/whatsapp-words.js): the reader's description is for a
  // poster that came alone.
  const said = whatsapp ? plainWords(note) : null;
  if (!read.parts) {
    const r = await squareRead(env, draft, read.read, { choose, context, words: said });
    return { ok: true, draft: r.draft, read: read.read, moved: r.moved };
  }

  // Several posters: a draft for each, with its own pictures and words.
  // Words the read gave to none of them are kept whole on each, as they came,
  // and fill no description: they are not known to be that poster's.
  const anyWords = read.parts.some(p => p.words.length);
  const textOf = (p) => (anyWords ? p.words.map(i => words.parts[i - 1]).join(words.sep) || null : note || null);
  const ids = await splitDraft(db, draft.id, read.parts.map(p => ({ pictures: p.pictures, text: textOf(p) })));
  if (!ids.length) return { ok: true, draft: null, read: read.read, moved: false };
  const drafts = [];
  for (const [i, part] of read.parts.entries()) {
    const own = anyWords && whatsapp ? plainWords(textOf(part)) : null;
    const r = await squareRead(env, { id: ids[i], parish_id: draft.parish_id }, part.read, { choose, context, words: own });
    drafts.push({ ...r, id: ids[i], read: part.read, pictures: part.pictures });
  }
  return { ok: true, draft: drafts[0].draft, read: drafts[0].read, moved: drafts[0].moved, drafts };
}

/**
 * A finished read, squared with the parish its draft is at — or moved to,
 * when `choose` says whose it is — and merged into the draft.
 *
 * @param {{id, parish_id}} draft
 * @param {object} read  normalizeRead()'s, changed in place
 * @param {object} o
 * @param {object} o.context  readContext() at the draft's parish
 * @param {string|null} [o.words]  the sender's words for its one event's description (plainWords)
 */
async function squareRead(env, draft, read, { choose = null, context, words = null }) {
  const db = env.DB;
  let parishId = draft.parish_id;
  let { parish, rules, zone } = context;
  // The parish's own address is not a venue, and "another parish's poster"
  // becomes a parish on file when one clearly matches.
  await placeRead(db, read, { id: parishId, ...(parish || {}) });
  let moved = false;
  const to = choose ? choose(read) : null;
  if (to && to !== parishId) {
    await db.prepare(`UPDATE drafts SET parish_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
      .bind(to, draft.id).run();
    parishId = to;
    ({ parish, zone, rules } = await readContext(db, parishId));
    // Again, at the parish it is now: its own address goes, and "another
    // parish's poster" is no longer another's.
    await placeRead(db, read, { id: parishId, ...(parish || {}) });
    moved = true;
  }
  await matchAt(db, read, { id: parishId, ...(parish || {}), timezone: zone }, rules);
  // One event, and words sent with it: they are its description (Kevin,
  // 19 Nov 2026), in place of the reader's. Several events share the words
  // between them, so each keeps its own, and Fill from WhatsApp is there.
  // A date called off says only why, if anything.
  const [only] = read.events;
  if (words && read.events.length === 1 && !only.cancelled) {
    only.description = words;
    only.read_notes = (only.read_notes || []).filter(n => n.field !== 'description');
    // Not "from poster": the WhatsApp words, shown under it, are where it came from.
    only.suggested = [...(only.suggested || []), 'description'];
  }
  return { draft: await mergeRead(db, draft.id, read), moved };
}

/**
 * A read squared with the parish whose timetable and events it is matched to
 * — every step that asks the parish anything, in its order. A read does this
 * once it is placed (squareRead); a draft moved by hand does it again at the
 * parish it moved to (squareMoved), so the two cannot drift apart.
 *
 * @param {object} read   normalizeRead()'s answer (or cardsAsRead()'s), changed in place
 * @param {{id, name, timezone}} here  the parish
 * @param {Array} rules   its active rules (readContext)
 */
async function matchAt(db, read, here, rules) {
  // Something held after a service starts when it ends, not at the time
  // printed for the service — and is never that service's date.
  afterServices(read, rules);
  // An event at another parish's church is that parish's, with this one
  // taking part: the one of theirs on file, or one to add there.
  await placeHosts(db, read, here, rules);
  // A dated regular service — a programme's Sunday and its saint — is a
  // change to that Sunday, not an event beside it.
  matchOccurrences(read, rules);
  // A one-off this parish already has on file is that one, filled in
  // rather than made twice.
  await matchOnFile(db, read, here);
  // No end printed: how long such a thing usually runs (a Liturgy 1½
  // hours, a fair 4), as a suggestion to check.
  suggestEnds(read);
  // A one-off service the poster gives no language for: the parish's
  // usual, as a suggestion to check (publishing needs one).
  const past = (await db.prepare(
    `SELECT event_type, languages FROM events WHERE parish_id = ? AND languages IS NOT NULL
     ORDER BY start_utc DESC LIMIT 40`).bind(here.id).all()).results || [];
  suggestLanguages(read, rules, past);
  return read;
}

/**
 * A draft moved to another parish by hand, squared with that parish as a read
 * there would have been — without reading the poster again.
 *
 * A WhatsApp forward from somebody who may edit every parish starts at no
 * parish, and stays there when the poster does not say whose it is: read
 * against no timetable and no events, nothing on it was matched to
 * anything. Kevin (25 Nov 2026): choosing the parish by hand then missed
 * what the reader gives — a date of a regular service, the event already on
 * file, another parish's feast with "Check replaced services" asked of this
 * one's own. A poster dropped at the wrong parish was the same: the move
 * unlinked its cards from the old parish's services (moveDraft) and matched
 * them to nothing at the new one.
 *
 * So the cards the read filled go through the read's steps again at the new
 * parish (matchAt), as they stand now, and what is found is written back as
 * a read is merged: filling, never overwriting what somebody typed
 * (drafts.mjs cardsAsRead, writeSquared). After moveDraft, which takes off
 * what only made sense at the old parish. Only a read draft: one whose
 * poster was taken off is the person's own.
 *
 * @param {object} draft  getDraft()'s answer, at the parish it moved to
 * @returns {Promise<object>} the draft as it now stands
 */
export async function squareMoved(db, draft) {
  if (draft.read_status !== 'read') return draft;
  const { read, cards } = cardsAsRead(draft);
  if (!cards.length) return draft;
  const { parish, zone, rules } = await readContext(db, draft.parish_id);
  await matchAt(db, read, { id: draft.parish_id, ...(parish || {}), timezone: zone }, rules);
  await writeSquared(db, cards, read, draft.parish_id);
  return getDraft(db, draft.id);
}

/**
 * Read what a phone with no account sent (routes/ingest.mjs) — pictures, or
 * words alone — for a suggestion rather than a draft. Nothing is written:
 * the suggestion takes its empty fields from the first event read
 * (suggestions.mjs fillFromRead), and `parishId` is whose it is. Unless the
 * sender named the parish (`fixed`), that is the one the read says the
 * poster is for, when one on file clearly matches; anybody may suggest at
 * any parish, so no role narrows it.
 *
 * @returns {Promise<{ok: true, read: object, parishId: string}|{ok: false, error: string}>}
 */
export async function readForSuggestion(env, parishId, { apiKey, images = [], note = '', whatsapp = true, fixed = false }) {
  const db = env.DB;
  let { parish, zone, today, rules } = await readContext(db, parishId);
  const read = await readPoster({
    apiKey,
    baseUrl: env.ANTHROPIC_BASE_URL,
    images,
    today,
    context: posterContext({ id: parishId, ...(parish || {}), timezone: zone }, today, rules, note,
      { image: images.length > 0, whatsapp, pictures: images.length }),
  });
  console.log(JSON.stringify({ poster_read: {
    suggestion: true, parish: parishId, ok: read.ok, ms: read.ms, ...(whatsapp ? { whatsapp: true } : {}),
    ...(images.length > 1 ? { pictures: images.length } : {}),
    ...(read.usage || {}), ...(read.ok ? { events: read.read.events.length } : { error: read.error }),
  } }));
  if (!read.ok) return { ok: false, error: read.error };
  await placeRead(db, read.read, { id: parishId, ...(parish || {}) });
  const to = !fixed && read.read.parish && read.read.parish.parish_id;
  if (to && to !== parishId && to !== '_unassigned') {
    parishId = to;
    ({ parish, zone, today, rules } = await readContext(db, parishId));
    await placeRead(db, read.read, { id: parishId, ...(parish || {}) });
  }
  afterServices(read.read, rules);
  suggestEnds(read.read);
  return { ok: true, read: read.read, parishId };
}
