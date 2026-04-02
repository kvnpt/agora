const { getDb } = require('../db');

const parishes = [
  {
    id: 'antiochian-stmichael-ryde',
    name: 'Sts Michael & Gabriel, Ryde',
    jurisdiction: 'antiochian',
    address: '39 Quarry Rd, Ryde NSW 2112',
    lat: -33.8154,
    lng: 151.1073,
    website: 'https://www.stsmichaelandgabriel.org.au',
    languages: '["English", "Arabic"]'
  },
  {
    id: 'antiochian-stnicholas-punchbowl',
    name: 'St Nicholas, Punchbowl',
    jurisdiction: 'antiochian',
    address: '7 Boyd St, Punchbowl NSW 2196',
    lat: -33.9264,
    lng: 151.0568,
    languages: '["Arabic", "English"]'
  },
  {
    id: 'antiochian-stmary-mayhill',
    name: "St Mary's, Mays Hill",
    jurisdiction: 'antiochian',
    address: '2 Kenyon St, Mays Hill NSW 2145',
    lat: -33.8269,
    lng: 150.9792,
    languages: '["English", "Arabic"]'
  }
];

// Default weekly schedules for seeded parishes
const schedules = [
  { parish_id: 'antiochian-stmichael-ryde', day_of_week: 0, start_time: '09:00', end_time: '11:30', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
  { parish_id: 'antiochian-stmichael-ryde', day_of_week: 6, start_time: '17:00', end_time: '18:00', title: 'Saturday Vespers', event_type: 'vespers' },
  { parish_id: 'antiochian-stnicholas-punchbowl', day_of_week: 0, start_time: '09:30', end_time: '12:00', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
  { parish_id: 'antiochian-stmary-mayhill', day_of_week: 0, start_time: '10:00', end_time: '12:00', title: 'Sunday Divine Liturgy', event_type: 'liturgy' },
];

function seed() {
  const db = getDb();

  const insertParish = db.prepare(`
    INSERT OR IGNORE INTO parishes (id, name, jurisdiction, address, lat, lng, website, languages)
    VALUES (@id, @name, @jurisdiction, @address, @lat, @lng, @website, @languages)
  `);

  const insertSchedule = db.prepare(`
    INSERT OR IGNORE INTO schedules (parish_id, day_of_week, start_time, end_time, title, event_type)
    VALUES (@parish_id, @day_of_week, @start_time, @end_time, @title, @event_type)
  `);

  const tx = db.transaction(() => {
    for (const p of parishes) {
      insertParish.run({
        ...p,
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
