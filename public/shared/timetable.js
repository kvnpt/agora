// Which parishes, and which of their rules, a link means.
//
// Two places list the timetables of many parishes at once: the app's Schedules
// view (renderServices in app.js) and the Worker's timetable page for a
// general link — /greek/qld, /liturgy, /wed/evening, /timetables
// (worker/lib/lite-timetable.mjs). Two filters of the same rules drift the
// moment one learns a new segment, which is how /evening nearly meant one
// thing in the feed and another on its headings. So the question lives here
// and both ask it.
//
// `f` is the filter set as the app keeps it in state.filters — jurisdiction,
// location (a slug), service, day, dayGroup (/weeknights, /weekends), part,
// lang and langStrict (the older
// englishOnly / englishStrict pair still means English), kind and kindSub,
// and parishIds (a Set) — and as the Worker builds it from the URL.
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

  /**
   * Does a language column's entry name the language asked for? Loosely, both
   * ways round, so "English" finds "English (some)" and "Slavonic" finds
   * "Church Slavonic".
   */
  function langIs(entry, want) {
    const a = String(entry || '').trim().toLowerCase();
    const b = String(want || '').trim().toLowerCase();
    return !!a && !!b && (a.includes(b) || b.includes(a));
  }

  /** The language filter a set asks for, or null: { lang, strict }. */
  function langFilterOf(f) {
    if (!f) return null;
    if (f.lang) return { lang: f.lang, strict: !!f.langStrict };
    if (f.englishOnly) return { lang: 'English', strict: !!f.englishStrict };
    return null;
  }

  /** Does a row's languages answer a language filter: any of them, or (strict) all? */
  function langsMatch(langs, lf) {
    if (!lf) return true;
    if (!langs) return false;
    return lf.strict ? langs.every(l => langIs(l, lf.lang)) : langs.some(l => langIs(l, lf.lang));
  }

  // What the feed calls a kind, of the seven event types (event-types.js),
  // after vespers and matins have been read as prayer.
  const DISPLAY_TYPE = { vespers: 'prayer', matins: 'prayer', festival: 'social', fundraiser: 'social' };
  const KIND_TYPES = { services: ['liturgy', 'prayer', 'feast'], talks: ['talk'], socials: ['social', 'youth'] };
  /** Is this row a Bible study, by its title? Talks' one sub-kind is read that way. */
  const isBibleStudy = (row) => !!services && services.serviceOf(row) === 'bible-study';
  /** Is an event or a rule of the kind (and sub-kind) asked for? Any, with none asked. */
  function kindMatches(row, f) {
    if (!f || !f.kind) return true;
    const t = DISPLAY_TYPE[row && row.event_type] || (row && row.event_type) || 'other';
    // Bible studies are Talks' sub-kind, but a type of their own they are not:
    // a study is usually typed "talk", sometimes "other", and its title says
    // what it is.
    if (f.kind === 'talks') {
      if (f.kindSub === 'bible-study') return isBibleStudy(row);
      return t === 'talk' || isBibleStudy(row);
    }
    if (f.kindSub) return t === f.kindSub;
    return (KIND_TYPES[f.kind] || []).includes(t);
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
    if (f.dayGroup && services && !services.dayGroupMatches(f.dayGroup, rule.day_of_week, rule)) return false;
    if (f.part && services && services.partOfDayOf(rule) !== f.part) return false;
    if (!kindMatches(rule, f)) return false;
    const lf = langFilterOf(f);
    if (lf) {
      const langs = langsOf(rule.languages)
        || langsOf(parishLanguages !== undefined ? parishLanguages : rule.parish_languages);
      return langsMatch(langs, lf);
    }
    return true;
  }

  /**
   * Does the link ask something of the rules — a service, a day, a part of
   * the day, a language? Then the parishes with no rules at all are not
   * counted under it. Nothing on file is not "no Bible study", and counting
   * it put Howick's mission, alone of 24 Antiochian parishes, under
   * /antiochian/bible-study: the other 19 without one have rules, so they
   * fell out at ruleMatches. A jurisdiction or region page still counts them.
   */
  function narrowsRules(f) {
    return !!(f.service || f.day != null || f.dayGroup || f.part || langFilterOf(f) || f.kind);
  }

  const api = { langsOf, langIs, langFilterOf, langsMatch, kindMatches, KIND_TYPES, parishInScope, ruleMatches, narrowsRules };
  if (isCjs) module.exports = api;
  else if (root) root.AgoraTimetable = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
