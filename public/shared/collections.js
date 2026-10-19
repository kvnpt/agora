// The collections: slices of the parishes that filters alone can say.
//
// /en, /sun/liturgy, /greek, /in-arabic, /monasteries — each one a link, a
// card on the page's shelves, a page the Worker answers that a search engine
// may index, and a chat app's preview with a picture of its own
// (public/og/c-<id>.jpg, drawn by scripts/build-og-images.mjs; a
// jurisdiction's is its logo once /admin has one, else its card). A list of
// parishes picked by hand (/sgr+snb) is a link as well, but it is its maker's
// and nobody's collection, so it is never one of these and never indexed. Nor
// is every other mix of filters: /greek/qld/wed/evening is a fine link and an
// endless space of pages, and these are the ones somebody chose.
//
// Shared because three readers name them and have to agree: the page's
// shelves (public/next/next.js), the Worker's page for the link — its title,
// description, preview and whether it is indexed (worker/lib/lite-timetable.mjs)
// — and the sitemap. A link is a collection when it MEANS one, whatever order
// its segments come in (/liturgy/sun is /sun/liturgy), so the two are compared
// as url-state reads them, never as strings.
//
// Plain words. A title says what it is and a blurb what it holds; neither
// sells it.
//
// Same dual-mode wrapper as its neighbours.
(function (root) {
  const isCjs = typeof module === 'object' && !!module.exports;
  const urlState = isCjs ? require('./url-state.js') : (root && root.AgoraUrlState);

  const CURATED = [
    { id: 'english', path: '/en', title: 'English services', kicker: 'Language',
      blurb: 'Parishes with services in English.' },
    { id: 'sunday', path: '/sun/liturgy', title: 'Sunday Liturgy', kicker: 'Services',
      blurb: 'Every parish with a Sunday Liturgy on its timetable.' },
    { id: 'vespers', path: '/sat/evening/prayer', title: 'Saturday Vespers', kicker: 'Services',
      blurb: 'Vespers and Vigils on Saturday evenings.' },
    { id: 'weeknights', path: '/weeknights/services', title: 'Weeknight services', kicker: 'Services',
      blurb: 'Services Monday to Friday, from late afternoon.' },
    { id: 'talks', path: '/talks', title: 'Talks & Bible studies', kicker: 'Events',
      blurb: 'Talks, catechism classes and Bible studies.' },
    { id: 'socials', path: '/social', title: 'Youth & socials', kicker: 'Events',
      blurb: 'Youth groups, festivals, meals and fundraisers.' },
    { id: 'monasteries', path: '/monasteries', title: 'Monasteries', kicker: 'Places',
      blurb: 'Monasteries, convents and sketes, with their service times.' },
  ].map(c => ({ ...c, group: 'curated', image: `/og/c-${c.id}.jpg` }));

  // The languages a parish prays in besides English, by how many parishes do.
  // 'Slavonic' finds Church Slavonic (timetable.langIs reads both ways round).
  const LANGUAGES = [
    ['greek', 'Greek'], ['arabic', 'Arabic'], ['serbian', 'Serbian'], ['slavonic', 'Church Slavonic', 'Slavonic'],
    ['romanian', 'Romanian'], ['macedonian', 'Macedonian'],
  ].map(([key, title, lang = title]) => ({
    id: `lang-${key}`, group: 'language', lang, path: `/in-${key}`, title, kicker: 'Language',
    blurb: `Parishes with services in ${title}.`, image: `/og/c-lang-${key}.jpg`,
  }));

  const JURISDICTION_NAMES = {
    greek: 'Greek Orthodox', antiochian: 'Antiochian Orthodox', serbian: 'Serbian Orthodox',
    russian: 'Russian Orthodox', romanian: 'Romanian Orthodox', macedonian: 'Macedonian Orthodox',
  };
  const JURISDICTIONS = Object.entries(JURISDICTION_NAMES).map(([j, title]) => ({
    id: `j-${j}`, group: 'jurisdiction', jurisdiction: j, path: `/${j}`, title, kicker: 'Jurisdiction',
    blurb: `Every ${title} parish, with its service times.`, image: `/og/${j}.jpg`,
  }));

  const COLLECTIONS = [...CURATED, ...LANGUAGES, ...JURISDICTIONS];

  // How each is drawn on its card: its colour and what is on it. The page's
  // shelves and cards draw it, and so does the Worker's first paint of a
  // collection's card, so the two cannot differ.
  //
  // Quiet on purpose: a collection's colour is a tint behind its sign, and
  // the sign in the colour (`tint`). Only a jurisdiction's card is its colour
  // in full (`art`), because there the colour means something.
  const LOOK = {
    english: { tint: '#1d4ed8', glyph: 'En' },
    sunday: { tint: '#b45309', icon: 'L', kind: 'liturgy' },
    vespers: { tint: '#5b21b6', icon: 'P', kind: 'prayer' },
    weeknights: { tint: '#0f766e', icon: 'P', kind: 'prayer' },
    talks: { tint: '#a16207', icon: 'T', kind: 'talk' },
    socials: { tint: '#be123c', icon: 'S', kind: 'social' },
    monasteries: { tint: '#57534e', glyph: '☦' },
  };
  // A language's: its first letters in its own script, and a colour.
  const LANGUAGE_LOOK = {
    English: ['En', '#1d4ed8'],
    Greek: ['Ελ', '#0061fe'], Arabic: ['عر', '#7c3bc1'], Serbian: ['Ср', '#cc2234'], Slavonic: ['Сл', '#d38301'],
    Romanian: ['Ro', '#4e7a27'], Macedonian: ['Мк', '#b92d5d'],
  };
  /** A colour lighter (amt > 0) or darker (amt < 0), as a fraction of the way. */
  function shade(hex, amt) {
    const n = parseInt(String(hex).slice(1), 16);
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => Math.round(amt > 0 ? v + (255 - v) * amt : v * (1 + amt)));
    return '#' + ch.map(v => Math.max(0, Math.min(255, v)).toString(16).padStart(2, '0')).join('');
  }
  /**
   * A collection's look: { art } for a jurisdiction, its colour in full —
   * which /admin may have changed: `colorOf(jurisdiction)` — and for every
   * other { tint, glyph?, icon?, kind? }.
   */
  function lookOf(c, colorOf) {
    if (c.group === 'jurisdiction') {
      const j = colorOf ? colorOf(c.jurisdiction) : '#64748b';
      return { art: `radial-gradient(120% 90% at 85% 10%, ${shade(j, 0.35)}, ${j} 55%, ${shade(j, -0.4)})`, color: j };
    }
    if (c.group === 'language') {
      const [glyph, tint] = LANGUAGE_LOOK[c.lang] || [c.title.slice(0, 2), '#64748b'];
      return { glyph, tint };
    }
    return LOOK[c.id] || {};
  }
  /**
   * The style that paints a look behind a card or a card's head: a
   * jurisdiction's colour, or a tint of a collection's (next.css .soft, which
   * mixes it with the page so it reads on light and dark alike).
   */
  const lookStyle = (look) => (look && look.tint ? `--c:${look.tint}` : `background:${(look && look.art) || '#64748b'}`);

  /**
   * What a classified link means, as one string to compare, or null when it is
   * not the kind of link a collection can be: one that names parishes, an
   * event, a date or a week. /timetables is dropped — the page IS the
   * timetable — and /liturgy is read as the app reads it, the Services kind
   * with Liturgy chosen.
   */
  function meaningOf(r) {
    if (!r || (r.parishSlugs && r.parishSlugs.length) || r.eventId || r.dateFocus || r.week || r.month || r.donate) return null;
    let kind = r.kind || null, sub = r.kindSub || null, service = r.service || null;
    const asKind = service && urlState && urlState.kindOfService(service);
    if (asKind && (!kind || kind === asKind[0]) && !sub) { [kind, sub] = asKind; service = null; }
    const lang = r.lang ? `${String(r.lang).toLowerCase()}${r.langStrict ? '!' : ''}` : '';
    return [r.jurisdiction || '', r.location || '', r.monasteries ? 'm' : '', r.day != null ? r.day : '',
      r.dayGroup || '', r.part || '', service || '', kind || '', sub || '', lang].join('|');
  }

  let byMeaning = null;
  /** The collection a classified link means, or null. */
  function collectionFor(route) {
    if (!urlState) return null;
    const key = meaningOf(route);
    if (key == null) return null;
    if (!byMeaning) {
      byMeaning = new Map(COLLECTIONS.map(c => [meaningOf(urlState.classifyPath(c.path)), c]));
    }
    return byMeaning.get(key) || null;
  }

  const byId = (id) => COLLECTIONS.find(c => c.id === id) || null;

  const api = { COLLECTIONS, CURATED, LANGUAGES, JURISDICTIONS, JURISDICTION_NAMES, LANGUAGE_LOOK, meaningOf, collectionFor, byId, lookOf, lookStyle, shade };
  if (isCjs) module.exports = api;
  else if (root) root.AgoraCollections = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
