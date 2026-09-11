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
 * @property {string} sourceUrl    the PDF itself — supplied by a person, not found
 * @property {string} timezone     fallback only; parishes.timezone wins when set
 * @property {string} publishes    observed cadence, and why the cron is what it is
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
];

export const getPdfSource = (key) => PDF_SOURCES.find(s => s.key === key) || null;

/** Where the extractor writes, and the adapter reads. */
export const r2KeyFor = (key) => `pdf-schedules/${key}.json`;
