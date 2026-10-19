// Reading the jurisdiction logos /admin uploaded (d1/schema.sql,
// jurisdiction_logos), for the bundle, the timetable pages and /next's head.

import urlState from '../../public/shared/url-state.js';

/** The jurisdictions a logo can be for: the six with a collection. */
export const LOGO_JURISDICTIONS = new Set(urlState.JURISDICTION_KEYS);

/** Where a jurisdiction's logo is kept in R2, by extension. */
export const jurisdictionLogoKey = (j, ext) => `logos/jurisdiction-${j}.${ext}`;

// What a stored path may look like on the way out: the key above, served by
// /logos/, and its cache buster. It is painted into a src and a preview's
// og:image, so a row that is anything else is dropped rather than served.
const LOGO_PATH = /^\/logos\/jurisdiction-[a-z]+\.(png|jpg|svg|webp)(\?v=\d+)?$/;

/**
 * The logos, as { jurisdiction: path }.
 *
 * An empty object is the normal answer, and the answer while migration 027
 * has not run: the table can land before or after the deploy that reads it.
 */
export async function jurisdictionLogos(db) {
  try {
    const r = await db.prepare('SELECT jurisdiction, logo_path FROM jurisdiction_logos').all();
    return Object.fromEntries((r.results || [])
      .filter((row) => LOGO_JURISDICTIONS.has(row.jurisdiction) && LOGO_PATH.test(String(row.logo_path || '')))
      .map((row) => [row.jurisdiction, row.logo_path]));
  } catch {
    return {};
  }
}

/**
 * A logo that can stand as a link preview: not an SVG, which no chat app
 * draws. The card on the page shows any of them.
 */
export const previewLogo = (logos, j) => {
  const path = j && logos && logos[j];
  return path && !/\.svg(\?|$)/.test(path) ? path : null;
};
