// Reading the jurisdiction colour overrides, for the two routes that need them.
//
// The colours themselves live in public/shared/jurisdiction-colors.js and are
// not here: that file is the default table, read by the app, the map, the seed
// and the tests. `jurisdiction_colors` holds only what /admin deliberately
// changed, so absence is the normal state and means "the file's colour".

import jurisTable from '../../public/shared/jurisdiction-colors.js';

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

/**
 * A jurisdiction's colour as SQL: /admin's override where there is a valid
 * one, else the shared table's, else the neutral grey. `jurisdiction` is the
 * SQL expression naming it — `p.jurisdiction` in a join.
 *
 * What a query selects where it used to select `parishes.color`. A parish has
 * no colour of its own (bundle.js always painted the jurisdiction's), and the
 * stored column had gone stale under it: 49 Macedonian and Romanian parishes
 * still held the colours their jurisdictions had before /admin changed them,
 * and every reader that took the column — the lite pages, a rule joined in
 * SQL — painted those. One expression, so a row joined in the Worker carries
 * the colour the app would give it, under the name it always had.
 *
 * Built from constants, never from input: the table's keys and hexes are
 * checked here, so nothing but those reaches the string.
 */
export function jurisdictionColorSql(jurisdiction) {
  const table = jurisTable.JURISDICTION_COLORS;
  const fallback = jurisTable.JURISDICTION_COLOR_FALLBACK;
  for (const [j, c] of Object.entries(table)) {
    if (!/^[a-z]+$/.test(j) || !HEX.test(c)) throw new Error(`jurisdiction colour table: ${j} ${c}`);
  }
  if (!HEX.test(fallback)) throw new Error(`jurisdiction colour fallback: ${fallback}`);
  // HEX, in SQL: the override is painted into styles, so a row that is not a
  // colour falls through to the table here as it does in jurisdictionColorOverrides.
  // A '#', three or six characters, none of them outside 0-9a-f. Not one GLOB
  // per digit: D1 refuses a pattern over 50 bytes ("LIKE or GLOB pattern too
  // complex"), which better-sqlite3 in the tests does not.
  const valid = `(length(jcx.color) IN (4, 7) AND substr(jcx.color, 1, 1) = '#' `
    + `AND lower(substr(jcx.color, 2)) NOT GLOB '*[^0-9a-f]*')`;
  const cases = Object.entries(table).map(([j, c]) => `WHEN '${j}' THEN '${c}'`).join(' ');
  return `COALESCE((SELECT jcx.color FROM jurisdiction_colors jcx WHERE jcx.jurisdiction = ${jurisdiction} AND ${valid}), `
    + `CASE ${jurisdiction} ${cases} ELSE '${fallback}' END)`;
}

/** The colour a row joined to its parish as `p` carries, as `parish_color`. */
export const PARISH_COLOR_SQL = jurisdictionColorSql('p.jurisdiction');
