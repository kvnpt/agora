const { Router } = require('express');
const crypto = require('crypto');
const { getDb } = require('../db');

const router = Router();

const ADMIN_BASE = process.env.AGORA_ADMIN_URL
  ? process.env.AGORA_ADMIN_URL.replace('/admin', '')
  : 'https://orthodoxy.au';

// Tailscale CGNAT range: 100.64.0.0/10 (100.64.x.x – 100.127.x.x)
function isTailscaleIp(ip) {
  const parts = ip.split('.');
  if (parts.length < 2) return false;
  const a = parseInt(parts[0], 10);
  const b = parseInt(parts[1], 10);
  return a === 100 && b >= 64 && b <= 127;
}

// Generate a single-use 48h magic token and return the full redemption URL.
// runId is optional — included in the `next` param when set.
function generateAdminToken(phone, runId) {
  const db = getDb();
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
  db.prepare('INSERT INTO admin_magic_tokens (token, phone, expires_at) VALUES (?, ?, ?)')
    .run(token, phone, expiresAt);
  const next = runId
    ? encodeURIComponent('/admin?run=' + runId)
    : encodeURIComponent('/admin');
  return ADMIN_BASE + '/auth/magic?t=' + token + '&next=' + next;
}

// Throttle map for last_seen_at updates: sessionId → timestamp
const lastSeenUpdated = new Map();

// GET /auth/check — Caddy forward_auth target.
// Returns 200 (allow) or 401 (deny). Caddy passes all original request headers.
router.get('/auth/check', (req, res) => {
  const forwarded = req.headers['x-forwarded-for'] || '';
  const clientIp = forwarded.split(',')[0].trim();

  if (clientIp && isTailscaleIp(clientIp)) {
    return res.sendStatus(200);
  }

  const adminPhone = req.session && req.session.adminPhone;
  if (adminPhone) {
    const db = getDb();
    const row = db.prepare(
      'SELECT id, last_seen_at FROM admin_sessions WHERE session_sid = ? AND revoked = 0'
    ).get(req.sessionID);
    if (row) {
      // Throttle last_seen_at writes to once per minute per session
      const now = Date.now();
      const lastUpdate = lastSeenUpdated.get(req.sessionID) || 0;
      if (now - lastUpdate > 60000) {
        db.prepare(
          "UPDATE admin_sessions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?"
        ).run(row.id);
        lastSeenUpdated.set(req.sessionID, now);
      }
      return res.sendStatus(200);
    }
  }

  res.sendStatus(401);
});

// GET /auth/magic — token redemption. Single-use; sets session cookie on success.
router.get('/auth/magic', (req, res) => {
  const { t: token, next } = req.query;
  if (!token) return res.status(400).send('Missing token.');

  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM admin_magic_tokens WHERE token = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now') AND used_at IS NULL"
  ).get(token);

  if (!row) {
    return res.status(200).send(
      'This link has already been used or has expired. Text the bot ‘admin’ to request a new one.'
    );
  }

  db.prepare(
    "UPDATE admin_magic_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE token = ?"
  ).run(token);

  req.session.adminPhone = row.phone;
  req.session.save(err => {
    if (err) {
      console.error('[magic-auth] session save error:', err.message);
      return res.status(500).send('Session error. Please try again.');
    }
    db.prepare('INSERT INTO admin_sessions (phone, session_sid) VALUES (?, ?)').run(row.phone, req.sessionID);
    const destination = next ? decodeURIComponent(next) : '/admin';
    res.redirect(destination);
  });
});

// GET /auth/whoami — auth method detection for admin.html.
// No gate — returns "none" when unauthenticated.
router.get('/auth/whoami', (req, res) => {
  const forwarded = req.headers['x-forwarded-for'] || '';
  const clientIp = forwarded.split(',')[0].trim();
  if (clientIp && isTailscaleIp(clientIp)) {
    return res.json({ method: 'tailscale' });
  }
  const adminPhone = req.session && req.session.adminPhone;
  if (adminPhone) {
    const db = getDb();
    const row = db.prepare(
      'SELECT 1 FROM admin_sessions WHERE session_sid = ? AND revoked = 0'
    ).get(req.sessionID);
    if (row) return res.json({ method: 'phone', phone: adminPhone });
  }
  res.json({ method: 'none' });
});

// POST /auth/logout — invalidates a phone-auth session fully.
router.post('/auth/logout', (req, res) => {
  const sid = req.sessionID;
  const db = getDb();
  db.prepare('UPDATE admin_sessions SET revoked = 1 WHERE session_sid = ?').run(sid);
  db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
  req.session.destroy(() => res.json({ ok: true }));
});

module.exports = router;
module.exports.generateAdminToken = generateAdminToken;
