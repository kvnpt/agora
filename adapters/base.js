class BaseAdapter {
  constructor({ id, parishId, schedule, sourceType }) {
    if (!id) throw new Error('Adapter must have an id');
    if (!parishId) throw new Error('Adapter must have a parishId');

    this.id = id;
    this.parishId = parishId;
    this.schedule = schedule !== undefined ? schedule : '0 */6 * * *'; // default: every 6 hours
    this.sourceType = sourceType || 'manual';
  }

  /**
   * Fetch events from source. Must return array of normalised event objects:
   * { title, description, start_utc, end_utc, event_type, location_override, lat, lng, source_url, source_hash }
   */
  async fetchEvents() {
    throw new Error(`${this.id}: fetchEvents() not implemented`);
  }

  healthCheck() {
    const { getDb } = require('../db');
    const db = getDb();
    const lastRun = db.prepare(
      'SELECT * FROM adapter_runs WHERE adapter_id = ? ORDER BY started_at DESC LIMIT 1'
    ).get(this.id);

    return {
      healthy: !lastRun || lastRun.status !== 'failed',
      message: lastRun ? `Last run: ${lastRun.status}` : 'Never run',
      lastRun: lastRun?.finished_at || null,
      lastError: lastRun?.error_message || null
    };
  }

  /**
   * Run the adapter: fetch events, upsert into DB, log the run.
   */
  async run() {
    const { getDb } = require('../db');
    const db = getDb();

    const runRecord = db.prepare(
      'INSERT INTO adapter_runs (adapter_id, status) VALUES (?, ?)'
    ).run(this.id, 'running');

    const runId = runRecord.lastInsertRowid;
    let eventsFound = 0, eventsCreated = 0, eventsUpdated = 0;

    try {
      const events = await this.fetchEvents();
      eventsFound = events.length;

      const upsert = db.prepare(`
        INSERT INTO events (parish_id, source_adapter, title, description, start_utc, end_utc, location_override, lat, lng, event_type, source_url, source_hash, confidence, status, hide_live, parish_scoped)
        VALUES (@parish_id, @source_adapter, @title, @description, @start_utc, @end_utc, @location_override, @lat, @lng, @event_type, @source_url, @source_hash, @confidence, @status, @hide_live, @parish_scoped)
        ON CONFLICT(source_hash) DO UPDATE SET
          title = excluded.title,
          description = excluded.description,
          start_utc = excluded.start_utc,
          end_utc = excluded.end_utc,
          event_type = excluded.event_type,
          hide_live = excluded.hide_live,
          parish_scoped = excluded.parish_scoped,
          updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      `);

      const parish = db.prepare('SELECT lat, lng FROM parishes WHERE id = ?').get(this.parishId);

      const tx = db.transaction(() => {
        for (const evt of events) {
          const result = upsert.run({
            parish_id: this.parishId,
            source_adapter: this.id,
            title: evt.title,
            description: evt.description || null,
            start_utc: evt.start_utc,
            end_utc: evt.end_utc || null,
            location_override: evt.location_override || null,
            lat: evt.lat || parish?.lat || null,
            lng: evt.lng || parish?.lng || null,
            event_type: evt.event_type || 'other',
            source_url: evt.source_url || null,
            source_hash: evt.source_hash || null,
            confidence: evt.confidence || this._defaultConfidence(),
            status: evt.status || this._defaultStatus(),
            hide_live: evt.hide_live ? 1 : 0,
            parish_scoped: evt.parish_scoped ? 1 : 0
          });
          if (result.changes > 0) {
            eventsCreated++;
          }
        }
      });
      tx();

      db.prepare(`
        UPDATE adapter_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
        status = 'success', events_found = ?, events_created = ?, events_updated = ?
        WHERE id = ?
      `).run(eventsFound, eventsCreated, eventsUpdated, runId);

      console.log(`[${this.id}] Run complete: found=${eventsFound} created=${eventsCreated}`);
      return { eventsFound, eventsCreated, eventsUpdated };

    } catch (err) {
      db.prepare(`
        UPDATE adapter_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
        status = 'failed', error_message = ? WHERE id = ?
      `).run(err.message, runId);

      console.error(`[${this.id}] Run failed:`, err.message);
      throw err;
    }
  }

  _defaultConfidence() {
    return 'manual';
  }

  _defaultStatus() {
    return 'approved';
  }
}

module.exports = BaseAdapter;
