// Inferring recurrence rules from a list of concrete occurrences.
//
// Both ingestion shapes end in the same place: a set of dated services inside a
// bounded window. A Google Calendar scrape produces one; a parish's monthly PDF
// produces one. What the feed actually wants is *rules*, so it can project past
// whatever window the source happened to cover — so the interesting work is
// source-agnostic and lives here rather than in any adapter.
//
// PURE. No database, no fetch. Given occurrences, it proposes; something else
// decides whether to write.
//
// THE SAFETY PROPERTY, and the reason this is not just a frequency count:
//
//   A rule is proposed only if, projected across the observed window, it
//   reproduces the observed dates EXACTLY — every occurrence explained, and
//   every gap explained too.
//
// The gaps are the half that matters. Good Shepherd runs a FOUNDATIONS course
// on alternate Sundays. Count weekday frequency alone and "every Sunday" looks
// like a fine rule with a few absences. Write that rule, then let absence drive
// tombstoning, and the four Sundays it does not run become four services
// publicly marked CANCELLED. A wrong rule turns absence detection into a
// cancellation generator, so the bar for proposing one is that it leaves
// nothing unexplained.

import { localPartsOf } from '../../public/shared/tz.mjs';
import { matchesWeekOfMonth } from '../../public/shared/recurrence.mjs';

const QUALIFIERS = ['first', 'second', 'third', 'fourth', 'last'];
const DAY_MS = 86400000;

/** Whitespace-collapsed title. Deliberately not case-folded: parishes capitalise
 *  meaningfully ("FOUNDATIONS Course"), and two titles differing only in case
 *  are worth showing a human rather than silently merging. */
const normTitle = (t) => String(t || '').trim().replace(/\s+/g, ' ');

const addDays = (date, n) =>
  new Date(Date.parse(date + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);

/** Every date in [from, to] falling on `dow`. */
function weekdayDatesIn(from, to, dow) {
  const out = [];
  let d = from;
  while (new Date(d + 'T00:00:00Z').getUTCDay() !== dow) d = addDays(d, 1);
  for (; d <= to; d = addDays(d, 7)) out.push(d);
  return out;
}

/** Does `week_of_month` reproduce `dates` exactly over the window? */
function fitsExactly(candidate, dates, from, to, dow) {
  const want = new Set(dates);
  const got = weekdayDatesIn(from, to, dow).filter(d => matchesWeekOfMonth(d, candidate));
  return got.length === want.size && got.every(d => want.has(d));
}

/** The smallest set of qualifiers covering every observed date, or null. */
function qualifierFor(dates, from, to, dow) {
  const needed = new Set();
  for (const d of dates) {
    const q = QUALIFIERS.find(q => matchesWeekOfMonth(d, q));
    if (!q) return null;
    needed.add(q);
  }
  const candidate = QUALIFIERS.filter(q => needed.has(q)).join(',');
  return fitsExactly(candidate, dates, from, to, dow) ? candidate : null;
}

/**
 * Is this equally well explained as "every N weeks"? Returns the reading, or
 * null when no interval fits or when the two agree everywhere that matters.
 *
 * schedules has no interval column — week_of_month is the only way to say
 * anything other than weekly — so a fortnightly series can only be written as a
 * set of month positions. Over a window where every month happens to have four
 * of the weekday, the two readings are indistinguishable, and they diverge the
 * first time one has five. That divergence is a real fork about a real service,
 * and the data cannot settle it, so it gets reported rather than guessed.
 */
function intervalReading(dates, qualifier, dow) {
  if (dates.length < 3) return null;
  const gaps = [];
  for (let i = 1; i < dates.length; i++) {
    gaps.push(Math.round((Date.parse(dates[i]) - Date.parse(dates[i - 1])) / DAY_MS));
  }
  const weeks = gaps[0] / 7;
  if (!Number.isInteger(weeks) || weeks < 2) return null;
  if (!gaps.every(g => g === gaps[0])) return null;

  // Where do the two readings first disagree? Walk forward from the last
  // observed date until the interval reading and the qualifier reading differ.
  const last = dates[dates.length - 1];
  let divergesOn = null;
  let byInterval = addDays(last, gaps[0]);
  for (const d of weekdayDatesIn(addDays(last, 1), addDays(last, 120), dow)) {
    const wantedByQualifier = matchesWeekOfMonth(d, qualifier);
    const wantedByInterval = d === byInterval;
    if (wantedByInterval) byInterval = addDays(byInterval, gaps[0]);
    if (wantedByQualifier !== wantedByInterval) { divergesOn = d; break; }
  }
  if (!divergesOn) return null;

  return {
    label: `every ${weeks} weeks`,
    firstDivergence: divergesOn,
    wantedBy: matchesWeekOfMonth(divergesOn, qualifier) ? qualifier : `every ${weeks} weeks`,
  };
}

/**
 * @param {Array} occurrences  [{ title, start_utc, end_utc, event_type, location_override }]
 * @param {object} opts        { timezone, windowFrom, windowTo, minSupport }
 * @returns {{ proposals: Array, unexplained: Array }}
 */
export function inferSchedules(occurrences, {
  timezone = 'Australia/Sydney',
  windowFrom,
  windowTo,
  minSupport = 3,
} = {}) {
  // Group by the three things a schedule row is keyed on.
  const groups = new Map();
  for (const o of occurrences || []) {
    const ms = Date.parse(o.start_utc);
    if (Number.isNaN(ms)) continue;
    const { date, time, dow } = localPartsOf(timezone, ms);
    const title = normTitle(o.title);
    const key = `${title}|${dow}|${time}`;
    let g = groups.get(key);
    if (!g) {
      g = { title, dow, time, dates: [], sample: o };
      groups.set(key, g);
    }
    if (!g.dates.includes(date)) g.dates.push(date);
  }

  // Absence only means anything inside a window we actually looked at. Where
  // the caller does not say, the observed span is the only defensible one.
  const all = [...groups.values()].flatMap(g => g.dates).sort();
  const from = windowFrom || all[0];
  const to = windowTo || all[all.length - 1];

  const proposals = [];
  const unexplained = [];

  for (const g of [...groups.values()].sort((a, b) => b.dates.length - a.dates.length)) {
    const dates = [...g.dates].sort();
    const end = g.sample.end_utc ? localPartsOf(timezone, Date.parse(g.sample.end_utc)).time : null;

    const base = {
      title: g.title,
      day_of_week: g.dow,
      start_time: g.time,
      end_time: end,
      event_type: g.sample.event_type || 'liturgy',
      location_override: g.sample.location_override || null,
    };
    const support = { count: dates.length, dates, from, to };

    if (dates.length < minSupport) {
      unexplained.push({ ...base, support, why: `only ${dates.length} occurrence(s); needs ${minSupport}` });
      continue;
    }

    // Weekly first: it is the simplest rule and the one most services follow.
    if (fitsExactly(null, dates, from, to, g.dow)) {
      proposals.push({ rule: { ...base, week_of_month: null }, support, confidence: 'high', ambiguity: null });
      continue;
    }

    const qualifier = qualifierFor(dates, from, to, g.dow);
    if (qualifier) {
      const interval = intervalReading(dates, qualifier, g.dow);
      if (interval) {
        // Withheld, not offered at low confidence. Both readings fit the sample
        // and they disagree about a real date, so proposing one is a coin flip
        // that renders as fact — and the coin came up wrong when we checked:
        // Good Shepherd's fortnightly course runs on 22 November 2026, which
        // 'second,last' omits while also inventing one on the 29th.
        //
        // schedules has no interval column and is not getting one; fortnightly
        // services are rare enough that leaving them as scraped one-off events
        // costs less than a rule that can express them wrongly.
        unexplained.push({
          ...base, support,
          why: `${interval.label} fits these dates as well as '${qualifier}' does, and ` +
               `schedules cannot express an interval. They disagree first on ` +
               `${interval.firstDivergence}, so neither is safe to assume.`,
        });
        continue;
      }
      proposals.push({
        rule: { ...base, week_of_month: qualifier },
        support,
        // Month positions need to be seen repeating before they mean much: two
        // first-Sundays is also two 28-day gaps.
        confidence: dates.length >= 4 ? 'high' : 'low',
        ambiguity: null,
      });
      continue;
    }

    unexplained.push({ ...base, support, why: 'no weekly or week-of-month rule reproduces these dates exactly' });
  }

  return { proposals, unexplained };
}
