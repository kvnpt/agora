// /next's head, for a collection's link.
//
// /next is one static page that reads its own address, so every link under it
// (/next/en, /next/greek, /next/monasteries) was the same HTML — and a chat app
// previewing one, which runs no JavaScript, saw "orthodoxy.au · next" whatever
// it was. A link that means a collection (public/shared/collections.js) now
// gets that collection's title, description and picture in the head, as its
// timetable page does at / (lite-timetable.mjs); any other link gets the page
// as it is.
//
// Still noindex: this is the prototype, and the pages a search engine is
// offered are the ones at / (the sitemap's). When /next replaces /, the page
// takes the timetable page's robots line too (timetableIndexable).
//
// PURE: its caller, serveNext in worker/index.mjs, reads the logos.

import urlState from '../../public/shared/url-state.js';
import collections from '../../public/shared/collections.js';
import { timetableHeading } from './lite-timetable.mjs';
import { previewLogo } from './juris-logos.mjs';

const BASE = '/next';
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The collection a /next path means, or null. */
export function nextCollection(pathname, { today = null } = {}) {
  const rest = pathname === BASE ? '' : pathname.startsWith(`${BASE}/`) ? pathname.slice(BASE.length) : null;
  if (rest == null) return null;
  const route = urlState.classifyPath(rest, { today });
  const c = collections.collectionFor(route);
  return c ? { collection: c, route } : null;
}

/**
 * What the head says for a collection: its heading (the timetable page's), its
 * blurb, its picture — a jurisdiction's logo once /admin has one — and its
 * address under /next.
 */
export function nextMeta({ collection, route }, { origin, logos = {} }) {
  const logo = previewLogo(logos, collection.jurisdiction);
  const image = logo || collection.image;
  return {
    title: timetableHeading({ route, loc: null, named: null }),
    description: collection.blurb,
    image: /^https?:/.test(image) ? image : `${origin}${image}`,
    // A logo is square, and previews as one; a card is wide.
    card: logo ? 'summary' : 'summary_large_image',
    url: `${origin}${BASE}${collection.path}`,
  };
}

/**
 * The page with `meta` in its head: the title and the description and preview
 * tags next.html carries, rewritten in place, and og:url added. A tag the
 * page does not have is left out rather than guessed at.
 */
export function withHead(html, meta) {
  const set = (s, attr, key, value) => s.replace(
    new RegExp(`(<meta ${attr}="${key}" content=")[^"]*(">)`), (_, a, b) => `${a}${esc(value)}${b}`);
  let out = html.replace(/<title>[^<]*<\/title>/, `<title>${esc(meta.title)} | orthodoxy.au</title>`);
  out = set(out, 'name', 'description', meta.description);
  out = set(out, 'property', 'og:title', meta.title);
  out = set(out, 'property', 'og:description', meta.description);
  out = set(out, 'property', 'og:image', meta.image);
  out = set(out, 'name', 'twitter:card', meta.card);
  return out.replace(/(<meta property="og:image"[^>]*>)/, `$1\n  <meta property="og:url" content="${esc(meta.url)}">`);
}
