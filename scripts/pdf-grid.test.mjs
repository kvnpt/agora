// Rebuilding a ruled table from the lines the PDF draws.
//
// The traces here are handwritten rather than captured, because the thing worth
// testing is one specific geometric hazard and a captured trace of a real page
// is two megabytes of XML in which that hazard is invisible. Each one is built
// to be the shape that defeats text extraction: a date cell drawn ONCE and
// centred over a block of services, so that the first service of a day sits
// ABOVE the cell that names the day.
//
// The real files are checked end to end by the workflow, whose log reports
// occurrences and coverage per source on every run.

import test from 'node:test';
import assert from 'node:assert';
import { reflowTraceXml } from './pdf-grid.mjs';

// y grows upward, as in PDF user space.
const rule = (x0, x1, y) =>
  `<fill_path><moveto x="${x0}" y="${y}"/><lineto x="${x1}" y="${y}"/>` +
  `<lineto x="${x1}" y="${y + 1}"/><lineto x="${x0}" y="${y + 1}"/><closepath/></fill_path>`;

const vrule = (x, y0, y1) =>
  `<fill_path><moveto x="${x}" y="${y0}"/><lineto x="${x + 1}" y="${y0}"/>` +
  `<lineto x="${x + 1}" y="${y1}"/><lineto x="${x}" y="${y1}"/><closepath/></fill_path>`;

// One span per text run, at 10pt, with glyphs advancing 5pt each — so a gap
// wider than 1.8pt (0.18 em) reads as a space, matching the real heuristic.
const text = (s, x, y) => {
  const glyphs = [...s].map((c, i) => {
    const ch = c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c;
    return `<g unicode="${ch}" x="${x + i * 5}" y="${y}" adv="0.5"/>`;
  }).join('');
  return `<span font="Test" trm="10 0 0 10">${glyphs}</span>`;
};

const page = (...parts) => `<page number="1">${parts.join('')}</page>`;

// Columns: DATE [36,93] FEAST [93,199] SERVICE [199,497] TIME [497,567].
const COLS = [36, 93, 199, 497, 567];

test('a service above its own centred date cell is still filed under that date', () => {
  // THE CASE THAT MOTIVATES ALL OF THIS.
  //
  // Day one occupies y 700-740 with two services; day two occupies y 600-700
  // with three. Day two's date text is drawn at y=640 — vertically centred in
  // its block — while its FIRST service sits at y=680, forty points ABOVE it.
  //
  // Read as lines, that service appears between "01/07" and "02/07" and looks
  // like it belongs to the first day. The rule at y=700 says otherwise, and
  // the rule is what the parish actually drew.
  const xml = page(
    // Day-level boundaries: drawn across DATE and FEAST only.
    rule(36, 199, 740), rule(36, 199, 700), rule(36, 199, 600),
    // Service-level boundaries: drawn across SERVICE and TIME.
    rule(199, 567, 740), rule(199, 567, 720), rule(199, 567, 700),
    rule(199, 567, 670), rule(199, 567, 640), rule(199, 567, 600),
    ...COLS.map(x => vrule(x, 600, 740)),

    text('01/07', 40, 720), text('Feast One', 95, 720),
    text('Matins', 200, 730), text('7am', 500, 730),
    text('Vespers', 200, 710), text('5pm', 500, 710),

    text('02/07', 40, 640), text('Feast Two', 95, 640),
    text('Matins', 200, 690), text('7am', 500, 690),      // above the 02/07 cell
    text('Vespers', 200, 660), text('5pm', 500, 660),
    text('Study', 200, 620), text('6pm', 500, 620),
  );

  const lines = reflowTraceXml(xml).trim().split('\n');
  assert.deepStrictEqual(lines, [
    '01/07',
    'Feast One',
    'Matins  7am',
    'Vespers  5pm',
    '02/07',
    'Feast Two',
    'Matins  7am',
    'Vespers  5pm',
    'Study  6pm',
  ]);
});

test('services come out in the order they are printed, top to bottom', () => {
  const xml = page(
    rule(36, 199, 700), rule(36, 199, 600),
    rule(199, 567, 700), rule(199, 567, 670), rule(199, 567, 640), rule(199, 567, 600),
    ...COLS.map(x => vrule(x, 600, 700)),
    text('05/07', 40, 650),
    text('Matins', 200, 690), text('7am', 500, 690),
    text('Liturgy', 200, 660), text('10am', 500, 660),
    text('Vespers', 200, 620), text('5pm', 500, 620),
  );
  const lines = reflowTraceXml(xml).trim().split('\n');
  assert.deepStrictEqual(lines,
    ['05/07', 'Matins  7am', 'Liturgy  10am', 'Vespers  5pm'],
    'a 5pm vespers listed before a 7am matins would be the rows read bottom-up');
});

test('a title that wraps around its own time stays one service', () => {
  // Real, from the Blacktown programme: the Catechism entry prints its title on
  // two lines with the time between them. They are one cell, so they are one
  // service — and only the ruled lines say where that cell ends.
  const xml = page(
    rule(36, 199, 700), rule(36, 199, 640), rule(36, 199, 600),
    rule(199, 567, 700), rule(199, 567, 640), rule(199, 567, 620), rule(199, 567, 600),
    ...COLS.map(x => vrule(x, 600, 700)),
    text('03/07', 40, 670),
    text('Catechism Course for adults who', 200, 690),
    text('6pm', 500, 670),
    text('wish to enter the Faith', 200, 650),
    text('04/07', 40, 620),
    text('Matins', 200, 630), text('7am', 500, 630),
    text('Vespers', 200, 610), text('5pm', 500, 610),
  );
  const lines = reflowTraceXml(xml).trim().split('\n');
  assert.deepStrictEqual(lines, [
    '03/07',
    'Catechism Course for adults who wish to enter the Faith  6pm',
    '04/07',
    'Matins  7am',
    'Vespers  5pm',
  ]);
});

test('the header row is dropped — it has no date to file anything under', () => {
  const xml = page(
    rule(36, 199, 760), rule(36, 199, 740), rule(36, 199, 700),
    rule(199, 567, 760), rule(199, 567, 740), rule(199, 567, 720), rule(199, 567, 700),
    ...COLS.map(x => vrule(x, 700, 760)),
    text('DATE', 40, 750), text('FEAST', 95, 750),
    text('SERVICE', 200, 750), text('TIME', 500, 750),
    text('01/07', 40, 720),
    text('Matins', 200, 730), text('7am', 500, 730),
    text('Vespers', 200, 710), text('5pm', 500, 710),
  );
  const out = reflowTraceXml(xml);
  assert.ok(!/DATE/.test(out), 'the column header must not survive as a row');
  assert.deepStrictEqual(out.trim().split('\n'), ['01/07', 'Matins  7am', 'Vespers  5pm']);
});

test('text outside the table is kept, and kept above it', () => {
  // The letterhead is where the month and year live, and the parser needs them
  // to turn "01/07" into a date at all. Losing it loses the whole file.
  const xml = page(
    rule(36, 199, 700), rule(36, 199, 640), rule(36, 199, 600),
    rule(199, 567, 700), rule(199, 567, 670), rule(199, 567, 640), rule(199, 567, 600),
    ...COLS.map(x => vrule(x, 600, 700)),
    text('JULY 2026', 40, 800),
    text('01/07', 40, 670),
    text('Matins', 200, 690), text('7am', 500, 690),
    text('Vespers', 200, 650), text('5pm', 500, 650),
    text('02/07', 40, 620),
    text('Liturgy', 200, 620), text('9am', 500, 620),
    text('Parish office: 9611 5311', 40, 500),
  );
  const lines = reflowTraceXml(xml).trim().split('\n');
  assert.strictEqual(lines[0], 'JULY 2026');
  assert.ok(lines.includes('Parish office: 9611 5311'));
  assert.ok(lines.indexOf('01/07') > 0);
});

test('a page with no table is passed through as plain lines', () => {
  const xml = page(text('Sunday 12 January', 40, 700), text('Divine Liturgy 10am', 40, 680));
  assert.deepStrictEqual(reflowTraceXml(xml).trim().split('\n'),
    ['Sunday 12 January', 'Divine Liturgy 10am']);
});

test('a table whose columns all share one grid is left alone', () => {
  // Every column divided the same way means no merged cells, so there is no
  // day-versus-service distinction to recover and nothing to reflow.
  const xml = page(
    rule(36, 567, 700), rule(36, 567, 670), rule(36, 567, 640),
    ...COLS.map(x => vrule(x, 640, 700)),
    text('a', 40, 690), text('b', 200, 690),
    text('c', 40, 660), text('d', 200, 660),
  );
  const out = reflowTraceXml(xml);
  assert.ok(out.includes('a'), 'the text still has to come out');
});

test('entities in the trace are decoded once, not twice', () => {
  const xml = page(
    rule(36, 199, 700), rule(36, 199, 640),
    rule(199, 567, 700), rule(199, 567, 640),
    ...COLS.map(x => vrule(x, 640, 700)),
    text('01/07', 40, 670),
    text('Q&A and <Vespers>', 200, 670), text('6pm', 500, 670),
  );
  const out = reflowTraceXml(xml);
  assert.match(out, /Q&A and <Vespers>/);
  assert.ok(!out.includes('&amp;'), 'a double decode would leave literal entities behind');
});
