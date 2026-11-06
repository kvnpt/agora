// lib/whatsapp.mjs: what the Cloud API sends, and the small decisions made on it.

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import {
  verifySignature, messagesOf, kindOf, groupOf, textsFor, codeIn, newCode, parishNamed, maskPhone,
  readSummary, draftLink, linkUrl, fetchMedia, WHATSAPP_DDL, GRAPH,
} from './whatsapp.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const sign = (secret, body) => `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;

test('a POST is Meta’s only with the app secret’s signature on its exact body', async () => {
  const body = '{"object":"whatsapp_business_account"}';
  assert.equal(await verifySignature('s3cret', body, sign('s3cret', body)), true);
  assert.equal(await verifySignature('s3cret', new TextEncoder().encode(body), sign('s3cret', body)), true, 'bytes too');
  assert.equal(await verifySignature('s3cret', body + ' ', sign('s3cret', body)), false, 'one byte more');
  assert.equal(await verifySignature('other', body, sign('s3cret', body)), false);
  assert.equal(await verifySignature('s3cret', body, ''), false);
  assert.equal(await verifySignature('s3cret', body, 'sha1=abc'), false);
  assert.equal(await verifySignature(null, body, sign('s3cret', body)), false, 'no secret, no entry');
});

const payload = (messages, { phoneNumberId = '111', contacts = [{ wa_id: '61412345678', profile: { name: 'Kevin' } }] } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp',
    metadata: { display_phone_number: '15551234567', phone_number_id: phoneNumberId },
    contacts, messages,
  } }] }],
});

test('messages come out flat, with their words, media and sender', () => {
  const got = messagesOf(payload([
    { from: '61412345678', id: 'wamid.A', timestamp: '1762400000', type: 'image',
      image: { caption: 'Mums Group, first Fridays', mime_type: 'image/jpeg', id: 'M1' }, context: { forwarded: true } },
    { from: '61412345678', id: 'wamid.B', timestamp: '1762400001', type: 'text', text: { body: 'All welcome' } },
  ]), '111');
  assert.equal(got.length, 2);
  assert.deepEqual(
    { id: got[0].id, from: got[0].from, name: got[0].name, type: got[0].type, text: got[0].text, mediaId: got[0].mediaId,
      mediaType: got[0].mediaType, forwarded: got[0].forwarded, sentAt: got[0].sentAt },
    { id: 'wamid.A', from: '61412345678', name: 'Kevin', type: 'image', text: 'Mums Group, first Fridays', mediaId: 'M1',
      mediaType: 'image/jpeg', forwarded: true, sentAt: 1762400000 });
  assert.equal(got[1].text, 'All welcome');
  assert.equal(got[1].forwarded, false);
  // Another number's messages, and status updates, are none of ours.
  assert.deepEqual(messagesOf(payload([{ from: '1', id: 'x', type: 'text', text: { body: 'hi' } }], { phoneNumberId: '999' }), '111'), []);
  assert.deepEqual(messagesOf({ entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'x' }] } }] }] }, '111'), []);
  assert.deepEqual(messagesOf(null, '111'), []);
});

test('what each kind of message is to the reader', () => {
  const m = (type, extra = {}) => ({ type, text: '', mediaType: null, ...extra });
  assert.equal(kindOf(m('image', { mediaType: 'image/jpeg' })), 'image');
  assert.equal(kindOf(m('document', { mediaType: 'image/png' })), 'image', 'a picture sent as a file, for its quality');
  assert.equal(kindOf(m('document', { mediaType: 'application/pdf' })), 'pdf');
  assert.equal(kindOf(m('text', { text: 'Vespers at 5' })), 'text');
  assert.equal(kindOf(m('text', { text: '  ' })), 'ignore');
  assert.equal(kindOf(m('reaction')), 'ignore');
  assert.equal(kindOf(m('video', { mediaType: 'video/mp4' })), 'other');
  assert.equal(kindOf(m('image', { mediaType: 'image/heic' })), 'other', 'nothing the reader takes');
});

test('a poster and its words a moment apart are one announcement', () => {
  const rows = [
    { id: 'old', type: 'image', sent_at: 100 },
    { id: 'p1', type: 'image', sent_at: 200 },
    { id: 't1', type: 'text', sent_at: 201 },
    { id: 'p2', type: 'image', sent_at: 203 },
    { id: 't2', type: 'text', sent_at: 203 },
    { id: 'later', type: 'text', sent_at: 300 },
  ];
  assert.deepEqual(groupOf(rows, 't2').map(r => r.id), ['p1', 't1', 'p2', 't2']);
  assert.deepEqual(groupOf(rows, 'old').map(r => r.id), ['old']);
  assert.deepEqual(groupOf(rows, 'later').map(r => r.id), ['later']);
  const isImage = (r) => r.type === 'image';
  const group = groupOf(rows, 'p1');
  assert.deepEqual(textsFor(group, 'p1', isImage).map(r => r.id), ['t1'], 'each text goes with the poster before it');
  assert.deepEqual(textsFor(group, 'p2', isImage).map(r => r.id), ['t2']);
  // Words first, then the poster: still one.
  const first = [{ id: 't', type: 'text', sent_at: 10 }, { id: 'p', type: 'image', sent_at: 11 }];
  assert.deepEqual(textsFor(first, 'p', isImage).map(r => r.id), ['t']);
});

test('a link code, as the account menu writes it or as six digits', () => {
  assert.equal(codeIn('LINK 482193'), '482193');
  assert.equal(codeIn(' link 482 193 '), '482193');
  assert.equal(codeIn('482193'), '482193');
  assert.equal(codeIn('LINK 4821'), null);
  assert.equal(codeIn('Vespers 482193'), null);
  for (let i = 0; i < 20; i++) assert.match(newCode(), /^\d{6}$/);
  assert.equal(linkUrl('15551234567', '004211'), 'https://wa.me/15551234567?text=LINK%20004211');
});

test('a parish named by its link, or by words that are only its link', () => {
  const ps = [{ id: 'snp', acronym: 'SNP' }, { id: 'smg', acronym: 'S MG' }, { id: 'none', acronym: null }];
  assert.equal(parishNamed('Details at orthodoxy.au/snp', ps), 'snp');
  assert.equal(parishNamed('https://orthodoxy.au/smg/feast', ps), 'smg', 'a named link is its parish’s');
  assert.equal(parishNamed('/snp', ps), 'snp');
  assert.equal(parishNamed(' snp ', ps), 'snp');
  assert.equal(parishNamed('see example.com/snp', ps), null, 'only Agora’s links');
  assert.equal(parishNamed('Mums Group snp', ps), null, 'a word among others is just a word');
  assert.equal(parishNamed('orthodoxy.au/snpx', ps), null);
});

test('a phone shown, a draft linked, a read summed up', () => {
  assert.equal(maskPhone('61412345678'), '+61 4•• ••• 678');
  assert.equal(draftLink('https://orthodoxy.au', { acronym: 'SNP' }, 241), 'https://orthodoxy.au/snp?draft=241');
  assert.equal(draftLink('https://orthodoxy.au', { acronym: null }, 7), 'https://orthodoxy.au/?draft=7');
  assert.equal(readSummary({ cards: [{ title: 'Mums Group', date: '2026-11-06', start_time: '10:00' }], read_services: [] }),
    'Mums Group, Fri 6 Nov 10am');
  assert.equal(readSummary({ cards: [{ title: 'A', date: '2026-11-14', start_time: '18:30' }, { title: 'B' }, { title: '' }],
    read_services: [{}] }), 'A, Sat 14 Nov 6:30pm, and 1 more; 1 service for the timetable');
  assert.equal(readSummary({ cards: [{}], read_services: [] }), '');
});

test('an image is fetched in two steps with the token, and refused over 5 MB', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init && init.headers && init.headers.authorization });
    if (url === `${GRAPH}/M1`) return Response.json({ url: 'https://lookaside.example/M1', mime_type: 'image/jpeg', file_size: 4 });
    if (url === `${GRAPH}/BIG`) return Response.json({ url: 'https://lookaside.example/BIG', mime_type: 'image/jpeg', file_size: 9e6 });
    if (url === 'https://lookaside.example/M1') return new Response(new Uint8Array([1, 2, 3, 4]));
    return new Response('no', { status: 404 });
  };
  const ok = await fetchMedia({ token: 'T', mediaId: 'M1', fetchImpl });
  assert.equal(ok.ok, true);
  assert.equal(ok.bytes.byteLength, 4);
  assert.equal(ok.mediaType, 'image/jpeg');
  assert.deepEqual(calls.map(c => c.auth), ['Bearer T', 'Bearer T']);
  assert.equal((await fetchMedia({ token: 'T', mediaId: 'BIG', fetchImpl })).tooLarge, true);
  assert.equal((await fetchMedia({ token: 'T', mediaId: 'GONE', fetchImpl })).ok, false);
});

test('the first-use DDL builds the same tables as the baseline', () => {
  const base = new Database(':memory:');
  base.exec(fs.readFileSync('d1/schema.sql', 'utf8'));
  const lazy = new Database(':memory:');
  for (const sql of WHATSAPP_DDL) lazy.exec(sql);
  const tables = ['whatsapp_links', 'whatsapp_codes', 'whatsapp_messages'];
  for (const t of tables) {
    const cols = (db) => db.prepare(`PRAGMA table_info(${t})`).all();
    assert.deepEqual(cols(lazy), cols(base), t);
  }
  const idx = (db) => db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN (${tables.map(t => `'${t}'`).join(',')}) ORDER BY name`).all();
  assert.deepEqual(idx(lazy), idx(base));
});
