const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { getDb } = require('./db');
const { sessionMiddleware } = require('./auth');
const { seed } = require('./seeds/parishes');
const { generateEvents } = require('./schedule-generator');
const registry = require('./adapters/registry');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Caddy's X-Forwarded-Proto so req.secure = true on HTTPS requests.
// Required for express-session to send Secure cookies through a reverse proxy.
app.set('trust proxy', 1);

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(sessionMiddleware());

// Rate limiting on write endpoints
const writeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Too many requests, please try again later' }
});

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
app.use('/api/submissions', writeLimiter, require('./routes/submissions'));
app.use('/api/webhooks/whatsapp', require('./routes/webhook'));
app.use('/api/admin', require('./routes/admin'));
app.use('/', require('./routes/magic-auth'));
app.use('/auth', require('./routes/auth'));

// Admin route
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Startup
function start() {
  // Init DB + seed + generate schedule events
  const db = getDb();
  seed();
  generateEvents();

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
