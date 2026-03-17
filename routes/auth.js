const { Router } = require('express');
const { google } = require('googleapis');
const { getOAuthClient, findOrCreateUser, SCOPES } = require('../auth');

const router = Router();

// GET /auth/login — redirect to Google OAuth
router.get('/login', (req, res) => {
  const client = getOAuthClient();
  if (!client) return res.status(503).json({ error: 'OAuth not configured' });

  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'select_account'
  });
  res.redirect(url);
});

// GET /auth/callback — handle OAuth callback
router.get('/callback', async (req, res) => {
  const client = getOAuthClient();
  if (!client) return res.status(503).json({ error: 'OAuth not configured' });

  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Missing authorization code' });

  try {
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data: profile } = await oauth2.userinfo.get();

    const user = findOrCreateUser(profile.email, profile.name);
    req.session.user = { id: user.id, email: user.email, name: user.name, role: user.role };

    res.redirect('/');
  } catch (err) {
    console.error('[auth] OAuth callback error:', err.message);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// GET /auth/me — current user info
router.get('/me', (req, res) => {
  if (!req.session.user) return res.json(null);
  res.json(req.session.user);
});

// POST /auth/logout
router.post('/logout', (req, res) => {
  req.session.destroy(() => {
    res.json({ ok: true });
  });
});

module.exports = router;
