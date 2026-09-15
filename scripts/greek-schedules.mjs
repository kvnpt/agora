// Turning what a Greek parish publishes into recurrence rules.
//
// WHY THIS LOOKS NOTHING LIKE antiochian-schedules.mjs. That file parses one
// template across 24 parishes: a weekday heading, then lines of `time - title`.
// It can afford to be a line parser because every page has the same shape.
//
// The Greek Archdiocese publishes NO service times at all — its 135 church
// pages carry an address, a phone, a feast day and a priest, and nothing else.
// So every time in this run comes from a parish's own site, and those are a
// hundred independent sites with a hundred layouts. What they have in common is
// not a layout, it is a SENTENCE:
//
//     "Matins and Liturgy take place every Sunday morning from 7:30am-10:30am."
//     "Sunday services always commence at 8:30am, starting with Matins & Divine Liturgy."
//     "Vespers take place every Saturday at 3pm."
//     "...the Divine Liturgy in English on the last Saturday morning of every month."
//
// So this file parses English prose, narrowly: a phrase that names a weekday,
// a phrase that names a time, and a title. That is a weaker parser than the
// Antiochian one and it is used differently — `greek-service-times.mjs` holds
// the sentences a person selected, and the tests parse those exact sentences
// and assert the rule that comes out. The parser is what stops the rule fields
// being typed by hand; the curation is what stops the parser reading a sentence
// nobody meant as a timetable.
//
// WHAT IT REFUSES. The refusals matter more than the parses here, because prose
// hedges in ways a table cannot:
//
//   - "alternates between the Parishes of St Basil's and The Presentation"
//     — a fortnight is not expressible in week_of_month, and a rule without one
//       means EVERY week, which would put a service at the wrong church half
//       the time.
//   - "services most feast days and weekends" — *most* is not a rule.
//   - "the church is open Monday to Friday 10am-12" — an opening time.
//   - "Confession available every Monday to Friday between 4-6pm" — an
//     availability, not something with a start you arrive for.
//
// Each returns a reason, and the caller prints it. Absence has to be a reported
// finding in this run, not a silent skip: the headline number is how many Greek
// parishes publish nothing, and that number is only honest if the ones that
// published something unreadable are counted separately.

// Sunday = 0, matching schedules.day_of_week.
const DAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

const DAY_WORDS = [
  [/\bsun(?:day)?s?\b|\bκυριακ[ήη]ς?\b/i, 0],
  [/\bmon(?:day)?s?\b|\bδευτέρας?\b/i, 1],
  [/\btues?(?:day)?s?\b|\bτρίτης?\b/i, 2],
  [/\bwed(?:nes)?(?:day)?s?\b|\bτετάρτης?\b/i, 3],
  [/\bthur?s?(?:day)?s?\b|\bπέμπτης?\b/i, 4],
  [/\bfri(?:day)?s?\b|\bπαρασκευ[ήη]ς?\b/i, 5],
  [/\bsat(?:ur)?(?:day)?s?\b|\bσάββατο?υ?\b/i, 6],
];

/** Every weekday a phrase names, in week order. `[]` if it names none. */
export function daysIn(text) {
  const s = String(text || '');
  const out = [];
  for (const [re, idx] of DAY_WORDS) if (re.test(s) && !out.includes(idx)) out.push(idx);
  return out.sort((a, b) => a - b);
}

/**
 * 'HH:MM' from the way these sites write a time, or null.
 *
 * Every variant seen across the 42 readable Greek sites: `7:30am`, `7.30am`,
 * `8 am`, `6pm`, `09:00`, `8:30 AM`, and the Greek `7:30 π.μ.`. A bare
 * `9` with no meridiem is NOT a time here and returns null — "from 9" appears
 * on these pages meaning nine in the morning and also meaning the ninth of the
 * month, and a rule built on the wrong reading is a card at the wrong hour.
 *
 * A bare 24-hour `19:00` is read as given: it is unambiguous and the only
 * reading that does not invent a meridiem.
 */
export function parseTime(text) {
  const s = String(text || '');
  const m = s.match(/(\d{1,2})\s*[:.]\s*(\d{2})\s*(a\.?m\.?|p\.?m\.?|π\.?μ\.?|μ\.?μ\.?)?/i)
    || s.match(/(\d{1,2})()\s*(a\.?m\.?|p\.?m\.?|π\.?μ\.?|μ\.?μ\.?)/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const min = m[2] === '' ? 0 : Number(m[2]);
  const mer = (m[3] || '').toLowerCase().replace(/\./g, '');
  if (!Number.isFinite(hour) || !Number.isFinite(min) || min > 59) return null;
  const pm = mer === 'pm' || mer === 'μμ';
  const am = mer === 'am' || mer === 'πμ';
  if (pm && hour !== 12) hour += 12;
  if (am && hour === 12) hour = 0;
  if (!mer && hour > 23) return null;
  if (hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * `{ start, end }` from a span, or `{ start, end: null }` from a single time.
 *
 * "7:30am-10:30am", "8-9 am", "9 am - 10.30 am", "7:30 – 11:15 am". The trap is
 * the unqualified first half: in "8-9 am" the 8 carries no meridiem of its own
 * and is 08:00, not 20:00, so an end that is EARLIER than the start means the
 * start borrowed the wrong half of the day and is corrected here.
 */
export function parseRange(text) {
  const s = String(text || '');
  const span = s.match(/(\d{1,2}(?:\s*[:.]\s*\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)\s*(?:-|–|—|to|until|till|έως)\s*(\d{1,2}(?:\s*[:.]\s*\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?)/i);
  if (!span) return { start: parseTime(s), end: null };

  const endMer = (span[2].match(/a\.?m\.?|p\.?m\.?/i) || [''])[0];
  const end = parseTime(span[2]);
  // Lend the end's meridiem to a start that has none, then sanity-check.
  const startHasMer = /a\.?m\.?|p\.?m\.?/i.test(span[1]);
  let start = parseTime(startHasMer || !endMer ? span[1] : `${span[1]} ${endMer}`);
  if (start && end && start > end && !startHasMer) {
    const flipped = parseTime(span[1].replace(/\s*(a\.?m\.?|p\.?m\.?)/i, ''));
    if (flipped && flipped <= end) start = flipped;
  }
  return { start, end: end && start && end === start ? null : end };
}

const ORDINAL = {
  1: 'first', first: 'first', 2: 'second', second: 'second', 3: 'third', third: 'third',
  4: 'fourth', fourth: 'fourth',
};

/**
 * The weeks of the month a phrase names, as recurrence.mjs spells them, or
 * null for "every week", or the string `unsupported`.
 *
 * `unsupported` is checked FIRST and that ordering is load-bearing — the same
 * bug the Antiochian run shipped a test for. `week_of_month` NULL does not mean
 * "unknown", it means EVERY matching weekday, so a pattern the column cannot
 * express has to refuse rather than fall through to null. "Alternates between
 * two parishes" and "every second week" are both that: a fortnight has no
 * spelling here, and widening it to weekly puts a service at a church that is
 * not holding it.
 */
export function parseWeekOfMonth(text) {
  const s = String(text || '');
  if (/\balternat(?:e|es|ing)\b|\bevery\s+(?:second|other|two)\s+week|\bfortnight/i.test(s)) return 'unsupported';
  if (/\b(?:\d+(?:st|nd|rd|th)|second|third|fourth)\s+last\b/i.test(s)) return 'unsupported';
  if (!/\b(week|month|μήνα)\b/i.test(s)) return null;

  const weeks = [];
  for (const m of s.matchAll(/\b(\d)(?:st|nd|rd|th)\b|\b(first|second|third|fourth)\b/gi)) {
    const key = m[1] ? Number(m[1]) : String(m[2]).toLowerCase();
    const w = ORDINAL[key];
    if (w && !weeks.includes(w)) weeks.push(w);
  }
  if (/\blast\b/i.test(s) && !weeks.includes('last')) weeks.push('last');
  return weeks.length ? weeks.join(',') : null;
}

// schedules.event_type is a fixed vocabulary. Order matters: "Matins and Divine
// Liturgy" is one block that IS the liturgy, so the liturgy test runs first.
const TYPE_BY_TITLE = [
  [/\bliturg(?:y|ies)\b|\bλειτουργ/i, 'liturgy'],
  [/\bmatins\b|\borthros\b|\bvespers\b|\besperinos\b|\bcompline\b|\bparaklesis\b|\bsupplicatory\b|\bakathist\b|\bvigil\b|\bmidnight\s+service\b|\bhours\b|\bprayer\b|\bόρθρος\b|\bεσπεριν/i, 'prayer'],
  [/\bcatechism\b|\bbible\s+stud|\bstudy\b|\bclass(?:es)?\b|\bseminar\b|\btalk\b|\bschool\b/i, 'talk'],
  [/\byouth\b|\bneolaia\b|\bgoyouth\b/i, 'youth'],
];

export const eventTypeFor = (title) => TYPE_BY_TITLE.find(([re]) => re.test(String(title || '')))?.[1] || 'other';

// Languages these parishes name. A whitelist for the same reason the Antiochian
// one is: the words beside a service title are not always a language.
const LANGUAGE = {
  english: 'English', greek: 'Greek', slavonic: 'Slavonic', arabic: 'Arabic',
  romanian: 'Romanian', serbian: 'Serbian', russian: 'Russian', ελληνικά: 'Greek', αγγλικά: 'English',
};

/** The languages a phrase names, or null. */
export function parseLanguages(text) {
  const s = String(text || '').toLowerCase();
  const out = [];
  for (const [word, name] of Object.entries(LANGUAGE)) {
    if (new RegExp(`\\b${word}\\b`, 'i').test(s) && !out.includes(name)) out.push(name);
  }
  return out.length ? out : null;
}

// Phrases that mean the sentence is not describing a service somebody arrives
// for. Each was written for a line that actually appears on one of these sites.
const NOT_A_SERVICE = [
  [/\b(?:office|administration|church|school|opening)\s+hours\b/i, 'opening hours, not a service'],
  [/\bopen\b[^.]*\b(?:from|between)\b/i, 'an opening time, not a service'],
  // NOT `[^.]*` between the words: the sentence this was written for contains
  // "4.00 - 6.00pm", and a dot-excluding gap stops before it reaches the
  // "for Holy Confession" that makes it an availability rather than a service.
  [/\bavailable\b[\s\S]{0,120}?\bfor\b[\s\S]{0,40}?\b(?:confession|spiritual)\b/i, 'an availability, not a service with a start'],
  [/\bby\s+appointment\b/i, 'by appointment, so there is no recurring time'],
  [/\bmost\b\s+(?:feast|sunday|weekend|week)/i, '"most" is not a recurrence this column can express'],
  [/\bas\s+(?:per\s+)?arrange/i, 'arranged rather than scheduled'],
];

/**
 * One published sentence to a rule, or a reason it is not one.
 *
 * Returns `{ ok: true, rules }` — plural, because "Matins at 7am and the Divine
 * Liturgy at 9am" on "every Tuesday and Sunday" is six rules — or
 * `{ ok: false, why }`.
 *
 * `title` is supplied by the caller rather than scraped out of the sentence.
 * That is the deliberate split: a machine can read "7:30am" out of prose far
 * more safely than it can read "which service is this", and a title guessed
 * wrong is a card that says the wrong thing rather than one that is merely
 * missing.
 */
export function ruleFromSentence(sentence, { title, days, languages, weekOfMonth } = {}) {
  const text = String(sentence || '').trim();
  if (!text) return { ok: false, why: 'empty' };

  for (const [re, why] of NOT_A_SERVICE) if (re.test(text)) return { ok: false, why };

  const dayList = days && days.length ? days : daysIn(text);
  if (!dayList.length) return { ok: false, why: 'no weekday named' };

  const wom = weekOfMonth !== undefined ? weekOfMonth : parseWeekOfMonth(text);
  if (wom === 'unsupported') {
    return { ok: false, why: 'recurs in a pattern week_of_month cannot express' };
  }

  const { start, end } = parseRange(text);
  if (!start) return { ok: false, why: 'no time published' };

  const name = String(title || '').trim();
  if (!name) return { ok: false, why: 'no service name' };

  const rules = [];
  for (const day of dayList) {
    rules.push({
      day_of_week: day,
      start_time: start,
      end_time: end || null,
      title: name,
      event_type: eventTypeFor(name),
      languages: languages === undefined ? parseLanguages(text) : languages,
      week_of_month: wom || null,
    });
  }
  return { ok: true, rules };
}

// ── writing ────────────────────────────────────────────────────────────────

const sql = (v) => (v === null || v === undefined || v === ''
  ? 'NULL'
  : `'${String(v).replace(/'/g, "''")}'`);

/**
 * What to CALL the source in the UI.
 *
 * Not "Greek Archdiocese": the Archdiocese publishes no service times, and a
 * line reading "Updated 2 days ago · Greek Archdiocese" under a timetable would
 * credit a source that never said it. Every rule in this run comes from the
 * parish's own site, which is what the line should say — the same label the
 * Romanian service-times run used, and for the same reason.
 */
export const SOURCE_NAME = 'Parish website';

/**
 * Plan the write: which rules update a row that already exists, and which are
 * new. Matched on parish + weekday + start time, NEVER on title.
 *
 * There are no Greek schedules in production at all, so today every rule is an
 * insert and `updates` is empty. It is written this way anyway because the
 * second run is the dangerous one: by then somebody will have renamed a rule in
 * /admin, and matching on title would insert a second copy beside it rather
 * than updating it — two cards for one service. Updating in place also keeps
 * the row id, which `events.schedule_id` and `schedule_overrides` both point at.
 */
export function planWrite(rules, existing) {
  const bySlot = new Map();
  for (const e of existing) {
    const k = `${e.parish_id}|${e.day_of_week}|${e.start_time}`;
    if (!bySlot.has(k)) bySlot.set(k, []);
    bySlot.get(k).push(e);
  }
  const updates = [];
  const inserts = [];
  for (const r of rules) {
    const pool = bySlot.get(`${r.parish_id}|${r.day_of_week}|${r.start_time}`);
    if (pool && pool.length) updates.push({ ...r, id: pool.shift().id });
    else inserts.push(r);
  }
  return { updates, inserts, untouched: [...bySlot.values()].flat() };
}

/**
 * Set `concurrent` on rules that share a parish, weekday and hour.
 *
 * The read-path dedup partitions on parish, time and title, so two services at
 * one hour can hide each other. It does not arise in this run — no Greek parish
 * publishes two services at the same minute — and it is applied anyway, because
 * the cost of being wrong is a service silently missing from the feed and the
 * cost of being right is an integer.
 */
export function markConcurrent(rules) {
  const slots = new Map();
  for (const r of rules) {
    const k = `${r.parish_id}|${r.day_of_week}|${r.start_time}`;
    slots.set(k, (slots.get(k) || 0) + 1);
  }
  for (const r of rules) {
    r.concurrent = slots.get(`${r.parish_id}|${r.day_of_week}|${r.start_time}`) > 1 ? 1 : 0;
  }
  return rules;
}

const COLS = ['parish_id', 'day_of_week', 'start_time', 'end_time', 'title', 'event_type',
  'languages', 'week_of_month', 'concurrent', 'source_name', 'source_ref', 'source_checked_at'];

const valueOf = (r, c) => {
  if (c === 'languages') {
    return sql(r.languages ? JSON.stringify(r.languages).replace(/","/g, '", "') : null);
  }
  if (c === 'day_of_week' || c === 'concurrent') return String(r[c] ?? 0);
  return sql(r[c]);
};

/** The SQL for a planned write: updates by id, inserts guarded on the natural key. */
export function buildScheduleSql({ updates, inserts }) {
  const out = [];
  for (const r of updates) {
    const sets = COLS.filter((c) => c !== 'parish_id').map((c) => `${c}=${valueOf(r, c)}`);
    out.push(`UPDATE schedules SET ${sets.join(', ')}, active=1 WHERE id=${Number(r.id)};`);
  }
  for (const r of inserts) {
    // AUTOINCREMENT id and no natural key, so re-running is made safe with
    // WHERE NOT EXISTS rather than ON CONFLICT — the same guard the seed uses,
    // and for the same reason: week_of_month makes "last Saturday 09:00 Liturgy"
    // and "09:00 Liturgy" distinct rules that agree on everything else.
    out.push(
      `INSERT INTO schedules (${COLS.join(', ')})\n`
      + `SELECT ${COLS.map((c) => valueOf(r, c)).join(', ')}\n`
      + `WHERE NOT EXISTS (SELECT 1 FROM schedules WHERE parish_id=${sql(r.parish_id)}`
      + ` AND day_of_week=${Number(r.day_of_week)} AND start_time=${sql(r.start_time)}`
      + ` AND title=${sql(r.title)});`,
    );
  }
  return out.join('\n');
}

/**
 * The SQL correcting `parishes.website`, and re-stamping when we last read the
 * directory that row came from.
 *
 * `info_checked_at` is re-stamped on EVERY row the directory was re-read for,
 * not only the ones that changed: the column records when we last looked, and
 * looking and finding nothing new is still looking. `info_source_name` and
 * `info_source_ref` are left alone — the address on these rows still came from
 * the Archdiocese directory, and a website found by search does not change
 * where the rest of the row came from.
 *
 * `info_verified_at` is never written here. A scrape is not a person standing
 * in front of the building, and that column is the guard that stops a re-import
 * moving a pin somebody has checked.
 */
export function buildWebsiteSql(changes, checkedAt) {
  const out = [];
  for (const c of changes) {
    out.push(`UPDATE parishes SET website=${sql(c.website)}, info_checked_at=${sql(checkedAt)} WHERE id=${sql(c.id)};`);
  }
  return out.join('\n');
}
