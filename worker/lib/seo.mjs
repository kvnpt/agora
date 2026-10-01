// What a search engine is told about the site as a whole.
//
// Only the parish pages are offered for indexing, for now: 293 of them, one
// per parish at its short link. Event pages and every date, day and service
// variant are served with `noindex` (lite-page.mjs) — the variants are an
// infinite URL space, and the stored one-offs are mostly a parish calendar
// republishing its weekly services, which is not what a search result for a
// feast should be. docs/lite-pages.md keeps the rule that was tried for events
// and why it waits.

const xmlEsc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** `parishes` need id, acronym and (optionally) info_checked_at / updated_at. */
export function sitemapXml(parishes, origin) {
  const slugOf = (p) => String(p.acronym || '').trim().toLowerCase().replace(/\s+/g, '') || p.id;
  const urls = [`<url><loc>${xmlEsc(origin)}/</loc></url>`];
  for (const p of parishes) {
    if (!p || p.id === '_unassigned') continue;
    const last = [p.updated_at, p.info_checked_at].filter(Boolean).sort().pop();
    urls.push(`<url><loc>${xmlEsc(`${origin}/${encodeURIComponent(slugOf(p))}`)}</loc>`
      + (last ? `<lastmod>${xmlEsc(String(last).slice(0, 10))}</lastmod>` : '') + '</url>');
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}
