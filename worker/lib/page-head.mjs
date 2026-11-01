// The page's head, for each link.
//
// v3 is one page that reads its own address (public/index.html,
// public/next/next.js): the home page, a parish (/sgr), an event (/102), a
// collection (/en, /greek), any other filter link (/greek/qld). A chat app
// previewing a link and a search engine reading one run no JavaScript, so the
// Worker writes what the link is into the page before it leaves: the title,
// the description, the canonical address, the robots line, the preview tags
// and the structured data. routes/pages.mjs reads D1 and finds the words
// (lite-page.mjs's liteMeta for a parish or an event, lite-timetable.mjs's
// timetableMeta for a filter link); this file writes them.
//
// The page marks the block it gives up: <!--page:head--> … <!--/page:head-->.
// What is between the marks is what a link gets when the Worker could not read
// it — the home page's words, noindex and no canonical — so a failure never
// tells a search engine that one link is another.
//
// PURE.

import { liteMeta, liteImage, churchJsonLd } from './lite-page.mjs';
import { timetableMeta, timetableIndexable, timetableImage } from './lite-timetable.mjs';
import { previewLogo } from './juris-logos.mjs';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const HOME_DESCRIPTION = 'Service times and events at Orthodox parishes across Australia and New Zealand — Greek, Antiochian, Serbian, Russian, Romanian and Macedonian — on one map.';

/** The home page: the site's own words, and the one page that is the site. */
export function homeMeta(origin) {
  return {
    title: 'Orthodox Services & Events', fullTitle: 'Orthodox Services & Events — orthodoxy.au',
    description: HOME_DESCRIPTION, canonical: `${origin}/`, indexable: true, ogType: 'website',
    image: `${origin}/og/default.jpg`, card: 'summary_large_image',
  };
}

/**
 * A link that is a page but none of the kinds below — a date across every
 * parish (/2026-10-25), the feed's kinds beside a filter (/greek/social),
 * /donate, or a parish or event that is not there. The home page's words,
 * kept out of the index, with no canonical to claim it is the home page.
 */
export function otherMeta(origin) {
  return { ...homeMeta(origin), canonical: null, indexable: false };
}

/**
 * A link's words found at several places across the site (/vigil,
 * /antiochian/festival; routes/pages.mjs wordsPage): the words, where they
 * were found, and the first poster among what was. Words are anybody's, an
 * endless space of pages, so never indexed and never a canonical.
 */
export function wordsMeta({ origin, phrase, places = [], titles = [], image = null }) {
  // A parish's name has a comma of its own (St George Cathedral, Redfern).
  const list = (xs) => (xs.length > 2 ? `${xs[0]} and ${xs.length - 1} more` : xs.join(' and '));
  const said = [...new Set(titles)].slice(0, 3);
  return {
    title: `“${phrase}” at ${list(places)}`,
    description: `${said.length ? `${said.join(' · ')}. ` : ''}What orthodoxy.au finds for “${phrase}”: ${places.length} places, with their times and what is coming up.`,
    canonical: null, indexable: false, ogType: 'website',
    image: image ? previewImage(/^https?:/.test(image) ? image : `${origin}${image}`, origin) : `${origin}/og/default.jpg`,
    card: 'summary_large_image',
  };
}

/**
 * A poster as a preview image: a JPEG at most 1200px wide, cut by the zone's
 * image transformations (Images → Transformations, which the page's poster
 * thumbnails use too). A poster is often a megabyte or more — a PNG straight
 * from a design app — and WhatsApp is widely reported to show no picture for
 * an image much over 300 KB (Kevin, 1 Nov 2026: Ryde's 1.4 MB Archangels
 * poster, 190 KB this way). A logo or one of the og cards is small and goes
 * as it is, and so does everything on a workers.dev Preview, which has no
 * transformations to ask.
 */
export const POSTER_PREVIEW = 'width=1200,quality=80,format=jpeg,fit=scale-down';
export function previewImage(url, origin) {
  if (!url || !origin || /\.workers\.dev$/.test(new URL(origin).hostname)) return url;
  return url.startsWith(`${origin}/posters/`) ? `${origin}/cdn-cgi/image/${POSTER_PREVIEW}${url.slice(origin.length)}` : url;
}

/** A parish or an event, from its card's model (lite-page.mjs liteModel). */
export function parishMeta(m, { indexable = true } = {}) {
  const words = liteMeta(m);
  return {
    ...words,
    canonical: m.canonical,
    indexable: indexable && m.indexable,
    ogType: m.pinned ? 'article' : 'place',
    image: previewImage(liteImage(m), m.origin),
    card: m.pinned && m.pinned.poster_path ? 'summary_large_image' : 'summary',
    jsonLd: churchJsonLd(m),
  };
}

/**
 * A filter link, from its timetable's model (lite-timetable.mjs): a
 * collection's own words and card, indexable once it lists somebody, and
 * every other mix of filters under its heading, noindex.
 */
export function timetableHeadMeta(m) {
  const words = timetableMeta(m);
  const logo = m.collection && previewLogo(m.logos, m.collection.jurisdiction);
  return {
    ...words,
    canonical: m.canonical,
    indexable: timetableIndexable(m),
    ogType: 'website',
    image: timetableImage(m),
    // A logo is square, and previews as one; a card is wide.
    card: logo ? 'summary' : 'summary_large_image',
  };
}

/** The block between the page's marks, for `meta`. */
export function headHTML(meta) {
  const title = meta.fullTitle || `${meta.title} | orthodoxy.au`;
  return [
    `<title>${esc(title)}</title>`,
    `<meta name="description" content="${esc(meta.description)}">`,
    meta.canonical ? `<link rel="canonical" href="${esc(meta.canonical)}">` : '',
    `<meta name="robots" content="${meta.indexable ? 'index,follow' : 'noindex,follow'}">`,
    '<meta property="og:site_name" content="orthodoxy.au">',
    `<meta property="og:type" content="${esc(meta.ogType || 'website')}">`,
    `<meta property="og:title" content="${esc(meta.title)}">`,
    `<meta property="og:description" content="${esc(meta.description)}">`,
    meta.canonical ? `<meta property="og:url" content="${esc(meta.canonical)}">` : '',
    `<meta property="og:image" content="${esc(meta.image)}">`,
    `<meta name="twitter:card" content="${esc(meta.card || 'summary_large_image')}">`,
    // Already escaped for a script (churchJsonLd): `<` is <.
    meta.jsonLd ? `<script type="application/ld+json">${meta.jsonLd}</script>` : '',
  ].filter(Boolean).join('\n  ');
}

const HEAD_MARKS = /<!--page:head-->[\s\S]*?<!--\/page:head-->/;
const CARD_MARK = '<!--page:card-->';

/**
 * The page with this link's head between its marks, and the card it opens
 * (lib/page-card.mjs) at its mark. A page without the marks is returned as it
 * is: the Worker's words are never guessed into a page that did not leave
 * room for them.
 */
export function withPage(html, { head = null, card = '' } = {}) {
  let out = html;
  if (head && HEAD_MARKS.test(out)) out = out.replace(HEAD_MARKS, () => `<!--page:head-->\n  ${head}\n  <!--/page:head-->`);
  if (card && out.includes(CARD_MARK)) out = out.replace(CARD_MARK, () => `${CARD_MARK}${card}`);
  return out;
}
