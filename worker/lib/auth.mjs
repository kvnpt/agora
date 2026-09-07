// Admin authentication via Cloudflare Access.
//
// Replaces the three legs that died with the VM: a Tailscale IP allowlist, a
// Caddy forward_auth hook, and magic-link tokens delivered over WhatsApp.
//
// Access authenticates at the edge and forwards a signed JWT in
// Cf-Access-Jwt-Assertion. Presence of that header proves nothing on its own —
// anything can set a header — so the signature is verified against the team's
// published keys.
//
// FAILS CLOSED. With ACCESS_TEAM_DOMAIN or ACCESS_AUD unset, every admin
// request is refused. Phase 6 is therefore configuration, not code:
//   wrangler secret put ACCESS_TEAM_DOMAIN   # e.g. yourteam.cloudflareaccess.com
//   wrangler secret put ACCESS_AUD           # the Access application's audience tag
//
// AGORA_DEV_ADMIN=true bypasses all of this and exists only for `wrangler dev`.
// It is deliberately absent from wrangler.toml so it cannot be deployed by
// accident — pass it with `wrangler dev --var AGORA_DEV_ADMIN:true`.

import { json } from './router.mjs';

const b64urlToBytes = (s) => {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(s.length / 4) * 4, '=');
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlToJson = (s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s)));

// Access rotates keys; cache per isolate, refresh when a kid is unknown.
let _keyCache = { domain: null, at: 0, keys: new Map() };
const KEY_TTL_MS = 3600_000;

async function keyFor(teamDomain, kid) {
  const stale = _keyCache.domain !== teamDomain || Date.now() - _keyCache.at > KEY_TTL_MS;
  if (!stale && _keyCache.keys.has(kid)) return _keyCache.keys.get(kid);

  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs unavailable: ${res.status}`);
  const { keys } = await res.json();

  const map = new Map();
  for (const jwk of keys || []) {
    map.set(jwk.kid, await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    ));
  }
  _keyCache = { domain: teamDomain, at: Date.now(), keys: map };
  return map.get(kid);
}

/**
 * Verify an Access JWT. Returns the claims, or throws.
 */
export async function verifyAccessJwt(token, { teamDomain, aud }) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed token');
  const [rawHeader, rawPayload, rawSig] = parts;

  const header = b64urlToJson(rawHeader);
  if (header.alg !== 'RS256') throw new Error(`unexpected alg ${header.alg}`);

  const key = await keyFor(teamDomain, header.kid);
  if (!key) throw new Error('unknown signing key');

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    b64urlToBytes(rawSig),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`),
  );
  if (!ok) throw new Error('bad signature');

  const claims = b64urlToJson(rawPayload);
  const now = Math.floor(Date.now() / 1000);
  if (claims.exp && claims.exp < now) throw new Error('token expired');
  if (claims.nbf && claims.nbf > now) throw new Error('token not yet valid');
  if (claims.iss && claims.iss !== `https://${teamDomain}`) throw new Error('wrong issuer');

  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(aud)) throw new Error('wrong audience');

  return claims;
}

/**
 * Guard for admin routes. Returns null when allowed, or a Response to return.
 */
export async function requireAdmin({ request, env }) {
  if (env.AGORA_DEV_ADMIN === 'true') return null;

  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  if (!teamDomain || !aud) {
    return json({
      error: 'Admin auth is not configured',
      detail: 'Set ACCESS_TEAM_DOMAIN and ACCESS_AUD. Refusing rather than allowing.',
    }, 503);
  }

  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return json({ error: 'Unauthorized' }, 401);

  try {
    const claims = await verifyAccessJwt(token, { teamDomain, aud });
    return null;
  } catch (err) {
    return json({ error: 'Unauthorized', detail: err.message }, 401);
  }
}

/** The signed-in identity, for audit lines. Null when not verifiable. */
export async function adminIdentity({ request, env }) {
  if (env.AGORA_DEV_ADMIN === 'true') return 'dev';
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  try {
    const c = await verifyAccessJwt(token, { teamDomain: env.ACCESS_TEAM_DOMAIN, aud: env.ACCESS_AUD });
    return c.email || c.sub || null;
  } catch { return null; }
}
