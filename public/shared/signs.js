// What a church sign says, set beside what is on file.
//
// A photo of the board out the front — "Saturdays 8.00–10.00 am, Sundays
// 8.00–11.00 am, Orthros & Divine Liturgy" — is read (worker/lib/poster-read.mjs,
// kind 'timetable') into weekly services and the parish's details. Those are
// PROPOSALS: a sign read by a model is checked by a person before anything is
// written, and each one is added on its own, by the routes a person adding it
// by hand would use. This file answers the one question the review asks of
// each — is it on file already, and if so, does the sign add anything — so the
// editor can show it and the tests can pin it.
//
// The source of whatever is added is the sign itself: "Church signage",
// linking to the photo (the same object as the draft's poster, which stays in
// R2 while a rule or a parish names it — poster-range.mjs releaseUnused).
//
// Same dual-mode wrapper as its neighbours: window.AgoraSigns for the editor,
// module.exports for the Worker and the tests.
(function (root) {
  const isCjs = typeof module === 'object' && !!module.exports;
  const types = isCjs ? require('./event-types.js') : (root && root.AgoraEventTypes);

  /** The source line a rule or a parish read off a sign shows. */
  const SIGN_SOURCE = 'Church signage';

  const WEEKS = ['first', 'second', 'third', 'fourth', 'last'];
  const isTime = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

  /** 'second,fourth' in a fixed order, or null for every week. */
  function weeksKey(v) {
    const list = String(v || '').split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
    const set = WEEKS.filter(w => list.includes(w));
    return set.length && set.length < WEEKS.length ? set.join(',') : null;
  }

  function langsOf(v) {
    if (Array.isArray(v)) return v.length ? v : null;
    if (!v) return null;
    try { const a = JSON.parse(v); return Array.isArray(a) && a.length ? a : null; } catch { return null; }
  }

  /**
   * A list of services as the editor sends it back, checked field by field.
   * The same shape normalizeRead gives: {title, day_of_week, start_time,
   * end_time, week_of_month, languages, event_type, read_notes}.
   *
   * @returns {{ok: true, services: Array} | {ok: false, error: string, index: number}}
   */
  function validateServices(list) {
    if (!Array.isArray(list)) return { ok: false, error: 'services must be a list.', index: -1 };
    if (list.length > 30) return { ok: false, error: 'That is more services than a sign holds.', index: -1 };
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i] && typeof list[i] === 'object' ? list[i] : {};
      const bad = (error) => ({ ok: false, error, index: i });
      const day = Number(s.day_of_week);
      if (!Number.isInteger(day) || day < 0 || day > 6) return bad('Which day is it on?');
      if (!isTime(s.start_time)) return bad('Write the time like 08:00.');
      if (s.end_time != null && s.end_time !== '' && !isTime(s.end_time)) return bad('Write the end time like 10:00.');
      if (s.title != null && typeof s.title !== 'string') return bad('The title must be text.');
      if (s.event_type && types && !types.isEventType(s.event_type)) return bad('That is not one of the kinds of service.');
      const langs = Array.isArray(s.languages)
        ? [...new Set(s.languages.map(l => String(l).trim().slice(0, 40)).filter(Boolean))].slice(0, 6) : [];
      const notes = (Array.isArray(s.read_notes) ? s.read_notes : [])
        .filter(n => n && typeof n.text === 'string')
        .map(n => ({ field: String(n.field || '').slice(0, 30), text: n.text.slice(0, 300) })).slice(0, 6);
      out.push({
        title: s.title ? String(s.title).trim().slice(0, 200) || null : null,
        day_of_week: day,
        start_time: s.start_time,
        end_time: s.end_time || null,
        week_of_month: weeksKey(s.week_of_month),
        languages: langs.length ? langs : null,
        event_type: s.event_type || 'liturgy',
        read_notes: notes,
      });
    }
    return { ok: true, services: out };
  }

  /** Is this rule running, as far as a sign is concerned: active and not ended? */
  const current = (r, today) => r && r.active !== 0 && (!r.effective_to || !today || r.effective_to >= today);

  /** The same slot: day, time and weeks. The title may be worded differently on file. */
  const sameSlot = (s, r) => r.day_of_week === s.day_of_week && r.start_time === s.start_time
    && weeksKey(r.week_of_month) === weeksKey(s.week_of_month);

  /**
   * Each service on the sign beside the timetable, and the rules the sign
   * does not mention.
   *
   *   status 'new'      not on file: offer to add it
   *   status 'on_file'  the same slot is on file (`rule`); `fills` is what the
   *                     sign says that the rule leaves empty — an end time,
   *                     its languages — and nothing it already says otherwise
   *   status 'weeks'    the same day and time is on file (`rule`) for other
   *                     weeks of the month — every Sunday where the sign says
   *                     the 2nd and 4th. Adding it would put a second rule on
   *                     top of the first; offer to correct the weeks instead
   *
   * `missing` is what the timetable has that the sign does not. Nothing is
   * offered for those: a sign out the front lists Sundays and leaves out the
   * weekday Vespers more often than the Vespers have stopped.
   *
   * @param {Array} services  the read's (or the editor's edited) services
   * @param {Array} rules     the parish's rules, as GET /api/admin/schedules gives them
   * @param {string} [today]  the parish's 'YYYY-MM-DD', to leave out ended rules
   */
  function compareSign(services, rules, today = null) {
    const live = (rules || []).filter(r => current(r, today));
    const matched = new Set();
    // Exact slots first, so a rule that is exactly on the sign is never taken
    // as the "other weeks" of a different line on it.
    const exact = (services || []).map(s => {
      const rule = live.find(r => !matched.has(r.id) && sameSlot(s, r)) || null;
      if (rule) matched.add(rule.id);
      return rule;
    });
    const rows = (services || []).map((s, i) => {
      const rule = exact[i];
      if (!rule) {
        const other = live.find(r => !matched.has(r.id)
          && r.day_of_week === s.day_of_week && r.start_time === s.start_time);
        if (!other) return { service: s, status: 'new', rule: null, fills: {} };
        matched.add(other.id);
        return { service: s, status: 'weeks', rule: other, fills: { week_of_month: weeksKey(s.week_of_month) } };
      }
      const fills = {};
      if (s.end_time && !rule.end_time) fills.end_time = s.end_time;
      const langs = langsOf(s.languages);
      if (langs && !langsOf(rule.languages)) fills.languages = langs;
      return { service: s, status: 'on_file', rule, fills };
    });
    const missing = live.filter(r => !matched.has(r.id))
      .sort((a, b) => a.day_of_week - b.day_of_week || String(a.start_time).localeCompare(String(b.start_time)));
    return { rows, missing };
  }

  // Two ways of printing one number, address or site are the same thing.
  const NORMAL = {
    phone: (v) => {
      let d = String(v || '').replace(/[^\d+]/g, '');
      if (d.startsWith('+61')) d = '0' + d.slice(3);
      return d;
    },
    email: (v) => String(v || '').trim().toLowerCase(),
    website: (v) => String(v || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, ''),
    address: (v) => String(v || '').toLowerCase()
      .replace(/\b(nsw|vic|qld|sa|wa|tas|act|nt|australia)\b/g, ' ')
      .replace(/\bcnr\b|\bcorner\b/g, 'corner').replace(/\bst\b/g, 'street').replace(/\bave?\b/g, 'avenue')
      .replace(/\brd\b/g, 'road').replace(/[^a-z0-9]+/g, ' ').trim(),
  };

  /**
   * Each detail the sign prints beside what the parish has on file:
   *   'same'    nothing to do
   *   'empty'   nothing on file — the sign can fill it
   *   'differs' both say something; a person chooses
   *
   * @param {{address, phone, email, website}|null} details
   * @param {object} parish  the parish row (or the app's copy of it)
   */
  function compareDetails(details, parish) {
    if (!details) return [];
    const p = parish || {};
    return ['address', 'phone', 'email', 'website']
      .filter(f => details[f])
      .map(f => {
        const onFile = p[f] || null;
        const status = !onFile ? 'empty' : NORMAL[f](onFile) === NORMAL[f](details[f]) ? 'same' : 'differs';
        return { field: f, sign: details[f], onFile, status };
      });
  }

  const ORDINAL = { first: '1st', second: '2nd', third: '3rd', fourth: '4th', last: 'last' };

  /** 'second,fourth' -> '2nd & 4th'; null -> ''. */
  function weeksLabel(v) {
    const k = weeksKey(v);
    if (!k) return '';
    const parts = k.split(',').map(w => ORDINAL[w]);
    return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} & ${parts[parts.length - 1]}` : parts[0];
  }

  const api = { SIGN_SOURCE, WEEKS, weeksKey, weeksLabel, validateServices, compareSign, compareDetails };
  if (isCjs) module.exports = api;
  else if (root) root.AgoraSigns = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
