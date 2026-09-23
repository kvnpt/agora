// Which weeks a recurring schedule runs on.
//
// Two independent qualifiers, and a rule uses at most one of them:
//
//   week_of_month  NULL, or a comma-separated subset of
//                  first,second,third,fourth,last
//   week_parity    NULL, or 'a' / 'b' — the fortnightly rule, running on
//                  alternate weeks forever
//
// They are mutually exclusive because together they over-constrain: "1st and
// 3rd Saturday" AND "week B" is a rule that matches roughly a quarter of the
// Saturdays it appears to name, and would look like a broken projection rather
// than a contradiction somebody wrote. The routes refuse the pair; the column
// pair is not CHECK-constrained because `schedules` cannot be rebuilt —
// schedule_overrides references it ON DELETE CASCADE, so a rebuild would
// cascade-delete every override on the way through.

// ─────────────────────────────────────────────────────────────────────────
// Week of the month
// ─────────────────────────────────────────────────────────────────────────

function matchesOneWeek(dateStr, qualifier) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dayOfMonth = d.getUTCDate();
  const nextWeek = new Date(d);
  nextWeek.setUTCDate(dayOfMonth + 7);
  const hasNextWeek = nextWeek.getUTCMonth() === d.getUTCMonth();

  if (qualifier === 'first')  return dayOfMonth <= 7;
  if (qualifier === 'second') return dayOfMonth >= 8  && dayOfMonth <= 14;
  if (qualifier === 'third')  return dayOfMonth >= 15 && dayOfMonth <= 21;
  // 'fourth' = 4th occurrence only when a 5th exists — never overlaps with 'last'
  if (qualifier === 'fourth') return dayOfMonth >= 22 && dayOfMonth <= 28 && hasNextWeek;
  if (qualifier === 'last')   return !hasNextWeek;
  return false;
}

export function matchesWeekOfMonth(dateStr, qualifier) {
  if (!qualifier) return true;
  return qualifier.split(',').some(q => matchesOneWeek(dateStr, q.trim()));
}

// ─────────────────────────────────────────────────────────────────────────
// Week A / week B — the fortnight
// ─────────────────────────────────────────────────────────────────────────
//
// A fortnightly service cannot be written as week_of_month. `docs/parish-
// ingestion.md` records what that cost: Coburg's Compline and its Youth Group
// both alternate with St Vasilios Brunswick, and both rules were DROPPED
// rather than written as month positions that would put a service at Coburg on
// the Tuesdays it is at Brunswick. Good Shepherd's FOUNDATIONS course is the
// case infer.mjs argues at length — 'second,last' is the closest spelling, it
// omits the 22 November the course actually runs and invents two in December.
//
// WHY A PARITY AND NOT A START DATE. Calendar apps anchor a fortnight to its
// first occurrence (RRULE's DTSTART). There is nowhere here to put that. The
// only date-ish field on the row is `effective_from`, which is a VALIDITY
// window — "this rule has been true since" — and making it double as the phase
// would mean that recording a rule's history silently moves which fortnight the
// service falls on. Every rule in production has it NULL, so they would have no
// phase at all. A parity is a property of the date, which is what the lens
// wants: pure, anchor-free, and correct looking backwards as well as forwards,
// which a deep link to /gsc/2019-03 needs.
//
// WHY A TABLE. ISO week parity alone does not survive a 53-week year. At the
// 2026→2027 boundary, 3 January 2027 is 2026-W53 (odd) and 10 January is
// 2027-W01 (odd as well) — two consecutive odd weeks, so "odd weeks" gives a
// fortnightly service a seven-day gap. The table says, per ISO year, which week
// NUMBERS are A, chosen so the alternation carries across that seam. The flips
// in it are exactly the years following a 53-week one.
//
// It is GENERATED, not typed: recurrence.test.mjs rebuilds it from a continuous
// count of weeks and fails if a single entry differs, so "good until 2126" is
// checked rather than claimed.

const DAY_MS = 86400000;
const WEEK_MS = 7 * DAY_MS;
const parseDate = (dateStr) => Date.parse(dateStr + 'T00:00:00Z');

/** First year the table covers. */
export const WEEK_AB_FROM = 2020;

/**
 * Per ISO year: 1 when the ODD week numbers are week A, 0 when the even ones
 * are. Index with `year - WEEK_AB_FROM`.
 */
export const WEEK_AB_TABLE = [
  /* 2020 */ 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1,
  /* 2040 */ 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0,
  /* 2060 */ 0, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 0, 0, 0,
  /* 2080 */ 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1,
  /* 2100 */ 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 1, 1, 1,
  /* 2120 */ 1, 1, 1, 0, 0, 0, 0,
];

/** Last year the table covers. */
export const WEEK_AB_TO = WEEK_AB_FROM + WEEK_AB_TABLE.length - 1;

// The Monday the epoch counts from. 5 January 1970 is a Monday; which of the
// two cycles gets called "A" is this line and nothing else.
const EPOCH_MONDAY = parseDate('1970-01-05');

/** The Monday of the ISO week containing this instant. */
function mondayOf(ms) {
  const dow = (new Date(ms).getUTCDay() + 6) % 7;   // Mon=0 .. Sun=6
  return ms - dow * DAY_MS;
}

/**
 * Which week numbers are A in `year`, for a year the table does not reach.
 *
 * The table is the shipped answer and the one to read; this continues the same
 * sequence past its end, because the alternative is a feed that silently stops
 * alternating at a horizon. `state._horizonDays` only ever grows and Load more
 * never takes it away — "the feed has no last page" — so the one thing this
 * must not do is have a last page of its own.
 */
function computedWeekAParity(year) {
  // ISO week 1 is the week containing 4 January.
  const week1 = mondayOf(Date.UTC(year, 0, 4));
  return Math.round((week1 - EPOCH_MONDAY) / WEEK_MS) % 2 === 0 ? 1 : 0;
}

/** Which week numbers are A in `year`: 1 = the odd ones, 0 = the even ones. */
export function weekAParity(year) {
  const i = year - WEEK_AB_FROM;
  const v = WEEK_AB_TABLE[i];
  return v === undefined ? computedWeekAParity(year) : v;
}

/** The ISO year and week number a local date falls in. */
export function isoWeekOf(dateStr) {
  const ms = parseDate(dateStr);
  // The Thursday of this week decides which ISO year the week belongs to —
  // which is why a date in early January can read as week 53 of the year before.
  const thursday = mondayOf(ms) + 3 * DAY_MS;
  const year = new Date(thursday).getUTCFullYear();
  const week1 = mondayOf(Date.UTC(year, 0, 4));
  return { year, week: 1 + Math.round((mondayOf(ms) - week1) / WEEK_MS) };
}

/** 'a' or 'b' — which fortnight this local date falls in. */
export function weekAbOf(dateStr) {
  const { year, week } = isoWeekOf(dateStr);
  return (week % 2) === weekAParity(year) ? 'a' : 'b';
}

/**
 * Does a rule qualified 'a' or 'b' run on this date? NULL parity is not a
 * fortnightly rule and matches every week, exactly as a NULL week_of_month does.
 */
export function matchesWeekParity(dateStr, parity) {
  if (!parity) return true;
  return weekAbOf(dateStr) === String(parity).toLowerCase();
}

/** The two values a fortnightly rule may carry. */
export const WEEK_PARITIES = ['a', 'b'];
