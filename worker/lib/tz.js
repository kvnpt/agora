// Timezone resolution for the date lens.
//
// WHY THIS EXISTS. schedule-expand.js called localToUtc() twice per projected
// instance, and each call was a four-step Temporal-polyfill chain doing a full
// IANA lookup. Over a 180-day window at ~100 rules that is ~5,200 timezone
// resolutions per request — comfortably past Workers' 10ms CPU ceiling, which
// meters compute rather than I/O wait.
//
// The insight: a 180-day window has at most 180 distinct answers per zone, not
// 5,200. Resolve the offset ONCE per (zone, date) and the per-instance cost
// collapses to a cache hit plus arithmetic.
//
// Correctness is not traded away. DST transition days genuinely have two
// offsets, so a date is only cached as uniform when its 00:00 and 23:59 offsets
// agree. Transition days fall back to exact per-instant resolution, which is
// ~2 days per zone per year.
//
// Uses the runtime's own Intl — native in Workers and in browsers — so nothing
// is shipped and nothing is polyfilled.

const MIN = 60000;

const _formatters = new Map();
function formatter(zone) {
  let f = _formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit'
    });
    _formatters.set(zone, f);
  }
  return f;
}

// Offset in minutes east of UTC for `epochMs` in `zone`.
// Formats the instant into the zone's wall clock, reads those fields back as if
// they were UTC, and takes the difference.
function offsetAt(zone, epochMs) {
  const p = formatter(zone).formatToParts(new Date(epochMs));
  const v = {};
  for (const { type, value } of p) if (type !== 'literal') v[type] = value;
  const asIfUtc = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour, +v.minute, +v.second);
  return (asIfUtc - epochMs) / MIN;
}

// Exact resolution on a transition day, given the day's two offsets (the
// offset in force at local 00:00 and at local 23:59).
//
// Disambiguation matches Temporal's 'compatible' default, which is what the
// previous implementation used: a time inside a spring-forward gap shifts
// forward by the gap; a time inside a fall-back overlap takes the earlier
// (first) occurrence.
//
// A time inside a fall-back OVERLAP is valid under both offsets and occurs
// twice; probing only one of them silently returns the second occurrence. A
// time inside a spring-forward GAP is valid under neither.
function transitionLocalToEpoch(zone, dateStr, timeStr, offA, offB) {
  const naive = naiveEpoch(dateStr, timeStr);
  const candA = naive - offA * MIN;
  const candB = naive - offB * MIN;
  // Valid when the zone reads that instant back as exactly the wall clock asked
  // for: epoch + offset(epoch) === naive.
  const valid = (e) => e + offsetAt(zone, e) * MIN === naive ? e : null;
  const a = valid(candA), b = valid(candB);
  if (a !== null && b !== null) return Math.min(a, b);  // overlap -> earlier occurrence
  if (a !== null) return a;
  if (b !== null) return b;
  return candA;                                         // gap -> shift forward by the gap
}

// Standalone exact resolution when the day's offsets aren't already known.
function exactLocalToEpoch(zone, dateStr, timeStr) {
  const startNaive = naiveEpoch(dateStr, '00:00');
  const endNaive = naiveEpoch(dateStr, '23:59');
  const offA = offsetAt(zone, startNaive - offsetAt(zone, startNaive) * MIN);
  const offB = offsetAt(zone, endNaive - offsetAt(zone, endNaive) * MIN);
  if (offA === offB) return naiveEpoch(dateStr, timeStr) - offA * MIN;
  return transitionLocalToEpoch(zone, dateStr, timeStr, offA, offB);
}

// 'YYYY-MM-DD' + 'HH:MM' read as if UTC, without Date.parse — string parsing
// 5,200 times a request was itself a measurable slice of the CPU budget.
function naiveEpoch(dateStr, timeStr) {
  const y = +dateStr.slice(0, 4), mo = +dateStr.slice(5, 7), d = +dateStr.slice(8, 10);
  const h = +timeStr.slice(0, 2), mi = +timeStr.slice(3, 5);
  return Date.UTC(y, mo - 1, d, h, mi, 0, 0);
}

// Minutes past local midnight, for the arithmetic fast path.
function timeToMinutes(timeStr) {
  return (+timeStr.slice(0, 2)) * 60 + (+timeStr.slice(3, 5));
}

/**
 * A per-request offset cache.
 *
 * Build one per request and let it die with the request — Workers isolates are
 * shared across requests, so a process-lifetime cache would be unbounded.
 */
class OffsetCache {
  constructor() { this.days = new Map(); }

  // { uniform: true, base } when the whole local day shares one offset — `base`
  // is the epoch of local midnight, so a time-of-day is one multiply away.
  // Otherwise { uniform: false } and callers take the exact path.
  _day(zone, dateStr) {
    const key = zone + '|' + dateStr;
    let d = this.days.get(key);
    if (d) return d;
    const startNaive = naiveEpoch(dateStr, '00:00');
    const endNaive = naiveEpoch(dateStr, '23:59');
    const a = offsetAt(zone, startNaive - offsetAt(zone, startNaive) * MIN);
    const b = offsetAt(zone, endNaive - offsetAt(zone, endNaive) * MIN);
    d = a === b
      ? { uniform: true, base: startNaive - a * MIN }
      : { uniform: false, offA: a, offB: b };
    this.days.set(key, d);
    return d;
  }

  /** Local wall clock ('YYYY-MM-DD', 'HH:MM') in `zone` -> epoch ms. */
  epoch(zone, dateStr, timeStr) {
    const d = this._day(zone, dateStr);
    if (d.uniform) return d.base + timeToMinutes(timeStr) * MIN;
    return transitionLocalToEpoch(zone, dateStr, timeStr, d.offA, d.offB);
  }

  /** Local wall clock -> UTC ISO string, matching the stored millisecond format. */
  toUtcISO(zone, dateStr, timeStr) {
    return new Date(this.epoch(zone, dateStr, timeStr)).toISOString();
  }

  get size() { return this.days.size; }
}

module.exports = { OffsetCache, offsetAt, exactLocalToEpoch, transitionLocalToEpoch };
