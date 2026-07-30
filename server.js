const express = require('express');
const compression = require('compression');
const path = require('path');
const { getDb } = require('./db');
const { sessionMiddleware } = require('./auth');
const { seed } = require('./seeds/parishes');
const registry = require('./adapters/registry');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Caddy's X-Forwarded-Proto so req.secure = true on HTTPS requests.
// Required for express-session to send Secure cookies through a reverse proxy.
app.set('trust proxy', 1);

// gzip / brotli for any response above the default 1KB threshold.
// Largest beneficiary is /api/events (~800KB JSON → ~80–120KB on the wire).
app.use(compression());

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(sessionMiddleware());

// Static files — no-cache on JS/CSS so browsers always revalidate after deploys
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  }
}));
app.use('/logos', express.static(path.join(__dirname, 'data', 'logos')));
app.use('/posters', express.static(path.join(__dirname, 'data', 'posters')));
app.use('/tiles', express.static('/app/tiles', { maxAge: '7d', acceptRanges: true }));

// Health check
app.get('/health', (req, res) => {
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// API routes
app.use('/api/events', require('./routes/events'));
app.use('/api/schedules', require('./routes/schedules'));
app.use('/api/parishes', require('./routes/parishes'));
app.use('/api/adapters', require('./routes/adapters'));
app.use('/api/webhooks/whatsapp', require('./routes/webhook'));
app.use('/api/admin', require('./routes/admin'));
app.use('/', require('./routes/magic-auth'));

// Sentry smoke test — throws so the error lands in Sentry. Dev-only: 404s in
// production (AGORA_ENV=production) so it can't be hit on the live site.
app.get('/debug-sentry', (req, res) => {
  if ((process.env.AGORA_ENV || 'production') === 'production') {
    return res.status(404).end();
  }
  throw new Error('Sentry smoke test — agora-dev');
});

// Admin route — gated server-side; non-admin requests redirect to /
const { requireAdmin } = require('./routes/magic-auth');
app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Payment deep links — /<slug>/donate, /<slug>/raffle, /<slug>/payment,
// /<slug>/gala. A parish slug (acronym) that has the matching URL on file
// hard-redirects (302) straight to it, so a shared /smg/donate link lands on
// the parish's payment page with no SPA flash. For /donate, jurisdiction slugs
// and the bare /donate fall through to the SPA, which opens the parish-picker
// dialog (jurisdiction preselected where present); the others have no dialog,
// so an unknown slug or missing link just falls through to the SPA.
const DONATE_JURISDICTIONS = new Set(['antiochian', 'greek', 'serbian', 'russian', 'romanian', 'macedonian']);
const PAY_LINK_COLUMNS = { donate: 'donation_url', raffle: 'raffle_url', payment: 'payment_url', gala: 'gala_url' };
for (const [kind, column] of Object.entries(PAY_LINK_COLUMNS)) {
  app.get(`/:slug/${kind}`, (req, res, next) => {
    const slug = (req.params.slug || '').toLowerCase().replace(/\s+/g, '');
    if (kind === 'donate' && DONATE_JURISDICTIONS.has(slug)) return next(); // SPA dialog, juris preselected
    const db = getDb();
    const parish = db.prepare(
      `SELECT ${column} AS url FROM parishes WHERE id != '_unassigned' AND lower(replace(acronym, ' ', '')) = ?`
    ).get(slug);
    if (parish && parish.url) return res.redirect(302, parish.url);
    return next(); // unknown slug or no link on file → SPA handles it
  });
}

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Sentry error handler — must come after all routes, before app.listen.
// No-op when SENTRY_DSN_AGORA is unset (SDK initialised disabled in instrument.js).
const Sentry = require('@sentry/node');
Sentry.setupExpressErrorHandler(app);

// Startup
function start() {
  // Init DB + seed. v26: schedule occurrences are computed on read
  // (schedule-expand.js), never generated — no generateEvents() here.
  const db = getDb();
  seed();

  // Seed known senders
  const seedSender = db.prepare("INSERT OR IGNORE INTO senders (phone, name, status) VALUES (?, ?, ?)");
  seedSender.run('61493457176', 'Kevin', 'approved');
  seedSender.run('61438342238', 'Kevin (alt)', 'approved');
  seedSender.run('61466797561', null, 'approved');
  seedSender.run('61433458666', null, 'approved');

  // Discover adapters + start scheduler
  registry.discover();
  scheduler.start();

  app.listen(PORT, () => {
    console.log(`Agora running on port ${PORT}`);
  });
}

start();

module.exports = app;
