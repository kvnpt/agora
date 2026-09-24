// Bundle loader — the client half of the date lens.
//
// The API used to return expanded event instances. It now returns the RULES,
// and this projects them here. The modules under /shared/ are the same files
// the Worker imports, so the projection and the dedup cannot drift between
// server and browser.
//
// app.js is a classic script and stays one — dynamic import() works fine from
// classic scripts, so nothing has to become a module and the inline onclick
// handlers keep working.

window.agoraBundle = (function () {
  let mods = null;        // resolved /shared/ modules
  let raw = null;         // last bundle payload
  let loadedAt = 0;
  let inflight = null;
  // What the payload in hand actually covers, and what the request in flight
  // will cover. Windows only ever WIDEN: the parish sheet asks for a month and
  // the main feed asks for whatever Load more has grown it to, and the narrower
  // caller landing second must not shrink the window out from under the first.
  let held = { from: null, to: null };
  let wanted = { from: null, to: null };

  const ms = (iso) => (iso ? Date.parse(iso) : NaN);
  const earlier = (a, b) => (!a ? b : !b ? a : (ms(a) <= ms(b) ? a : b));
  const later = (a, b) => (!a ? b : !b ? a : (ms(a) >= ms(b) ? a : b));

  /** Does `range` already contain [from, to]? A missing bound is unbounded.
   *  Named `range` rather than `window` on purpose — this file reaches for the
   *  global `window` a few lines down. */
  function covers(range, from, to) {
    if (!range.from || !range.to) return false;
    if (from && ms(from) < ms(range.from)) return false;
    if (to && ms(to) > ms(range.to)) return false;
    return true;
  }

  async function modules() {
    if (!mods) {
      const [project, merge, tz, recurrence, parishJoin] = await Promise.all([
        import('/shared/project.mjs'),
        import('/shared/merge.mjs'),
        import('/shared/tz.mjs'),
        // The app needs the week table directly, not only through the
        // projection: the fortnightly picker has to SHOW which dates a rule
        // would run on, and a second copy of that arithmetic in app.js is
        // exactly the drift /shared/ exists to prevent.
        import('/shared/recurrence.mjs'),
        // Puts each rule's parish fields back: the bundle sends a rule's own
        // columns only, and the projection reads the parish_* copies.
        import('/shared/parish-join.mjs'),
      ]);
      mods = { ...project, ...merge, ...tz, ...recurrence, ...parishJoin };
    }
    return mods;
  }

  /**
   * How this fetch may use the browser's HTTP cache.
   *
   * `/api/bundle` is served `no-cache` with an ETag, so the browser always
   * asks, and an unchanged bundle comes back as a 304 with no body. That is
   * what makes an edit in /admin show the moment somebody returns to the app —
   * it used to be `max-age=60, stale-while-revalidate=600`, under which a
   * script's fetch() was answered from the browser's copy for up to eleven
   * minutes without a request, and a localStorage hint tried (and on the way
   * back from /admin failed) to spot the admins it hurt.
   *
   * `fresh` — the write path — says the same thing explicitly. It is already
   * what the default does; spelling it out keeps a write from ever depending
   * on a header somebody later relaxes.
   */
  function cacheInit(opts) {
    return opts.fresh ? { cache: 'no-cache' } : {};
  }

  /**
   * Fetch the bundle. Cheap enough to re-fetch, but deduped so concurrent
   * callers share one request.
   *
   * The window matters now that the feed's horizon grows without limit. Rules
   * always travel whole — they are what makes a 2027 date projectable from a
   * bundle fetched today — but OVERRIDES and stored one-off events are
   * window-filtered server-side, so asking further out has to cost a request.
   * A window we already hold does not: the check is containment, not equality,
   * so the parish sheet's month never re-fetches behind the main feed's year.
   */
  async function load(opts = {}) {
    const from = opts.from || null;
    const to = opts.to || null;

    if (raw && !opts.fresh && covers(held, from, to) && Date.now() - loadedAt < 60000) return raw;
    if (inflight && !opts.fresh && covers(wanted, from, to)) return inflight;

    // Ask for the union of everything asked for since the last load, so a
    // narrow request landing after a wide one cannot undo the widening.
    wanted = { from: earlier(from, wanted.from), to: later(to, wanted.to) };
    const reqFrom = wanted.from, reqTo = wanted.to;

    const params = new URLSearchParams();
    if (reqFrom) params.set('from', reqFrom);
    if (reqTo) params.set('to', reqTo);

    inflight = (async () => {
      // The request and the four /shared/ modules together, not one after the
      // other: on a first load the imports alone are a round trip, and
      // nothing in them is needed to ASK for the bundle — only to use it.
      const [res] = await Promise.all([
        fetch(`/api/bundle?${params}`, cacheInit(opts)),
        modules(),
      ]);
      if (!res.ok) throw new Error(`bundle ${res.status}`);
      raw = await res.json();
      // Each rule arrives with its own columns only; give it its parish's
      // back, from the list in the same payload, before anything projects it.
      raw.schedules = mods.joinParishes(raw.schedules, raw.parishes);
      // What the SERVER says it answered with, not what we asked for — it
      // applies its own default when a bound is missing.
      held = { from: (raw.window && raw.window.from) || reqFrom, to: (raw.window && raw.window.to) || reqTo };
      wanted = { from: held.from, to: held.to };
      // Jurisdiction colour overrides ride along with the rules, and are
      // applied here rather than by a caller: every reader of a colour — cards,
      // map dots, chips, the parish sheet — runs during the render this load
      // triggers, so a caller that forgot the call would draw the old hue and
      // nothing would say why.
      if (window.agoraSetJurisdictionColors) {
        window.agoraSetJurisdictionColors(raw.jurisdiction_colors);
      }
      // …with one exception to "runs during the render this load triggers":
      // the jurisdiction chips are painted once by initFilters, before this
      // resolves, and nothing re-paints them afterwards. They are the reason
      // an override used to move every colour on the page except the row at
      // the very top of it.
      if (window.agoraRepaintJurisdictionChips) window.agoraRepaintJurisdictionChips();
      loadedAt = Date.now();
      return raw;
    })();

    // Clear only OUR request. A caller that needed a wider window replaced
    // `inflight` while this one was in the air, and nulling theirs on our
    // resolution would cost every later caller the dedup.
    const mine = inflight;
    try { return await mine; } finally { if (inflight === mine) inflight = null; }
  }

  /**
   * Project + merge into the feed shape app.js already expects: one array of
   * event objects with string ids.
   */
  function feed(from, to, opts = {}) {
    if (!raw || !mods) return [];
    const instances = mods.expandFrom(raw, from, to);
    const oneOffs = (raw.events || []).filter(e => {
      const t = Date.parse(e.start_utc);
      return t >= Date.parse(from) && t <= Date.parse(to);
    });
    // Jurisdiction/type filtering is left to app.js's own applyFilters, so the
    // two do not disagree about precedence.
    return mods.buildFeed(
      { instances, oneOffs, crossRows: raw.event_parishes },
      { lat: opts.lat, lng: opts.lng, radiusKm: opts.radiusKm },
    ).map(e => ({ ...e, id: String(e.id) }));
  }

  /** Resolve one id — integer (stored) or "scheduleId:YYYY-MM-DD" (instance). */
  function resolveEvent(id, from, to) {
    if (!raw || !mods) return null;
    const str = String(id);
    const stored = (raw.events || []).find(e => String(e.id) === str);
    if (stored) return { ...stored, id: str };

    const parsed = mods.parseInstanceId(str);
    if (!parsed) return null;
    // Project just this schedule's occurrence, without expanding the window.
    const s = (raw.schedules || []).find(x => x.id === parsed.scheduleId);
    if (!s || !mods.isValidOccurrence(s, parsed.date)) return null;
    const o = (raw.overrides || []).find(
      x => x.schedule_id === parsed.scheduleId && x.occurrence_date === parsed.date);
    // A break speaks for this date when no override does, exactly as it does
    // inside expandFrom. Without this a deep link into a break resolved to the
    // service running — the one card the break exists to replace.
    const b = o ? null : mods.breakCovering(s, parsed.date, raw.breaks);
    const inst = mods.project(s, parsed.date, o || (b ? {
      kind: 'break',
      break_from: b.from_date,
      break_until: b.to_date,
      break_note: b.note || null,
      updated_at: b.updated_at || null,
    } : null), new mods.OffsetCache());
    return inst ? { ...inst, id: String(inst.id) } : null;
  }

  /**
   * A parish's wall clock -> a UTC instant, through the same /shared/ module
   * the projection uses.
   *
   * Recurrence rules store LOCAL time and one-off events store UTC — the
   * asymmetry is deliberate and d1/schema.sql argues it at length — so the
   * moment a person types a date and a time into a form, something has to
   * cross between the two. That something is `exactLocalToEpoch`, which
   * already handles the two days a year a zone has two offsets.
   *
   * Exposed here rather than reimplemented in app.js, which is a classic
   * script and cannot import: a second copy of the offset maths in the app is
   * precisely the drift /shared/ exists to prevent, and it would be a copy
   * nothing in the suite runs.
   */
  async function localToUtc(zone, dateStr, timeStr) {
    const m = await modules();
    return new Date(m.exactLocalToEpoch(zone, dateStr, timeStr)).toISOString();
  }

  const parishes = () => (raw && raw.parishes) || [];

  // The bundle carries parish columns under the aliases the projection wants
  // (parish_jurisdiction, p_lat, p_timezone). The services view was written
  // against the old /api/schedules shape, which used jurisdiction/lat/lng.
  // Alias here rather than editing several thousand lines of render code —
  // without this every parish silently groups under "Other Orthodox".
  const schedules = () => ((raw && raw.schedules) || []).map(s => ({
    ...s,
    jurisdiction: s.jurisdiction ?? s.parish_jurisdiction,
    timezone: s.timezone ?? s.p_timezone,
    lat: s.lat ?? s.p_lat,
    lng: s.lng ?? s.p_lng,
  }));
  const isLoaded = () => !!raw;

  // The break windows the current window carries. The app needs the rows
  // themselves and not only their effect on the feed: a timetable row says "on
  // a break, back on the 12th", and that sentence is about the RULE rather than
  // about any occurrence the feed happens to be showing.
  const breaks = () => (raw && raw.breaks) || [];

  /**
   * Which fortnight a date falls in — 'a', 'b', or null before the modules
   * have loaded.
   *
   * Exposed for the same reason `localToUtc` is: app.js is a classic script
   * and cannot import, and the fortnightly picker has to SHOW the dates a rule
   * would run on or nobody can tell which of the two weeks they just picked.
   * A second copy of the week table in the app is precisely the drift
   * /shared/ exists to prevent, and it would be a copy no test runs.
   *
   * Synchronous, because it is called from a render. Null degrades to a picker
   * without its date preview rather than to a wrong one.
   */
  const weekAbOf = (dateStr) => (mods ? mods.weekAbOf(dateStr) : null);

  /**
   * The first date a rule runs again on or after `from`, stepping over its
   * breaks. Same reasoning as weekAbOf: the timetable says "back Sun 10 Jan"
   * and the arithmetic behind that sentence is the projection's, not a second
   * copy in app.js that nothing runs.
   */
  const nextOccurrenceAfterBreak = (rule, from, brs) =>
    (mods ? mods.nextOccurrenceAfterBreak(rule, from, brs || breaks()) : null);

  return {
    load, feed, resolveEvent, localToUtc, parishes, schedules, breaks, weekAbOf,
    nextOccurrenceAfterBreak, isLoaded,
    get raw() { return raw; },
  };
})();
