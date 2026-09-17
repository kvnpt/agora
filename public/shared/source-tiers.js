// Which source wins when two of them disagree about a parish.
//
// Agora learns about a parish from several places at once and they do not
// agree. The Antiochian directory says St Mary Magdalene is on "Coronation
// Street, Elimbah"; the parish's own site gives the street number. The same
// directory lists two Vespers that the parish confirmed by telephone no longer
// run. Both are the same kind of collision — a multiplicity of sources
// competing over one fact — and until this file existed the winner was
// whichever import ran last.
//
// THE LADDER, best first:
//
//   admin         a person typed it into /admin, or deleted it from /admin.
//                 Nothing outranks this. A deletion is a claim like any other
//                 and is the one this table exists to protect: a rule somebody
//                 removed on purpose has no row left to match, so every
//                 importer's "insert if it isn't there" guard would put it
//                 straight back.
//   parish        the parish's own website or social feed. It is the parish
//                 talking about itself.
//   jurisdiction  the jurisdiction's directory. Authoritative about which
//                 parishes exist, second-hand about any one of them.
//   search        a search engine's answer. Sometimes the only thing there is.
//   directory     a third-party aggregator — World Orthodox Directory,
//                 OpenStreetMap. Right often enough to be worth importing and
//                 wrong often enough to lose every argument.
//   (null)        no source at all, which loses to everything including itself.
//
// This is a ladder and not a score. `outranks` is the only comparison anyone
// should make, because "how much better" is not a question the ladder answers:
// a parish's own website beats its jurisdiction's directory by the same amount
// whatever the field is.
//
// A classic script rather than an .mjs, for the same reason as
// jurisdiction-colors.js next door: app.js cannot import, and the import
// scripts and the Worker both can. One file, three consumers, no drift.
(function (root) {
  const SOURCE_TIERS = [
    { id: 'admin', label: 'Agora admin', short: 'Admin',
      blurb: 'Typed or deleted by a person in /admin.' },
    { id: 'parish', label: 'Parish website or social feed', short: 'Parish',
      blurb: 'The parish talking about itself.' },
    { id: 'jurisdiction', label: 'Jurisdiction directory', short: 'Jurisdiction',
      blurb: 'The archdiocese or diocese listing its own parishes.' },
    { id: 'search', label: 'Search engine', short: 'Search',
      blurb: 'Found by searching, with nothing better available.' },
    { id: 'directory', label: 'Third-party directory', short: 'Directory',
      blurb: 'An aggregator such as the World Orthodox Directory or OpenStreetMap.' },
  ];

  const RANK = new Map(SOURCE_TIERS.map((t, i) => [t.id, i]));
  const TIER_IDS = SOURCE_TIERS.map((t) => t.id);

  /** Position on the ladder. An unknown or absent tier sits below every real one. */
  function tierRank(id) {
    const r = RANK.get(id);
    return r === undefined ? Number.POSITIVE_INFINITY : r;
  }

  /**
   * May `a` overwrite something `b` said?
   *
   * STRICTLY better, never equal. Two sources at the same tier disagreeing is
   * not something a rank can settle — the Greek run had a parish whose own
   * website and own Facebook page gave different times — so the later read
   * does NOT get to win by default. Same tier means the stored value stands
   * and a person decides.
   */
  function outranks(a, b) {
    return tierRank(a) < tierRank(b);
  }

  function tierLabel(id) {
    const t = SOURCE_TIERS.find((x) => x.id === id);
    return t ? t.label : 'Unsourced';
  }

  function isTier(id) {
    return RANK.has(id);
  }

  const host = (url) => {
    try {
      return new URL(String(url)).hostname.replace(/^www\./i, '').toLowerCase();
    } catch {
      return null;
    }
  };

  /**
   * Which tier a parish row's stored details came from.
   *
   * Derived rather than stored, because `parishes.info_source_type` is three
   * values — website / person / import — and the ladder is five. 281 of the
   * 293 rows in production say 'import', which is true and says nothing about
   * whether the import read the jurisdiction's own directory or an aggregator.
   * The URL already in `info_source_ref` answers that, so the derivation reads
   * it rather than asking for a migration that would have to guess the same
   * thing from a name string.
   *
   * `directory` is the jurisdiction's own directory URL, from
   * JURISDICTION_SOURCES. Pass null when there isn't one and an import
   * falls to `directory` — which is the right answer: a jurisdiction that
   * publishes no directory cannot have been the source.
   */
  function sourceTier(parish, jurisdictionDirectory) {
    if (!parish) return null;
    if (parish.info_source_type === 'person') return 'admin';
    if (parish.info_source_type === 'website') return 'parish';
    const ref = host(parish.info_source_ref);
    if (!ref) return null;
    const jd = host(jurisdictionDirectory);
    if (jd && (ref === jd || ref.endsWith(`.${jd}`))) return 'jurisdiction';
    const own = host(parish.website);
    if (own && (ref === own || own.endsWith(`.${ref}`) || ref.endsWith(`.${own}`))) return 'parish';
    return 'directory';
  }

  const api = {
    SOURCE_TIERS, TIER_IDS, tierRank, outranks, tierLabel, isTier, sourceTier,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.AGORA_SOURCE_TIERS = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
