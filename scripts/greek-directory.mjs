// Reading the Greek Archdiocese's church pages.
//
// The 135 Greek parishes were imported from this directory in September 2026
// (docs/parish-ingestion.md). This is the part of that scrape worth keeping as
// a library, because the SERVICE TIMES run has to come back to the same pages
// for a different reason.
//
// WHAT THE DIRECTORY PUBLISHES, AND WHAT IT DOES NOT. Each page is a labelled
// list — address, phone, fax, feast day, email, website, priest, deacon — and
// there is no service time on any of the 135. So this file cannot produce a
// single recurrence rule, and the times have to come from the parish's own
// site. What it CAN produce is the link to that site, which is the one field
// that decides whether the rest of the run has a source at all.
//
// The markup is a WordPress template, uniform across every page:
//
//     <li><span class='information-label'>Website</span>https://example.org</li>
//
// Labels vary in case and in whether the value is wrapped in an anchor, and
// Cloudflare rewrites every mailto into an obfuscated span — which is why
// `email` is deliberately NOT read here. A directory-imported parish already
// has its email; re-reading it through a decoder that Cloudflare can change
// under us buys nothing.

/** Strip tags and decode the entities this template actually emits. */
export function textOf(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;|&#8217;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#8211;|&#8212;/g, '-')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Every `label -> value` the church-informations list carries.
 *
 * A page repeats `Mobile`, `Email` and `Confessor` once per clergyman, so the
 * value is the FIRST occurrence: the fields this run wants (Website, Address,
 * Phone) occur once, and taking the last would silently attribute a deacon's
 * mobile to the parish.
 */
export function directoryFields(html) {
  const out = new Map();
  const re = /<li>\s*<span class=['"]information-label['"]>([^<]*)<\/span>([\s\S]*?)<\/li>/gi;
  for (const m of String(html || '').matchAll(re)) {
    const label = textOf(m[1]).toLowerCase();
    if (!label || out.has(label)) continue;
    out.set(label, textOf(m[2]));
  }
  return out;
}

/**
 * The website the directory lists for a parish, normalised, or null.
 *
 * Normalising matters because this value is compared against what is already
 * in `parishes.website` to decide whether anything changed, and the directory
 * is inconsistent about the trailing slash and the scheme. Comparing raw
 * strings would report a third of the parishes as "moved" on a re-run.
 *
 * A bare domain ("allsaints.com.au") is given https, not http: every one of
 * these resolves over TLS, and storing http would hand the app a link that
 * redirects on every click.
 */
export function directoryWebsite(html) {
  const raw = directoryFields(html).get('website');
  return normaliseUrl(raw);
}

/** 'https://host/path' with no trailing slash, or null if it is not a URL. */
export function normaliseUrl(raw) {
  let s = String(raw || '').trim();
  if (!s || /^(n\/?a|none|tba|-)$/i.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) {
    // A bare domain only. Anything without a dot is prose, not a host.
    if (!/^[\w-]+(\.[\w-]+)+(\/|$)/.test(s)) return null;
    s = `https://${s}`;
  }
  let u;
  try { u = new URL(s); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes('.')) return null;
  u.hash = '';
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol}//${u.hostname}${path}${u.search}`;
}

/** Do two URLs point at the same place, ignoring scheme, `www.` and slash? */
export function sameSite(a, b) {
  const key = (v) => {
    const n = normaliseUrl(v);
    if (!n) return null;
    try {
      const u = new URL(n);
      return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
    } catch { return null; }
  };
  const ka = key(a);
  return ka !== null && ka === key(b);
}
