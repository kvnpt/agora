// A box drawn again keeps what it already has (public/shared/morph.js): the
// rows still wanted are the same elements, moved if they must be, and a
// picture is never made twice. Run here on a stand-in tree, with just enough
// of a DOM for the matching; the page's own use of it is checked in a browser
// (docs/browser-checks.md).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { morphInto, keyOf } = require('../public/shared/morph.js');

class Node {
  constructor(type) { this.nodeType = type; this.parentNode = null; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get nextSibling() { const s = this.parentNode ? this.parentNode.childNodes : []; return s[s.indexOf(this) + 1] || null; }
  insertBefore(n, ref) {
    if (n.parentNode) n.parentNode.removeChild(n);
    const at = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    assert.notEqual(at, -1, 'insertBefore: the reference is a child');
    this.childNodes.splice(at, 0, n);
    n.parentNode = this;
    return n;
  }
  removeChild(n) {
    const at = this.childNodes.indexOf(n);
    assert.notEqual(at, -1, 'removeChild: a child');
    this.childNodes.splice(at, 1);
    n.parentNode = null;
    return n;
  }
  replaceChild(n, old) { this.insertBefore(n, old); this.removeChild(old); return old; }
}
class Text extends Node {
  constructor(v) { super(3); this.nodeValue = v; }
  isEqualNode(o) { return o.nodeType === 3 && o.nodeValue === this.nodeValue; }
}
class El extends Node {
  constructor(tag, attrs = {}) { super(1); this.tagName = tag.toUpperCase(); this.a = new Map(Object.entries(attrs)); }
  get attributes() { return [...this.a].map(([name, value]) => ({ name, value })); }
  getAttribute(k) { return this.a.has(k) ? this.a.get(k) : null; }
  hasAttribute(k) { return this.a.has(k); }
  setAttribute(k, v) { this.a.set(k, String(v)); }
  removeAttribute(k) { this.a.delete(k); }
  querySelectorAll(sel) {
    assert.equal(sel, 'img');
    const out = [];
    const walk = (n) => n.childNodes.forEach(c => { if (c.tagName === 'IMG') out.push(c); walk(c); });
    walk(this);
    return out;
  }
  isEqualNode(o) {
    return o.nodeType === 1 && o.tagName === this.tagName && o.a.size === this.a.size && [...this.a].every(([k, v]) => o.a.get(k) === v)
      && o.childNodes.length === this.childNodes.length && this.childNodes.every((c, i) => c.isEqualNode(o.childNodes[i]));
  }
}
/** h('div', { class: 'x' }, child, 'text', …) */
const h = (tag, attrs = {}, ...kids) => {
  const el = new El(tag, attrs);
  kids.flat().forEach(k => el.insertBefore(typeof k === 'string' ? new Text(k) : k, null));
  return el;
};
const say = (n) => (n.nodeType === 3 ? n.nodeValue
  : `<${n.tagName.toLowerCase()}${n.attributes.map(a => ` ${a.name}="${a.value}"`).join('')}>${n.childNodes.map(say).join('')}</${n.tagName.toLowerCase()}>`);
const inside = (n) => n.childNodes.map(say).join('');

const logo = (src) => h('img', { src, alt: '' });
const row = (id, title, src) => h('button', { class: 'erow', 'data-event': id }, h('span', { class: 'etitle' }, title), src ? logo(src) : []);

test('what names an element among its siblings', () => {
  assert.equal(keyOf(row('7', 'Vespers')), 'BUTTON data-event=7');
  assert.equal(keyOf(logo('/logos/a.jpg')), 'IMG src=/logos/a.jpg', 'a picture, by its address');
  assert.equal(keyOf(h('div', { class: 'slot' })), null, 'furniture has no name');
  assert.equal(keyOf(h('div', { 'data-keep': 'wk', id: 'x' })), 'DIV data-keep=wk', 'an island by its own name first');
  assert.equal(keyOf(new Text('x')), null);
});

test('a list that has not changed is not touched', () => {
  const make = () => h('div', {}, row('1', 'Matins', '/logos/a.jpg'), ' ', row('2', 'Liturgy', '/logos/b.jpg'));
  const box = make();
  const was = [...box.childNodes], pics = box.querySelectorAll('img');
  assert.equal(morphInto(box, make()), false, 'nothing changed');
  assert.deepEqual(box.childNodes, was);
  assert.deepEqual(box.querySelectorAll('img'), pics);
});

test('rows that change places move, with their pictures', () => {
  const box = h('div', {}, row('1', 'Matins', '/logos/a.jpg'), row('2', 'Liturgy', '/logos/b.jpg'), row('3', 'Vespers', '/logos/c.jpg'));
  const [r1, r2, r3] = box.childNodes;
  const pics = box.querySelectorAll('img');
  assert.equal(morphInto(box, h('div', {}, row('3', 'Vespers', '/logos/c.jpg'), row('1', 'Matins', '/logos/a.jpg'), row('2', 'Liturgy', '/logos/b.jpg'))), true);
  assert.deepEqual(box.childNodes, [r3, r1, r2], 'the same three elements, in the new order');
  assert.deepEqual(new Set(box.querySelectorAll('img')), new Set(pics), 'and the same three pictures');
});

test('a row that leaves goes, a new one comes in, the rest stay', () => {
  const box = h('div', {}, row('1', 'Matins'), row('2', 'Liturgy'), row('3', 'Vespers'));
  const [r1, , r3] = box.childNodes;
  morphInto(box, h('div', {}, row('1', 'Matins'), row('4', 'Compline'), row('3', 'Vespers')));
  assert.equal(box.childNodes[0], r1);
  assert.equal(box.childNodes[2], r3);
  assert.equal(inside(box), inside(h('div', {}, row('1', 'Matins'), row('4', 'Compline'), row('3', 'Vespers'))));
});

test('a row whose words or attributes changed is written in place', () => {
  const box = h('div', {}, row('1', 'Matins', '/logos/a.jpg'));
  const r = box.firstChild, pic = box.querySelectorAll('img')[0], title = r.firstChild;
  const next = row('1', 'Matins & Liturgy', '/logos/a.jpg');
  next.setAttribute('class', 'erow lit');
  next.setAttribute('aria-current', 'true');
  r.setAttribute('style', '--pc:red');
  assert.equal(morphInto(box, h('div', {}, next)), true);
  assert.equal(box.firstChild, r);
  assert.equal(r.firstChild, title, 'its title is the same element');
  assert.equal(say(r), '<button class="erow lit" data-event="1" aria-current="true"><span class="etitle">Matins & Liturgy</span><img src="/logos/a.jpg" alt=""></img></button>',
    'new words, the new attributes on, the one the markup dropped off');
  assert.equal(box.querySelectorAll('img')[0], pic, 'and its picture is not made again');
});

test('furniture is matched by its sort, so a heading added above leaves the rows below as they were', () => {
  const slot = (key, ...rows) => h('div', { class: 'slot', 'data-key': key }, rows);
  const box = h('div', {}, h('div', { class: 'tsub' }, 'Later today'), slot('18:00', row('1', 'Vespers', '/logos/a.jpg')), h('button', { class: 'see-all' }, 'Tomorrow'));
  const [sub, s, more] = box.childNodes;
  morphInto(box, h('div', {}, h('div', { class: 'eve' }, 'Evening'), h('div', { class: 'tsub' }, 'Later today'), slot('17:00', row('9', 'Paraklesis')),
    slot('18:00', row('1', 'Vespers', '/logos/a.jpg')), h('button', { class: 'see-all' }, 'Tomorrow')));
  assert.equal(box.childNodes.length, 5);
  assert.equal(box.childNodes[1], sub, 'the heading that was there');
  assert.equal(box.childNodes[3], s, 'the 6pm slot, not rebuilt as the 5pm one');
  assert.equal(box.childNodes[4], more);
});

test('an island is left exactly as it is, and replaced when its name changes', () => {
  const bar = (name, dots) => h('div', { class: 'wk', 'data-keep': name }, h('span', { class: 'dots' }, dots));
  const box = h('div', {}, bar('wk:2026-11-16', ''), h('div', { class: 'cu' }, 'Monday'));
  const island = box.firstChild;
  // What the page's scripts did to it since: none of it in any markup.
  island.setAttribute('class', 'wk mview open');
  island.firstChild.firstChild.nodeValue = '•••';
  assert.equal(morphInto(box, h('div', {}, bar('wk:2026-11-16', ''), h('div', { class: 'cu' }, 'Tuesday'))), true);
  assert.equal(box.firstChild, island);
  assert.equal(say(island), '<div class="wk mview open" data-keep="wk:2026-11-16"><span class="dots">•••</span></div>');
  assert.equal(say(box.childNodes[1]), '<div class="cu">Tuesday</div>', 'what is beside it is drawn');
  morphInto(box, h('div', {}, bar('wk:2026-11-17', ''), h('div', { class: 'cu' }, 'Tuesday')));
  assert.notEqual(box.firstChild, island, 'a new day, a new bar');
  assert.equal(box.childNodes.length, 2);
});

test('a picture in a row drawn afresh is the picture that was there', () => {
  // The 9am slot becomes the 9:30 one: its row is new, in a new slot.
  const slot = (key, ...rows) => h('div', { class: 'slot', 'data-key': key }, rows);
  const box = h('div', {}, slot('09:00', row('1:2026-11-22', 'Liturgy', '/logos/a.jpg')));
  const pic = box.querySelectorAll('img')[0];
  morphInto(box, h('div', {}, slot('09:30', row('1:2026-11-29', 'Liturgy', '/logos/a.jpg'))));
  assert.equal(box.querySelectorAll('img').length, 1);
  assert.equal(box.querySelectorAll('img')[0], pic, 'the same element, carried over');
  assert.equal(pic.parentNode.getAttribute('data-event'), '1:2026-11-29');
});

test('a different picture is a new element, never the old one given a new address', () => {
  const box = h('div', {}, h('span', { class: 'av' }, logo('/logos/a.jpg')));
  const pic = box.querySelectorAll('img')[0];
  morphInto(box, h('div', {}, h('span', { class: 'av' }, logo('/logos/b.jpg'))));
  const now = box.querySelectorAll('img')[0];
  assert.notEqual(now, pic);
  assert.equal(now.getAttribute('src'), '/logos/b.jpg');
  assert.equal(pic.getAttribute('src'), '/logos/a.jpg', 'the old one was not rewritten');
});

test('two of one name: the first is kept, the second made new, none left over', () => {
  const box = h('div', {}, row('1', 'Matins'), row('1', 'Matins again'), row('2', 'Liturgy'));
  const [first] = box.childNodes;
  morphInto(box, h('div', {}, row('2', 'Liturgy'), row('1', 'Matins')));
  assert.equal(box.childNodes.length, 2);
  assert.equal(box.childNodes[1], first);
  assert.equal(inside(box), inside(h('div', {}, row('2', 'Liturgy'), row('1', 'Matins'))));
});

test('an empty box fills, and a full one empties', () => {
  const box = h('div', {});
  assert.equal(morphInto(box, h('div', {}, row('1', 'Matins'))), true);
  assert.equal(box.childNodes.length, 1);
  assert.equal(morphInto(box, h('div', {})), true);
  assert.equal(box.childNodes.length, 0);
  assert.equal(morphInto(box, h('div', {})), false);
});

/** The old children `morphInto` took out and put back somewhere (a move), as it ran. */
function movesOf(box, to) {
  const moved = [], put = box.insertBefore.bind(box);
  box.insertBefore = (n, ref) => { if (n.parentNode === box) moved.push(n); return put(n, ref); };
  morphInto(box, to);
  delete box.insertBefore;
  return moved;
}

test('a row gone from the top moves none of the rows under it', () => {
  const box = h('div', {}, h('h3', { class: 'sday' }, 'Monday'), row('1', 'Matins'), row('2', 'Liturgy'), row('3', 'Vespers'), row('4', 'Compline'));
  const [, , r2, r3, r4] = box.childNodes;
  const moved = movesOf(box, h('div', {}, row('2', 'Liturgy'), row('3', 'Vespers'), row('4', 'Compline')));
  assert.deepEqual(moved, [], 'nothing was taken out and put back');
  assert.deepEqual(box.childNodes, [r2, r3, r4]);
});

test('only what is out of its order moves: one row sent to the bottom is one move', () => {
  const ids = ['1', '2', '3', '4', '5', '6'];
  const box = h('div', {}, ids.map(i => row(i, `Service ${i}`)));
  const was = [...box.childNodes];
  const moved = movesOf(box, h('div', {}, ['2', '3', '4', '5', '6', '1'].map(i => row(i, `Service ${i}`))));
  assert.deepEqual(moved, [was[0]], 'the one row, not the five it passed');
  assert.deepEqual(box.childNodes, [...was.slice(1), was[0]]);
});

test('one row brought to the top is one move too', () => {
  const box = h('div', {}, ['1', '2', '3', '4', '5', '6'].map(i => row(i, `Service ${i}`)));
  const was = [...box.childNodes];
  const moved = movesOf(box, h('div', {}, ['6', '1', '2', '3', '4', '5'].map(i => row(i, `Service ${i}`))));
  assert.deepEqual(moved, [was[5]], 'the one row, not the five it passed');
  assert.deepEqual(box.childNodes, [was[5], ...was.slice(0, 5)]);
});

test('whatever the old list and the new, the box reads as the new one and keeps every row it can', () => {
  let seed = 20261116;
  const rnd = (n) => {   // mulberry32: the same lists every run
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
  const some = () => {
    const kids = [], n = rnd(13);
    for (let i = 0; i < n; i++) {
      const what = rnd(10);
      if (what < 6) kids.push(row(String(rnd(7)), `Service ${rnd(3)}`, rnd(2) ? `/logos/${rnd(4)}.jpg` : null));   // names repeat now and then
      else if (what < 8) kids.push(h('h3', { class: rnd(2) ? 'sday' : 'slot' }, `Heading ${rnd(3)}`));
      else if (what < 9) kids.push(h('div', { 'data-keep': `wk:${rnd(2)}` }, 'kept'));
      else kids.push(`text ${rnd(3)}`);
    }
    return h('div', {}, kids);
  };
  let shared = 0;
  for (let run = 0; run < 2000; run++) {
    const box = some(), to = some(), want = inside(to);
    const names = (b) => new Map(b.childNodes.filter(c => keyOf(c) != null).reverse().map(c => [keyOf(c), c]));   // the first of each name
    const before = names(box), wanted = new Set(to.childNodes.map(keyOf).filter(k => k != null));
    shared += [...before.keys()].filter(k => wanted.has(k)).length;
    morphInto(box, to);
    // An island is left as it is, so read it as its markup would have it.
    const read = box.childNodes.map(c => (c.nodeType === 1 && c.hasAttribute('data-keep') ? say(h('div', { 'data-keep': c.getAttribute('data-keep') }, 'kept')) : say(c))).join('');
    assert.equal(read, want, `run ${run}`);
    for (const [k, n] of before) if (wanted.has(k)) assert.equal(n.parentNode, box, `run ${run}: ${k} is the element it was`);
  }
  assert.ok(shared > 2000, `the lists share rows often enough to mean something (${shared})`);
});

test('a part of a row that became another sort is made new, and nothing after it moves', () => {
  const erow = (cls) => h('button', { class: 'erow', 'data-event': '1' }, h('span', { class: cls }, '9am'), ' ', h('span', { class: 'ebody' }, 'Liturgy', logo('/logos/a.jpg')));
  const box = h('div', {}, erow('etime'));
  const r = box.childNodes[0], [, gap, body] = r.childNodes;
  const moved = movesOf(r, erow('etime same'));
  assert.deepEqual(moved, [], 'the words and the picture stayed where they were');
  assert.deepEqual(r.childNodes.slice(1), [gap, body]);
  assert.equal(r.childNodes[0].getAttribute('class'), 'etime same');
});
