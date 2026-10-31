// What a source's dated services ARE, against the parish's timetable.
//
// A parish calendar lists every Sunday's Liturgy as an entry of its own. The
// timetable already has "Sundays 10am Liturgy". Written as one-off events
// beside it, every Sunday became two cards (Good Shepherd, Clayton showed
// "Liturgy" and "Divine Liturgy" at 10am every week). So an entry that IS an
// occurrence of a rule lands ON that occurrence, the way a poster's dated
// services do (drafts.mjs matchOccurrences; CLAUDE.md, "a dated change to a
// regular service is an override, published ONTO its occurrence, never a
// one-off beside it"): nothing at all when it says what the rule says, else an
// override carrying what it changes — the time, the day's saint. Only what is
// not a regular service becomes an event.
//
// PURE. reconcile() pairs by name and time; this decides what each pair, each
// unclear case and each leftover entry turns into. The writing is the
// adapter's (adapters.mjs), and the model's part is pairing-read.mjs.
//
// THE MODEL'S PART, AND ITS LIMITS. Claude Haiku is asked two things, and only
// when the rules above cannot say:
//
//   subtitle  a paired entry's title has words beyond the service's name —
//             "Divine Liturgy – St Nicholas". Which of them is the day's
//             commemoration? ("Divine Liturgy of St John Chrysostom" names
//             none.) It goes under the title, as a poster's does.
//   which     a rule's occurrence that day found no entry by name, and the day
//             has entries nothing claimed. Is one of them this service, moved
//             or called after the feast?
//
// What an answer may do is bounded on purpose, because nobody reviews a cron
// run: it can pair (so a Sunday reads "Liturgy, St Nicholas, 9:30" instead of
// two cards) and it can hold back a cancellation it is unsure of. It can never
// cause one. Every cancellation here is one the rules alone would have made,
// and an unsure answer goes to whoever keeps the parish as a suggestion
// (suggestions.mjs) rather than being acted on. Without a key, or when the
// call fails, the rules' answer stands and nothing is lost but the subtitle.

import { localPartsOf } from '../../public/shared/tz.mjs';
import langList from '../../public/shared/languages.js';
import { sameService } from './reconcile.mjs';

export const dateOf = (inst) => String(inst.start_local || '').slice(0, 10);
export const timeOf = (inst) => String(inst.start_local || '').slice(11, 16);
export const occurrenceKey = (inst) => `${inst.schedule_id}:${dateOf(inst)}`;

const localOf = (timezone, iso) => (iso ? localPartsOf(timezone, Date.parse(iso)) : null);

// Words that name a service, how it is served, or the language it is in. Left
// over after these, a title has said something about the DAY.
const SERVICE_WORDS = new Set(`
  divine holy liturgy liturgies matins orthros vespers vesperal vigil all night
  great small little compline apodeipnon confession confessions paraklesis
  supplication supplicatory akathist hours royal typika presanctified gifts
  hierarchical pontifical festal sung said service services prayer prayers
  of the and with for in at a an followed by then
`.split(/\s+/).filter(Boolean));
const LANGUAGE_WORDS = new Set(langList.NAMES.flatMap(n => words(n)));

function words(s) {
  return String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * What a paired entry's title says beyond its service's name. Empty for
 * "Divine Liturgy" against "Liturgy" or "Matins (Orthros)" against "Matins";
 * ["st", "nicholas"] for "Divine Liturgy – St Nicholas". Only then is the model
 * asked what the commemoration is.
 */
export function leftoverWords(entryTitle, ruleTitle) {
  const rule = new Set(words(ruleTitle));
  return words(entryTitle).filter(w => !SERVICE_WORDS.has(w) && !LANGUAGE_WORDS.has(w) && !rule.has(w));
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
function longDate(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
const quote = (t) => `"${String(t || '').replace(/\s+/g, ' ').trim()}"`;

/**
 * The questions this run needs answered, as text. The text is the cache key
 * (pairing-read.mjs): the same question is never asked twice, and a changed
 * title or time is a new question.
 *
 * @param {object} args
 *   diff      reconcile()'s answer
 *   timezone  the parish's zone
 *   spoken    keys ("sid:date") of occurrences a PERSON has an override on —
 *             their word stands, so nothing is asked about them
 * @returns {Array<{kind, key, instance, entries, text}>}
 */
export function questionsFor({ diff, timezone, spoken = new Set() }) {
  const out = [];
  for (const m of [...(diff.matched || []), ...(diff.moved || [])]) {
    if (spoken.has(occurrenceKey(m.instance))) continue;
    if (!leftoverWords(m.event.title, m.instance.title).length) continue;
    out.push({
      kind: 'subtitle', key: occurrenceKey(m.instance), instance: m.instance, entries: [m.event],
      text: ['subtitle', `regular service: ${quote(m.instance.title)}`,
        `calendar entry: ${quote(m.event.title)}`].join('\n'),
    });
  }

  // The day's entries nothing claimed, in time order, for the "which" kind.
  const byDate = new Map();
  for (const e of diff.extra || []) {
    const l = localOf(timezone, e.start_utc);
    if (!l) continue;
    if (!byDate.has(l.date)) byDate.set(l.date, []);
    byDate.get(l.date).push({ e, time: l.time });
  }
  for (const list of byDate.values()) list.sort((a, b) => a.time.localeCompare(b.time) || a.e.title.localeCompare(b.e.title));

  const unclear = [...(diff.held || []).map(h => h.instance), ...(diff.unpaired || [])];
  for (const inst of unclear) {
    if (spoken.has(occurrenceKey(inst))) continue;
    const day = byDate.get(dateOf(inst));
    if (!day || !day.length) continue;
    out.push({
      kind: 'which', key: occurrenceKey(inst), instance: inst, entries: day.map(x => x.e),
      text: ['which', `date: ${longDate(dateOf(inst))}`,
        `regular service: ${quote(inst.title)} at ${timeOf(inst)}`,
        'unmatched calendar entries that day:',
        ...day.map((x, i) => `${i + 1}. ${quote(x.e.title)} at ${x.time}`)].join('\n'),
    });
  }
  return out;
}

// What the model wrote, made safe to store: one line, a sensible length.
const clean = (s) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t && t.length <= 120 ? t : '';
};

/**
 * Turn the pairing and the answers into what the run writes.
 *
 * @param {object} args
 *   diff       reconcile()'s answer
 *   questions  questionsFor()'s answer
 *   answers    Map(question text → {entry, sure, service, feast}); a question
 *              with no answer (no key, a failed call) is decided by the rules
 *   spoken     keys of occurrences a person has an override on
 * @returns {{pairs: Array, oneOffs: Array, missing: Array, withheld: Array, unsure: Array}}
 *   pairs     [{instance, event, feast, service}] each entry that IS that occurrence
 *   oneOffs   entries that are no regular service: written as events
 *   missing   what may become a cancellation (tombstone.mjs still decides)
 *   withheld  occurrences an unsure answer kept from being cancelled
 *   unsure    [{question, answer}] for whoever keeps the parish
 */
export function resolvePairing({ diff, questions = [], answers = new Map(), spoken = new Set() }) {
  const answerFor = (q) => answers.get(q.text) || null;
  const subtitleOf = new Map();
  const whichOf = new Map();
  for (const q of questions) (q.kind === 'subtitle' ? subtitleOf : whichOf).set(q.key, q);

  const pairs = [];
  const taken = new Set();
  for (const m of [...(diff.matched || []), ...(diff.moved || [])]) {
    const q = subtitleOf.get(occurrenceKey(m.instance));
    const a = q && answerFor(q);
    pairs.push({ instance: m.instance, event: m.event, feast: a ? clean(a.feast) : '', service: '' });
    taken.add(m.event);
  }

  const withheld = [], unsure = [], missing = [];
  const inWindow = new Set(diff.missing || []);

  // Something else at the rule's exact minute. The rules alone leave the
  // occurrence standing and the entry as its own event; a person who has
  // spoken for the occurrence has already said what that minute is.
  for (const h of diff.held || []) {
    const key = occurrenceKey(h.instance);
    if (spoken.has(key)) { pairs.push({ instance: h.instance, event: h.event, feast: '', service: '' }); taken.add(h.event); continue; }
    settle(h.instance, false);
  }
  for (const inst of diff.unpaired || []) {
    if (spoken.has(occurrenceKey(inst))) { if (inWindow.has(inst)) missing.push(inst); continue; }
    settle(inst, inWindow.has(inst));
  }

  function settle(inst, wouldBeMissing) {
    const q = whichOf.get(occurrenceKey(inst));
    const a = q && answerFor(q);
    if (a && a.sure && a.entry >= 1 && a.entry <= q.entries.length && !taken.has(q.entries[a.entry - 1])) {
      const event = q.entries[a.entry - 1];
      const service = clean(a.service);
      pairs.push({
        instance: inst, event, feast: clean(a.feast),
        // The entry's own name for the service, only when it is a DIFFERENT
        // service from the rule's — "Vesperal Liturgy" on a Saturday that has
        // "Vespers". The same service keeps the timetable's name.
        service: service && !sameService(service, inst.title) ? service : '',
      });
      taken.add(event);
      return;
    }
    if (a && !a.sure) {
      withheld.push(inst);
      unsure.push({ question: q, answer: a });
      return;
    }
    if (wouldBeMissing) missing.push(inst);
  }

  const oneOffs = (diff.extra || []).filter(e => !taken.has(e));
  return { pairs, oneOffs, missing, withheld, unsure };
}

/**
 * The override a pair needs, or null when the entry says what the rule says.
 *
 * Only what the entry CHANGES is written: its time, when that differs (and its
 * end with it); the day's commemoration as the subtitle; a different service's
 * name and kind. The rule's title, languages and place are left to the rule —
 * "Divine Liturgy" for "Liturgy" is not a change worth a row every Sunday.
 *
 * @param {object} pair      resolvePairing()'s pair
 * @param {string} timezone  the parish's zone
 * @param {Function} typeOf  title → event_type, for a renamed service
 */
export function overrideFor(pair, timezone, typeOf) {
  const { instance, event } = pair;
  const date = dateOf(instance);
  const start = localOf(timezone, event.start_utc);
  const end = localOf(timezone, event.end_utc);
  const patch = {};
  if (start && start.date === date && start.time !== timeOf(instance)) {
    patch.patch_start_time = start.time;
    // The entry's end goes with its start, when it ends that day; an end that
    // stays the rule's would put the service's end before its new start.
    patch.patch_end_time = end && end.date === date && end.time > start.time ? end.time : null;
  }
  if (pair.feast && pair.feast !== instance.title) patch.patch_feast = pair.feast;
  if (pair.service) {
    patch.patch_title = pair.service;
    if (typeOf) patch.patch_event_type = typeOf(pair.service);
  }
  if (!Object.keys(patch).length) return null;
  return {
    schedule_id: instance.schedule_id,
    occurrence_date: date,
    patch_title: patch.patch_title || null,
    patch_start_time: patch.patch_start_time || null,
    patch_end_time: patch.patch_end_time || null,
    patch_event_type: patch.patch_event_type || null,
    patch_feast: patch.patch_feast || null,
    note: `From the source: ${quote(event.title)}${start ? ` at ${start.time}` : ''}`,
  };
}

/**
 * The suggestion an unsure answer becomes, in the words whoever keeps the
 * parish will read: what the calendar has, what the timetable expected, and
 * what the page shows meanwhile.
 */
export function suggestionFor({ question, answer }, sourcePhrase = 'The source') {
  const inst = question.instance;
  const date = dateOf(inst);
  const picked = answer.entry >= 1 && answer.entry <= question.entries.length
    ? question.entries[answer.entry - 1] : null;
  const what = picked
    ? `${quote(picked.title)}, which might be the ${inst.title} moved or renamed for the day`
    : `${question.entries.map(e => quote(e.title)).join(', ')}, and no ${inst.title}`;
  return {
    about: `${longDate(date)}, ${inst.title} at ${timeOf(inst)}`,
    body: `${sourcePhrase} shows ${what}. Agora could not tell whether the ${inst.title} is on as usual, `
      + `so for now the page shows it at ${timeOf(inst)}, and the entries as events of their own. `
      + `If it has moved or is not on, change that day's ${inst.title}; ${sourcePhrase.toLowerCase()} will not undo it.`,
  };
}
