// lib/mail.mjs: who gets written to, and that a failure is only ever a log line.

import test from 'node:test';
import assert from 'node:assert/strict';
import { sendMail, isEmail, canMail, claimDecidedMail, MAIL_FROM } from './mail.mjs';

test('only addresses get mail; a bare subject or the dev identity does not', () => {
  assert.equal(isEmail('maria@example.org'), true);
  assert.equal(isEmail('dev'), false);
  assert.equal(isEmail('a1b2c3-sub'), false);
  assert.equal(isEmail('two words@example.org'), false);
  assert.equal(canMail({}), false);
  assert.equal(canMail({ EMAIL: {} }), false, 'a binding is something that can send');
});

test('one message per address, deduplicated, and nothing when not set up', async () => {
  const sent = [];
  const env = { EMAIL: { send: async (m) => { sent.push(m); return { messageId: 'x' }; } } };
  const r = await sendMail(env, { to: ['a@example.org', 'b@example.org', 'a@example.org', 'dev'], subject: 'S', text: 'T' });
  assert.deepEqual(r, { sent: 2 });
  assert.deepEqual(sent.map(m => m.to), ['a@example.org', 'b@example.org']);
  assert.deepEqual(sent[0].from, { email: MAIL_FROM, name: 'orthodoxy.au' });
  assert.deepEqual(await sendMail({}, { to: 'a@example.org', subject: 'S', text: 'T' }), { sent: 0, skipped: 'not-configured' });
  assert.deepEqual(await sendMail(env, { to: 'dev', subject: 'S', text: 'T' }), { sent: 0, skipped: 'no-recipient' });
});

test('a send that throws is reported, never thrown', async () => {
  const env = { EMAIL: { send: async () => { const e = new Error('x'); e.code = 'E_DELIVERY_FAILED'; throw e; } } };
  const r = await sendMail(env, { to: 'a@example.org', subject: 'S', text: 'T' });
  assert.deepEqual(r, { sent: 0, failed: ['E_DELIVERY_FAILED'] });
});

test('a declined claim links to the parish by its acronym', () => {
  const m = claimDecidedMail({}, { id: 'antiochian-stgeorge-redfern', name: 'St George', acronym: 'SGR' },
    { approved: false, note: null }, 'https://orthodoxy.au');
  assert.match(m.text, /https:\/\/orthodoxy\.au\/sgr\n/);
  assert.doesNotMatch(m.text, /wrote/, 'no note, no quote');
});
