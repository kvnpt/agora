// What each jurisdiction's directory is, and what can actually be re-read.
//
// Six directories were scraped into D1 over four days in September 2026 and
// then nothing watched them. Parishes move, close, merge, build a website and
// change their service times, and the only signal any of that had happened
// would be somebody noticing a wrong card. `info_checked_at` and
// `source_checked_at` record when we last looked — this is the table that makes
// those two columns answer a question instead of just sitting there.
//
// The registry is data for the same reason pdf-sources.mjs is: the Worker needs
// it to describe a jurisdiction, and the re-scrape needs it to run one, and a
// second copy is a second chance for the two to disagree.
//
// ── WHY `automation` IS NOT A BOOLEAN ──
//
// "Can this be re-scraped?" has three answers here, and docs/parish-ingestion.md
// paid for all three:
//
//   full     the directory answers a plain fetch. Serbian and ROCOR are
//            WordPress REST APIs; a script reads them start to finish.
//
//   browser  half the sites return a shell. goacathedral.org.au returns
//            literally zero characters of body text to fetch, and its only
//            standing weekly rule is in that unrendered footer. Those pages need
//            a real browser into the cache before the parser sees them, and
//            three hosts cannot be reached from a scraping environment at all.
//
//   person   the Antiochian site answers 403 to every automated client. Its 24
//            pages are fetched by hand. This is also why its 67 rules are a
//            script and not an adapter — a Worker adapter would fail every four
//            hours forever.
//
// Collapsing those into one flag would put a button on a card that cannot work,
// which is the exact failure this admin panel spent four tiers removing.

/**
 * @typedef {object} Jurisdiction
 * @property {string} slug        the `parishes.jurisdiction` value
 * @property {string} label       what to call it on screen
 * @property {string} [directory] the jurisdiction's own parish directory
 * @property {'full'|'browser'|'person'|'none'} automation  see above
 * @property {string[]} parishScripts   the three reviewable passes, in order
 * @property {string[]} scheduleScripts the service-times pass, where one exists
 * @property {string} [scheduleSource]  what its rules cite, when they cite anything
 * @property {string} notes       what the next person will wish they knew
 */

/** @type {Jurisdiction[]} */
export const JURISDICTION_SOURCES = [
  {
    slug: 'greek',
    label: 'Greek Archdiocese',
    directory: 'https://greekorthodox.org.au',
    // The directory itself is fetchable; the 135 PARISH sites behind it are
    // not, and the service times live on those.
    automation: 'browser',
    parishScripts: ['greek-crawl.mjs', 'greek-directory.mjs'],
    scheduleScripts: ['scrape-greek-sites.mjs', 'greek-schedules.mjs', 'build-greek-schedules.mjs'],
    scheduleSource: 'Parish website',
    notes:
      'The Archdiocese publishes no service times, so every rule cites the parish’s own '
      + 'site — 17 rules across 8 of 135 parishes, and that ratio is a finding rather than '
      + 'a shortfall. Half the sites are a Wix or Squarespace shell needing a real browser, '
      + 'and three hosts refuse a scraping environment outright. A re-run’s most likely '
      + 'find is a website column: the last one changed 19 of them.',
  },
  {
    slug: 'russian',
    label: 'ROCOR Australia & New Zealand',
    directory: 'https://rocor.org.au',
    automation: 'full',
    parishScripts: ['scrape-rocor.mjs', 'geocode-rocor.mjs', 'build-rocor-sql.mjs'],
    scheduleScripts: [],
    notes:
      'A WordPress REST API, so the parish pass re-runs cleanly. The diocese publishes no '
      + 'addresses — its own directory links are dead — so those came from an aggregator '
      + 'and the rows are labelled ‘import’ rather than ‘website’. No service '
      + 'times are published anywhere, which is why this has no rules at all.',
  },
  {
    slug: 'antiochian',
    label: 'Antiochian Archdiocese',
    directory: 'https://antiochian.org.au',
    // The one that cannot be automated, and the one with the most to gain.
    automation: 'person',
    parishScripts: ['scrape-antiochian.mjs', 'geocode-antiochian.mjs', 'build-antiochian-sql.mjs'],
    scheduleScripts: ['build-antiochian-schedules.mjs'],
    scheduleSource: 'Antiochian Archdiocese',
    notes:
      'The site answers 403 to every automated client, so its 24 pages are fetched by a '
      + 'person into cache/ before any script runs. It is also the only jurisdiction whose '
      + 'own directory publishes service times — 62 of these 67 rules cite the '
      + 'Archdiocese itself, so a re-read here is the one that can find a whole '
      + 'jurisdiction’s timetable changed at once.',
  },
  {
    slug: 'serbian',
    label: 'Serbian Orthodox Church',
    directory: 'https://soc.org.au',
    automation: 'full',
    parishScripts: ['scrape-serbian.mjs', 'geocode-serbian.mjs', 'build-serbian-sql.mjs'],
    scheduleScripts: [],
    notes:
      'A WordPress REST API. The six rules on these parishes were typed by hand in /admin '
      + 'and carry no source at all — a re-run must leave them exactly as they are, '
      + 'because a scrape has nothing to say about a claim it did not make.',
  },
  {
    slug: 'romanian',
    label: 'Romanian Orthodox',
    automation: 'none',
    parishScripts: [],
    scheduleScripts: [],
    scheduleSource: 'Parish website',
    notes:
      'Imported without a reusable script, so re-reading it is a fresh job rather than a '
      + 're-run. Neither diocesan directory publishes a service time; the seven rules here '
      + 'each came from a parish’s own site. Three parishes publish a dated month of '
      + 'services, which is an adapter’s work and not a recurrence rule.',
  },
  {
    slug: 'macedonian',
    label: 'Macedonian Orthodox',
    automation: 'none',
    parishScripts: [],
    scheduleScripts: [],
    notes:
      'Imported without a reusable script. The diocesan pages publish office hours, which '
      + 'is not a service time and must not be read as one — which is why these 27 '
      + 'parishes have no rules and no websites on file.',
  },
];

export const getJurisdiction = (slug) =>
  JURISDICTION_SOURCES.find(j => j.slug === slug) || null;

/** Can the panel start a re-scrape for this one at all? */
export const isRerunnable = (j) => !!j && j.automation !== 'none' && j.parishScripts.length > 0;

/** Why the button is not offered, in words worth reading. */
export function automationNote(j) {
  if (!j) return null;
  switch (j.automation) {
    case 'full':
      return 'Re-reads cleanly from here.';
    case 'browser':
      return 'The directory re-reads from here, but the parish sites behind it need a real '
        + 'browser — expect a partial answer on the service times.';
    case 'person':
      return 'The directory answers 403 to every automated client. Its pages have to be '
        + 'fetched by a person into cache/ before a re-run can read them.';
    default:
      return 'No re-runnable scraper exists for this one — it was imported by hand.';
  }
}

const DAY = 86400000;

/**
 * How long ago, in whole days. Null when never.
 *
 * Both dates this is asked about mean the same thing in different places:
 * `parishes.info_checked_at` is when we last read the directory for a parish's
 * details, `schedules.source_checked_at` is when we last read the page a rule
 * came from. Neither expires on its own, which is the whole reason to count.
 */
export function daysSince(iso, now = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(String(iso).endsWith('Z') || String(iso).includes('+') ? iso : `${iso}Z`);
  if (!Number.isFinite(t)) return null;
  return Math.max(0, Math.floor((now - t) / DAY));
}

/**
 * How overdue a jurisdiction is, as something to sort by.
 *
 * Deliberately NOT a single number pretending to be a score. Three months is
 * the threshold because that is roughly how the parish sheet already talks
 * about staleness — "Updated 3 months ago" — and because a directory that
 * changes is one that has had a season to change in.
 */
export const STALE_DAYS = 90;

export function staleness(days) {
  if (days === null) return 'never';
  if (days >= STALE_DAYS * 2) return 'overdue';
  if (days >= STALE_DAYS) return 'stale';
  return 'fresh';
}
