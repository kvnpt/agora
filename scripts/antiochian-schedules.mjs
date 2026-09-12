// The Antiochian Archdiocese's published service times, turned into recurrence
// rules.
//
// WHY THIS IS A SCRIPT AND NOT AN ADAPTER. `docs/adapters.md` is the usual home
// for service times, and an adapter is the right shape when a source can be
// re-fetched on a schedule. This one cannot: antiochian.org.au answers 403 to
// every automated client on every path, so the Worker could never reach it and
// an adapter would fail every four hours forever. The pages are fetched by a
// person into `cache/antiochian/` and imported once, which is also why the
// rules carry `source_updated_at` — nothing here will notice when they change,
// so the row has to say how old it is.
//
// WHAT THE PAGES LOOK LIKE. Each parish's PRAYER SERVICES tab is a set of day
// headings with lines under them:
//
//     Sundays
//       Morning
//       9:00AM- Matins (Arabic)
//       10:00AM- Liturgy (Mostly Arabic)
//       Evening
//       6:00 PM- Liturgy (English)
//
// So: a time, a separator that is a hyphen or an en-dash, a title, an optional
// parenthesised language list, and sometimes a trailing qualifier naming which
// weeks of the month it runs. "Morning" and "Evening" are layout, not services.
//
// THE RULE THIS FILE FOLLOWS. A line without a time is never guessed at. Two of
// these parishes publish a service with no time — Redfern's "Every 2nd last
// Friday. Compline Service" — and a rule invented for it would put a card on
// the map at an hour nobody said. Those are reported and dropped.

// Sunday = 0, matching schedules.day_of_week.
const DAY_INDEX = {
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
};

/** A section heading that names a weekday, or null. Plural or singular. */
export function dayOfHeading(heading) {
  const m = String(heading || '').trim().toLowerCase().match(/^(sun|mon|tues|wednes|thurs|fri|satur)days?$/);
  if (!m) return null;
  const full = { sun: 'sunday', mon: 'monday', tues: 'tuesday', wednes: 'wednesday', thurs: 'thursday', fri: 'friday', satur: 'saturday' }[m[1]];
  return DAY_INDEX[full];
}

// Layout labels and prose that sit among the service lines. None is a service.
const NOT_A_SERVICE = /^(morning|evening|evenings|afternoon|weekly|daily|n\/a|note\s*:?|tba)$/i;

/**
 * 'HH:MM' from the way these pages write a time, or null.
 *
 * Every variant in the directory: `9:00AM`, `09:30AM`, `6:00 PM`, `11:00 AM`,
 * `07:00PM`, `3:30PM`, and one bare 24-hour `09:30`. A bare time is read as
 * 24-hour, which is right for the one that occurs and is the only reading that
 * does not invent a meridiem.
 */
export function parseTime(text) {
  const m = String(text || '').match(/^\s*(\d{1,2})\s*[:.]\s*(\d{2})\s*(am|pm)?/i);
  if (!m) return null;
  let hour = Number(m[1]);
  const min = Number(m[2]);
  const mer = (m[3] || '').toLowerCase();
  if (min > 59) return null;
  if (mer === 'pm' && hour !== 12) hour += 12;
  if (mer === 'am' && hour === 12) hour = 0;
  if (hour > 23) return null;
  return `${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// Languages these parishes actually name. A whitelist, not a split on commas,
// because the parenthesis after a title is not always a language list —
// "Sisterhood of Saints Mary and Martha (Paraklesis Service)" names the service.
const LANGUAGE = {
  arabic: 'Arabic', english: 'English', greek: 'Greek', slavonic: 'Slavonic',
  romanian: 'Romanian', serbian: 'Serbian', russian: 'Russian', french: 'French',
};

/**
 * The languages a parenthesis names, or null if it does not name languages.
 *
 * "Mostly Arabic" yields ["Arabic"]: the qualifier is dropped rather than
 * guessed at, which claims less than the page does and never more.
 * "Bi-Lingual" names no language at all, so it resolves to the parish's OWN
 * declared languages — which the same page publishes under ABOUT — rather than
 * to a guess that Antiochian bilingual must mean Arabic and English.
 */
export function parseLanguages(inside, parishLanguages = null) {
  const raw = String(inside || '').trim();
  if (!raw) return null;
  if (/^bi[-\s]?lingual$/i.test(raw)) return parishLanguages && parishLanguages.length ? [...parishLanguages] : null;
  const parts = raw.split(/\s*(?:\/|&|,| and )\s*/i).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const part of parts) {
    const word = part.replace(/^(mostly|mainly|primarily|some)\s+/i, '').trim().toLowerCase();
    const hit = LANGUAGE[word];
    if (!hit) return null;          // not a language list at all
    if (!out.includes(hit)) out.push(hit);
  }
  return out.length ? out : null;
}

const ORDINAL = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth' };

// "1st Sunday of every month", "Every 1st and 3rd Sunday of the Month" — the
// phrase that says WHICH weeks, so it can be lifted out of a tail that also
// carries something else worth keeping.
const WEEK_PHRASE = /\b(?:every\s+)?\d(?:st|nd|rd|th)(?:\s*(?:,|and)\s*\d(?:st|nd|rd|th))*(?:\s+\w+)?\s+of\s+(?:the\s+|every\s+)?month\b\.?/i;

/**
 * The weeks of the month a qualifier names, as recurrence.mjs spells them.
 *
 * "1st and 3rd Sunday of the Month" -> "first,third". Anything the vocabulary
 * cannot express — Redfern's "every 2nd last Friday" — returns the string
 * `unsupported`, so the caller drops the rule instead of silently widening it
 * to every week, which would put a service on the map three Fridays too often.
 */
export function parseWeekOfMonth(text) {
  const s = String(text || '');
  // Checked BEFORE the week/month guard, because "every 2nd last Friday" names
  // neither word. Returning null there would have left the rule with no
  // week_of_month at all, which does not mean "unknown" — it means EVERY
  // Friday, so the guard meant to refuse the pattern would have widened it.
  if (/\b(2nd|second|3rd|third|\d+(?:st|nd|rd|th))\s+last\b/i.test(s)) return 'unsupported';
  if (!/\b(week|month)\b/i.test(s)) return null;
  const weeks = [];
  for (const m of s.matchAll(/\b(\d)(?:st|nd|rd|th)\b/gi)) {
    const w = ORDINAL[Number(m[1])];
    if (w && !weeks.includes(w)) weeks.push(w);
  }
  if (/\blast\b/i.test(s) && !weeks.includes('last')) weeks.push('last');
  return weeks.length ? weeks.join(',') : null;
}

// schedules.event_type is a fixed vocabulary. Everything these parishes publish
// is either the Liturgy or one of the daily offices around it.
const TYPE_BY_TITLE = [
  [/\bliturgy\b|\bmass\b/i, 'liturgy'],
  [/\bmatins\b|\borthros\b|\bvespers\b|\bcompline\b|\bparaklesis\b|\bprayer|\bakathist\b|\bvigil\b/i, 'prayer'],
  [/\bschool\b|\bcatechism\b|\bstudy\b|\bclass\b/i, 'talk'],
  [/\byouth\b/i, 'youth'],
];

export const eventTypeFor = (title) => TYPE_BY_TITLE.find(([re]) => re.test(title))?.[1] || 'other';

/**
 * One service line to a rule, or a reason it is not one.
 *
 * Returns `{ ok: true, rule }` or `{ ok: false, line, why }`. The caller is
 * expected to print the failures: on this directory they are the two services
 * published without a time, and nobody should have to diff the output to find
 * out that they were dropped.
 */
export function parseServiceLine(line, { day, parishLanguages } = {}) {
  const text = String(line || '').trim();
  if (!text || NOT_A_SERVICE.test(text)) return { ok: false, line: text, why: 'layout label, not a service' };

  const start = parseTime(text);
  if (!start) return { ok: false, line: text, why: 'no time published' };

  // Drop the time, then the separator, which is a hyphen or an en/em dash.
  let rest = text.replace(/^\s*\d{1,2}\s*[:.]\s*\d{2}\s*(am|pm)?\s*/i, '')
    .replace(/^\s*[-–—]\s*/, '').trim();

  // A trailing qualifier after a second dash: "– 1st Sunday of every month".
  let tail = '';
  const split = rest.split(/\s+[-–—]\s+/);
  if (split.length > 1) { rest = split[0].trim(); tail = split.slice(1).join(' ').trim(); }

  // A location the service is held at, which schedules cannot store in a column
  // — St Mary Magdalene serves Pomona and Gympie from Elimbah. Kept in the
  // title, because dropping it would put those services at the wrong church.
  let at = '';
  const atMatch = rest.match(/\s*@\s*(.+)$/);
  if (atMatch) { at = atMatch[1].trim(); rest = rest.slice(0, atMatch.index).trim(); }

  // The parenthesis: languages, or part of the name.
  let languages = null;
  const paren = rest.match(/\(([^)]*)\)\s*$/);
  if (paren) {
    languages = parseLanguages(paren[1], parishLanguages);
    if (languages) rest = rest.slice(0, paren.index).trim();
  }

  let title = rest.replace(/[\s.,;:–-]+$/, '').trim();
  if (!title) return { ok: false, line: text, why: 'no service name' };
  if (at) title = `${title} at ${at.replace(/\s+/g, ' ')}`;

  const wom = parseWeekOfMonth(`${tail} ${text}`);
  if (wom === 'unsupported') {
    return { ok: false, line: text, why: 'recurs in a pattern week_of_month cannot express' };
  }

  // Whatever the tail says BESIDES which weeks it runs is a real detail, and on
  // this directory it is load-bearing rather than decorative. Punchbowl holds
  // two liturgies at 09:30 on the first Sunday — one Arabic in the church, one
  // English "in the hall" — and the read-path dedup partitions on parish, time
  // and TITLE, so dropping those three words would leave both rules called
  // "Liturgy" at 09:30 and the week_of_month one would silently hide the other.
  const leftover = tail.replace(WEEK_PHRASE, ' ').replace(/[\s.,]+$/, '').replace(/^[\s.,]+/, '').trim();
  if (leftover) title = `${title} (${leftover})`;

  return {
    ok: true,
    rule: {
      day_of_week: day,
      start_time: start,
      title,
      event_type: eventTypeFor(title),
      languages: languages || null,
      week_of_month: wom || null,
    },
  };
}

/** Every rule a parish's day sections describe, plus what was dropped. */
export function rulesForParish(parish) {
  const rules = [];
  const dropped = [];
  for (const [heading, body] of Object.entries(parish.sections || {})) {
    const day = dayOfHeading(heading);
    if (day === null) continue;
    for (const line of String(body).split('\n')) {
      const res = parseServiceLine(line, { day, parishLanguages: parish.languages });
      if (res.ok) rules.push(res.rule);
      else if (res.why !== 'layout label, not a service') {
        dropped.push({ parish: parish.name, day: heading, ...res });
      }
    }
  }
  // Two parishes list the same service twice under one heading; one row each.
  const seen = new Set();
  const unique = rules.filter((r) => {
    const key = `${r.day_of_week}|${r.start_time}|${r.title}|${r.week_of_month || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Services at the same hour on the same day are GENUINELY SIMULTANEOUS here,
  // not duplicates: Punchbowl holds an Arabic liturgy in the church and an
  // English one in the hall at 09:30 on first Sundays, and Kirrawee does the
  // same at 10:00. `concurrent` is the column that stops the read-path dedup
  // collapsing them. Distinct titles happen to achieve that too, but relying on
  // that would make a future title edit quietly delete a service from the feed.
  const slots = new Map();
  for (const r of unique) {
    const k = `${r.day_of_week}|${r.start_time}`;
    slots.set(k, (slots.get(k) || 0) + 1);
  }
  for (const r of unique) r.concurrent = slots.get(`${r.day_of_week}|${r.start_time}`) > 1 ? 1 : 0;

  return { rules: unique, dropped };
}

// ── writing ────────────────────────────────────────────────────────────────

const sql = (v) => (v === null || v === undefined || v === ''
  ? 'NULL'
  : `'${String(v).replace(/'/g, "''")}'`);

// What to CALL the source in the UI. Short on purpose: it renders directly
// under a jurisdiction header that already says "Antiochian Orthodox", and a
// schedule line has room for a relative date and a name, not a full legal title.
export const SOURCE_NAME = 'Archdiocese';

/**
 * Plan the write: which rules update a row that already exists, and which are new.
 *
 * Matched on parish + weekday + start time, NOT on title. The nine rules seeded
 * by hand before any scraping are all called "Sunday Divine Liturgy" with no
 * languages, and matching on title would leave every one of them in place with
 * the directory's version inserted beside it — two cards for one service. One of
 * them is also simply wrong: the seed says Ryde's 09:00 Sunday service is the
 * Liturgy, and the parish says 09:00 is Matins and the Liturgy is at 10:00.
 *
 * Updating in place keeps the row's id, which matters because `events.schedule_id`
 * and `schedule_overrides` both point at it — neither does today, but a rule that
 * is deleted and reinserted breaks those silently the first time one does.
 *
 * An existing rule the directory does NOT mention is left alone. A page that
 * omits a service is weak evidence that it has stopped; Ryde's Saturday Vespers
 * and Good Shepherd's Confession are both absent from the directory and both
 * plausibly still happen.
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
    const k = `${r.parish_id}|${r.day_of_week}|${r.start_time}`;
    const pool = bySlot.get(k);
    if (pool && pool.length) updates.push({ ...r, id: pool.shift().id, was: null });
    else inserts.push(r);
  }
  // Rows in a slot the directory also describes, but which it had no rule left
  // to pair with, plus every slot it never mentioned.
  const untouched = [...bySlot.values()].flat();
  return { updates, inserts, untouched };
}

const COLS = ['parish_id', 'day_of_week', 'start_time', 'title', 'event_type',
  'languages', 'week_of_month', 'concurrent', 'source_name', 'source_ref', 'source_updated_at'];

const valueOf = (r, c) => (c === 'languages'
  ? sql(r.languages ? JSON.stringify(r.languages).replace(/","/g, '", "') : null)
  : (c === 'day_of_week' || c === 'concurrent' ? String(r[c] ?? 0) : sql(r[c])));

/** The SQL for a planned write: updates by id, inserts guarded on the natural key. */
export function buildScheduleSql({ updates, inserts }) {
  const out = [];
  for (const r of updates) {
    const sets = COLS.filter((c) => c !== 'parish_id').map((c) => `${c}=${valueOf(r, c)}`);
    // active=1 because an update may be reviving a rule somebody turned off;
    // if that was deliberate this is the one thing here worth checking.
    out.push(`UPDATE schedules SET ${sets.join(', ')}, active=1 WHERE id=${Number(r.id)};`);
  }
  for (const r of inserts) {
    // schedules has an AUTOINCREMENT id and no natural key, so re-running is made
    // safe with WHERE NOT EXISTS rather than ON CONFLICT — the same guard the
    // seed uses, and for the same reason: week_of_month makes "1st Sunday 09:30
    // Liturgy" and "09:30 Liturgy" distinct rules that agree on everything else.
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
