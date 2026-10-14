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
  // Studies (talks), Socials (social and youth), each segment its kind and, for
  // two of them, one sub-kind. /social is older than the rest and stays.
  const KIND_SEGMENTS = {
    worship: ['services', null],
    'worship-liturgy': ['services', 'liturgy'],
    'worship-prayer': ['services', 'prayer'],
    'worship-feast': ['services', 'feast'],
    studies: ['studies', null],
    social: ['socials', null],
    'social-gatherings': ['socials', 'social'],
    'social-youth': ['socials', 'youth'],
  };
  /** The segment for a kind filter, or null for any event. */
  function kindSegment(kind, sub) {
    if (!kind) return null;
    for (const [seg, [k, s]] of Object.entries(KIND_SEGMENTS)) {
      if (k === kind && (s || null) === (sub || null)) return seg;
    }
    return null;
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
      services: false,
      lang: null,
      langStrict: false,
      englishOnly: false,
      englishStrict: false,
      week: false,
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
        // The feed's kind (/worship is Services — /services is already the
        // timetable), perhaps with one sub-kind.
        [out.kind, out.kindSub] = KIND_SEGMENTS[seg];
      } else if (seg === 'services') {
        out.services = true;
      } else if (seg === 'this-week') {
        out.week = true;
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
    // The timetable (/services) and a kind of event are exclusive, and the
    // timetable wins. A later kind segment replaced an earlier one above.
    if (out.services) { out.kind = null; out.kindSub = null; }
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
   *                 /sgr/next-tue, /sgr/services)
   *   'event'     — one event by id (/102, /42:2026-10-04)
   *   'timetable' — any other filter link (/greek/qld, /liturgy, /smg+sgr,
   *                 /services)
   *   null        — the home page, a link with a date and no parish, /social,
   *                 /worship, /donate, and a path that names nothing
   *
   * Shared because two readers act on it: the Worker answers these with a
   * page (worker/routes/pages.mjs), and the app, when it is the one answering
   * — for an admin — lays a parish or an event out as that page rather than
   * as a sheet over the map. The two must agree on which links are pages.
   */
  function pageKind(r) {
    if (!r || r.kind || r.week || r.donate) return null;
    // A card is one parish's, so a jurisdiction, a region or a language beside
    // one is a question the card does not answer; the app does.
    const scoped = r.jurisdiction || r.location || r.lang;
    if (r.parishSlugs && r.parishSlugs.length === 1) return scoped ? null : 'parish';
    if (r.eventId) {
      const bare = !r.parishSlugs && !scoped && !r.dateFocus && r.day == null && !r.service
        && !r.part && !r.services;
      return bare ? 'event' : null;
    }
    // "What is on next Sunday" is a list of dates across parishes, which the
    // app answers. A path that names nothing is the home page, or a segment
    // nobody recognises.
    if (r.dateFocus) return null;
    const names = scoped || r.services || r.service || r.day != null || r.part
      || (r.parishSlugs && r.parishSlugs.length > 1);
    return names ? 'timetable' : null;
  }

  const api = { JURISDICTION_KEYS, KIND_SEGMENTS, isEventId, classifyPath, firstEventOnDay, pageKind,
    englishSegment, kindSegment, langSlug, langFromSlug };
  if (isCjs) module.exports = api;
  else if (root) root.AgoraUrlState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
