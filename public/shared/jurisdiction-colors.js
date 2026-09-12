// The jurisdiction colour table. One copy, because three had already drifted.
//
// These hexes were written out in app.js (_JURIS_RAW_COLORS), again in
// seeds/parishes.js (ANTIOCHIAN_BLUE, GREEK_BLUE) and would have been written
// a third time into the migration that paints every parish its jurisdiction's
// colour. The seed's Greek was #0d5eaf against the app's #00508f, so a seeded
// Greek parish drew one blue on its card and a different one everywhere the
// app asked the table directly — which is the whole argument for this file.
//
// It is a classic script rather than an .mjs like its neighbours here because
// its two readers cannot import: app.js is a classic script (deliberately —
// see bundle.js on why the inline onclick handlers keep it one) and
// seeds/parishes.js is CommonJS. The wrapper below serves both.
//
// WHERE A COLOUR IS ALLOWED TO BE THE PARISH'S OWN: a card, a feed line, an
// event group — anywhere the parish is the subject. The map is not one of
// those. See the note in map.js on why its dots and labels read jurisdiction
// and nothing else.
(function (root) {
  const JURISDICTION_COLORS = {
    antiochian: '#1e3a5f',
    greek: '#00508f',
    serbian: '#b22234',
    russian: '#c8a951',
    romanian: '#002b7f',
    macedonian: '#d20000',
  };

  // 'other' is in the schema's CHECK but not in the table: a jurisdiction with
  // no flag of its own gets the neutral grey rather than a colour invented for
  // it. Same answer for a value the table has never heard of.
  const JURISDICTION_COLOR_FALLBACK = '#888888';

  function jurisdictionColor(j) {
    return JURISDICTION_COLORS[j] || JURISDICTION_COLOR_FALLBACK;
  }

  const api = { JURISDICTION_COLORS, JURISDICTION_COLOR_FALLBACK, jurisdictionColor };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.AGORA_JURISDICTION_COLORS = JURISDICTION_COLORS;
    root.agoraJurisdictionColor = jurisdictionColor;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
