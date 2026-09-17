// Where a PDF parish's file actually is, once /admin has been allowed to say.
//
// pdf-sources.mjs remembers a URL. That URL goes stale in the most predictable
// way there is: a parish republishes under a new path — the Sunshine Coast
// sheet is a fresh URL every January, sharing no pattern with last year's — and
// following it meant a pull request and a deploy. It is the commonest
// maintenance act on a PDF parish, it needs no code review, and it was the one
// thing a sub-admin could not do.
//
// So the URL, and ONLY the URL, can be overridden from the panel. `parse`,
// `extract` and `linkPattern` stay in code: those are judgements about how to
// read a document, and a wrong one mis-reads every service silently instead of
// failing loudly.
//
// THE INVARIANT. pdf-sources.mjs is imported by the Worker and by the GitHub
// Action on purpose, so that the URL fetched and the URL believed cannot drift.
// An override only the Worker could see would break exactly that — the panel
// would show a new file, the Action would keep fetching the old one, and
// nothing would change. Which is the same "button that looks like the fix and
// is not" that this whole change set exists to remove.
//
// The fix is that the overrides are PUBLIC. /api/pdf-sources serves them, the
// Action reads them before it fetches, and the two consumers stay one source of
// truth. They are public parish PDFs, already linked from parish websites;
// there is nothing here to keep back, and five scripts in this repo already
// read production's public API the same way.

import { PDF_SOURCES } from './pdf-sources.mjs';

/**
 * The override rows, as { key: { url, updatedAt, updatedBy } }.
 *
 * An empty object is the normal answer, and so is the answer when the table
 * does not exist — the schema change can land before or after the deploy that
 * reads it, in either order, and a scrape should carry on with the file's URL
 * rather than fail for the window in between. Same reasoning as
 * jurisdictionColorOverrides().
 */
export async function pdfSourceOverrides(db) {
  if (!db) return {};
  try {
    const r = await db.prepare(
      'SELECT source_key, source_url, updated_at, updated_by FROM pdf_source_overrides'
    ).all();
    return Object.fromEntries((r.results || [])
      .filter(row => isHttpUrl(row.source_url))
      .map(row => [row.source_key, {
        url: String(row.source_url).trim(),
        updatedAt: row.updated_at || null,
        updatedBy: row.updated_by || null,
      }]));
  } catch {
    return {};
  }
}

/**
 * http(s) and nothing else.
 *
 * Applied on the way OUT as well as on the way in, because this value is
 * handed to a fetch in the Worker and to one in a GitHub Action. A `file://`
 * or a `javascript:` reaching either would be somebody else's problem to have.
 */
export function isHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try {
    const u = new URL(value.trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * One source, with its override applied.
 *
 * Returns a NEW object rather than mutating the registry entry: PDF_SOURCES is
 * module state shared across every request in an isolate, and an override
 * written into it would leak into the next request for a different deployment
 * state. It also keeps `remembersUrl` — what the file says — so the panel and
 * the extraction log can show both and a divergence is visible rather than
 * silent.
 */
export function applyOverride(source, overrides) {
  const o = overrides && overrides[source.key];
  if (!o || !isHttpUrl(o.url) || o.url === source.sourceUrl) {
    return { ...source, overridden: false, remembersUrl: source.sourceUrl };
  }
  return {
    ...source,
    sourceUrl: o.url,
    overridden: true,
    remembersUrl: source.sourceUrl,
    overrideUpdatedAt: o.updatedAt,
    overrideUpdatedBy: o.updatedBy,
  };
}

/** Every source with overrides applied — what both consumers should fetch. */
export function resolveSources(overrides, sources = PDF_SOURCES) {
  return sources.map(s => applyOverride(s, overrides));
}

/**
 * The public payload, for the extraction Action.
 *
 * Deliberately NOT the whole registry. The Action already has the file — it
 * imports pdf-sources.mjs — so all it is missing is which URLs have been
 * changed since. Sending only that keeps the file authoritative for everything
 * else and makes an unreachable endpoint degrade to "no overrides" rather than
 * to "no sources".
 */
export function publicOverridePayload(overrides) {
  return Object.entries(overrides).map(([key, o]) => ({
    key,
    source_url: o.url,
    updated_at: o.updatedAt,
  })).sort((a, b) => a.key.localeCompare(b.key));
}
