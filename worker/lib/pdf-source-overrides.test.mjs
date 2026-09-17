// Letting /admin move a PDF parish's file, without breaking the invariant that
// made pdf-sources.mjs a shared module in the first place.

import test from 'node:test';
import assert from 'node:assert/strict';
import { pdfSourceOverrides, applyOverride, resolveSources, isHttpUrl, publicOverridePayload }
  from './pdf-source-overrides.mjs';
import { PDF_SOURCES } from './pdf-sources.mjs';

const SOURCE = {
  key: 'gopssc-buderim',
  sourceUrl: 'https://orthodoxsunshinecoast.org/hubfs/2026.pdf',
  parse: { locationColumn: false },
};

// Enough of D1's surface for these: .prepare().all(), and a way to throw.
const db = (rows) => ({
  prepare: () => ({
    all: async () => {
      if (rows instanceof Error) throw rows;
      return { results: rows };
    },
  }),
});

test('no rows is the normal answer, and so is no table', async () => {
  assert.deepEqual(await pdfSourceOverrides(db([])), {});
  // The schema change can land before or after the deploy that reads it. A
  // scrape should carry on with the file's URL rather than fail for the window
  // in between — same reasoning as the jurisdiction colours.
  assert.deepEqual(await pdfSourceOverrides(db(new Error('no such table'))), {});
  assert.deepEqual(await pdfSourceOverrides(null), {});
});

test('a row overrides the file, and keeps what the file said', async () => {
  const o = await pdfSourceOverrides(db([
    { source_key: 'gopssc-buderim', source_url: 'https://orthodoxsunshinecoast.org/hubfs/2027.pdf',
      updated_at: '2027-01-08T00:00:00Z', updated_by: 'deacon@example.org' },
  ]));
  const r = applyOverride(SOURCE, o);
  assert.equal(r.sourceUrl, 'https://orthodoxsunshinecoast.org/hubfs/2027.pdf');
  assert.equal(r.overridden, true);
  // Both are kept so the panel and the extraction log can show a divergence
  // rather than quietly presenting one as the other.
  assert.equal(r.remembersUrl, 'https://orthodoxsunshinecoast.org/hubfs/2026.pdf');
  assert.equal(r.overrideUpdatedBy, 'deacon@example.org');
});

test('the registry entry is never mutated', async () => {
  // PDF_SOURCES is module state shared by every request in an isolate. An
  // override written into it would leak into the next request.
  const before = PDF_SOURCES[0].sourceUrl;
  const o = { [PDF_SOURCES[0].key]: { url: 'https://example.org/other.pdf' } };
  const r = applyOverride(PDF_SOURCES[0], o);
  assert.equal(r.sourceUrl, 'https://example.org/other.pdf');
  assert.equal(PDF_SOURCES[0].sourceUrl, before, 'the registry was mutated');
});

test('everything else about the source survives the override', async () => {
  // Only the URL is data. parse/extract/linkPattern are judgements about how to
  // read a document, and losing them would mis-read every service silently.
  const src = { ...SOURCE, extract: 'grid', linkPattern: /x/, parse: { defaultLocation: 'A church' } };
  const r = applyOverride(src, { 'gopssc-buderim': { url: 'https://example.org/new.pdf' } });
  assert.equal(r.extract, 'grid');
  assert.deepEqual(r.parse, { defaultLocation: 'A church' });
  assert.ok(r.linkPattern instanceof RegExp);
});

test('an override equal to the file is not an override', async () => {
  // Otherwise a row would sit there claiming somebody changed something, and a
  // later edit to pdf-sources.mjs would be silently ignored in favour of a row
  // agreeing with its old value.
  const r = applyOverride(SOURCE, { 'gopssc-buderim': { url: SOURCE.sourceUrl } });
  assert.equal(r.overridden, false);
  assert.equal(r.sourceUrl, SOURCE.sourceUrl);
});

test('a row that is not an http URL is ignored, not fetched', async () => {
  // This value is handed to a fetch in the Worker AND to one in a GitHub
  // Action, so it is filtered on the way out as well as on the way in.
  const o = await pdfSourceOverrides(db([
    { source_key: 'a', source_url: 'javascript:alert(1)' },
    { source_key: 'b', source_url: 'file:///etc/passwd' },
    { source_key: 'c', source_url: '' },
    { source_key: 'd', source_url: null },
    { source_key: 'e', source_url: 'https://ok.example/x.pdf' },
  ]));
  assert.deepEqual(Object.keys(o), ['e']);
});

test('isHttpUrl takes http and https and nothing else', async () => {
  assert.equal(isHttpUrl('https://a.example/x.pdf'), true);
  assert.equal(isHttpUrl('http://a.example/x.pdf'), true);
  for (const bad of ['ftp://a/x', 'javascript:1', 'file:///x', '/relative.pdf', 'a.example/x.pdf', '', null, 7]) {
    assert.equal(isHttpUrl(bad), false, `${JSON.stringify(bad)} should be refused`);
  }
});

test('resolveSources covers the whole registry, overridden or not', async () => {
  const r = resolveSources({ 'gopssc-buderim': { url: 'https://example.org/new.pdf' } });
  assert.equal(r.length, PDF_SOURCES.length);
  assert.equal(r.find(s => s.key === 'gopssc-buderim').overridden, true);
  assert.equal(r.find(s => s.key === 'stparaskevi-blacktown').overridden, false);
  // Even an unoverridden source reports what the file remembers, so one code
  // path serves both cases.
  assert.ok(r.every(s => s.remembersUrl));
});

test('the public payload carries only overrides, sorted', async () => {
  // The Action already imports pdf-sources.mjs, so all it is missing is what
  // changed. Sending only that means an unreachable endpoint degrades to "no
  // overrides" rather than to "no sources".
  const payload = publicOverridePayload({
    'z-parish': { url: 'https://z.example/x.pdf', updatedAt: '2027-01-02T00:00:00Z' },
    'a-parish': { url: 'https://a.example/x.pdf', updatedAt: '2027-01-01T00:00:00Z' },
  });
  assert.deepEqual(payload.map(r => r.key), ['a-parish', 'z-parish']);
  assert.deepEqual(payload[0], { key: 'a-parish', source_url: 'https://a.example/x.pdf', updated_at: '2027-01-01T00:00:00Z' });
  // No updated_by: who changed it is an admin detail and this endpoint is
  // public.
  assert.ok(!('updated_by' in payload[0]));
});

test('the extractor and the Worker resolve a source identically', async () => {
  // THE WHOLE POINT. pdf-sources.mjs is imported by both so the URL fetched
  // and the URL believed cannot drift; an override only one of them could see
  // would have broken exactly that. Both call applyOverride, so this asserts
  // the shared function is the only resolution there is.
  const overrides = { 'stparaskevi-blacktown': { url: 'https://stparaskevi.au/programme_march_2027_en.pdf' } };
  const workerView = resolveSources(overrides).find(s => s.key === 'stparaskevi-blacktown');
  const actionView = applyOverride(
    PDF_SOURCES.find(s => s.key === 'stparaskevi-blacktown'), overrides);
  assert.equal(workerView.sourceUrl, actionView.sourceUrl);
  assert.equal(workerView.sourceUrl, 'https://stparaskevi.au/programme_march_2027_en.pdf');
});
