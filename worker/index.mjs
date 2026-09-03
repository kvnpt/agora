// Worker entry point.
//
// Phase 3b placeholder: the lens and the override write-path are ported and
// tested (worker/lib/), but the routes are not yet. Phase 3c replaces this with
// the real router and the scheduled() handler for the Google Calendar adapter.
//
// It exists now so wrangler.toml resolves and `wrangler dev` can boot.

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      // Proves the D1 binding is wired, which is the only thing worth asserting
      // at this stage.
      try {
        const row = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM parishes WHERE id != '_unassigned'"
        ).first();
        return Response.json({ status: 'ok', parishes: row.n, phase: '3b' });
      } catch (err) {
        return Response.json({ status: 'error', error: err.message }, { status: 500 });
      }
    }

    return Response.json(
      { error: 'Not implemented yet — routes land in phase 3c' },
      { status: 501 },
    );
  },
};
