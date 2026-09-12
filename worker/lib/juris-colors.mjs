// Reading the jurisdiction colour overrides, for the two routes that need them.
//
// The colours themselves live in public/shared/jurisdiction-colors.js and are
// not here: that file is the default table, read by the app, the map, the seed
// and the tests. `jurisdiction_colors` holds only what /admin deliberately
// changed, so absence is the normal state and means "the file's colour".

// #rgb or #rrggbb and nothing else. Applied on the way out as well as on the
// way in, because a value that reaches the browser is painted into inline
// styles and into a MapLibre paint expression, and neither is a place to find
// out that a row says "red; }".
export const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// The schema's CHECK, as a set. Repeated here so a bad key is a 400 rather
// than a D1 constraint error surfacing as a 500; d1/juris-colors.test.mjs
// parses the CHECK out of the schema and compares, so the two cannot drift.
export const JURISDICTIONS = new Set(['antiochian', 'greek', 'serbian', 'russian',
  'romanian', 'macedonian', 'other']);

/**
 * The overrides, as { jurisdiction: hex }.
 *
 * An empty object is the normal answer. So is the answer when the table does
 * not exist: migration 006 can land before or after the deploy that reads it,
 * in either order, and the site is right either way rather than serving a 500
 * for the window in between.
 */
export async function jurisdictionColorOverrides(db) {
  try {
    const r = await db.prepare('SELECT jurisdiction, color FROM jurisdiction_colors').all();
    return Object.fromEntries((r.results || [])
      .filter((row) => HEX.test(String(row.color || '').trim()))
      .map((row) => [row.jurisdiction, String(row.color).trim()]));
  } catch {
    return {};
  }
}
