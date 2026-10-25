// The languages a service can be in: a fixed list, not free text.
//
// Every languages column (parishes, schedules, events, overrides, drafts) is a
// JSON array of these names, and nothing else. The forms pick from them
// (lang-picker.js), the Worker keeps to them on every write (`clean`), and the
// poster reader is given them as its only answers. A new language is a line
// here.
//
// `short` is what a badge on an event or timetable row says, where "Church
// Slavonic" is too long; everywhere else says `name`. `slug` is the tail of
// its link (/in-slavonic); English keeps /en. `glyph` and `tint` draw its chip
// on the page's Languages shelf.
//
// Russian is not one: the Russian parishes pray in Church Slavonic, and
// "Russian" (what the ROCOR import wrote) reads as it. So does "Slavonic".
//
// Same dual-mode wrapper as its neighbours: a classic script for the page and
// /admin, a CommonJS module for the Worker and the tests.
(function (root) {
  const LANGUAGES = [
    { name: 'English', short: 'English', slug: 'english', glyph: 'En', tint: '#1d4ed8' },
    { name: 'Greek', short: 'Greek', slug: 'greek', glyph: 'Ελ', tint: '#0061fe' },
    { name: 'Arabic', short: 'Arabic', slug: 'arabic', glyph: 'عر', tint: '#7c3bc1' },
    { name: 'Serbian', short: 'Serbian', slug: 'serbian', glyph: 'Ср', tint: '#cc2234' },
    { name: 'Church Slavonic', short: 'Slavonic', slug: 'slavonic', glyph: 'Сл', tint: '#d38301',
      aliases: ['slavonic', 'russian', 'church-slavonic', 'old church slavonic'] },
    { name: 'Romanian', short: 'Romanian', slug: 'romanian', glyph: 'Ro', tint: '#4e7a27' },
    { name: 'Macedonian', short: 'Macedonian', slug: 'macedonian', glyph: 'Мк', tint: '#b92d5d' },
    { name: 'Ukrainian', short: 'Ukrainian', slug: 'ukrainian', glyph: 'Ук', tint: '#0e7490' },
  ];
  const NAMES = LANGUAGES.map(l => l.name);

  const key = (v) => String(v == null ? '' : v).trim().toLowerCase().replace(/\s+/g, ' ');
  const BY_KEY = new Map();
  for (const l of LANGUAGES) {
    for (const k of [l.name, l.short, l.slug, ...(l.aliases || [])]) BY_KEY.set(key(k), l);
  }

  /** The language a spelling names ('slavonic', 'Russian', 'greek'), or null. */
  const find = (v) => BY_KEY.get(key(v)) || BY_KEY.get(key(v).replace(/-/g, ' ')) || null;
  /** Its name as stored: 'russian' → 'Church Slavonic'; null for one not on the list. */
  const canonical = (v) => (find(v) || {}).name || null;
  /** What a row's badge says: 'Church Slavonic' → 'Slavonic'. Anything else as it is. */
  const shortOf = (v) => (find(v) || {}).short || String(v == null ? '' : v);

  /** A languages value in any shape: an array, a JSON array, or "Greek, English". */
  function listOf(v) {
    if (Array.isArray(v)) return v;
    if (v == null) return [];
    const s = String(v).trim();
    if (!s) return [];
    if (s[0] === '[') {
      try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; }
    }
    return s.split(',');
  }

  /**
   * The names on the list, in the order given, each once; anything not a
   * language dropped. ["greek", "Russian", "French"] → ["Greek", "Church Slavonic"].
   */
  function names(v) {
    const out = [];
    for (const x of listOf(v)) {
      const n = canonical(x);
      if (n && !out.includes(n)) out.push(n);
    }
    return out;
  }

  /** A languages column to write: the JSON array of `names`, or null for none. */
  function clean(v) {
    const n = names(v);
    return n.length ? JSON.stringify(n) : null;
  }

  const api = { LANGUAGES, NAMES, find, canonical, shortOf, names, clean };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.AgoraLanguages = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
