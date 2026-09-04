// Range header parsing for R2-backed assets.
//
// PMTiles reads a multi-hundred-megabyte archive a few kilobytes at a time over
// HTTP byte serving, so this is what makes the map possible without the file
// being on a local disk. Getting an off-by-one here shows up as a subtly
// corrupt map rather than an error, which is why the cases are spelled out.

import test from 'node:test';
import assert from 'node:assert';
import { parseRange } from '../routes/assets.mjs';

const SIZE = 1000;

test('no header means no range', () => {
  assert.strictEqual(parseRange(null, SIZE), null);
  assert.strictEqual(parseRange('', SIZE), null);
});

test('closed range is inclusive of both ends', () => {
  // "bytes=0-99" is 100 bytes, not 99 — the classic off-by-one.
  assert.deepStrictEqual(parseRange('bytes=0-99', SIZE), { offset: 0, length: 100 });
  assert.deepStrictEqual(parseRange('bytes=64-127', SIZE), { offset: 64, length: 64 });
  assert.deepStrictEqual(parseRange('bytes=999-999', SIZE), { offset: 999, length: 1 });
});

test('open-ended range runs to the last byte', () => {
  assert.deepStrictEqual(parseRange('bytes=900-', SIZE), { offset: 900, length: 100 });
  assert.deepStrictEqual(parseRange('bytes=0-', SIZE), { offset: 0, length: 1000 });
});

test('an end past the object is clamped, not an error', () => {
  assert.deepStrictEqual(parseRange('bytes=990-99999', SIZE), { offset: 990, length: 10 });
});

test('suffix range counts back from the end', () => {
  assert.deepStrictEqual(parseRange('bytes=-100', SIZE), { offset: 900, length: 100 });
  // A suffix longer than the object yields the whole object.
  assert.deepStrictEqual(parseRange('bytes=-99999', SIZE), { offset: 0, length: 1000 });
});

test('a start at or past the end is unsatisfiable (416)', () => {
  assert.deepStrictEqual(parseRange('bytes=1000-', SIZE), { unsatisfiable: true });
  assert.deepStrictEqual(parseRange('bytes=5000-6000', SIZE), { unsatisfiable: true });
});

test('a reversed range is unsatisfiable', () => {
  assert.deepStrictEqual(parseRange('bytes=500-100', SIZE), { unsatisfiable: true });
});

test('malformed headers are ignored rather than guessed at', () => {
  for (const h of ['bytes=', 'bytes=abc-def', 'items=0-10', 'bytes=0-10, 20-30', 'garbage']) {
    assert.strictEqual(parseRange(h, SIZE), null, h);
  }
});

test('whitespace around the header is tolerated', () => {
  assert.deepStrictEqual(parseRange('  bytes=0-9  ', SIZE), { offset: 0, length: 10 });
});
