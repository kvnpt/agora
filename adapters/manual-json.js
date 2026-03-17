const BaseAdapter = require('./base');

/**
 * Manual adapter — reads approved submissions from the database
 * and creates events from them. This is the simplest adapter:
 * events are entered by contributors and approved by admins.
 */
class ManualJsonAdapter extends BaseAdapter {
  constructor() {
    super({
      id: 'manual',
      parishId: '*',  // handles all parishes
      schedule: '*/15 * * * *',  // every 15 minutes
      sourceType: 'manual'
    });
  }

  async fetchEvents() {
    const { getDb } = require('../db');
    const db = getDb();

    const submissions = db.prepare(`
      SELECT * FROM event_submissions WHERE status = 'approved'
    `).all();

    return submissions.map(s => ({
      title: s.title,
      description: s.description,
      start_utc: s.start_utc,
      end_utc: s.end_utc,
      event_type: s.event_type,
      source_url: s.source_url,
      source_hash: `manual-submission-${s.id}`,
      confidence: 'manual',
      status: 'approved'
    }));
  }

  // Override run to handle multi-parish
  async run() {
    const { getDb } = require('../db');
    const db = getDb();

    const runRecord = db.prepare(
      'INSERT INTO adapter_runs (adapter_id, status) VALUES (?, ?)'
    ).run(this.id, 'running');
    const runId = runRecord.lastInsertRowid;

    try {
      const submissions = db.prepare(`
        SELECT * FROM event_submissions WHERE status = 'approved'
      `).all();

      let eventsCreated = 0;

      const upsert = db.prepare(`
        INSERT INTO events (parish_id, source_adapter, title, description, start_utc, end_utc, event_type, source_url, source_hash, confidence, status, lat, lng)
        SELECT @parish_id, 'manual', @title, @description, @start_utc, @end_utc, @event_type, @source_url, @source_hash, 'manual', 'approved', p.lat, p.lng
        FROM parishes p WHERE p.id = @parish_id
        ON CONFLICT(source_hash) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          start_utc = excluded.start_utc,
          end_utc = excluded.end_utc,
          event_type = excluded.event_type,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      `);

      const tx = db.transaction(() => {
        for (const s of submissions) {
          const result = upsert.run({
            parish_id: s.parish_id,
            title: s.title,
            description: s.description || null,
            start_utc: s.start_utc,
            end_utc: s.end_utc || null,
            event_type: s.event_type || 'other',
            source_url: s.source_url || null,
            source_hash: `manual-submission-${s.id}`
          });
          if (result.changes > 0) eventsCreated++;
        }
      });
      tx();

      db.prepare(`
        UPDATE adapter_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
        status = 'success', events_found = ?, events_created = ?
        WHERE id = ?
      `).run(submissions.length, eventsCreated, runId);

      console.log(`[manual] Run complete: found=${submissions.length} created=${eventsCreated}`);
      return { eventsFound: submissions.length, eventsCreated, eventsUpdated: 0 };

    } catch (err) {
      db.prepare(`
        UPDATE adapter_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
        status = 'failed', error_message = ? WHERE id = ?
      `).run(err.message, runId);
      throw err;
    }
  }
}

module.exports = new ManualJsonAdapter();
