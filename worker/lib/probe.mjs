// Requests for files a scanner hopes were published by mistake.
//
// /.env, /.git/config, /wp-login.php, /backup.sql: the most-probed paths on the
// internet, tried on every hostname a scanner learns of — and since the zone's
// wildcard routes answer every subdomain, on every one of ours. None of them
// exists here (secrets are in the Secrets Store; the Worker has no file
// system), but until this they cost a Worker run, reached the router — whose
// `/:slug/:link` route queries D1 for /.git/config — and then servePage, which
// read ".env" as a parish slug and scanned `parishes` twice, before the app
// shell went back with a 200 that a scanner logs as a hit.
//
// Answered here instead, first, with a 404 and nothing else: no D1, no assets.
// docs/roadmap.md, "Probes for /.env".

// A dotfile or dot-directory anywhere in the path — but /.well-known/ is a
// real convention (security.txt, app links) and is left alone.
const DOT_SEGMENT = (s) => s.startsWith('.');

// First segments that only ever name somebody else's software.
const FOREIGN_DIRS = new Set(['wp-admin', 'wp-content', 'wp-includes', 'cgi-bin', 'phpmyadmin', 'vendor']);

// File types nothing here serves. Not .xml (the sitemap), not images or
// .pmtiles (the R2 proxy), not .js/.css/.json (the asset router has those).
const FOREIGN_EXT = /\.(php\d?|phtml|aspx?|ashx|jsp|cgi|env|sql|bak|old|orig|save|swp|ini|ya?ml|conf|cfg|log|tar|tgz|gz|zip|rar|7z|pem|key|sh)$/i;

/** Is this path a scanner's probe rather than anything a person or the app asks for? */
export function isProbePath(pathname) {
  let path = String(pathname || '');
  try { path = decodeURIComponent(path); } catch { /* malformed escapes: judge it as written */ }
  const segs = path.split('/').filter(Boolean);
  if (!segs.length || segs[0] === '.well-known') return false;
  if (segs.some(DOT_SEGMENT)) return true;
  if (FOREIGN_DIRS.has(segs[0].toLowerCase())) return true;
  return FOREIGN_EXT.test(segs[segs.length - 1]);
}

/** The whole answer to a probe. Cacheable: the answer never changes. */
export function probeResponse() {
  return new Response('Not found', {
    status: 404,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400',
      'X-Robots-Tag': 'noindex',
    },
  });
}
