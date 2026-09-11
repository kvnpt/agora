// Fetch each parish's published PDF and write the text out as JSON.
//
// This is the half of PDF ingestion that cannot live in the Worker, and it is
// worth being precise about why, because "PDFs are hard" is not a reason.
//
// Five real parish schedules were pulled apart before this was written:
//
//   * Every one with a text layer uses SUBSETTED fonts. The bytes in the
//     content stream are glyph ids in the font's own numbering — <0033> is "P"
//     in one file and something else in the next — so reading them at all means
//     resolving each font's /ToUnicode CMap.
//   * One (orthodox.net) ships no ToUnicode map, so even that is not enough:
//     the embedded font PROGRAM has to be parsed to recover the characters.
//   * One (St Nicholas, Wallsend) has no text layer whatsoever. It is a single
//     2480x3504 JPEG — a photograph of a printed sheet. Only OCR reaches it.
//   * Reading order is not the order on the page. Columns interleave, and a
//     table cell drawn once and centred over its block lands in the middle of
//     the rows it labels.
//
// A Worker gets 10ms of CPU on the free plan and this repo ships an ~85 KB
// bundle with no third-party runtime dependencies. pdf.js alone is larger than
// that before it has opened a file, and none of it would help with the scan.
//
// So the shape docs/adapters.md recommends, and the basemap workflow already
// set the precedent for: a GitHub Action does the heavy part where there is a
// full toolchain and visible logs, and puts a small JSON document in R2. The
// Worker reads that. The text -> occurrences parser stays pure, in
// worker/lib/pdf-schedule.mjs, and is tested without any of this.
//
// Usage:
//   node scripts/extract-parish-pdf.mjs --out dist/pdf-schedules
//   node scripts/extract-parish-pdf.mjs --out dist/pdf-schedules --key gopssc-buderim
//
// Requires `pdftotext` (poppler-utils) on PATH.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDF_SOURCES, r2KeyFor } from '../worker/lib/pdf-sources.mjs';
import { parseSchedulePdfText } from '../worker/lib/pdf-schedule.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const outDir = arg('out', 'dist/pdf-schedules');
const only = arg('key');
const sources = only ? PDF_SOURCES.filter(s => s.key === only) : PDF_SOURCES;

if (!sources.length) {
  console.error(only ? `No source with key '${only}'.` : 'No sources configured.');
  process.exit(1);
}

// `pdftotext -layout` keeps the columns as runs of spaces, which is what the
// parser splits a row on. Without -layout the columns are concatenated and the
// venue runs into the title.
function pdfToText(bytes) {
  const scratch = path.join(tmpdir(), `agora-pdf-${process.pid}-${Date.now()}.pdf`);
  try {
    writeFileSync(scratch, bytes);
    execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', scratch, `${scratch}.txt`]);
    return readFileSync(`${scratch}.txt`, 'utf8');
  } finally {
    rmSync(scratch, { force: true });
    rmSync(`${scratch}.txt`, { force: true });
  }
}

let failures = 0;
mkdirSync(outDir, { recursive: true });

for (const source of sources) {
  const label = `[${source.key}]`;
  try {
    console.log(`${label} GET ${source.sourceUrl}`);
    const res = await fetch(source.sourceUrl, {
      headers: { 'User-Agent': 'Agora-OrthodoxEventFinder/1.0 (orthodoxy.au)' },
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const bytes = Buffer.from(await res.arrayBuffer());

    // A parish site that has lost the file usually answers with an HTML error
    // page and a 200. Extracting that would produce plausible-looking text with
    // no services in it, which reads downstream as "everything is cancelled".
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error(`not a PDF (starts with ${JSON.stringify(bytes.subarray(0, 16).toString('latin1'))})`);
    }

    const text = pdfToText(bytes);

    // Parse here too. Nothing downstream depends on it — the Worker re-parses
    // the text itself — but a workflow that says "0 occurrences, refused:
    // column-grid" in its log is the difference between noticing a parish
    // changed their layout and finding out when the feed empties.
    const parsed = parseSchedulePdfText(text, { ...source.parse });
    const summary = parsed.refused
      ? `REFUSED ${parsed.refused.reason} — ${parsed.refused.detail}`
      : `${parsed.occurrences.length} occurrences, ${parsed.skipped.length} skipped, ` +
        `covering ${parsed.coverage ? `${parsed.coverage.from}..${parsed.coverage.to}` : 'nothing'}`;
    console.log(`${label} ${bytes.length} bytes, ${text.length} chars of text — ${summary}`);

    if (!text.trim()) {
      // The scanned-schedule case. Uploading an empty document would be worse
      // than uploading nothing: the adapter would read it, find no services and
      // report a window it never actually saw.
      throw new Error('no text layer — the PDF is probably a scan, and needs OCR rather than extraction');
    }

    const doc = {
      key: source.key,
      parish_id: source.parishId,
      source_url: source.sourceUrl,
      fetched_at: new Date().toISOString(),
      // Lets the adapter log say whether it is looking at a new file or the one
      // it read last time, without diffing the text.
      pdf_sha256: createHash('sha256').update(bytes).digest('hex'),
      pdf_bytes: bytes.length,
      extractor: 'pdftotext -layout',
      text,
    };

    const file = path.join(outDir, `${source.key}.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(doc, null, 2));
    console.log(`${label} wrote ${file} -> ${r2KeyFor(source.key)}`);
  } catch (err) {
    failures++;
    // Never fail the whole run on one parish. A parish that reorganises its
    // website should not stop every other parish's schedule from refreshing.
    console.error(`::error::${label} ${err.message}`);
  }
}

console.log(`\n${sources.length - failures}/${sources.length} sources extracted.`);
// Only a total loss is worth failing on: a partial run still has something
// worth uploading, and the per-source ::error:: annotations say what is missing.
if (failures === sources.length) process.exit(1);
