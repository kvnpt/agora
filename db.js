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
      CREATE TABLE parishes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        jurisdiction TEXT NOT NULL CHECK(jurisdiction IN ('antiochian','greek','serbian','russian','romanian','coptic','other')),
        address TEXT,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        website TEXT,
        contact_email TEXT
      );

      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parish_id TEXT NOT NULL REFERENCES parishes(id),
        source_adapter TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        start_utc TEXT NOT NULL,
        end_utc TEXT,
        recurrence TEXT,
        location_override TEXT,
        lat REAL,
        lng REAL,
        event_type TEXT NOT NULL DEFAULT 'other' CHECK(event_type IN ('liturgy','vespers','feast','festival','youth','talk','fundraiser','other')),
        source_url TEXT,
        source_hash TEXT,
        confidence TEXT NOT NULL DEFAULT 'manual' CHECK(confidence IN ('api','ai-parsed','manual')),
        status TEXT NOT NULL DEFAULT 'approved' CHECK(status IN ('approved','pending_review','rejected')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE INDEX idx_events_parish ON events(parish_id);
      CREATE INDEX idx_events_start ON events(start_utc);
      CREATE INDEX idx_events_status ON events(status);
      CREATE UNIQUE INDEX idx_events_source_hash ON events(source_hash) WHERE source_hash IS NOT NULL;

      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('viewer','contributor','admin')),
        parish_id TEXT REFERENCES parishes(id),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE event_submissions (
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
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
        reviewed_by INTEGER REFERENCES users(id),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );

      CREATE TABLE adapter_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        adapter_id TEXT NOT NULL,
        started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        finished_at TEXT,
        status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','success','failed')),
        events_found INTEGER DEFAULT 0,
        events_created INTEGER DEFAULT 0,
        events_updated INTEGER DEFAULT 0,
        error_message TEXT
      );
    `);
    db.pragma('user_version = 1');
  }
}

module.exports = { getDb };
