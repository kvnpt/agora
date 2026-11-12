// What an event or a rule may BE, in the order every picker offers it.
//
// Written down once. It was the same literal three times in app.js, then once
// in app.js and again in /admin's service form — and now a third reader needs
// it: the poster reader in the Worker, which has to tell Claude what the seven
// kinds mean and constrain its answer to them. A model choosing from a list the
// pickers do not offer could only ever produce an event nobody can re-select.
//
// `hint` is what the poster reader is told each kind means. Kept beside the id
// so a kind cannot be added without saying what it is for.
//
// Classic script, the same dual shape as its neighbours: a browser global for
// app.js and /admin, module.exports for the Worker and the tests.
(function (root) {
  const KINDS = [
    { id: 'liturgy', label: 'Liturgy', hint: 'the Divine Liturgy, or another Eucharistic service' },
    { id: 'prayer',  label: 'Prayer',  hint: 'Vespers, Matins, Paraklesis, an Akathist, Compline, a memorial or another service of prayer' },
    { id: 'feast',   label: 'Feast',   hint: 'a feast day or patronal festival — its services and its celebration' },
    { id: 'talk',    label: 'Talk',    hint: 'a talk, lecture, class, catechism or Bible study' },
    { id: 'youth',   label: 'Youth',   hint: 'a gathering for children, teenagers or young adults' },
    { id: 'social',  label: 'Social',  hint: 'a meal, fundraiser, festival, picnic, concert or other gathering' },
    { id: 'other',   label: 'Other',   hint: 'anything else' },
  ];

  const EVENT_TYPES = KINDS.map(k => k.id);

  // Each kind's colours — the type dot on a card, the badge in a drawer, the
  // kind picker's chips — as [background, text], in light and in dark. One
  // table, so a kind looks the same wherever it is named (/admin's .k-<kind>
  // badges carry the same pairs, for the markup that has no JS).
  //
  // Feast gold, Talk terracotta, Youth teal, Social deep green (Kevin, 13 Nov
  // 2026). Until then Feast and Talk were one gold, Youth was Prayer's blue,
  // and Social was Romanian's green. Each event type's text colour is now at
  // least 7.5 from every other's and about 10 from every jurisdiction's
  // (jurisdiction-colors.js), so a row's word and its line do not read as one.
  const COLORS = {
    light: {
      liturgy: ['#e8d5e8', '#6b2d6b'], prayer: ['#d5e0f0', '#2d4a7a'], feast: ['#f1e7ce', '#896a00'],
      talk: ['#fee1d6', '#8d3c18'], youth: ['#d2eef1', '#006169'], social: ['#dbeedb', '#15561d'],
      other: ['#e8e8e8', '#555555'],
    },
    dark: {
      liturgy: ['#3a2840', '#d4a3d4'], prayer: ['#1f2a3a', '#9bb8e0'], feast: ['#362d13', '#d9bb68'],
      talk: ['#40271d', '#f9a686'], youth: ['#163336', '#71cfd9'], social: ['#213322', '#95cf96'],
      other: ['#26272c', '#aaaaaa'],
    },
  };

  /** A kind's colours: { bg, fg }. Unknown kinds wear "other"'s. */
  function kindColors(id, dark = false) {
    const table = dark ? COLORS.dark : COLORS.light;
    const [bg, fg] = table[id] || table.other;
    return { bg, fg };
  }

  // The kinds a row of the Calendar, Today or search says in a word under its
  // time. A liturgy's or a prayer's name already says what it is ("Divine
  // Liturgy", "Vespers"), and "Other" says nothing; a feast's "Great Vespers"
  // or a social's "Paniyiri" does not. Said in words, not a colour: a row's
  // colour is its jurisdiction's, and a word is read where a colour beside
  // another is only compared.
  const ROW_WORD_KINDS = ['feast', 'talk', 'youth', 'social'];
  /** 'feast' -> 'Feast'; '' for a kind its row does not say. */
  const rowWord = (id) => (ROW_WORD_KINDS.includes(id) ? eventTypeLabel(id) : '');

  /** Is this one of the seven? */
  const isEventType = (v) => EVENT_TYPES.includes(v);

  /** 'youth' -> 'Youth'; anything unknown comes back as it was. */
  function eventTypeLabel(id) {
    const k = KINDS.find(x => x.id === id);
    return k ? k.label : String(id || '');
  }

  const api = { KINDS, EVENT_TYPES, isEventType, eventTypeLabel, kindColors, rowWord };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.AgoraEventTypes = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
