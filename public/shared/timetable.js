// Which parishes, and which of their rules, a link means.
//
// Two places list the timetables of many parishes at once: the app's Schedules
// view (renderServices in app.js) and the Worker's timetable page for a
// general link — /greek/qld, /liturgy, /wed/evening, /services
// (worker/lib/lite-timetable.mjs). Two filters of the same rules drift the
// moment one learns a new segment, which is how /evening nearly meant one
// thing in the feed and another on its headings. So the question lives here
// and both ask it.
//
// `f` is the filter set as the app keeps it in state.filters — jurisdiction,
// location (a slug), service, day, part, englishOnly, englishStrict, and
// parishIds (a Set) — and as the Worker builds it from the URL.
//
// Same dual-mode wrapper as its neighbours.
(function (root) {
  const isCjs = typeof module === 'object' && !!module.exports;
  const services = isCjs ? require('./services.js') : (root && root.AgoraServices);
  const locations = isCjs ? require('./locations.js') : (root && root.AgoraLocations);

  /** A languages column — a JSON array — as an array, or null when it says nothing. */
  function langsOf(v) {
    if (Array.isArray(v)) return v.length ? v : null;
    if (!v) return null;
    try {
      const a = JSON.parse(v);
      return Array.isArray(a) && a.length ? a : null;
    } catch {
      return null;
    }
  }

  /** Is this parish one the link covers: its jurisdiction, its region, the parishes it names? */
  function parishInScope(parish, f) {
    if (!parish || parish.id === '_unassigned') return false;
    if (f.jurisdiction && parish.jurisdiction !== f.jurisdiction) return false;
    if (f.location && locations) {
      const loc = locations.resolveLocation(f.location);
      if (loc && !locations.locationMatchesParish(loc, parish)) return false;
    }
    if (f.parishIds && f.parishIds.size && !f.parishIds.has(parish.id)) return false;
    return true;
  }

  /**
   * Does this rule answer the link: its service, day, part of the day and
   * language?
   *
   * `parishLanguages` is the parish's own column, which a rule without
   * languages of its own falls back to — the app's rows carry it as
   * `parish_languages`, the Worker passes it.
   *
   * A parish_scoped rule shows only on its own parish's card, never in a list
   * of many (docs/editing.md), so it answers only when the link names that
   * one parish — the rule the events feed already keeps.
   */
  function ruleMatches(rule, f, { parishLanguages } = {}) {
    if (!rule) return false;
    if (rule.parish_scoped) {
      const one = f.parishIds && f.parishIds.size === 1 && f.parishIds.has(rule.parish_id);
      if (!one) return false;
    }
    if (f.service && services && !services.serviceMatches(f.service, rule)) return false;
    if (f.day != null && rule.day_of_week !== f.day) return false;
    if (f.part && services && services.partOfDayOf(rule) !== f.part) return false;
    if (f.englishOnly) {
      const langs = langsOf(rule.languages)
        || langsOf(parishLanguages !== undefined ? parishLanguages : rule.parish_languages);
      if (!langs) return false;
      return f.englishStrict
        ? langs.every(l => /english/i.test(l))
        : langs.some(l => /english/i.test(l));
    }
    return true;
  }

  const api = { langsOf, parishInScope, ruleMatches };
  if (isCjs) module.exports = api;
  else if (root) root.AgoraTimetable = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
