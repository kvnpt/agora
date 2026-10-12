// Where something happens when it is not the parish's own church.
//
// Migration 023. A place is one of three things, and a request names it with
// four fields that travel together:
//
//   at home            all four empty — the parish's address and pin
//   at another parish  location_parish_id — that parish's name, address, pin
//   a place of its own location_override (its words) and location_lat/lng
//                      (its pin, looked up from the address or put on the door
//                      by hand); the map draws it as a square marker
//
// The same reading for an event, a rule, one date's override and a draft
// card, so the four cannot disagree about what a place is. Naming the host
// parish itself as the venue is "at home".

const KEYS = ['location_parish_id', 'location_override', 'location_lat', 'location_lng'];

const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** Does this body say anything about where? */
export const namesVenue = (body) => !!body && KEYS.some(k => body[k] !== undefined);

/**
 * The place a body names, checked.
 *
 * @returns {{present: false}
 *   | {present: true, venue: {location_parish_id, location_override, location_lat, location_lng},
 *      pin: {lat, lng} | null}
 *   | {error: string}}
 *   `pin` is where distance is measured from: the venue parish's pin, the
 *   place's own, or null (at home, or words with no pin yet).
 */
export async function readVenue(db, body, { hostParishId = null } = {}) {
  if (!namesVenue(body)) return { present: false };
  const home = { present: true, pin: null,
    venue: { location_parish_id: null, location_override: null, location_lat: null, location_lng: null } };

  const pid = body.location_parish_id ? String(body.location_parish_id).trim() : '';
  if (pid) {
    if (pid === hostParishId) return home;
    const p = await db.prepare('SELECT id, lat, lng FROM parishes WHERE id = ?').bind(pid).first();
    if (!p || pid === '_unassigned') return { error: 'That parish is not on file.' };
    return { present: true, pin: p.lat != null ? { lat: p.lat, lng: p.lng } : null,
      venue: { location_parish_id: pid, location_override: null, location_lat: null, location_lng: null } };
  }

  const text = typeof body.location_override === 'string' ? body.location_override.trim().slice(0, 300) || null : null;
  const lat = num(body.location_lat), lng = num(body.location_lng);
  if (Number.isNaN(lat) || Number.isNaN(lng)) return { error: 'A pin is two numbers.' };
  if ((lat == null) !== (lng == null)) return { error: 'A pin needs both a latitude and a longitude.' };
  if (lat != null && (lat < -90 || lat > 90 || lng < -180 || lng > 180)) return { error: 'That pin is not on the map.' };
  if (!text && lat == null) return home;
  return { present: true, pin: lat != null ? { lat, lng } : null,
    venue: { location_parish_id: null, location_override: text, location_lat: lat, location_lng: lng } };
}

/** A rule's or an event's own place, as the four fields. */
export const venueOf = (row) => ({
  location_parish_id: (row && row.location_parish_id) || null,
  location_override: (row && row.location_override) || null,
  location_lat: row && row.location_lat != null ? row.location_lat : null,
  location_lng: row && row.location_lng != null ? row.location_lng : null,
});

/** Two places the same? */
export const sameVenue = (a, b) => KEYS.every(k => (a[k] ?? null) === (b[k] ?? null));
