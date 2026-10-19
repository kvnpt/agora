// "Updated 3 months ago · Antiochian Archdiocese ↗": where a parish's details,
// or its service times, came from, and how long since we last read it.
//
// A recurrence rule is a claim about the future that never expires on its own
// ("Sundays 9am" looks as current the day the parish changes it as the day it
// was entered), so this line is the one thing on the page that says how old it
// is. The age is how long since WE read the source, not since the source
// changed: the weaker claim and the honest one. No date renders the name
// alone, never "unverified" (parishes.info_verified_at is a person's check,
// and nothing renders it).
//
// One line per block. A timetable's is whoever changed it last: an edit in
// /admin restamps every rule of the parish (stampTimetable in
// worker/routes/admin.mjs), so the newest stamp is the timetable's source.
//
// Shared by /next and the Worker's lite card (worker/lib/lite-page.mjs). The
// app's own copy (relativeAge, sourceLineHTML in app.js) goes when v3
// replaces it. Classic script and CommonJS, like its neighbours.
(function (root) {
  const DAY_MS = 86400000;

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** "today", "yesterday", "3 days ago", "2 months ago"; null with no date. */
  function relativeAge(iso, now = Date.now()) {
    const then = Date.parse(iso || '');
    if (!Number.isFinite(then)) return null;
    const days = Math.floor((now - then) / DAY_MS);
    if (days < 0) return 'just now';          // a source dated in the future
    if (days === 0) return 'today';
    if (days === 1) return 'yesterday';
    const [value, unit] = days < 30 ? [days, 'day']
      : days < 365 ? [Math.round(days / 30.44), 'month']
        : [Math.round(days / 365.25), 'year'];
    try {
      return new Intl.RelativeTimeFormat('en', { numeric: 'always' }).format(-value, unit);
    } catch {
      return `${value} ${unit}${value === 1 ? '' : 's'} ago`;
    }
  }

  /** The rule a timetable's line names: the newest with a source. Null if none has one. */
  function latestSource(rules) {
    let latest = null;
    for (const r of rules || []) {
      if (!r || !r.source_name) continue;
      if (!latest || String(r.source_checked_at || '') > String(latest.source_checked_at || '')) latest = r;
    }
    return latest;
  }

  /**
   * The line itself. The name is the readable half and the ref the checkable
   * half, so the name is what links, and only when the ref is a URL: a source
   * can be a person or a file, and those must not render as dead links. A
   * photo of a church sign is the one path that links, because it is ours
   * (/posters/, public/shared/signs.js). The arrow is a span painted by a CSS
   * mask, so it follows the line's colour in the dark.
   */
  function sourceLineHTML(name, ref, checked, { cls = 'source-line', now = Date.now() } = {}) {
    if (!name) return '';
    const age = relativeAge(checked, now);
    const icon = '<span class="source-link-icon" aria-hidden="true"></span>';
    const label = /^(https?:|\/posters\/)/.test(ref || '')
      ? `<a href="${esc(ref)}" target="_blank" rel="noopener nofollow">${esc(name)}${icon}</a>`
      : esc(name);
    return `<div class="${esc(cls)}">${age ? `Updated ${esc(age)} &middot; ` : ''}${label}</div>`;
  }

  /** A timetable's line, from its rules. */
  const timetableSourceHTML = (rules, opts) => {
    const r = latestSource(rules);
    return r ? sourceLineHTML(r.source_name, r.source_ref, r.source_checked_at, opts) : '';
  };

  /** A parish's details' line. */
  const detailsSourceHTML = (p, opts) =>
    (p ? sourceLineHTML(p.info_source_name, p.info_source_ref, p.info_checked_at, opts) : '');

  const api = { relativeAge, latestSource, sourceLineHTML, timetableSourceHTML, detailsSourceHTML };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AgoraSourceLine = api;
})(typeof window !== 'undefined' ? window : globalThis);
