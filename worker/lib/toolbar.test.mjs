// The toolbar's rows (public/shared/toolbar.js): the feed and the parish card
// lay theirs out from one function, so the two stop drifting apart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rowsHTML } = require('../../public/shared/toolbar.js');

const slots = (html) => [...html.matchAll(/data-filter-slot="(\w+)" data-filter-scope="(\w+)"/g)].map(m => `${m[1]}:${m[2]}`);

test('both toolbars have the same slots in the same order, each over its own filter set', () => {
  assert.deepEqual(slots(rowsHTML('main')), ['lang:main', 'kind:main', 'bookmarks:main', 'when:main']);
  assert.deepEqual(slots(rowsHTML('parish')), ['lang:parish', 'kind:parish', 'bookmarks:parish', 'when:parish']);
});

test('language, kind and bookmarks share a row; When has the next one to itself', () => {
  const [pills, when] = rowsHTML('parish').split('<div class="mode-bar-row mode-bar-row-when">');
  assert.match(pills, /^<div class="mode-bar-row mode-bar-row-pills">/);
  assert.deepEqual(slots(pills), ['lang:parish', 'kind:parish', 'bookmarks:parish']);
  assert.deepEqual(slots(when), ['when:parish']);
});

test("the feed's extras go where its rows put them", () => {
  const html = rowsHTML('main', { pillsId: 'p', pillsEnd: '<i id="save"></i>', whenStart: '<i id="tt"></i>' });
  assert.match(html, /id="p"/);
  assert.ok(html.indexOf('data-filter-slot="bookmarks"') < html.indexOf('id="save"'));
  assert.ok(html.indexOf('id="save"') < html.indexOf('mode-bar-row-when'));
  assert.ok(html.indexOf('id="tt"') < html.indexOf('data-filter-slot="when"'));
});
