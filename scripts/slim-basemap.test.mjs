// The basemap slimmer drops only landuse the styles never paint, and leaves
// every other byte of a tile as it was.

import test from 'node:test';
import assert from 'node:assert/strict';
import { drawnLanduseKinds, slimTile } from './slim-basemap.mjs';

// ── A tiny vector-tile writer and reader, enough for these tiles ────────

const varint = (n) => { const o = []; while (n >= 0x80) { o.push((n % 128) | 0x80); n = Math.floor(n / 128); } o.push(n); return o; };
const bytesField = (tag, body) => Buffer.from([...varint(tag * 8 + 2), ...varint(body.length), ...body]);
const varintField = (tag, n) => Buffer.from([...varint(tag * 8), ...varint(n)]);
const str = (s) => Buffer.from(s, 'utf8');

function feature(id, tags) {
  return Buffer.concat([
    varintField(1, id),
    bytesField(2, Buffer.from(tags.flatMap(varint))),
    varintField(3, 3),                                   // polygon
    bytesField(4, Buffer.from([9, 0, 0, 26, 2, 0, 0, 2, 3, 0, 15].flatMap(varint))),
  ]);
}

function layer(name, keys, values, features) {
  return Buffer.concat([
    varintField(15, 2),
    bytesField(1, str(name)),
    ...features.map(f => bytesField(2, f)),
    ...keys.map(k => bytesField(3, str(k))),
    ...values.map(v => bytesField(4, bytesField(1, str(v)))),
    varintField(5, 4096),
  ]);
}

/** The kinds of a tile's landuse features, in order (null where a feature has none). */
function landuseKinds(tile) {
  const read = (buf) => {
    const out = [];
    for (let pos = 0; pos < buf.length;) {
      let key = 0, mult = 1, b;
      do { b = buf[pos++]; key += (b & 0x7f) * mult; mult *= 128; } while (b & 0x80);
      const tag = Math.floor(key / 8), wire = key & 7;
      if (wire === 0) { do { b = buf[pos++]; } while (b & 0x80); out.push({ tag }); continue; }
      let len = 0; mult = 1;
      do { b = buf[pos++]; len += (b & 0x7f) * mult; mult *= 128; } while (b & 0x80);
      out.push({ tag, body: buf.subarray(pos, pos + len) });
      pos += len;
    }
    return out;
  };
  for (const l of read(tile).filter(f => f.tag === 3)) {
    const fs = read(l.body);
    if (fs.find(f => f.tag === 1).body.toString() !== 'landuse') continue;
    const keys = fs.filter(f => f.tag === 3).map(f => f.body.toString());
    const values = fs.filter(f => f.tag === 4).map(f => read(f.body)[0].body.toString());
    return fs.filter(f => f.tag === 2).map((f) => {
      const tags = read(f.body).find(t => t.tag === 2).body;
      const nums = [];
      for (let p = 0; p < tags.length;) { let n = 0, m = 1, b; do { b = tags[p++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); nums.push(n); }
      for (let i = 0; i < nums.length; i += 2) if (keys[nums[i]] === 'kind') return values[nums[i + 1]];
      return null;
    });
  }
  return null;
}

// keys: kind, name. values: residential, park, Parramatta Park.
const LANDUSE = layer('landuse', ['kind', 'name'], ['residential', 'park', 'Parramatta Park'], [
  feature(1, [0, 0]),          // residential
  feature(2, [0, 1, 1, 2]),    // park, named
  feature(3, [1, 2]),          // no kind at all
  feature(4, [0, 0]),          // residential
]);
const ROADS = layer('roads', ['kind'], ['major_road'], [feature(9, [0, 0])]);
const TILE = Buffer.concat([bytesField(3, ROADS), bytesField(3, LANDUSE)]);

test('the styles paint parks and schools, and never residential land', () => {
  const kinds = drawnLanduseKinds();
  for (const k of ['park', 'wood', 'nature_reserve', 'school', 'hospital', 'industrial', 'beach']) assert.ok(kinds.has(k), k);
  for (const k of ['residential', 'commercial', 'farmland', 'pitch']) assert.ok(!kinds.has(k), k);
  for (const w of ['in', '==', 'kind']) assert.ok(!kinds.has(w), `not the filter's own word "${w}"`);
});

test('only landuse of a kind nobody draws goes; every other byte stays', () => {
  const slim = slimTile(TILE, new Set(['park']));
  assert.deepEqual(landuseKinds(TILE), ['residential', 'park', null, 'residential']);
  assert.deepEqual(landuseKinds(slim), ['park', null], 'a feature with no kind is kept');
  assert.ok(slim.includes(bytesField(3, ROADS)), 'the roads layer is byte for byte the same');
  assert.ok(slim.length < TILE.length);
});

test('a tile with nothing to drop comes back as itself', () => {
  assert.equal(slimTile(TILE, new Set(['park', 'residential'])), TILE);
  const noLanduse = bytesField(3, ROADS);
  assert.equal(slimTile(noLanduse, new Set()), noLanduse);
});
