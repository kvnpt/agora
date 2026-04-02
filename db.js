const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'agora.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

function migrate(db) {
  const version = db.pragma('user_version', { simple: true });

  if (version < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS parishes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        full_name TEXT,
        jurisdiction TEXT NOT NULL CHECK(jurisdiction IN ('antiochian','greek','serbian','russian','romanian','coptic','other')),
        address TEXT,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        website TEXT,
        phone TEXT,
        email TEXT,
        logo_path TEXT,
        acronym TEXT,
        chant_style TEXT,
        languages TEXT NOT NULL DEFAULT '["English"]'
      );

      CREATE TABLE IF NOT EXISTS schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parish_id TEXT NOT NULL REFERENCES parishes(id),
        day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
        start_time TEXT NOT NULL,
        end_time TEXT,
        title TEXT NOT NULL,
        event_type TEXT NOT NULL DEFAULT 'liturgy',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_schedules_parish ON schedules(parish_id);

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parish_id TEXT NOT NULL REFERENCES parishes(id),
        source_adapter TEXT NOT NULL,
        schedule_id INTEGER REFERENCES schedules(id),
        title TEXT NOT NULL,
        description TEXT,
        start_utc TEXT NOT NULL,
        end_utc TEXT,
        location_override TEXT,
        lat REAL,
        lng REAL,
        event_type TEXT NOT NULL DEFAULT 'other',
        source_url TEXT,
        source_hash TEXT,
        confidence TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL DEFAULT 'approved',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source_hash ON events(source_hash);
      CREATE INDEX IF NOT EXISTS idx_events_parish ON events(parish_id);
      CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_utc);
      CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
      CREATE INDEX IF NOT EXISTS idx_events_schedule ON events(schedule_id);

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        role TEXT NOT NULL DEFAULT 'viewer',
        parish_id TEXT REFERENCES parishes(id),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS event_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        submitted_by INTEGER REFERENCES users(id),
        parish_id TEXT NOT NULL REFERENCES parishes(id),
        title TEXT NOT NULL,
        description TEXT,
        start_utc TEXT NOT NULL,
        end_utc TEXT,
        event_type TEXT NOT NULL DEFAULT 'other',
        source_url TEXT,
        image_path TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        reviewed_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE IF NOT EXISTS adapter_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        adapter_id TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running',
        events_found INTEGER DEFAULT 0,
        events_created INTEGER DEFAULT 0,
        events_updated INTEGER DEFAULT 0,
        error_message TEXT
      );

      CREATE TABLE IF NOT EXISTS channels (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parish_id TEXT REFERENCES parishes(id),
        platform TEXT NOT NULL,
        ingest_method TEXT NOT NULL,
        config TEXT NOT NULL DEFAULT '{}',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE INDEX IF NOT EXISTS idx_channels_platform ON channels(platform);
      CREATE INDEX IF NOT EXISTS idx_channels_parish ON channels(parish_id);

      -- Sentinel parish for events with unknown parish
      INSERT OR IGNORE INTO parishes (id, name, jurisdiction, address, lat, lng)
      VALUES ('_unassigned', 'Unassigned / Unknown Parish', 'other', 'Sydney NSW', -33.8688, 151.2093);
    `);
    db.pragma('user_version = 1');
  }
}

module.exports = { getDb };
