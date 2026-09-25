// Where a Greek parish actually publishes, when the Archdiocese directory does
// not say or says something that no longer answers.
//
// The directory lists a website for 34 of the 135 Greek parishes and eleven of
// those links are dead. This file is the hand-resolved remainder: one entry per
// parish that needed a person to look, with the URL, how it was found, and — on
// the ones where the answer is "nowhere" — that fact recorded explicitly.
//
// WHY A FILE AND NOT A COLUMN. Same reason `pdf-sources.mjs` is a file: it is
// curation, not data. Each line is somebody's judgement that this domain is
// this parish and not a different parish of the same dedication three suburbs
// over — Australia has nine Greek parishes called St Nicholas and five called
// St George — and that judgement wants to be reviewable in a diff, next to the
// evidence for it, rather than buried in a row somebody can edit later.
//
// `website: null` is a FINDING, not a gap. It means somebody searched and this
// parish has no site of its own, so the run reports it as "publishes nowhere"
// rather than "not looked at". The distinction is the whole reason the run can
// claim a denominator at all. `unreachable` is the third state and is neither:
// the site exists and this environment's egress cannot open it, which must not
// be recorded as the parish having no site.
//
// THE RULE ABOUT SOURCES STILL HOLDS. A search engine and an aggregator are
// signposts to a parish's own site and nothing more; no service time in this
// run comes from one. `orthodoxyinaustralia.com` in particular publishes times
// for most of these parishes and not one of them is used here — it is read for
// its outbound links and then closed. Where a parish publishes only through the
// community that runs it — the Greek Community of Melbourne runs five of these
// churches outright — that community IS the parish's publisher, and its page is
// a first-party source rather than an aggregator.
//
// `found` says how the URL was reached, so a later reader can check the work.

export const SITE_OVERRIDES = {
  // ── The directory's link is dead, or it lists none and the parish has one ──

  'greek-steuphemia-bankstown': {
    website: 'https://www.steuphemia.org',
    found: 'search; confirmed by the parish\'s own address and dedication on the page',
    note: 'The directory lists no website. Note .org, not .org.au.',
  },
  'greek-annunciationlady-redfern': {
    website: 'https://www.goacathedral.org.au',
    found: 'search; the Cathedral\'s own site, confirmed by address',
  },
  'greek-ststephanos-hurlstonepark': {
    website: 'http://www.ststephanos.com.au',
    found: 'aggregator link, confirmed by address; served over http only',
  },
  'greek-stcatherine-mascot': {
    website: 'https://www.stcatherine.org.au',
    found: 'aggregator link (saintcatherine.org.au), which redirects here',
  },
  'greek-straphael-liverpool': {
    website: 'https://www.straphael.org.au',
    found: 'aggregator link, confirmed by street address',
  },
  'greek-stgerasimos-leichhardt': {
    website: 'http://stgerasimosfellowship.blogspot.com',
    found: 'aggregator link, confirmed by street address',
  },
  'greek-holyapostles-hamilton': {
    website: 'http://holyapostlesnewcastle.blogspot.com',
    found: 'aggregator link, confirmed by suburb and dedication',
  },
  'greek-dormitionlady-mtgravatt': {
    website: 'https://www.dormition.org.au',
    found: 'aggregator link, confirmed by suburb and dedication',
  },
  'greek-stgeorge-southhobart': {
    website: 'https://www.greekcommunitytas.com.au/st-georges',
    found: 'the Greek Community of Tasmania runs this church and publishes its page',
  },
  'greek-dormitionlady-northaltona': {
    website: 'https://www.dormitionaltona.org.au/en',
    found: 'the directory\'s link, which is a one-line script that redirects to /en',
    note: 'The bare domain serves 156 bytes of JavaScript and no content; /en is the page.',
  },

  // ── The five churches the Greek Community of Melbourne runs itself ────────
  //
  // The directory lists no website for any of them because they do not have
  // one: the GCM publishes a page per church on its own site, and that is the
  // parish's own publisher rather than a third party. None of the five
  // publishes a service time — the pages carry the address, the priest and a
  // long parish history — which is a finding rather than a reason to skip them.

  'greek-annunciationlady-eastmelbourne': {
    website: 'https://www.greekcommunity.com.au/churches/evangelismos',
    found: 'Greek Community of Melbourne, which runs this church',
    note: 'Answers 403 to an automated client; read with a browser.',
  },
  'greek-stgeorge-thornbury': {
    website: 'https://www.greekcommunity.com.au/churches/holy-church-of-saint-george',
    found: 'Greek Community of Melbourne, which runs this church',
  },
  'greek-holytrinity-footscray': {
    website: 'https://www.greekcommunity.com.au/churches/holy-church-of-holy-trinity',
    found: 'Greek Community of Melbourne, which runs this church',
  },
  'greek-stdemetrios-prahran': {
    website: 'https://www.greekcommunity.com.au/churches/holy-church-of-saint-demetrios',
    found: 'Greek Community of Melbourne, which runs this church',
  },
  'greek-steleftherios-brunswick': {
    website: 'https://www.greekcommunity.com.au/churches/holy-church-of-saint-eleftherios',
    found: 'Greek Community of Melbourne, which runs this church',
  },

  // ── Sites that exist and this environment cannot open ─────────────────────
  //
  // Not the same as having no site, and deliberately not recorded as one. Two
  // hosts are refused at the egress gateway (ERR_TUNNEL_CONNECTION_FAILED from
  // a browser, `fetch failed` from Node) and two sit behind SiteGround's
  // captcha, which a real browser does not get past either. The URL is kept so
  // `parishes.website` can still be corrected; the times cannot be read here.

  'greek-stnicholas-kingston': {
    website: 'https://www.saintnicholascanberra.org.au',
    found: 'search; the parish publishes a Church Program page',
    unreachable: 'egress gateway refuses the host',
  },
  'greek-stnicholas-darwin': {
    website: 'https://gocna.com.au/st-nicholas/',
    found: 'search; the Greek Orthodox Community of Northern Australia runs it',
    unreachable: 'SiteGround captcha, which a real browser does not clear either',
  },
  'greek-stsconstantine-northbridge': {
    website: 'https://www.hcwa.org',
    found: 'the directory\'s own link, still listed on the parish row',
    unreachable: 'SiteGround captcha, which a real browser does not clear either',
  },
  'greek-stsophia-bowden': {
    website: 'https://www.stsophiaadelaide.org.au',
    found: 'the directory\'s own link, still listed on the parish row',
    unreachable: 'egress gateway answers 502 to CONNECT',
  },

  // ── Publishes only on Facebook, and that page is its site of record ──
  //
  // The exception to the Facebook rule below, made by the owner, for a parish
  // whose monthly bulletin names the page as the place it publishes. It is
  // recorded as the website so the parish sheet links it and the ladder treats
  // it as the parish speaking; it is `unreachable` because no crawl can read
  // Facebook, so the service times arrive from the bulletin instead
  // (docs/adapters.md, "A parish that publishes on Facebook").
  'greek-archangelmichael-crowsnest': {
    website: 'https://facebook.com/ArchMichaelGOC',
    found: 'the parish\'s September 2026 bulletin, which also gives Fr Timothy\'s mobile as the parish phone',
    unreachable: 'Facebook serves a login wall to every automated client',
  },

  // ── Looked for, and there is nothing to find ──────────────────────────────
  //
  // Every one of these was searched by name and suburb. Each has a Facebook
  // page and, in a few cases, an Instagram or a YouTube channel, and no website
  // of its own. Facebook is deliberately not recorded as a website: it cannot
  // be read by the crawl, cannot be re-read on a schedule, and a page nobody
  // can fetch is not a source a `source_ref` should point at.

  'greek-stsanargiri-oakleigh': { website: null, found: 'searched; Facebook and YouTube only' },
  'greek-stnectarios-burwood': { website: null, found: 'searched; Facebook only' },
  'greek-threehierarchs-clayton': { website: null, found: 'searched; Facebook and Instagram only' },
  'greek-steustathios-southmelbourne': { website: null, found: 'searched; Facebook only' },
  'greek-stsconstantine-newtown': { website: null, found: 'searched; Facebook only' },
  'greek-holycross-wollongong': { website: null, found: 'searched; Facebook only' },
  'greek-transfiguration-earlwood': { website: null, found: 'searched; Facebook only' },
  'greek-stsophia-paddington': { website: null, found: 'searched; no site of its own' },
  'greek-stspyridon-clayton': { website: null, found: 'searched; Facebook only' },
  'greek-ststheodores-townsville': { website: null, found: 'searched; Facebook only' },
  'greek-stnicholas-toowoomba': {
    website: null,
    found: 'searched; the one Toowoomba Orthodox site is a ROCOR mission, not this parish',
    note: 'orthodoxtoowoomba.com belongs to St John the Baptist Orthodox Mission (ROCOR). '
      + 'The aggregator offers it for this parish and it is a different church — which is why '
      + 'a candidate is confirmed against the dedication and not just the suburb.',
  },
  'greek-stathanasios-rookwood': {
    website: null,
    found: 'searched; the blogspot the aggregator lists answers "Blog not found"',
  },
  'greek-ladyaxionestin-northcote': {
    website: null,
    found: 'searched; Facebook and Instagram only',
    note: 'The parish row pointed at greekorthodox.org.au/monasteries/holy-monastery-of-axion-estin, '
      + 'which is a 404 — the Archdiocese moved it under /churches/. That is the directory, not a '
      + 'parish site, so the column is cleared rather than repointed at it: info_source_ref already '
      + 'says the directory is where this row came from.',
  },
};

/** Parish ids whose entry says the parish publishes nowhere. */
export const NO_SITE = Object.entries(SITE_OVERRIDES)
  .filter(([, v]) => v.website === null)
  .map(([k]) => k);

/** Parish ids with a real site this environment could not open. */
export const UNREACHABLE = Object.entries(SITE_OVERRIDES)
  .filter(([, v]) => v.unreachable)
  .map(([k]) => k);
