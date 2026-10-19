// What a filter link is called, by its preview and by the page's own
// parishes in view (public/shared/link-words.js).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const W = require('../public/shared/link-words.js');
const U = require('../public/shared/url-state.js');
const words = (path, opts) => W.headingOf(U.classifyPath(path), opts);

test('a link is named as its preview says it', () => {
  assert.equal(words('/'), 'Orthodox parishes and times');
  assert.equal(words('/antiochian/liturgy/en'), 'Antiochian Orthodox Liturgies in English');
  assert.equal(words('/social-youth'), 'Orthodox youth groups');
  assert.equal(words('/wed/morning/bible-study/en'), 'Orthodox morning Bible studies on Wednesdays in English');
  assert.equal(words('/greek', { loc: { label: 'Queensland' } }), 'Greek Orthodox parishes and times in Queensland');
});

test('several jurisdictions and days are said together', () => {
  assert.equal(words('/antiochian+greek'), 'Antiochian and Greek Orthodox parishes and times');
  assert.equal(words('/antiochian+greek+serbian/liturgy'), 'Antiochian, Greek and Serbian Orthodox Liturgies');
  assert.equal(words('/wed+fri/vespers'), 'Orthodox Vespers on Wednesdays and Fridays');
  assert.equal(W.jurisLabel('russian'), 'Russian Orthodox (ROCOR)');
  assert.equal(W.jurisLabel(null), 'Orthodox');
});
