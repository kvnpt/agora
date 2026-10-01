// One poster, many services: a parish bulletin put on every service it covers.
//
// A poster belongs to an occurrence, not to a rule (CLAUDE.md, "A poster
// belongs to an occurrence") — and that stays true here. What a parish actually
// sends is a bulletin for a PERIOD: Crows Nest's covers September, its four
// Sundays, its feasts and its two Paraklesis services. Putting it on the rule
// would show September's commemorations on November's Liturgy, with nothing to
// say it was stale. So the upload names a range, and each occurrence in it is
// pointed at ONE object — the same shape the hand-entered Crows Nest bulletin
// already has (docs/adapters.md), now reachable from the app.
//
// Two scopes:
//   rule    every occurrence of the anchor's rule between `from` and `until`
//   parish  every rule's occurrences at that parish, and its stored one-offs,
//           between the same dates
//
// What it will not write over: an occurrence a break silences (an override
// beats a break, so a poster there would quietly reinstate the service), and
// one somebody hid (it is not on the site to carry a flyer). A cancelled or
// combined occurrence keeps what it is and gains the poster, exactly as the
// single-occurrence upload does — see applyAdminEdit.
//
// The object is released, not just un-pointed, once nothing refers to it:
// `releaseUnused` deletes a poster from R2 only when no event and no override
// still names it, so taking a bulletin off one Sunday leaves the other three.

import { isValidOccurrence, breakCovering } from './expand.mjs';
import { localDateOf } from '../../public/shared/tz.mjs';

const DAY_MS = 86400000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;
/** A year and a day: a standing flyer is a year out, not open-ended. */
export const MAX_RANGE_DAYS = 366;
export const SCOPES = ['rule', 'parish'];

const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);

/** Is this a real calendar date, not merely date-shaped? */
const realDate = (d) => ISO.test(d) && new Date(d + 'T00:00:00Z').toISOString().slice(0, 10) === d;

/**
 * Validate a range request. Returns { scope, from, until } or { error }.
 * `anchorDate` is the local date of the service the upload was made from; it
 * has to be inside the range, or the poster would not land where it was put.
 */
export function readRange({ scope, from, until }, { anchorDate, anchorIsRule }) {
  if (!SCOPES.includes(scope)) return { error: `scope must be one of ${SCOPES.join(', ')}` };
  if (scope === 'rule' && !anchorIsRule) {
    return { error: 'A one-off has no other dates — use scope=parish to cover the parish’s services' };
  }
  if (!realDate(from || '') || !realDate(until || '')) return { error: 'from and until must be dates (YYYY-MM-DD)' };
  if (from > until) return { error: 'until is before from' };
  if ((Date.parse(until) - Date.parse(from)) / DAY_MS + 1 > MAX_RANGE_DAYS) {
    return { error: `A range is at most ${MAX_RANGE_DAYS} days` };
  }
  if (anchorDate && (anchorDate < from || anchorDate > until)) {
    return { error: `The range ${from} – ${until} does not include this service (${anchorDate})` };
  }
  return { scope, from, until };
}

/**
 * The occurrences a range covers: [{ schedule_id, date, previous }], where
 * `previous` is the poster that occurrence had (to release afterwards).
 *
 * Pure — rows in, targets out. `schedules` are the rules in scope (already
 * narrowed to one rule or one parish), `overrides` and `breaks` those that
 * touch the range.
 */
export function ruleTargets({ schedules, overrides, breaks }, from, until) {
  const ov = new Map((overrides || []).map(o => [`${o.schedule_id}:${o.occurrence_date}`, o]));
  const out = [];
  for (const s of schedules || []) {
    for (let d = from; d <= until; d = addDays(d, 1)) {
      if (!isValidOccurrence(s, d)) continue;
      const o = ov.get(`${s.id}:${d}`);
      if (o && o.kind === 'hidden') continue;
      // No override and a break: the service is not running, and a write here
      // would be an override — which beats the break and brings it back.
      if (!o && breakCovering(s, d, breaks)) continue;
      out.push({ schedule_id: s.id, date: d, previous: (o && o.patch_poster_path) || null });
    }
  }
  return out;
}

/** Stored one-offs whose start falls on a local date in the range. */
export function oneOffTargets(events, zone, from, until) {
  return (events || []).filter(e => {
    const d = localDateOf(zone, Date.parse(e.start_utc));
    return d >= from && d <= until;
  });
}

// D1 binds at most 100 parameters to a statement; three per row.
const ROWS_PER_STATEMENT = 30;

/**
 * Point every target occurrence at `path`. An existing override keeps its
 * kind and every other patch — only the poster changes — and a new one is a
 * 'modified' override carrying nothing but the poster, which is what the
 * single upload writes too.
 */
export function overrideStatements(db, targets, path) {
  const stmts = [];
  for (let i = 0; i < targets.length; i += ROWS_PER_STATEMENT) {
    const chunk = targets.slice(i, i + ROWS_PER_STATEMENT);
    stmts.push(db.prepare(`
      INSERT INTO schedule_overrides (schedule_id, occurrence_date, kind, patch_poster_path)
      VALUES ${chunk.map(() => "(?, ?, 'modified', ?)").join(', ')}
      ON CONFLICT(schedule_id, occurrence_date) DO UPDATE SET
        patch_poster_path = excluded.patch_poster_path,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')
    `).bind(...chunk.flatMap(t => [t.schedule_id, t.date, path])));
  }
  return stmts;
}

/** The R2 key a stored poster path names: '/posters/x.png?v=1' → 'posters/x.png'. */
export function posterKeyOf(path) {
  if (!path || typeof path !== 'string') return null;
  const key = path.replace(/^\//, '').split('?')[0];
  return key.startsWith('posters/') ? key : null;
}

/**
 * SQL naming one poster object in `col`, with or without its ?v= — and the
 * values to bind, in order.
 *
 * A prefix comparison rather than `LIKE '/posters/…?%'`: D1 caps a LIKE
 * pattern at 50 bytes and refuses anything longer ("pattern too complex"), and
 * a range key — parish id, two dates and a stamp — is longer than that. Local
 * SQLite has no such cap, so only a run against D1 itself shows it.
 */
export function namesPoster(col, key) {
  const exact = '/' + key;
  const versioned = exact + '?';
  return {
    sql: `(${col} = ? OR substr(${col}, 1, ?) = ?)`,
    args: [exact, versioned.length, versioned],
  };
}

/** Is anything still pointing at this R2 key? */
async function referenced(db, key) {
  const ev = namesPoster('poster_path', key);
  const ov = namesPoster('patch_poster_path', key);
  const row = await db.prepare(`
    SELECT 1 FROM events WHERE ${ev.sql}
    UNION ALL
    SELECT 1 FROM schedule_overrides WHERE ${ov.sql}
    LIMIT 1
  `).bind(...ev.args, ...ov.args).first();
  return !!row;
}

/**
 * Delete the objects behind these paths that nothing refers to any more.
 * Returns the keys deleted. `keep` is a key that must survive regardless —
 * the one just uploaded, which a sweep must never race.
 */
export async function releaseUnused(env, paths, { keep = null } = {}) {
  if (!env.ASSETS_BUCKET) return [];
  const keys = [...new Set((paths || []).map(posterKeyOf).filter(Boolean))].filter(k => k !== keep);
  const gone = [];
  for (const k of keys) {
    if (!(await referenced(env.DB, k))) gone.push(k);
  }
  if (gone.length) await env.ASSETS_BUCKET.delete(gone);
  return gone;
}
