// Comparing what the rules say is on against what a source actually published.
//
// PURE, and deliberately opinion-free: it reports a diff and decides nothing.
// Whether a missing occurrence becomes a tombstone is policy, that policy has
// guards, and it belongs where the guards can be read in one place.
//
// WHY MATCHING IS LOOSE HERE
//
// merge.mjs's partitionKey is parish + exact instant + exact title. That is
// right for collapsing duplicates and useless for this. Parishes decorate
// titles on the day — "Divine Liturgy" becomes "Divine Liturgy — Sunday of the
// Prodigal Son" — and move a service half an hour without meaning anything by
// it. Under a strict key both read as "the rule's occurrence did not happen",
// and the consequence of that reading is a service publicly marked CANCELLED.
//
// Hence the asymmetry governing every judgement call in this file. A missed
// cancellation leaves a stale card, and the next scrape can fix it. A false
// cancellation keeps someone away from a service that is running. When in
// doubt, match.

import { localPartsOf } from '../../public/shared/tz.mjs';

const MIN_MS = 60000;
const DAY_MS = 86400000;

const addDays = (date, n) =>
  new Date(Date.parse(date + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);

/**
 * The local dates a source's instant range FULLY covers.
 *
 * Sources ask in instants — Google's timeMin is "now" and timeMax is "now plus
 * ninety days" — and absence is judged per local date. Converting one to the
 * other by naming the dates at each end WIDENS the range, and every day it adds
 * is a day the source never had the chance to report on. Those days then read
 * as absent, and absence writes tombstones: a clean scrape marking real
 * services cancelled at both edges, on every run. It did exactly that the first
 * time this was run end to end.
 *
 * So round inward. A scrape starting at 3pm cannot speak for that morning's
 * liturgy, and one ending at 3pm on day ninety cannot speak for that evening's
 * vespers. Both days are dropped.
 *
 * @returns {{windowFrom: string, windowTo: string}|null} null if nothing is
 *          fully covered — a window shorter than a day proves nothing.
 */
export function coveredLocalDates(timezone, fromIso, toIso) {
  const f = localPartsOf(timezone, Date.parse(fromIso));
  const t = localPartsOf(timezone, Date.parse(toIso));
  // Start: a day is covered only if the range began at or before its midnight.
  const windowFrom = f.time === '00:00' ? f.date : addDays(f.date, 1);
  // End: the day the range stops inside is never complete, whatever the time —
  // ending at 00:00 covers none of it, ending at 23:59 still misses a minute.
  const windowTo = addDays(t.date, -1);
  return windowFrom > windowTo ? null : { windowFrom, windowTo };
}

const norm = (t) => String(t || '').trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * Plausibly the same service: equal titles, or one a prefix of the other at a
 * word boundary. Prefix rather than substring — "Vespers" and "Great Vespers"
 * are arguably one service, but "Liturgy" appearing somewhere inside a longer
 * unrelated title is not evidence of anything.
 */
export function titlesMatch(a, b) {
  const x = norm(a), y = norm(b);
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (!short || !long.startsWith(short)) return false;
  const next = long[short.length];
  return next === undefined || !/[a-z0-9]/.test(next);
}

/**
 * @param {object} args
 *   projected         schedule instances, as expandFrom() emits them
 *   scraped           occurrences a source just published
 *   timezone          the parish's IANA zone. Dates are compared in local
 *                     terms, because "which day is this service on" is a local
 *                     question and the answer differs near midnight.
 *   windowFrom/To     local 'YYYY-MM-DD' bounds of what the source was asked
 *                     for. Absence outside them says nothing at all.
 *   toleranceMinutes  how far a start may drift and still be one service
 * @returns {{matched: Array, moved: Array, missing: Array, extra: Array}}
 */
export function reconcile({
  projected = [],
  scraped = [],
  timezone = 'Australia/Sydney',
  windowFrom,
  windowTo,
  toleranceMinutes = 90,
} = {}) {
  const local = (o) => {
    const ms = Date.parse(o.start_utc);
    return Number.isNaN(ms) ? null : { ...localPartsOf(timezone, ms), ms, o };
  };
  const inWindow = (d) => (!windowFrom || d >= windowFrom) && (!windowTo || d <= windowTo);

  const want = projected.map(local).filter(p => p && inWindow(p.date));
  const have = scraped.map(local).filter(Boolean);

  const claimed = new Set();
  const matched = [], moved = [], missing = [];

  for (const p of want) {
    // Best candidate on the same local day: a title match first, then closest.
    let best = null;
    for (let i = 0; i < have.length; i++) {
      if (claimed.has(i) || have[i].date !== p.date) continue;
      const ok = titlesMatch(p.o.title, have[i].o.title);
      const drift = Math.abs(have[i].ms - p.ms) / MIN_MS;
      const score = (ok ? 0 : 1e6) + drift;
      if (!best || score < best.score) best = { i, ok, drift, score, s: have[i] };
    }

    if (!best || !best.ok) { missing.push(p.o); continue; }
    claimed.add(best.i);

    if (best.drift <= toleranceMinutes) {
      matched.push({ instance: p.o, event: best.s.o });
    } else {
      // Same service, same day, a different hour: a time change. Reading it as
      // a cancellation would bury a service that is running.
      moved.push({ instance: p.o, event: best.s.o, driftMinutes: Math.round(best.drift) });
    }
  }

  const extra = have.filter((_, i) => !claimed.has(i)).map(s => s.o);
  return { matched, moved, missing, extra };
}
