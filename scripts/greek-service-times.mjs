// What the Greek parishes that publish a service time actually say, quoted.
//
// THE REASON THIS FILE EXISTS. The Greek Archdiocese publishes no service
// times, so every rule here comes from a parish's own site, and those sites do
// not agree on anything — least of all on where a timetable lives or what it
// looks like. What they do share is that a parish states its times in a
// SENTENCE, somewhere on a page about something else. A crawler can find the
// page; only a person can say which sentence is a promise about next Sunday
// and which is a note about a working bee.
//
// So: `scrape-greek-schedules.mjs` produces pages, a person reads them, and
// what they select lands here — the sentence verbatim, the URL it is on, and
// the rule it means. `greek-schedules.test.mjs` then parses every `quote` and
// asserts it yields exactly the `start_time`, `end_time`, `days` and
// `event_type` claimed beside it. That is what stops this file drifting into a
// list of numbers somebody typed: a transcription error fails the suite.
//
// FIELDS.
//   parish_id     the row in `parishes`
//   source_ref    the page the quote is on — not the homepage, the page
//   quote         the parish's own words, verbatim, including the hedges
//   context       adjacent text from the SAME page, verbatim — the heading above
//                 the quote, or the other half of a sentence the quote is a
//                 clause of. Checked against the page like `quote` is.
//   note          the curator's own explanation. Never checked against anything,
//                 because it is not something the parish said.
//   title         what the card will say; chosen by a person, never guessed
//   days          0=Sun; supplied when the quote alone does not name the day
//   start_time /  local wall clock, per schema.sql — NOT normalised to UTC
//   end_time      null when the parish states a start and no finish
//   week_of_month null means every matching weekday
//   languages     only when the parish names one
//
// WHAT IS DELIBERATELY ABSENT. Parishes that publish a DATED programme — a
// month of real dates — are not in this file. Perth's Evangelismos, Templestowe
// and Geelong all do, and "a dated programme is not a rule" is the finding the
// Romanian run wrote down: `infer.mjs` turns observed occurrences into rules
// only when a rule reproduces the dates exactly, and hand-writing "Sundays 8am"
// off a September calendar asserts something the calendar does not. Those
// parishes want an adapter, and `docs/parish-ingestion.md` records which.

export const SERVICE_TIMES = [
  // ── All Saints, Belmore ───────────────────────────────────────────────────
  {
    parish_id: 'greek-allsaints-belmore',
    source_ref: 'https://www.allsaints.com.au/sacraments',
    quote: 'Matins and Liturgy take place every Sunday morning from 7:30am-10:30am.',
    context: 'Sunday Services',
    note: 'The parish files its weekly times on its Sacraments page rather than anywhere '
      + 'named for a timetable.',
    title: 'Matins & Divine Liturgy',
    days: [0],
    start_time: '07:30',
    end_time: '10:30',
    event_type: 'liturgy',
    week_of_month: null,
    languages: null,
  },

  // ── The Cathedral of the Annunciation of Our Lady, Redfern ───────────────
  //
  // The Cathedral's upcoming-services panel is a dated programme and is not
  // used. This line is different: it is a standing weekly claim in the site
  // footer, and it sits under a heading that reads "Opening Hours" — which is
  // recorded here rather than smoothed over, because that heading is exactly
  // what `NOT_A_SERVICE` refuses elsewhere. The line beside it, "Mon - Fri:
  // 8:00 AM - 3:30 PM", genuinely IS an opening time and is not taken. This one
  // names a service, a weekday and a span, and every dated Sunday in the
  // programme above it starts at 7:30 am, which is corroboration rather than
  // the source.
  {
    parish_id: 'greek-annunciationlady-redfern',
    source_ref: 'https://www.goacathedral.org.au',
    context: 'Sunday',
    note: 'In the site footer, under an "Opening Hours" heading. The "Mon - Fri: 8:00 AM - 3:30 PM" '
      + 'line above it is an opening time and is deliberately not taken.',
    quote: 'Divine Liturgy: 7:30 AM - 11:00 AM',
    title: 'Divine Liturgy',
    days: [0],
    start_time: '07:30',
    end_time: '11:00',
    event_type: 'liturgy',
    week_of_month: null,
    languages: null,
  },

  // ── The Presentation of Our Lord, Coburg ─────────────────────────────────
  //
  // The fullest timetable any Greek parish in Australia publishes, and the one
  // that needed the most judgement. Three of its lines are NOT here and the
  // reasons are worth keeping next to the ones that are:
  //
  //   Small Compline — the parish's own two pages give it as Tuesdays 7pm
  //     (/our-programs) and Tuesdays 5pm (/liturgical-programs). A source that
  //     contradicts itself is not a source for either hour.
  //   Youth Group, Tuesdays 7:30pm — "alternates between the Parishes of St
  //     Vasilios's (Brunswick) and The Presentation of Our Lord (Coburg)".
  //     A fortnight has no spelling in week_of_month, and the widened rule
  //     would put it at this church on the Tuesdays it is at the other one.
  //   Paraklesis to St John the Russian — given as Tuesday mornings on one page
  //     and Thursday mornings from 7am on the other. Same problem as Compline.
  //
  // The three-service sentence is quoted three times, once per clause, because
  // each clause carries its own hour. `context` holds the whole sentence so the
  // weekdays can be checked against the words that name them.
  {
    parish_id: 'greek-presentationlord-coburg',
    source_ref: 'https://www.thepresentationofourlord.org.au/our-programs',
    quote: 'Every Tuesday and Sunday our Parish conducts these services commencing at 6:30am with the Midnight Service',
    title: 'Midnight Service',
    days: [0, 2],
    start_time: '06:30',
    end_time: null,
    event_type: 'prayer',
    week_of_month: null,
    languages: null,
  },
  {
    parish_id: 'greek-presentationlord-coburg',
    source_ref: 'https://www.thepresentationofourlord.org.au/our-programs',
    context: 'Every Tuesday and Sunday our Parish conducts these services commencing at 6:30am with the '
      + 'Midnight Service, followed by Matins at 7am and the Divine Liturgy at 9am.',
    quote: 'followed by Matins at 7am',
    title: 'Matins',
    days: [0, 2],
    start_time: '07:00',
    end_time: null,
    event_type: 'prayer',
    week_of_month: null,
    languages: null,
  },
  {
    parish_id: 'greek-presentationlord-coburg',
    source_ref: 'https://www.thepresentationofourlord.org.au/our-programs',
    context: 'Every Tuesday and Sunday our Parish conducts these services commencing at 6:30am with the '
      + 'Midnight Service, followed by Matins at 7am and the Divine Liturgy at 9am.',
    quote: 'and the Divine Liturgy at 9am',
    title: 'Divine Liturgy',
    days: [0, 2],
    start_time: '09:00',
    end_time: null,
    event_type: 'liturgy',
    week_of_month: null,
    languages: null,
  },
  {
    parish_id: 'greek-presentationlord-coburg',
    source_ref: 'https://www.thepresentationofourlord.org.au/our-programs',
    quote: 'Vespers take place every Saturday at 3pm (unless otherwise stated in the weekly program above).',
    title: 'Vespers',
    days: [6],
    start_time: '15:00',
    end_time: null,
    event_type: 'prayer',
    week_of_month: null,
    languages: null,
  },
  {
    parish_id: 'greek-presentationlord-coburg',
    source_ref: 'https://www.thepresentationofourlord.org.au/liturgical-programs',
    quote: 'Currently, English liturgies are served every Friday at 6pm and notified through the weekly program.',
    title: 'Divine Liturgy in English',
    days: [5],
    start_time: '18:00',
    end_time: null,
    event_type: 'liturgy',
    week_of_month: null,
    languages: ['English'],
  },
  {
    parish_id: 'greek-presentationlord-coburg',
    source_ref: 'https://www.thepresentationofourlord.org.au/our-programs',
    quote: 'Run by Theodore Theodorou, Catechism classes at our Parish are conducted on Tuesdays at 7pm.',
    title: 'Catechism Classes',
    days: [2],
    start_time: '19:00',
    end_time: null,
    event_type: 'talk',
    week_of_month: null,
    languages: null,
  },

  // ── St Anna, Bundall (Gold Coast) ────────────────────────────────────────
  //
  // The title comes from the heading directly above the hours — "Sunday Service
  // Matins & Divine Liturgy" — rather than from the quoted line, which says only
  // "Sunday Service". Naming the two offices is what the parish does one line up;
  // dropping to "Sunday Service" would claim less than the page does.
  {
    parish_id: 'greek-stanna-bundallgold',
    source_ref: 'https://gocstanna.org',
    quote: 'Sunday Service every Sunday | 7:30am - 10:30am',
    context: 'Sunday Service Matins & Divine Liturgy',
    title: 'Matins & Divine Liturgy',
    days: [0],
    start_time: '07:30',
    end_time: '10:30',
    event_type: 'liturgy',
    week_of_month: null,
    languages: null,
  },

  // ── St George, South Hobart ──────────────────────────────────────────────
  //
  // Published by the Greek Community of Tasmania, which runs this church — its
  // own publisher, not a third party.
  {
    parish_id: 'greek-stgeorge-southhobart',
    source_ref: 'https://www.greekcommunitytas.com.au/st-georges',
    quote: 'Sunday services always commence at 8:30am at St George’s, starting with Matins & Divine Liturgy.',
    title: 'Matins & Divine Liturgy',
    days: [0],
    start_time: '08:30',
    end_time: null,
    event_type: 'liturgy',
    week_of_month: null,
    languages: null,
  },

  // ── Sts Raphael, Nicholas & Irene, Liverpool ─────────────────────────────
  {
    parish_id: 'greek-straphael-liverpool',
    source_ref: 'https://www.straphael.org.au/whats-on',
    context: 'Every Sunday',
    quote: 'Matins + Divine Liturgy starting at 7:30am',
    title: 'Matins & Divine Liturgy',
    days: [0],
    start_time: '07:30',
    end_time: null,
    event_type: 'liturgy',
    week_of_month: null,
    languages: null,
  },

  // ── St Sophia, Taylor Square ─────────────────────────────────────────────
  //
  // The only monthly rule in the run, and the reason parseWeekOfMonth has to
  // understand "last ... of every month": without it this would project onto
  // every Saturday of the year.
  {
    parish_id: 'greek-stsophiathree-taylorsquare',
    source_ref: 'https://stsophia.org.au/divine-liturgy-in-english',
    // The hour and the week are in two different paragraphs, so the quote is
    // the one carrying the hour and `context` is the one carrying the week —
    // which is also the sentence that justifies week_of_month being 'last'.
    context: 'Dedicated to providing our English speaking parishioners with opportunities to engage with '
      + 'their faith. St Sophia has implemented a new initiative to perform the Divine Liturgy in English '
      + 'on the last Saturday morning of every month .',
    quote: 'The Liturgy begins at 9:00am.',
    title: 'Divine Liturgy in English',
    days: [6],
    start_time: '09:00',
    end_time: null,
    event_type: 'liturgy',
    week_of_month: 'last',
    languages: ['English'],
  },

  // ── St Sophrony, Hectorville ─────────────────────────────────────────────
  //
  // Two rules and not one, because the parish publishes two spans with a
  // boundary it states itself. Glenfield in the Romanian run got one rule for
  // the opposite reason: it published "09:00am to 12:00pm" as a single block.
  {
    parish_id: 'greek-stsophronyessex-hectorville',
    source_ref: 'https://saintsophronyorthodoxparish.com',
    quote: 'Sundays 8 am - 9 am',
    context: 'Matins Service',
    title: 'Matins',
    days: [0],
    start_time: '08:00',
    end_time: '09:00',
    event_type: 'prayer',
    week_of_month: null,
    languages: null,
  },
  {
    parish_id: 'greek-stsophronyessex-hectorville',
    source_ref: 'https://saintsophronyorthodoxparish.com',
    quote: 'Sundays 9 am - 10.30 am',
    context: 'Divine Liturgy',
    title: 'Divine Liturgy',
    days: [0],
    start_time: '09:00',
    end_time: '10:30',
    event_type: 'liturgy',
    week_of_month: null,
    languages: null,
  },
];

/**
 * Parishes that publish something this run deliberately did NOT turn into a
 * rule, and why. Printed by the build so the report has a denominator: a parish
 * that publishes an unreadable timetable is a different finding from one that
 * publishes nothing, and both are different from one nobody looked at.
 */
export const PUBLISHES_BUT_NOT_A_RULE = [
  {
    parish_id: 'greek-annunciationlady-westperth',
    url: 'https://evangelismos.com.au',
    why: 'publishes a dated calendar of every service, weeks ahead — an adapter\'s input, not a hand-written rule',
  },
  {
    parish_id: 'greek-stharalambos-templestowe',
    url: 'https://www.stharalambos.org.au',
    why: 'publishes a dated "calendar of services", and the copy on the site is a year stale',
  },
  {
    parish_id: 'greek-dormitionlady-geelong',
    url: 'https://hocog.org.au',
    why: 'the Greek Community of Geelong publishes a dated monthly programme',
  },
  {
    parish_id: 'greek-stvasilios-brunswick',
    url: 'https://stvasiliosbrunswick.com',
    why: 'publishes only a confession availability — "every Monday to Friday between 4.00 - 6.00pm" — '
      + 'which is not a service with a start somebody arrives for',
  },
  {
    parish_id: 'greek-dormitionlady-mtgravatt',
    url: 'https://www.dormition.org.au',
    why: 'publishes administration office hours and no service time',
  },
  {
    parish_id: 'greek-stgerasimos-leichhardt',
    url: 'http://stgerasimosfellowship.blogspot.com',
    why: 'a blog whose most recent service post is years old; no recurring timetable',
  },
  {
    parish_id: 'greek-stgeorge-rosebay',
    url: 'https://www.stgeorgerosebay.org.au',
    why: 'publishes dated parish events and no weekly service times',
  },
  {
    parish_id: 'greek-stspyridon-kingsford',
    url: 'https://stspyridon.org.au',
    why: 'publishes a dated programme — every Sunday listed by name and date at 7:30-11:00am, '
      + 'which is an adapter\'s input and not a rule the parish has stated as one',
  },
  {
    parish_id: 'greek-stnektarios-dianella',
    url: 'https://www.stnektarioswa.org.au',
    why: 'the only recurring times it publishes are RADIO BROADCASTS of recorded liturgies — '
      + '"Thursdays from 1:30pm of the recorded English liturgy from the previous Saturday". '
      + 'A broadcast is not a service somebody travels to, and the liturgies themselves appear '
      + 'only in a newsletter dated 2022',
  },
];
