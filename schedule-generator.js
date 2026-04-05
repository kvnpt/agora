const { getDb } = require('./db');

/**
 * Determine UTC offset for Sydney on a given date.
 * AEDT (UTC+11): first Sunday in October → first Sunday in April
 * AEST (UTC+10): first Sunday in April → first Sunday in October
 */
function sydneyOffset(date) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth(); // 0-indexed

  // Find first Sunday in a given month
  function firstSunday(y, m) {
    const d = new Date(Date.UTC(y, m, 1));
    return 1 + (7 - d.getUTCDay()) % 7;
  }

  const dstStart = new Date(Date.UTC(year, 9, firstSunday(year, 9), 2, 0, 0)); // Oct, 2am AEST = 16:00 UTC prev day
  const dstEnd = new Date(Date.UTC(year, 3, firstSunday(year, 3), 3, 0, 0));   // Apr, 3am AEDT = 16:00 UTC prev day

  // Simplified: if between April first Sunday and October first Sunday → AEST (+10)
  if (date >= dstEnd && date < dstStart) return 10;
  return 11;
}

/**
 * Convert Sydney local time string to UTC ISO string for a given date.
 * @param {string} dateStr - YYYY-MM-DD
 * @param {string} timeStr - HH:MM
 * @returns {string} ISO 8601 UTC string
 */
function localToUtc(dateStr, timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  const localDate = new Date(`${dateStr}T${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00Z`);
  const offset = sydneyOffset(localDate);
  const utc = new Date(localDate.getTime() - offset * 3600000);
  return utc.toISOString();
}

/**
 * Generate event instances from recurring schedules for the next N weeks.
 */
function generateEvents(weeksAhead = 4) {
  const db = getDb();

  const schedules = db.prepare(`
    SELECT s.*, p.lat, p.lng
    FROM schedules s
    JOIN parishes p ON s.parish_id = p.id
    WHERE s.active = 1
  `).all();

  if (!schedules.length) {
    console.log('[schedule-gen] No active schedules');
    return { generated: 0, cleaned: 0 };
  }

  const upsert = db.prepare(`
    INSERT INTO events (parish_id, source_adapter, schedule_id, title, start_utc, end_utc, event_type, source_hash, confidence, status, lat, lng, languages)
    VALUES (@parish_id, 'schedule', @schedule_id, @title, @start_utc, @end_utc, @event_type, @source_hash, 'schedule', 'approved', @lat, @lng, @languages)
    ON CONFLICT(source_hash) DO UPDATE SET
      title = excluded.title,
      start_utc = excluded.start_utc,
      end_utc = excluded.end_utc,
      languages = excluded.languages,
      updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `);

  const now = new Date();
  let generated = 0;

  const tx = db.transaction(() => {
    for (const schedule of schedules) {
      for (let week = 0; week < weeksAhead; week++) {
        // Find the next occurrence of this day_of_week
        const target = new Date(now);
        target.setUTCDate(target.getUTCDate() + week * 7);

        const currentDay = target.getUTCDay();
        let daysAhead = schedule.day_of_week - currentDay;
        if (week === 0 && daysAhead < 0) daysAhead += 7;
        if (week === 0 && daysAhead === 0) daysAhead = 0; // today is valid
        target.setUTCDate(target.getUTCDate() + daysAhead);

        const dateStr = target.toISOString().split('T')[0];
        const startUtc = localToUtc(dateStr, schedule.start_time);
        const endUtc = schedule.end_time ? localToUtc(dateStr, schedule.end_time) : null;
        const sourceHash = `schedule-${schedule.id}-${dateStr}`;

        upsert.run({
          parish_id: schedule.parish_id,
          schedule_id: schedule.id,
          title: schedule.title,
          start_utc: startUtc,
          end_utc: endUtc,
          event_type: schedule.event_type,
          source_hash: sourceHash,
          lat: schedule.lat,
          lng: schedule.lng,
          languages: schedule.languages || null
        });
        generated++;
      }
    }
  });
  tx();

  // Clean up old schedule-generated events (older than 7 days)
  const cutoff = new Date(now.getTime() - 7 * 86400000).toISOString();
  let cleaned = db.prepare(`
    DELETE FROM events WHERE source_adapter = 'schedule' AND start_utc < ?
  `).run(cutoff).changes;

  // Clean up future events from disabled schedules
  const disabledCleaned = db.prepare(`
    DELETE FROM events WHERE source_adapter = 'schedule' AND start_utc >= ?
    AND schedule_id IN (SELECT id FROM schedules WHERE active = 0)
  `).run(now.toISOString()).changes;
  cleaned += disabledCleaned;

  console.log(`[schedule-gen] Generated ${generated} events, cleaned ${cleaned} old`);
  return { generated, cleaned };
}

module.exports = { generateEvents, localToUtc, sydneyOffset };
