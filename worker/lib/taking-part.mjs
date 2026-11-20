// Who takes part in what: the parishes a combine adds to an event, and since
// migration 041 to one DATE of a service.
//
// An event's are `event_parishes`, keyed by its integer id. A date of a
// service is projected and never stored, so its are `occurrence_parishes`,
// keyed by the rule and the date, as an override is. Every reader wants both
// as one list of `{ event_id, parish_id }`, with a date's under the id the
// projection gives that date ("sid:YYYY-MM-DD", public/shared/project.mjs), so
// that buildFeed (public/shared/merge.mjs attachExtraParishes) joins the two
// alike and nothing downstream asks which kind of host it has.

import { expandOne, parseInstanceId } from './expand.mjs';

/** Both, as one list of rows. The date's id is the projection's own. */
export const CROSS_SQL = `SELECT event_id, parish_id FROM event_parishes
  UNION ALL
  SELECT schedule_id || ':' || occurrence_date AS event_id, parish_id FROM occurrence_parishes`;

/**
 * Every row, events' and dates', or one parish's alone (`parishId`). Falls
 * back to the events' while migration 041 has not run, so a page is still
 * served before it.
 */
export async function crossRows(db, { parishId = null } = {}) {
  const both = parishId
    ? db.prepare(`SELECT event_id, parish_id FROM event_parishes WHERE parish_id = ?
       UNION ALL
       SELECT schedule_id || ':' || occurrence_date AS event_id, parish_id FROM occurrence_parishes WHERE parish_id = ?`)
      .bind(parishId, parishId)
    : db.prepare(CROSS_SQL);
  const events = () => (parishId
    ? db.prepare('SELECT event_id, parish_id FROM event_parishes WHERE parish_id = ?').bind(parishId)
    : db.prepare('SELECT event_id, parish_id FROM event_parishes')).all();
  const r = await both.all().catch(events).catch(() => ({ results: [] }));
  return r.results || [];
}

/** One host's parishes taking part, whichever kind of host it is. */
export async function takingPartIn(db, id) {
  const inst = parseInstanceId(String(id));
  const r = inst
    ? await db.prepare('SELECT parish_id FROM occurrence_parishes WHERE schedule_id = ? AND occurrence_date = ?')
      .bind(inst.scheduleId, inst.date).all().catch(() => ({ results: [] }))
    : await db.prepare('SELECT parish_id FROM event_parishes WHERE event_id = ?')
      .bind(id).all().catch(() => ({ results: [] }));
  return (r.results || []).map(x => x.parish_id);
}

/**
 * The dates of OTHER parishes' services that these parishes take part in,
 * between two local dates, each projected on its own with who takes part.
 *
 * For what is read one parish at a time (a parish's painted card, its .ics):
 * those read the parish's own rules, and another parish's Liturgy it is part
 * of on the 25th is not one of them. Projected one by one rather than by
 * reading the host's rules into the window, which would put the host's whole
 * timetable on this parish's card. Few rows: a handful a year.
 */
export async function hostedDates(db, parishIds, fromDate, toDate) {
  const ids = [...new Set((parishIds || []).filter(Boolean))];
  if (!ids.length) return [];
  const marks = ids.map(() => '?').join(',');
  const r = await db.prepare(
    `SELECT DISTINCT op.schedule_id, op.occurrence_date FROM occurrence_parishes op
     JOIN schedules s ON s.id = op.schedule_id
     WHERE op.parish_id IN (${marks}) AND s.parish_id NOT IN (${marks})
       AND op.occurrence_date BETWEEN ? AND ?
     ORDER BY op.occurrence_date LIMIT 50`
  ).bind(...ids, ...ids, fromDate, toDate).all().catch(() => ({ results: [] }));
  const out = [];
  for (const row of r.results || []) {
    const inst = await expandOne(db, row.schedule_id, row.occurrence_date);
    if (!inst) continue;
    out.push({ ...inst, combined_parishes: await takingPartIn(db, inst.id) });
  }
  return out;
}
