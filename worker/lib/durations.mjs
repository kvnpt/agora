// How long a service or event usually runs, for when nothing says when it ends.
//
// Kevin (4 Nov 2026), after St John the Baptist, Croydon Park's Christmas Fair
// poster ("Sunday 13th Dec, Liturgy 10AM", then a day of food and fun): "A
// liturgy is usually 90 minutes. Matins is 1 hour, Vespers 90 minutes. Bible
// study is 90 minutes", and a fair, like a festival, four hours. A poster
// rarely prints an end, so without these a card read off one has none, the
// fair could not start "when the Liturgy ends", and a 10am Liturgy could not
// be seen to fall inside the 9am Matins & Divine Liturgy (drafts.mjs).
//
// By the name, which is what a poster gives: a title that names several
// services is them one after another ("Matins & Divine Liturgy" is 1 hour
// then 1½, so 2½ hours). Nothing else is guessed: a Paraklesis, a talk or a
// youth night keeps no end until somebody gives it one.

/** The services a name can join, in the order they are held, and how long each runs. */
const SERVICES = [
  { word: 'matins', also: ['orthros'], minutes: 60, name: 'Matins' },
  { word: 'vespers', also: [], minutes: 90, name: 'Vespers' },
  { word: 'liturgy', also: ['liturgies'], minutes: 90, name: 'Liturgy' },
];
const BIBLE_STUDY = 90;
/** A fair or a festival: the whole day's food and stalls. */
const FAIR_WORDS = new Set(['fair', 'fete', 'festival', 'bazaar', 'market', 'paniyiri', 'panigiri', 'panigyri']);
const FAIR = 240;

const wordsOf = (t) => String(t || '').toLowerCase().replace(/[^a-z]+/g, ' ').trim().split(' ').filter(Boolean);

/** The services a name says, by their own word: "Orthros & Divine Liturgy" is ['matins', 'liturgy']. */
export function servicesNamed(title) {
  const w = new Set(wordsOf(title));
  return SERVICES.filter(s => w.has(s.word) || s.also.some(a => w.has(a))).map(s => s.word);
}

/**
 * How long something usually runs, by its name: { minutes, what } — `what`
 * says which, for a note ("Matins and Liturgy") — or null when its name gives
 * nothing to go by. A Liturgy by its kind alone ("Holy Eucharist") is a
 * Liturgy's length.
 *
 * @param {{title?: string, event_type?: string}} x
 */
export function usualLength(x) {
  const title = (x && x.title) || '';
  const named = SERVICES.filter(s => servicesNamed(title).includes(s.word));
  if (named.length) {
    return { minutes: named.reduce((n, s) => n + s.minutes, 0), what: named.map(s => s.name).join(' and ') };
  }
  const w = wordsOf(title);
  if (w.includes('bible') && w.some(v => v.startsWith('stud'))) return { minutes: BIBLE_STUDY, what: 'Bible study' };
  if (w.some(v => FAIR_WORDS.has(v))) return { minutes: FAIR, what: 'a fair or festival' };
  if (x && x.event_type === 'liturgy') return { minutes: 90, what: 'Liturgy' };
  return null;
}

/** "1 hour", "1½ hours", "4 hours", "45 minutes": a length for a note. */
export function lengthText(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} minutes`;
  if (!m) return `${h} hour${h === 1 ? '' : 's'}`;
  if (m === 30) return `${h}½ hours`;
  return `${h} hour${h === 1 ? '' : 's'} ${m} minutes`;
}

/** "HH:MM" -> minutes since midnight; null when it is not a time. */
export function toMinutes(t) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(t || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minutes since midnight -> "HH:MM"; null at or past midnight, which a same-day end cannot be. */
export function fromMinutes(n) {
  if (n == null || n < 0 || n >= 24 * 60) return null;
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}

/**
 * When something on a day ends: its own end time, else its start and its usual
 * length — { end: "HH:MM", usual: {minutes, what} | null } — or null when
 * neither says (or it would run past midnight).
 *
 * @param {{start_time, end_time?, title?, event_type?}} x
 */
export function endOf(x) {
  const s = toMinutes(x && x.start_time);
  if (s == null) return null;
  const own = toMinutes(x.end_time);
  if (own != null && own > s) return { end: x.end_time, usual: null };
  const usual = usualLength(x);
  const end = usual ? fromMinutes(s + usual.minutes) : null;
  return end ? { end, usual } : null;
}
