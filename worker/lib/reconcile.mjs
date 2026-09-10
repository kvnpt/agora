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
