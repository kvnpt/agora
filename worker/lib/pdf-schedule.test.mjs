// The text -> occurrences parser, against real published schedules.
//
// Everything here runs on strings from pdf-schedule.fixture.mjs, which are
// verbatim `pdftotext -layout` output from PDFs downloaded off parish websites.
// No network, no PDF, no clock.

import test from 'node:test';
import assert from 'node:assert';
import { parseSchedulePdfText, parseTime, parseDateHeader } from './pdf-schedule.mjs';
import {
  GOOD_SHEPHERD_LISTING, SUNSHINE_COAST_2025, SUNSHINE_COAST_2026,
  BLACKTOWN_GRID, BLACKTOWN_REFLOWED, WALLSEND_SCAN,
} from './pdf-schedule.fixture.mjs';

// ── times ────────────────────────────────────────────────────────────────────

test('parses every time spelling the surveyed parishes use', () => {
  const cases = [
    ['5pm', '17:00', null],
    ['9am', '09:00', null],
    ['12:30pm', '12:30', null],
    ['11.30 am', '11:30', null],                 // Sunshine Coast writes a dot
    ['7:30-9:30 am', '07:30', '09:30'],          // Blacktown: one meridiem, both ends
    ['5:00 - 6:00 pm', '17:00', '18:00'],
    ['7.00 pm to 11.00 pm', '19:00', '23:00'],
    ['12am', '00:00', null],                     // midnight, not noon
    ['12pm', '12:00', null],
  ];
  for (const [input, start, end] of cases) {
    const got = parseTime(input);
    assert.ok(got, `no time found in ${JSON.stringify(input)}`);
    assert.deepStrictEqual([got.start, got.end], [start, end], input);
  }
});

test('a meridiem is borrowed forwards, never backwards', () => {
  // "7:30-9:30 am" means both ends are am, so the start may take the end's.
  assert.deepStrictEqual(
    [parseTime('7:30-9:30 am').start, parseTime('7:30-9:30 am').end], ['07:30', '09:30']);
  // "11.00 pm to 2.30am" states both, and the start must keep its own — reading
  // the end's back onto it would turn a paschal vigil into an 11am service.
  const vigil = parseTime('11.00 pm to 2.30am');
  assert.deepStrictEqual([vigil.start, vigil.end], ['23:00', '02:30']);
});

test('numbers that are not times are left alone', () => {
  // The tone number, the note's date fragment, and the postcode all sit in the
  // service column of a real parish programme.
  assert.strictEqual(parseTime('Liturgy of John Chrysostom (Tone 6)'), null);
  assert.strictEqual(parseTime('(Great & the Holy Lenten Fast 3/3)'), null);
  assert.strictEqual(parseTime('47-51 Balmoral St. Blacktown N.S.W. 2148'), null);
  assert.strictEqual(parseTime('16 SUNDAY OF LUKE, THE PUBLICAN & THE PHARISEE'), null);
});

// ── date headers ─────────────────────────────────────────────────────────────

test('reads the date spellings the sample uses', () => {
  const ctx = { year: 2026, month: 1 };
  const at = (line) => parseDateHeader(line, ctx)?.date;
  assert.strictEqual(at('Sunday 12 January'), '2026-01-12');
  assert.strictEqual(at('Sunday 11th January'), '2026-01-11');
  assert.strictEqual(at('Sunday July 12th'), '2026-07-12');     // same file, later page
  assert.strictEqual(at('12 SEP, SAT'), '2026-09-12');
  assert.strictEqual(at('12 January 2027'), '2027-01-12');
});

test('a slash date is read day-first', () => {
  // Australian convention, and the only one in the sample. Month-first would
  // put 01/07 six months from where the parish published it.
  assert.strictEqual(parseDateHeader('01/07', { year: 2026 }).date, '2026-07-01');
  assert.strictEqual(parseDateHeader('01/07/2026', {}).date, '2026-07-01');
});

test('a date that is not on the calendar is refused, not rolled over', () => {
  // new Date(2026, 1, 30) is 2 March. A misprint should drop the header, not
  // quietly relocate everything under it.
  assert.strictEqual(parseDateHeader('30 February 2026', {}), null);
  assert.strictEqual(parseDateHeader('31/09/2026', {}), null);
});

test('a programme running into a new year rolls the year forward', () => {
  const dec = parseDateHeader('Sunday 14 December', { year: 2026, month: 11 });
  assert.strictEqual(dec.date, '2026-12-14');
  const jan = parseDateHeader('Sunday 11 January', { year: dec.year, month: dec.month });
  assert.strictEqual(jan.date, '2027-01-11', 'Dec then Jan is next year, not ten months back');
});

// ── the documented listing shape ─────────────────────────────────────────────

test('Good Shepherd: a date header owns the rows beneath it', () => {
  const { occurrences, refused } = parseSchedulePdfText(GOOD_SHEPHERD_LISTING, {
    year: 2026, locationColumn: true,
  });
  assert.strictEqual(refused, null);
  assert.strictEqual(occurrences.length, 6);

  assert.deepStrictEqual(
    occurrences.map(o => `${o.date} ${o.start} ${o.title}`),
    [
      '2026-09-12 17:00 Vespers',
      '2026-09-12 18:00 Confession',
      '2026-09-13 09:00 Matins (Orthros)',
      '2026-09-13 10:00 Divine Liturgy',
      '2026-09-13 12:30 FOUNDATIONS Course',
      '2026-09-19 17:00 Vespers',
    ]);
});

test('Good Shepherd: the third column is the room, not part of the title', () => {
  const { occurrences } = parseSchedulePdfText(GOOD_SHEPHERD_LISTING, {
    year: 2026, locationColumn: true,
  });
  const liturgy = occurrences.find(o => o.title === 'Divine Liturgy');
  assert.strictEqual(liturgy.location,
    'Monash Orthodox Chaplaincy, 38 Exhibition Walk, Clayton VIC 3168');
  const vespers = occurrences.find(o => o.title === 'Vespers');
  assert.strictEqual(vespers.location,
    'Religious Centre, 38 Exhibition Walk, Clayton VIC 3168');
});

test('without locationColumn a wrapped title is never filed as an address', () => {
  const { occurrences } = parseSchedulePdfText(GOOD_SHEPHERD_LISTING, { year: 2026 });
  assert.ok(occurrences.every(o => o.location === null));
  assert.deepStrictEqual([...new Set(occurrences.map(o => o.title))],
    ['Vespers', 'Confession', 'Matins (Orthros)', 'Divine Liturgy', 'FOUNDATIONS Course']);
});

test('defaultLocation fills rows that name no room', () => {
  const { occurrences } = parseSchedulePdfText(SUNSHINE_COAST_2025, {
    defaultLocation: "St Mark's Anglican Church, 7 Main Street, Buderim QLD 4556",
  });
  assert.ok(occurrences.length);
  assert.ok(occurrences.every(o => o.location.startsWith("St Mark's")));
});

// ── the time-last listing shape ──────────────────────────────────────────────

test('Sunshine Coast 2025: time last, feast name on the date line', () => {
  const { occurrences, refused } = parseSchedulePdfText(SUNSHINE_COAST_2025);
  assert.strictEqual(refused, null);
  assert.deepStrictEqual(
    occurrences.map(o => `${o.date} ${o.start} ${o.title}`),
    [
      '2025-01-26 11:30 Liturgy of John Chrysostom (Tone 6)',
      '2025-02-09 11:30 Liturgy of John Chrysostom (Tone 8)',
      '2025-02-23 11:30 Liturgy of John Chrysostom (Tone 2)',
      '2025-03-09 11:30 Liturgy of Basil the Great (Tone 4)',
    ]);
});

test('"NO SERVICE AT BUDERIM" produces no event at all', () => {
  const { occurrences, skipped } = parseSchedulePdfText(SUNSHINE_COAST_2025);
  assert.ok(!occurrences.some(o => o.date === '2025-01-12'),
    '12 January is the Sunday the parish said it was not serving');
  assert.ok(!occurrences.some(o => /no service|to be advised/i.test(o.title)));
  // Nothing about the parser writes a cancellation. The occurrence is simply
  // absent from the window, and tombstone.mjs decides — with its guards — what
  // that absence is allowed to mean.
  assert.ok(Array.isArray(skipped));
});

test('a parenthetical note is not a service, even when it looks like a time', () => {
  const { occurrences } = parseSchedulePdfText(SUNSHINE_COAST_2025);
  assert.ok(!occurrences.some(o => /Lenten Fast|Triodion|Venue/i.test(o.title)));
});

test('Sunshine Coast 2026: the same parish, a different file, one year on', () => {
  const { occurrences, refused } = parseSchedulePdfText(SUNSHINE_COAST_2026);
  assert.strictEqual(refused, null);
  // Twenty-six Sundays are listed and three carry a clock, but only one states
  // its time and its service on the same row. A date with no time cannot become
  // an instant, so it is not invented.
  assert.deepStrictEqual(
    occurrences.map(o => `${o.date} ${o.start}-${o.end} ${o.title}`),
    ['2026-04-09 19:00-23:00 Holy Thursday']);
  assert.ok(!occurrences.some(o => o.date === '2026-07-12'),
    'a dates-only entry yields nothing rather than a guessed 11.30am');
});

test('a time with no service on its own row is skipped, not paired with a neighbour', () => {
  // Holy Week in the 2026 sheet writes the time on one line and the service on
  // another — and not consistently: on 10 April the service is the line ABOVE
  // its time, on 11 April it is the line BELOW. Either guess is wrong half the
  // time, and a wrong guess captions a real service with someone else's title.
  const { occurrences, skipped } = parseSchedulePdfText(SUNSHINE_COAST_2026);
  assert.ok(!occurrences.some(o => o.date === '2026-04-10' || o.date === '2026-04-11'));
  assert.deepStrictEqual(
    skipped.filter(s => s.why === 'no title').map(s => s.line),
    ['7.00 pm to 10.00 pm', 'Saturday 11th April                – 11.00 pm to 2.30am']);
});

// ── the grid we refuse ───────────────────────────────────────────────────────

test('a DATE | FEAST | SERVICE | TIME grid is refused, not guessed at', () => {
  const { occurrences, refused } = parseSchedulePdfText(BLACKTOWN_GRID, { year: 2026 });
  assert.strictEqual(occurrences.length, 0);
  assert.ok(refused, 'the grid must be refused');
  assert.strictEqual(refused.reason, 'column-grid');
  assert.match(refused.detail, /DATE/);
});

test('the grid is refused on interleaving alone, without a header row', () => {
  // The same file with its header row lost — a page break, a cropped extract.
  // The tell is still there: the centred date cell shares a line with a service.
  const headerless = BLACKTOWN_GRID.split('\n').filter(l => !/^\s*DATE\s/.test(l));
  const rows = [];
  for (let d = 1; d <= 8; d++) {
    rows.push(`  0${d}/07      Some Feast        Vespers & Paraklesis            5:00-6:00 pm`);
    rows.push(`                                  Matins & Divine Liturgy         7:30-9:30 am`);
  }
  const { refused } = parseSchedulePdfText([...headerless, ...rows].join('\n'), { year: 2026 });
  assert.ok(refused);
  assert.strictEqual(refused.reason, 'column-grid');
  assert.match(refused.detail, /date lines also carry a service time/);
});

test('a scanned schedule yields nothing and claims no coverage', () => {
  // The whole point: an empty extract must not read as "the parish cancelled
  // everything". No occurrences means no coverage, and no coverage means
  // runAdapter has no window to tombstone against.
  const out = parseSchedulePdfText(WALLSEND_SCAN);
  assert.deepStrictEqual(out.occurrences, []);
  assert.strictEqual(out.coverage, null);
  assert.strictEqual(out.refused, null);
});

// ── coverage ─────────────────────────────────────────────────────────────────

test('coverage is clamped to the dates actually parsed', () => {
  const { coverage, declared } = parseSchedulePdfText(SUNSHINE_COAST_2025);
  // The file declares 2025. It is not held to the whole of 2025 — only to the
  // span it was actually read to cover.
  assert.deepStrictEqual(declared, { from: '2025-01-01', to: '2025-12-31' });
  assert.deepStrictEqual(coverage, { from: '2025-01-26', to: '2025-03-09' });
});

test('a monthly letterhead narrows the declared period to that month', () => {
  const text = [
    'PROGRAM OF SERVICES',
    'JULY 2026',
    '',
    '05 July',
    '  9am   Divine Liturgy',
    '26 July',
    '  9am   Divine Liturgy',
  ].join('\n');
  const { declared, coverage } = parseSchedulePdfText(text);
  assert.deepStrictEqual(declared, { from: '2026-07-01', to: '2026-07-31' });
  assert.deepStrictEqual(coverage, { from: '2026-07-05', to: '2026-07-26' });
});

test('coverage never runs past what the file declares', () => {
  // A stray header for a date outside the declared month must not widen the
  // window onto days the file says nothing about.
  const text = [
    'JULY 2026',
    '05 July',
    '  9am   Divine Liturgy',
    '02 August',
    '  9am   Divine Liturgy',
  ].join('\n');
  const { coverage } = parseSchedulePdfText(text);
  assert.deepStrictEqual(coverage, { from: '2026-07-05', to: '2026-07-31' });
});

test('the parser is pure: the same text parses the same twice', () => {
  const a = parseSchedulePdfText(SUNSHINE_COAST_2025);
  const b = parseSchedulePdfText(SUNSHINE_COAST_2025);
  assert.deepStrictEqual(a, b);
});

// ── the same grid, once the ruled lines have been read ───────────────────────

test('the reflowed grid parses, and 02/07 keeps all three of its services', () => {
  // The payoff for scripts/pdf-grid.mjs, and the exact row the flattened form
  // gets wrong: "Matins & Divine Liturgy" printed above the 02/07 cell is a
  // 2 July service, and here it is filed as one.
  const { occurrences, refused, skipped } = parseSchedulePdfText(BLACKTOWN_REFLOWED, {
    locationColumn: false,
  });
  assert.strictEqual(refused, null, 'reflowed text is a listing, not a grid');
  assert.strictEqual(skipped.length, 0);

  assert.deepStrictEqual(
    occurrences.map(o => `${o.date} ${o.start}-${o.end} ${o.title}`),
    [
      '2026-07-01 07:30-09:30 Matins & Divine Liturgy',
      '2026-07-01 17:00-18:00 Vespers & Paraklesis to Saint Paraskevi',
      '2026-07-02 07:30-09:30 Matins & Divine Liturgy',
      '2026-07-02 17:00-18:00 Vespers & Paraklesis to Saint Paraskevi',
      '2026-07-02 18:00-19:15 Bible Studies and Q&A in the English language',
      '2026-07-03 07:30-09:30 Matins & Divine Liturgy',
      '2026-07-03 17:00-18:00 Vespers & Paraklesis to Saint Paraskevi',
      '2026-07-03 18:00-null Catechism Course & Reception into the Orthodox Church for adults who wish to enter the Orthodox Faith',
    ]);
});

test('"Wednesday 01/07" is a date header — the weekday is decoration', () => {
  // The reflowed date cell carries both, because the table prints both.
  assert.strictEqual(parseDateHeader('Wednesday 01/07', { year: 2026 }).date, '2026-07-01');
  assert.strictEqual(parseDateHeader('Thursday 02/07', { year: 2026 }).date, '2026-07-02');
  // And a weekday that disagrees with the date is still not our problem to
  // adjudicate: the date is what the parish printed against the services.
  assert.strictEqual(parseDateHeader('Monday 02/07', { year: 2026 }).date, '2026-07-02');
});

test('the feast line between a date and its services is ignored, not titled', () => {
  const { occurrences } = parseSchedulePdfText(BLACKTOWN_REFLOWED, { locationColumn: false });
  assert.ok(!occurrences.some(o => /Hyacinthus|Deposition of the Robe|Unmercenaries/.test(o.title)),
    'a feast name has no time and must not become a service');
});

test('the reflowed month declares and covers that month', () => {
  const { declared, coverage } = parseSchedulePdfText(BLACKTOWN_REFLOWED, { locationColumn: false });
  // "JULY 2026" survives in the letterhead, which is the only thing in the file
  // that says which year "01/07" belongs to.
  assert.deepStrictEqual(declared, { from: '2026-07-01', to: '2026-07-31' });
  assert.deepStrictEqual(coverage, { from: '2026-07-01', to: '2026-07-03' });
});

test('flattened and reflowed are the same file with opposite outcomes', () => {
  // Worth asserting together: this is the whole argument for the grid
  // extractor, and for the parser refusing rather than guessing without it.
  assert.strictEqual(parseSchedulePdfText(BLACKTOWN_GRID, { year: 2026 }).refused.reason, 'column-grid');
  assert.strictEqual(parseSchedulePdfText(BLACKTOWN_REFLOWED).refused, null);
});
