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
   * Fetch the bundle. Cheap enough to re-fetch, but deduped so concurrent
   * callers share one request.
   */
  async function load(opts = {}) {
    if (inflight) return inflight;
    if (raw && !opts.fresh && Date.now() - loadedAt < 60000) return raw;

    const params = new URLSearchParams();
    if (opts.from) params.set('from', opts.from);
    if (opts.to) params.set('to', opts.to);

    inflight = (async () => {
      await modules();
      const res = await fetch(`/api/bundle?${params}`, opts.fresh ? { cache: 'no-store' } : {});
      if (!res.ok) throw new Error(`bundle ${res.status}`);
      raw = await res.json();
      loadedAt = Date.now();
      return raw;
    })();

    try { return await inflight; } finally { inflight = null; }
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

  return { load, feed, resolveEvent, parishes, schedules, isLoaded, get raw() { return raw; } };
})();
