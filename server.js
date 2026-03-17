const express = require('express');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { getDb } = require('./db');
const { sessionMiddleware } = require('./auth');
const { seed } = require('./seeds/parishes');
const registry = require('./adapters/registry');
const scheduler = require('./scheduler');

const app = express();
const PORT = process.env.PORT || 3000;

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

// Static files
app.use(express.static(path.join(__dirname, 'public')));

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
app.use('/api/parishes', require('./routes/parishes'));
app.use('/api/adapters', require('./routes/adapters'));
app.use('/api/submissions', writeLimiter, require('./routes/submissions'));
app.use('/auth', require('./routes/auth'));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Startup
function start() {
  // Init DB + seed
  getDb();
  seed();

  // Discover adapters + start scheduler
  registry.discover();
  scheduler.start();

  app.listen(PORT, () => {
    console.log(`Agora running on port ${PORT}`);
  });
}

start();

module.exports = app;
