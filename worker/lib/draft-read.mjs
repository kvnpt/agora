// Reading a poster into a draft: the one pipeline, wherever the poster came from.
//
// Two ways in. The add-event editor drops a poster on a draft and streams the
// read back as it is written (POST /api/admin/drafts/:id/poster). A poster
// forwarded to Agora's WhatsApp number is read into a draft with nobody
// watching (routes/ingest.mjs). Both want the same answer — the read squared
// with the parish, its services and its events on file — so both come here.
//
// lib/poster-read.mjs is the model side; lib/drafts.mjs has every step below.

import { readPoster, sortPosters, sortGroups, keepParts, posterContext, noteParts, PDF_TYPE } from './poster-read.mjs';
import { placeRead, afterServices, placeHosts, matchOccurrences, matchOnFile, suggestEnds, suggestLanguages,
  mergeRead, setReadStatus, splitDraft } from './drafts.mjs';
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
 *                                     own (a WhatsApp forward's, as it came: readApart)
 * @param {number} [o.deadline]        ms since the epoch: stop reading then, and keep what was read
 * @param {AbortSignal} [o.stop]       the same, known only later (the editor gone: routes/admin.mjs)
 * @param {{after, count, title}} [o.after]  read on from where the draft's last read stopped
 *                                     (its `read_cut`): only what comes after, added to its cards
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
export async function readIntoDraft(env, draft, { apiKey, bytes, mediaType, images = null, note = '', whatsapp = false, split = false, send = () => {}, choose = null, deadline = null, stop = null, after = null }) {
  const db = env.DB;
  await setReadStatus(db, draft.id, 'reading');
  const context = await readContext(db, draft.parish_id);
  const { parish, zone, today, rules } = context;

  const pictures = images && images.length ? images : (bytes ? [{ bytes, mediaType }] : []);
  const words = noteParts(note);
  const base = { apiKey, baseUrl: env.ANTHROPIC_BASE_URL, today, deadline, stop };
  const contextFor = (own, o = {}) => posterContext({ ...parish, timezone: zone }, today, rules, o.note ?? note,
    { image: own.length > 0, whatsapp, pictures: own.length, pdf: own.some(p => p.mediaType === PDF_TYPE),
      part: o.part || null, after });
  const read = split && pictures.length > 1 && !after
    ? await readApart({ base, pictures, note, words, contextFor, parish: { ...parish, timezone: zone }, send })
    : await readPoster({ ...base, images: pictures, context: contextFor(pictures) }, send);
  // One line per read, for Workers Observability: what it cost and how long.
  console.log(JSON.stringify({ poster_read: {
    draft: draft.id, parish: draft.parish_id, ok: read.ok, ms: read.ms, ...(whatsapp ? { whatsapp: true } : {}),
    ...(pictures.length > 1 ? { pictures: pictures.length } : {}),
    ...(pictures.some(p => p.mediaType === PDF_TYPE) ? { pdf: true } : {}),
    ...(read.sorted ? { sorted: read.sorted } : {}),
    ...(read.parts ? { posters: read.parts.length } : {}),
    ...(after ? { after: after.after } : {}),
    ...(read.usage || {}), ...(read.ok ? { events: read.read.events.length } : { error: read.error }),
    ...(read.ok && read.cut ? { cut: read.cut.why } : {}),
  } }));
  // Read on from a stop: only what it had not, and where this one stopped, if it did, counted from the first.
  if (read.ok && after) onFrom(read, after);
  if (!read.ok) {
    await setReadStatus(db, draft.id, after ? 'read' : 'failed');
    return { ok: false, error: read.error, retry: read.retry };
  }

  // The words on WhatsApp are the parish's own, and are what a card says
  // (public/shared/whatsapp-words.js): the reader's description is for a
  // poster that came alone.
  const said = whatsapp ? plainWords(note) : null;
  if (!read.parts) {
    const r = await squareRead(env, draft, read.read, { choose: after ? null : choose, context, words: after ? null : said, append: !!after });
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
 * The rest of a read that stopped part-way, squared with what it has: an
 * event it read already (by date and title, and time when both give one) is
 * one the draft has, said again, and goes. Where this read stopped, if it
 * did, has every event read so far, the first read's too.
 */
export function onFrom(read, after) {
  const same = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
  const had = after.had || [];
  const known = (e) => had.some(h => (h.date || null) === (e.date || null) && same(h.title, e.title)
    && (!h.start_time || !e.start_time || h.start_time === e.start_time));
  read.read.events = read.read.events.filter(e => !known(e));
  const cut = read.read.cut;
  if (cut) {
    cut.had = [...had, ...read.read.events.map(e => ({ date: e.date, start_time: e.start_time, title: e.title }))];
    cut.count = cut.had.length;
  }
  return read;
}

/**
 * A WhatsApp forward of several pictures, which may be several posters: which
 * announcements it is (sortPosters, a small request), then each read on its
 * own, at once. One announcement — or a sort that fails or says nothing
 * clear — is one read of every picture, as before.
 *
 * It was one read that did both, with a schema the API would not compile
 * (400, St Mary's, Mays Hill's two posters, 28 Nov 2026). Read apart, each
 * poster is also a shorter read, and they run side by side.
 *
 * @returns readPoster's answer, with `parts` (keepParts's) when there are
 *   several posters, and `sorted`: how many announcements the sort said, or
 *   'failed'.
 */
async function readApart({ base, pictures, note, words, contextFor, parish, send }) {
  const started = Date.now();
  const sorted = await sortPosters({ ...base, images: pictures, parish, note });
  const groups = sorted.ok ? sortGroups(sorted.posters, { pictures: pictures.length, words: words.parts.length }) : null;
  if (!sorted.ok) console.error(`[poster-read] sort: ${sorted.error}`);
  if (!groups || groups.length < 2) {
    const one = await readPoster({ ...base, images: pictures, context: contextFor(pictures) }, send);
    return { ...one, ms: Date.now() - started, sorted: sorted.ok ? 1 : 'failed' };
  }
  const anyWords = groups.some(g => g.words.length);
  const reads = await Promise.all(groups.map((g, i) => {
    const own = g.pictures.map(n => pictures[n - 1]);
    // Its own part of the words; when the sort gave none any, all of them,
    // said to be everybody's.
    const text = anyWords ? g.words.map(k => words.parts[k - 1]).join(words.sep) : note;
    return readPoster({ ...base, images: own,
      context: contextFor(own, { note: text, part: { n: i + 1, of: groups.length, shared: !anyWords && !!note } }) });
  }));
  const usage = { input_tokens: 0, output_tokens: 0 };
  for (const r of [sorted, ...reads]) {
    if (r.usage) {
      usage.model = usage.model || r.usage.model;
      usage.input_tokens += r.usage.input_tokens || 0;
      usage.output_tokens += r.usage.output_tokens || 0;
    }
  }
  const ms = Date.now() - started;
  const parts = keepParts(groups, reads, { pictures: pictures.length });
  if (!parts.length) {
    const failed = reads.find(r => !r.ok) || { error: 'Nothing could be read.', retry: true };
    return { ok: false, error: failed.error, retry: failed.retry, ms, usage, sorted: groups.length };
  }
  // The whole read, for the draft that came: its first part's.
  const read = parts[0].read;
  return { ok: true, read, cut: read.cut || null, parts: parts.length > 1 ? parts : null, usage, ms, sorted: groups.length };
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
 * @param {boolean} [o.append]  the rest of a read that stopped part-way: added after the cards
 */
async function squareRead(env, draft, read, { choose = null, context, words = null, append = false }) {
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
  // Something held after a service starts when it ends, not at the time
  // printed for the service — and is never that service's date.
  afterServices(read, rules);
  // An event at another parish's church is that parish's, with this one
  // taking part: the one of theirs on file, or one to add there.
  await placeHosts(db, read, { id: parishId, ...(parish || {}) }, rules);
  // A dated regular service — a programme's Sunday and its saint — is a
  // change to that Sunday, not an event beside it.
  matchOccurrences(read, rules);
  // A one-off this parish already has on file is that one, filled in
  // rather than made twice.
  await matchOnFile(db, read, { id: parishId, ...(parish || {}), timezone: zone });
  // No end printed: how long such a thing usually runs (a Liturgy 1½
  // hours, a fair 4), as a suggestion to check.
  suggestEnds(read);
  // A one-off service the poster gives no language for: the parish's
  // usual, as a suggestion to check (publishing needs one).
  const past = (await db.prepare(
    `SELECT event_type, languages FROM events WHERE parish_id = ? AND languages IS NOT NULL
     ORDER BY start_utc DESC LIMIT 40`).bind(parishId).all()).results || [];
  suggestLanguages(read, rules, past);
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
  return { draft: await mergeRead(db, draft.id, read, { append }), moved };
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
export async function readForSuggestion(env, parishId, { apiKey, images = [], note = '', whatsapp = true, fixed = false, deadline = null }) {
  const db = env.DB;
  let { parish, zone, today, rules } = await readContext(db, parishId);
  const read = await readPoster({
    apiKey,
    baseUrl: env.ANTHROPIC_BASE_URL,
    images,
    today,
    deadline,
    context: posterContext({ id: parishId, ...(parish || {}), timezone: zone }, today, rules, note,
      { image: images.length > 0, whatsapp, pictures: images.length, pdf: images.some(p => p.mediaType === PDF_TYPE) }),
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
