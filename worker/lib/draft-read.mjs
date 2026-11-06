// Reading a poster into a draft: the one pipeline, wherever the poster came from.
//
// Two ways in. The add-event editor drops a poster on a draft and streams the
// read back as it is written (POST /api/admin/drafts/:id/poster). A poster
// forwarded to Agora's WhatsApp number is read into a draft with nobody
// watching (routes/ingest.mjs). Both want the same answer — the read squared
// with the parish, its services and its events on file — so both come here.
//
// lib/poster-read.mjs is the model side; lib/drafts.mjs has every step below.

import { readPoster, posterContext } from './poster-read.mjs';
import { placeRead, afterServices, placeHosts, matchOccurrences, matchOnFile, suggestEnds, suggestLanguages,
  mergeRead, setReadStatus } from './drafts.mjs';
import { localDateOf } from '../../public/shared/tz.mjs';
import timezones from '../../public/shared/timezones.js';

const { DEFAULT_TIMEZONE } = timezones;

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
 * @param {Function} [o.send]          the editor's stream: 'kind', 'field', 'item' as they are written
 * @param {(read) => string|null} [o.choose]
 *   For a draft whose parish was only a guess (a WhatsApp sender's): the
 *   parish it should be at, given whose poster the read says it is — or null
 *   to stay. The draft moves BEFORE its read is squared with a parish, so the
 *   services and events it is matched to are the right parish's.
 * @returns {Promise<{ok: true, draft: object|null, read: object, moved: boolean}
 *                   |{ok: false, error: string, retry: boolean}>}
 *   `draft` null when it was discarded while it was being read.
 */
export async function readIntoDraft(env, draft, { apiKey, bytes, mediaType, images = null, note = '', whatsapp = false, send = () => {}, choose = null }) {
  const db = env.DB;
  await setReadStatus(db, draft.id, 'reading');
  let parishId = draft.parish_id;
  let { parish, zone, today, rules } = await readContext(db, parishId);

  const pictures = images && images.length ? images : (bytes ? [{ bytes, mediaType }] : []);
  const read = await readPoster({
    apiKey,
    baseUrl: env.ANTHROPIC_BASE_URL,
    images: pictures,
    context: posterContext({ ...parish, timezone: zone }, today, rules, note,
      { image: pictures.length > 0, whatsapp, pictures: pictures.length }),
  }, send);
  // One line per read, for Workers Observability: what it cost and how long.
  console.log(JSON.stringify({ poster_read: {
    draft: draft.id, parish: parishId, ok: read.ok, ms: read.ms, ...(whatsapp ? { whatsapp: true } : {}),
    ...(pictures.length > 1 ? { pictures: pictures.length } : {}),
    ...(read.usage || {}), ...(read.ok ? { events: read.read.events.length } : { error: read.error }),
  } }));
  if (!read.ok) {
    await setReadStatus(db, draft.id, 'failed');
    return { ok: false, error: read.error, retry: read.retry };
  }

  // The parish's own address is not a venue, and "another parish's poster"
  // becomes a parish on file when one clearly matches.
  await placeRead(db, read.read, { id: parishId, ...(parish || {}) });
  let moved = false;
  const to = choose ? choose(read.read) : null;
  if (to && to !== parishId) {
    await db.prepare(`UPDATE drafts SET parish_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`)
      .bind(to, draft.id).run();
    parishId = to;
    ({ parish, zone, today, rules } = await readContext(db, parishId));
    // Again, at the parish it is now: its own address goes, and "another
    // parish's poster" is no longer another's.
    await placeRead(db, read.read, { id: parishId, ...(parish || {}) });
    moved = true;
  }
  // Something held after a service starts when it ends, not at the time
  // printed for the service — and is never that service's date.
  afterServices(read.read, rules);
  // An event at another parish's church is that parish's, with this one
  // taking part: the one of theirs on file, or one to add there.
  await placeHosts(db, read.read, { id: parishId, ...(parish || {}) }, rules);
  // A dated regular service — a programme's Sunday and its saint — is a
  // change to that Sunday, not an event beside it.
  matchOccurrences(read.read, rules);
  // A one-off this parish already has on file is that one, filled in
  // rather than made twice.
  await matchOnFile(db, read.read, { id: parishId, ...(parish || {}), timezone: zone });
  // No end printed: how long such a thing usually runs (a Liturgy 1½
  // hours, a fair 4), as a suggestion to check.
  suggestEnds(read.read);
  // A one-off service the poster gives no language for: the parish's
  // usual, as a suggestion to check (publishing needs one).
  const past = (await db.prepare(
    `SELECT event_type, languages FROM events WHERE parish_id = ? AND languages IS NOT NULL
     ORDER BY start_utc DESC LIMIT 40`).bind(parishId).all()).results || [];
  suggestLanguages(read.read, rules, past);
  return { ok: true, draft: await mergeRead(db, draft.id, read.read), read: read.read, moved };
}
