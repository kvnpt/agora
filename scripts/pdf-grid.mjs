// Turning a ruled table back into a listing, using the lines the PDF draws.
//
// WHY THIS EXISTS
//
// Some parishes publish their schedule as a bordered table — DATE | FEAST |
// SERVICE | TIME — and flattening one to text loses which day a service is on.
// The date cell is drawn ONCE and centred over its block of services, so after
// `pdftotext -layout` it can sit several lines below the first service it
// labels:
//
//     01/07      Cosmas & Damian     Vespers & Paraklesis…     5:00-6:00 pm
//                                    Matins & Divine Liturgy   7:30-9:30 am   <- 2 July
//                  Deposition of the
//    Thursday
//                Robe of the Most    Vespers & Paraklesis…     5:00-6:00 pm
//     02/07
//
// Nothing left in that text says the "Matins" row is the 2nd. Attaching it to
// the nearest date above puts a liturgy on the wrong morning and tells
// reconcile.mjs the right one was cancelled, so worker/lib/pdf-schedule.mjs
// refuses the shape outright rather than guessing.
//
// The information is not gone, though — it is in the ruled lines, which live in
// the PDF's vector layer where no text extractor looks. `mutool draw -F trace`
// reports both the glyphs and the drawn paths in one coordinate system, so the
// table can be reassembled exactly and emitted as the listing the parser
// already reads. No guessing anywhere in here.
//
// THE OBSERVATION THAT MAKES IT GENERAL. A merged cell has no rule across it,
// so a column's rule count IS its granularity: in the sampled file DATE and
// FEAST have 19 boundaries each and SERVICE and TIME have 39-48. The coarse
// columns describe a day, the fine ones describe a service, and nothing here
// needs to know that a column is called "FEAST".
//
// Action-side only. It is imported by scripts/extract-parish-pdf.mjs and never
// by the Worker, which has neither mutool nor the CPU budget for this.

const HAIRLINE = 2.5;      // a filled rect thinner than this is a rule, not a box
const MIN_RULE = 20;       // …and shorter than this is a tick or a glyph artefact
const TOL = 2;             // coordinates that differ by less than this are the same

const decodeEntities = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&amp;/g, '&');          // last, so "&amp;lt;" does not become "<"

/** Collapse near-equal coordinates to one representative each, ascending. */
function cluster(values, tol = TOL) {
  const sorted = [...values].sort((a, b) => a - b);
  const out = [];
  for (const v of sorted) if (!out.length || v - out[out.length - 1] > tol) out.push(v);
  return out;
}

function parsePage(page) {
  const glyphs = [];
  // Per SPAN, because `adv` is a fraction of the em and only the span's text
  // matrix says how many points that is. Assuming one size turns "Blacktown
  // N.S.W." into "BlacktownN.S.W." in the 8pt line and spaces out the 20pt
  // heading letter by letter.
  for (const span of page.matchAll(/<span\b[^>]*\btrm="([-\d.eE]+)[^"]*"[^>]*>([\s\S]*?)<\/span>/g)) {
    const size = Math.abs(+span[1]) || 10;
    for (const m of span[2].matchAll(
      /<g unicode="((?:[^"\\]|\\.)*)"[^>]*?\sx="([-\d.]+)"\s+y="([-\d.]+)"[^>]*?adv="([-\d.eE]+)"/g)) {
      glyphs.push({ c: decodeEntities(m[1]), x: +m[2], y: +m[3], adv: +m[4] * size, size });
    }
  }

  const horizontal = [], vertical = [];
  for (const fp of page.matchAll(/<fill_path[^>]*>([\s\S]*?)<\/fill_path>/g)) {
    const pts = [...fp[1].matchAll(/<(?:moveto|lineto) x="([-\d.]+)" y="([-\d.]+)"/g)]
      .map(p => ({ x: +p[1], y: +p[2] }));
    if (pts.length < 3) continue;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (y1 - y0 < HAIRLINE && x1 - x0 > MIN_RULE) horizontal.push({ x0, x1, y: (y0 + y1) / 2 });
    else if (x1 - x0 < HAIRLINE && y1 - y0 > MIN_RULE) vertical.push({ x: (x0 + x1) / 2, y0, y1 });
  }
  return { glyphs, horizontal, vertical };
}

/**
 * The glyphs inside a cell, as one line of text.
 *
 * A cell's contents may be several visual lines — a wrapped title, a feast name
 * over three lines — and they are joined, because the rules say they are one
 * cell. That is the case flattened text cannot get right: "Catechism Course …
 * for adults who" and "wish to enter the Orthodox Faith" are one service with
 * its time printed between them.
 */
function assembleLines(glyphs) {
  const lines = [];
  for (const g of glyphs) {
    const line = lines.find(l => Math.abs(l.y - g.y) <= 3);
    if (line) line.glyphs.push(g);
    else lines.push({ y: g.y, glyphs: [g] });
  }

  // y grows upward in PDF space, so the topmost line is the largest y.
  return lines.sort((a, b) => b.y - a.y).map(line => {
    line.glyphs.sort((a, b) => a.x - b.x);
    let out = '', penEnd = null;
    for (const g of line.glyphs) {
      // Fonts routinely draw a space by advancing the pen rather than emitting
      // a space glyph, so a visible gap has to become one. The threshold is a
      // fraction of the em: a fixed number of points would either weld "(02)
      // 9611 5311" together at 8pt or space out a heading letter by letter.
      if (penEnd !== null && g.x - penEnd > g.size * 0.18 && g.c !== ' ') out += ' ';
      out += g.c;
      penEnd = g.x + g.adv;
    }
    return out.replace(/\s+/g, ' ').trim();
  }).filter(Boolean);
}

function cellText(glyphs, x0, x1, yLo, yHi) {
  const inside = glyphs.filter(g => g.x >= x0 - 1 && g.x < x1 && g.y > yLo + 1 && g.y < yHi - 1);
  return assembleLines(inside).join(' ');
}

/** Text outside the table — letterhead, footer — in reading order. */
function looseText(glyphs, tableTop, tableBottom) {
  return assembleLines(
    glyphs.filter(g => tableTop === null || g.y > tableTop || g.y < tableBottom));
}

function reflowPage(page) {
  const { glyphs, horizontal, vertical } = parsePage(page);
  if (!glyphs.length) return [];

  const columnEdges = cluster(vertical.map(v => v.x));
  // Fewer than three edges is not a table with a label column and a data
  // column, so there is nothing here this file can improve on.
  if (columnEdges.length < 3 || horizontal.length < 4) return looseText(glyphs, null, null);

  const columns = columnEdges.slice(0, -1).map((x0, i) => {
    const x1 = columnEdges[i + 1];
    const width = x1 - x0;
    // A rule belongs to a column when it spans most of it. Partial rules are
    // what distinguish a merged cell from a divided one, so "most" matters.
    const bounds = cluster(horizontal
      .filter(r => Math.min(r.x1, x1) - Math.max(r.x0, x0) > width * 0.8)
      .map(r => r.y));
    return { x0, x1, bounds };
  }).filter(c => c.bounds.length >= 2);

  if (columns.length < 2) return looseText(glyphs, null, null);

  // Granularity IS the rule count: the coarse columns describe a day, the fine
  // ones describe one service within it.
  const coarsest = Math.min(...columns.map(c => c.bounds.length));
  const finest = Math.max(...columns.map(c => c.bounds.length));
  if (coarsest === finest) return looseText(glyphs, null, null);

  const dayColumns = columns.filter(c => c.bounds.length === coarsest);
  const serviceColumns = columns.filter(c => c.bounds.length > coarsest);
  const dayBounds = dayColumns[0].bounds;
  // A row separator drawn in only one of the fine columns still separates rows.
  const serviceBounds = cluster(serviceColumns.flatMap(c => c.bounds));

  // Top of the page downward, so the emitted listing reads in date order.
  const table = [];
  for (let i = dayBounds.length - 2; i >= 0; i--) {
    const lo = dayBounds[i], hi = dayBounds[i + 1];

    const label = cellText(glyphs, dayColumns[0].x0, dayColumns[0].x1, lo, hi);
    // The table's own header row ("DATE", "FEAST", …) has no digits in its
    // first cell and no date to be read out of it.
    if (!/\d/.test(label)) continue;

    const rows = cluster([lo, ...serviceBounds.filter(y => y > lo && y < hi), hi]);
    const services = [];
    for (let r = rows.length - 2; r >= 0; r--) {
      const cells = serviceColumns
        .map(c => cellText(glyphs, c.x0, c.x1, rows[r], rows[r + 1]))
        .filter(Boolean);
      if (cells.length) services.push(cells.join('  '));
    }
    if (!services.length) continue;

    table.push(label);
    // Day-level context — a feast name — on its own line rather than appended
    // to the date. A feast that happened to contain something clock-shaped
    // would otherwise make a date line look like a grid row again.
    for (const c of dayColumns.slice(1)) {
      const extra = cellText(glyphs, c.x0, c.x1, lo, hi);
      if (extra) table.push(extra);
    }
    table.push(...services);
  }
  if (!table.length) return looseText(glyphs, null, null);

  // The DAY grid's extent is the table — which also drops its header row, whose
  // date cell said "DATE" and was skipped above but is still table furniture.
  //
  // Not the horizontal rules at large: a decorative line under a letterhead is
  // one of those, and taking the topmost swallows the letterhead along with the
  // "JULY 2026" the parser needs to date anything. Not the column separators
  // either: here they are drawn as one short segment per row, so they measure a
  // cell rather than the table. Only rules spanning most of the narrow date
  // column become day boundaries, which is what makes this the narrow answer.
  return [
    ...looseText(glyphs, Math.max(...dayBounds), Math.min(...dayBounds)),
    ...table,
  ];
}

/**
 * `mutool draw -F trace` XML → the same schedule as a listing.
 *
 * PURE: XML in, text out. The subprocess that produces the XML is the caller's
 * problem, which is what makes this testable against a handwritten trace.
 */
export function reflowTraceXml(xml) {
  const pages = String(xml || '').split(/<page\b/).slice(1);
  return pages.map(p => reflowPage(p).join('\n')).filter(Boolean).join('\n\n') + '\n';
}
