// The fail-closed guard, and the two shapes a secret arrives in.
//
// Cloudflare hands ACCESS_TEAM_DOMAIN and ACCESS_AUD over as a plain string
// (a Worker secret) or as an object you await a .get() on (a Secrets Store
// binding). The dashboard's "Add binding" list offers only the second, so both
// occur. Reading the object as a string is silently truthy: the guard would
// pass and the value would land in a URL as "[object Object]", turning a
// misconfiguration into a confusing 401 instead of a clear 503.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { requireAdmin, adminIdentity } from './auth.mjs';

const req = (headers = {}) => new Request('https://orthodoxy.au/api/admin/ping', { headers });
const store = (value) => ({ get: async () => value });

async function refusal(env, request = req()) {
  const res = await requireAdmin({ request, env });
  assert.ok(res, 'expected a Response, got null (request was allowed)');
  return { status: res.status, body: await res.json() };
}

test('both unset: refuses and names both', async () => {
  const { status, body } = await refusal({});
  assert.equal(status, 503);
  assert.match(body.detail, /ACCESS_TEAM_DOMAIN and ACCESS_AUD/);
});

test('one unset: names only the one that is missing', async () => {
  const { body } = await refusal({ ACCESS_AUD: 'aud-tag' });
  assert.match(body.detail, /ACCESS_TEAM_DOMAIN/);
  assert.doesNotMatch(body.detail, /ACCESS_AUD/);
});

test('empty string counts as unset', async () => {
  const { status } = await refusal({ ACCESS_TEAM_DOMAIN: '', ACCESS_AUD: '' });
  assert.equal(status, 503);
});

test('Secrets Store bindings are read, not stringified', async () => {
  // The regression. An object binding is truthy, so it always got past the
  // not-configured check — the damage was downstream, where the team domain
  // becomes a URL. Assert on the URL actually fetched: pre-fix it read
  // https://[object Object]/cdn-cgi/access/certs.
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const token = `${b64({ alg: 'RS256', kid: 'k1' })}.${b64({ aud: 'aud-tag' })}.sig`;

  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    seen.push(String(url));
    return new Response('{}', { status: 500 });   // stop before key import
  };
  try {
    const res = await requireAdmin({
      request: req({ 'Cf-Access-Jwt-Assertion': token }),
      env: {
        ACCESS_TEAM_DOMAIN: store('team.cloudflareaccess.com'),
        ACCESS_AUD: store('aud-tag'),
      },
    });
    assert.equal(res.status, 401);
    assert.deepEqual(seen, ['https://team.cloudflareaccess.com/cdn-cgi/access/certs']);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a Secrets Store binding resolving to empty counts as unset', async () => {
  const env = { ACCESS_TEAM_DOMAIN: store(''), ACCESS_AUD: store('aud-tag') };
  const { status, body } = await refusal(env);
  assert.equal(status, 503);
  assert.match(body.detail, /ACCESS_TEAM_DOMAIN/);
});

test('the two shapes are interchangeable', async () => {
  const env = { ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com', ACCESS_AUD: store('aud-tag') };
  const { status } = await refusal(env);
  assert.equal(status, 401);
});

test('AGORA_DEV_ADMIN bypasses everything, and only that exact string', async () => {
  assert.equal(await requireAdmin({ request: req(), env: { AGORA_DEV_ADMIN: 'true' } }), null);
  const { status } = await refusal({ AGORA_DEV_ADMIN: true });   // boolean, not 'true'
  assert.equal(status, 503);
});

// ── The signed-in identity ──
//
// Everything above stops before a signature is ever checked, because every
// case it covers is a refusal. These sign a real token with a real key and let
// verifyAccessJwt succeed, which is the only way to test what the guard leaves
// behind for the handler.

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const b64uJson = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

// A fresh kid per keypair, because _keyCache is module-level and keyed by kid
// — exactly as it is in production, where it saves a fetch per isolate. Two
// tests minting different keys under one kid would have the second verified
// against the first's key, which is the cache working, not a bug.
let kidSeq = 0;

/** A keypair, its JWKS, and a signer — the shape Access actually presents. */
async function accessKeys(kid = `k${++kidSeq}`) {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', publicKey);
  const sign = async (claims) => {
    const head = b64uJson({ alg: 'RS256', kid });
    const body = b64uJson(claims);
    const sig = await crypto.subtle.sign(
      'RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(`${head}.${body}`));
    return `${head}.${body}.${b64u(sig)}`;
  };
  return { jwks: { keys: [{ ...jwk, kid, alg: 'RS256' }] }, sign };
}

const TEAM = 'team.cloudflareaccess.com';
const AUD = 'aud-tag';
const liveClaims = (over = {}) => ({
  aud: AUD, iss: `https://${TEAM}`, email: 'deacon@example.org',
  exp: Math.floor(Date.now() / 1000) + 600, ...over,
});

/** Runs fn with fetch answering the Access certs endpoint. Counts the calls. */
async function withCerts(jwks, fn) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify(jwks), { status: 200 });
  };
  try { return await fn(calls); } finally { globalThis.fetch = real; }
}

test('a valid token is admitted, and the claims are left on the context', async () => {
  const { jwks, sign } = await accessKeys();
  const c = {
    request: req({ 'Cf-Access-Jwt-Assertion': await sign(liveClaims()) }),
    env: { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD },
  };
  await withCerts(jwks, async () => {
    assert.equal(await requireAdmin(c), null, 'a correctly signed token should be admitted');
    assert.equal(c.claims.email, 'deacon@example.org');
  });
});

test('the identity comes from the guard\'s claims, without a second verify', async () => {
  const { jwks, sign } = await accessKeys();
  const c = {
    request: req({ 'Cf-Access-Jwt-Assertion': await sign(liveClaims()) }),
    env: { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD },
  };

  // Count the RSA verify, not the certs fetch. The key cache absorbs the
  // second fetch either way, so fetches would look identical before and after
  // this change and would prove nothing; the signature check is the actual
  // cost, and it is the one adminIdentity used to pay a second time.
  let verifies = 0;
  const realVerify = crypto.subtle.verify.bind(crypto.subtle);
  crypto.subtle.verify = (...a) => { verifies++; return realVerify(...a); };
  try {
    await withCerts(jwks, async () => {
      await requireAdmin(c);
      assert.equal(verifies, 1, 'the guard should verify exactly once');
      assert.equal(await adminIdentity(c), 'deacon@example.org');
      assert.equal(verifies, 1, 'adminIdentity verified the token a second time');
    });
  } finally {
    crypto.subtle.verify = realVerify;
  }
});

test('an identity with no email falls back to the subject', async () => {
  const { jwks, sign } = await accessKeys();
  const c = {
    request: req({ 'Cf-Access-Jwt-Assertion': await sign(liveClaims({ email: undefined, sub: 'abc123' })) }),
    env: { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD },
  };
  await withCerts(jwks, async () => {
    await requireAdmin(c);
    assert.equal(await adminIdentity(c), 'abc123');
  });
});

test('dev admin has an identity too, so the header never renders empty', async () => {
  assert.equal(await adminIdentity({ request: req(), env: { AGORA_DEV_ADMIN: 'true' } }), 'dev');
});

test('an unverifiable request has no identity rather than a guessed one', async () => {
  // No claims stashed and no token: the header should say nothing, not invent
  // somebody. A token present but unreadable lands the same way.
  assert.equal(await adminIdentity({ request: req(), env: {} }), null);
  assert.equal(await adminIdentity({
    request: req({ 'Cf-Access-Jwt-Assertion': 'not.a.token' }),
    env: { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD },
  }), null);
});
