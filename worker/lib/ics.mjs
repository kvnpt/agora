// A calendar file (RFC 5545), for "Add to calendar" and a calendar a phone
// subscribes to: every link's `.ics` twin (routes/calendar.mjs).
//
// DATES WRITTEN OUT ONE BY ONE, never a repeat rule. An RRULE would hand the
// projection to the phone, and the phone would get a fourth Sunday, a week
// held otherwise, a break, an override and the dedup wrong: the lens is the
// one projection (public/shared/project.mjs), and this writes down what it
// made. Each date keeps its own id as its UID (`20:2026-11-22@orthodoxy.au`),
// so a moved time is the same entry moved, never a second one beside it.
//
// TIMES IN UTC. The phone shows them in its own zone, as every calendar does;
// the page still shows the parish's (docs/architecture.md). A TZID would need
// a VTIMEZONE written out for every zone, for the same result.
//
// NOTHING DISAPPEARS. A cancelled date stays, its title saying so, as its
// card does. It is NOT marked STATUS:CANCELLED: Google hides those outright,
// and somebody who planned to go would see nothing at all.
//
// Pure: no D1, no fetch. The route gathers the events and the parishes.

const UID_HOST = 'orthodoxy.au';
const PRODID = '-//orthodoxy.au//Agora//EN';
// How long a date with no end time is held in a calendar: the usual length
// of a Liturgy (lib/durations.mjs), which most such rows are.
const DEFAULT_MINUTES = 90;
// What a subscribed calendar is asked to wait between looks. Apple and
// Outlook read these; Google ignores them and comes when it likes.
const REFRESH = 'PT6H';

/** What a tombstone's title starts with, in the card's own words. */
const OFF = { cancelled: 'Cancelled', combined: 'Combined', break: 'On a break' };
const OFF_SAYS = {
  cancelled: 'This has been cancelled.',
  combined: 'Combined with another service, held elsewhere this time.',
  break: 'Not held: the parish is on a break.',
};

/** A TEXT value, escaped (RFC 5545 3.3.11). */
export function escapeText(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * One content line folded at 75 octets (3.1), never inside a character: a
 * Greek or Arabic title is two bytes a letter, and a split letter is a
 * broken one in every calendar that reads it.
 */
export function foldLine(line) {
  const enc = new TextEncoder();
  const out = [];
  let rest = line, limit = 75;
  while (enc.encode(rest).length > limit) {
    let n = Math.min(rest.length, limit);
    while (n > 1 && enc.encode(rest.slice(0, n)).length > limit) n--;
    // Never between the halves of a surrogate pair (an emoji in a title).
    const c = rest.charCodeAt(n - 1);
    if (c >= 0xd800 && c <= 0xdbff) n--;
    out.push(rest.slice(0, n));
    rest = rest.slice(n);
    limit = 74;   // a continuation line spends one octet on its leading space
  }
  out.push(rest);
  return out.join('\r\n ');
}

/** '2026-11-22T23:30:00.000Z' → '20261122T233000Z'. Null for no date. */
export function utcStamp(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

const tombOf = (e) => (e.status in OFF ? e.status : (e.is_tombstone ? 'cancelled' : null));

/** "Liturgy — St John Chrysostom", "Cancelled: Liturgy". */
export function summaryOf(e) {
  const name = e.feast && e.feast !== e.title ? `${e.title} — ${e.feast}` : (e.title || 'Event');
  const off = tombOf(e);
  return off ? `${OFF[off]}: ${name}` : name;
}

/** ['English', 'Arabic'] from the JSON text a row carries, or a list. */
function languagesOf(e) {
  const raw = e.languages != null ? e.languages : e.parish_languages;
  if (Array.isArray(raw)) return raw.filter(Boolean);
  try { const l = JSON.parse(raw || '[]'); return Array.isArray(l) ? l.filter(Boolean) : []; } catch { return []; }
}

/**
 * Where, as a calendar's location line: a place of its own, another parish,
 * else the parish itself. lib/venues.mjs says why it is these three.
 */
export function locationOf(e, parishes) {
  if (e.location_override) return e.location_override;
  const at = e.location_parish_id && parishes.get(e.location_parish_id);
  const p = at || parishes.get(e.parish_id);
  if (!p) return e.parish_address || null;
  return [p.name, p.address].filter(Boolean).join(', ');
}

function geoOf(e, parishes) {
  if (e.location_override) {
    return e.location_lat != null && e.location_lng != null ? [e.location_lat, e.location_lng] : null;
  }
  const p = parishes.get(e.location_parish_id || e.parish_id);
  return p && p.lat != null && p.lng != null ? [p.lat, p.lng] : null;
}

/** The notes: its own words, what makes it off, its language, and the way back to its card. */
export function descriptionOf(e, { origin }) {
  const parts = [];
  const off = tombOf(e);
  if (off) parts.push([OFF_SAYS[off], off === 'break' ? e.break_note : null].filter(Boolean).join(' '));
  if (e.description) parts.push(e.description);
  const langs = languagesOf(e);
  if (langs.length && e.languages != null) parts.push(`In ${langs.join(' and ')}.`);
  parts.push(`${origin}/${e.id}`);
  return parts.join('\n\n');
}

/** The lines of one VEVENT. */
export function eventLines(e, { parishes = new Map(), origin, stamp }) {
  const start = utcStamp(e.start_utc);
  if (!start) return [];
  const endMs = e.end_utc && Date.parse(e.end_utc) > Date.parse(e.start_utc)
    ? Date.parse(e.end_utc) : Date.parse(e.start_utc) + DEFAULT_MINUTES * 60000;
  const changed = utcStamp(e.updated_at) || utcStamp(e.created_at) || stamp;
  const lines = [
    'BEGIN:VEVENT',
    `UID:${String(e.id)}@${UID_HOST}`,
    `DTSTAMP:${changed}`,
    `LAST-MODIFIED:${changed}`,
    `DTSTART:${start}`,
    `DTEND:${utcStamp(new Date(endMs).toISOString())}`,
    `SUMMARY:${escapeText(summaryOf(e))}`,
  ];
  const where = locationOf(e, parishes);
  if (where) lines.push(`LOCATION:${escapeText(where)}`);
  const geo = geoOf(e, parishes);
  if (geo) lines.push(`GEO:${Number(geo[0]).toFixed(6)};${Number(geo[1]).toFixed(6)}`);
  lines.push(`DESCRIPTION:${escapeText(descriptionOf(e, { origin }))}`);
  lines.push(`URL:${origin}/${String(e.id)}`);
  // A tombstone takes no time out of anybody's day.
  if (tombOf(e)) lines.push('TRANSP:TRANSPARENT');
  lines.push('END:VEVENT');
  return lines;
}

/**
 * A whole calendar.
 *
 * @param {object} o
 * @param {string} o.name      what the calendar is called in the phone's list
 * @param {object[]} o.events  the lens's rows (projected dates and one-offs)
 * @param {Map|object[]} o.parishes  by id, for where each is
 * @param {string} o.origin    'https://orthodoxy.au'
 * @param {boolean} [o.feed]   a subscription (asks to be looked at again) or one date's file
 * @param {number} [o.now]
 */
export function calendarText({ name, events, parishes = new Map(), origin, feed = true, now = Date.now() }) {
  const byId = parishes instanceof Map ? parishes : new Map((parishes || []).map(p => [p.id, p]));
  const stamp = utcStamp(new Date(now).toISOString());
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
  ];
  if (name) lines.push(`X-WR-CALNAME:${escapeText(name)}`, `NAME:${escapeText(name)}`);
  if (feed) lines.push(`REFRESH-INTERVAL;VALUE=DURATION:${REFRESH}`, `X-PUBLISHED-TTL:${REFRESH}`);
  for (const e of events || []) lines.push(...eventLines(e, { parishes: byId, origin, stamp }));
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

