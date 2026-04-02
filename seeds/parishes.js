const { getDb } = require('../db');

const parishes = [
  {
    id: 'antiochian-stgeorge-redfern',
    name: 'St George Cathedral, Redfern',
    full_name: 'St George Antiochian Orthodox Cathedral',
    jurisdiction: 'antiochian',
    address: 'Cnr Walker & Cooper Streets, Redfern NSW 2016',
    lat: -33.8910,
    lng: 151.2089,
    website: 'https://stgeorgecathedral.com.au/',
    languages: '["Arabic", "English"]'
  },
  {
    id: 'antiochian-stnicholas-punchbowl',
    name: 'St Nicholas, Punchbowl',
    full_name: 'St Nicholas Antiochian Orthodox Church',
    jurisdiction: 'antiochian',
    address: '11 Henry St, Punchbowl NSW 2196',
    lat: -33.9222,
    lng: 151.0546,
    website: 'https://stnicholaspunchbowl.org.au/',
    languages: '["Arabic", "English"]'
  },
  {
    id: 'antiochian-stmary-mayshill',
    name: "St Mary's, Mays Hill",
    full_name: 'Nativity of the Theotokos Antiochian Orthodox Parish',
    jurisdiction: 'antiochian',
    address: '139 Burnett St, Mays Hill NSW 2145',
    lat: -33.8200,
    lng: 150.9909,
    website: 'https://www.saintmary.org.au/',
    languages: '["English", "Arabic"]'
  },
  {
    id: 'antiochian-stmichaelgabriel-ryde',
    name: 'Sts Michael & Gabriel, Ryde',
    full_name: 'Sts Michael & Gabriel Antiochian Orthodox Church',
    jurisdiction: 'antiochian',
    address: '72 Belmore St, Ryde NSW 2112',
    lat: -33.8181,
    lng: 151.0986,
    website: 'https://smg.org.au/',
    languages: '["English", "Arabic"]'
  },
  {
    id: 'antiochian-stnicholas-bankstown',
    name: 'St Nicholas, Bankstown',
    full_name: 'St Nicholas Antiochian Orthodox Church, Bankstown',
    jurisdiction: 'antiochian',
    address: '2a Weigand Ave, Bankstown NSW 2200',
    lat: -33.9160,
    lng: 151.0287,
    website: 'https://www.stnicholas-bankstown.org/',
    languages: '["Arabic", "English"]'
  },
  {
    id: 'antiochian-stspeterpaul-doonside',
    name: 'Sts Peter & Paul, Doonside',
    full_name: 'Sts Peter and Paul Antiochian Orthodox Church',
    jurisdiction: 'antiochian',
    address: '182 Hill End Road, Doonside NSW 2767',
    lat: -33.7485,
    lng: 150.8719,
    languages: '["Arabic", "English"]'
  },
  {
    id: 'antiochian-stjohnbaptist-croydonpark',
    name: 'St John the Baptist, Croydon Park',
    full_name: 'St John the Baptist Antiochian Orthodox Church',
    jurisdiction: 'antiochian',
    address: '12-14 Balmoral Ave, Croydon Park NSW 2133',
    lat: -33.8997,
    lng: 151.1017,
    website: 'https://stjohnthebaptist.church/',
    languages: '["Arabic", "English"]'
  },
  {
    id: 'antiochian-stelias-wollongong',
    name: 'St Elias, Wollongong',
    full_name: 'St Elias Antiochian Orthodox Church',
    jurisdiction: 'antiochian',
    address: '86 Kenny Street, Wollongong NSW 2500',
    lat: -34.4364,
    lng: 150.8905,
    website: 'https://www.saintelias.org.au/',
    languages: '["Arabic", "English"]'
  }
];

// Default weekly schedules for seeded parishes
const schedules = [
  { parish_id: 'antiochian-stgeorge-redfern', day_of_week: 0, start_time: '10:00', end_time: '12:00', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
  { parish_id: 'antiochian-stnicholas-punchbowl', day_of_week: 0, start_time: '09:30', end_time: '12:00', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
  { parish_id: 'antiochian-stmary-mayshill', day_of_week: 0, start_time: '10:00', end_time: '12:00', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
  { parish_id: 'antiochian-stmichaelgabriel-ryde', day_of_week: 0, start_time: '09:00', end_time: '11:30', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
  { parish_id: 'antiochian-stmichaelgabriel-ryde', day_of_week: 6, start_time: '17:00', end_time: '18:00', title: 'Saturday Vespers', event_type: 'vespers' },
  { parish_id: 'antiochian-stnicholas-bankstown', day_of_week: 0, start_time: '10:00', end_time: '12:00', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
  { parish_id: 'antiochian-stspeterpaul-doonside', day_of_week: 0, start_time: '10:00', end_time: '12:00', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
  { parish_id: 'antiochian-stjohnbaptist-croydonpark', day_of_week: 0, start_time: '10:00', end_time: '12:00', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
  { parish_id: 'antiochian-stelias-wollongong', day_of_week: 0, start_time: '10:00', end_time: '12:00', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
];

function seed() {
  const db = getDb();

  const insertParish = db.prepare(`
    INSERT OR IGNORE INTO parishes (id, name, full_name, jurisdiction, address, lat, lng, website, languages)
    VALUES (@id, @name, @full_name, @jurisdiction, @address, @lat, @lng, @website, @languages)
  `);

  const insertSchedule = db.prepare(`
    INSERT OR IGNORE INTO schedules (parish_id, day_of_week, start_time, end_time, title, event_type)
    VALUES (@parish_id, @day_of_week, @start_time, @end_time, @title, @event_type)
  `);

  const tx = db.transaction(() => {
    for (const p of parishes) {
      insertParish.run({
        ...p,
        full_name: p.full_name || null,
        website: p.website || null,
        languages: p.languages || '["English"]'
      });
    }
    // Only seed schedules if table is empty
    const count = db.prepare('SELECT COUNT(*) as n FROM schedules').get().n;
    if (count === 0) {
      for (const s of schedules) {
        insertSchedule.run(s);
      }
    }
  });
  tx();

  const parishCount = db.prepare('SELECT COUNT(*) as n FROM parishes WHERE id != ?').get('_unassigned').n;
  const scheduleCount = db.prepare('SELECT COUNT(*) as n FROM schedules').get().n;
  console.log(`Seeded ${parishCount} parishes, ${scheduleCount} schedules`);
}

module.exports = { seed };
