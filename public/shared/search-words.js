// What words mean to the site's search, and whether a rule or an event
// answers them.
//
// Two readers ask the same question. The search box (next/next.js) reads what
// is typed, and a link reads the words in it that nothing else claims:
// /smmp/disco is "disco" asked of St Mary's, as typing it would be (Kevin,
// 28 Oct 2026). One reading, so a link and the box cannot come to mean
// different things by a word — and the Worker, which answers the link's
// preview, reads it here too.
//
// A few words are read as intent rather than text, so "english liturgy
// sunday" or "vespers tonight" ask the timetable a question instead of
// looking for those words in titles. A word that names a thing — a festival,
// a dinner, a picnic — is text: "festival" is the events called that, not
// every social and youth night (Kevin, 28 Oct 2026).
//
// Same dual-mode wrapper as its neighbours: a classic script for the page, a
// CommonJS module for the Worker and the tests.
(function (root) {
  const isCjs = typeof module === 'object' && !!module.exports;
  const timetable = isCjs ? require('./timetable.js') : (root && root.AgoraTimetable);

  /** Lower case, no accents or apostrophes, "Saint"/"Sts" as "st", and anything else a space. */
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[’'`.]/g, '').replace(/\bsaints?\b|\bsts?\b/g, 'st')
    .replace(/[^a-z0-9Ͱ-ϿЀ-ӿ؀-ۿ]+/g, ' ').trim();
  /** Does a normalised text hold a word starting with `tok`? */
  const hasWord = (hay, tok) => (' ' + hay).includes(' ' + tok);

  const DAY_WORDS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
  const KIND_WORDS = {
    liturgy: 'liturgy', liturgies: 'liturgy', mass: 'liturgy', eucharist: 'liturgy',
    talk: 'talk', talks: 'talk', bible: 'talk', study: 'talk', catechism: 'talk', class: 'talk', classes: 'talk', lecture: 'talk',
    youth: 'youth', young: 'youth', kids: 'youth', children: 'youth',
    social: 'social', socials: 'social',
    feast: 'feast', feasts: 'feast',
  };
  // Prayer services are asked for by name; these stay as text, and also mean "a service".
  const PRAYER_WORDS = ['vespers', 'vigil', 'matins', 'orthros', 'paraklesis', 'akathist', 'akatist', 'compline', 'confession', 'supplication', 'prayer', 'prayers'];
  const LANG_WORDS = { english: 'English', greek: 'Greek', arabic: 'Arabic', serbian: 'Serbian', russian: 'Church Slavonic', slavonic: 'Church Slavonic', romanian: 'Romanian', macedonian: 'Macedonian', ukrainian: 'Ukrainian' };
  const FILLER = new Set(['the', 'a', 'an', 'in', 'at', 'on', 'of', 'for', 'this', 'next', 'service', 'services', 'church', 'parish', 'parishes', 'orthodox', 'and', 'with', 'times', 'time', 'whats', 'what', 'is', 'near', 'me', 'nearby', 'around', 'week']);

  const DAY_MS = 86400000;
  const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY_MS).toISOString().slice(0, 10);
  const weekdayOf = (date) => new Date(date + 'T00:00:00Z').getUTCDay();

  /**
   * What a query asks: { text, days, tonight, kind, prayer, lang, nearMe, raw }.
   * `today` is the 'YYYY-MM-DD' that "today", "tonight" and a weekday count
   * from; a weekday is its next two, as the box always had it.
   */
  function parseQuery(q, today) {
    const toks = norm(q).split(' ').filter(Boolean);
    const out = { text: [], days: null, tonight: false, kind: null, prayer: false, lang: null, nearMe: /\bnear me\b|\bnearby\b|\baround me\b/.test(norm(q)), raw: toks };
    const t = today;
    const addDay = (k) => { out.days = out.days || new Set(); out.days.add(k); };
    for (let i = 0; i < toks.length; i++) {
      const w = toks[i];
      if (w === 'today') { addDay(t); continue; }
      if (w === 'tonight') { addDay(t); out.tonight = true; continue; }
      if (w === 'tomorrow') { addDay(addDays(t, 1)); continue; }
      if (w === 'weekend') { for (let d = 0; d < 7; d++) { const k = addDays(t, d); const wd = weekdayOf(k); if (wd === 0 || wd === 6) addDay(k); } continue; }
      if (w in DAY_WORDS) { for (let d = 0; d < 14; d++) { const k = addDays(t, d); if (weekdayOf(k) === DAY_WORDS[w]) addDay(k); } continue; }
      if (w in KIND_WORDS) { out.kind = KIND_WORDS[w]; if (w !== 'bible' && w !== 'study') continue; }
      if (w in LANG_WORDS) { out.lang = LANG_WORDS[w]; }
      if (PRAYER_WORDS.includes(w)) out.prayer = true;
      if (FILLER.has(w)) continue;
      out.text.push(w);
    }
    // A language word is both: "greek" is a language for services and a
    // jurisdiction (and a word in names) for parishes. Keep it as text too.
    return out;
  }

  /** The words of a query that are looked for in titles: not its language's, which is intent. */
  const textWords = (Q) => Q.text.filter(w => !(w in LANG_WORDS));
  /** Does a query ask anything at all? "the", alone, does not. */
  const asks = (Q) => !!Q && !!(Q.text.length || Q.days || Q.kind || Q.lang || Q.prayer);

  /**
   * Does a rule or an event answer a query: its day, its kind, its language,
   * and every word in its title, its subtitle (the saint or the feast) or its
   * description?
   *
   * An event says when it is on its parish's clock: `date` ('YYYY-MM-DD') and
   * `hm` ('HH:MM'). A rule has no date, so it answers a day by its weekday.
   * `parishLang(lang)` says whether the row's parish holds a service in a
   * language, which is how a talk or a social answers one (timetable.js).
   */
  function answers(row, Q, { date = null, hm = null, parishLang = null } = {}) {
    if (!row || !Q) return false;
    const isRule = !date && row.day_of_week != null;
    if (Q.days) {
      if (isRule ? ![...Q.days].some(k => weekdayOf(k) === row.day_of_week) : !Q.days.has(date)) return false;
    }
    if (Q.tonight && String((isRule ? row.start_time : hm) || '') < '16:00') return false;
    if (Q.kind && row.event_type !== Q.kind && !(Q.kind === 'social' && row.event_type === 'youth')) return false;
    if (Q.lang && timetable && !timetable.rowAnswersLang(row, { lang: Q.lang }, !!(parishLang && parishLang(Q.lang)))) return false;
    const words = textWords(Q);
    if (!words.length) return !Q.prayer || row.event_type === 'prayer';
    const hay = norm(`${row.title || ''} ${row.feast || ''} ${row.description || ''}`);
    return words.every(w => hasWord(hay, w));
  }

  /** "disco-night" and "disco/night" as one phrase: what a link's words say. */
  const phraseOf = (words) => [].concat(words || []).join(' ').replace(/[-+]+/g, ' ').replace(/\s+/g, ' ').trim();

  /**
   * What a link's words find across the site when they name no parish
   * (/village, /vigil, /antiochian/festival), as one verdict the page and the
   * Worker's preview both reach:
   *
   *   { verdict: 'none' }                  nothing: the search, with the words in it
   *   { verdict: 'parish', pid }           one parish by its name, and nothing found elsewhere
   *   { verdict: 'match', pid, words? }    all that was found is at one parish: /smmp/disco;
   *                                        `words` when only some are asked of it (/smg-feast: "feast")
   *   { verdict: 'list', ids, named, found } several places: a collection of them
   *
   * A parish is found as the search box finds one: every word in its names,
   * initials or address (`hayOf` adds what else it answers to). A rule or a
   * one-off is found by `answers`, and is at its own parish. `parishes` and
   * `rows` are what the link's other words leave in (its jurisdiction, its
   * region), Parish only rows already out; a one-off carries its `_at`
   * ({ date, hm } on its parish's clock), a rule none. `parishLang(pid, lang)`
   * says whether a parish holds a service in a language.
   *
   * One parish by name with something elsewhere is a list, not the parish
   * (Kevin, 28 Oct 2026: /village is the monastery and the bus beside it).
   *
   * Words that name a parish ask the rest of themselves of it, as the box
   * does when "smg feast" lists Ryde's feasts under Ryde: /smg-feast is
   * /smg/feast (Kevin, 1 Nov 2026). The rest is a kind, a day or a
   * language; a word that is only text is the parish's name or nothing.
   */
  function findAcross({ parishes = [], rows = [], Q, hayOf = () => '', parishLang = () => false }) {
    if (!asks(Q)) return { verdict: 'none' };
    const words = textWords(Q);
    const named = !words.length ? [] : parishes.filter(p => {
      const hay = norm(`${p.name || ''} ${p.full_name || ''} ${p.acronym || ''} ${p.address || ''} ${hayOf(p) || ''}`);
      return words.every(w => hasWord(hay, w)) && (!Q.lang || parishLang(p.id, Q.lang));
    }).map(p => p.id);
    const rest = named.length && (Q.kind || Q.days || Q.lang) ? { ...Q, text: [] } : null;
    const at = (r) => ({ ...(r._at || {}), parishLang: (lang) => parishLang(r.parish_id, lang) });
    const asked = rows.filter(r => rest && named.includes(r.parish_id) && answers(r, rest, at(r)));
    const found = rows.filter(r => asked.includes(r) || answers(r, Q, at(r)));
    const hosts = [...new Set(found.map(r => r.parish_id))];
    if (!named.length && !found.length) return { verdict: 'none' };
    if (named.length === 1 && hosts.every(id => id === named[0])) {
      // The words not in its name are what is asked of it: "feast", "english".
      if (asked.length) return { verdict: 'match', pid: named[0], words: Q.raw.filter(w => !words.includes(w)) };
      return { verdict: 'parish', pid: named[0] };
    }
    if (!named.length && hosts.length === 1) return { verdict: 'match', pid: hosts[0] };
    return { verdict: 'list', ids: [...new Set([...named, ...hosts])], named, found };
  }

  const api = { norm, hasWord, DAY_WORDS, KIND_WORDS, PRAYER_WORDS, LANG_WORDS, FILLER, parseQuery, textWords, asks, answers, phraseOf, findAcross };
  if (isCjs) module.exports = api;
  else if (root) root.AgoraSearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
