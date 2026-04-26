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
 * Check if a date (YYYY-MM-DD) matches a single week qualifier.
 */
function matchesOneWeek(dateStr, qualifier) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dayOfMonth = d.getUTCDate();
  const nextWeek = new Date(d);
  nextWeek.setUTCDate(dayOfMonth + 7);
  const hasNextWeek = nextWeek.getUTCMonth() === d.getUTCMonth();

  if (qualifier === 'first')  return dayOfMonth <= 7;
  if (qualifier === 'second') return dayOfMonth >= 8  && dayOfMonth <= 14;
  if (qualifier === 'third')  return dayOfMonth >= 15 && dayOfMonth <= 21;
  // 'fourth' = 4th occurrence only when a 5th exists — never overlaps with 'last'
  if (qualifier === 'fourth') return dayOfMonth >= 22 && dayOfMonth <= 28 && hasNextWeek;
  if (qualifier === 'last')   return !hasNextWeek;
  return false;
}

/**
 * Check if a date matches a week_of_month value.
 * Supports comma-separated values e.g. 'first,third' or 'second,fourth,last'.
 * null = every week.
 */
function matchesWeekOfMonth(dateStr, qualifier) {
  if (!qualifier) return true;
  return qualifier.split(',').some(q => matchesOneWeek(dateStr, q.trim()));
}

/**
 * Convert a week_of_month value to a short human-readable label.
 * e.g. 'first,third' → '1st, 3rd'
 */
function weekOfMonthLabel(qualifier) {
  if (!qualifier) return null;
  const map = { first: '1st', second: '2nd', third: '3rd', fourth: '4th', last: 'last' };
  return qualifier.split(',').map(q => map[q.trim()] || q.trim()).join(', ');
}

/**
 * Generate event instances from recurring schedules for the next N weeks.
 */
function generateEvents(weeksAhead = 10, scheduleId = null) {
  const db = getDb();

  const schedules = scheduleId
    ? db.prepare(`SELECT s.*, p.lat, p.lng FROM schedules s JOIN parishes p ON s.parish_id = p.id WHERE s.id = ? AND s.active = 1`).all(scheduleId)
    : db.prepare(`SELECT s.*, p.lat, p.lng FROM schedules s JOIN parishes p ON s.parish_id = p.id WHERE s.active = 1`).all();

  if (!schedules.length) {
    console.log('[schedule-gen] No active schedules');
    return { generated: 0, cleaned: 0 };
  }

  const upsert = db.prepare(`
    INSERT INTO events (parish_id, source_adapter, schedule_id, title, start_utc, end_utc, event_type, source_hash, confidence, status, lat, lng, languages, hide_live, parish_scoped, mutation_type)
    VALUES (@parish_id, 'schedule', @schedule_id, @title, @start_utc, @end_utc, @event_type, @source_hash, 'schedule', 'approved', @lat, @lng, @languages, @hide_live, @parish_scoped, 'scheduled')
    ON CONFLICT(source_hash) DO UPDATE SET
      title        = CASE WHEN events.mutation_type = 'scheduled' THEN excluded.title        ELSE events.title        END,
      start_utc    = CASE WHEN events.mutation_type = 'scheduled' THEN excluded.start_utc    ELSE events.start_utc    END,
      end_utc      = CASE WHEN events.mutation_type = 'scheduled' THEN excluded.end_utc      ELSE events.end_utc      END,
      languages    = CASE WHEN events.mutation_type = 'scheduled' THEN excluded.languages    ELSE events.languages    END,
      hide_live    = CASE WHEN events.mutation_type = 'scheduled' THEN excluded.hide_live    ELSE events.hide_live    END,
      parish_scoped= CASE WHEN events.mutation_type = 'scheduled' THEN excluded.parish_scoped ELSE events.parish_scoped END,
      lat          = excluded.lat,
      lng          = excluded.lng,
      updated_at   = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
  `);

  // Pre-fetch dates where occurrences have been replaced (generator must skip these)
  const replacedBySchedule = {};
  db.prepare(`SELECT schedule_id, date(start_utc) as date_str FROM events WHERE schedule_id IS NOT NULL AND mutation_type = 'replaced'`).all()
    .forEach(r => {
      if (!replacedBySchedule[r.schedule_id]) replacedBySchedule[r.schedule_id] = new Set();
      replacedBySchedule[r.schedule_id].add(r.date_str);
    });

  const now = new Date();
  let generated = 0;

  const tx = db.transaction(() => {
    for (const schedule of schedules) {
      const replacedDates = replacedBySchedule[schedule.id] || new Set();
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

        // Skip if this date doesn't match the week_of_month qualifier
        if (!matchesWeekOfMonth(dateStr, schedule.week_of_month)) continue;
        // Skip if this occurrence has been replaced by another event
        if (replacedDates.has(dateStr)) continue;

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
          languages: schedule.languages || null,
          hide_live: schedule.hide_live ? 1 : 0,
          parish_scoped: schedule.parish_scoped ? 1 : 0
        });
        generated++;
      }
    }
  });
  tx();

  // Clean up future events that no longer match their schedule's week_of_month
  const womSchedules = db.prepare(`SELECT id, week_of_month, day_of_week FROM schedules WHERE week_of_month IS NOT NULL AND active = 1`).all();
  const delMismatch = db.prepare(`DELETE FROM events WHERE schedule_id = ? AND source_adapter = 'schedule' AND source_hash = ?`);
  let womCleaned = 0;
  for (const ws of womSchedules) {
    const futureEvents = db.prepare(`SELECT id, source_hash, start_utc FROM events WHERE schedule_id = ? AND source_adapter = 'schedule' AND start_utc >= ?`).all(ws.id, now.toISOString());
    for (const evt of futureEvents) {
      const dateStr = evt.start_utc.split('T')[0];
      if (!matchesWeekOfMonth(dateStr, ws.week_of_month)) {
        delMismatch.run(ws.id, evt.source_hash);
        womCleaned++;
      }
    }
  }
  if (womCleaned) console.log(`[schedule-gen] Cleaned ${womCleaned} events not matching week_of_month`);

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

module.exports = { generateEvents, localToUtc, sydneyOffset, matchesWeekOfMonth, weekOfMonthLabel };
