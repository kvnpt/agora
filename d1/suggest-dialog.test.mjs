// What "Suggest edits" keeps between its dialog and the suggest page, across
// the Cloudflare sign-in (public/shared/suggest-dialog.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import S from '../public/shared/suggest-dialog.js';

const memory = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
};

test('a suggestion needs words; a request to edit needs a name', () => {
  assert.equal(S.draftFrom({ change_body: '   ' }).field, 'change_body');
  assert.equal(S.draftFrom({ contact: true, change_body: '' }).field, 'name');
  const ok = S.draftFrom({ about: 'An event', change_body: ' Vespers is at 6 ', name: ' Kev ' }).draft;
  assert.deepEqual(ok, { kind: 'change', about: 'An event', change_body: 'Vespers is at 6', name: 'Kev', contact: false, relation: '' });
  const claim = S.draftFrom({ contact: true, name: 'Kev', relation: 'Secretary' }).draft;
  assert.equal(claim.contact, true);
  assert.equal(claim.relation, 'Secretary', 'the request alone, with nothing to change, is enough');
  assert.equal(S.draftFrom({ contact: false, change_body: 'x', relation: 'Secretary' }).draft.relation, '',
    'a role typed and then unticked is not sent');
});

test('the draft is read once, by its parish, and not after it went stale', () => {
  const store = memory();
  const now = Date.parse('2026-10-14T10:00:00Z');
  S.saveDraft('p1', { change_body: 'hi' }, store, now);
  assert.equal(S.takeDraft('p2', store, now), null, 'another parish has none');
  const v = S.takeDraft('p1', store, now + 60000);
  assert.equal(v.change_body, 'hi');
  assert.equal(v.submit, true, 'the dialog button was the send');
  assert.equal(S.takeDraft('p1', store, now), null, 'read once');
  S.saveDraft('p1', { change_body: 'old' }, store, now);
  assert.equal(S.takeDraft('p1', store, now + S.MAX_AGE_MS + 1), null, 'abandoned at the sign-in');
  assert.equal(store.m.size, 0, 'a stale draft is forgotten too');
  store.setItem(S.KEY('p1'), '{not json');
  assert.equal(S.takeDraft('p1', store, now), null);
});

test("the dialog's topics are the suggest page's, word for word", async () => {
  const { readFile } = await import('node:fs/promises');
  const admin = await readFile(new URL('../public/admin.html', import.meta.url), 'utf8');
  for (const t of S.OTHER_TOPICS) {
    const html = t.replace(/'/g, "'");
    assert.ok(admin.includes(`<option>${html}</option>`), `admin.html offers "${t}"`);
  }
});

test('a poster from the dialog is enough on its own, and says it is coming', () => {
  const d = S.draftFrom({ change_body: '', poster: true }).draft;
  assert.equal(d.poster, true, 'the suggest page looks for it by this');
  assert.equal(S.draftFrom({ change_body: 'x' }).draft.poster, undefined, 'no poster, no flag');
});

test('with no IndexedDB, a poster is not kept and none is found — and nothing throws', async () => {
  assert.equal(await S.savePoster('p1', new Blob(['x']), { idb: null }), false);
  assert.equal(await S.takePoster('p1', { idb: null }), null);
  await S.dropPoster('p1', { idb: null });
});
