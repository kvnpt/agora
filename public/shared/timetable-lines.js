// A parish's timetable as lines: one per service, with the days it runs.
//
// "Tue–Thu, Sat 6pm Vespers" is several rules, one for each day, read as one
// line. Which rules make a line, how its days are said, what it says about its
// dates ("until 24 Oct", "from 25 Oct"), and the order of the lines (the
// morning's, then the evening's under the moon, each from Sunday): the page's
// parish card (public/next/next.js) and the Worker's first paint of it
// (worker/lib/page-card.mjs) read the same lines from here, so the card a link
// paints at once is the card the page then draws.
//
// PURE. A rule's day and time are its parish's wall clock, so no zone is
// needed; `today` is the parish's date, which the caller knows.

(function (root) {
  const isCjs = typeof module === 'object' && module.exports;
  const services = isCjs ? require('./services.js') : root.AgoraServices;

  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const ORD = { first: '1st', second: '2nd', third: '3rd', fourth: '4th', last: 'last' };

  /** "1st & 3rd", "fortnightly": what narrows a rule to some of its days. */
  function qualifier(r) {
    const bits = [];
    if (r.week_of_month) bits.push(String(r.week_of_month).split(',').map(w => ORD[w.trim()] || w).join(' & '));
    if (r.week_parity) bits.push('fortnightly');
    return bits.join(' ');
  }

  /** "Mon–Fri", "Tue, Thu", "Every day": Monday first, a run of three a range. */
  function dayList(days) {
    const ds = [...new Set(days)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
    if (ds.length === 7) return 'Every day';
    const idx = ds.map(d => (d + 6) % 7);
    const out = [];
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) j++;
      if (j - i >= 2) out.push(`${WD[(idx[i] + 1) % 7]}–${WD[(idx[j] + 1) % 7]}`);
      else for (let k = i; k <= j; k++) out.push(WD[(idx[k] + 1) % 7]);
      i = j + 1;
    }
    return out.join(', ');
  }

  /**
   * "until 24 Oct", "from 25 Oct", "2 Mar – 20 Apr": a rule that ends, or has
   * not started by `today`, says so. A service changed from a date on is two
   * rules, and without it the timetable read as both running.
   */
  function ruleRange(r, today) {
    const from = r.effective_from && r.effective_from > today ? r.effective_from : null;
    const to = r.effective_to || null;
    const d = (k) => `${Number(k.slice(8, 10))} ${MON[Number(k.slice(5, 7)) - 1]}`;
    return from && to ? `${d(from)} – ${d(to)}` : from ? `from ${d(from)}` : to ? `until ${d(to)}` : '';
  }

  /** Is this rule a timetable's today: active, and not ended by `today`. */
  const isLive = (r, today) => r.active !== 0 && r.active !== false && !(r.effective_to && r.effective_to < today);

  const isEvening = (r) => services.partOfDayOf(r) === 'evening';

  /**
   * The lines of these rules, in the timetable's order. `offOf(rule)` says
   * what a break makes of a rule today ('on a break, back Sun 8 Nov'), or ''.
   * Each line is { r, days, ids, q, range, off, evening }: `r` the first rule
   * of it, `ids` every rule it stands for.
   */
  function linesOf(rules, { today, offOf = () => '' } = {}) {
    const lines = new Map();
    for (const r of rules) {
      const q = qualifier(r), range = ruleRange(r, today), off = offOf(r) || '';
      const key = [r.title, r.feast || '', r.event_type, r.start_time, q, r.languages || '', range, off].join('|');
      if (!lines.has(key)) lines.set(key, { r, days: [], ids: [], q, range, off, evening: isEvening(r) });
      lines.get(key).days.push(r.day_of_week);
      lines.get(key).ids.push(r.id);
    }
    const firstDay = (l) => Math.min(...l.days);
    return [...lines.values()].sort((a, b) => a.evening - b.evening || firstDay(a) - firstDay(b)
      || String(a.r.start_time).localeCompare(String(b.r.start_time)));
  }

  /**
   * A day's rows as its time slots: every row in a run at one time is one
   * slot, which a Coming up shows on one stretch of its rule with the time
   * said once. `timeOf(row)` is the row's wall clock ("09:00"); the rows come
   * in the day's order, which this keeps.
   */
  function slotsOf(rows, timeOf) {
    const out = [];
    for (const row of rows) {
      const t = timeOf(row);
      const last = out[out.length - 1];
      if (last && last.time === t) last.rows.push(row);
      else out.push({ time: t, rows: [row] });
    }
    return out;
  }

  const api = { qualifier, dayList, ruleRange, isLive, isEvening, linesOf, slotsOf };
  if (isCjs) module.exports = api;
  else root.AgoraTimetableLines = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
