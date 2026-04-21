const session = require('express-session');
const { google } = require('googleapis');
const { getDb } = require('./db');

const SCOPES = ['https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/userinfo.profile'];

// SQLite-backed session store — survives container restarts.
// Lazy DB access (getter) avoids circular init since getDb() triggers migrations.
class SqliteStore extends session.Store {
  get db() { return getDb(); }

  get(sid, cb) {
    try {
      const row = this.db.prepare(
        "SELECT data FROM sessions WHERE sid = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now')"
      ).get(sid);
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (e) { cb(e); }
  }

  set(sid, sess, cb) {
    try {
      const expires = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).toISOString()
        : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      this.db.prepare(
        'INSERT OR REPLACE INTO sessions (sid, data, expires_at) VALUES (?, ?, ?)'
      ).run(sid, JSON.stringify(sess), expires);
      cb(null);
    } catch (e) { cb(e); }
  }

  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb(null);
    } catch (e) { cb(e); }
  }

  touch(sid, sess, cb) {
    try {
      const expires = sess.cookie && sess.cookie.expires
        ? new Date(sess.cookie.expires).toISOString()
        : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
      this.db.prepare(
        "UPDATE sessions SET expires_at = ? WHERE sid = ?"
      ).run(expires, sid);
      cb(null);
    } catch (e) { cb(e); }
  }
}

function getOAuthClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || 'https://agora.orthodoxy.au/auth/callback';

  if (!clientId || !clientSecret) return null;

  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

function sessionMiddleware() {
  return session({
    secret: process.env.AGORA_SESSION_SECRET || 'agora-dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    store: new SqliteStore(),
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
    }
  });
}

function requireAuth(req, res, next) {
  if (!req.session.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    if (!roles.includes(req.session.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

function findOrCreateUser(email, name) {
  const db = getDb();
  let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    const result = db.prepare('INSERT INTO users (email, name) VALUES (?, ?)').run(email, name);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
  }
  return user;
}

module.exports = { getOAuthClient, sessionMiddleware, requireAuth, requireRole, findOrCreateUser, SCOPES };
