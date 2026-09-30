// What a path means, segment by segment.
//
// `/sgr/next-tue`, `/greek/qld`, `/smg/wed/liturgy`, `/42:2026-10-04` — the
// app's whole URL grammar. It lived as a loop inside app.js's detectUrlState(),
// which was fine while only the browser read a URL. The Worker now reads the
// same links, to answer a shared parish or event link with a lite card of its
// own (worker/routes/pages.mjs), and two readers of one grammar are two
// grammars the moment either changes. So the loop lives here, and both call it:
// the same reasoning that put the projection in project.mjs.
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

  // The jurisdictions a path segment filters to. Not slugs.js's JURISDICTIONS,
  // which also holds 'other' — a value a parish can carry but not a view
  // anybody links to.
  const JURISDICTION_KEYS = ['antiochian', 'greek', 'serbian', 'russian', 'romanian', 'macedonian'];

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
      socialOnly: false,
      services: false,
      englishOnly: false,
      englishStrict: false,
      donate: false,
      eventId: null,
      dateFocus: null,
      precision: null,
      day: null,
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
      let d, loc, svc;
      if (JURISDICTION_KEYS.includes(seg)) {
        out.jurisdiction = seg;
      } else if (seg === 'social') {
        out.socialOnly = true;
      } else if (seg === 'services') {
        out.services = true;
      } else if (seg === 'en') {
        out.englishOnly = true;
        out.englishStrict = true;
      } else if (seg === 'bilingual') {
        out.englishOnly = true;
        out.englishStrict = false;
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
    // Services and socials are exclusive, and services wins.
    if (out.services && out.socialOnly) out.socialOnly = false;
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

  const api = { JURISDICTION_KEYS, isEventId, classifyPath, firstEventOnDay };
  if (isCjs) module.exports = api;
  else if (root) root.AgoraUrlState = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
