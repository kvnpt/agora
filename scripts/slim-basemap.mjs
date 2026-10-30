// Take out of the basemap archive what the map never draws.
//
//   node scripts/slim-basemap.mjs in.pmtiles out.pmtiles
//
// The archive is Protomaps' general-purpose extract of OpenStreetMap, made for
// any style. Ours paints only some kinds of landuse (parks and bush, schools,
// hospitals, industrial ground, beaches and the like) and leaves the rest as
// the plain background: residential above all, then commercial, sports pitches,
// farmland, wetland, railway land. Those shapes rode along in every tile, 15 to
// 40% of its points around Sydney and Melbourne (measured 30 Oct 2026), drawn
// by nobody. This keeps every layer as it is and drops only landuse features
// whose `kind` no landuse layer of either style (public/lib/
// protomaps-themes-base.js for light, public/protomaps-dark.json for dark)
// asks for. The map looks exactly the same; the tiles are smaller.
//
// The kinds come from the styles every run, so a style that starts painting
// residential needs only a fresh build (.github/workflows/basemap.yml) to get
// its shapes back. Nothing else is decoded or re-encoded: a tile's bytes are
// copied but for the dropped features, so geometry cannot change.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  HEADER_BYTES, parseHeader, writeHeader, parseDirectory, decompress, buildDirectories,
} from '../worker/lib/pmtiles.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// ── Which landuse the styles draw ───────────────────────────────────────

// A filter's own vocabulary, not kinds of land.
const EXPRESSION_WORDS = new Set(['in', '!in', '==', '!=', 'any', 'all', 'none', '!', 'get', 'has', 'literal', 'match', 'case', 'coalesce', 'kind']);

/** Every string a landuse layer's filter names, in both styles: the kinds to keep. */
export function drawnLanduseKinds() {
  const ctx = {};
  vm.createContext(ctx);
  const themes = vm.runInContext(
    fs.readFileSync(path.join(ROOT, 'public/lib/protomaps-themes-base.js'), 'utf8') + '\n;protomaps_themes_base', ctx);
  const light = themes.default('protomaps', 'light');
  const dark = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/protomaps-dark.json'), 'utf8'));
  const kinds = new Set();
  const walk = (v) => {
    if (typeof v === 'string' && !EXPRESSION_WORDS.has(v)) kinds.add(v);
    else if (Array.isArray(v)) v.forEach(walk);
  };
  for (const layer of [...light, ...dark]) {
    if (layer['source-layer'] === 'landuse') walk(layer.filter);
  }
  return kinds;
}

// ── Protobuf, just enough to copy fields ────────────────────────────────

function varint(buf, pos) {
  let result = 0, mult = 1, b;
  do { b = buf[pos++]; result += (b & 0x7f) * mult; mult *= 128; } while (b & 0x80);
  return [result, pos];
}

function encodeVarint(n) {
  const out = [];
  while (n >= 0x80) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
  return Buffer.from(out);
}

/** Each field of a message: its tag, and where it and (for bytes) its payload sit. */
function fields(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const start = pos;
    let key;
    [key, pos] = varint(buf, pos);
    const tag = Math.floor(key / 8), wire = key & 7;
    let body = null;
    if (wire === 0) [, pos] = varint(buf, pos);
    else if (wire === 1) pos += 8;
    else if (wire === 5) pos += 4;
    else if (wire === 2) {
      let len;
      [len, pos] = varint(buf, pos);
      body = buf.subarray(pos, pos + len);
      pos += len;
    } else throw new Error(`slim-basemap: wire type ${wire} in a tile`);
    out.push({ tag, start, end: pos, body });
  }
  return out;
}

// Vector tile fields (https://github.com/mapbox/vector-tile-spec, 2.1).
const TILE_LAYER = 3;
const LAYER_NAME = 1, LAYER_FEATURE = 2, LAYER_KEY = 3, LAYER_VALUE = 4;
const FEATURE_TAGS = 2;
const VALUE_STRING = 1;

/** A landuse layer without the features of kinds not in `keep`; null if it drops none. */
function slimLanduse(layer, keep) {
  const fs_ = fields(layer);
  const keys = fs_.filter(f => f.tag === LAYER_KEY).map(f => f.body.toString('utf8'));
  const values = fs_.filter(f => f.tag === LAYER_VALUE).map((f) => {
    const s = fields(f.body).find(v => v.tag === VALUE_STRING);
    return s ? s.body.toString('utf8') : null;
  });
  const kindKey = keys.indexOf('kind');
  if (kindKey < 0) return null;
  const drop = new Set();
  for (const f of fs_) {
    if (f.tag !== LAYER_FEATURE) continue;
    const tags = fields(f.body).find(t => t.tag === FEATURE_TAGS);
    if (!tags) continue;
    for (let pos = 0; pos < tags.body.length;) {
      let k, v;
      [k, pos] = varint(tags.body, pos);
      [v, pos] = varint(tags.body, pos);
      if (k === kindKey) {
        if (values[v] != null && !keep.has(values[v])) drop.add(f);
        break;
      }
    }
  }
  if (!drop.size) return null;
  return Buffer.concat(fs_.filter(f => !drop.has(f)).map(f => layer.subarray(f.start, f.end)));
}

/**
 * One tile's bytes (uncompressed) without the landuse nobody draws. Every
 * other byte is the tile's own. Returns the input itself when nothing goes.
 */
export function slimTile(tile, keep) {
  const parts = [];
  let changed = false;
  for (const f of fields(tile)) {
    if (f.tag === TILE_LAYER) {
      const name = fields(f.body).find(l => l.tag === LAYER_NAME);
      if (name && name.body.toString('utf8') === 'landuse') {
        const slim = slimLanduse(f.body, keep);
        if (slim) {
          parts.push(encodeVarint(TILE_LAYER * 8 + 2), encodeVarint(slim.length), slim);
          changed = true;
          continue;
        }
      }
    }
    parts.push(tile.subarray(f.start, f.end));
  }
  return changed ? Buffer.concat(parts) : tile;
}

// ── The archive ─────────────────────────────────────────────────────────

/** Every tile entry of the archive at `fd`, in tile-id order, through its leaves. */
async function allEntries(fd, header) {
  const read = (offset, length) => {
    const b = Buffer.alloc(length);
    fs.readSync(fd, b, 0, length, offset);
    return b;
  };
  const dir = async (offset, length) =>
    parseDirectory(await decompress(read(offset, length), header.internalCompression));
  const out = [];
  const visit = async (entries) => {
    for (const e of entries) {
      if (e.runLength > 0) out.push(e);
      else await visit(await dir(header.leafOffset + e.offset, e.length));
    }
  };
  await visit(await dir(header.rootOffset, header.rootLength));
  return { entries: out, read };
}

export async function slimArchive(inPath, outPath, { log = () => {} } = {}) {
  const keep = drawnLanduseKinds();
  const fd = fs.openSync(inPath, 'r');
  const head = Buffer.alloc(HEADER_BYTES);
  fs.readSync(fd, head, 0, HEADER_BYTES, 0);
  const header = parseHeader(head);
  if (header.tileType !== 1) throw new Error('slim-basemap: not a vector tile archive');
  const gzipped = header.tileCompression === 2;
  const { entries, read } = await allEntries(fd, header);
  log(`${entries.length} entries; keeping landuse kinds: ${[...keep].sort().join(', ')}`);

  // Tile data to a file of its own as it is made, then everything after it.
  const dataPath = `${outPath}.data`;
  const out = fs.openSync(dataPath, 'w');
  const moved = new Map();   // old offset -> new entry fields: a repeated tile stays one copy
  const newEntries = [];
  let at = 0, before = 0, after = 0;
  for (const [i, e] of entries.entries()) {
    let m = moved.get(e.offset);
    if (!m) {
      const raw = read(header.dataOffset + e.offset, e.length);
      const tile = gzipped ? zlib.gunzipSync(raw) : raw;
      const slim = slimTile(tile, keep);
      const bytes = slim === tile ? raw : (gzipped ? zlib.gzipSync(slim) : slim);
      fs.writeSync(out, bytes, 0, bytes.length, at);
      m = { offset: at, length: bytes.length };
      moved.set(e.offset, m);
      at += bytes.length;
      before += e.length;
      after += bytes.length;
    }
    newEntries.push({ tileId: e.tileId, runLength: e.runLength, ...m });
    if (i % 25000 === 0) log(`  ${i} / ${entries.length}`);
  }
  fs.closeSync(out);

  const { root, leaves } = await buildDirectories(newEntries);
  const metadata = read(header.metadataOffset, header.metadataLength);
  const h = {
    ...header,
    rootOffset: HEADER_BYTES, rootLength: root.length,
    metadataOffset: HEADER_BYTES + root.length, metadataLength: metadata.length,
    leafOffset: HEADER_BYTES + root.length + metadata.length, leafLength: leaves.length,
    dataOffset: HEADER_BYTES + root.length + metadata.length + leaves.length, dataLength: at,
    tileEntries: newEntries.length, tileContents: moved.size, clustered: true,
  };
  const file = fs.openSync(outPath, 'w');
  let pos = 0;
  for (const part of [writeHeader(h), root, metadata, leaves]) {
    fs.writeSync(file, part, 0, part.length, pos);
    pos += part.length;
  }
  // Append the tile data in chunks.
  const data = fs.openSync(dataPath, 'r');
  const chunk = Buffer.alloc(8 << 20);
  for (let off = 0; off < at;) {
    const n = fs.readSync(data, chunk, 0, Math.min(chunk.length, at - off), off);
    fs.writeSync(file, chunk, 0, n, pos);
    pos += n; off += n;
  }
  fs.closeSync(data);
  fs.closeSync(file);
  fs.closeSync(fd);
  fs.unlinkSync(dataPath);
  return { tiles: moved.size, before, after, bytes: pos };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const [inPath, outPath] = process.argv.slice(2);
  if (!inPath || !outPath) {
    console.error('usage: node scripts/slim-basemap.mjs in.pmtiles out.pmtiles');
    process.exit(2);
  }
  const r = await slimArchive(inPath, outPath, { log: (s) => console.log(s) });
  const mb = (n) => (n / 1e6).toFixed(1);
  console.log(`${r.tiles} tiles: ${mb(r.before)} MB of tile data -> ${mb(r.after)} MB (${Math.round(100 - 100 * r.after / r.before)}% smaller); archive ${mb(r.bytes)} MB`);
}
