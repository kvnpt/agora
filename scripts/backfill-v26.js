// One-shot backfill for schema v26 (materialize-on-read).
// Converts stored schedule-generated events into the new model:
//   mutation_type='scheduled'            -> delete (recomputed on read)
//   mutation_type='adapted'              -> schedule_overrides kind='modified'
//   event_replaces (suppressed base)     -> schedule_overrides kind='combined'
//   anything that can't map cleanly      -> kept as a standalone one-off (logged)
//
// Idempotent: re-running after success is a no-op (no schedule rows remain,
// event_replaces emptied, overrides use INSERT OR IGNORE).
//
// Run AFTER the v26 migration has created schedule_overrides. Requires
// AGORA_DB_PATH. Run on dev first and eyeball the summary before prod.
//
//   AGORA_DB_PATH=/path/to/agora.db node scripts/backfill-v26.js

const { getDb } = require('../db');
const { Temporal } = require('@js-temporal/polyfill');
const { matchesWeekOfMonth } = require('../schedule-generator');

const TZ = 'Australia/Sydney';

const sydDate = (utc) => Temporal.Instant.from(utc).toZonedDateTimeISO(TZ).toPlainDate().toString();
const sydHHMM = (utc) => {
  const z = Temporal.Instant.from(utc).toZonedDateTimeISO(TZ);
  return `${String(z.hour).padStart(2, '0')}:${String(z.minute).padStart(2, '0')}`;
};
const validOccurrence = (s, date) => {
  const pd = Temporal.PlainDate.from(date);
  const dow = pd.dayOfWeek === 7 ? 0 : pd.dayOfWeek;
  return dow === s.day_of_week && matchesWeekOfMonth(date, s.week_of_month);
};

function run() {
  const db = getDb();
  const stats = {
    combined_overrides: 0,
    hidden_overrides: 0,
    adapted_to_override: 0,
    adapted_to_oneoff: 0,
    scheduled_deleted: 0,
    kept_oneoff: 0,
    warnings: [],
  };

  const insModified = db.prepare(`
    INSERT OR IGNORE INTO schedule_overrides
      (schedule_id, occurrence_date, kind, patch_title, patch_start_time, patch_end_time,
       patch_event_type, patch_languages, patch_description, patch_location_override,
       patch_hide_live, patch_parish_scoped)
    VALUES (@schedule_id, @occurrence_date, 'modified', @patch_title, @patch_start_time, @patch_end_time,
       @patch_event_type, @patch_languages, @patch_description, @patch_location_override,
       @patch_hide_live, @patch_parish_scoped)
  `);
  const insCombined = db.prepare(`
    INSERT OR IGNORE INTO schedule_overrides (schedule_id, occurrence_date, kind, combined_into_event_id)
    VALUES (?, ?, 'combined', ?)
  `);
  const insHidden = db.prepare(`
    INSERT OR IGNORE INTO schedule_overrides (schedule_id, occurrence_date, kind)
    VALUES (?, ?, 'hidden')
  `);
  const toOneOff = db.prepare(
    "UPDATE events SET source_adapter='manual', schedule_id=NULL, mutation_type='headless' WHERE id=?"
  );
  const delEvent = db.prepare('DELETE FROM events WHERE id=?');

  const tx = db.transaction(() => {
    // 1. event_replaces where the suppressed base is a SCHEDULE instance ->
    //    combined override. One-off->one-off combines are left untouched (the
    //    base keeps status='replaced', which the API default filter drops, and
    //    the old escalate route keeps working until phase 2 migrates it).
    for (const r of db.prepare('SELECT * FROM event_replaces').all()) {
      const base = db.prepare('SELECT * FROM events WHERE id=?').get(r.replaced_event_id);
      if (!base || !base.schedule_id) continue;          // not a schedule instance -> leave as-is
      const s = db.prepare('SELECT * FROM schedules WHERE id=?').get(base.schedule_id);
      const date = sydDate(base.start_utc);
      if (!(s && validOccurrence(s, date))) {
        stats.warnings.push(`combined: base ${base.id} date ${date} not a valid occurrence of schedule ${base.schedule_id} -> left as-is`);
        continue;
      }
      const repl = db.prepare('SELECT * FROM events WHERE id=?').get(r.replacing_event_id);
      if (repl && repl.source_adapter === 'schedule') {
        // The combining event must survive as a one-off (not excluded on read).
        db.prepare("UPDATE events SET source_adapter='manual', schedule_id=NULL WHERE id=?").run(repl.id);
      }
      insCombined.run(base.schedule_id, date, r.replacing_event_id);
      stats.combined_overrides++;
      db.prepare('DELETE FROM event_replaces WHERE replacing_event_id=? AND replaced_event_id=?')
        .run(r.replacing_event_id, r.replaced_event_id);
      delEvent.run(base.id);
    }

    // 2. adapted schedule events -> modified overrides.
    for (const e of db.prepare("SELECT * FROM events WHERE source_adapter='schedule' AND mutation_type='adapted'").all()) {
      const s = e.schedule_id ? db.prepare('SELECT * FROM schedules WHERE id=?').get(e.schedule_id) : null;
      const date = sydDate(e.start_utc);
      if (!s || !validOccurrence(s, date)) {
        toOneOff.run(e.id);
        stats.adapted_to_oneoff++;
        stats.warnings.push(`adapted: event ${e.id} date ${date} not a valid occurrence of schedule ${e.schedule_id} -> kept as one-off`);
        continue;
      }
      const evStart = sydHHMM(e.start_utc);
      const evEnd = e.end_utc ? sydHHMM(e.end_utc) : null;
      insModified.run({
        schedule_id: s.id,
        occurrence_date: date,
        patch_title: e.title !== s.title ? e.title : null,
        patch_start_time: evStart !== s.start_time ? evStart : null,
        patch_end_time: (evEnd || null) !== (s.end_time || null) ? evEnd : null,
        patch_event_type: e.event_type !== s.event_type ? e.event_type : null,
        patch_languages: (e.languages || null) !== (s.languages || null) ? (e.languages || null) : null,
        patch_description: e.description || null,
        patch_location_override: e.location_override || null,
        patch_hide_live: (e.hide_live || 0) !== (s.hide_live || 0) ? e.hide_live : null,
        patch_parish_scoped: (e.parish_scoped || 0) !== (s.parish_scoped || 0) ? e.parish_scoped : null,
      });
      stats.adapted_to_override++;
      delEvent.run(e.id);
    }

    // 3. remaining schedule-sourced rows. Hidden instances get a 'hidden'
    //    override so the suppression survives; plain scheduled/replaced ->
    //    delete (recomputed on read); anything else -> preserve as one-off.
    for (const e of db.prepare("SELECT * FROM events WHERE source_adapter='schedule'").all()) {
      if (e.status === 'hidden') {
        const s = e.schedule_id ? db.prepare('SELECT * FROM schedules WHERE id=?').get(e.schedule_id) : null;
        const date = sydDate(e.start_utc);
        if (s && validOccurrence(s, date)) {
          insHidden.run(e.schedule_id, date);
          stats.hidden_overrides++;
          delEvent.run(e.id);
        } else {
          toOneOff.run(e.id);   // keeps status='hidden'
          stats.kept_oneoff++;
          stats.warnings.push(`hidden: event ${e.id} date ${date} not a valid occurrence -> kept as hidden one-off`);
        }
      } else if (e.mutation_type === 'scheduled' || e.mutation_type === 'replaced') {
        delEvent.run(e.id);
        stats.scheduled_deleted++;
      } else {
        toOneOff.run(e.id);
        stats.kept_oneoff++;
        stats.warnings.push(`leftover schedule row ${e.id} mutation_type=${e.mutation_type} -> kept as one-off`);
      }
    }
  });
  tx();

  console.log('[backfill-v26] done:');
  console.log(JSON.stringify(stats, null, 2));
  const remaining = db.prepare("SELECT COUNT(*) c FROM events WHERE source_adapter='schedule'").get().c;
  const overrides = db.prepare('SELECT kind, COUNT(*) c FROM schedule_overrides GROUP BY kind').all();
  console.log(`[backfill-v26] schedule-sourced events remaining: ${remaining} (expect 0)`);
  console.log('[backfill-v26] overrides by kind:', JSON.stringify(overrides));
}

run();
