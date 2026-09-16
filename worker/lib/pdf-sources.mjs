// One entry per parish that publishes its schedule as a PDF.
//
// A parish's source is a thing the app REMEMBERS, not a thing it discovers.
// Nobody crawls anybody's website looking for a link: somebody who knows the
// parish supplies the URL once, and it lives here with everything else that is
// specific to reading that parish's file — how often they republish, where the
// services happen, and whichever quirks of their layout the parser has to be
// told about. Adding a parish is adding an entry.
//
// This list is imported by TWO things, and that is the point:
//
//   worker/lib/adapters.mjs      builds one adapter per entry
//   scripts/extract-parish-pdf.mjs  fetches and extracts each entry, in CI
//
// Same trick as public/shared/ — one definition, two consumers, so the URL the
// GitHub Action downloads and the URL the adapter believes it is reading can
// never drift apart.
//
// WHY THE EXTRACTION IS NOT HERE. Turning a PDF into text needs a real
// toolchain: the sampled files use subsetted fonts with custom glyph encodings,
// one has no ToUnicode map at all, and one is a photograph of a piece of paper.
// pdf.js is several times the size of this entire Worker bundle before it has
// parsed anything. So the Action does that, uploads the text to R2, and the
// adapter reads a small JSON document. docs/adapters.md has the full survey.

/**
 * @typedef {object} PdfSource
 * @property {string} key          identifies the adapter and its R2 object
 * @property {string} parishId     must exist in `parishes` before this can run
 * @property {string} sourceUrl    the PDF itself — supplied by a person, not found.
 *                                 With indexUrl set this is the FALLBACK: the last
 *                                 known-good file, used when discovery finds nothing.
 * @property {string} [indexUrl]   a stable page that links the current PDF, when the
 *                                 parish has one. The file's URL changes; this does not.
 * @property {RegExp} [linkPattern] which link on that page is the schedule
 * @property {string} timezone     fallback only; parishes.timezone wins when set
 * @property {string} publishes    observed cadence, and why the cron is what it is
 * @property {'layout'|'grid'} [extract]  how the file has to be read; default 'layout'
 * @property {object} parse        options for parseSchedulePdfText
 * @property {string} [notes]      anything the next person will wish they knew
 */

/** @type {PdfSource[]} */
export const PDF_SOURCES = [
  {
    key: 'gopssc-buderim',
    parishId: 'greek-gopssc-buderim',
    // Republished under a NEW path every year — the 2025 sheet was
    // "2025 GOP SSC Service Sheet Eng|Gr.pdf" and shares no pattern with this
    // one. There is nothing here to guess from last year's URL, which is the
    // clearest argument in the sample for a remembered source over a derived
    // one: when the parish posts next year's file, somebody edits this line.
    //
    // No `indexUrl` either, and that is a finding rather than an omission: the
    // site links no PDF from any page, because /hubfs/ is HubSpot's file
    // manager and the sheet is handed out rather than published. Blacktown can
    // be followed; this one genuinely needs a person once a year.
    sourceUrl: 'https://orthodoxsunshinecoast.org/hubfs/Liturgy%20Dates%20-%202026%20GOPSSC.pdf',
    timezone: 'Australia/Brisbane',
    // Once a year, then revised in place — this file is already titled "REVISED
    // LIST INCLUDING DETAILS FOR HOLY WEEK". A revision in place is exactly the
    // change a person re-uploading by hand would miss and a weekly re-fetch
    // catches, which is the whole reason this is automated at all for a file
    // that only appears once a year.
    publishes: 'yearly, revised in place',
    parse: {
      // The rows name a service and a time and nothing else. The venue is the
      // one the letterhead gives, and the parish is a mission meeting in a
      // borrowed building, so it belongs on the event rather than on the pin.
      defaultLocation: "St Mark's Anglican Church, 7 Main Street, Buderim QLD 4556",
      locationColumn: false,
    },
    notes:
      'Time last: "Liturgy of John Chrysostom (Tone 6)      11.30 am". The 2025 ' +
      'sheet lists 23 liturgies this way. The 2026 sheet is mostly a list of DATES ' +
      'with no clock, so it yields far fewer events — that is the file, not a bug. ' +
      'Dates with no time are skipped rather than given the parish\'s usual 11.30am, ' +
      'because inventing an instant puts someone outside a locked church.',
  },

  {
    key: 'stparaskevi-blacktown',
    parishId: 'greek-stparaskevi-blacktown',
    // The URL carries the month and the parish does not post every month:
    // probing this template across 2025-26 finds February, March, May and July
    // 2026 and nothing else, so there is no sequence to follow forward.
    //
    // But the PAGE that links it is stable. /church-programme.html shows one
    // month at a time — "JULY 2026" and an English and a Greek link — so the
    // remembered thing is the index and the file is read off it. This URL stays
    // as the fallback: the last file known to work, used when discovery finds
    // nothing, so a site reorganisation degrades to a stale month with a notice
    // in the log rather than to no schedule at all.
    sourceUrl: 'https://www.stparaskevi.au/uploads/4/2/1/2/42128533/programme_july_2026_en.pdf',
    indexUrl: 'https://www.stparaskevi.au/church-programme.html',
    // The Greek edition sits beside the English one under the same heading and
    // is a translation of it, not another month — so the language is part of
    // what identifies the file, not something to disambiguate later.
    linkPattern: /programme_([a-z]+)_(\d{4})_en\.pdf$/i,
    timezone: 'Australia/Sydney',
    publishes: 'monthly, irregularly',
    // A bordered DATE | FEAST | SERVICE | TIME table. `pdftotext -layout`
    // flattens it and loses which day each service belongs to — the date cell
    // is drawn once and centred over its block — so the ruled lines have to be
    // read out of the vector layer instead. scripts/pdf-grid.mjs does that, and
    // worker/lib/pdf-schedule.mjs refuses the flattened form outright rather
    // than guessing at it.
    extract: 'grid',
    parse: {
      // One building, and the table names no venue, so every service is at the
      // parish's own address. Unlike the two missions in this list, this is the
      // parish pin — but location_override keeps the card self-describing.
      defaultLocation: 'Sts Paraskevi & Barbara, 47-51 Balmoral St, Blacktown NSW 2148',
      locationColumn: false,
    },
    notes:
      'The richest source here by a wide margin: ~75-78 services a month, every ' +
      'day of the month, including daily Matins and Vespers. Titles carry real ' +
      'detail ("Matins & Divine Liturgy in the English language") and a service ' +
      'title can wrap around its own time in the PDF, which is why cells are ' +
      'joined by rule rather than by line.',
  },
];

export const getPdfSource = (key) => PDF_SOURCES.find(s => s.key === key) || null;

/** Where the extractor writes, and the adapter reads. */
export const r2KeyFor = (key) => `pdf-schedules/${key}.json`;
