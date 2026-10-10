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
  // What production shows, as set in /admin in October 2026. The defaults had
  // drifted from it entirely — Antiochian navy against the purple everyone
  // sees — and the lite pages, which read the table before the overrides
  // reached them, showed the stale set.
  const JURISDICTION_COLORS = {
    antiochian: '#7c3bc1',
    greek: '#0061fe',
    serbian: '#cc2234',
    russian: '#d38301',
    romanian: '#4e7a27',
    macedonian: '#b92d5d',
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

  /**
   * The same answer from an override map passed in, rather than the module's
   * own layer. For the Worker: an isolate serves many requests, and a lite page
   * must not repaint itself with colours another request set on the module.
   */
  function jurisdictionColorFrom(overrides, j) {
    const o = overrides && overrides[j];
    if (typeof o === 'string' && HEX.test(o.trim())) return o.trim();
    return JURISDICTION_COLORS[j] || JURISDICTION_COLOR_FALLBACK;
  }

  // ── The dark-mode lift ──────────────────────────────────────────────────
  //
  // Lifted out of map.js so the Worker can paint a lite page's dark variant
  // with exactly the colours the app shows in the dark. In OKLab: a colour
  // whose lightness is below FLOOR is raised to FLOOR, hue and chroma kept;
  // anything already brighter passes through. Lift only, not a flip — a flip
  // would drag bright greens and pinks into mud. OKLab rather than HSL because
  // HSL's L weighs blue and violet wrongly, so a deep purple at L=0.5 still
  // reads as dim.
  const DARK_FLOOR = 0.7;
  function srgbToLinear(c) {
    c /= 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function linearToSrgb(c) {
    const v = c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(v * 255)));
  }
  function rgbToOklab(r, g, b) {
    const lr = srgbToLinear(r), lg = srgbToLinear(g), lb = srgbToLinear(b);
    const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
    const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
    const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;
    const l_ = Math.cbrt(l), m_ = Math.cbrt(m), s_ = Math.cbrt(s);
    return [
      0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_,
      1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_,
      0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_,
    ];
  }
  function oklabToRgb(L, a, b) {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.2914855480 * b;
    const lr = l_ ** 3, lm = m_ ** 3, ls = s_ ** 3;
    return [
      linearToSrgb(+4.0767416621 * lr - 3.3077115913 * lm + 0.2309699292 * ls),
      linearToSrgb(-1.2684380046 * lr + 2.6097574011 * lm - 0.3413193965 * ls),
      linearToSrgb(-0.0041960863 * lr - 0.7034186147 * lm + 1.7076147010 * ls),
    ];
  }

  /** '#1e3a5f' → the colour the app paints for it in dark mode. */
  function liftForDark(hex) {
    if (!hex) return '#aaaaaa';
    const m = String(hex).trim().replace(/^#/, '').match(/^([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (!m) return hex;
    let s = m[1];
    if (s.length === 3) s = s.split('').map(c => c + c).join('');
    const [L, A, B] = rgbToOklab(parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16));
    if (L >= DARK_FLOOR) return '#' + s.toLowerCase();
    const toHex = v => v.toString(16).padStart(2, '0');
    return '#' + oklabToRgb(DARK_FLOOR, A, B).map(toHex).join('');
  }

  // CommonJS gets exports; a browser classic script gets globals. Never both:
  // the Worker bundles this file too (esbuild resolves the CJS branch), and a
  // module that writes to globalThis on the way past is a surprise there.
  const api = {
    JURISDICTION_COLORS, JURISDICTION_COLOR_FALLBACK, jurisdictionColor,
    setJurisdictionColors, jurisdictionColorFrom, liftForDark,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) {
    root.AGORA_JURISDICTION_COLORS = JURISDICTION_COLORS;
    root.agoraJurisdictionColor = jurisdictionColor;
    root.agoraSetJurisdictionColors = setJurisdictionColors;
    root.agoraLiftForDark = liftForDark;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
