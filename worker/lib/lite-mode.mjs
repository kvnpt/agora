// The lite version: the page for a phone that cannot run the full one.
//
// The full page is a map and a 3,500-line script; a 2GB phone (Kevin's RUIO
// Joy, October 2026) stalls on it. The lite version is what the Worker
// already paints for a reader that runs no JavaScript — a parish's, an
// event's or a collection's card (lib/page-card.mjs) — in a shell of its own
// (public/lite.html) with no map, no app script and nothing to edit, and a
// search box the Worker answers. The home page is that search, the parishes
// nearest the reader, and the collections as links.
//
// Who gets it is a cookie, `agora_lite`: "1" lite, "0" full. A link's
// `?lite=1` or `?lite=0` sets it and sends the reader on to the link without
// it. The full page sets it to "1" itself, once, when the phone looks too weak
// for it (the check at the top of public/index.html); a choice made by hand
// ("0" included) is never second-guessed.
//
// PURE: rows and the request in, markup out.

import jurisColors from '../../public/shared/jurisdiction-colors.js';
import lines from '../../public/shared/timetable-lines.js';
import ruleFilters from '../../public/shared/timetable.js';
import collections from '../../public/shared/collections.js';
import { localDateOf } from '../../public/shared/tz.mjs';
import { parishSlug } from './lite-page.mjs';

export const COOKIE = 'agora_lite';
const YEAR = 365 * 86400;

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** "1", "0" or null: what the reader's cookie says. */
export function cookieChoice(request) {
  const m = /(?:^|;\s*)agora_lite=([01])(?:;|$)/.exec(request.headers.get('cookie') || '');
  return m ? m[1] : null;
}

/** Is this request for the lite version? */
export const wantsLite = (request) => cookieChoice(request) === '1';

/**
 * A `?lite=1` / `?lite=0` link: the cookie set, and the link without it. Null
 * for any other request.
 */
export function liteSwitch(request) {
  const url = new URL(request.url);
  const v = url.searchParams.get('lite');
  if (v !== '1' && v !== '0') return null;
  url.searchParams.delete('lite');
  return new Response(null, {
    status: 302,
    headers: {
      location: `${url.pathname}${url.search}`,
      'set-cookie': `${COOKIE}=${v}; Path=/; Max-Age=${YEAR}; SameSite=Lax; Secure`,
      'cache-control': 'no-store',
    },
  });
}

// ── what the home page and search read ───────────────────────────────────

const JURIS_SHORT = {
  greek: 'Greek', antiochian: 'Antiochian', serbian: 'Serbian', russian: 'Russian',
  romanian: 'Romanian', macedonian: 'Macedonian',
};

/**
 * Every parish, as one row of what a lite list says about it: its link, its
 * colour, its languages and whether it has times on file. Small enough to
 * keep at the edge per data version and hour (pages.mjs).
 */
export function liteIndex({ parishes, rules, overrides, now }) {
  const byParish = new Map();
  for (const r of rules) {
    if (!byParish.has(r.parish_id)) byParish.set(r.parish_id, []);
    byParish.get(r.parish_id).push(r);
  }
  return parishes.map(p => {
    const today = localDateOf(p.timezone || 'Australia/Sydney', now);
    const live = (byParish.get(p.id) || []).filter(r => lines.isLive(r, today));
    return {
      id: p.id, slug: parishSlug(p), name: p.name, full_name: p.full_name || '', acronym: p.acronym || '',
      jurisdiction: p.jurisdiction, address: p.address || '', lat: p.lat, lng: p.lng,
      color: jurisColors.jurisdictionColorFrom(overrides, p.jurisdiction),
      langs: ruleFilters.parishLangsOf(live), times: live.length > 0,
    };
  });
}

/** The page's search's spelling (next.js norm): no accents, "Saint" as "st". */
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/[’'`.]/g, '').replace(/\bsaints?\b|\bsts?\b/g, 'st')
  .replace(/[^a-z0-9Ͱ-ϿЀ-ӿ؀-ۿ]+/g, ' ').trim();
const hasWord = (hay, tok) => (' ' + hay).includes(' ' + tok);

// A language word asks which parishes hold services in it, as the page's
// search reads it (next.js LANG_WORDS): "english" never matches as text,
// since it would match every parish named in English.
const LANG_WORDS = {
  english: 'English', greek: 'Greek', arabic: 'Arabic', serbian: 'Serbian', russian: 'Church Slavonic',
  slavonic: 'Church Slavonic', romanian: 'Romanian', macedonian: 'Macedonian', ukrainian: 'Ukrainian',
};
const FILLER = new Set(['the', 'a', 'an', 'in', 'at', 'of', 'for', 'church', 'parish', 'parishes',
  'orthodox', 'and', 'near', 'me', 'nearby', 'service', 'services']);

const R = 6371;
const rad = (d) => d * Math.PI / 180;
/** Kilometres between two points, or null when either is missing. */
export function km(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return null;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * The parishes a query names: every word (but a language's) in the parish's
 * names, initials, address or jurisdiction, and a language word as the
 * services it holds. Best match first, then nearest `at`.
 */
export function searchParishes(index, q, at = null) {
  const toks = norm(q).split(' ').filter(Boolean);
  const langs = toks.filter(w => w in LANG_WORDS).map(w => LANG_WORDS[w]);
  const words = toks.filter(w => !(w in LANG_WORDS) && !FILLER.has(w));
  if (!words.length && !langs.length) return [];
  const out = [];
  for (const p of index) {
    if (langs.length && !langs.every(l => p.langs.includes(l))) continue;
    const name = norm(`${p.name} ${p.full_name}`), acr = norm(p.acronym), addr = norm(p.address);
    const all = `${name} ${acr} ${addr} ${norm(JURIS_SHORT[p.jurisdiction] || '')}`;
    if (!words.every(w => hasWord(all, w))) continue;
    const phrase = words.join(' ');
    let score = 0;
    if (phrase && acr === phrase) score += 100;
    if (phrase && name.startsWith(phrase)) score += 50;
    score += words.filter(w => hasWord(name, w)).length * 12;
    score += words.filter(w => hasWord(addr, w)).length * 6;
    if (p.times) score += 3;
    out.push({ p, score, d: km(at, p) });
  }
  return out.sort((a, b) => b.score - a.score || (a.d ?? 0) - (b.d ?? 0) || a.p.name.localeCompare(b.p.name));
}

/** The `n` parishes nearest `at`, those with times on file first among equals. */
export function nearest(index, at, n = 10) {
  if (!at) return [];
  return index.filter(p => p.lat != null)
    .map(p => ({ p, d: km(at, p) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, n);
}

/** The collections a query names, by their title or kicker. */
export function searchCollections(q) {
  const toks = norm(q).split(' ').filter(w => w && !FILLER.has(w));
  if (!toks.length) return [];
  return collections.COLLECTIONS.filter(c => toks.every(w => hasWord(norm(`${c.title} ${c.kicker || ''} ${c.lang || ''}`), w)
    || (w === 'english' && c.id === 'english'))).slice(0, 6);
}

/**
 * Where the reader is: `?near=lat,lng` from Near me, else where Cloudflare
 * places their connection (a mobile network's is often only the capital).
 */
export function readerPlace(url, cf) {
  const m = /^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(url.searchParams.get('near') || '');
  if (m) {
    const lat = Number(m[1]), lng = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return { lat, lng, label: 'you', exact: true };
  }
  if (cf && cf.latitude != null && cf.longitude != null) {
    return { lat: Number(cf.latitude), lng: Number(cf.longitude), label: cf.city || null, exact: false };
  }
  return null;
}

// ── markup ───────────────────────────────────────────────────────────────

const distText = (d) => d == null ? '' : d < 10 ? `${d.toFixed(1)} km` : `${Math.round(d)} km`;

function parishRow({ p, d }) {
  const tag = String(p.acronym || p.name || '?').slice(0, 3);
  const meta = [JURIS_SHORT[p.jurisdiction], distText(d)].filter(Boolean).join(' · ');
  return `<a class="lite-row" href="/${esc(p.slug)}">
      <span class="lite-av" style="--j:${esc(p.color)}">${esc(tag)}</span>
      <span class="lite-t"><b>${esc(p.name)}</b><small>${esc(meta)}</small>${p.address ? `<small>${esc(p.address)}</small>` : ''}<small class="lite-langs">${p.times ? esc(p.langs.join(', ') || 'Service times on file') : 'No service times on file yet'}</small></span>
    </a>`;
}

const collRow = (c) => `<a class="lite-link" href="${esc(c.path)}"><b>${esc(c.title)}</b>${c.kicker ? `<small>${esc(c.kicker)}</small>` : ''}</a>`;

/** Beyond this, the nearest parish is no answer to "near me". */
const FAR = 1000;

const NEAR_ME = '<button class="lite-near" type="button" hidden>Use my location</button>';

/** The lite home page under the search box: results for `q`, else the nearest parishes and the collections. */
export function liteHomeHTML({ index, q = '', at = null, ids = null }) {
  q = String(q || '').trim().slice(0, 100);
  // A link's words found across the site (/vigil, routes/pages.mjs
  // wordsPage): the places they were found at, nearest first.
  if (ids && ids.length) {
    const ps = ids.map(id => index.find(p => p.id === id)).filter(Boolean)
      .map(p => ({ p, d: km(at, p) })).sort((a, b) => (a.d ?? 0) - (b.d ?? 0) || a.p.name.localeCompare(b.p.name));
    return `<section class="lite-sec"><h1>“${esc(q)}”</h1><div class="lite-list">${ps.map(parishRow).join('')}</div></section>`;
  }
  if (q) {
    const ps = searchParishes(index, q, at);
    const cs = searchCollections(q);
    if (!ps.length && !cs.length) {
      return `<section class="lite-sec"><h1>Nothing for “${esc(q)}”</h1>
        <p class="lite-note">Try a suburb, a postcode, or a parish’s name or initials.</p></section>`;
    }
    return `${cs.length ? `<section class="lite-sec"><h2>Collections</h2><div class="lite-links">${cs.map(collRow).join('')}</div></section>` : ''}
      ${ps.length ? `<section class="lite-sec"><h2>Parishes <span>${ps.length}</span></h2><div class="lite-list">${ps.slice(0, 40).map(parishRow).join('')}</div>
        ${ps.length > 40 ? `<p class="lite-note">Showing the first 40. Add a suburb to narrow it.</p>` : ''}</section>` : ''}`;
  }
  // Nobody is sent 15,000 km to church: a reader placed abroad (or wrongly)
  // gets the search alone.
  const near = nearest(index, at).filter((x, i, all) => all[0].d <= FAR);
  const groups = [
    ['Collections', collections.CURATED],
    ['Languages', collections.LANGUAGES],
    ['Jurisdictions', collections.JURISDICTIONS],
  ];
  return `<section class="lite-sec">
      <h1>${near.length ? `Nearest to ${esc(at.label || 'you')}` : 'Find a parish'}</h1>
      ${near.length ? `<div class="lite-list">${near.map(parishRow).join('')}</div>` : '<p class="lite-note">Search for a suburb, a postcode, or a parish’s name.</p>'}
      ${at && at.exact ? '' : NEAR_ME}
    </section>
    ${groups.map(([title, cs]) => `<section class="lite-sec"><h2>${title}</h2><div class="lite-links">${cs.map(collRow).join('')}</div></section>`).join('')}`;
}

/**
 * The lite shell (public/lite.html) with its marks filled: the search box's
 * words, the home page's content, and the way back to the full version of
 * this same link.
 */
export function withLite(html, { q = '', main = '', path = '/' } = {}) {
  const full = `${path}${path.includes('?') ? '&' : '?'}lite=0`;
  return html
    .replace('<!--lite:q-->', () => esc(String(q || '').slice(0, 100)))
    .replace('<!--lite:main-->', () => main)
    .replace('<!--lite:full-->', () => esc(full));
}
