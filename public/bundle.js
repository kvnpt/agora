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
      const [project, merge, tz] = await Promise.all([
        import('/shared/project.mjs'),
        import('/shared/merge.mjs'),
        import('/shared/tz.mjs'),
      ]);
      mods = { ...project, ...merge, ...tz };
    }
    return mods;
  }

  /**
   * Whether this fetch may be answered from the browser's own HTTP cache.
   *
   * `/api/bundle` is served `max-age=60, stale-while-revalidate=600`, and the
   * SWR half is the part that bites: for ten minutes past the first minute the
   * browser will hand back a stale body WITHOUT asking, revalidating behind it.
   * For a reader that is the whole point — the client re-derives "now" locally,
   * so a slightly old set of rules still projects a correct feed.
   *
   * For the admin who just wrote a rule it is a bug, and a confusing one: a
   * hard reload does not clear it, because a script-issued `fetch()` is not
   * covered by the reload's cache bypass. The symptom is a new service that
   * refuses to appear in the session that added it while a private window shows
   * it at once — a private window having no HTTP cache to be stale.
   *
   * `fresh` is the write path and is unconditional. The admin flag is a HINT
   * and nothing else: it is read from localStorage so it is known on the very
   * first load, when `checkAdmin()` has not answered yet (init runs it
   * alongside `fetchParishes`, not before it). Being wrong costs one uncached
   * request and can grant nothing — every admin route verifies the Access JWT
   * server-side, and this value never reaches one.
   */
  function cacheInit(opts) {
    if (opts.fresh) return { cache: 'no-store' };
    let hinted = false;
    try { hinted = localStorage.getItem('agora.wasAdmin') === '1'; } catch { /* private window */ }
    const live = window.agoraState && window.agoraState.isAdmin;
    return (hinted || live) ? { cache: 'no-store' } : {};
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
      await modules();
      const res = await fetch(`/api/bundle?${params}`, cacheInit(opts));
      if (!res.ok) throw new Error(`bundle ${res.status}`);
      raw = await res.json();
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
    const inst = mods.project(s, parsed.date, o, new mods.OffsetCache());
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

  return { load, feed, resolveEvent, localToUtc, parishes, schedules, isLoaded, get raw() { return raw; } };
})();
