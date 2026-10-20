// Worker entry.
//
// Replaces server.js. The frontend ships with this Worker as static assets
// (see [assets] in wrangler.toml) and is served without invoking it; what runs
// here is the API, the payment redirects, the R2 asset proxy, and the page at
// every link, with that link's head (routes/pages.mjs).

import { Router, json } from './lib/router.mjs';
import { registerPublicRoutes } from './routes/public.mjs';
import { registerAdminRoutes } from './routes/admin.mjs';
import { registerAssetRoutes } from './routes/assets.mjs';
import { ADAPTERS, runAdapter, adapterPacing, isDue } from './lib/adapters.mjs';
import { bumpVersion, isDataWrite } from './lib/data-version.mjs';
import { servePage } from './routes/pages.mjs';
import { isProbePath, probeResponse } from './lib/probe.mjs';
import { adminHostRedirect, subdomainRedirect } from './lib/admin-host.mjs';
import slugs from '../public/shared/slugs.js';

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);
registerAssetRoutes(router);

// GET /health — proves the D1 binding, nothing more.
router.get('/health', async ({ env }) => {
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM parishes WHERE id != '_unassigned'"
    ).first();
    return json({ status: 'ok', parishes: row.n, timestamp: new Date().toISOString() });
  } catch (err) {
    // Public, like every 500 here: what failed goes to the log, not the reply.
    console.error('[health]', err && err.stack || err);
    return json({ status: 'error' }, 500);
  }
});

// Payment deep links: /<slug>/donate|raffle|payment|gala.
//
// One of the few things that cannot move to the client — it is a DB lookup and
// a 302, and the whole point is that a shared /smg/donate link lands on the
// parish's payment page with no SPA flash in between.
const PAY_LINK_COLUMNS = {
  donate: 'donation_url', raffle: 'raffle_url', payment: 'payment_url', gala: 'gala_url',
};
// For /donate only, a jurisdiction slug falls through to the SPA, which opens
// the parish picker with that jurisdiction preselected.
const DONATE_JURISDICTIONS = new Set([
  'antiochian', 'greek', 'serbian', 'russian', 'romanian', 'macedonian',
]);

for (const [kind, column] of Object.entries(PAY_LINK_COLUMNS)) {
  router.get(`/:slug/${kind}`, async ({ env, params }) => {
    const slug = (params.slug || '').toLowerCase().replace(/\s+/g, '');
    if (kind === 'donate' && DONATE_JURISDICTIONS.has(slug)) return null; // SPA handles it
    if (slugs.reservedSlugReason(slug)) return null; // /greek/raffle: no parish can be called that
    const row = await env.DB.prepare(
      `SELECT ${column} AS url FROM parishes
       WHERE id != '_unassigned' AND lower(replace(acronym, ' ', '')) = ?`
    ).bind(slug).first();
    if (row && row.url) return Response.redirect(row.url, 302);
    return null; // unknown slug or no link on file -> fall through to the SPA
  });
}

// The same thing for a parish's OWN links (parish_links) — a festival, a
// building fund, anything the four columns above do not name.
//
// Registered after them, so a parish that somehow has a `donate` row cannot
// shadow the column. It answers only when BOTH halves resolve to a real row,
// which is what makes a catch-all two-segment route safe here: /smg/liturgy,
// /greek/queensland and /wed/liturgy are all client routes of exactly this
// shape, and every one of them falls through untouched. The slug is refused at
// save time if it spells one of those (reservedSlugReason), so the two cannot
// come to mean different things.
router.get('/:slug/:link', async ({ env, params }) => {
  const slug = (params.slug || '').toLowerCase().replace(/\s+/g, '');
  const link = (params.link || '').toLowerCase().replace(/\s+/g, '');
  if (!slug || !link) return null;
  // /greek/qld, /sgr/evening, /liturgy/sun: a filter, which no acronym or link
  // slug can spell (both are refused at save time), so D1 has nothing to find.
  // Without this every two-segment path a crawler walks costs a parish scan.
  if (slugs.reservedSlugReason(slug) || slugs.reservedSlugReason(link)) return null;
  const row = await env.DB.prepare(
    `SELECT l.url FROM parish_links l JOIN parishes p ON p.id = l.parish_id
     WHERE p.id != '_unassigned' AND lower(replace(p.acronym, ' ', '')) = ? AND l.slug = ?`
  ).bind(slug, link).first().catch(() => null);   // table may predate migration 008
  return row && row.url ? Response.redirect(row.url, 302) : null;
});

/**
 * /next was the next version while it was a prototype, and is now the page at
 * every address: /next/sgr is /sgr, for good. A file under it (/next/next.js)
 * is the page's own and never reaches here (run_worker_first), and is never
 * moved if it does.
 */
export function nextRedirect(request) {
  const url = new URL(request.url);
  if (url.pathname !== '/next' && !url.pathname.startsWith('/next/')) return null;
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  if (/\.[a-z0-9]+$/i.test(url.pathname)) return null;
  const rest = url.pathname.slice('/next'.length).replace(/^\/+/, '');
  return new Response(null, {
    status: 301,
    headers: { location: `/${rest}${url.search}`, 'cache-control': 'public, max-age=86400' },
  });
}

export default {
  async fetch(request, env, ctx) {
    // /.env, /.git/config, /wp-login.php: a scanner's, answered before the
    // router or a page can spend a D1 read on it (lib/probe.mjs).
    if (isProbePath(new URL(request.url).pathname)) return probeResponse();
    // /admin on greek.orthodoxy.au: sent to orthodoxy.au, the one host Access
    // guards it on (lib/admin-host.mjs).
    const toAdminHost = adminHostRedirect(request.url);
    if (toAdminHost) return toAdminHost;
    // Everything else on greek.orthodoxy.au: orthodoxy.au/greek (the same file).
    const toApex = subdomainRedirect(request);
    if (toApex) return toApex;
    // /next/greek/en, from when v3 was a prototype under /next: /greek/en.
    const fromNext = nextRedirect(request);
    if (fromNext) return fromNext;
    try {
      const res = await router.handle(request, env, ctx);
      // A write that landed moves the data version, so the next /api/bundle
      // anybody asks for — the admin's own first, on this same location — is
      // rebuilt rather than served from a cache holding the old answer. Before
      // returning, not after: the redirect back to the app can beat a
      // waitUntil. A failed bump must not fail a write that succeeded.
      if (res && isDataWrite(request, res)) {
        await bumpVersion(env, new URL(request.url).origin)
          .catch(err => console.error(`[data-version] bump failed: ${err.message}`));
      }
      if (res) return res;
    } catch (err) {
      // The detail goes to the log, not the response: an uncaught error can be
      // a D1 message naming a table or a column, and this answers anybody.
      console.error(`[${request.method} ${new URL(request.url).pathname}]`, err && err.stack || err);
      return json({ error: 'Internal error' }, 500);
    }

    // Nothing matched. An unknown /api/ path is a real 404; anything else is a
    // page — a deep link like /102:2026-09-06 or /smg — or a file. The asset
    // layer's not_found_handling does not apply once the Worker has been
    // invoked, so a file is handed back explicitly.
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/') || path === '/health') {
      return json({ error: 'Not found' }, 404);
    }
    // A page is v3 with this link's head (routes/pages.mjs); a file, and any
    // failure, is the asset layer's.
    const page = await servePage(request, env, ctx).catch(() => null);
    if (page) return page;
    return env.ASSETS.fetch(request);
  },

  // Cron Trigger — replaces node-cron's in-process timer.
  //
  // node-cron kept one long-lived process with a timer per adapter; a Cron
  // Trigger invokes this instead. One adapter failing must not stop the others,
  // and the failure is already recorded in adapter_runs by runAdapter.
  async scheduled(event, env, ctx) {
    console.log(`[cron] ${event.cron} at ${new Date(event.scheduledTime).toISOString()}`);

    // The trigger fires hourly; adapter_settings decides what that means. A
    // Cron Trigger is fixed at deploy time, so this is the only place pacing
    // can live if the admin panel is to change it without a deploy.
    const pacing = await adapterPacing(env.DB);
    const now = event.scheduledTime || Date.now();
    const due = [];
    for (const a of ADAPTERS) {
      const verdict = isDue(pacing.setting(a.id), pacing.lastSuccess(a.id), now);
      if (verdict.due) due.push(a);
      else console.log(`[cron] ${a.id} skipped: ${verdict.why}`);
    }
    if (!due.length) return;

    const results = await Promise.allSettled(due.map(a => runAdapter(a, env)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[cron] ${due[i].id} failed: ${r.reason?.message || r.reason}`);
      }
    });

    // A scrape writes events and tombstones, so it moves the data version like
    // an admin write does. There is no request here, so no origin: the R2
    // object moves and every location picks it up within VERSION_TTL.
    await bumpVersion(env, null)
      .catch(err => console.error(`[data-version] bump failed: ${err.message}`));
  },
};
