// Week-of-month qualifiers for recurring schedules.
//
// Salvaged from schedule-generator.js, whose generate-and-write half died with
// v26 (occurrences are computed on read by schedule-expand.js). These two
// functions were the only part still reachable.
//
// A schedule's week_of_month is either NULL (every matching weekday) or a
// comma-separated list like 'first,third'.

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

function matchesWeekOfMonth(dateStr, qualifier) {
  if (!qualifier) return true;
  return qualifier.split(',').some(q => matchesOneWeek(dateStr, q.trim()));
}

module.exports = { matchesWeekOfMonth };
