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

// GET /auth/magic — validates token only; returns auto-submitting page.
// Preview bots (WhatsApp, iMessage, etc.) fetch this URL but don't execute JS,
// so the token is NOT consumed. Real browsers auto-submit the hidden form after
// 300ms and land on POST /auth/magic which does the actual redemption.
router.get('/auth/magic', (req, res) => {
  const { t: token, next } = req.query;
  if (!token) return res.status(400).send('Missing token.');

  const db = getDb();
  const row = db.prepare(
    "SELECT 1 FROM admin_magic_tokens WHERE token = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now') AND used_at IS NULL"
  ).get(token);

  const safeToken = token.replace(/[^a-f0-9]/gi, '');
  const safeNext = next ? encodeURIComponent(decodeURIComponent(next)) : encodeURIComponent('/admin');

  if (!row) {
    return res.status(200).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link expired</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5}
.card{background:#fff;border-radius:12px;padding:2rem 2.5rem;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center;max-width:340px}
p{color:#555;margin:.5rem 0 0}</style>
</head><body><div class="card">
<p>This link has already been used or has expired.</p>
<p>Text the bot <strong>admin</strong> to request a new one.</p>
</div></body></html>`);
  }

  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Logging in…</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5}
.card{background:#fff;border-radius:12px;padding:2rem 2.5rem;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center;max-width:340px}
p{color:#555;margin:.5rem 0 0}</style>
</head><body><div class="card">
<p>Logging you in…</p>
</div>
<form id="f" method="POST" action="/auth/magic">
  <input type="hidden" name="t" value="${safeToken}">
  <input type="hidden" name="next" value="${safeNext}">
</form>
<script>setTimeout(function(){document.getElementById('f').submit();},300);</script>
</body></html>`);
});

// POST /auth/magic — actual token redemption. Sets session cookie on success.
router.post('/auth/magic', (req, res) => {
  const token = req.body && req.body.t;
  const next = req.body && req.body.next;
  if (!token) return res.status(400).send('Missing token.');

  const db = getDb();
  const row = db.prepare(
    "SELECT * FROM admin_magic_tokens WHERE token = ? AND expires_at > strftime('%Y-%m-%dT%H:%M:%SZ', 'now') AND used_at IS NULL"
  ).get(token);

  if (!row) {
    return res.status(200).send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link expired</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5}
.card{background:#fff;border-radius:12px;padding:2rem 2.5rem;box-shadow:0 2px 12px rgba(0,0,0,.08);text-align:center;max-width:340px}
p{color:#555;margin:.5rem 0 0}</style>
</head><body><div class="card">
<p>This link has already been used or has expired.</p>
<p>Text the bot <strong>admin</strong> to request a new one.</p>
</div></body></html>`);
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

// Middleware: allow only Tailscale IPs or valid phone-auth sessions.
// Unauthorized requests are redirected to / (not 401) so the user gets a
// useful page rather than a browser error screen.
function requireAdmin(req, res, next) {
  const forwarded = req.headers['x-forwarded-for'] || '';
  const clientIp = forwarded.split(',')[0].trim();
  if (clientIp && isTailscaleIp(clientIp)) return next();

  const adminPhone = req.session && req.session.adminPhone;
  if (adminPhone) {
    const db = getDb();
    const row = db.prepare(
      'SELECT 1 FROM admin_sessions WHERE session_sid = ? AND revoked = 0'
    ).get(req.sessionID);
    if (row) return next();
  }

  res.redirect('/');
}

module.exports = router;
module.exports.generateAdminToken = generateAdminToken;
module.exports.requireAdmin = requireAdmin;
