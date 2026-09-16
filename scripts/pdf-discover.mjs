// Finding the CURRENT schedule PDF on a parish's page.
//
// WHY THIS IS NOT "GUESS THE NEXT URL". pdf-sources.mjs says at length that a
// parish's source is remembered rather than discovered, and that is still the
// rule for the file itself. Blacktown is the proof: its filenames carry the
// month, and probing the template across 2025-26 finds February, March, May and
// July 2026 and nothing else — eight of twelve months are 404s. There is no
// sequence to follow forward.
//
// What IS stable is the page that links to it. `/church-programme.html` has a
// fixed URL, shows one month at a time, and carries the current file as an
// ordinary link. So the remembered thing becomes the INDEX rather than the
// document, and the document is read off it — which is both more reliable than
// a guess and self-correcting, because the parish updating the page is exactly
// the event we want to notice.
//
// THE REMEMBERED URL DOES NOT GO AWAY. `sourceUrl` stays, and stays the
// fallback. A parish that reorganises its site should degrade to "we are still
// reading last month's file, and the log says why" rather than to nothing at
// all. Discovery failing is a notice, never an error.
//
// Nothing here fetches. The extractor does that; this takes HTML and returns a
// URL, so the link-picking is testable without the network.

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12,
};

/** Every href on a page, resolved against it. Order preserved. */
export function hrefs(html, baseUrl) {
  const out = [];
  for (const m of String(html || '').matchAll(/<a\b[^>]*\bhref=["']([^"']+)["']/gi)) {
    try { out.push(new URL(m[1], baseUrl).href); } catch { /* not a URL */ }
  }
  return out;
}

/**
 * A sortable key from whatever a pattern captured, or null if it captured
 * nothing datelike.
 *
 * Deliberately tolerant about which group is which: the pattern is written per
 * parish and there is no reason to make its author remember an order. A
 * four-digit number is the year and a month name is the month.
 */
export function periodOf(groups) {
  let year = null;
  let month = null;
  for (const g of groups || []) {
    if (g === undefined || g === null) continue;
    const s = String(g).trim().toLowerCase();
    if (/^\d{4}$/.test(s)) { year ??= Number(s); continue; }
    if (MONTHS[s] !== undefined) { month ??= MONTHS[s]; continue; }
  }
  if (year === null && month === null) return null;
  return (year ?? 0) * 12 + (month ?? 0);
}

/**
 * The PDF a page is currently offering: `{ url, reason }`, or
 * `{ url: null, reason }` saying why not.
 *
 * `reason` is always populated because this ends up in a CI log, and "no link
 * matched" and "two links matched and neither is obviously newer" want
 * different responses from whoever reads it.
 *
 * MULTIPLE MATCHES ARE REFUSED unless every one of them carries a period to
 * order by. Blacktown's page offers exactly one English programme at a time, so
 * the ambiguous case is hypothetical today — and picking arbitrarily from it is
 * how a run would silently start serving an archived month. Refusing falls back
 * to the remembered URL, which is a known-good file rather than a guess.
 */
export function discoverPdfUrl(html, { indexUrl, linkPattern } = {}) {
  if (!indexUrl || !linkPattern) return { url: null, reason: 'no index configured' };
  const re = linkPattern instanceof RegExp ? linkPattern : new RegExp(linkPattern, 'i');

  const matches = [];
  for (const href of hrefs(html, indexUrl)) {
    const m = href.match(re);
    if (m) matches.push({ url: href, period: periodOf(m.slice(1)) });
  }

  if (!matches.length) return { url: null, reason: `no link on ${indexUrl} matched ${re}` };
  if (matches.length === 1) return { url: matches[0].url, reason: 'one link matched' };

  // Several. Order them only if every one says which period it is for.
  if (matches.some((m) => m.period === null)) {
    return {
      url: null,
      reason: `${matches.length} links matched ${re} and not all carry a month to order by: `
        + matches.map((m) => m.url).join(', '),
    };
  }
  const best = matches.reduce((a, b) => (b.period > a.period ? b : a));
  // A tie means two files for the same month — the same ambiguity as above.
  if (matches.filter((m) => m.period === best.period).length > 1) {
    return {
      url: null,
      reason: `${matches.length} links matched ${re} and two are for the same month: `
        + matches.map((m) => m.url).join(', '),
    };
  }
  return { url: best.url, reason: `newest of ${matches.length} matching links` };
}
