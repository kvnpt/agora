// What a filter link is called: "Antiochian Orthodox Liturgies in English",
// "Orthodox youth groups", "Greek Orthodox parishes and times in Queensland".
//
// The Worker heads a link's page with these words, so a chat preview and a
// search result name it (worker/lib/lite-timetable.mjs timetableHeading). The
// page says the same of what its map is showing, under the parishes in view
// and on a list saved from them (public/next/next.js), so one view has one
// name wherever it is read. Two copies of the sentence would part the first
// time either learnt a filter.
//
// `r` is url-state.js's classification of a link (classifyPath), or a filter
// set in the same fields. `loc` is the region it names, resolved
// (locations.js); `named` the parishes it names by acronym, when several.
//
// Same dual-mode wrapper as its neighbours.
(function (root) {
  const isCjs = typeof module === 'object' && !!module.exports;
  const services = isCjs ? require('./services.js') : (root && root.AgoraServices);
  const eventTypes = isCjs ? require('./event-types.js') : (root && root.AgoraEventTypes);

  const JURIS_LABEL = {
    antiochian: 'Antiochian Orthodox', greek: 'Greek Orthodox', serbian: 'Serbian Orthodox',
    russian: 'Russian Orthodox (ROCOR)', romanian: 'Romanian Orthodox', macedonian: 'Macedonian Orthodox',
  };
  const JURIS_SHORT = {
    antiochian: 'Antiochian', greek: 'Greek', serbian: 'Serbian', russian: 'Russian', romanian: 'Romanian', macedonian: 'Macedonian',
  };
  const and = (xs) => (xs.length > 2 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs.join(' and '));

  /** 'greek' → "Greek Orthodox"; several → "Antiochian and Greek Orthodox"; none → "Orthodox". */
  function jurisLabel(j) {
    const js = (j == null ? [] : [].concat(j)).filter(x => JURIS_LABEL[x]);
    if (js.length === 1) return JURIS_LABEL[js[0]];
    return js.length ? `${and(js.map(x => JURIS_SHORT[x]))} Orthodox` : 'Orthodox';
  }

  /** Does the link narrow a parish's services: a service, a day, a part of the day? */
  const isNarrowed = (r) => !!(r.service || r.day != null || r.dayGroup || r.part);

  /** " on Wednesdays and Fridays", " on weekends", or nothing. */
  function daysPhrase(r) {
    if (r.day != null) return ` on ${services.dayNames(r.day)}`;
    return r.dayGroup ? ` on ${services.dayGroupLabel(r.dayGroup).toLowerCase()}` : '';
  }

  // The feed's other kinds, which only the page names (/talks, /social).
  const OTHER_KINDS = { talks: 'talks and Bible studies', socials: 'youth groups and socials' };
  const OTHER_SUBS = { 'bible-study': 'Bible studies', youth: 'youth groups', social: 'social gatherings' };

  /**
   * "Greek Orthodox parishes and times in Queensland" (/greek/qld, /timetables),
   * "Orthodox service times in English" (/services/en), "Orthodox evening
   * Vespers on Wednesdays", "Antiochian Orthodox Liturgies in English",
   * "Orthodox fully-English services".
   *
   * Two languages, two names: /en is English services — English, or English
   * beside another language — and /en-only is fully-English services, English
   * and nothing else.
   */
  function headingOf(r, { loc = null, named = null } = {}) {
    const who = jurisLabel(r.jurisdiction);
    const svc = r.service ? services.servicePlural(r.service) : null;
    // English keeps its words ("fully-English"); another language is "Greek-only".
    const full = r.lang && r.langStrict ? (/^english$/i.test(r.lang) ? 'fully-English' : `${r.lang}-only`) : '';
    const sub = r.kind === 'services' && r.kindSub
      ? `${eventTypes.eventTypeLabel(r.kindSub).toLowerCase()} services` : (r.kindSub && OTHER_SUBS[r.kindSub]) || null;
    let noun = svc || sub || OTHER_KINDS[r.kind] || (r.kind === 'services' ? (isNarrowed(r) ? 'services' : 'service times')
      : isNarrowed(r) || r.lang ? 'services' : 'parishes and times');
    if (r.monasteries) noun = noun === 'parishes and times' ? 'monasteries and service times' : `${noun} at monasteries`;
    const lang = r.lang && !full ? ` in ${r.lang}` : '';
    let where = loc ? ` in ${loc.label}` : '';
    if (named && named.length) where = ` at ${and(named.map(p => p.name))}`;
    return [who, full, r.part || '', noun].filter(Boolean).join(' ') + daysPhrase(r) + lang + where;
  }

  /**
   * A list's name, for a list saved from a view: what it holds, shortest first.
   * "English Antiochian parishes in Sydney", "Greek Liturgies on Sundays near
   * you", "Monasteries in Victoria". No count: the list's row says how many,
   * and stays right as parishes are added to it. `place` is where the map is
   * ("Sydney", "Near you") when no region is asked for.
   */
  function listNameOf(r, { loc = null, place = null } = {}) {
    const js = (r.jurisdiction == null ? [] : [].concat(r.jurisdiction)).filter(x => JURIS_SHORT[x]);
    const lang = r.lang ? (r.langStrict ? (/^english$/i.test(r.lang) ? 'Fully-English' : `${r.lang}-only`) : r.lang) : '';
    const sub = r.kind === 'services' && r.kindSub
      ? `${eventTypes.eventTypeLabel(r.kindSub).toLowerCase()} services` : (r.kindSub && OTHER_SUBS[r.kindSub]) || null;
    let noun = (r.service ? services.servicePlural(r.service) : null) || sub || OTHER_KINDS[r.kind]
      || (r.kind === 'services' || isNarrowed(r) ? 'services' : 'parishes');
    if (r.monasteries) noun = noun === 'parishes' ? 'monasteries' : `${noun} at monasteries`;
    const where = loc ? ` in ${loc.label}` : !place ? '' : /^near you$/i.test(place) ? ' near you' : ` in ${place}`;
    const name = [lang, and(js.map(x => JURIS_SHORT[x])), r.part || '', noun].filter(Boolean).join(' ') + daysPhrase(r) + where;
    return name.charAt(0).toUpperCase() + name.slice(1);
  }

  /** Does the link ask anything of a parish or its services, beyond where it is? */
  const asksAnything = (r) => !!(r.jurisdiction || r.monasteries || r.kind || r.lang || isNarrowed(r));

  const api = { JURIS_LABEL, JURIS_SHORT, jurisLabel, isNarrowed, daysPhrase, headingOf, listNameOf, asksAnything };
  if (isCjs) module.exports = api;
  else if (root) root.AgoraLinkWords = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
