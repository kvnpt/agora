const Database = require('better-sqlite3');

const DB_PATH = process.env.AGORA_DB_PATH;
if (!DB_PATH) {
  throw new Error('AGORA_DB_PATH env var is required (e.g. /app/data/agora.db). Refusing to fall back to a relative path.');
}

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

  if (version < 2) {
    db.exec(`ALTER TABLE parishes ADD COLUMN color TEXT`);
    db.pragma('user_version = 2');
  }

  if (version < 3) {
    // Replace coptic with macedonian in jurisdiction CHECK constraint
    db.pragma('foreign_keys = OFF');
    db.exec(`
      DROP TABLE IF EXISTS parishes_new;
      CREATE TABLE parishes_new (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        full_name TEXT,
        jurisdiction TEXT NOT NULL CHECK(jurisdiction IN ('antiochian','greek','serbian','russian','romanian','macedonian','other')),
        address TEXT,
        lat REAL NOT NULL,
        lng REAL NOT NULL,
        website TEXT,
        phone TEXT,
        email TEXT,
        logo_path TEXT,
        acronym TEXT,
        chant_style TEXT,
        languages TEXT NOT NULL DEFAULT '["English"]',
        color TEXT
      );
      INSERT INTO parishes_new SELECT * FROM parishes;
      DROP TABLE parishes;
      ALTER TABLE parishes_new RENAME TO parishes;
    `);
    db.pragma('foreign_keys = ON');
    db.pragma('user_version = 3');
  }

  if (version < 4) {
    db.exec(`ALTER TABLE schedules ADD COLUMN languages TEXT`);
    db.exec(`ALTER TABLE events ADD COLUMN languages TEXT`);
    db.pragma('user_version = 4');
  }

  if (version < 5) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS senders (
        phone TEXT PRIMARY KEY,
        name TEXT,
        status TEXT NOT NULL DEFAULT 'approved' CHECK(status IN ('approved','review','blocked')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
      );
      ALTER TABLE events ADD COLUMN poster_path TEXT;
    `);
    db.pragma('user_version = 5');
  }

  if (version < 6) {
    db.exec(`ALTER TABLE schedules ADD COLUMN week_of_month TEXT CHECK(week_of_month IN ('first','second','third','fourth','last'))`);
    db.pragma('user_version = 6');
  }

  if (version < 7) {
    // Remove CHECK constraint from week_of_month to support comma-separated values like 'first,third'
    db.pragma('foreign_keys = OFF');
    db.exec(`
      CREATE TABLE schedules_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parish_id TEXT NOT NULL REFERENCES parishes(id),
        day_of_week INTEGER NOT NULL CHECK(day_of_week BETWEEN 0 AND 6),
        start_time TEXT NOT NULL,
        end_time TEXT,
        title TEXT NOT NULL,
        event_type TEXT NOT NULL DEFAULT 'liturgy',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        languages TEXT,
        week_of_month TEXT
      );
      INSERT INTO schedules_new SELECT * FROM schedules;
      DROP TABLE schedules;
      ALTER TABLE schedules_new RENAME TO schedules;
    `);
    db.pragma('foreign_keys = ON');
    db.pragma('user_version = 7');
  }

  if (version < 8) {
    // Backfill: any parish with no schedules gets one generic inactive schedule
    db.exec(`
      INSERT INTO schedules (parish_id, day_of_week, start_time, title, event_type, active)
      SELECT p.id, 0, '09:00', 'Divine Liturgy', 'liturgy', 0
      FROM parishes p
      WHERE p.id != '_unassigned'
        AND NOT EXISTS (SELECT 1 FROM schedules s WHERE s.parish_id = p.id);
    `);
    db.pragma('user_version = 8');
  }

  if (version < 9) {
    db.exec(`ALTER TABLE parishes ADD COLUMN live_url TEXT`);
    db.pragma('user_version = 9');
  }

  if (version < 10) {
    db.exec(`ALTER TABLE adapter_runs ADD COLUMN input_texts TEXT`);
    db.exec(`ALTER TABLE adapter_runs ADD COLUMN claude_response TEXT`);
    db.pragma('user_version = 10');
  }

  if (version < 11) {
    db.exec(`ALTER TABLE schedules ADD COLUMN status TEXT NOT NULL DEFAULT 'approved'`);
    db.exec(`ALTER TABLE schedules ADD COLUMN source_run_id INTEGER REFERENCES adapter_runs(id)`);
    db.exec(`ALTER TABLE events ADD COLUMN source_run_id INTEGER REFERENCES adapter_runs(id)`);
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_parish_updates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        parish_id TEXT NOT NULL REFERENCES parishes(id),
        proposed_changes TEXT NOT NULL,
        sender_phone TEXT,
        source_run_id INTEGER REFERENCES adapter_runs(id),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        reviewed_at TEXT
      )
    `);
    db.pragma('user_version = 11');
  }

  if (version < 12) {
    db.exec(`ALTER TABLE schedules ADD COLUMN concurrent INTEGER NOT NULL DEFAULT 0`);
    db.pragma('user_version = 12');
  }

  if (version < 13) {
    db.exec(`ALTER TABLE events ADD COLUMN hide_live INTEGER NOT NULL DEFAULT 0`);
    db.pragma('user_version = 13');
  }

  if (version < 14) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_cancellations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
        reason TEXT,
        sender_phone TEXT,
        source_run_id INTEGER REFERENCES adapter_runs(id),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        reviewed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pending_cancellations_status ON pending_cancellations(status);
    `);
    db.pragma('user_version = 14');
  }

  if (version < 15) {
    db.exec(`ALTER TABLE schedules ADD COLUMN hide_live INTEGER NOT NULL DEFAULT 0`);
    db.pragma('user_version = 15');
  }

  if (version < 16) {
    db.exec(`ALTER TABLE events ADD COLUMN parish_scoped INTEGER NOT NULL DEFAULT 0`);
    db.pragma('user_version = 16');
  }

  if (version < 17) {
    db.prepare(`ALTER TABLE schedules ADD COLUMN parish_scoped INTEGER NOT NULL DEFAULT 0`).run();
    db.pragma('user_version = 17');
  }

  if (version < 18) {
    db.exec(`ALTER TABLE parishes ADD COLUMN source_run_id INTEGER REFERENCES adapter_runs(id)`);
    db.pragma('user_version = 18');
  }

  if (version < 19) {
    db.exec(`ALTER TABLE adapter_runs ADD COLUMN sender_phone TEXT`);
    db.exec(`ALTER TABLE adapter_runs ADD COLUMN parish_match_confidence TEXT`);
    db.exec(`ALTER TABLE adapter_runs ADD COLUMN parish_match_question TEXT`);
    db.pragma('user_version = 19');
  }

  if (version < 20) {
    db.exec(`ALTER TABLE events ADD COLUMN mutation_type TEXT NOT NULL DEFAULT 'scheduled'`);
    db.exec(`UPDATE events SET mutation_type = 'headless' WHERE source_adapter != 'schedule'`);
    db.exec(`CREATE TABLE IF NOT EXISTS event_parishes (event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, parish_id TEXT NOT NULL REFERENCES parishes(id), PRIMARY KEY (event_id, parish_id))`);
    db.exec(`CREATE TABLE IF NOT EXISTS event_replaces (replacing_event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE, replaced_event_id INTEGER NOT NULL REFERENCES events(id), PRIMARY KEY (replacing_event_id, replaced_event_id))`);
    db.pragma('user_version = 20');
  }

  if (version < 21) {
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      sid        TEXT PRIMARY KEY,
      data       TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )`).run();
    db.prepare(`ALTER TABLE senders ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`).run();
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_magic_tokens (
      token      TEXT PRIMARY KEY,
      phone      TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at    TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    )`).run();
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_sessions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      phone        TEXT NOT NULL,
      session_sid  TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      revoked      INTEGER NOT NULL DEFAULT 0
    )`).run();
    db.pragma('user_version = 21');
  }

  if (version < 22) {
    // Backfill: events written before their parish was geocoded held stale
    // Sydney-default coords. Resync non-overridden events to current parish
    // coords in one pass.
    db.prepare(`
      UPDATE events SET lat = (SELECT p.lat FROM parishes p WHERE p.id = events.parish_id),
                        lng = (SELECT p.lng FROM parishes p WHERE p.id = events.parish_id)
      WHERE (location_override IS NULL OR location_override = '')
        AND parish_id IN (SELECT id FROM parishes WHERE id != '_unassigned')
    `).run();
    db.pragma('user_version = 22');
  }
}

// Resync all non-overridden event coords for a single parish to match the
// parish's current lat/lng. Call this after any write that updates a parish's
// coordinates (webhook geocode, admin edit) so events don't drift.
function syncEventCoordsForParish(db, parishId) {
  if (!parishId || parishId === '_unassigned') return;
  const p = db.prepare('SELECT lat, lng FROM parishes WHERE id = ?').get(parishId);
  if (!p || p.lat == null || p.lng == null) return;
  db.prepare(`
    UPDATE events SET lat = ?, lng = ?
    WHERE parish_id = ? AND (location_override IS NULL OR location_override = '')
  `).run(p.lat, p.lng, parishId);
}

module.exports = { getDb, syncEventCoordsForParish };
