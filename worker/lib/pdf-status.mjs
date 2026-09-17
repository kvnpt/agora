// What the panel can say about a PDF parish's file, as opposed to about the
// last time an adapter read it.
//
// THE FAILURE THIS EXISTS FOR. A PDF adapter's card was built entirely out of
// `adapter_runs`: status, counts, and a coverage window computed from
// `window_to`. That is the Worker's record of its own last read, and it freezes
// the moment the adapter stops running — so an adapter that is paused, or whose
// last run failed, shows a card that is silent about a perfectly good file
// sitting in R2. On 12 September 2026 the Blacktown card said "Failed — run the
// GitHub Action"; the Action had in fact run successfully on the 13th and
// uploaded a July programme, and nothing on the card could say so, because the
// adapter had not run since to notice.
//
// So the card needs a second source: the extracted document itself. It already
// carries everything worth showing — which file was fetched, when, whether it
// is the same file as last time, and (since the coverage change) what the file
// covers. None of it was ever read back.
//
// WHY NOT FOLD IT INTO THE RUN. Because they answer different questions and can
// legitimately disagree. "The scrape last worked on Tuesday" and "the newest
// file we hold covers July" are both true, both worth knowing, and the gap
// between them is the thing to act on. Same reasoning as coverage.mjs declining
// to fold itself into `healthy`.
//
// THE TEXT IS NEVER RETURNED. R2 has no way to fetch part of a JSON document,
// so reading the metadata means pulling the whole object — a few kilobytes,
// admin-only, and worth it. But the text is the bulk of it and none of the
// panel's business, so it is dropped here rather than carried to the browser.

import { coverageState, coverageMessage } from './coverage.mjs';
import { r2KeyFor } from './pdf-sources.mjs';

/**
 * Summarise the extracted document behind one PDF adapter.
 *
 * NEVER THROWS. This decorates a list that has to render whatever happens: an
 * unbound bucket or a malformed object should cost one card its detail, not
 * turn the whole Adapters tab into a 500. Every failure comes back as
 * `{ present: false, problem }` and the card says so in words.
 *
 * @param {object|undefined} bucket  env.ASSETS_BUCKET, possibly unbound
 * @param {{key: string, sourceUrl?: string}} source  a PDF_SOURCES entry
 * @param {string} today  'YYYY-MM-DD', for coverage
 */
export async function pdfSourceStatus(bucket, source, today) {
  const key = r2KeyFor(source.key);

  if (!bucket) {
    return { present: false, key, problem: 'ASSETS_BUCKET is not bound on this deployment.' };
  }

  let object;
  try {
    object = await bucket.get(key);
  } catch (err) {
    return { present: false, key, problem: `R2 could not be read: ${err.message}` };
  }
  if (!object) {
    return {
      present: false,
      key,
      problem: 'No file has been extracted yet. Re-fetch from the parish to produce one.',
    };
  }

  let doc;
  try {
    doc = await object.json();
  } catch {
    return { present: false, key, problem: `${key} is not readable JSON.` };
  }
  if (!doc || typeof doc !== 'object') {
    return { present: false, key, problem: `${key} does not hold an extracted document.` };
  }

  // `coverage` postdates the first documents written, so a file extracted
  // before it existed has none. That is 'unknown' — the same state a run that
  // read nothing datable reports — and NOT 'expired', which would accuse a
  // parish of having stopped publishing on the strength of a missing field.
  const cover = coverageState(doc.coverage?.to || null, today);

  return {
    present: true,
    key,
    // The URL actually fetched, which with an index page is the discovered one
    // rather than the one pdf-sources.mjs remembers. Those differing is worth
    // seeing: it means the parish has moved on and the fallback is ageing.
    sourceUrl: doc.source_url || source.sourceUrl || null,
    discoveredFrom: doc.discovered_from || null,
    remembersUrl: source.sourceUrl || null,
    fetchedAt: doc.fetched_at || null,
    // Enough of the digest to compare two of them by eye, which is all the
    // panel does with it — "same file as last time" is a sameness question,
    // never an integrity one.
    sha: typeof doc.pdf_sha256 === 'string' ? doc.pdf_sha256.slice(0, 12) : null,
    bytes: Number.isFinite(doc.pdf_bytes) ? doc.pdf_bytes : null,
    extractor: doc.extractor || null,
    occurrences: Number.isFinite(doc.occurrences) ? doc.occurrences : null,
    coverage: { ...cover, message: coverageMessage(cover) },
  };
}

/**
 * Is the adapter's last read older than the file it reads?
 *
 * The specific confusion this answers. An operator looks at a red card saying
 * "run the GitHub Action", runs it, and the card does not change — because the
 * Action writes R2 and only an adapter run rewrites the card. Without this the
 * panel cannot tell that story; with it, the card can say the file is newer
 * than the reading of it and offer the button that actually helps.
 *
 * Both timestamps are ISO. Missing either means no opinion: a file with no
 * `fetched_at` predates the field, and an adapter with no run has never read
 * anything, which its own status already says more clearly than this could.
 */
export function fileIsNewerThanRun(fetchedAtIso, lastRunIso) {
  if (!fetchedAtIso || !lastRunIso) return false;
  const f = Date.parse(fetchedAtIso);
  const r = Date.parse(lastRunIso.endsWith('Z') ? lastRunIso : `${lastRunIso}Z`);
  if (!Number.isFinite(f) || !Number.isFinite(r)) return false;
  return f > r;
}
