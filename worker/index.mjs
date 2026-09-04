// Worker entry.
//
// Replaces server.js. The static frontend is served by Pages; this handles the
// API and the few paths that genuinely need server-side logic.

import { Router, json } from './lib/router.mjs';
import { registerPublicRoutes } from './routes/public.mjs';
import { registerAdminRoutes } from './routes/admin.mjs';
import { ADAPTERS, runAdapter } from './lib/adapters.mjs';

const router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);

// GET /health — proves the D1 binding, nothing more.
router.get('/health', async ({ env }) => {
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM parishes WHERE id != '_unassigned'"
    ).first();
    return json({ status: 'ok', parishes: row.n, timestamp: new Date().toISOString() });
  } catch (err) {
    return json({ status: 'error', error: err.message }, 500);
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
    const row = await env.DB.prepare(
      `SELECT ${column} AS url FROM parishes
       WHERE id != '_unassigned' AND lower(replace(acronym, ' ', '')) = ?`
    ).bind(slug).first();
    if (row && row.url) return Response.redirect(row.url, 302);
    return null; // unknown slug or no link on file -> fall through to the SPA
  });
}

export default {
  async fetch(request, env, ctx) {
    try {
      const res = await router.handle(request, env, ctx);
      if (res) return res;
    } catch (err) {
      return json({ error: 'Internal error', detail: err.message }, 500);
    }

    // Nothing matched. An unknown /api/ path is a real 404; anything else is a
    // client route — a deep link like /102:2026-09-06 or /smg — and belongs to
    // the SPA. The asset layer's not_found_handling does not apply once the
    // Worker has been invoked, so hand it back explicitly.
    const path = new URL(request.url).pathname;
    if (path.startsWith('/api/') || path === '/health') {
      return json({ error: 'Not found' }, 404);
    }
    return env.ASSETS.fetch(request);
  },

  // Cron Trigger — replaces node-cron's in-process timer.
  //
  // node-cron kept one long-lived process with a timer per adapter; a Cron
  // Trigger invokes this instead. One adapter failing must not stop the others,
  // and the failure is already recorded in adapter_runs by runAdapter.
  async scheduled(event, env, ctx) {
    console.log(`[cron] ${event.cron} at ${new Date(event.scheduledTime).toISOString()}`);
    const results = await Promise.allSettled(
      ADAPTERS.map(a => runAdapter(a, env))
    );
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[cron] ${ADAPTERS[i].id} failed: ${r.reason?.message || r.reason}`);
      }
    });
  },
};
