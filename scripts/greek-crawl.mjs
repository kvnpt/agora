// Finding the page a parish publishes its service times on.
//
// The Antiochian run had one template across 24 parishes. This one has a
// hundred-odd independent sites — WordPress, Wix, Squarespace, one Blogspot —
// with nothing in common but the language. So there is no parser that reads
// "the schedule"; there is a crawl that finds the page most likely to carry
// one, and a human-reviewed extraction afterwards.
//
// WHAT THIS FILE IS FOR. Ranking. Given a homepage and its links, say which
// two or three pages are worth fetching. Getting that wrong is not fatal — it
// costs a fetch — but getting it *systematically* wrong is, because a parish
// whose times live on a page we never fetched is indistinguishable from a
// parish that publishes none, and the second is reported as a real finding.
//
// THE WORDS THAT MATTER. Australian Greek parishes name this page in a small
// and stable vocabulary, and about a third of them name it in Greek. Both sets
// are here. `programma`/`πρόγραμμα` is the highest-signal word on these sites
// and the one an English-only list would miss on a quarter of them.

/** Link text or href that suggests a page of service times, best first. */
const PAGE_HINTS = [
  [/\b(?:service|liturgic(?:al)?|church|divine|weekly|holy|our)[-\s_]*(?:time|hour|schedule|program(?:me)?|calendar)s?\b/i, 100],
  [/\bπρόγραμμα\b|\bprogramma\b/i, 95],
  [/\b(?:ακολουθ|akolouth)/i, 90],
  [/\bservices?\b/i, 80],
  [/\bworship\b/i, 78],
  [/\bschedule\b|\btimetable\b/i, 76],
  [/\bservice[-\s_]*times?\b/i, 95],
  [/\bdivine[-\s_]*liturg/i, 70],
  [/\bλειτουργ/i, 68],
  [/\bcalendars?\b|\bημερολ/i, 60],
  // Plural matters: the page Coburg publishes its whole timetable on is called
  // "Our Programs", and `\bprogram\b` does not match "Programs".
  [/\bprogram(?:me)?s?\b/i, 58],
  [/\bwhat'?s[-\s_]*on\b/i, 52],
  [/\bparish[-\s_]*life\b/i, 40],
  [/\bweekly[-\s_]*bulletin\b|\bnewsletter\b/i, 30],
];

// Pages that use the vocabulary and are never a timetable. A wedding or a
// funeral page says "service" constantly; a shop says "calendar" because it
// sells one. Scored out rather than filtered so an unlucky URL that also
// matches a strong hint can still win.
const PAGE_PENALTIES = [
  // Heavier than it looks like it needs to be, and deliberately: a sacraments
  // page scores 80 on the word "services" alone, so the penalty has to outweigh
  // that outright. "Wedding Services" is never a timetable.
  [/\b(?:wedding|baptism|funeral|memorial|marriage|christening)s?\b/i, -90],
  [/\b(?:shop|store|cart|checkout|product|donate|donation|payment|book(?:shop|store))\b/i, -80],
  [/\b(?:privacy|terms|cookie|sitemap|login|admin|wp-|feed|rss)\b/i, -120],
  [/\b(?:history|about|contact|gallery|photo|news|media|hall[-\s_]*hire)\b/i, -35],
  [/\b(?:school|youth[-\s_]*group|philoptochos|dance|festival|fete)\b/i, -30],
  [/\.(?:jpg|jpeg|png|gif|svg|zip|mp3|mp4|docx?|xlsx?)(?:$|\?)/i, -200],
];

// A percent-escape a parish's CMS wrote badly is not a reason to stop reading
// the site. Greek slugs arrive percent-encoded and one of these hosts emits a
// stray `%` in a query string, which throws rather than returning the string.
const decodePath = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

/** How promising a link is as the parish's timetable page. Higher is better. */
export function scoreLink(href, text) {
  const hay = `${String(text || '')} ${decodePath(String(href || ''))}`;
  let score = 0;
  let matched = false;
  for (const [re, pts] of PAGE_HINTS) {
    if (re.test(hay)) { score = Math.max(score, pts); matched = true; }
  }
  if (!matched) return 0;
  for (const [re, pts] of PAGE_PENALTIES) if (re.test(hay)) score += pts;
  return score;
}

/** Every `{ href, text }` an HTML page links to. */
export function links(html) {
  const out = [];
  const re = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of String(html || '').matchAll(re)) {
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    out.push({ href: m[1].trim(), text });
  }
  return out;
}

/**
 * The best internal pages to try, best first.
 *
 * Same-origin only. An off-site link scoring well is usually the parish's
 * Facebook page, and a Facebook page is not a source we can read or re-read.
 */
export function candidatePages(html, baseUrl, limit = 4) {
  let base;
  try { base = new URL(baseUrl); } catch { return []; }
  const seen = new Map();
  for (const { href, text } of links(html)) {
    if (/^(?:mailto:|tel:|javascript:|#)/i.test(href)) continue;
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    u.hash = '';
    const key = `${u.origin}${u.pathname.replace(/\/+$/, '')}${u.search}`;
    if (key === `${base.origin}${base.pathname.replace(/\/+$/, '')}`) continue;
    const score = scoreLink(u.pathname + u.search, text);
    if (score <= 0) continue;
    if (!seen.has(key) || seen.get(key).score < score) seen.set(key, { url: key, text, score });
  }
  return [...seen.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * Paths worth trying even when nothing links to them.
 *
 * Ranking links finds the timetable when the parish links to it from the
 * homepage, and a surprising number do not: St Nicholas Marrickville publishes
 * at `/general/serviceschedule.html`, reachable only from a submenu that is
 * built by script and therefore absent from the HTML the crawl reads. A page
 * that exists and is never linked is indistinguishable, to a link crawler, from
 * a parish that publishes nothing — and this run REPORTS "publishes nothing" as
 * a finding, so that confusion would be a false claim rather than a gap.
 *
 * Cheap enough to be worth it: one conditional GET each, cached forever.
 */
export const WELL_KNOWN_PATHS = [
  '/services', '/service-times', '/servicetimes', '/church-services',
  '/divine-services', '/our-services', '/worship', '/schedule',
  '/service-schedule', '/programme', '/program', '/weekly-program',
  '/church-program', '/liturgical-program', '/parish-life',
  '/general/serviceschedule.html',
];

// ── reading a page as text ──────────────────────────────────────────────────

/**
 * A page's visible text, one logical line per line.
 *
 * Block boundaries become newlines and inline tags become spaces, which is the
 * distinction that decides whether "Sunday" and "9:00am" end up on one line or
 * two — and a time separated from its day by a stray newline is a time this run
 * cannot use. `<br>` is a line break; `<span>` and `<strong>` are not.
 */
export function pageText(html) {
  let h = String(html || '');
  h = h.replace(/<(script|style|noscript|svg|head)\b[\s\S]*?<\/\1>/gi, ' ');
  h = h.replace(/<!--[\s\S]*?-->/g, ' ');
  h = h.replace(/<br\s*\/?>/gi, '\n');
  h = h.replace(/<\/(p|div|li|tr|h[1-6]|td|th|section|article|figcaption|blockquote)>/gi, '\n');
  h = h.replace(/<(p|div|li|tr|h[1-6]|section|article|table|blockquote)\b[^>]*>/gi, '\n');
  h = h.replace(/<td\b[^>]*>|<th\b[^>]*>/gi, ' \t');
  h = h.replace(/<[^>]+>/g, ' ');
  h = decodeEntities(h);
  return h.split('\n')
    .map((s) => s.replace(/[ \t ]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

// Named entities these sites emit. The accented Latin ones are here because a
// parish's page is as likely to write "Café" as "Caf&eacute;", and a stray
// "&eacute;" left undecoded in the middle of a line is the kind of thing that
// makes a quoted sentence in greek-service-times.mjs not match its own page.
const NAMED = {
  nbsp: ' ', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', ndash: '-', mdash: '-',
  rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', hellip: '…', middot: '·', bull: '·', deg: '°',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à', aacute: 'á', acirc: 'â', auml: 'ä',
  iacute: 'í', icirc: 'î', oacute: 'ó', ocirc: 'ô', ouml: 'ö', uacute: 'ú', uuml: 'ü',
  ccedil: 'ç', ntilde: 'ñ', szlig: 'ß', aring: 'å', oslash: 'ø', ae: 'æ',
  laquo: '«', raquo: '»', sbquo: '‚', dagger: '†', permil: '‰', euro: '€', pound: '£',
  copy: '©', reg: '®', trade: '™', times: '×', frac12: '½', frac14: '¼', prime: '′',
};

/** The entities these sites actually emit, plus numeric ones. */
export function decodeEntities(s) {
  return String(s || '')
    .replace(/&([a-z][a-z0-9]{1,8});/gi, (whole, n) => {
      const hit = NAMED[n.toLowerCase()];
      return hit === undefined ? whole : hit;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(Number(d)));
}

const safeChar = (code) => {
  if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) return ' ';
  const ch = String.fromCodePoint(code);
  return ch === ' ' ? ' ' : ch;
};

// A clock time in any form these sites write one. Used only to decide whether a
// page is worth a person's attention — the real parse is greek-schedules.mjs.
export const TIME_RE = /\b\d{1,2}\s*[:.]\s*\d{2}\s*(?:a\.?m\.?|p\.?m\.?|π\.?μ\.?|μ\.?μ\.?)?|\b\d{1,2}\s*(?:am|pm)\b/i;

const DAY_RE = /\b(sun|mon|tues?|wed(?:nes)?|thur?s?|fri|satur?)day\b|\bκυριακ|\bδευτέρ|\bτρίτ|\bτετάρτ|\bπέμπτ|\bπαρασκευ|\bσάββατ/i;

/**
 * How much this page looks like a timetable: lines that carry BOTH a weekday
 * and a clock time, which is the minimum a rule needs.
 *
 * Counted over a two-line window, because the commonest layout on these sites
 * is a weekday heading with its times underneath.
 */
export function timetableScore(text) {
  const lines = String(text || '').split('\n');
  let hits = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const window = `${lines[i]} ${lines[i + 1] || ''}`;
    if (DAY_RE.test(window) && TIME_RE.test(window)) hits += 1;
  }
  return hits;
}
