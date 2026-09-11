// Seed data: the parishes and recurrence rules a fresh database starts with.
const ANTIOCHIAN_BLUE = '#1e3a5f';
const GREEK_BLUE = '#0d5eaf';

const parishes = [
  {
    id: 'antiochian-stgeorge-redfern',
    name: 'St George Cathedral, Redfern',
    full_name: 'St George Antiochian Orthodox Cathedral',
    jurisdiction: 'antiochian',
    address: 'Cnr Walker & Cooper Streets, Redfern NSW 2016',
    lat: -33.8910, lng: 151.2089,
    website: 'https://stgeorgecathedral.com.au/',
    languages: '["Arabic", "English"]',
    color: ANTIOCHIAN_BLUE
  },
  {
    // Melbourne, not Sydney — a mission at the Monash University Religious
    // Centre rather than a parish with its own building, which is why the
    // address is a room on a campus. Its row existed only in the database the
    // VM took with it; everything else here predates that.
    id: 'antiochian-good-shepherd-antiochian-church',   // must match the adapter's parishId
    name: 'The Good Shepherd, Clayton',
    full_name: 'The Good Shepherd Antiochian Orthodox Church',
    jurisdiction: 'antiochian',
    // From the parish's own published listings, which give the street address
    // on every entry. Replaces a guess at "21 Chancellors Walk ... 3800" made
    // when no source could be reached — wrong street and wrong postcode.
    // Services run in two rooms at this address: the Religious Centre and the
    // Monash Orthodox Chaplaincy. The parish pin is the building; which room
    // rides on each event as location_override.
    address: 'Religious Centre, 38 Exhibition Walk, Clayton VIC 3168',
    lat: -37.9115, lng: 145.1330,
    timezone: 'Australia/Melbourne',
    website: 'https://www.thegoodshepherd.org.au/',
    languages: '["English"]',
    color: ANTIOCHIAN_BLUE
  },
  {
    id: 'antiochian-stnicholas-punchbowl',
    name: 'St Nicholas, Punchbowl',
    full_name: 'St Nicholas Antiochian Orthodox Church',
    jurisdiction: 'antiochian',
    address: '11 Henry St, Punchbowl NSW 2196',
    lat: -33.9222, lng: 151.0546,
    website: 'https://stnicholaspunchbowl.org.au/',
    languages: '["Arabic", "English"]',
    color: ANTIOCHIAN_BLUE
  },
  {
    id: 'antiochian-stmary-mayshill',
    name: "St Mary's, Mays Hill",
    full_name: 'Nativity of the Theotokos Antiochian Orthodox Parish',
    jurisdiction: 'antiochian',
    address: '139 Burnett St, Mays Hill NSW 2145',
    lat: -33.8200, lng: 150.9909,
    website: 'https://www.saintmary.org.au/',
    languages: '["English", "Arabic"]',
    color: ANTIOCHIAN_BLUE
  },
  {
    id: 'antiochian-stmichaelgabriel-ryde',
    name: 'Sts Michael & Gabriel, Ryde',
    full_name: 'Sts Michael & Gabriel Antiochian Orthodox Church',
    jurisdiction: 'antiochian',
    address: '72 Belmore St, Ryde NSW 2112',
    lat: -33.8181, lng: 151.0986,
    website: 'https://smg.org.au/',
    languages: '["English", "Arabic"]',
    color: ANTIOCHIAN_BLUE
  },
  {
    id: 'antiochian-stnicholas-bankstown',
    name: 'St Nicholas, Bankstown',
    full_name: 'St Nicholas Antiochian Orthodox Church, Bankstown',
    jurisdiction: 'antiochian',
    address: '2a Weigand Ave, Bankstown NSW 2200',
    lat: -33.9160, lng: 151.0287,
    website: 'https://www.stnicholas-bankstown.org/',
    languages: '["Arabic", "English"]',
    color: ANTIOCHIAN_BLUE
  },
  {
    id: 'antiochian-stspeterpaul-doonside',
    name: 'Sts Peter & Paul, Doonside',
    full_name: 'Sts Peter and Paul Antiochian Orthodox Church',
    jurisdiction: 'antiochian',
    address: '182 Hill End Road, Doonside NSW 2767',
    lat: -33.7485, lng: 150.8719,
    languages: '["Arabic", "English"]',
    color: ANTIOCHIAN_BLUE
  },
  {
    id: 'antiochian-stjohnbaptist-croydonpark',
    name: 'St John the Baptist, Croydon Park',
    full_name: 'St John the Baptist Antiochian Orthodox Church',
    jurisdiction: 'antiochian',
    address: '12-14 Balmoral Ave, Croydon Park NSW 2133',
    lat: -33.8997, lng: 151.1017,
    website: 'https://stjohnthebaptist.church/',
    languages: '["Arabic", "English"]',
    color: ANTIOCHIAN_BLUE
  },
  {
    // Queensland, and the first parish here outside the Antiochian
    // archdiocese. It publishes its year's liturgies as a PDF rather than a
    // calendar, which is what worker/lib/pdf-sources.mjs points at.
    //
    // Like Good Shepherd, a parish without its own building: a visiting priest
    // serves roughly fortnightly in a borrowed Anglican church, so the venue is
    // somebody else's address. Both come from the parish's own published
    // programme, which prints them on every sheet.
    //
    // ABOUT THE PIN. -26.6851, 153.0527 is what Nominatim returns for "7 Main
    // Street, Buderim QLD 4556" — the centroid of Main Street, not the church
    // door, because St Mark's is not in OpenStreetMap under any name. That is
    // the same answer worker/lib/geocode.mjs would store if this parish were
    // added through the admin panel, and Main Street is about 400m end to end,
    // so the marker lands within sight of the building. It is still worth
    // replacing with a confirmed position: unlike the parish's address, nobody
    // has checked this against the place itself.
    //
    // Australia/Brisbane, NOT Australia/Sydney. Queensland does not observe
    // daylight saving, so for half the year the default would render an 11:30am
    // liturgy as 12:30pm.
    id: 'greek-gopssc-buderim',
    name: 'Sunshine Coast, Buderim',
    full_name: 'Greek Orthodox Parish of the Sunshine Coast',
    jurisdiction: 'greek',
    address: "St Mark's Anglican Church, 7 Main Street, Buderim QLD 4556",
    lat: -26.6851, lng: 153.0527,
    timezone: 'Australia/Brisbane',
    website: 'https://orthodoxsunshinecoast.org/',
    // The programme is published twice over, English and Greek, in one file.
    languages: '["English", "Greek"]',
    color: GREEK_BLUE
  },
  {
    id: 'antiochian-stelias-wollongong',
    name: 'St Elias, Wollongong',
    full_name: 'St Elias Antiochian Orthodox Church',
    jurisdiction: 'antiochian',
    address: '86 Kenny Street, Wollongong NSW 2500',
    lat: -34.4364, lng: 150.8905,
    website: 'https://www.saintelias.org.au/',
    languages: '["Arabic", "English"]',
    color: ANTIOCHIAN_BLUE
  }
];

const schedules = [
  { parish_id: 'antiochian-stgeorge-redfern', day_of_week: 0, start_time: '10:00', end_time: '12:00', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
  { parish_id: 'antiochian-stnicholas-punchbowl', day_of_week: 0, start_time: '09:30', end_time: '12:00', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
  { parish_id: 'antiochian-stmary-mayshill', day_of_week: 0, start_time: '10:00', end_time: '12:00', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
  { parish_id: 'antiochian-stmichaelgabriel-ryde', day_of_week: 0, start_time: '09:00', end_time: '11:30', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
  { parish_id: 'antiochian-stmichaelgabriel-ryde', day_of_week: 6, start_time: '17:00', end_time: '18:00', title: 'Saturday Vespers', event_type: 'prayer' },
  { parish_id: 'antiochian-stnicholas-bankstown', day_of_week: 0, start_time: '10:00', end_time: '12:00', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
  { parish_id: 'antiochian-stspeterpaul-doonside', day_of_week: 0, start_time: '10:00', end_time: '12:00', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
  { parish_id: 'antiochian-stjohnbaptist-croydonpark', day_of_week: 0, start_time: '10:00', end_time: '12:00', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
  { parish_id: 'antiochian-stelias-wollongong', day_of_week: 0, start_time: '10:00', end_time: '12:00', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
];

// Pure data. The Node seeder that used to live here went with the Express app;
// the D1 seed is generated from these arrays by scripts/gen-seed-sql.js.
module.exports = { parishes, schedules };
