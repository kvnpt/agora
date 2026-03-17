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
    contact_email: null
  },
  {
    id: 'antiochian-stnicholas-punchbowl',
    name: 'St Nicholas, Punchbowl',
    jurisdiction: 'antiochian',
    address: '7 Boyd St, Punchbowl NSW 2196',
    lat: -33.9264,
    lng: 151.0568,
    website: null,
    contact_email: null
  },
  {
    id: 'antiochian-stmary-mayhill',
    name: "St Mary's, Mays Hill",
    jurisdiction: 'antiochian',
    address: '2 Kenyon St, Mays Hill NSW 2145',
    lat: -33.8269,
    lng: 150.9792,
    website: null,
    contact_email: null
  }
];

const sampleEvents = [
  {
    parish_id: 'antiochian-stmichael-ryde',
    source_adapter: 'seed',
    title: 'Sunday Divine Liturgy',
    description: 'Regular Sunday Divine Liturgy celebrated in English and Arabic.',
    start_utc: nextDay(0, 9, 0), // Next Sunday 9:00 AEDT
    end_utc: nextDay(0, 11, 30),
    event_type: 'liturgy',
    source_hash: 'seed-stmichael-sunday-liturgy',
    confidence: 'manual',
    status: 'approved'
  },
  {
    parish_id: 'antiochian-stmichael-ryde',
    source_adapter: 'seed',
    title: 'Saturday Vespers',
    description: 'Great Vespers service.',
    start_utc: nextDay(6, 17, 0), // Next Saturday 5pm AEDT
    end_utc: nextDay(6, 18, 0),
    event_type: 'vespers',
    source_hash: 'seed-stmichael-saturday-vespers',
    confidence: 'manual',
    status: 'approved'
  },
  {
    parish_id: 'antiochian-stnicholas-punchbowl',
    source_adapter: 'seed',
    title: 'Sunday Divine Liturgy',
    description: 'Divine Liturgy in Arabic and English.',
    start_utc: nextDay(0, 9, 30),
    end_utc: nextDay(0, 12, 0),
    event_type: 'liturgy',
    source_hash: 'seed-stnicholas-sunday-liturgy',
    confidence: 'manual',
    status: 'approved'
  },
  {
    parish_id: 'antiochian-stnicholas-punchbowl',
    source_adapter: 'seed',
    title: 'Youth Group Meeting',
    description: 'Monthly youth gathering with discussion, food, and fellowship.',
    start_utc: nextDay(5, 18, 30), // Next Friday 6:30pm
    end_utc: nextDay(5, 20, 30),
    event_type: 'youth',
    source_hash: 'seed-stnicholas-youth',
    confidence: 'manual',
    status: 'approved'
  },
  {
    parish_id: 'antiochian-stmary-mayhill',
    source_adapter: 'seed',
    title: 'Sunday Divine Liturgy',
    description: 'Divine Liturgy.',
    start_utc: nextDay(0, 10, 0),
    end_utc: nextDay(0, 12, 0),
    event_type: 'liturgy',
    source_hash: 'seed-stmary-sunday-liturgy',
    confidence: 'manual',
    status: 'approved'
  },
  {
    parish_id: 'antiochian-stmary-mayhill',
    source_adapter: 'seed',
    title: 'Annunciation Feast Day Celebration',
    description: 'Feast of the Annunciation — festive Divine Liturgy followed by parish lunch.',
    start_utc: nextDay(2, 9, 0), // Next Tuesday
    end_utc: nextDay(2, 14, 0),
    event_type: 'feast',
    source_hash: 'seed-stmary-annunciation',
    confidence: 'manual',
    status: 'approved'
  },
  {
    parish_id: 'antiochian-stmichael-ryde',
    source_adapter: 'seed',
    title: 'Lenten Lecture Series: The Fathers on Prayer',
    description: 'Fr. John presents on Patristic teachings about prayer during Great Lent.',
    start_utc: nextDay(3, 19, 0), // Next Wednesday 7pm
    end_utc: nextDay(3, 20, 30),
    event_type: 'talk',
    source_hash: 'seed-stmichael-lenten-talk',
    confidence: 'manual',
    status: 'approved'
  }
];

// Helper: get the next occurrence of a given day of week (0=Sun) at given AEDT time
function nextDay(dayOfWeek, hour, minute) {
  const now = new Date();
  // Work in UTC, target AEDT = UTC+11
  const offset = 11;
  const target = new Date(now);
  const currentDay = target.getUTCDay();
  let daysAhead = dayOfWeek - currentDay;
  if (daysAhead <= 0) daysAhead += 7;
  target.setUTCDate(target.getUTCDate() + daysAhead);
  target.setUTCHours(hour - offset, minute, 0, 0);
  return target.toISOString();
}

function seed() {
  const db = getDb();
  const insertParish = db.prepare(`
    INSERT OR IGNORE INTO parishes (id, name, jurisdiction, address, lat, lng, website, contact_email)
    VALUES (@id, @name, @jurisdiction, @address, @lat, @lng, @website, @contact_email)
  `);

  const insertEvent = db.prepare(`
    INSERT OR IGNORE INTO events (parish_id, source_adapter, title, description, start_utc, end_utc, event_type, source_hash, confidence, status, lat, lng)
    SELECT @parish_id, @source_adapter, @title, @description, @start_utc, @end_utc, @event_type, @source_hash, @confidence, @status, p.lat, p.lng
    FROM parishes p WHERE p.id = @parish_id
  `);

  const tx = db.transaction(() => {
    for (const p of parishes) {
      insertParish.run(p);
    }
    for (const e of sampleEvents) {
      insertEvent.run(e);
    }
  });
  tx();
  console.log(`Seeded ${parishes.length} parishes, ${sampleEvents.length} sample events`);
}

module.exports = { seed };
