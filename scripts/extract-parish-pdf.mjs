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
// A Worker gets 10ms of CPU on the free plan and this repo ships a ~99 KB
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
// Requires `pdftotext` (poppler-utils) and `mutool` (mupdf-tools) on PATH.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDF_SOURCES, r2KeyFor } from '../worker/lib/pdf-sources.mjs';
import { parseSchedulePdfText } from '../worker/lib/pdf-schedule.mjs';
import { reflowTraceXml } from './pdf-grid.mjs';
import { discoverPdfUrl } from './pdf-discover.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const outDir = arg('out', 'dist/pdf-schedules');
const only = arg('key');
// Whether the workflow will go on to upload. This script never uploads either
// way — it writes JSON to disk and the workflow's next step copies it to R2 —
// but it is the thing writing the log, so it is the thing that has to say
// which happened. Without this the dry run still printed "-> pdf-schedules/…",
// which reads exactly like an upload that did not occur.
const dryRun = args.includes('--dry-run');
const sources = only ? PDF_SOURCES.filter(s => s.key === only) : PDF_SOURCES;

if (!sources.length) {
  console.error(only ? `No source with key '${only}'.` : 'No sources configured.');
  process.exit(1);
}

// Two ways to get text out, chosen per source because it is a property of how
// that parish draws its schedule, not something to sniff at runtime.
//
//   layout  `pdftotext -layout` — keeps columns as runs of spaces, which is
//           what the parser splits a service row on. Right for a listing.
//
//   grid    `mutool draw -F trace` plus scripts/pdf-grid.mjs — reads the ruled
//           lines out of the vector layer and rebuilds the table as a listing.
//           Needed when the date cell is drawn once and centred over its block
//           of services, because flattening that loses which day a service is
//           on and no amount of parsing gets it back.
const EXTRACTORS = {
  layout: (scratch) => {
    execFileSync('pdftotext', ['-layout', '-enc', 'UTF-8', scratch, `${scratch}.out`]);
    return readFileSync(`${scratch}.out`, 'utf8');
  },
  grid: (scratch) => {
    execFileSync('mutool', ['draw', '-F', 'trace', '-o', `${scratch}.out`, scratch],
      { stdio: ['ignore', 'ignore', 'ignore'] });
    return reflowTraceXml(readFileSync(`${scratch}.out`, 'utf8'));
  },
};

function pdfToText(bytes, mode) {
  const extractor = EXTRACTORS[mode];
  if (!extractor) throw new Error(`unknown extract mode '${mode}' — expected ${Object.keys(EXTRACTORS).join(' or ')}`);
  const scratch = path.join(tmpdir(), `agora-pdf-${process.pid}-${Date.now()}.pdf`);
  try {
    writeFileSync(scratch, bytes);
    return extractor(scratch);
  } finally {
    rmSync(scratch, { force: true });
    rmSync(`${scratch}.out`, { force: true });
  }
}

let failures = 0;
mkdirSync(outDir, { recursive: true });

const UA = { 'User-Agent': 'Agora-OrthodoxEventFinder/1.0 (orthodoxy.au)' };

/**
 * The URL to actually download, following the parish's index page when it has
 * one. Returns the remembered `sourceUrl` unchanged when it does not, or when
 * following fails.
 *
 * Never throws. A parish reorganising its website should cost us this month's
 * file, not the whole extraction — so every failure here is a notice and a
 * fallback to the last URL known to work.
 */
async function resolveSourceUrl(source, label) {
  if (!source.indexUrl || !source.linkPattern) return { url: source.sourceUrl, from: null };
  let html = '';
  try {
    const res = await fetch(source.indexUrl, { headers: UA, redirect: 'follow' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    html = await res.text();
  } catch (err) {
    console.log(`::notice::${label} could not read ${source.indexUrl} (${err.message}); using the remembered URL`);
    return { url: source.sourceUrl, from: null };
  }

  const { url, reason } = discoverPdfUrl(html, source);
  if (!url) {
    console.log(`::notice::${label} ${reason}; using the remembered URL`);
    return { url: source.sourceUrl, from: null };
  }
  if (url !== source.sourceUrl) {
    // The parish has published something new. This is the event the index is
    // there to catch, and it is worth an annotation rather than a log line:
    // pdf-sources.mjs still names the old file, and somebody should move it on
    // so the fallback is the current one rather than an ageing one.
    console.log(`::notice::${label} ${source.indexUrl} now offers ${url} — `
      + `pdf-sources.mjs still remembers ${source.sourceUrl}`);
  }
  console.log(`${label} discovered ${url} (${reason})`);
  return { url, from: source.indexUrl };
}

for (const source of sources) {
  const label = `[${source.key}]`;
  try {
    const { url: sourceUrl, from: discoveredFrom } = await resolveSourceUrl(source, label);
    console.log(`${label} GET ${sourceUrl}`);
    const res = await fetch(sourceUrl, { headers: UA, redirect: 'follow' });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    const bytes = Buffer.from(await res.arrayBuffer());

    // A parish site that has lost the file usually answers with an HTML error
    // page and a 200. Extracting that would produce plausible-looking text with
    // no services in it, which reads downstream as "everything is cancelled".
    if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw new Error(`not a PDF (starts with ${JSON.stringify(bytes.subarray(0, 16).toString('latin1'))})`);
    }

    const mode = source.extract || 'layout';
    const text = pdfToText(bytes, mode);

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
      // The URL actually fetched, which with an index is the discovered one —
      // the adapter stamps this onto every event's source_url, so a card links
      // the file its service was read out of rather than a remembered older one.
      source_url: sourceUrl,
      // Null when the URL came from pdf-sources.mjs rather than a page.
      discovered_from: discoveredFrom,
      fetched_at: new Date().toISOString(),
      // Lets the adapter log say whether it is looking at a new file or the one
      // it read last time, without diffing the text.
      pdf_sha256: createHash('sha256').update(bytes).digest('hex'),
      pdf_bytes: bytes.length,
      extractor: mode === 'grid' ? 'mutool trace + pdf-grid' : 'pdftotext -layout',
      // What the FILE covers, as opposed to what the last adapter run covered.
      //
      // The two are usually the same and diverge in exactly the case worth
      // seeing: an adapter that is paused, failing or simply has not run since
      // the Action last fetched. Coverage computed from `adapter_runs` freezes
      // with the adapter, so a card could say nothing at all about a perfectly
      // good file sitting in R2. Written here because the parse already
      // happened for the log two lines up; re-deriving it in the Worker would
      // mean parsing the whole text again to learn one pair of dates.
      //
      // Null when nothing datable was read — distinct from a missing field,
      // which is a document written before this existed.
      coverage: parsed.refused ? null : (parsed.coverage || null),
      occurrences: parsed.refused ? 0 : parsed.occurrences.length,
      text,
    };

    const file = path.join(outDir, `${source.key}.json`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(doc, null, 2));
    console.log(dryRun
      ? `${label} wrote ${file} — dry run, ${r2KeyFor(source.key)} left as it was`
      : `${label} wrote ${file} -> ${r2KeyFor(source.key)}`);
  } catch (err) {
    failures++;
    // Never fail the whole run on one parish. A parish that reorganises its
    // website should not stop every other parish's schedule from refreshing.
    console.error(`::error::${label} ${err.message}`);
  }
}

console.log(`\n${sources.length - failures}/${sources.length} sources extracted.` +
  (dryRun ? ' Dry run — nothing was uploaded to R2.' : ''));

// ANY failure fails the run.
//
// This used to be `failures === sources.length`, so a green tick meant "at
// least one source extracted" — with two sources, one success was green, and
// at ten PDF parishes nine failures would still be green. The only per-source
// signal was an ::error:: annotation inside a step summary nobody opens on a
// passing run, and a parish going dark is precisely the thing that has to be
// noticed rather than looked for.
//
// Every source that worked has already been written to disk, and the workflow
// uploads those before it acts on this status — see the "Extract" step, which
// swallows this exit code on purpose and re-raises it at the end. Continuing
// past a failed parish is still right; reporting the run as a pass was not.
if (failures > 0) process.exit(1);
