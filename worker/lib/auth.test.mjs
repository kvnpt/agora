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
import { requireAdmin } from './auth.mjs';

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
