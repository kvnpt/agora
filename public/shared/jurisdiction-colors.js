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

  // What /admin has changed, layered over the table above at runtime.
  //
  // The table stays the DEFAULT and the file stays the one place a colour is
  // written down in code — this is not a second copy of it. It is the same
  // arrangement adapter_settings has: absence means the default, and a row
  // exists only where somebody deliberately chose otherwise. The alternative
  // was a deploy per hue, which is how six colours nobody has seen side by
  // side stay unexamined for a year.
  //
  // Overrides arrive with /api/bundle, so they are applied once at load and
  // every reader — cards, map dots, chips, the parish sheet — picks them up
  // through jurisdictionColor() below without knowing they exist.
  const OVERRIDES = {};

  const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

  /**
   * Replace the override layer wholesale.
   *
   * Validated rather than trusted: these values are painted straight into
   * inline styles and a map paint expression, so a row holding "red; }" or an
   * empty string has to fall back to the default instead of reaching either.
   * A key the table has never heard of is kept — the schema's CHECK is the
   * authority on what a jurisdiction is, not this file.
   */
  function setJurisdictionColors(next) {
    for (const k of Object.keys(OVERRIDES)) delete OVERRIDES[k];
    for (const [k, v] of Object.entries(next || {})) {
      if (typeof v === 'string' && HEX.test(v.trim())) OVERRIDES[k] = v.trim();
    }
    return OVERRIDES;
  }

  function jurisdictionColor(j) {
    return OVERRIDES[j] || JURISDICTION_COLORS[j] || JURISDICTION_COLOR_FALLBACK;
  }

  // CommonJS gets exports; a browser classic script gets globals. Never both:
  // the Worker bundles this file too (esbuild resolves the CJS branch), and a
  // module that writes to globalThis on the way past is a surprise there.
  const api = {
    JURISDICTION_COLORS, JURISDICTION_COLOR_FALLBACK, jurisdictionColor,
    setJurisdictionColors,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) {
    root.AGORA_JURISDICTION_COLORS = JURISDICTION_COLORS;
    root.agoraJurisdictionColor = jurisdictionColor;
    root.agoraSetJurisdictionColors = setJurisdictionColors;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
