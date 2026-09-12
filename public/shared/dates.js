// When, as a URL slug.
//
// The feed already starts at today and runs forward. A date segment moves that
// start: /smg/2026-07 is St Michael & Gabriel from July onwards, /next-thursday
// is the whole feed from next Thursday, /liturgy/wednesday/march is every
// Wednesday liturgy with the stream wound on to March.
//
// So a date slug resolves to a DATE TO SHOW FROM, never to a single day's
// events. "From" is what the feed can honestly offer: a parish does not
// publish a month at a time, and a picked day with nothing on it should show
// the next thing that IS on rather than an empty page.
//
// ── Precision, and why a month stays a month ─────────────────────────────
//
// /smg/2026-07 resolves to 2026-07-01, and writing that back as 2026-07-01
// would be a different link from the one the user typed. Resolution therefore
// carries the precision it was asked at: a month-shaped slug reads back as a
// month and says "Showing from July 2026", a day-shaped one reads back as a
// day. Relative spellings are the exception — /next-thursday is a question
// about today, it has exactly one answer the moment it is asked, and that
// answer is what the URL is rewritten to.
//
// ── What is NOT reserved, and why ────────────────────────────────────────
//
// Three-letter month abbreviations. `sep` is St Elijah the Prophet, Coober
// Pedy, and has been a working link since the Serbian import. A path segment
// resolves in a fixed order with the parish acronym LAST, so teaching the
// router that `sep` means September would not raise a clash — it would quietly
// make that parish unreachable. Full month names cost nothing (no acronym
// spells one) and are what a person types anyway.
//
// Same dual-mode wrapper as its neighbours in this directory: a classic script
// in the browser, CommonJS for the Worker and the tests, so the spellings the
// router accepts and the spellings an acronym may not take are one list.
(function (root) {
  const isCjs = typeof module === 'object' && !!module.exports;
  const services = isCjs ? require('./services.js') : (root && root.AgoraServices);

  const MONTHS = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
  ];
  const MONTH_LABELS = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ];

  const DAY_MS = 86400000;
  const DAY_SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;
  const MONTH_SHAPE = /^(\d{4})-(\d{2})$/;

  const norm = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, '-');

  const pad = (n) => String(n).padStart(2, '0');
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
  const dowOf = (date) => new Date(date + 'T00:00:00Z').getUTCDay();
  const addDays = (date, n) => iso(Date.parse(date + 'T00:00:00Z') + n * DAY_MS);

  /** Is this a real calendar date, rather than merely date-shaped? */
  function isRealDate(y, m, d) {
    if (m < 1 || m > 12 || d < 1) return false;
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }

  /**
   * Every relative spelling, built from the weekday aliases services.js already
   * owns — so /next-weds works for the same reason /weds does, and neither list
   * can grow a spelling the other lacks.
   */
  function relativeSlugs() {
    const out = new Map();       // slug -> { kind, dow }
    out.set('today', { kind: 'today' });
    out.set('tomorrow', { kind: 'tomorrow' });
    out.set('next-week', { kind: 'offset', days: 7 });
    out.set('next-month', { kind: 'month-offset', months: 1 });
    out.set('next-year', { kind: 'month-offset', months: 12 });
    const aliases = (services && services.DAY_SLUGS) ? [...services.DAY_SLUGS] : [];
    for (const alias of aliases) {
      const dow = services.resolveDay(alias);
      if (dow == null) continue;
      out.set(`next-${alias}`, { kind: 'weekday', dow, inclusive: false });
      out.set(`this-${alias}`, { kind: 'weekday', dow, inclusive: true });
    }
    return out;
  }

  const RELATIVE = relativeSlugs();

  /** Every fixed spelling a date segment can take. Reserved against acronyms. */
  const DATE_SLUGS = new Set([...RELATIVE.keys(), ...MONTHS]);

  /**
   * Resolve one path segment to a focus, or null if it is not a date at all.
   *
   * `today` is the viewer's own local date as 'YYYY-MM-DD' — the caller passes
   * it, because this file has no opinion about which zone "today" is in and the
   * app has already decided (the feed's day headers are Sydney's).
   *
   * @returns {{date: string, precision: 'day'|'month', slug: string}|null}
   *   `slug` is the canonical spelling to write back. A relative segment
   *   resolves to an absolute one; a month keeps its month shape.
   */
  function resolveDateSlug(seg, today) {
    const key = norm(seg);
    if (!key) return null;
    const base = DAY_SHAPE.test(String(today || '')) ? String(today) : iso(Date.now());

    const day = DAY_SHAPE.exec(key);
    if (day) {
      const [, y, m, d] = day.map(Number);
      if (!isRealDate(y, m, d)) return null;
      return { date: key, precision: 'day', slug: key };
    }

    const month = MONTH_SHAPE.exec(key);
    if (month) {
      const [, y, m] = month.map(Number);
      if (!isRealDate(y, m, 1)) return null;
      return { date: `${y}-${pad(m)}-01`, precision: 'month', slug: `${y}-${pad(m)}` };
    }

    const monthName = MONTHS.indexOf(key);
    if (monthName !== -1) {
      // The one we are standing in counts. Asking for /march on 5 March means
      // this March, and resolving it to next year's would read as a typo.
      const [ty, tm] = base.split('-').map(Number);
      const year = tm <= monthName + 1 ? ty : ty + 1;
      return { date: `${year}-${pad(monthName + 1)}-01`, precision: 'month', slug: `${year}-${pad(monthName + 1)}` };
    }

    // Hyphens are how these read, but a hand-typed /nextthursday means the same
    // thing and there is nothing else it could mean.
    const rel = RELATIVE.get(key) || RELATIVE.get(hyphenate(key));
    if (!rel) return null;
    const date = resolveRelative(rel, base);
    return date ? { date, precision: 'day', slug: date } : null;
  }

  /** 'nextthursday' -> 'next-thursday', for the spellings we know. */
  function hyphenate(key) {
    for (const slug of RELATIVE.keys()) {
      if (slug.replace(/-/g, '') === key) return slug;
    }
    return key;
  }

  function resolveRelative(rel, today) {
    if (rel.kind === 'today') return today;
    if (rel.kind === 'tomorrow') return addDays(today, 1);
    if (rel.kind === 'offset') return addDays(today, rel.days);
    if (rel.kind === 'month-offset') {
      const [y, m] = today.split('-').map(Number);
      const total = (y * 12) + (m - 1) + rel.months;
      return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}-01`;
    }
    if (rel.kind === 'weekday') {
      // "next Thursday" is never today, even on a Thursday: somebody standing
      // in front of this morning's service asking for next Thursday means the
      // one after it. "this Thursday" is the nearer reading and includes today.
      let d = rel.inclusive ? today : addDays(today, 1);
      for (let i = 0; i < 7; i++) {
        if (dowOf(d) === rel.dow) return d;
        d = addDays(d, 1);
      }
    }
    return null;
  }

  /** The segment a focus writes back into the path. */
  function dateSlugFor(date, precision) {
    if (!DAY_SHAPE.test(String(date || ''))) return null;
    return precision === 'month' ? String(date).slice(0, 7) : String(date);
  }

  /**
   * "3/7/2027", or "July 2027" when only the month was asked for.
   *
   * Australian order, because every other date in the app is — the day headers,
   * the source lines, the horizon note.
   */
  function dateFocusLabel(date, precision) {
    if (!DAY_SHAPE.test(String(date || ''))) return '';
    const [y, m, d] = String(date).split('-').map(Number);
    if (precision === 'month') return `${MONTH_LABELS[m - 1]} ${y}`;
    return `${d}/${m}/${y}`;
  }

  const api = {
    DATE_SLUGS, MONTHS, MONTH_LABELS,
    resolveDateSlug, dateSlugFor, dateFocusLabel,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.AgoraDates = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
