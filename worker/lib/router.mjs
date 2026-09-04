// A ~40-line router.
//
// The plan said Hono. For ten routes with `:param` patterns and JSON responses,
// a dependency earns less than it costs — this keeps the Worker bundle free of
// third-party code, which suits a project whose frontend has no build step.
// Swap it for Hono the moment routing gets interesting (middleware chains,
// nested mounts); it is deliberately not trying to be a framework.

export class Router {
  constructor() { this.routes = []; }

  add(method, pattern, handler) {
    // '/api/events/:id' -> /^\/api\/events\/([^/]+)$/ with names ['id']
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:[A-Za-z_]+/g, (m) => {
      names.push(m.slice(1));
      return '([^/]+)';
    }).replace(/\//g, '\\/') + '$');
    this.routes.push({ method, re, names, handler });
    return this;
  }

  get(p, h) { return this.add('GET', p, h); }
  post(p, h) { return this.add('POST', p, h); }
  patch(p, h) { return this.add('PATCH', p, h); }
  delete(p, h) { return this.add('DELETE', p, h); }

  /** Returns a Response, or null when nothing matched. */
  async handle(request, env, ctx) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    let pathMatchedWrongMethod = false;

    for (const r of this.routes) {
      const m = path.match(r.re);
      if (!m) continue;
      if (r.method !== request.method) { pathMatchedWrongMethod = true; continue; }
      const params = {};
      r.names.forEach((n, i) => { params[n] = m[i + 1]; });
      return r.handler({ request, env, ctx, params, url, query: url.searchParams });
    }
    if (pathMatchedWrongMethod) return json({ error: 'Method not allowed' }, 405);
    return null;
  }
}

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** Read a JSON body, tolerating an empty one. */
export async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}
