// Real parish schedules, as `pdftotext -layout` actually renders them.
//
// Every string below was produced by running scripts/extract-parish-pdf.mjs
// over a PDF downloaded from the parish's own site, and pasted in verbatim —
// leading spaces, wrapped superscripts, blank lines and all. That matters:
// almost everything awkward about parsing these files is a detail of the
// whitespace, and a fixture that has been tidied up tests nothing.
//
// The survey behind docs/adapters.md covered five files. Four are here; the
// fifth (orthodox.net, a grid whose fonts carry no ToUnicode map) decoded to
// mojibake and is represented by the note in that doc rather than by a string
// of rubbish.

// ── 1. The listing shape docs/adapters.md documents ──────────────────────────
// Time first, then the service, then the room. Good Shepherd runs in two rooms
// at one address, which is why the venue rides on each row rather than on the
// parish.
export const GOOD_SHEPHERD_LISTING = `
12
SEP, SAT
5pm     Vespers             Religious Centre, 38 Exhibition Walk, Clayton VIC 3168
6pm     Confession          Religious Centre, 38 Exhibition Walk, Clayton VIC 3168
13
SEP, SUN
9am     Matins (Orthros)    Monash Orthodox Chaplaincy, 38 Exhibition Walk, Clayton VIC 3168
10am    Divine Liturgy      Monash Orthodox Chaplaincy, 38 Exhibition Walk, Clayton VIC 3168
12:30pm FOUNDATIONS Course  Religious Centre, 38 Exhibition Walk, Clayton VIC 3168
19
SEP, SAT
5pm     Vespers             Religious Centre, 38 Exhibition Walk, Clayton VIC 3168
`;

// ── 2. Greek Orthodox Parish of the Sunshine Coast, 2025 ─────────────────────
// orthodoxsunshinecoast.org. Time LAST, no venue column, and the date header
// carries the feast name on the same line. Note what is here to be got wrong:
// "(Great & the Holy Lenten Fast 3/3)" is a note whose "3/3" is not a time,
// "NO SERVICE AT BUDERIM" is a real instruction that must not become an event,
// and a superscript "TH" wraps onto its own line mid-sentence.
export const SUNSHINE_COAST_2025 = `
                         PROGRAMME OF SERVICES

                 GREEK ORTHODOX ARCHDIOCESE OF AUSTRALIA
                   PARISH OF SUNSHINE COAST, QUEENSLAND

                          AT ST. MARK'S ANGLICAN CHURCH
                          7 MAIN STREET, BUDERIM QLD 4556


                                         2025
Sunday 12 January  SUNDAY AFTER THEOPHANY
                   NO SERVICE AT BUDERIM
                   DIVINE LITURGY AT ST PARASKEVI, TAIGUM
                   THROWING OF THE HOLY CROSS & GREEK FESTIVAL
                   (Venue To be advised)
Sunday 26 January   15TH SUNDAY OF LUKE, ZACCHEUS
                    Liturgy of John Chrysostom (Tone 6)                           11.30 am
Sunday 9 February 16 SUNDAY OF LUKE, THE PUBLICAN & THE PHARISEE
                       TH


                   (Beginning of the Triodion)
                   Liturgy of John Chrysostom (Tone 8)                            11.30 am
Sunday 23 February SUNDAY OF MEATFARE, THE LAST JUDGMENT
                   Liturgy of John Chrysostom (Tone 2)                            11.30 am
                           (Great & the Holy Lenten Fast 3/3)
Sunday 9 March     1ST SUNDAY OF GREAT LENT, SUNDAY OF ORTHODOXY
                   Holy Forty Martyrs of Sebaste
                   Liturgy of Basil the Great (Tone 4)                            11.30 am
`;

// ── 3. The same parish, a year later ─────────────────────────────────────────
// The 2026 sheet is a list of DATES, not of times: 26 Sundays, of which three
// carry a clock. Same parish, same publisher, one year apart — which is the
// answer to "is the shape stable". It also flips date order mid-document,
// "Sunday 11th January" early on and "Sunday July 12th" later.
export const SUNSHINE_COAST_2026 = `
GREEK ORTHODOX PARISH OF THE SUNSHINE COAST

Liturgy Dates – 2026
REVISED LIST INCLUDING DETAILS FOR HOLY WEEK
(Subject to Priest Availability)

JANUARY

                                   - 31st Sunday after Pentecost Afterfeast of Theophany, Sunday after the Theophany, St
Sunday 11th January
                                   Theodosius the Great, the Cenobiarch (529).

HOLY WEEK

Thursday 9th April                 – Holy Thursday – 7.00 pm to 11.00 pm
                                   Passion of Our Lord Jesus Christ with the reading of the Twelve Gospels.

Friday 10th April                  – Holy Friday – To be advised
                                   Decoration of the Holy Tomb of Christ in the Church Hall
                                   7.00 pm to 10.00 pm
                                   Service of the Procession of the Holy Epitaphios

Saturday 11th April                – 11.00 pm to 2.30am
                                   Vigil of the Resurrection, followed by CHRIST IS RISEN! & The Liturgy of the Resurrection (Holy
                                   Communion)

JULY

Sunday July 12th        – 6th Sunday after Pentecost (Matthew 6)
`;

// ── 4. Hellenic Orthodox Parish of Blacktown Districts, July 2026 ────────────
// stparaskevi.au. A bordered DATE | FEAST | SERVICE | TIME grid, and the reason
// parseSchedulePdfText refuses a whole class of file rather than guessing.
//
// Read the 02/07 block. Its first service — "Matins & Divine Liturgy
// 7:30-9:30 am", on the line straight after 01/07's vespers — belongs to
// 2 July, but the 02/07 cell is drawn once and centred, so it appears three
// lines LOWER than the service it labels. What actually separates the two days
// is a ruled line in the PDF's vector layer, which no text extractor emits.
// Attach that row to the nearest date above it and you have advertised a
// liturgy on the wrong morning and told reconcile.mjs the right one was
// cancelled.
export const BLACKTOWN_GRID = `
  DATE             FEAST                SERVICE                                                                             TIME

Wednesday   Holy Unmercenaries           Matins & Divine Liturgy                                                       7:30-9:30 am
  01/07      Cosmas & Damian             Vespers & Paraklesis to Saint Paraskevi                                       5:00-6:00 pm
                                         Matins & Divine Liturgy                                                       7:30-9:30 am
              Deposition of the
 Thursday
            Robe of the Most Holy        Vespers & Paraklesis to Saint Paraskevi                                       5:00-6:00 pm
  02/07
                 Theotokos
                                         Bible Studies and Q&A in the English language                                 6:00-7:15 pm
                                         Matins & Divine Liturgy                                                       7:30-9:30 am
  Friday                                 Vespers & Paraklesis to Saint Paraskevi                                       5:00-6:00 pm
                  Hyacinthus
  03/07
                                         Catechism Course & Reception into the Orthodox Church for adults who
                                                                                                                           6:00 pm
                                         wish to enter the Orthodox Faith
`;

// ── 5. St Nicholas, Wallsend ─────────────────────────────────────────────────
// stnicholaswallsend.org.au publishes a seasonal schedule going back to 2003.
// Every one of them is a photograph of a piece of paper: a single 2480x3504
// JPEG, no embedded fonts, no text layer. `pdftotext` returns exactly this.
//
// It is in the fixture because it is the strongest argument in the whole survey
// for keeping extraction out of the Worker. No parser improvement reaches this
// file; only OCR does, and OCR is not something a Worker can do.
export const WALLSEND_SCAN = '';
