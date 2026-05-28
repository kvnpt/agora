const session = require('express-session');
const { getDb } = require('./db');

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

module.exports = { sessionMiddleware };
