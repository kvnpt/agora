// Reading (and, for scripts/slim-basemap.mjs, writing) a PMTiles v3 archive.
//
// The basemap is one archive in R2, tiles/oceania.pmtiles. The browser used to
// read it itself, a few kilobytes at a time with HTTP range requests (pmtiles.js
// in the page): the header, then a directory, then the tile, three trips in a
// row before the first tile, and Safari keeps no range response, so every visit
// asked for every tile again. The Worker reads it now (routes/assets.mjs,
// /tiles/oceania/{z}/{x}/{y}.mvt) and the browser gets each tile as an ordinary
// cacheable file. This is that reading: the header, the directories, and where
// a tile is. https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
//
// No dependencies: varints, a Hilbert curve and gzip (CompressionStream, which
// the Worker and Node both have).

export const HEADER_BYTES = 127;
/** What a reader fetches first: the header and, by the spec, the whole root directory. */
export const ROOT_BYTES = 16384;

const COMPRESSION = { unknown: 0, none: 1, gzip: 2, brotli: 3, zstd: 4 };

// ── Varints ─────────────────────────────────────────────────────────────

/** A cursor over bytes that reads protobuf-style varints (up to 2^53). */
export function reader(bytes) {
  let pos = 0;
  return {
    get pos() { return pos; },
    varint() {
      let result = 0, mult = 1, b;
      do {
        if (pos >= bytes.length) throw new Error('pmtiles: varint runs past the end');
        b = bytes[pos++];
        result += (b & 0x7f) * mult;
        mult *= 128;
      } while (b & 0x80);
      return result;
    },
  };
}

function pushVarint(out, n) {
  while (n >= 0x80) { out.push((n % 128) | 0x80); n = Math.floor(n / 128); }
  out.push(n);
}

// ── Tile ids ────────────────────────────────────────────────────────────

/**
 * A tile's id: every tile of the zooms above it, plus its place along the
 * zoom's Hilbert curve. Neighbours on the map are neighbours in the archive.
 */
export function zxyToTileId(z, x, y) {
  if (z > 26) throw new Error('pmtiles: zoom above 26');
  const n = 2 ** z;
  if (x < 0 || y < 0 || x >= n || y >= n) throw new Error('pmtiles: tile outside its zoom');
  let id = (n * n - 1) / 3;   // tiles in zooms 0..z-1
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (x & s) ? 1 : 0, ry = (y & s) ? 1 : 0;
    id += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { x = s - 1 - x; y = s - 1 - y; }
      [x, y] = [y, x];
    }
  }
  return id;
}

// ── Header ──────────────────────────────────────────────────────────────

/** The 127-byte header, as numbers. */
export function parseHeader(bytes) {
  if (bytes.length < HEADER_BYTES) throw new Error('pmtiles: header too short');
  const magic = String.fromCharCode(...bytes.subarray(0, 7));
  if (magic !== 'PMTiles' || bytes[7] !== 3) throw new Error('pmtiles: not a v3 archive');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = (o) => Number(dv.getBigUint64(o, true));
  const e7 = (o) => dv.getInt32(o, true) / 1e7;
  return {
    rootOffset: u64(8), rootLength: u64(16),
    metadataOffset: u64(24), metadataLength: u64(32),
    leafOffset: u64(40), leafLength: u64(48),
    dataOffset: u64(56), dataLength: u64(64),
    addressedTiles: u64(72), tileEntries: u64(80), tileContents: u64(88),
    clustered: bytes[96] === 1,
    internalCompression: bytes[97], tileCompression: bytes[98], tileType: bytes[99],
    minZoom: bytes[100], maxZoom: bytes[101],
    minLon: e7(102), minLat: e7(106), maxLon: e7(110), maxLat: e7(114),
    centerZoom: bytes[118], centerLon: e7(119), centerLat: e7(123),
  };
}

/** The header back to its 127 bytes. */
export function writeHeader(h) {
  const bytes = new Uint8Array(HEADER_BYTES);
  const dv = new DataView(bytes.buffer);
  bytes.set([...'PMTiles'].map(c => c.charCodeAt(0)));
  bytes[7] = 3;
  const u64 = (o, v) => dv.setBigUint64(o, BigInt(v), true);
  const e7 = (o, v) => dv.setInt32(o, Math.round(v * 1e7), true);
  u64(8, h.rootOffset); u64(16, h.rootLength);
  u64(24, h.metadataOffset); u64(32, h.metadataLength);
  u64(40, h.leafOffset); u64(48, h.leafLength);
  u64(56, h.dataOffset); u64(64, h.dataLength);
  u64(72, h.addressedTiles); u64(80, h.tileEntries); u64(88, h.tileContents);
  bytes[96] = h.clustered ? 1 : 0;
  bytes[97] = h.internalCompression; bytes[98] = h.tileCompression; bytes[99] = h.tileType;
  bytes[100] = h.minZoom; bytes[101] = h.maxZoom;
  e7(102, h.minLon); e7(106, h.minLat); e7(110, h.maxLon); e7(114, h.maxLat);
  bytes[118] = h.centerZoom; e7(119, h.centerLon); e7(123, h.centerLat);
  return bytes;
}

// ── Compression ─────────────────────────────────────────────────────────

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** Undo the archive's own compression of a directory or the metadata. */
export function decompress(bytes, compression) {
  if (compression === COMPRESSION.none || compression === COMPRESSION.unknown) return Promise.resolve(bytes);
  if (compression === COMPRESSION.gzip) return pipe(bytes, new DecompressionStream('gzip'));
  throw new Error(`pmtiles: compression ${compression} is not read here`);
}

export function gzip(bytes) {
  return pipe(bytes, new CompressionStream('gzip'));
}

// ── Directories ─────────────────────────────────────────────────────────

/**
 * A directory's entries, sorted by tileId: { tileId, offset, length,
 * runLength }. A runLength of 0 points at a leaf directory instead of a tile;
 * more than 1 is that many consecutive tiles with the same bytes.
 */
export function parseDirectory(bytes) {
  const r = reader(bytes);
  const n = r.varint();
  const entries = new Array(n);
  let id = 0;
  for (let i = 0; i < n; i++) { id += r.varint(); entries[i] = { tileId: id, offset: 0, length: 0, runLength: 1 }; }
  for (let i = 0; i < n; i++) entries[i].runLength = r.varint();
  for (let i = 0; i < n; i++) entries[i].length = r.varint();
  for (let i = 0; i < n; i++) {
    const v = r.varint();
    entries[i].offset = (v === 0 && i > 0) ? entries[i - 1].offset + entries[i - 1].length : v - 1;
  }
  return entries;
}

/** Entries back to directory bytes (uncompressed). */
export function serializeDirectory(entries) {
  const out = [];
  pushVarint(out, entries.length);
  let last = 0;
  for (const e of entries) { pushVarint(out, e.tileId - last); last = e.tileId; }
  for (const e of entries) pushVarint(out, e.runLength);
  for (const e of entries) pushVarint(out, e.length);
  entries.forEach((e, i) => {
    const prev = entries[i - 1];
    pushVarint(out, (i > 0 && e.offset === prev.offset + prev.length) ? 0 : e.offset + 1);
  });
  return Uint8Array.from(out);
}

/**
 * The entry that answers `tileId` in one directory: a tile's entry, a leaf
 * directory's (runLength 0) to look in next, or null when the archive has no
 * such tile (open sea, outside the region).
 */
export function findEntry(entries, tileId) {
  let lo = 0, hi = entries.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (entries[mid].tileId <= tileId) lo = mid + 1; else hi = mid - 1;
  }
  const e = entries[hi];
  if (!e) return null;
  if (e.runLength === 0) return e;
  return tileId < e.tileId + e.runLength ? e : null;
}

/**
 * Where one tile's bytes are, as { offset, length } from the start of the
 * archive, or null. `readLeaf(entry)` returns a leaf directory's parsed
 * entries (the caller decides how to fetch and keep them).
 */
export async function locateTile(header, root, tileId, readLeaf) {
  let entries = root;
  for (let depth = 0; depth < 4; depth++) {
    const e = findEntry(entries, tileId);
    if (!e) return null;
    if (e.runLength > 0) return { offset: header.dataOffset + e.offset, length: e.length };
    entries = await readLeaf(e);
  }
  throw new Error('pmtiles: directories nested too deep');
}

// ── Writing (scripts/slim-basemap.mjs) ──────────────────────────────────

/**
 * Root and leaf directories for `entries` (tile entries, sorted), compressed:
 * everything in the root when it fits beside the header in ROOT_BYTES, or else
 * leaves of as many entries as keep the root under it.
 */
export async function buildDirectories(entries) {
  const fits = ROOT_BYTES - HEADER_BYTES;
  const root = await gzip(serializeDirectory(entries));
  if (root.length <= fits) return { root, leaves: new Uint8Array(0) };
  for (let size = 4096; ; size = Math.ceil(size * 1.2)) {
    const rootEntries = [], parts = [];
    let offset = 0;
    for (let i = 0; i < entries.length; i += size) {
      const leaf = await gzip(serializeDirectory(entries.slice(i, i + size)));
      rootEntries.push({ tileId: entries[i].tileId, offset, length: leaf.length, runLength: 0 });
      parts.push(leaf);
      offset += leaf.length;
    }
    const r = await gzip(serializeDirectory(rootEntries));
    if (r.length <= fits) {
      const leaves = new Uint8Array(offset);
      let at = 0;
      for (const p of parts) { leaves.set(p, at); at += p.length; }
      return { root: r, leaves };
    }
  }
}
