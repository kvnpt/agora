// Admin answers on orthodoxy.au only; a subdomain sends it there. And an
// uncaught error answers the public with "Internal error" and nothing more.
// Through the Worker's own fetch, with bindings that fail the test if touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.mjs';
import { isAdminPath, adminHostRedirect, subdomainRedirect } from './admin-host.mjs';

const untouched = (what) => new Proxy({}, { get: () => () => { throw new Error(`${what} was touched`); } });
const ctx = { waitUntil() {} };

test('the admin page and API are admin paths; nothing else is', () => {
  for (const p of ['/admin', '/admin.html', '/ADMIN', '/admin/', '/api/admin', '/api/admin/ping', '/api/admin/events/12']) {
    assert.equal(isAdminPath(p), true, p);
  }
  for (const p of ['/', '/administration', '/admins', '/api/bundle', '/api/administer', '/sgr', '/sgr/admin', '/posters/admin.jpg']) {
    assert.equal(isAdminPath(p), false, p);
  }
});

test('an admin path on a subdomain is sent to orthodoxy.au, path and query kept', async () => {
  const env = { DB: untouched('D1'), ASSETS: untouched('ASSETS'), ASSETS_BUCKET: untouched('R2') };
  for (const [from, to] of [
    ['https://greek.orthodoxy.au/admin', 'https://orthodoxy.au/admin'],
    ['https://agora.orthodoxy.au/admin.html', 'https://orthodoxy.au/admin.html'],
    ['https://russian.orthodoxy.au/api/admin/ping', 'https://orthodoxy.au/api/admin/ping'],
    ['https://a.b.orthodoxy.au/admin?tab=people', 'https://orthodoxy.au/admin?tab=people'],
  ]) {
    const res = await worker.fetch(new Request(from), env, ctx);
    assert.equal(res.status, 307, from);
    assert.equal(res.headers.get('Location'), to, from);
  }
});

test('a POST to the admin API on a subdomain stays a POST (307, not 302)', async () => {
  const res = adminHostRedirect('https://greek.orthodoxy.au/api/admin/places');
  assert.equal(res.status, 307);
});

test('orthodoxy.au itself, other hosts, and the rest of a subdomain are left alone', () => {
  for (const u of [
    'https://orthodoxy.au/admin',
    'https://orthodoxy.au/api/admin/ping',
    'http://localhost:8787/admin',
    'https://notorthodoxy.au/admin',
    'https://orthodoxy.au.example.com/admin',
    'https://greek.orthodoxy.au/',
    'https://greek.orthodoxy.au/api/bundle',
    'https://greek.orthodoxy.au/sgr',
  ]) {
    assert.equal(adminHostRedirect(u), null, u);
  }
});

test('a jurisdiction subdomain is its filter on orthodoxy.au; anything else moves as it is', async () => {
  const env = { DB: untouched('D1'), ASSETS: untouched('ASSETS'), ASSETS_BUCKET: untouched('R2') };
  for (const [from, status, to] of [
    ['https://greek.orthodoxy.au/', 301, 'https://orthodoxy.au/greek'],
    ['https://greek.orthodoxy.au/en', 301, 'https://orthodoxy.au/greek/en'],
    ['https://greek.orthodoxy.au/sgr?x=1', 301, 'https://orthodoxy.au/greek/sgr?x=1'],
    ['https://Russian.orthodoxy.au/this-week', 301, 'https://orthodoxy.au/russian/this-week'],
    // The path's own jurisdiction wins, as it did when the page read the host.
    ['https://greek.orthodoxy.au/antiochian', 301, 'https://orthodoxy.au/antiochian'],
    // Not a jurisdiction: the same path.
    ['https://www.orthodoxy.au/sgr', 301, 'https://orthodoxy.au/sgr'],
    ['https://agora.orthodoxy.au/', 301, 'https://orthodoxy.au/'],
    // Not a page: the same path, method kept.
    ['https://greek.orthodoxy.au/api/bundle', 308, 'https://orthodoxy.au/api/bundle'],
    ['https://greek.orthodoxy.au/shared/url-state.js', 308, 'https://orthodoxy.au/shared/url-state.js'],
  ]) {
    const res = await worker.fetch(new Request(from), env, ctx);
    assert.equal(res.status, status, from);
    assert.equal(res.headers.get('Location'), to, from);
  }
  const post = await worker.fetch(new Request('https://greek.orthodoxy.au/', { method: 'POST' }), env, ctx);
  assert.equal(post.status, 308);
  assert.equal(post.headers.get('Location'), 'https://orthodoxy.au/');
});

test('orthodoxy.au itself and other hosts are not redirected', () => {
  for (const u of ['https://orthodoxy.au/', 'https://orthodoxy.au/greek', 'http://localhost:8787/',
    'https://notorthodoxy.au/', 'https://pr-1-agora.kpkevpat.workers.dev/']) {
    assert.equal(subdomainRedirect(new Request(u)), null, u);
  }
});

test('an uncaught error answers "Internal error" and keeps the detail to the log', async () => {
  const secretish = 'D1_ERROR: no such column: p.private_notes';
  const env = {
    DB: { prepare() { throw new Error(secretish); } },
    ASSETS: untouched('ASSETS'), ASSETS_BUCKET: untouched('R2'),
  };
  const logged = [];
  const realError = console.error;
  console.error = (...a) => logged.push(a.map(String).join(' '));
  try {
    for (const path of ['/api/parishes', '/health']) {
      const res = await worker.fetch(new Request(`https://orthodoxy.au${path}`), env, ctx);
      assert.equal(res.status, 500, path);
      const body = await res.text();
      assert.doesNotMatch(body, /private_notes|D1_ERROR/, `${path} answered with the detail`);
    }
  } finally {
    console.error = realError;
  }
  assert.equal(logged.length, 2);
  assert.ok(logged.every(l => l.includes('private_notes')), 'the detail has to reach the log');
});
