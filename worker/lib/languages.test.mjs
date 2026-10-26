// The fixed list of languages (public/shared/languages.js): what every write
// keeps to, and how the old spellings read.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../../public/shared/languages.js');

test('eight languages, and no Russian: the Russian parishes pray in Church Slavonic', () => {
  assert.deepEqual(L.NAMES, ['English', 'Greek', 'Arabic', 'Serbian', 'Church Slavonic', 'Romanian', 'Macedonian', 'Ukrainian']);
  for (const v of ['Russian', 'russian', 'Slavonic', 'church slavonic', 'church-slavonic']) {
    assert.equal(L.canonical(v), 'Church Slavonic', v);
  }
  assert.equal(L.canonical('French'), null);
});

test('a row badge says Slavonic; everything else says it whole', () => {
  assert.equal(L.shortOf('Church Slavonic'), 'Slavonic');
  assert.equal(L.shortOf('Greek'), 'Greek');
  assert.equal(L.shortOf('Klingon'), 'Klingon');
});

test('clean keeps the list, in the order given, each once, from any shape', () => {
  assert.equal(L.clean('["Greek", "English"]'), '["Greek","English"]', 'the first language means something');
  assert.equal(L.clean(['russian', 'English', 'Slavonic', 'French']), '["Church Slavonic","English"]');
  assert.equal(L.clean('greek, english'), '["Greek","English"]');
  assert.equal(L.clean('[]'), null);
  assert.equal(L.clean(''), null);
  assert.equal(L.clean(null), null);
  assert.equal(L.clean('["Klingon"]'), null);
});

test("a form shows English and the jurisdiction's own language first", () => {
  const L = require('../../public/shared/languages.js');
  assert.deepEqual(L.upFront('greek'), ['English', 'Greek']);
  assert.deepEqual(L.upFront('antiochian'), ['English', 'Arabic']);
  assert.deepEqual(L.upFront('russian'), ['English', 'Church Slavonic']);
  assert.deepEqual(L.upFront('other'), ['English']);
  assert.deepEqual(L.upFront(''), ['English']);
  for (const n of Object.values(L.JURISDICTION_LANGUAGE)) assert.ok(L.NAMES.includes(n), `${n} is on the list`);
});
