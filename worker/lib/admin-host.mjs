// Admin lives on orthodoxy.au, and only there.
//
// The zone's routes send orthodoxy.au/* AND *.orthodoxy.au/* to this Worker,
// so /admin answered on greek.orthodoxy.au, agora.orthodoxy.au and every other
// subdomain the zone's DNS names. The Access application covers
// orthodoxy.au's admin paths, and the page loaded on the others for anyone —
// the second, unprotected way in that `workers_dev = false` was set to close
// (wrangler.toml), reopened by the wildcard. The admin API still refused
// there, because requireAdmin verifies the JWT on every hostname, so this is a
// door rather than a hole; it is closed anyway, here and in Access.
//
// A redirect rather than a 404: somebody who typed a subdomain is sent to the
// one place admin works. 307, so a POST stays a POST and nothing is cached as
// permanent. Only an admin path moves — a subdomain still serves the app.

import urlState from '../../public/shared/url-state.js';

const { JURISDICTION_KEYS, classifyPath } = urlState;

export const ADMIN_HOST = 'orthodoxy.au';

/** Is this path the admin page or the admin API? */
export function isAdminPath(pathname) {
  const p = String(pathname || '').toLowerCase();
  return p === '/admin' || p === '/admin.html' || p.startsWith('/admin/')
    || p === '/api/admin' || p.startsWith('/api/admin/');
}

/**
 * The redirect to ADMIN_HOST for an admin path asked of one of its
 * subdomains, or null. Any other host — ADMIN_HOST itself, localhost under
 * `wrangler dev` — is left alone.
 */
export function adminHostRedirect(url) {
  const u = new URL(url);
  if (!u.hostname.endsWith(`.${ADMIN_HOST}`) || !isAdminPath(u.pathname)) return null;
  u.protocol = 'https:';
  u.hostname = ADMIN_HOST;
  u.port = '';
  return new Response(null, {
    status: 307,
    headers: { Location: u.toString(), 'Cache-Control': 'no-store' },
  });
}

// ── every other path on a subdomain ──
//
// greek.orthodoxy.au was the page pre-filtered to Greek parishes, read off
// the hostname in the browser. That made each subdomain a second copy of the
// site: its own origin, so a "Suggest edits" draft kept in this browser on
// greek.orthodoxy.au was not there when Access sent the reader on to
// orthodoxy.au/admin, and its own entry in a search index. A subdomain is a
// shortcut for a filter (Kevin, 20 Oct 2026), so it is sent to the filter:
// greek.orthodoxy.au/ → orthodoxy.au/greek, greek.orthodoxy.au/en →
// orthodoxy.au/greek/en. A path that names a jurisdiction of its own keeps
// it, as the hostname never overrode one. Any other subdomain (www, agora)
// and anything that is not a page (the API, a file) moves as it is.

const ADMIN_ROOT = `.${ADMIN_HOST}`;

/** Is this path the page (a link the app reads), rather than the API or a file? */
const isPagePath = (p) => !p.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(p);

/**
 * The redirect to ADMIN_HOST for anything asked of a subdomain, or null.
 * Run after adminHostRedirect, which keeps its own 307 for admin paths.
 * A page is GET or HEAD, so its move is permanent (301); anything else keeps
 * its method (308).
 */
export function subdomainRedirect(request) {
  const u = new URL(request.url);
  const host = u.hostname.toLowerCase();
  if (!host.endsWith(ADMIN_ROOT)) return null;
  const sub = host.slice(0, -ADMIN_ROOT.length);
  const page = (request.method === 'GET' || request.method === 'HEAD') && isPagePath(u.pathname);
  let path = u.pathname;
  if (page && JURISDICTION_KEYS.includes(sub)) {
    if (!classifyPath(path).jurisdiction) path = path === '/' ? `/${sub}` : `/${sub}${path}`;
  }
  const to = new URL(`https://${ADMIN_HOST}${path}${u.search}${u.hash}`);
  return new Response(null, {
    status: page ? 301 : 308,
    headers: { Location: to.toString(), 'Cache-Control': page ? 'public, max-age=86400' : 'no-store' },
  });
}
