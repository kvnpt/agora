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
