// Good Shepherd, Clayton — as published, Sep–Nov 2026. Times are Melbourne
// wall clock; start_utc is what an adapter would store.
// Melbourne went AEST(+10) -> AEDT(+11) on 4 October 2026. The fixture spans
// it deliberately: a 5pm service is 5pm on both sides, and must group as one rule.
function at(date, hhmm, title, where, type = 'liturgy') {
  const [h, m] = hhmm.split(':').map(Number);
  const off = date >= '2026-10-04' ? 11 : 10;
  const utc = new Date(Date.UTC(
    +date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), h - off, m
  )).toISOString();
  return { title, start_utc: utc, event_type: type, location_override: where };
}

const RC = 'Religious Centre, 38 Exhibition Walk, Clayton VIC 3168, Australia';
const CH = 'Monash Orthodox Chaplaincy, 38 Exhibition Walk, Clayton VIC 3168, Australia';

const SATS = ['2026-09-12','2026-09-19','2026-09-26','2026-10-03','2026-10-10',
              '2026-10-17','2026-10-24','2026-10-31','2026-11-07'];
const SUNS = ['2026-09-13','2026-09-20','2026-09-27','2026-10-04','2026-10-11',
              '2026-10-18','2026-10-25','2026-11-01'];

export const GOOD_SHEPHERD = [
  ...SATS.flatMap(d => [at(d, '17:00', 'Vespers', RC), at(d, '18:00', 'Confession', RC, 'other')]),
  ...SUNS.flatMap(d => [at(d, '09:00', 'Matins (Orthros)', CH), at(d, '10:00', 'Divine Liturgy', CH)]),
  // Alternate Sundays.
  ...['2026-09-13','2026-09-27','2026-10-11','2026-10-25']
      .map(d => at(d, '12:30', 'FOUNDATIONS Course', RC, 'education')),
  // First Sunday of the month.
  ...['2026-10-04','2026-11-01'].map(d => at(d, '12:00', 'Bookshop', RC, 'social')),
  // Genuinely one-off.
  at('2026-10-25', '13:00', 'Marriage blessing', null, 'other'),
];

export const WINDOW = { windowFrom: '2026-09-12', windowTo: '2026-11-07' };
