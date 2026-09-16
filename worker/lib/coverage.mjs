// How much future a scrape can still speak for.
//
// THE FAILURE THIS EXISTS FOR. A parish that publishes a month of services at a
// time eventually does not publish the next one. Nothing about that looks like
// a failure: the Action fetches the same PDF it fetched last week, the parser
// reads it perfectly, the adapter writes the same events it wrote before, and
// `adapter_runs.status` is 'success' forever. The feed just quietly has nothing
// in it for that parish, and `/api/adapters/status` says OK.
//
// That is not hypothetical. On 16 September 2026 the Sunshine Coast adapter
// reported healthy with `window: 2026-04-09 -> 2026-04-09` — a single day five
// months in the past — because the only dated service it could read out of the
// 2026 sheet was Holy Thursday. And Blacktown's source PDF was last republished
// for July while the parish's programme page still advertised July in the
// middle of September. Neither shows up in a status built on `status !==
// 'failed'`, because neither run failed.
//
// WHY THIS IS NOT `healthy`. The run worked. Folding coverage into `healthy`
// would report a working scraper as broken, and this codebase already draws
// that line deliberately elsewhere — `tombstones_refused` is surfaced beside
// the status rather than inside it, because "the scrape worked and declined to
// cancel anything" is a third thing. So is "the scrape worked and the source
// has run out of dates". Coverage is its own field with its own states.
//
// WHY IT IS NOT A SCHEDULING INPUT EITHER. The tempting version of this is to
// re-fetch more often as the horizon approaches. It buys nothing: fetching a
// parish's website twice as often does not make the parish publish, and the
// Action already polls weekly, which bounds pickup at seven days for a monthly
// publisher. What was missing was never fetch frequency — it was anyone
// noticing. This is the noticing.

const DAY_MS = 86400000;

/**
 * How many days of warning before a horizon counts as `ending`.
 *
 * Three weeks, because that is roughly the notice a monthly publisher gives:
 * a parish posting next month's programme in the last week of this one leaves
 * about that much runway. It is deliberately ONE number rather than a per-source
 * setting — no one has tuned it yet, and a knob added before anybody has wanted
 * to turn it is a knob that gets set wrong.
 *
 * A yearly publisher is the case this serves least well: three weeks' notice on
 * an annual sheet is late, though still better than the none there is now.
 */
export const COVERAGE_WARN_DAYS = 21;

/**
 * The coverage state of one run, from the window it reported.
 *
 * Returns `{ state, until, daysLeft }` where state is one of:
 *
 *   'unknown'  the run reported no window — it read nothing it could date, so
 *              it cannot speak for any day at all. Distinct from `expired`:
 *              one source has run out, the other never said.
 *   'expired'  the last day it covers is today or earlier. The parish has
 *              published nothing beyond now, and the feed is empty past it.
 *   'ending'   inside COVERAGE_WARN_DAYS of running out.
 *   'ok'       further out than that.
 *
 * `windowTo` is a LOCAL date (`adapter_runs.window_to`, per schema.sql) and
 * `today` is compared as a plain UTC date, so the answer can be a day out at
 * the edges. At a three-week threshold that does not matter, and carrying the
 * parish's zone this far to fix it would buy a day of precision on a number
 * whose whole job is to be approximate.
 *
 * A rolling source never trips this on its own: the Google Calendar adapter
 * asks for ninety days every time, so its horizon moves forward with it. It
 * only goes quiet if the adapter itself stops running — which is a real thing
 * to report, and reports as the same sentence: the dates this source can speak
 * for have run out.
 */
export function coverageState(windowTo, today, { warnDays = COVERAGE_WARN_DAYS } = {}) {
  if (!windowTo) return { state: 'unknown', until: null, daysLeft: null };

  const end = Date.parse(`${String(windowTo).slice(0, 10)}T00:00:00Z`);
  const now = Date.parse(`${String(today).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(now)) {
    return { state: 'unknown', until: null, daysLeft: null };
  }

  const daysLeft = Math.round((end - now) / DAY_MS);
  const state = daysLeft <= 0 ? 'expired' : (daysLeft <= warnDays ? 'ending' : 'ok');
  return { state, until: String(windowTo).slice(0, 10), daysLeft };
}

/** A sentence for the status payload and the admin panel. Null when nothing to say. */
export function coverageMessage({ state, until, daysLeft }) {
  if (state === 'ok') return null;
  if (state === 'unknown') return 'Nothing dated was read, so this run covers no days at all.';
  if (state === 'expired') {
    const ago = Math.abs(daysLeft);
    return `Out of dates: the source covers nothing after ${until}`
      + `${ago === 0 ? ' (today)' : `, ${ago} day${ago === 1 ? '' : 's'} ago`}.`;
  }
  return `Running dry: the source covers only ${daysLeft} more day${daysLeft === 1 ? '' : 's'}, to ${until}.`;
}
