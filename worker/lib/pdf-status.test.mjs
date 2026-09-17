// Reading a PDF parish's extracted document back.
//
// The case that drove this: a card showing a stale failure while a good file
// sat in R2, because everything on the card came from `adapter_runs` and the
// adapter had not run since the Action uploaded.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfSourceStatus, fileIsNewerThanRun } from './pdf-status.mjs';

// Same surface the adapter uses: get() returns null for a missing key, and the
// object it returns for a present one has .json().
const fakeR2 = (objects) => ({
  async get(key) {
    if (!(key in objects)) return null;
    const body = objects[key];
    if (body instanceof Error) throw body;
    return { async json() { if (body === 'BAD_JSON') throw new Error('bad'); return body; } };
  },
});

const SOURCE = {
  key: 'stparaskevi-blacktown',
  sourceUrl: 'https://www.stparaskevi.au/uploads/programme_july_2026_en.pdf',
};
const KEY = 'pdf-schedules/stparaskevi-blacktown.json';

const doc = (over = {}) => ({
  key: 'stparaskevi-blacktown',
  parish_id: 'greek-stparaskevi-blacktown',
  source_url: 'https://www.stparaskevi.au/uploads/programme_july_2026_en.pdf',
  discovered_from: 'https://www.stparaskevi.au/church-programme.html',
  fetched_at: '2026-09-13T19:16:24.000Z',
  pdf_sha256: '3595e4eac638b58f8cb0827e01b03c45df2d7e827fb75bf450b61237202c91c6',
  pdf_bytes: 315574,
  extractor: 'mutool trace + pdf-grid',
  coverage: { from: '2026-07-01', to: '2026-07-31' },
  occurrences: 78,
  text: 'PROGRAM OF SERVICES\nJULY 2026\n…',
  ...over,
});

const read = (objects, today = '2026-09-17') =>
  pdfSourceStatus(fakeR2(objects), SOURCE, today);

test('the file describes itself: which one, when, how much, how far', async () => {
  const s = await read({ [KEY]: doc() });
  assert.equal(s.present, true);
  assert.equal(s.sourceUrl, 'https://www.stparaskevi.au/uploads/programme_july_2026_en.pdf');
  assert.equal(s.discoveredFrom, 'https://www.stparaskevi.au/church-programme.html');
  assert.equal(s.fetchedAt, '2026-09-13T19:16:24.000Z');
  assert.equal(s.occurrences, 78);
  assert.equal(s.bytes, 315574);
  assert.equal(s.extractor, 'mutool trace + pdf-grid');
  assert.equal(s.sha, '3595e4eac638');
});

test('the text is never carried to the browser', async () => {
  // It is the bulk of the document and none of the panel's business. R2 cannot
  // fetch part of an object, so it is read and dropped rather than not read.
  const s = await read({ [KEY]: doc() });
  assert.equal(s.text, undefined);
  assert.ok(!JSON.stringify(s).includes('PROGRAM OF SERVICES'));
});

test('coverage is the FILE\'s, and says how stale in words', async () => {
  const s = await read({ [KEY]: doc() });
  assert.equal(s.coverage.state, 'expired');
  assert.equal(s.coverage.until, '2026-07-31');
  assert.equal(s.coverage.daysLeft, -48);
  assert.match(s.coverage.message, /covers nothing after 2026-07-31/);
});

test('a file with room left reads ok and says nothing', async () => {
  const s = await read({ [KEY]: doc({ coverage: { from: '2026-09-01', to: '2026-12-31' } }) });
  assert.equal(s.coverage.state, 'ok');
  assert.equal(s.coverage.message, null);
});

test('a document written before coverage existed is unknown, not expired', async () => {
  // The distinction matters: 'expired' accuses the parish of having stopped
  // publishing. A missing field is our own document being old, which is a
  // statement about us.
  const { coverage, ...older } = doc();
  const s = await read({ [KEY]: older });
  assert.equal(s.present, true);
  assert.equal(s.coverage.state, 'unknown');
  assert.notEqual(s.coverage.state, 'expired');
});

test('a source that has never been extracted says so, and says what to do', async () => {
  const s = await read({});
  assert.equal(s.present, false);
  assert.match(s.problem, /Re-fetch from the parish/);
  assert.equal(s.key, KEY);
});

test('an unbound bucket costs one card its detail, not the whole tab', async () => {
  const s = await pdfSourceStatus(undefined, SOURCE, '2026-09-17');
  assert.equal(s.present, false);
  assert.match(s.problem, /ASSETS_BUCKET/);
});

test('a malformed object never throws out of here', async () => {
  // The Adapters tab has to render whatever happens. Every one of these used
  // to be a way for one bad object to 500 the list.
  for (const bad of ['BAD_JSON', null, 42, new Error('R2 is having a day')]) {
    const s = await read({ [KEY]: bad });
    assert.equal(s.present, false, `expected no detail for ${String(bad)}`);
    assert.ok(s.problem, 'a refusal should always say why');
  }
});

test('the discovered URL and the remembered one are both reported', async () => {
  // They differ when the parish has moved on and pdf-sources.mjs still names
  // the old file — worth seeing, because the fallback is quietly ageing.
  const s = await read({ [KEY]: doc({ source_url: 'https://www.stparaskevi.au/uploads/programme_september_2026_en.pdf' }) });
  assert.equal(s.sourceUrl, 'https://www.stparaskevi.au/uploads/programme_september_2026_en.pdf');
  assert.equal(s.remembersUrl, 'https://www.stparaskevi.au/uploads/programme_july_2026_en.pdf');
  assert.notEqual(s.sourceUrl, s.remembersUrl);
});

test('a file newer than the last run is exactly the Blacktown case', async () => {
  // The Action uploaded on the 13th; the adapter's last run was the 12th and
  // failed. Without this the panel shows the failure and cannot say it has
  // been overtaken.
  assert.equal(fileIsNewerThanRun('2026-09-13T19:16:24.000Z', '2026-09-12T15:00:42Z'), true);
  assert.equal(fileIsNewerThanRun('2026-09-13T19:16:24.000Z', '2026-09-14T04:00:00Z'), false);
});

test('a run timestamp without its Z is still read as UTC', async () => {
  // D1 stores 'YYYY-MM-DDTHH:MM:SSZ' via strftime, but adapter_runs rows
  // written by older code come back without the Z. Parsed as local time those
  // would drift by the runner's offset and flip this comparison.
  assert.equal(fileIsNewerThanRun('2026-09-13T19:16:24.000Z', '2026-09-13T19:00:00'), true);
  assert.equal(fileIsNewerThanRun('2026-09-13T19:16:24.000Z', '2026-09-13T19:30:00'), false);
});

test('no opinion when either side is missing', async () => {
  assert.equal(fileIsNewerThanRun(null, '2026-09-12T15:00:42Z'), false);
  assert.equal(fileIsNewerThanRun('2026-09-13T19:16:24.000Z', null), false);
  assert.equal(fileIsNewerThanRun('not a date', '2026-09-12T15:00:42Z'), false);
});
