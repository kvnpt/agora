// A poster of several pictures (public/shared/posters.js): how its value
// holds them, and the gallery the page, a link's painted card and the editor
// all draw from it. Kevin, 27 Nov 2026: "I want posters to follow the
// insta-style multi-pic format when there's multiple ones instead of the
// combining we've been doing." The swipe itself is the browser's, and is
// checked in one (docs/browser-checks.md); here, the markup and the counting.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const P = require('../public/shared/posters.js');

const A = '/posters/ev-1.1764200000-1.jpg';
const B = '/posters/ev-1.1764200000-2.jpg';
const C = '/posters/ev-1.1764200000-3.png';

test('one picture is its path, as a poster always was; several are a list of them', () => {
  assert.deepEqual(P.list(A), [A]);
  assert.deepEqual(P.list(` ${A} `), [A]);
  assert.deepEqual(P.list(JSON.stringify([A, B])), [A, B]);
  assert.deepEqual(P.list([A, '', null, B]), [A, B]);
  assert.deepEqual(P.list(null), []);
  assert.deepEqual(P.list(''), []);
  assert.deepEqual(P.list('[not json'), [], 'a broken list is no pictures, never a path');
  assert.deepEqual(P.list('["/posters/a.jpg", 3, ""]'), ['/posters/a.jpg'], 'only paths in it count');

  assert.equal(P.first(JSON.stringify([B, A])), B, 'the cover is the first');
  assert.equal(P.first(null), null);
  assert.equal(P.count(JSON.stringify([A, B, C])), 3);
  assert.equal(P.isGallery(A), false);
  assert.equal(P.isGallery(JSON.stringify([A, B])), true);
  assert.equal(P.isGallery(JSON.stringify([A])), false, 'a list of one is one picture');
});

test('a value is written the one way: null, a path, or a list of each once, the first ten', () => {
  assert.equal(P.valueOf([]), null);
  assert.equal(P.valueOf([A]), A, 'one is its path, so nothing that reads a path changes');
  assert.equal(P.valueOf([A, B]), JSON.stringify([A, B]));
  assert.equal(P.valueOf([A, B, A]), JSON.stringify([A, B]), 'each once, in order');
  assert.equal(P.valueOf([A, A]), A);
  assert.equal(P.valueOf(JSON.stringify([A, B])), JSON.stringify([A, B]), 'a value is its own value');
  const twelve = Array.from({ length: 12 }, (_, i) => `/posters/p-${i}.jpg`);
  assert.equal(P.count(P.valueOf(twelve)), P.MAX);
  assert.equal(P.MAX, 10);
});

test('the gallery: a picture at a time, a dot for each, the first one shown', () => {
  const v = JSON.stringify([A, B, C]);
  const html = P.galleryHTML(v);
  const count = (re) => (html.match(re) || []).length;
  assert.equal(count(/class="pg-pic"/g), 3);
  assert.equal(count(/class="pg-dot( on)?"/g), 3);
  assert.equal(count(/class="pg-dot on"/g), 1, 'one dot lit');
  assert.match(html, /data-pg-to="0" aria-label="Picture 1" aria-current="true"/);
  assert.match(html, /data-pg-n="3"/);
  // Each picture a link to itself, so a painted card opens it before any
  // script has come; the page's click opens its viewer at that picture.
  assert.match(html, new RegExp(`<a class="pg-pic" href="${B}" target="_blank" rel="noopener" data-poster="[^"]+" data-poster-at="1"`));
  assert.match(html, /aria-label="Picture 2 of 3, full size"/);
  // The first two asked for now, the rest as the gallery comes near them.
  assert.equal(count(/loading="lazy"/g), 1);
  assert.match(html, new RegExp(`src="${C}" alt="" loading="lazy"`));
  // No way back from the first picture.
  assert.match(html, /class="pg-arrow pg-prev" data-pg-step="-1" aria-label="Previous picture" hidden>/);
  assert.match(html, /class="pg-arrow pg-next" data-pg-step="1" aria-label="Next picture">/);
  // An island, named by its pictures: the same poster drawn again is left as it is.
  assert.match(html, new RegExp(`data-keep="pg ${v.replace(/"/g, '&quot;').replace(/[[\]/.]/g, '\\$&')}"`));
});

test('nothing for no pictures; the same markup however the poster is given', () => {
  assert.equal(P.galleryHTML(null), '');
  assert.equal(P.galleryHTML(''), '');
  assert.equal(P.galleryHTML([A, B]), P.galleryHTML(JSON.stringify([A, B])));
  // A name that could break out of an attribute is written as text.
  const odd = P.galleryHTML(['/posters/a"b<c>.jpg', B]);
  assert.ok(!odd.includes('a"b<c>'), 'escaped');
  assert.match(odd, /a&quot;b&lt;c&gt;\.jpg/);
});

test('in a viewer or the editor: no island, no links, each picture says its place', () => {
  const html = P.galleryHTML([A, B], { cls: 'pg-view', keep: false, link: false, picAttrs: (src, i) => `data-i="${i}"` });
  assert.ok(!html.includes('data-keep'));
  assert.ok(!html.includes('<a '));
  assert.match(html, /^<div class="pg pg-view"/);
  assert.match(html, /<div class="pg-pic" data-poster-at="0"><img src="[^"]+" alt="" data-i="0"><\/div>/);
  assert.match(html, /<div class="pg-pic" data-poster-at="1"><img src="[^"]+" alt="" data-i="1"><\/div>/);
});

test('a small picture of a poster of several is marked, as Instagram marks a post of several', () => {
  assert.equal(P.markHTML(A), '');
  assert.equal(P.markHTML(null), '');
  assert.match(P.markHTML(JSON.stringify([A, B])), /^<span class="pg-mark" aria-label="2 pictures" title="2 pictures"><svg/);
  assert.match(P.markHTML(4), /aria-label="4 pictures"/, 'or given how many');
  assert.equal(P.markHTML(1), '');
});

test('a link’s painted card draws the gallery the page draws, to the letter', async () => {
  const { posterHTML } = await import('../worker/lib/page-card.mjs');
  const v = JSON.stringify([A, B]);
  // next.js eventCard: the page's own markup for the same poster.
  const page = (value, offCls = '', stamp = '') => `<div class="ev-poster ev-gallery${offCls}">${P.galleryHTML(value)}${stamp}</div>`;
  assert.equal(posterHTML(v), page(v));
  assert.equal(posterHTML(v, ' off', '<span class="off-veil"></span>'), page(v, ' off', '<span class="off-veil"></span>'));
  // One picture as it always was.
  assert.match(posterHTML(A), new RegExp(`^<a class="ev-poster" href="${A}"`));
});

// ── Live: dots and arrows follow the scroll ──
//
// A stand-in gallery with just what sync, indexOf and go touch.

function fakeGallery(n, { width = 300 } = {}) {
  const cls = (on = false) => {
    const set = new Set(on ? ['on'] : []);
    return { toggle: (c, v) => (v ? set.add(c) : set.delete(c)), contains: (c) => set.has(c), has: set };
  };
  const imgs = Array.from({ length: n }, (_, i) => ({ loading: i > 1 ? 'lazy' : 'eager' }));
  const children = imgs.map(img => ({ querySelector: (q) => (q === 'img[loading="lazy"]' && img.loading === 'lazy' ? img : null) }));
  const dots = Array.from({ length: n }, (_, i) => {
    const attrs = new Map(i ? [] : [['aria-current', 'true']]);
    return { classList: cls(!i), setAttribute: (k, v) => attrs.set(k, v), removeAttribute: (k) => attrs.delete(k), attrs };
  });
  const track = {
    children, clientWidth: width, scrollLeft: 0, scrolled: [],
    scrollTo(o) { this.scrolled.push(o); this.scrollLeft = o.left; },
  };
  const prev = { hidden: true }, next = { hidden: false };
  const g = {
    dataset: {},
    querySelector: (q) => ({ '.pg-track': track, '.pg-prev': prev, '.pg-next': next }[q] || null),
    querySelectorAll: (q) => (q === '.pg-dot' ? dots : []),
  };
  return { g, track, dots, prev, next, imgs };
}

test('which picture shows is where the row is scrolled, to the nearest picture', () => {
  const { g, track } = fakeGallery(3);
  assert.equal(P.indexOf(g), 0);
  track.scrollLeft = 290;
  assert.equal(P.indexOf(g), 1, 'nearly there is there');
  track.scrollLeft = 2000;
  assert.equal(P.indexOf(g), 2, 'never past the last');
  track.clientWidth = 0;
  assert.equal(P.indexOf(g), 0, 'not laid out yet: the first');
});

test('the dots, the arrows and the pictures either side follow the picture showing', () => {
  const { g, track, dots, prev, next, imgs } = fakeGallery(4);
  track.scrollLeft = 600;
  P.sync(g);
  assert.deepEqual(dots.map(d => d.classList.contains('on')), [false, false, true, false]);
  assert.deepEqual(dots.map(d => d.attrs.get('aria-current') || null), [null, null, 'true', null]);
  assert.equal(prev.hidden, false);
  assert.equal(next.hidden, false);
  assert.equal(imgs[3].loading, 'eager', 'the next one asked for before it slides in');
  assert.equal(g.dataset.pgAt, '2');
  track.scrollLeft = 900;
  P.sync(g);
  assert.equal(next.hidden, true, 'nothing after the last');
});

test('a dot or an arrow moves the row a whole picture, never past either end', () => {
  const { g, track } = fakeGallery(3);
  P.go(g, 2, false);
  assert.deepEqual(track.scrolled.at(-1), { left: 600, behavior: 'auto' });
  P.go(g, 9, false);
  assert.equal(track.scrolled.at(-1).left, 600);
  P.go(g, -1, false);
  assert.equal(track.scrolled.at(-1).left, 0);
});
