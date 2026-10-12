// public/shared/event-types.js — the kinds, and the one table of their colours
// the cards, the drawers and the kind picker all paint from.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { KINDS, kindColors } = require('../public/shared/event-types.js');
const HEX = /^#[0-9a-f]{6}$/i;

test('every kind has a background and a text colour, in both schemes', () => {
  for (const { id } of KINDS) {
    for (const dark of [false, true]) {
      const { bg, fg } = kindColors(id, dark);
      assert.match(bg, HEX, `${id} ${dark ? 'dark' : 'light'} background`);
      assert.match(fg, HEX, `${id} ${dark ? 'dark' : 'light'} text`);
      assert.notEqual(bg, fg, `${id} is unreadable: its text is its background`);
    }
  }
});

test('the kinds look different from one another', () => {
  const seen = new Set(KINDS.map(k => kindColors(k.id).bg));
  assert.equal(seen.size, KINDS.length, 'two kinds share a colour, so the picker cannot tell them apart');
});

test('a kind nobody knows wears "other"', () => {
  assert.deepEqual(kindColors('vespers'), kindColors('other'));
  assert.deepEqual(kindColors(undefined, true), kindColors('other', true));
});
