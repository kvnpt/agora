// What a parish acronym is not allowed to be.
//
// An acronym is a URL segment: /sjfc opens that parish. So is a jurisdiction
// (/greek), a region (/qld), a service (/liturgy), a mode (/services) and an
// event id (/42). They
// share one namespace and detectUrlState resolves them in a fixed order, with
// the parish slug last — so an acronym that spells an earlier one is not a
// clash the router notices, it is a parish that has quietly become
// unreachable. The check has to happen when the acronym is saved, which is
// what this file is for.
//
// Enforced in the Worker (worker/routes/admin.mjs), which is what makes it
// true for BOTH editors: the in-app parish form and /admin both PATCH the same
// endpoint, so neither can save a name the other would refuse.
//
// Same dual-mode wrapper as its neighbours — the Worker bundles the CommonJS
// branch, the browser gets a global for the inline hint under the field.
(function (root) {
  const isCjs = typeof module === 'object' && !!module.exports;
  const locations = isCjs ? require('./locations.js') : (root && root.AgoraLocations);
  const services = isCjs ? require('./services.js') : (root && root.AgoraServices);

  const JURISDICTIONS = [
    'antiochian', 'greek', 'serbian', 'russian', 'romanian', 'macedonian', 'other',
  ];

  // Path segments detectUrlState gives a meaning of their own.
  const PATH_KEYWORDS = ['social', 'services', 'en', 'bilingual'];

  // The second segment of a payment deep link, /<acronym>/donate. Reserved as
  // a first segment too, because /donate/donate could not be read either way.
  const PAY_KINDS = ['donate', 'raffle', 'payment', 'gala'];

  // Paths the Worker or the asset layer answers before the SPA ever sees them.
  const SITE_PATHS = [
    'api', 'health', 'admin', 'logos', 'tiles', 'posters', 'shared', 'lib',
    'glyphs', 'sprites', 'eucalyptus', 'cdn-cgi', 'assets', 'static',
    'favicon.ico', 'robots.txt', 'sitemap.xml', 'index.html', 'manifest.json',
  ];

  /** The comparison form: what the router matches a path segment against. */
  function normaliseSlug(value) {
    return String(value == null ? '' : value).trim().toLowerCase().replace(/\s+/g, '');
  }

  function buildReserved() {
    const set = new Set();
    const add = (v) => { const s = normaliseSlug(v); if (s) set.add(s); };
    JURISDICTIONS.forEach(add);
    PATH_KEYWORDS.forEach(add);
    PAY_KINDS.forEach(add);
    SITE_PATHS.forEach(add);
    if (locations && locations.LOCATION_SLUGS) {
      // Both spellings: a location alias resolves in the URL, so an acronym
      // matching 'queensland' is shadowed just as surely as one matching 'qld'.
      // The hyphenless form too, since normaliseSlug strips spaces but a
      // hand-typed "New Zealand" would otherwise slip past 'new-zealand'.
      for (const slug of locations.LOCATION_SLUGS) {
        add(slug);
        add(String(slug).replace(/-/g, ''));
      }
    }
    if (services && services.SERVICE_SLUGS) {
      for (const slug of services.SERVICE_SLUGS) {
        add(slug);
        add(String(slug).replace(/-/g, ''));
      }
    }
    if (services && services.DAY_SLUGS) for (const slug of services.DAY_SLUGS) add(slug);
    return set;
  }

  const RESERVED_SLUGS = buildReserved();

  /**
   * Why this acronym cannot be used, as a sentence, or null if it can.
   * Shape checks come first: they explain the problem better than "reserved".
   */
  function reservedSlugReason(value) {
    const slug = normaliseSlug(value);
    if (!slug) return null;                     // clearing the acronym is fine
    if (/[/?#]/.test(slug)) return 'An acronym cannot contain /, ? or #.';
    if (slug.includes('+')) {
      return 'An acronym cannot contain "+" — that joins several parishes in one link (/smg+sjfc).';
    }
    if (/^\d+$/.test(slug)) {
      return 'An acronym cannot be only digits — a numeric path segment is an event id.';
    }
    if (/^\d+:\d{4}-\d{2}-\d{2}$/.test(slug)) {
      return 'An acronym cannot look like a service instance id ("42:2026-09-06").';
    }
    if (RESERVED_SLUGS.has(slug)) {
      return `"${slug}" is a reserved link — it already means a jurisdiction, a region or a page, so /${slug} would never reach this parish.`;
    }
    return null;
  }

  const api = {
    RESERVED_SLUGS, JURISDICTIONS, PATH_KEYWORDS, PAY_KINDS, SITE_PATHS,
    normaliseSlug, reservedSlugReason,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.AgoraSlugs = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
