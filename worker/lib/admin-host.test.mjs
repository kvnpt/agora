// Admin answers on orthodoxy.au only; a subdomain sends it there. And an
// uncaught error answers the public with "Internal error" and nothing more.
// Through the Worker's own fetch, with bindings that fail the test if touched.

import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../index.mjs';
import { isAdminPath, adminHostRedirect } from './admin-host.mjs';

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
