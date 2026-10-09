// What to check on an event before it is published.
//
// One checker, run in two places: live in the add-event editor as the fields
// change, so a card says what is wrong while the person is looking at it, and
// in the Worker as the gate on Publish, so a card that skipped the browser
// cannot slip past. Two copies would be two opinions about the same event.
//
// It exists mostly because of posters. A model reads the date off a photograph,
// and a misread 7:30 sends somebody to a locked church — the asymmetry
// tombstone.mjs is built around. A poster usually prints the weekday as well as
// the date, which is a free cross-check: "Saturday 15 November" when the 15th
// is a Sunday means one of the two was misread, and the editor should say so
// in so many words rather than leave it to be noticed.
//
// Three levels:
//   block  Publish cannot go ahead (no title, no date, no start time, a value
//          that is not a date or a time)
//   warn   probably wrong, worth a look (the weekday disagrees, the date has
//          passed)
//   info   true and worth knowing (the year was assumed, it ends after midnight)
//
// Dates and times are the parish's LOCAL wall clock, as a draft holds them, so
// nothing here needs a time zone — except "today", which the caller supplies
// as the parish's own calendar date.
//
// Classic script, dual shape: window.AgoraEventChecks, and module.exports for
// the Worker and the tests.
(function (root) {
  const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** 'YYYY-MM-DD' that names a real calendar day. */
  function isLocalDate(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const [y, m, d] = v.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d));
    return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
  }

  /** 'HH:MM', 24-hour. */
  const isLocalTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

  /** 0 = Sunday, read off the calendar date itself — no zone involved. */
  function weekdayOf(date) {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  /** '2026-11-15' -> '15 Nov 2026'. */
  function readableDate(date) {
    const [y, m, d] = date.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
  }

  /**
   * A weekday as a poster printed it — "SAT.", "Saturday", "sat" — as 0–6, or
   * null for anything that is not one. Only English is attempted: the reader is
   * asked to give the weekday in English whatever language the poster is in.
   */
  function printedWeekday(v) {
    if (typeof v !== 'string') return null;
    const k = v.trim().toLowerCase().replace(/[^a-z]/g, '').slice(0, 3);
    const i = WEEKDAYS.findIndex(w => w.toLowerCase().startsWith(k));
    return k.length === 3 && i >= 0 ? i : null;
  }

  const blank = (v) => v == null || String(v).trim() === '';

  /**
   * @param {object} f  a draft event: title, date, start_time, end_time,
   *                    printed_weekday, year_printed
   * @param {{today?: string}} ctx  the parish's own 'YYYY-MM-DD'
   * @returns {Array<{field: string, level: 'block'|'warn'|'info', text: string}>}
   */
  function checkDraftEvent(f, ctx = {}) {
    const out = [];
    const add = (field, level, text) => out.push({ field, level, text });
    f = f || {};

    if (blank(f.title)) add('title', 'block', 'Needs a title.');

    const dateOk = isLocalDate(f.date);
    if (blank(f.date)) add('date', 'block', 'Needs a date.');
    else if (!dateOk) add('date', 'block', 'That is not a date.');

    if (blank(f.start_time)) add('start_time', 'block', 'Needs a start time.');
    else if (!isLocalTime(f.start_time)) add('start_time', 'block', 'Write the time like 19:30.');

    if (!blank(f.end_time) && !isLocalTime(f.end_time)) add('end_time', 'block', 'Write the time like 21:00.');

    if (dateOk) {
      const said = printedWeekday(f.printed_weekday);
      const is = weekdayOf(f.date);
      if (said != null && said !== is) {
        add('date', 'warn',
          `The poster says ${WEEKDAYS[said]}, but ${readableDate(f.date)} is a ${WEEKDAYS[is]}.`);
      }
      if (f.year_printed === 0 || f.year_printed === false) {
        add('date', 'info', `No year on the poster — read as ${f.date.slice(0, 4)}.`);
      }
      if (ctx.today && isLocalDate(ctx.today) && f.date < ctx.today) {
        add('date', 'warn', 'This date has already passed.');
      }
    }

    if (isLocalTime(f.start_time) && isLocalTime(f.end_time) && f.end_time <= f.start_time) {
      add('end_time', 'info', 'Ends after midnight, on the next day.');
    }
    return out;
  }

  /** The checks that stop a Publish. */
  const blockers = (checks) => (checks || []).filter(c => c.level === 'block');

  const api = { checkDraftEvent, blockers, isLocalDate, isLocalTime, weekdayOf, readableDate,
    printedWeekday, WEEKDAYS };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.AgoraEventChecks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
