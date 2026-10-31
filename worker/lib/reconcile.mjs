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
import services from '../../public/shared/services.js';

const { serviceOf } = services;

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
 * The same service by name, which is a looser question than `titlesMatch`:
 * the titles match, or both name the same service. "Liturgy" and "Divine
 * Liturgy", "Matins" and "Matins (Orthros)", "Vespers" and "Great Vespers".
 *
 * Good Shepherd, Clayton is why. Its rules say "Matins" and "Liturgy" (the
 * Archdiocese's words) and its calendar says "Matins (Orthros)" and "Divine
 * Liturgy", so neither title is a prefix of the other — and every Sunday the
 * feed showed both, and a run would have cancelled every Sunday Liturgy.
 *
 * The services are the site's own list (public/shared/services.js), the one
 * that also answers /gsm/liturgy, so a calendar entry pairs with a rule
 * exactly when a link would call them the same service. A feast is not one: it
 * names the day, not what is served.
 */
export function sameService(a, b) {
  if (titlesMatch(a, b)) return true;
  const x = serviceOf({ title: a || '' }), y = serviceOf({ title: b || '' });
  return !!x && x === y && x !== 'feast';
}

/**
 * Pair what the rules project with what a source published.
 *
 * @param {object} args
 *   projected         schedule instances, as expandFrom() emits them
 *   scraped           occurrences a source just published
 *   timezone          the parish's IANA zone. Dates are compared in local
 *                     terms, because "which day is this service on" is a local
 *                     question and the answer differs near midnight.
 *   windowFrom/To     local 'YYYY-MM-DD' bounds of what the source was asked
 *                     for. Absence outside them says nothing at all.
 *   toleranceMinutes  how far a start may drift and still be one service
 * @returns {{matched: Array, moved: Array, held: Array, missing: Array,
 *            unpaired: Array, extra: Array}}
 *
 *   matched   [{instance, event, driftMinutes}] the same service, within tolerance
 *   moved     [{instance, event, driftMinutes}] the same service, a different hour
 *   held      [{instance, event}] something ELSE at the rule's exact time. Not
 *             claimed as the service (the event stays in `extra`), but not
 *             missing either: when in doubt, match.
 *   missing   unpaired instances inside the window: the only list that may
 *             become a cancellation (tombstone.mjs decides)
 *   unpaired  every unpaired instance, edge days too, held ones excepted
 *   extra     events no instance claimed as itself
 *
 * Pairs are chosen best first across the whole run, not rule by rule, so the
 * order the rules happen to arrive in cannot hand an event to the wrong one:
 * the same service at the same minute, then the same service nearest in time,
 * an exact title before a related one. Only then does an unrelated event at
 * the rule's exact minute hold it. One event is never two services.
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

  const want = projected.map(local).filter(Boolean);
  const have = scraped.map(local).filter(Boolean);

  // Every same-day pairing worth considering, scored.
  const related = [], sameMinute = [];
  for (let w = 0; w < want.length; w++) {
    for (let h = 0; h < have.length; h++) {
      if (have[h].date !== want[w].date) continue;
      const drift = Math.abs(have[h].ms - want[w].ms) / MIN_MS;
      if (sameService(want[w].o.title, have[h].o.title)) {
        // An exact title wins a tie over a merely related one.
        related.push({ w, h, drift, score: drift + (titlesMatch(want[w].o.title, have[h].o.title) ? 0 : 0.5) });
      } else if (drift === 0) {
        sameMinute.push({ w, h, drift, score: 0 });
      }
    }
  }
  const byScore = (a, b) => a.score - b.score || a.w - b.w || a.h - b.h;
  related.sort(byScore);
  sameMinute.sort(byScore);

  const pairedWant = new Map(), claimed = new Set();
  for (const c of related) {
    if (pairedWant.has(c.w) || claimed.has(c.h)) continue;
    pairedWant.set(c.w, c);
    claimed.add(c.h);
  }
  const heldWant = new Map(), heldHave = new Set();
  for (const c of sameMinute) {
    if (pairedWant.has(c.w) || heldWant.has(c.w) || claimed.has(c.h) || heldHave.has(c.h)) continue;
    heldWant.set(c.w, c);
    heldHave.add(c.h);
  }

  const matched = [], moved = [], held = [], missing = [], unpaired = [];
  want.forEach((p, w) => {
    const c = pairedWant.get(w);
    if (c) {
      const pair = { instance: p.o, event: have[c.h].o, driftMinutes: Math.round(c.drift) };
      // Same service, same day, a different hour: a time change. Reading it as
      // a cancellation would bury a service that is running.
      (c.drift <= toleranceMinutes ? matched : moved).push(pair);
      return;
    }
    const k = heldWant.get(w);
    if (k) { held.push({ instance: p.o, event: have[k.h].o }); return; }
    unpaired.push(p.o);
    if (inWindow(p.date)) missing.push(p.o);
  });

  const extra = have.filter((_, i) => !claimed.has(i)).map(s => s.o);
  return { matched, moved, held, missing, unpaired, extra };
}
