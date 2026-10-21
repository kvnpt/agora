// What a person keeps (public/shared/saved.js): one shape for the page and
// the Worker, and a merge that adds a visitor's things to an account's.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const SV = require('../public/shared/saved.js');

test('the keys are the ones the page has always written', () => {
  assert.deepEqual(SV.KEYS, {
    favourites: 'agora-favourites', lists: 'agora-lists', bookmarks: 'agora-bookmarks', views: 'agora-saved-filters',
  });
});

test('clean keeps the four parts and drops what is not one of their items', () => {
  const d = SV.clean({
    favourites: [{ id: 'a', at: 2 }, { id: 'a', at: 1 }, { at: 3 }, 'x', { id: 'b', at: 5 }],
    lists: [{ id: 'fav', name: 'x', ids: [] }, { id: 'l1', name: '', ids: ['a', 'a', 7, null] }],
    bookmarks: [{ id: 3, kind: 'rule', at: 1 }, { id: 4, kind: 'parish' }],
    views: [{ path: '/greek', url: 'https://x/greek', at: 1 }, { path: '/' }, { path: '//evil.example' }, { path: 'rel' }],
    extra: 'dropped',
  });
  assert.deepEqual(d.favourites, [{ id: 'b', at: 5 }, { id: 'a', at: 2 }]);
  assert.deepEqual(d.lists, [{ id: 'l1', name: 'My list', ids: ['a', '7'], at: 0 }]);
  assert.deepEqual(d.bookmarks, [{ id: '3', kind: 'rule', at: 1 }]);
  assert.deepEqual(d.views, [{ path: '/greek', at: 1 }]);
  assert.deepEqual(Object.keys(d), ['favourites', 'lists', 'bookmarks', 'views']);
  assert.deepEqual(SV.clean(null), { favourites: [], lists: [], bookmarks: [], views: [] });
});

test('clean caps every part', () => {
  const many = (n, f) => Array.from({ length: n }, (_, i) => f(i));
  const d = SV.clean({
    favourites: many(600, i => ({ id: `p${i}`, at: i + 1 })),
    lists: many(60, i => ({ id: `l${i}`, name: `L${i}`, ids: many(600, j => `p${j}`), at: i + 1 })),
  });
  assert.equal(d.favourites.length, SV.LIMITS.favourites);
  assert.equal(d.favourites[0].id, 'p599', 'newest kept');
  assert.equal(d.lists.length, SV.LIMITS.lists);
  assert.equal(d.lists[0].ids.length, SV.LIMITS.listIds);
  assert.ok(JSON.stringify(d).length < SV.MAX_BYTES);
});

test('merge is everything in either, an item in both keeping when it was first added', () => {
  const account = {
    favourites: [{ id: 'a', at: 10 }],
    bookmarks: [{ id: '1', kind: 'event', at: 5 }],
    views: [{ path: '/greek', at: 3 }],
    lists: [{ id: 'l1', name: 'Sydney', ids: ['a', 'b'], at: 4 }],
  };
  const browser = {
    favourites: [{ id: 'a', at: 7 }, { id: 'c', at: 8 }],
    bookmarks: [{ id: '1', kind: 'rule', at: 6 }],
    views: [{ path: '/greek', at: 9 }, { path: '/talks', at: 2 }],
    lists: [{ id: 'l9', name: 'sydney', ids: ['b', 'c'], at: 2, about: 'Near work' }, { id: 'l8', name: 'Melbourne', ids: ['m'], at: 1 }],
  };
  const m = SV.merge(account, browser);
  assert.deepEqual(m.favourites, [{ id: 'c', at: 8 }, { id: 'a', at: 7 }]);
  assert.deepEqual(m.bookmarks.map(b => `${b.kind}:${b.id}`).sort(), ['event:1', 'rule:1']);
  assert.deepEqual(m.views, [{ path: '/greek', at: 3 }, { path: '/talks', at: 2 }]);
  assert.deepEqual(m.lists, [
    { id: 'l1', name: 'Sydney', ids: ['a', 'b'], at: 4 },
    { id: 'l9', name: 'sydney', ids: ['b', 'c'], at: 2, about: 'Near work' },
    { id: 'l8', name: 'Melbourne', ids: ['m'], at: 1 },
  ], 'two lists of one name are two lists');
  const again = SV.merge({ lists: [{ id: 'l1', name: 'Sydney', ids: ['a'], at: 4 }] }, { lists: [{ id: 'l1', name: 'Sydney', ids: ['b'], at: 3, about: 'x' }] });
  assert.deepEqual(again.lists, [{ id: 'l1', name: 'Sydney', ids: ['a', 'b'], at: 3, about: 'x' }], 'one list by id holds both');
  assert.ok(SV.same(SV.merge(m, m), m), 'merging a copy with itself changes nothing');
});

test('isEmpty and same', () => {
  assert.ok(SV.isEmpty({}));
  assert.ok(!SV.isEmpty({ favourites: [{ id: 'a' }] }));
  assert.ok(SV.same({ views: [{ path: '/x', url: 'https://o/x', at: 1 }] }, { views: [{ path: '/x', at: 1 }] }));
});
