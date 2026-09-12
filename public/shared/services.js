// Service kinds, as URL slugs.
//
// /liturgy filters the feed to liturgies. /smg/liturgy goes further: it opens
// St Michael & Gabriel focused on the next occurrence of that parish's liturgy
// rule, with the parish feed showing only that rule's future recurrences.
//
// ── Why titles and not event_type ────────────────────────────────────────
//
// event_type is a five-way bucket — production's 68 rules are 36 'liturgy',
// 31 'prayer' and one 'other' — and "prayer" covers Matins, Vespers,
// Paraklesis, Compline and Confession alike. The name is where the service
// actually is: "Matins", "Small Compline", "Sisterhood of Saints Mary and
// Martha (Paraklesis Service)". So the title decides, and event_type is the
// fallback for a row whose title names nothing recognisable.
//
// Order matters, and liturgy is first for one reason: "Vesperal Liturgy -
// Entrance of the Theotokos" matches both /vesper/ and /liturg/, and it is a
// Liturgy served in the evening, not a Vespers.
//
// Same dual-mode wrapper as its neighbours in this directory.
(function (root) {
  const SERVICES = [
    { slug: 'liturgy', label: 'Liturgy', plural: 'Liturgies', aliases: ['divine-liturgy', 'liturgies'],
      title: /\bliturg/i, types: ['liturgy'] },
    // Not in the original request, and 20 of production's 68 rules are Matins
    // — /smg/liturgy working while /smg/matins did not would be the odd part.
    { slug: 'matins', label: 'Matins', plural: 'Matins', aliases: ['orthros'],
      title: /\bmatins\b|\borthros\b/i },
    { slug: 'vespers', label: 'Vespers', plural: 'Vespers', aliases: ['esperinos'],
      title: /\bvespers?\b|\bvesperal\b/i },
    { slug: 'paraklesis', label: 'Paraklesis', plural: 'Paraklesis services', aliases: ['supplication'],
      title: /\bparaklesis\b|\bsupplicat/i },
    { slug: 'compline', label: 'Compline', plural: 'Compline services', aliases: ['apodeipnon'],
      title: /\bcompline\b|\bapodeipnon\b/i },
    { slug: 'bible-study', label: 'Bible Study', plural: 'Bible studies', aliases: ['biblestudy', 'scripture-study', 'study'],
      title: /\bbible\s*study\b|\bscripture\s+study\b/i },
    // Also from the data rather than the request: Confession is 13 of the 68
    // one-off events, and it is the one people most need the time of.
    { slug: 'confession', label: 'Confession', plural: 'Confessions', aliases: ['confessions'],
      title: /\bconfession/i },
    // The only entry that is a type first. A feast is what the day is, not
    // what the service is called, so its rows are titled after the feast.
    { slug: 'feast', label: 'Feast', plural: 'Feasts', aliases: ['feasts', 'feast-day'],
      title: /\bfeast\b/i, types: ['feast'] },
  ];

  // ── Days of the week ─────────────────────────────────────────────────
  //
  // /sgr/wed/liturgy is the Wednesday liturgy, not the Sunday one. The day
  // lives here rather than in its own file because a schedule rule is a day,
  // a time and a service, and the URL names them in that order.
  //
  // 0 is Sunday, matching schedules.day_of_week and JavaScript's getDay().
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const DAY_ALIASES = [
    ['sun', 'sunday', 'sundays'],
    ['mon', 'monday', 'mondays'],
    ['tue', 'tuesday', 'tuesdays', 'tues'],
    ['wed', 'wednesday', 'wednesdays', 'weds'],
    ['thu', 'thursday', 'thursdays', 'thur', 'thurs'],
    ['fri', 'friday', 'fridays'],
    ['sat', 'saturday', 'saturdays'],
  ];
  const BY_DAY_SLUG = new Map();
  DAY_ALIASES.forEach((names, dow) => names.forEach(n => BY_DAY_SLUG.set(n, dow)));

  /** Every spelling of a weekday. Reserved against parish acronyms. */
  const DAY_SLUGS = new Set(BY_DAY_SLUG.keys());

  /** 'wed' / 'Wednesday' → 3. Anything else → null (0 is Sunday, so no ||). */
  function resolveDay(slug) {
    const key = String(slug == null ? '' : slug).trim().toLowerCase().replace(/\s+/g, '');
    const dow = BY_DAY_SLUG.get(key);
    return dow === undefined ? null : dow;
  }

  /** 3 → 'wed'. The canonical short form the URL is rewritten to. */
  function daySlug(dow) {
    return DAY_ALIASES[dow] ? DAY_ALIASES[dow][0] : null;
  }

  /** 3 → 'Wednesday'. */
  function dayName(dow) {
    return DAY_NAMES[dow] || '';
  }

  const BY_SLUG = new Map();
  for (const svc of SERVICES) {
    BY_SLUG.set(svc.slug, svc);
    for (const a of svc.aliases || []) BY_SLUG.set(a, svc);
  }

  /** Every spelling that names a service. Reserved against parish acronyms. */
  const SERVICE_SLUGS = new Set(BY_SLUG.keys());

  const norm = (s) => String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, '-');

  function resolveService(slug) {
    const key = norm(slug);
    return BY_SLUG.get(key) || BY_SLUG.get(key.replace(/-/g, '')) || null;
  }

  /**
   * Which service this row is, as a slug, or null.
   *
   * One classification for everything — filtering, the chip's label, the pill
   * a schedule row spawns — so a row cannot be filtered as one service and
   * labelled as another. Rows are events, projected instances and schedule
   * rules alike: all three carry `title` and `event_type`.
   */
  function serviceOf(row) {
    if (!row) return null;
    const title = row.title || '';
    for (const svc of SERVICES) if (svc.title && svc.title.test(title)) return svc.slug;
    const type = row.event_type || '';
    for (const svc of SERVICES) if (svc.types && svc.types.includes(type)) return svc.slug;
    return null;
  }

  /** Is this row the given service? Pass a slug or a service object. */
  function serviceMatches(service, row) {
    const slug = typeof service === 'string' ? norm(service) : (service && service.slug);
    if (!slug) return true;
    const resolved = resolveService(slug);
    return !!resolved && serviceOf(row) === resolved.slug;
  }

  /** Label for a slug, for a chip or a pill. Falls back to the slug itself. */
  function serviceLabel(slug) {
    const svc = resolveService(slug);
    return svc ? svc.label : String(slug || '');
  }

  /**
   * Plural, for "Showing Liturgies" — a parish with three liturgy rules under
   * one /liturgy link. Spelled out per service rather than derived, because
   * the English does not follow a rule here: Matins and Vespers are already
   * plural, Paraklesis and Compline take a noun after them, and Bible Study
   * pluralises on its second word.
   */
  function servicePlural(slug) {
    const svc = resolveService(slug);
    return svc ? (svc.plural || svc.label) : String(slug || '');
  }

  const api = { SERVICES, SERVICE_SLUGS, resolveService, serviceOf, serviceMatches, serviceLabel, servicePlural,
    DAY_SLUGS, DAY_NAMES, resolveDay, daySlug, dayName };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.AgoraServices = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
