// Parsing a parish's published schedule, from text somebody else extracted.
//
// PURE. No network, no PDF, no clock. Text in, occurrences out — which is what
// makes the fragile half of this testable at all. Getting text OUT of a PDF is
// the hard part and it does not happen here; see scripts/extract-parish-pdf.mjs
// and docs/adapters.md for why it cannot happen inside a Worker.
//
// WHAT THE REAL FILES LOOK LIKE
//
// Five real parish PDFs were pulled apart before any of this was written
// (docs/adapters.md records the survey). The shape is NOT stable across
// parishes, and the differences are not cosmetic:
//
//   listing, time-leading    a date header owns the rows under it, each row
//                            "5pm  Vespers  Religious Centre, 38 Exhibition…"
//   listing, time-trailing   same, but "Liturgy of John Chrysostom    11.30 am"
//   column grid              DATE | FEAST | SERVICE | TIME, with the date cell
//                            drawn once and centred over its block of services
//   a scan                   300dpi JPEG, no text layer at all
//
// This file handles the two listing forms, because they share one grammar: a
// date header line claims every service row beneath it until the next date
// header. The grid is REFUSED rather than guessed at — see refuseColumnGrid.
//
// THE ASYMMETRY, same as everywhere else in this codebase. A service parsed
// onto the wrong day is a card advertising a liturgy that is not happening,
// and — because coverage feeds reconcile.mjs — a tombstone on the real one. A
// service we decline to parse is a missing card the next scrape can add. So
// every judgement call below resolves toward emitting less.

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Long names are matched by prefix, so "sept" and "september" both land on 9.
const monthNumber = (word) => MONTHS[String(word || '').slice(0, 3).toLowerCase()] ?? null;

const WEEKDAY = /^(sun|mon|tue|wed|thu|fri|sat)[a-z]*\.?$/i;
const MONTH_WORD = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?,?$/i;

const pad = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/**
 * Is `date` a real calendar date? new Date(2026, 1, 30) silently becomes 2 March,
 * and a date header that rolls over like that is a misprint we should drop rather
 * than relocate a service to a day nobody published.
 */
function validDate(y, m, d) {
  if (!(y >= 1900 && y <= 2999) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

// ── times ────────────────────────────────────────────────────────────────────

// Every separator seen in the sample: "5pm", "12:30pm", "11.30 am", "7:30-9:30 am",
// "5:00 - 6:00 pm", "7.00 pm to 11.00 pm", "11.00 pm to 2.30am".
//
// Anchored on the meridiem. A bare "10" in "Tone 10" or "2148" in a postcode is a
// number, not a time, and requiring am/pm is what keeps the parser off them — at
// the cost of dropping 24-hour listings, which none of the sampled parishes use.
const TIME = String.raw`(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?`;
const RANGE = new RegExp(
  String.raw`\b${TIME}(?:\s*(?:-|–|—|to)\s*${TIME})?(?![\d:.])`, 'gi'
);

function toHHMM(hour, minute, meridiem) {
  let h = Number(hour);
  const m = Number(minute || 0);
  if (h > 12 || m > 59) return null;
  const mer = meridiem ? meridiem[0].toLowerCase() : null;
  if (mer === 'p' && h !== 12) h += 12;
  if (mer === 'a' && h === 12) h = 0;
  if (h > 23) return null;
  return `${pad(h)}:${pad(m)}`;
}

/**
 * The first time or time-range in a line, with where it sat.
 *
 * "7:30-9:30 am" writes the meridiem once, at the end, and means it for both
 * ends. "11.00 pm to 2.30am" writes it twice and means two different ones. So a
 * missing meridiem on the start borrows from the end, and never the other way:
 * borrowing backwards would turn "11 pm to 2.30 am" into an 11am service.
 */
export function parseTime(line) {
  RANGE.lastIndex = 0;
  let m;
  while ((m = RANGE.exec(line))) {
    const [, h1, min1, mer1, h2, min2, mer2] = m;
    // A bare number with no meridiem at either end is not a time.
    if (!mer1 && !mer2) continue;
    const start = toHHMM(h1, min1, mer1 || mer2);
    if (!start) continue;
    const end = h2 === undefined ? null : toHHMM(h2, min2, mer2 || mer1);
    return { start, end, index: m.index, length: m[0].length, text: m[0] };
  }
  return null;
}

// ── date headers ─────────────────────────────────────────────────────────────

/**
 * A date at the START of a line, and how much of the line it used.
 *
 * Four spellings, all from the sample:
 *
 *   Sunday 12 January     Sunday 11th January     Sunday July 12th
 *   12 SEP, SAT           01/07                   01/07/2026
 *
 * A bare "12" on its own line is also a date header — that is the shape
 * docs/adapters.md documents — but only when the NEXT line names a month, so
 * that case is resolved by the caller, which can see both lines.
 *
 * @param {string} line
 * @param {{year: number|null, month: number|null}} ctx  what earlier lines established
 */
export function parseDateHeader(line, ctx = {}) {
  const full = line.trimStart();
  if (!full) return null;

  // A weekday in front of the date is decoration, in every spelling: "Sunday 12
  // January" and "Wednesday 01/07" both occur in the sample. Strip it once, up
  // front, so each form does not have to remember to allow it.
  const lead = /^([A-Za-z]+)\.?,?\s+/.exec(full);
  const hadWeekday = Boolean(lead) && WEEKDAY.test(lead[1]);
  const text = hadWeekday ? full.slice(lead[0].length) : full;

  // 01/07 or 01/07/2026 — day first, which is the Australian convention and the
  // only one the sample uses. Never month-first: reading 01/07 as 7 January
  // would put a service six months from where the parish published it.
  let m = /^(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\/\s*(\d{2,4}))?\b/.exec(text);
  if (m) {
    const year = m[3] ? normaliseYear(m[3]) : ctx.year;
    if (!year) return null;
    const d = +m[1], mo = +m[2];
    if (!validDate(year, mo, d)) return null;
    return { date: iso(year, mo, d), rest: text.slice(m[0].length), month: mo, year };
  }

  const words = text.split(/\s+/);

  const dayAt = (w) => {
    const d = /^(\d{1,2})(st|nd|rd|th)?[.,]?$/i.exec(w || '');
    return d ? +d[1] : null;
  };

  let day = null, month = null, used = 0;
  const [a, b] = words;

  if (MONTH_WORD.test(a || '') && dayAt(b) !== null) {
    month = monthNumber(a); day = dayAt(b); used = 2;          // "July 12th"
  } else if (dayAt(a) !== null && MONTH_WORD.test(b || '')) {
    day = dayAt(a); month = monthNumber(b); used = 2;          // "12 January", "12 SEP,"
  } else if (dayAt(a) !== null && hadWeekday) {
    day = dayAt(a); month = ctx.month; used = 1;               // "Sunday 12" under a month heading
  } else {
    return null;
  }

  if (day === null || !month) return null;

  // A year may follow the month ("12 January 2026"); otherwise carry the one in
  // force, rolling forward when the months go backwards — a programme running
  // Nov, Dec, Jan is crossing a new year, not going back ten months.
  let year = ctx.year;
  const yearWord = /^(\d{4})[.,]?$/.exec(words[used] || '');
  if (yearWord) { year = +yearWord[1]; used += 1; }
  else if (year && ctx.month && month < ctx.month - 6) year += 1;
  if (!year) return null;
  if (!validDate(year, month, day)) return null;

  return {
    date: iso(year, month, day),
    rest: words.slice(used).join(' '),
    month, year,
  };
}

const normaliseYear = (s) => (s.length === 4 ? +s : 2000 + +s);

/** A line that is nothing but a month name, e.g. "SEPTEMBER" — sets the context. */
function monthHeading(line) {
  const t = line.trim();
  if (!/^[A-Za-z]{3,9}$/.test(t)) return null;
  return monthNumber(t);
}

// ── lines we deliberately drop ───────────────────────────────────────────────

// A parish writing "NO SERVICE AT BUDERIM" is telling us something real, and the
// right way to record it is to emit nothing: the occurrence then goes missing
// from the window, reconcile.mjs notices, and tombstone.mjs decides — with all
// its guards — whether that absence may become a visible CANCELLED card. An
// adapter has no way to write a tombstone directly and should not have one.
const NON_SERVICE = /\b(no service|not? liturgy|cancelled|canceled|to be advised|tba|venue to be|subject to)\b/i;

// Rows whose "time" is a date fragment rather than a clock — "(Great & the Holy
// Lenten Fast 3/3)", "(Fast-Free Period 20/4 – 26/4)". These sit in the service
// column of a real parish programme and are notes, not services.
const PARENTHETICAL_NOTE = /^\s*\(.*\)\s*$/;

// ── the column grid we refuse ────────────────────────────────────────────────

/**
 * Does this text come from a bordered table rather than a listing?
 *
 * This matters enough to refuse the whole file over. In a grid the DATE cell is
 * drawn ONCE and centred over its block of services, so once the layout is
 * flattened to lines the date can land in the middle of its own block:
 *
 *     01/07      Cosmas & Damian    Vespers & Paraklesis…      5:00-6:00 pm
 *                                   Matins & Divine Liturgy    7:30-9:30 am   <- 2 July
 *                Deposition of the
 *    Thursday
 *                Robe of the Most   Vespers & Paraklesis…      5:00-6:00 pm
 *     02/07
 *
 * "Matins" there belongs to 2 July and sits above the 02/07 cell. Nothing left
 * in the text says so — the boundary is carried by ruled lines in the PDF's
 * vector layer, which text extraction drops. Assigning it to the nearest date
 * gets it wrong, and getting it wrong means a liturgy advertised on the wrong
 * morning plus a tombstone on the right one.
 *
 * So: name the shape, refuse it, and say why. Adding grid support means teaching
 * the EXTRACTOR to emit rows (it has the geometry; the Worker never will), not
 * teaching this parser to guess.
 */
function refuseColumnGrid(lines) {
  // A header row that names its own columns. Two or more of these labels
  // separated by runs of spaces is a table declaring itself.
  for (const line of lines.slice(0, 40)) {
    const cells = line.trim().split(/\s{2,}/).filter(Boolean);
    if (cells.length < 3) continue;
    const labels = cells.map(c => c.toLowerCase());
    if (labels.includes('time') && (labels.includes('service') || labels.includes('services'))
        && labels.some(l => l === 'date' || l === 'day')) {
      return { reason: 'column-grid', detail: `table header row: "${line.trim()}"` };
    }
  }

  // Failing a header, the interleaving itself gives it away: in a listing a date
  // header owns the rows BELOW it, so it rarely shares a line with a time. In a
  // grid the centred date cell sits on the same visual line as a service.
  let dated = 0, datedWithTime = 0;
  for (const line of lines) {
    const head = parseDateHeader(line, { year: 2000, month: 1 });
    if (!head) continue;
    dated++;
    if (parseTime(head.rest)) datedWithTime++;
  }
  if (dated >= 6 && datedWithTime / dated > 0.7) {
    return {
      reason: 'column-grid',
      detail: `${datedWithTime} of ${dated} date lines also carry a service time`,
    };
  }
  return null;
}

// ── the parser ───────────────────────────────────────────────────────────────

/**
 * Text from a parish's published schedule → the occurrences it lists.
 *
 * @param {string} text  whatever the extractor produced, newline separated
 * @param {object} [options]
 * @param {number} [options.year]        the year the file is for, when it does not say
 * @param {'lead'|'trail'|'auto'} [options.timePosition]
 * @param {boolean} [options.locationColumn]  trailing column is a venue, not part of the title
 * @param {string} [options.defaultLocation]  venue for rows that do not name one
 *
 * @returns {{
 *   occurrences: Array<{date: string, start: string, end: string|null, title: string, location: string|null, line: string}>,
 *   coverage: {from: string, to: string}|null,
 *   declared: {from: string, to: string}|null,
 *   skipped: Array<{line: string, why: string}>,
 *   refused: {reason: string, detail: string}|null,
 * }}
 */
export function parseSchedulePdfText(text, options = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const empty = { occurrences: [], coverage: null, declared: null, skipped: [], refused: null };

  const refused = refuseColumnGrid(lines);
  if (refused) return { ...empty, refused };

  const declaredYear = options.year || detectYear(lines);
  const ctx = { year: declaredYear || null, month: null };

  const occurrences = [];
  const skipped = [];
  let current = null;             // the date header in force

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;

    const heading = monthHeading(line);
    if (heading) { ctx.month = heading; continue; }

    // "12" alone, with the month on the next line — docs/adapters.md's shape:
    //     12
    //     SEP, SAT
    //     5pm   Vespers   Religious Centre…
    const bare = /^\s*(\d{1,2})\s*$/.exec(line);
    if (bare) {
      const next = lines[i + 1] || '';
      const combined = parseDateHeader(`${bare[1]} ${next.trim()}`, ctx);
      if (combined) {
        current = combined.date;
        ctx.month = combined.month; ctx.year = combined.year;
        i++;                      // the month/weekday line is consumed
        continue;
      }
      if (ctx.month && ctx.year) {
        const day = +bare[1];
        if (validDate(ctx.year, ctx.month, day)) { current = iso(ctx.year, ctx.month, day); continue; }
      }
      continue;
    }

    const head = parseDateHeader(line, ctx);
    let body = line;
    if (head) {
      current = head.date;
      ctx.month = head.month; ctx.year = head.year;
      body = head.rest;           // "Sunday 12 January  SUNDAY AFTER THEOPHANY"
      if (!body.trim()) continue;
    }

    const time = parseTime(body);
    if (!time) continue;          // prose, feast names, notes — not a service row

    if (!current) { skipped.push({ line: line.trim(), why: 'no date header yet' }); continue; }
    if (NON_SERVICE.test(body)) { skipped.push({ line: line.trim(), why: 'not a service' }); continue; }
    if (PARENTHETICAL_NOTE.test(body)) { skipped.push({ line: line.trim(), why: 'note, not a service' }); continue; }

    const { title, location } = splitRow(body, time, options);
    if (!title) { skipped.push({ line: line.trim(), why: 'no title' }); continue; }

    occurrences.push({
      date: current,
      start: time.start,
      end: time.end,
      title,
      location: location || options.defaultLocation || null,
      line: line.trim(),
    });
  }

  return {
    occurrences,
    ...coverageOf(occurrences, declaredYear, lines),
    skipped,
    refused: null,
  };
}

/**
 * Title and venue, from a row with the time cut out of it.
 *
 * Both column orders are real: Good Shepherd puts the time first
 * ("5pm  Vespers  Religious Centre…"), the Sunshine Coast puts it last
 * ("Liturgy of John Chrysostom (Tone 6)      11.30 am"). Which one a file uses
 * is visible in the row itself — the time is either at the start or it is not —
 * so there is nothing to configure and nothing to get wrong on a file that
 * mixes them.
 */
function splitRow(body, time, options) {
  const before = body.slice(0, time.index);
  const after = body.slice(time.index + time.length);
  const leading = !before.trim();

  // Cut the time out, keeping the column gaps on either side of it intact: those
  // gaps are what separate title from venue.
  const remainder = leading ? after : `${before}${after}`;
  const cells = remainder.split(/\s{2,}/).map(s => s.trim()).filter(Boolean);
  if (!cells.length) return { title: null, location: null };

  const title = tidy(cells[0]);
  // A venue only when the row actually has a further column AND the source says
  // its rows carry one. Without that flag a wrapped title's second half would be
  // filed as an address, which is how a service ends up captioned "wish to enter
  // the Orthodox Faith".
  const location = options.locationColumn && cells.length > 1
    ? tidy(cells.slice(1).join(', '))
    : null;
  return { title, location };
}

// Trailing separators left behind where a time was cut out ("Holy Thursday –").
const tidy = (s) => s.replace(/\s+/g, ' ').replace(/^[–—\-:,.\s]+|[–—\-:,\s]+$/g, '').trim();

/** The first plausible four-digit year in the file's opening lines. */
function detectYear(lines) {
  for (const line of lines.slice(0, 60)) {
    const m = /\b(20\d{2})\b/.exec(line);
    if (m) return +m[1];
  }
  return null;
}

/**
 * What the file can be held to have covered.
 *
 * This is the input to reconcile.mjs, so it decides which dates a missing
 * service is allowed to be read as a cancellation on — which makes it the most
 * dangerous value in this module.
 *
 * It is clamped to the dates actually parsed, never widened to the period the
 * file declares. A monthly programme really does cover its whole month, so
 * clamping gives up real signal at the edges: a Tuesday at the start of the
 * month with nothing on it stops counting as absent. That is the cheap
 * direction. The expensive one is claiming a month and having extraction
 * quietly deliver half of it — which is not hypothetical, one of the surveyed
 * PDFs is a flat scan that yields zero characters — and cancelling every
 * service in the half we never saw.
 */
function coverageOf(occurrences, year, lines) {
  const declared = declaredPeriod(year, lines);
  if (!occurrences.length) return { coverage: null, declared };
  const dates = occurrences.map(o => o.date).sort();
  let from = dates[0], to = dates[dates.length - 1];
  if (declared) {
    if (declared.from > from) from = declared.from;
    if (declared.to < to) to = declared.to;
  }
  return { coverage: from <= to ? { from, to } : null, declared };
}

/** "JULY 2026" in the letterhead → that month. A bare year → that year. */
function declaredPeriod(year, lines) {
  if (!year) return null;
  for (const line of lines.slice(0, 40)) {
    const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(20\d{2})\b/i.exec(line);
    if (!m || +m[2] !== year) continue;
    const mo = monthNumber(m[1]);
    const last = new Date(Date.UTC(year, mo, 0)).getUTCDate();
    return { from: iso(year, mo, 1), to: iso(year, mo, last) };
  }
  return { from: iso(year, 1, 1), to: iso(year, 12, 31) };
}
