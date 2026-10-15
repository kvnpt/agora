// What a path means, segment by segment.
//
// `/sgr/next-tue`, `/greek/qld`, `/smg/wed/liturgy`, `/antiochian/evening`,
// `/42:2026-10-04` — the app's whole URL grammar. It lived as a loop inside
// app.js's detectUrlState(), which was fine while only the browser read a URL.
// The Worker now reads the same links, to answer a shared parish or event link
// with a lite card of its own (worker/routes/pages.mjs), and two readers of one
// grammar are two grammars the moment either changes. So the loop lives here,
// and both call it: the same reasoning that put the projection in project.mjs.
//
// It CLASSIFIES and does not resolve. A parish slug stays a slug here, because
// the browser holds the parish list and the Worker asks D1; each resolves it
// its own way. Everything else resolves through the shared tables beside this
// file, in the order the app always checked them — and the order is the
// grammar: /next-thursday is a date before it is a weekday, and a location
// before a parish is why an acronym may not spell one.
//
// Same dual-mode wrapper as its neighbours: a classic script for app.js, a
// CommonJS module for the Worker and the tests.
(function (root) {
  const isCjs = typeof module === 'object' && !!module.exports;
  const services = isCjs ? require('./services.js') : (root && root.AgoraServices);
  const dates = isCjs ? require('./dates.js') : (root && root.AgoraDates);
  const locations = isCjs ? require('./locations.js') : (root && root.AgoraLocations);
  const slugs = isCjs ? require('./slugs.js') : (root && root.AgoraSlugs);

  // The jurisdictions a path segment filters to. Not slugs.js's JURISDICTIONS,
  // which also holds 'other' — a value a parish can carry but not a view
  // anybody links to.
  const JURISDICTION_KEYS = ['antiochian', 'greek', 'serbian', 'russian', 'romanian', 'macedonian'];

  // /en, /english, /bilingual, /some-english… mean any service with English
  // in it; /en-only, /english-only, /full-english mean English and nothing
  // else. slugs.js keeps the spellings, because an acronym may not take one.
  const ENGLISH = (slugs && slugs.ENGLISH_SEGMENTS) || ['en'];
  const ENGLISH_ONLY = (slugs && slugs.ENGLISH_ONLY_SEGMENTS) || ['en-only'];

  /** 'Church Slavonic' → 'church-slavonic': a language as a path segment's tail. */
  const langSlug = (name) => String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  /** 'church-slavonic' → 'Church Slavonic'. */
  const langFromSlug = (slug) => String(slug || '').split('-').filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

  /**
   * The segment a link writes for a language filter, or null when there is
   * none. English keeps its old spellings (/en, /en-only); any other language
   * is /in-greek, or /in-greek-only for nothing but Greek.
   *
   * `f` is a filter set: { lang, langStrict }, or the older englishOnly /
   * englishStrict pair, which means English.
   */
  function englishSegment(f) {
    if (!f) return null;
    const lang = f.lang || (f.englishOnly ? 'English' : null);
    if (!lang) return null;
    const strict = f.lang ? !!f.langStrict : !!f.englishStrict;
    if (/^english$/i.test(lang)) return strict ? ENGLISH_ONLY[0] : ENGLISH[0];
    return `in-${langSlug(lang)}${strict ? '-only' : ''}`;
  }

  // The feed's kind filter: Any event, then Services (liturgy, prayer, feast),
  // Talks (and Bible studies), Socials (social and youth), each a segment and,
  // for each sub-kind, a segment of its own. /social is older than the rest
  // and stays.
  //
  // A sub-kind is named by its own word: /liturgy, /prayer, /feast,
  // /bible-study. Three of those four were already services (services.js)
  // and are read as one here — the app turns a feed-wide /liturgy into the
  // Services filter with Liturgy chosen (kindOfService) — so only /prayer
  // needs a row of its own below.
  const KIND_SEGMENTS = {
    services: ['services', null],
    prayer: ['services', 'prayer'],
    talks: ['talks', null],
    social: ['socials', null],
    'social-gatherings': ['socials', 'social'],
    'social-youth': ['socials', 'youth'],
  };
  // The sub-kinds that are services.js's services too, and what they choose.
  const SERVICE_KINDS = {
    liturgy: ['services', 'liturgy'],
    feast: ['services', 'feast'],
    'bible-study': ['talks', 'bible-study'],
  };
  /** The [kind, sub-kind] a service slug stands for in the feed, or null. */
  function kindOfService(slug) {
    return SERVICE_KINDS[String(slug || '')] || null;
  }
  /** The segment for a kind filter, or null for any event. */
  function kindSegment(kind, sub) {
    if (!kind) return null;
    for (const [seg, [k, s]] of Object.entries(SERVICE_KINDS)) {
      if (k === kind && s === (sub || null)) return seg;
    }
    for (const [seg, [k, s]] of Object.entries(KIND_SEGMENTS)) {
      if (k === kind && (s || null) === (sub || null)) return seg;
    }
    return null;
  }

  // Spellings the site has stopped writing. Services were /worship while
  // /services was the timetable, then /services-liturgy…; Talks were
  // /studies. The Worker answers one with a 301 to its name now (renamedPath),
  // and nothing reads them otherwise.
  const RENAMED_SEGMENTS = {
    worship: 'services',
    'worship-liturgy': 'liturgy',
    'worship-prayer': 'prayer',
    'worship-feast': 'feast',
    'services-liturgy': 'liturgy',
    'services-prayer': 'prayer',
    'services-feast': 'feast',
    studies: 'talks',
  };

  // The timetable's segment. /timetable is read too, as people type it, and
  // /parishes, which is what the page lists.
  const TIMETABLE_SEGMENTS = ['timetables', 'timetable', 'parishes'];

  /**
   * The path an old link should be sent to, or null when it is current:
   * /worship → /services, /sgr/services-liturgy → /sgr/liturgy.
   * Segments are matched whole and case-blind; the rest is left as written.
   */
  function renamedPath(pathname) {
    const segs = String(pathname || '').split('/');
    let changed = false;
    const out = segs.map(seg => {
      const now = RENAMED_SEGMENTS[seg.toLowerCase()];
      if (!now) return seg;
      changed = true;
      return now;
    });
    return changed ? out.join('/') : null;
  }

  // A week either side of this one: /next-week, /in-3-weeks, /last-week,
  // /2-weeks-ago. This week is /this-week, and the next month /this-month.
  /** The week a segment names, as weeks from this one, or null. */
  function weekOffsetOf(seg) {
    if (seg === 'this-week') return 0;
    if (seg === 'next-week') return 1;
    if (seg === 'last-week') return -1;
    let m = /^in-(\d{1,2})-weeks?$/.exec(seg);
    if (m) return Number(m[1]);
    m = /^(\d{1,2})-weeks?-ago$/.exec(seg);
    if (m) return -Number(m[1]);
    return null;
  }
  /** The segment for a week `n` weeks from this one. */
  function weekSegment(n) {
    if (!n) return 'this-week';
    if (n === 1) return 'next-week';
    if (n === -1) return 'last-week';
    return n > 0 ? `in-${n}-weeks` : `${-n}-weeks-ago`;
  }

  /** A stored event's id (`102`) or a projected occurrence's (`42:2026-10-04`). */
  const EVENT_ID = /^\d+$|^\d+:\d{4}-\d{2}-\d{2}$/;
  const isEventId = (seg) => EVENT_ID.test(String(seg || ''));

  /**
   * Classify a pathname.
   *
   * `today` is the 'YYYY-MM-DD' a relative date (/next-tue, /march) counts
   * from. The browser passes its own; the Worker passes the parish's, which
   * it only knows once the parish has resolved — so it may classify twice.
   *
   * Never throws: a path that will not decode means nothing, and an empty
   * answer is what "nothing" looks like.
   */
  function classifyPath(pathname, { today = null } = {}) {
    const out = {
      jurisdiction: null,
      kind: null,
      kindSub: null,
      socialOnly: false,
      worshipOnly: false,
      timetable: false,
      lang: null,
      langStrict: false,
      englishOnly: false,
      englishStrict: false,
      week: false,
      weekOffset: 0,
      month: false,
      donate: false,
      eventId: null,
      dateFocus: null,
      precision: null,
      day: null,
      part: null,
      service: null,
      location: null,
      parishSlugs: null,
    };
    let parts;
    try {
      parts = decodeURIComponent(String(pathname || ''))
        .toLowerCase().split('/').map(s => s.trim()).filter(Boolean);
    } catch {
      return out;
    }

    for (const seg of parts) {
      let d, loc, svc, part;
      if (JURISDICTION_KEYS.includes(seg)) {
        out.jurisdiction = seg;
      } else if (KIND_SEGMENTS[seg]) {
        // The feed's kind (/services, /prayer, /talks…), perhaps with one
        // sub-kind.
        [out.kind, out.kindSub] = KIND_SEGMENTS[seg];
      } else if (TIMETABLE_SEGMENTS.includes(seg)) {
        out.timetable = true;
      } else if (weekOffsetOf(seg) !== null) {
        // Before the dates: /next-week is a week, not "from seven days out".
        out.week = true;
        out.weekOffset = weekOffsetOf(seg);
        out.month = false;
      } else if (seg === 'this-month') {
        out.month = true;
        out.week = false;
      } else if (ENGLISH.includes(seg)) {
        out.lang = 'English';
        out.langStrict = false;
      } else if (ENGLISH_ONLY.includes(seg)) {
        out.lang = 'English';
        out.langStrict = true;
      } else if (/^in-[a-z0-9-]+$/.test(seg) && seg.length > 3) {
        const strict = /-only$/.test(seg);
        out.lang = langFromSlug(seg.slice(3).replace(/-only$/, ''));
        out.langStrict = strict;
      } else if (seg === 'donate') {
        out.donate = true;
      } else if (isEventId(seg)) {
        out.eventId = seg;
      } else if (dates && (d = dates.resolveDateSlug(seg, today))) {
        // Before the weekday: /next-thursday is a date, /thursday a filter.
        out.dateFocus = d.date;
        out.precision = d.precision;
      } else if (services && services.resolveDay(seg) !== null && services.resolveDay(seg) !== undefined) {
        out.day = services.resolveDay(seg);
      } else if (services && (part = services.resolvePartOfDay(seg))) {
        out.part = part;
      } else if (services && (svc = services.resolveService(seg))) {
        out.service = svc.slug;
      } else if (locations && (loc = locations.resolveLocation(seg))) {
        // Before the parish fallback — which is why an acronym may not spell a
        // region (slugs.js refuses one that would).
        out.location = loc.slug;
      } else if (seg.includes('+')) {
        out.parishSlugs = seg.split('+').map(s => s.trim()).filter(Boolean);
      } else {
        out.parishSlugs = [seg];
      }
    }
    // The timetable (/timetables) and a kind of event are exclusive, and the
    // timetable wins. A later kind segment replaced an earlier one above.
    if (out.timetable) { out.kind = null; out.kindSub = null; }
    // The older names, for readers that ask them.
    out.socialOnly = out.kind === 'socials';
    out.worshipOnly = out.kind === 'services';
    out.englishOnly = !!out.lang && /^english$/i.test(out.lang);
    out.englishStrict = out.englishOnly && out.langStrict;
    return out;
  }

  /**
   * The event a date focus pins at one parish: the first one ON that day.
   *
   * A date in a link is a question about a day, and the answer is what is on
   * then — and nothing, when nothing is. Pinning the next day's service would
   * answer a question nobody asked; the list below still starts at the date,
   * so the next thing on is right there. A month is not a day and pins nothing.
   *
   * `localDate(e)` gives an event's date where it happens. Shared, so the app's
   * sheet and the Worker's lite card pin the same event for the same link.
   */
  function firstEventOnDay(events, date, precision, localDate) {
    if (!date || precision === 'month') return null;
    return (events || [])
      .filter(e => !e.is_tombstone && localDate(e) === date)
      .sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc))[0] || null;
  }

  /**
   * Which kind of page a classified path is, or null for the app's own views.
   *
   *   'parish'    — one parish, with or without a focus (/sgr, /sgr/evening,
   *                 /sgr/next-tue, /sgr/timetables)
   *   'event'     — one event by id (/102, /42:2026-10-04)
   *   'timetable' — any other filter link (/greek/qld, /liturgy, /smg+sgr,
   *                 /timetables, /services)
   *   null        — the home page, a link with a date and no parish, /social,
   *                 /talks, a week, /donate, and a path that names nothing
   *
   * Shared because two readers act on it: the Worker answers these with a
   * page (worker/routes/pages.mjs), and the app, when it is the one answering
   * — for an admin — lays a parish or an event out as that page rather than
   * as a sheet over the map. The two must agree on which links are pages.
   */
  function pageKind(r) {
    // /services, /prayer: the timetable of services, when no parish is named.
    const servicesOnly = r && r.kind === 'services' && !(r.parishSlugs && r.parishSlugs.length === 1);
    if (!r || (r.kind && !servicesOnly) || r.week || r.month || r.donate) return null;
    // A card is one parish's, so a jurisdiction, a region or a language beside
    // one is a question the card does not answer; the app does.
    const scoped = r.jurisdiction || r.location || r.lang;
    if (r.parishSlugs && r.parishSlugs.length === 1) return scoped ? null : 'parish';
    if (r.eventId) {
      const bare = !r.parishSlugs && !scoped && !r.dateFocus && r.day == null && !r.service
        && !r.part && !r.timetable && !r.kind;
      return bare ? 'event' : null;
    }
    // "What is on next Sunday" is a list of dates across parishes, which the
    // app answers. A path that names nothing is the home page, or a segment
    // nobody recognises.
    if (r.dateFocus) return null;
    const names = scoped || r.timetable || servicesOnly || r.service || r.day != null || r.part
      || (r.parishSlugs && r.parishSlugs.length > 1);
    return names ? 'timetable' : null;
  }

  const api = { JURISDICTION_KEYS, KIND_SEGMENTS, SERVICE_KINDS, kindOfService, TIMETABLE_SEGMENTS, renamedPath,
    weekOffsetOf, weekSegment, isEventId, classifyPath, firstEventOnDay, pageKind,
    englishSegment, kindSegment, langSlug, langFromSlug };
  if (isCjs) module.exports = api;
  else if (root) root.AgoraUrlState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
