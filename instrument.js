// Sentry initialisation — loaded via `node --require ./instrument.js server.js`
// so it runs BEFORE express/http are required and can auto-instrument them.
//
// If SENTRY_DSN_AGORA is unset the SDK initialises in a disabled state (no-op),
// so this is safe to ship before the DSN exists. Set the DSN in
// /srv/secrets/agora.env and restart to turn it on.
const Sentry = require('@sentry/node');

Sentry.init({
  dsn: process.env.SENTRY_DSN_AGORA,
  // prod vs dev tag, set per-container in docker-compose.yml
  environment: process.env.AGORA_ENV || 'production',
  // Crash reporting only for Phase 1 — no perf tracing yet.
  tracesSampleRate: 0,
});
