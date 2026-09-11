// Policy: which of reconcile's findings are allowed to change the database.
//
// PURE. Takes the diff and the current overrides, returns what to write. The
// caller does the writing, so every guard sits in one readable place instead of
// being distributed through a transaction.
//
// A tombstone still renders — "CANCELLED" on the card, not a disappearance —
// which is the point: someone who would otherwise turn up at church is told.
// The mirror harm is the one these guards exist for. A tombstone written by
// mistake keeps someone AWAY from a service that is running, and unlike a stale
// card nothing about the site tells them it is wrong.
//
// So absence is only ever evidence under all of these at once:
//
//   the run succeeded            — a failed scrape knows nothing
//   the source returned events   — an empty-but-successful scrape cannot tell
//                                  "everything is cancelled" from "they stopped
//                                  publishing", and silently blanking a parish
//                                  is not a risk worth taking for either
//   inside the queried window    — enforced upstream in reconcile()
//   below the breaker            — a run proposing to cancel most of a parish
//                                  has found a broken source, not a closure
//   not already spoken for       — a human's override always wins
//
// Withdrawal is the other half and matters as much: a service that reappears
// must lose its tombstone, or one bad scrape marks a Sunday cancelled forever.

/** Marker written into schedule_overrides.source so these are distinguishable
 *  from a person's, and therefore withdrawable without clobbering theirs. */
export const adapterSource = (adapterId) => `adapter:${adapterId}`;

const dateOf = (instance) => String(instance.start_local || '').slice(0, 10);

/**
 * @param {object} args
 *   diff             reconcile() output
 *   projectedCount   occurrences the rules produced in the window (denominator)
 *   scrapedCount     occurrences the source returned
 *   existing         [{schedule_id, occurrence_date, kind, source}] already on file
 *   adapterId        who is asking
 *   maxCancelFraction  refuse a run that would cancel more than this share
 * @returns {{create: Array, withdraw: Array, skipped: Array, refused: null|object}}
 */
export function decideTombstones({
  diff,
  projectedCount,
  scrapedCount,
  existing = [],
  adapterId,
  maxCancelFraction = 0.5,
}) {
  const source = adapterSource(adapterId);
  const none = { create: [], withdraw: [], skipped: [], refused: null };

  if (!scrapedCount) {
    return { ...none, refused: {
      reason: 'empty-scrape',
      detail: 'The source returned no events. Absence cannot be distinguished ' +
              'from the source going quiet, so nothing was cancelled.',
    } };
  }
  if (!projectedCount) return none;

  const missing = diff.missing || [];
  const fraction = missing.length / projectedCount;
  if (fraction > maxCancelFraction) {
    return { ...none, refused: {
      reason: 'too-many',
      detail: `${missing.length} of ${projectedCount} occurrences were absent ` +
              `(${Math.round(fraction * 100)}%). A run proposing to cancel that ` +
              'much has more likely found a broken source than a closed parish.',
      missing: missing.length,
      projected: projectedCount,
    } };
  }

  const key = (sid, date) => `${sid}:${date}`;
  const onFile = new Map(existing.map(r => [key(r.schedule_id, r.occurrence_date), r]));

  const create = [], skipped = [];
  for (const inst of missing) {
    const date = dateOf(inst);
    const row = onFile.get(key(inst.schedule_id, date));
    if (row) {
      // Someone has already said something about this occurrence. Whatever it
      // is — cancelled, moved, combined — it was said deliberately, and
      // UNIQUE(schedule_id, occurrence_date) means writing ours would replace
      // it rather than sit alongside.
      skipped.push({ schedule_id: inst.schedule_id, occurrence_date: date,
                     because: row.source === source ? 'already-tombstoned' : 'override-on-file' });
      continue;
    }
    create.push({
      schedule_id: inst.schedule_id,
      occurrence_date: date,
      note: `Absent from ${adapterId} on ${new Date().toISOString().slice(0, 10)}`,
    });
  }

  // Anything of ours covering an occurrence the source is publishing again.
  // Only ours, and only tombstones — a person's decision is not ours to undo.
  const backAgain = new Set([
    ...(diff.matched || []).map(m => key(m.instance.schedule_id, dateOf(m.instance))),
    ...(diff.moved || []).map(m => key(m.instance.schedule_id, dateOf(m.instance))),
  ]);
  const withdraw = existing
    .filter(r => r.source === source && r.kind === 'cancelled' &&
                 backAgain.has(key(r.schedule_id, r.occurrence_date)))
    .map(r => ({ schedule_id: r.schedule_id, occurrence_date: r.occurrence_date }));

  return { create, withdraw, skipped, refused: null };
}
