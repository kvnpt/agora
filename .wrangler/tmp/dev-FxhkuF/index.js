var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker/lib/router.mjs
var Router = class {
  static {
    __name(this, "Router");
  }
  constructor() {
    this.routes = [];
  }
  add(method, pattern, handler) {
    const names = [];
    const re = new RegExp("^" + pattern.replace(/:[A-Za-z_]+/g, (m) => {
      names.push(m.slice(1));
      return "([^/]+)";
    }).replace(/\//g, "\\/") + "$");
    this.routes.push({ method, re, names, handler });
    return this;
  }
  get(p, h) {
    return this.add("GET", p, h);
  }
  post(p, h) {
    return this.add("POST", p, h);
  }
  patch(p, h) {
    return this.add("PATCH", p, h);
  }
  delete(p, h) {
    return this.add("DELETE", p, h);
  }
  /** Returns a Response, or null when nothing matched. */
  async handle(request, env, ctx) {
    const url = new URL(request.url);
    const path = decodeURIComponent(url.pathname);
    let pathMatchedWrongMethod = false;
    for (const r of this.routes) {
      const m = path.match(r.re);
      if (!m) continue;
      if (r.method !== request.method) {
        pathMatchedWrongMethod = true;
        continue;
      }
      const params = {};
      r.names.forEach((n, i) => {
        params[n] = m[i + 1];
      });
      return r.handler({ request, env, ctx, params, url, query: url.searchParams });
    }
    if (pathMatchedWrongMethod) return json({ error: "Method not allowed" }, 405);
    return null;
  }
};
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers }
  });
}
__name(json, "json");
async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}
__name(readJson, "readJson");

// public/shared/tz.mjs
var MIN = 6e4;
var _formatters = /* @__PURE__ */ new Map();
function formatter(zone) {
  let f = _formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    });
    _formatters.set(zone, f);
  }
  return f;
}
__name(formatter, "formatter");
function offsetAt(zone, epochMs) {
  const p = formatter(zone).formatToParts(new Date(epochMs));
  const v = {};
  for (const { type, value } of p) if (type !== "literal") v[type] = value;
  const asIfUtc = Date.UTC(+v.year, +v.month - 1, +v.day, +v.hour, +v.minute, +v.second);
  return (asIfUtc - epochMs) / MIN;
}
__name(offsetAt, "offsetAt");
function transitionLocalToEpoch(zone, dateStr, timeStr, offA, offB) {
  const naive = naiveEpoch(dateStr, timeStr);
  const candA = naive - offA * MIN;
  const candB = naive - offB * MIN;
  const valid = /* @__PURE__ */ __name((e) => e + offsetAt(zone, e) * MIN === naive ? e : null, "valid");
  const a = valid(candA), b = valid(candB);
  if (a !== null && b !== null) return Math.min(a, b);
  if (a !== null) return a;
  if (b !== null) return b;
  return candA;
}
__name(transitionLocalToEpoch, "transitionLocalToEpoch");
function naiveEpoch(dateStr, timeStr) {
  const y = +dateStr.slice(0, 4), mo = +dateStr.slice(5, 7), d = +dateStr.slice(8, 10);
  const h = +timeStr.slice(0, 2), mi = +timeStr.slice(3, 5);
  return Date.UTC(y, mo - 1, d, h, mi, 0, 0);
}
__name(naiveEpoch, "naiveEpoch");
function timeToMinutes(timeStr) {
  return +timeStr.slice(0, 2) * 60 + +timeStr.slice(3, 5);
}
__name(timeToMinutes, "timeToMinutes");
var OffsetCache = class {
  static {
    __name(this, "OffsetCache");
  }
  constructor() {
    this.days = /* @__PURE__ */ new Map();
  }
  // { uniform: true, base } when the whole local day shares one offset — `base`
  // is the epoch of local midnight, so a time-of-day is one multiply away.
  // Otherwise { uniform: false } and callers take the exact path.
  _day(zone, dateStr) {
    const key = zone + "|" + dateStr;
    let d = this.days.get(key);
    if (d) return d;
    const startNaive = naiveEpoch(dateStr, "00:00");
    const endNaive = naiveEpoch(dateStr, "23:59");
    const a = offsetAt(zone, startNaive - offsetAt(zone, startNaive) * MIN);
    const b = offsetAt(zone, endNaive - offsetAt(zone, endNaive) * MIN);
    d = a === b ? { uniform: true, base: startNaive - a * MIN } : { uniform: false, offA: a, offB: b };
    this.days.set(key, d);
    return d;
  }
  /** Local wall clock ('YYYY-MM-DD', 'HH:MM') in `zone` -> epoch ms. */
  epoch(zone, dateStr, timeStr) {
    const d = this._day(zone, dateStr);
    if (d.uniform) return d.base + timeToMinutes(timeStr) * MIN;
    return transitionLocalToEpoch(zone, dateStr, timeStr, d.offA, d.offB);
  }
  /** Local wall clock -> UTC ISO string, matching the stored millisecond format. */
  toUtcISO(zone, dateStr, timeStr) {
    return new Date(this.epoch(zone, dateStr, timeStr)).toISOString();
  }
  get size() {
    return this.days.size;
  }
};
function localDateOf(zone, epochMs) {
  const p = formatter(zone).formatToParts(new Date(epochMs));
  const v = {};
  for (const { type, value } of p) if (type !== "literal") v[type] = value;
  return `${v.year}-${v.month}-${v.day}`;
}
__name(localDateOf, "localDateOf");

// public/shared/recurrence.mjs
function matchesOneWeek(dateStr, qualifier) {
  const d = /* @__PURE__ */ new Date(dateStr + "T00:00:00Z");
  const dayOfMonth = d.getUTCDate();
  const nextWeek = new Date(d);
  nextWeek.setUTCDate(dayOfMonth + 7);
  const hasNextWeek = nextWeek.getUTCMonth() === d.getUTCMonth();
  if (qualifier === "first") return dayOfMonth <= 7;
  if (qualifier === "second") return dayOfMonth >= 8 && dayOfMonth <= 14;
  if (qualifier === "third") return dayOfMonth >= 15 && dayOfMonth <= 21;
  if (qualifier === "fourth") return dayOfMonth >= 22 && dayOfMonth <= 28 && hasNextWeek;
  if (qualifier === "last") return !hasNextWeek;
  return false;
}
__name(matchesOneWeek, "matchesOneWeek");
function matchesWeekOfMonth(dateStr, qualifier) {
  if (!qualifier) return true;
  return qualifier.split(",").some((q) => matchesOneWeek(dateStr, q.trim()));
}
__name(matchesWeekOfMonth, "matchesWeekOfMonth");

// public/shared/project.mjs
var DAY_MS = 864e5;
function dateIndexFor(zone, fromMs, toMs) {
  const start = localDateOf(zone, fromMs);
  const end = localDateOf(zone, toMs);
  const byDow = { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
  let t = Date.parse(start + "T00:00:00Z");
  const endT = Date.parse(end + "T00:00:00Z");
  while (t <= endT) {
    const d = new Date(t);
    byDow[d.getUTCDay()].push(d.toISOString().slice(0, 10));
    t += DAY_MS;
  }
  return byDow;
}
__name(dateIndexFor, "dateIndexFor");
function project(s, date, o, cache) {
  const zone = s.p_timezone || "Australia/Sydney";
  const kind = o ? o.kind : null;
  const startTime = o && o.patch_start_time || s.start_time;
  const endTime = o && o.patch_end_time != null ? o.patch_end_time : s.end_time;
  const isTombstone = kind === "cancelled" || kind === "combined";
  return {
    id: `${s.id}:${date}`,
    // stable synthetic id (doubles as service_key)
    parish_id: s.parish_id,
    schedule_id: s.id,
    source_adapter: "schedule",
    title: o && o.patch_title || s.title,
    description: o && o.patch_description || null,
    feast: o && o.patch_feast || null,
    start_utc: cache.toUtcISO(zone, date, startTime),
    end_utc: endTime ? cache.toUtcISO(zone, date, endTime) : null,
    // Local wall clock and zone, so the client renders parish-local time without
    // converting back from UTC — and without knowing the viewer's location.
    start_local: `${date}T${startTime}`,
    end_local: endTime ? `${date}T${endTime}` : null,
    timezone: zone,
    location_override: o && o.patch_location_override || null,
    lat: s.p_lat,
    lng: s.p_lng,
    event_type: o && o.patch_event_type || s.event_type,
    languages: o && o.patch_languages != null ? o.patch_languages : s.languages,
    hide_live: o && o.patch_hide_live != null ? o.patch_hide_live : s.hide_live || 0,
    parish_scoped: o && o.patch_parish_scoped != null ? o.patch_parish_scoped : s.parish_scoped || 0,
    source_url: null,
    source_hash: `schedule-${s.id}-${date}`,
    confidence: "schedule",
    mutation_type: kind === "modified" ? "adapted" : "scheduled",
    // 'hidden' is still projected; the default API filter drops it. Not a tombstone.
    status: kind === "cancelled" ? "cancelled" : kind === "combined" ? "combined" : kind === "hidden" ? "hidden" : "approved",
    is_tombstone: isTombstone ? 1 : 0,
    combined_into_event_id: o && o.combined_into_event_id || null,
    created_at: s.created_at,
    updated_at: o ? o.updated_at : s.created_at,
    parish_name: s.parish_name,
    jurisdiction: s.parish_jurisdiction,
    parish_address: s.parish_address,
    parish_website: s.parish_website,
    parish_logo: s.parish_logo,
    parish_languages: s.parish_languages,
    parish_acronym: s.parish_acronym,
    parish_color: s.parish_color,
    parish_live_url: s.parish_live_url,
    // dedup inputs (see partitionKey/preferenceCmp in the events route)
    concurrent: s.concurrent || 0,
    week_of_month: s.week_of_month || null
  };
}
__name(project, "project");
function isValidOccurrence(s, date) {
  const dow = (/* @__PURE__ */ new Date(date + "T00:00:00Z")).getUTCDay();
  if (dow !== s.day_of_week) return false;
  if (!matchesWeekOfMonth(date, s.week_of_month)) return false;
  if (s.effective_from && date < s.effective_from) return false;
  if (s.effective_to && date > s.effective_to) return false;
  return true;
}
__name(isValidOccurrence, "isValidOccurrence");
function expandFrom({ schedules, overrides }, fromUtc, toUtc, { cache = new OffsetCache() } = {}) {
  const fromMs = Date.parse(fromUtc);
  const toMs = Date.parse(toUtc);
  const ov = {};
  for (const r of overrides || []) ov[`${r.schedule_id}:${r.occurrence_date}`] = r;
  const indexes = /* @__PURE__ */ new Map();
  const out = [];
  for (const s of schedules || []) {
    const zone = s.p_timezone || "Australia/Sydney";
    let byDow = indexes.get(zone);
    if (!byDow) {
      byDow = dateIndexFor(zone, fromMs, toMs);
      indexes.set(zone, byDow);
    }
    for (const date of byDow[s.day_of_week] || []) {
      if (!matchesWeekOfMonth(date, s.week_of_month)) continue;
      if (s.effective_from && date < s.effective_from) continue;
      if (s.effective_to && date > s.effective_to) continue;
      const inst = project(s, date, ov[`${s.id}:${date}`], cache);
      const startMs = Date.parse(inst.start_utc);
      if (startMs < fromMs || startMs > toMs) continue;
      out.push(inst);
    }
  }
  return out;
}
__name(expandFrom, "expandFrom");
function parseInstanceId(id) {
  const str = String(id);
  const i = str.indexOf(":");
  if (i === -1) return null;
  const scheduleId = Number(str.slice(0, i));
  const date = str.slice(i + 1);
  if (!Number.isInteger(scheduleId) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return { scheduleId, date };
}
__name(parseInstanceId, "parseInstanceId");

// worker/lib/expand.mjs
var DAY_MS2 = 864e5;
var isoDate = /* @__PURE__ */ __name((ms) => new Date(ms).toISOString().slice(0, 10), "isoDate");
var PARISH_COLS = `
  p.lat AS p_lat, p.lng AS p_lng, p.timezone AS p_timezone,
  p.name AS parish_name, p.jurisdiction AS parish_jurisdiction,
  p.address AS parish_address, p.website AS parish_website,
  p.logo_path AS parish_logo, p.languages AS parish_languages,
  p.acronym AS parish_acronym, p.color AS parish_color, p.live_url AS parish_live_url
`;
async function fetchWindowRows(db, fromUtc, toUtc, { scheduleId = null } = {}) {
  const startStr = isoDate(Date.parse(fromUtc) - DAY_MS2);
  const endStr = isoDate(Date.parse(toUtc) + DAY_MS2);
  const schedSql = `
    SELECT s.*, ${PARISH_COLS}
    FROM schedules s JOIN parishes p ON s.parish_id = p.id
    WHERE s.active = 1 ${scheduleId ? "AND s.id = ?" : ""}
      AND (s.effective_from IS NULL OR s.effective_from <= ?)
      AND (s.effective_to   IS NULL OR s.effective_to   >= ?)
  `;
  const schedArgs = scheduleId ? [scheduleId, endStr, startStr] : [endStr, startStr];
  const ovSql = scheduleId ? "SELECT * FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date BETWEEN ? AND ?" : "SELECT * FROM schedule_overrides WHERE occurrence_date BETWEEN ? AND ?";
  const ovArgs = scheduleId ? [scheduleId, startStr, endStr] : [startStr, endStr];
  const [schedules, overrides] = await Promise.all([
    db.prepare(schedSql).bind(...schedArgs).all(),
    db.prepare(ovSql).bind(...ovArgs).all()
  ]);
  return { schedules: schedules.results || [], overrides: overrides.results || [] };
}
__name(fetchWindowRows, "fetchWindowRows");
async function expandWindow(db, fromUtc, toUtc, { scheduleId = null, cache = new OffsetCache() } = {}) {
  const rows = await fetchWindowRows(db, fromUtc, toUtc, { scheduleId });
  if (!rows.schedules.length) return [];
  return expandFrom(rows, fromUtc, toUtc, { cache });
}
__name(expandWindow, "expandWindow");
async function expandOne(db, scheduleId, date, { cache = new OffsetCache() } = {}) {
  const s = await db.prepare(
    `SELECT s.*, ${PARISH_COLS} FROM schedules s JOIN parishes p ON s.parish_id = p.id WHERE s.id = ?`
  ).bind(scheduleId).first();
  if (!s || !s.active) return null;
  if (!isValidOccurrence(s, date)) return null;
  const o = await db.prepare(
    "SELECT * FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?"
  ).bind(scheduleId, date).first();
  return project(s, date, o, cache);
}
__name(expandOne, "expandOne");

// worker/routes/public.mjs
var DEFAULT_WINDOW_DAYS = 120;
var DAY_MS3 = 864e5;
function windowFrom(query) {
  const from = query.get("from") || new Date(Date.now() - DAY_MS3).toISOString();
  const to = query.get("to") || new Date(Date.parse(from) + DEFAULT_WINDOW_DAYS * DAY_MS3).toISOString();
  return { from, to };
}
__name(windowFrom, "windowFrom");
var PARISH_COLS2 = `id, name, full_name, jurisdiction, address, lat, lng, timezone,
  website, phone, email, logo_path, acronym, chant_style, languages, color, live_url,
  donation_url, raffle_url, payment_url, gala_url,
  info_source_type, info_source_ref, info_verified_at`;
function registerPublicRoutes(router2) {
  router2.get("/api/bundle", async ({ env, query }) => {
    const { from, to } = windowFrom(query);
    const [rows, parishes, oneOffs, cross] = await Promise.all([
      fetchWindowRows(env.DB, from, to),
      env.DB.prepare(`SELECT ${PARISH_COLS2} FROM parishes WHERE id != '_unassigned'`).all(),
      env.DB.prepare(
        `SELECT e.*, p.name AS parish_name, p.jurisdiction, p.address AS parish_address,
                p.website AS parish_website, p.logo_path AS parish_logo,
                p.languages AS parish_languages, p.acronym AS parish_acronym,
                p.color AS parish_color, p.live_url AS parish_live_url,
                p.timezone AS timezone
         FROM events e JOIN parishes p ON e.parish_id = p.id
         WHERE e.source_adapter != 'schedule' AND e.start_utc >= ? AND e.start_utc <= ?`
      ).bind(from, to).all(),
      env.DB.prepare("SELECT event_id, parish_id FROM event_parishes").all()
    ]);
    return json({
      window: { from, to },
      generated_at: (/* @__PURE__ */ new Date()).toISOString(),
      parishes: parishes.results || [],
      schedules: rows.schedules,
      overrides: rows.overrides,
      events: oneOffs.results || [],
      event_parishes: cross.results || []
    }, 200, {
      // Rules change rarely. The client re-derives "now" locally, so a stale-ish
      // bundle is still correct — only newly-added events are missed, briefly.
      "cache-control": "public, max-age=60, stale-while-revalidate=600"
    });
  });
  router2.get("/api/parishes", async ({ env }) => {
    const r = await env.DB.prepare(
      `SELECT ${PARISH_COLS2} FROM parishes WHERE id != '_unassigned' ORDER BY name`
    ).all();
    return json(r.results || []);
  });
  router2.get("/api/parishes/:id", async ({ env, params }) => {
    const row = await env.DB.prepare(`SELECT ${PARISH_COLS2} FROM parishes WHERE id = ?`).bind(params.id).first();
    return row ? json(row) : json({ error: "Parish not found" }, 404);
  });
  router2.get("/api/schedules", async ({ env, query }) => {
    const jurisdiction = query.get("jurisdiction");
    const sql = `
      SELECT s.*, p.name AS parish_name, p.full_name, p.jurisdiction, p.timezone,
             p.address AS parish_address, p.lat, p.lng, p.website AS parish_website,
             p.logo_path AS parish_logo, p.languages AS parish_languages,
             p.acronym AS parish_acronym, p.color AS parish_color
      FROM schedules s JOIN parishes p ON s.parish_id = p.id
      WHERE s.active = 1 AND p.id != '_unassigned'
      ${jurisdiction ? "AND p.jurisdiction = ?" : ""}
      ORDER BY p.name, s.day_of_week, s.start_time`;
    const stmt = jurisdiction ? env.DB.prepare(sql).bind(jurisdiction) : env.DB.prepare(sql);
    return json((await stmt.all()).results || []);
  });
  router2.get("/api/events/:id", async ({ env, params }) => {
    const parsed = parseInstanceId(params.id);
    if (parsed) {
      const inst = await expandOne(env.DB, parsed.scheduleId, parsed.date);
      return inst ? json(inst) : json({ error: "Event not found" }, 404);
    }
    const row = await env.DB.prepare(
      `SELECT e.*, p.name AS parish_name, p.jurisdiction, p.address AS parish_address,
              p.timezone, p.live_url AS parish_live_url
       FROM events e JOIN parishes p ON e.parish_id = p.id WHERE e.id = ?`
    ).bind(params.id).first();
    return row ? json(row) : json({ error: "Event not found" }, 404);
  });
  router2.get("/api/adapters/status", async ({ env }) => {
    const r = await env.DB.prepare(
      `SELECT adapter_id, started_at, finished_at, status, events_found, events_created,
              events_updated, error_message
       FROM adapter_runs r
       WHERE started_at = (SELECT MAX(started_at) FROM adapter_runs WHERE adapter_id = r.adapter_id)
       ORDER BY adapter_id`
    ).all();
    return json((r.results || []).map((run) => ({
      id: run.adapter_id,
      healthy: run.status !== "failed",
      message: `Last run: ${run.status}`,
      lastRun: run.finished_at,
      lastError: run.error_message,
      eventsFound: run.events_found,
      eventsCreated: run.events_created,
      eventsUpdated: run.events_updated
    })));
  });
}
__name(registerPublicRoutes, "registerPublicRoutes");

// worker/lib/auth.mjs
var b64urlToBytes = /* @__PURE__ */ __name((s) => {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}, "b64urlToBytes");
var b64urlToJson = /* @__PURE__ */ __name((s) => JSON.parse(new TextDecoder().decode(b64urlToBytes(s))), "b64urlToJson");
var _keyCache = { domain: null, at: 0, keys: /* @__PURE__ */ new Map() };
var KEY_TTL_MS = 36e5;
async function keyFor(teamDomain, kid) {
  const stale = _keyCache.domain !== teamDomain || Date.now() - _keyCache.at > KEY_TTL_MS;
  if (!stale && _keyCache.keys.has(kid)) return _keyCache.keys.get(kid);
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs unavailable: ${res.status}`);
  const { keys } = await res.json();
  const map = /* @__PURE__ */ new Map();
  for (const jwk of keys || []) {
    map.set(jwk.kid, await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    ));
  }
  _keyCache = { domain: teamDomain, at: Date.now(), keys: map };
  return map.get(kid);
}
__name(keyFor, "keyFor");
async function verifyAccessJwt(token, { teamDomain, aud }) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [rawHeader, rawPayload, rawSig] = parts;
  const header = b64urlToJson(rawHeader);
  if (header.alg !== "RS256") throw new Error(`unexpected alg ${header.alg}`);
  const key = await keyFor(teamDomain, header.kid);
  if (!key) throw new Error("unknown signing key");
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    b64urlToBytes(rawSig),
    new TextEncoder().encode(`${rawHeader}.${rawPayload}`)
  );
  if (!ok) throw new Error("bad signature");
  const claims = b64urlToJson(rawPayload);
  const now = Math.floor(Date.now() / 1e3);
  if (claims.exp && claims.exp < now) throw new Error("token expired");
  if (claims.nbf && claims.nbf > now) throw new Error("token not yet valid");
  if (claims.iss && claims.iss !== `https://${teamDomain}`) throw new Error("wrong issuer");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(aud)) throw new Error("wrong audience");
  return claims;
}
__name(verifyAccessJwt, "verifyAccessJwt");
async function requireAdmin({ request, env }) {
  if (env.AGORA_DEV_ADMIN === "true") return null;
  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  if (!teamDomain || !aud) {
    return json({
      error: "Admin auth is not configured",
      detail: "Set ACCESS_TEAM_DOMAIN and ACCESS_AUD. Refusing rather than allowing."
    }, 503);
  }
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return json({ error: "Unauthorized" }, 401);
  try {
    const claims = await verifyAccessJwt(token, { teamDomain, aud });
    return null;
  } catch (err) {
    return json({ error: "Unauthorized", detail: err.message }, 401);
  }
}
__name(requireAdmin, "requireAdmin");

// worker/lib/geocode.mjs
async function geocode(address, { countryCodes = "au" } = {}) {
  if (!address || !address.trim()) return null;
  const params = new URLSearchParams({
    q: address,
    format: "json",
    limit: "1",
    countrycodes: countryCodes,
    // Bias toward Sydney without excluding the rest of Oceania.
    viewbox: "150.5,-34.2,151.5,-33.4",
    bounded: "0"
  });
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { "User-Agent": "Agora-OrthodoxEventFinder/1.0 (orthodoxy.au)" }
    });
    if (!res.ok) return null;
    const results = await res.json();
    if (!results.length) return null;
    return { lat: parseFloat(results[0].lat), lng: parseFloat(results[0].lon) };
  } catch (err) {
    console.error("[geocode] failed:", err.message);
    return null;
  }
}
__name(geocode, "geocode");

// worker/lib/overrides.mjs
var PATCH_COLS = [
  "patch_title",
  "patch_start_time",
  "patch_end_time",
  "patch_event_type",
  "patch_languages",
  "patch_feast",
  "patch_description",
  "patch_location_override",
  "patch_hide_live",
  "patch_parish_scoped"
];
var DISPLAY_FIELDS = [
  "title",
  "description",
  "start_utc",
  "end_utc",
  "event_type",
  "languages",
  "location_override",
  "hide_live",
  "parish_scoped",
  "feast"
];
function localHHMM(zone, utc) {
  const ms = Date.parse(utc);
  const mins = ((ms + offsetAt(zone, ms) * 6e4) % 864e5 + 864e5) % 864e5 / 6e4;
  const h = Math.floor(mins / 60), m = Math.round(mins % 60);
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}
__name(localHHMM, "localHHMM");
function mergePatch(s, zone, body, cur) {
  if ("title" in body) cur.patch_title = body.title && body.title !== s.title ? body.title : null;
  if ("start_utc" in body && body.start_utc) {
    const hhmm = localHHMM(zone, body.start_utc);
    cur.patch_start_time = hhmm !== s.start_time ? hhmm : null;
  }
  if ("end_utc" in body) {
    const hhmm = body.end_utc ? localHHMM(zone, body.end_utc) : null;
    cur.patch_end_time = (hhmm || null) !== (s.end_time || null) ? hhmm : null;
  }
  if ("event_type" in body) cur.patch_event_type = body.event_type && body.event_type !== s.event_type ? body.event_type : null;
  if ("languages" in body) cur.patch_languages = (body.languages || null) !== (s.languages || null) ? body.languages || null : null;
  if ("feast" in body) cur.patch_feast = body.feast || null;
  if ("description" in body) cur.patch_description = body.description || null;
  if ("location_override" in body) cur.patch_location_override = body.location_override || null;
  if ("hide_live" in body) cur.patch_hide_live = (body.hide_live ? 1 : 0) !== (s.hide_live || 0) ? body.hide_live ? 1 : 0 : null;
  if ("parish_scoped" in body) cur.patch_parish_scoped = (body.parish_scoped ? 1 : 0) !== (s.parish_scoped || 0) ? body.parish_scoped ? 1 : 0 : null;
}
__name(mergePatch, "mergePatch");
var hasContent = /* @__PURE__ */ __name((cur) => PATCH_COLS.some((c) => cur[c] != null) || cur.combined_into_event_id != null, "hasContent");
function upsert(db, scheduleId, date, kind, cur) {
  return db.prepare(`
    INSERT INTO schedule_overrides
      (schedule_id, occurrence_date, kind, patch_title, patch_start_time, patch_end_time,
       patch_event_type, patch_languages, patch_feast, patch_description, patch_location_override,
       patch_hide_live, patch_parish_scoped, combined_into_event_id, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
    ON CONFLICT(schedule_id, occurrence_date) DO UPDATE SET
      kind=excluded.kind,
      patch_title=excluded.patch_title, patch_start_time=excluded.patch_start_time,
      patch_end_time=excluded.patch_end_time, patch_event_type=excluded.patch_event_type,
      patch_languages=excluded.patch_languages, patch_feast=excluded.patch_feast,
      patch_description=excluded.patch_description,
      patch_location_override=excluded.patch_location_override,
      patch_hide_live=excluded.patch_hide_live, patch_parish_scoped=excluded.patch_parish_scoped,
      combined_into_event_id=excluded.combined_into_event_id,
      updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
  `).bind(
    scheduleId,
    date,
    kind,
    cur.patch_title ?? null,
    cur.patch_start_time ?? null,
    cur.patch_end_time ?? null,
    cur.patch_event_type ?? null,
    cur.patch_languages ?? null,
    cur.patch_feast ?? null,
    cur.patch_description ?? null,
    cur.patch_location_override ?? null,
    cur.patch_hide_live ?? null,
    cur.patch_parish_scoped ?? null,
    cur.combined_into_event_id ?? null
  ).run();
}
__name(upsert, "upsert");
var loadSchedule = /* @__PURE__ */ __name((db, scheduleId) => db.prepare(
  `SELECT s.*, p.timezone AS p_timezone FROM schedules s
   JOIN parishes p ON s.parish_id = p.id WHERE s.id = ?`
).bind(scheduleId).first(), "loadSchedule");
var loadOverride = /* @__PURE__ */ __name((db, scheduleId, date) => db.prepare(
  "SELECT * FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?"
).bind(scheduleId, date).first(), "loadOverride");
async function applyAdminEdit(db, scheduleId, date, body, cache = new OffsetCache()) {
  const s = await loadSchedule(db, scheduleId);
  if (!s) return { error: "Schedule not found", code: 404 };
  if (!isValidOccurrence(s, date)) return { error: "Not a valid occurrence of this schedule", code: 400 };
  if (body.parish_id && body.parish_id !== s.parish_id) {
    return { error: "Edit the schedule to move a recurring service to another parish", code: 400 };
  }
  const zone = s.p_timezone || "Australia/Sydney";
  const existing = await loadOverride(db, scheduleId, date);
  const cur = existing ? { ...existing } : {};
  const hasDisplay = DISPLAY_FIELDS.some((f) => f in body);
  mergePatch(s, zone, body, cur);
  const status = body.status;
  if (status && !["approved", "cancelled", "hidden"].includes(status)) {
    return { error: "Unsupported status for a scheduled instance (use approved/cancelled/hidden)", code: 400 };
  }
  let kind;
  if (status === "cancelled") kind = "cancelled";
  else if (status === "hidden") kind = "hidden";
  else if (status === "approved") kind = hasContent(cur) ? "modified" : "__revert__";
  else kind = hasDisplay ? "modified" : null;
  if (kind === "modified" && !hasContent(cur)) kind = "__revert__";
  if (kind === null) return { error: "No changes", code: 400 };
  if (kind === "__revert__") {
    await db.prepare("DELETE FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?").bind(scheduleId, date).run();
  } else {
    await upsert(db, scheduleId, date, kind, cur);
  }
  return { instance: await expandOne(db, scheduleId, date, { cache }) };
}
__name(applyAdminEdit, "applyAdminEdit");
async function hideInstance(db, scheduleId, date) {
  const s = await loadSchedule(db, scheduleId);
  if (!s) return { error: "Schedule not found", code: 404 };
  if (!isValidOccurrence(s, date)) return { error: "Not a valid occurrence of this schedule", code: 400 };
  const existing = await loadOverride(db, scheduleId, date);
  await upsert(db, scheduleId, date, "hidden", existing ? { ...existing } : {});
  return { ok: true };
}
__name(hideInstance, "hideInstance");
async function setCombined(db, scheduleId, date, combiningEventId) {
  const s = await loadSchedule(db, scheduleId);
  if (!s) return { error: "Schedule not found", code: 404 };
  if (!isValidOccurrence(s, date)) return { error: "Not a valid occurrence of this schedule", code: 400 };
  const existing = await loadOverride(db, scheduleId, date);
  const cur = existing ? { ...existing } : {};
  cur.combined_into_event_id = combiningEventId;
  await upsert(db, scheduleId, date, "combined", cur);
  return { ok: true };
}
__name(setCombined, "setCombined");
async function clearCombined(db, scheduleId, date) {
  await db.prepare(
    "DELETE FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ? AND kind = 'combined'"
  ).bind(scheduleId, date).run();
  return { ok: true };
}
__name(clearCombined, "clearCombined");

// worker/lib/adapters.mjs
async function sha256Hex(input) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
__name(sha256Hex, "sha256Hex");
var GoogleCalendarAdapter = class {
  static {
    __name(this, "GoogleCalendarAdapter");
  }
  constructor({ parishId, calendarId, schedule }) {
    this.id = `gcal-${parishId}`;
    this.parishId = parishId;
    this.calendarId = calendarId;
    this.sourceType = "google-calendar";
    this.schedule = schedule || "0 */4 * * *";
  }
  async fetchEvents(env) {
    const apiKey = env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error("GOOGLE_API_KEY not set");
    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events`
    );
    url.searchParams.set("key", apiKey);
    url.searchParams.set("timeMin", (/* @__PURE__ */ new Date()).toISOString());
    url.searchParams.set("timeMax", new Date(Date.now() + 90 * 864e5).toISOString());
    url.searchParams.set("singleEvents", "true");
    url.searchParams.set("orderBy", "startTime");
    url.searchParams.set("maxResults", "100");
    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Google Calendar API error: ${res.status} ${res.statusText}`);
    const data = await res.json();
    return Promise.all((data.items || []).map(async (item) => {
      const start = item.start?.dateTime || item.start?.date;
      const end = item.end?.dateTime || item.end?.date;
      const title = item.summary || "Untitled Event";
      return {
        title,
        description: item.description || null,
        start_utc: new Date(start).toISOString(),
        end_utc: end ? new Date(end).toISOString() : null,
        event_type: guessEventType(title),
        source_url: item.htmlLink || null,
        source_hash: await sha256Hex(`gcal-${this.calendarId}-${item.id}`),
        location_override: item.location || null,
        hide_live: shouldHideLive(title) ? 1 : 0,
        parish_scoped: isParishScoped(title) ? 1 : 0
      };
    }));
  }
};
var shouldHideLive = /* @__PURE__ */ __name((t) => /confession|setup|prayer ministry|retreat|camp/i.test(t), "shouldHideLive");
var isParishScoped = /* @__PURE__ */ __name((t) => /^\s*(setup|cleaning|confession)\s*$/i.test(t), "isParishScoped");
function guessEventType(title) {
  const t = title.toLowerCase();
  if (/liturgy|θεία λειτουργία/.test(t)) return "liturgy";
  if (/vespers|εσπερινός|matins|orthros|compline|bridegroom|holy unction|lamentations|passion gospels/.test(t)) return "prayer";
  if (/feast|nameday/.test(t)) return "feast";
  if (/youth|young|teens/.test(t)) return "youth";
  if (/talk|lecture|class|study/.test(t)) return "talk";
  if (/festival|paniyiri|fete|fundrais|dinner|gala|charity/.test(t)) return "social";
  return "other";
}
__name(guessEventType, "guessEventType");
var ADAPTERS = [
  new GoogleCalendarAdapter({
    parishId: "antiochian-good-shepherd-antiochian-church",
    calendarId: "goodshepherdclayton@gmail.com"
  })
];
var getAdapter = /* @__PURE__ */ __name((id) => ADAPTERS.find((a) => a.id === id) || null, "getAdapter");
async function runAdapter(adapter, env) {
  const db = env.DB;
  const started = await db.prepare(
    "INSERT INTO adapter_runs (adapter_id, status) VALUES (?, 'running') RETURNING id"
  ).bind(adapter.id).first();
  const runId = started.id;
  try {
    const events = await adapter.fetchEvents(env);
    const eventsFound = events.length;
    let eventsCreated = 0, eventsUpdated = 0;
    const hashes = events.map((e) => e.source_hash).filter(Boolean);
    const existing = /* @__PURE__ */ new Set();
    if (hashes.length) {
      const q = await db.prepare(
        `SELECT source_hash FROM events WHERE source_hash IN (${hashes.map(() => "?").join(",")})`
      ).bind(...hashes).all();
      for (const r of q.results || []) existing.add(r.source_hash);
    }
    const parish = await db.prepare("SELECT lat, lng FROM parishes WHERE id = ?").bind(adapter.parishId).first();
    const upsert2 = db.prepare(`
      INSERT INTO events (parish_id, source_adapter, title, description, start_utc, end_utc,
        location_override, lat, lng, event_type, source_url, source_hash, status,
        mutation_type, hide_live, parish_scoped)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'approved','headless',?,?)
      ON CONFLICT(source_hash) DO UPDATE SET
        title=excluded.title, description=excluded.description,
        start_utc=excluded.start_utc, end_utc=excluded.end_utc,
        event_type=excluded.event_type, hide_live=excluded.hide_live,
        parish_scoped=excluded.parish_scoped,
        updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
    `);
    const writes = events.map((e) => {
      if (e.source_hash && existing.has(e.source_hash)) eventsUpdated++;
      else eventsCreated++;
      return upsert2.bind(
        adapter.parishId,
        adapter.id,
        e.title,
        e.description || null,
        e.start_utc,
        e.end_utc || null,
        e.location_override || null,
        e.lat ?? parish?.lat ?? null,
        e.lng ?? parish?.lng ?? null,
        e.event_type || "other",
        e.source_url || null,
        e.source_hash || null,
        e.hide_live ? 1 : 0,
        e.parish_scoped ? 1 : 0
      );
    });
    if (writes.length) await db.batch(writes);
    await db.prepare(
      `UPDATE adapter_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
       status='success', events_found=?, events_created=?, events_updated=? WHERE id=?`
    ).bind(eventsFound, eventsCreated, eventsUpdated, runId).run();
    console.log(`[${adapter.id}] found=${eventsFound} created=${eventsCreated} updated=${eventsUpdated}`);
    return { eventsFound, eventsCreated, eventsUpdated };
  } catch (err) {
    await db.prepare(
      `UPDATE adapter_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
       status='failed', error_message=? WHERE id=?`
    ).bind(err.message, runId).run();
    console.error(`[${adapter.id}] failed:`, err.message);
    throw err;
  }
}
__name(runAdapter, "runAdapter");

// worker/routes/admin.mjs
var guarded = /* @__PURE__ */ __name((fn) => async (c) => {
  const denied = await requireAdmin(c);
  if (denied) return denied;
  return fn(c);
}, "guarded");
async function syncEventCoordsForParish(db, parishId) {
  if (!parishId || parishId === "_unassigned") return;
  const p = await db.prepare("SELECT lat, lng FROM parishes WHERE id = ?").bind(parishId).first();
  if (!p || p.lat == null) return;
  await db.prepare(
    `UPDATE events SET lat = ?, lng = ? WHERE parish_id = ?
     AND (location_override IS NULL OR location_override = '')`
  ).bind(p.lat, p.lng, parishId).run();
}
__name(syncEventCoordsForParish, "syncEventCoordsForParish");
function registerAdminRoutes(router2) {
  router2.get("/api/admin/ping", guarded(async () => json({ ok: true })));
  router2.get("/api/admin/events/candidates", guarded(async ({ env, query }) => {
    const date = query.get("date");
    const excludeId = query.get("exclude_id");
    if (!date) return json({ error: "date required (YYYY-MM-DD)" }, 400);
    const [y, m, d] = date.split("-").map(Number);
    const from = new Date(Date.UTC(y, m - 1, d - 1, 13, 0, 0)).toISOString();
    const to = new Date(Date.UTC(y, m - 1, d, 14, 0, 0)).toISOString();
    const oneOffs = await env.DB.prepare(
      `SELECT e.id, e.title, e.start_utc, e.end_utc, e.parish_id, p.name AS parish_name,
              e.mutation_type, e.status, e.event_type
       FROM events e JOIN parishes p ON e.parish_id = p.id
       WHERE e.source_adapter != 'schedule' AND e.start_utc >= ? AND e.start_utc < ?
         AND e.status NOT IN ('replaced','rejected','cancelled','hidden')
         AND e.id != COALESCE(?, -1)
       ORDER BY e.start_utc`
    ).bind(from, to, /^\d+$/.test(String(excludeId)) ? Number(excludeId) : null).all();
    const instances = (await expandWindow(env.DB, from, to)).filter((e) => e.id !== excludeId && e.status === "approved").map((e) => ({
      id: e.id,
      title: e.title,
      start_utc: e.start_utc,
      end_utc: e.end_utc,
      parish_id: e.parish_id,
      parish_name: e.parish_name,
      mutation_type: e.mutation_type,
      status: e.status,
      event_type: e.event_type
    }));
    return json([...oneOffs.results || [], ...instances].sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc)));
  }));
  router2.patch("/api/admin/events/:id", guarded(async ({ env, params, request }) => {
    const body = await readJson(request);
    const inst = parseInstanceId(params.id);
    if (inst) {
      const r = await applyAdminEdit(env.DB, inst.scheduleId, inst.date, body);
      return r.error ? json({ error: r.error }, r.code || 400) : json(r.instance);
    }
    const event = await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(params.id).first();
    if (!event) return json({ error: "Event not found" }, 404);
    const {
      status,
      parish_id,
      title,
      description,
      start_utc,
      end_utc,
      event_type,
      languages,
      location_override,
      hide_live,
      parish_scoped
    } = body;
    if (status && !["approved", "rejected", "cancelled", "hidden"].includes(status)) {
      return json({ error: "Invalid status" }, 400);
    }
    const sets = [], vals = [];
    const put = /* @__PURE__ */ __name((col, v) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    }, "put");
    if (status) put("status", status);
    if (title) put("title", title);
    if (description !== void 0) put("description", description || null);
    if (start_utc) put("start_utc", start_utc);
    if (end_utc !== void 0) put("end_utc", end_utc || null);
    if (event_type) put("event_type", event_type);
    if (languages !== void 0) put("languages", languages || null);
    if (location_override !== void 0) put("location_override", location_override || null);
    if (hide_live !== void 0) put("hide_live", hide_live ? 1 : 0);
    if (parish_scoped !== void 0) put("parish_scoped", parish_scoped ? 1 : 0);
    if (parish_id && parish_id !== event.parish_id) {
      const p = await env.DB.prepare("SELECT id, lat, lng FROM parishes WHERE id = ?").bind(parish_id).first();
      if (!p) return json({ error: "Invalid parish_id" }, 400);
      put("parish_id", parish_id);
      put("lat", p.lat);
      put("lng", p.lng);
    }
    if (!sets.length) return json({ error: "No fields to update" }, 400);
    sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now')");
    await env.DB.prepare(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, params.id).run();
    if (location_override) {
      const coords = await geocode(location_override);
      if (coords) {
        await env.DB.prepare("UPDATE events SET lat = ?, lng = ? WHERE id = ?").bind(coords.lat, coords.lng, params.id).run();
      }
    } else if (location_override === "") {
      const p = await env.DB.prepare("SELECT lat, lng FROM parishes WHERE id = ?").bind(event.parish_id).first();
      if (p) {
        await env.DB.prepare("UPDATE events SET lat = ?, lng = ? WHERE id = ?").bind(p.lat, p.lng, params.id).run();
      }
    }
    return json(await env.DB.prepare("SELECT * FROM events WHERE id = ?").bind(params.id).first());
  }));
  router2.delete("/api/admin/events/:id", guarded(async ({ env, params }) => {
    const inst = parseInstanceId(params.id);
    if (inst) {
      const r = await hideInstance(env.DB, inst.scheduleId, inst.date);
      return r.error ? json({ error: r.error }, r.code || 400) : json({ ok: true });
    }
    const event = await env.DB.prepare("SELECT id FROM events WHERE id = ?").bind(params.id).first();
    if (!event) return json({ error: "Event not found" }, 404);
    await env.DB.prepare("DELETE FROM events WHERE id = ?").bind(params.id).run();
    return json({ ok: true });
  }));
  router2.get("/api/admin/events/:id/escalation", guarded(async ({ env, params }) => {
    const additive = await env.DB.prepare("SELECT parish_id FROM event_parishes WHERE event_id = ?").bind(params.id).all();
    const replaced = (await env.DB.prepare(
      `SELECT e.id, e.title, e.parish_id, p.name AS parish_name, e.start_utc, e.end_utc
       FROM event_replaces er JOIN events e ON e.id = er.replaced_event_id
       JOIN parishes p ON p.id = e.parish_id WHERE er.replacing_event_id = ?`
    ).bind(params.id).all()).results || [];
    const combined = await env.DB.prepare(
      "SELECT schedule_id, occurrence_date FROM schedule_overrides WHERE combined_into_event_id = ? AND kind = 'combined'"
    ).bind(params.id).all();
    for (const r of combined.results || []) {
      const inst = await expandOne(env.DB, r.schedule_id, r.occurrence_date);
      if (inst) replaced.push({
        id: inst.id,
        title: inst.title,
        parish_id: inst.parish_id,
        parish_name: inst.parish_name,
        start_utc: inst.start_utc,
        end_utc: inst.end_utc
      });
    }
    return json({
      additive_parish_ids: (additive.results || []).map((r) => r.parish_id),
      replaced_events: replaced
    });
  }));
  router2.post("/api/admin/events/:id/escalate", guarded(async ({ env, params, request }) => {
    const db = env.DB;
    const event = await db.prepare("SELECT * FROM events WHERE id = ?").bind(params.id).first();
    if (!event) return json({ error: "Event not found" }, 404);
    const body = await readJson(request);
    const { additive_parish_ids = [], replaced_event_ids = [], approve = false } = body;
    const synthTargets = /* @__PURE__ */ new Set(), intTargets = /* @__PURE__ */ new Set();
    for (const rid of replaced_event_ids) {
      if (parseInstanceId(rid)) synthTargets.add(String(rid));
      else if (/^\d+$/.test(String(rid))) intTargets.add(Number(rid));
    }
    const targetParishes = new Set(
      additive_parish_ids.filter((pid) => typeof pid === "string" && pid !== event.parish_id)
    );
    const [curP, curR, curC] = await Promise.all([
      db.prepare("SELECT parish_id FROM event_parishes WHERE event_id = ?").bind(event.id).all(),
      db.prepare("SELECT replaced_event_id FROM event_replaces WHERE replacing_event_id = ?").bind(event.id).all(),
      db.prepare("SELECT schedule_id, occurrence_date FROM schedule_overrides WHERE combined_into_event_id = ? AND kind = 'combined'").bind(event.id).all()
    ]);
    const currentParishes = (curP.results || []).map((r) => r.parish_id);
    const currentReplaces = (curR.results || []).map((r) => r.replaced_event_id);
    const currentCombined = (curC.results || []).map((r) => `${r.schedule_id}:${r.occurrence_date}`);
    const stmts = [];
    if (approve) {
      stmts.push(db.prepare(
        "UPDATE events SET status='approved', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?"
      ).bind(event.id));
    }
    for (const pid of targetParishes) {
      if (!currentParishes.includes(pid)) {
        stmts.push(db.prepare("INSERT OR IGNORE INTO event_parishes (event_id, parish_id) VALUES (?,?)").bind(event.id, pid));
      }
    }
    for (const pid of currentParishes) {
      if (!targetParishes.has(pid)) {
        stmts.push(db.prepare("DELETE FROM event_parishes WHERE event_id=? AND parish_id=?").bind(event.id, pid));
      }
    }
    for (const rid of intTargets) {
      if (!currentReplaces.includes(rid)) {
        stmts.push(db.prepare("INSERT OR IGNORE INTO event_replaces (replacing_event_id, replaced_event_id) VALUES (?,?)").bind(event.id, rid));
        stmts.push(db.prepare(
          "UPDATE events SET status='replaced', mutation_type='replaced', updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?"
        ).bind(rid));
      }
    }
    for (const rid of currentReplaces) {
      if (!intTargets.has(rid)) {
        stmts.push(db.prepare("DELETE FROM event_replaces WHERE replacing_event_id=? AND replaced_event_id=?").bind(event.id, rid));
        stmts.push(db.prepare(
          `UPDATE events SET status='approved',
             mutation_type = CASE WHEN schedule_id IS NOT NULL THEN 'scheduled' ELSE 'headless' END,
             updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
           WHERE id=? AND mutation_type='replaced'`
        ).bind(rid));
      }
    }
    if (stmts.length) await db.batch(stmts);
    for (const sid of synthTargets) {
      if (!currentCombined.includes(sid)) {
        const p = parseInstanceId(sid);
        await setCombined(db, p.scheduleId, p.date, event.id);
      }
    }
    for (const sid of currentCombined) {
      if (!synthTargets.has(sid)) {
        const p = parseInstanceId(sid);
        await clearCombined(db, p.scheduleId, p.date);
      }
    }
    const [updated, addl, repl] = await Promise.all([
      db.prepare("SELECT * FROM events WHERE id = ?").bind(event.id).first(),
      db.prepare("SELECT parish_id FROM event_parishes WHERE event_id = ?").bind(event.id).all(),
      db.prepare("SELECT replaced_event_id FROM event_replaces WHERE replacing_event_id = ?").bind(event.id).all()
    ]);
    return json({
      ...updated,
      additional_parishes: (addl.results || []).map((r) => r.parish_id),
      replaces: (repl.results || []).map((r) => r.replaced_event_id)
    });
  }));
  router2.post("/api/admin/parishes", guarded(async ({ env, request }) => {
    const b = await readJson(request);
    const { name, jurisdiction, lat, lng } = b;
    if (!name || !jurisdiction || lat == null || lng == null) {
      return json({ error: "name, jurisdiction, lat, and lng are required" }, 400);
    }
    const id = jurisdiction + "-" + name.toLowerCase().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
    if (await env.DB.prepare("SELECT id FROM parishes WHERE id = ?").bind(id).first()) {
      return json({ error: "Parish already exists", id }, 409);
    }
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO parishes (id, name, full_name, jurisdiction, address, lat, lng, timezone,
          website, email, phone, languages, live_url, donation_url, raffle_url, payment_url, gala_url,
          info_source_type, info_source_ref, info_verified_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        id,
        name,
        b.full_name || null,
        jurisdiction,
        b.address || null,
        lat,
        lng,
        b.timezone || "Australia/Sydney",
        b.website || null,
        b.email || null,
        b.phone || null,
        b.languages || '["English"]',
        b.live_url || null,
        b.donation_url || null,
        b.raffle_url || null,
        b.payment_url || null,
        b.gala_url || null,
        b.info_source_type || null,
        b.info_source_ref || null,
        b.info_verified_at || (/* @__PURE__ */ new Date()).toISOString()
      ),
      // A generic inactive rule so the parish shows up in the schedules list.
      env.DB.prepare(
        `INSERT INTO schedules (parish_id, day_of_week, start_time, title, event_type, active)
         VALUES (?, 0, '09:00', 'Divine Liturgy', 'liturgy', 0)`
      ).bind(id)
    ]);
    return json(await env.DB.prepare("SELECT * FROM parishes WHERE id = ?").bind(id).first(), 201);
  }));
  const PARISH_EDITABLE = [
    "name",
    "full_name",
    "jurisdiction",
    "address",
    "website",
    "email",
    "phone",
    "acronym",
    "chant_style",
    "languages",
    "lat",
    "lng",
    "color",
    "live_url",
    "donation_url",
    "raffle_url",
    "payment_url",
    "gala_url",
    "timezone",
    "info_source_type",
    "info_source_ref",
    "info_verified_at"
  ];
  router2.patch("/api/admin/parishes/:id", guarded(async ({ env, params, request }) => {
    const id = params.id;
    if (id === "_unassigned") return json({ error: "Cannot edit sentinel parish" }, 400);
    const parish = await env.DB.prepare("SELECT * FROM parishes WHERE id = ?").bind(id).first();
    if (!parish) return json({ error: "Parish not found" }, 404);
    const b = await readJson(request);
    const sets = [], vals = [];
    for (const k of PARISH_EDITABLE) {
      if (b[k] !== void 0) {
        sets.push(`${k} = ?`);
        vals.push(b[k]);
      }
    }
    if (!sets.length) return json({ error: "No valid fields to update" }, 400);
    await env.DB.prepare(`UPDATE parishes SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, id).run();
    if (b.lat !== void 0 || b.lng !== void 0) await syncEventCoordsForParish(env.DB, id);
    if (b.address && b.lat === void 0) {
      const coords = await geocode(b.address);
      if (coords) {
        await env.DB.prepare("UPDATE parishes SET lat = ?, lng = ? WHERE id = ?").bind(coords.lat, coords.lng, id).run();
        await syncEventCoordsForParish(env.DB, id);
      }
    }
    return json(await env.DB.prepare("SELECT * FROM parishes WHERE id = ?").bind(id).first());
  }));
  router2.delete("/api/admin/parishes/:id", guarded(async ({ env, params, query }) => {
    const id = params.id;
    if (id === "_unassigned") return json({ error: "Cannot delete sentinel parish" }, 400);
    if (!await env.DB.prepare("SELECT id FROM parishes WHERE id = ?").bind(id).first()) {
      return json({ error: "Parish not found" }, 404);
    }
    const transferTo = query.get("transfer_to");
    const deleteEvents = query.get("delete_events") === "1";
    const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE parish_id = ?").bind(id).first();
    if (n > 0 && !transferTo && !deleteEvents) {
      return json({ error: `${n} events reference this parish`, event_count: n }, 400);
    }
    const stmts = [];
    if (transferTo) {
      if (!await env.DB.prepare("SELECT id FROM parishes WHERE id = ?").bind(transferTo).first()) {
        return json({ error: "Transfer target parish not found" }, 400);
      }
      stmts.push(env.DB.prepare("UPDATE events SET parish_id = ? WHERE parish_id = ?").bind(transferTo, id));
      stmts.push(env.DB.prepare("UPDATE schedules SET parish_id = ? WHERE parish_id = ?").bind(transferTo, id));
    } else if (deleteEvents) {
      stmts.push(env.DB.prepare("DELETE FROM events WHERE parish_id = ?").bind(id));
    }
    stmts.push(env.DB.prepare("DELETE FROM schedules WHERE parish_id = ?").bind(id));
    stmts.push(env.DB.prepare("DELETE FROM parishes WHERE id = ?").bind(id));
    await env.DB.batch(stmts);
    return json({ ok: true });
  }));
  router2.get("/api/admin/schedules", guarded(async ({ env }) => {
    const r = await env.DB.prepare(
      `SELECT s.*, p.name AS parish_name, p.jurisdiction AS parish_jurisdiction, p.timezone
       FROM schedules s JOIN parishes p ON s.parish_id = p.id
       ORDER BY s.parish_id, s.day_of_week, s.start_time`
    ).all();
    return json(r.results || []);
  }));
  const VALID_WEEKS = /* @__PURE__ */ new Set(["first", "second", "third", "fourth", "last"]);
  router2.post("/api/admin/schedules", guarded(async ({ env, request }) => {
    const b = await readJson(request);
    const { parish_id, day_of_week, start_time, title } = b;
    if (!parish_id || day_of_week == null || !start_time || !title) {
      return json({ error: "parish_id, day_of_week, start_time, and title are required" }, 400);
    }
    if (b.week_of_month && b.week_of_month.split(",").some((w) => !VALID_WEEKS.has(w.trim()))) {
      return json({ error: "week_of_month values must be: first, second, third, fourth, last" }, 400);
    }
    if (!await env.DB.prepare("SELECT id FROM parishes WHERE id = ?").bind(parish_id).first()) {
      return json({ error: "Invalid parish_id" }, 400);
    }
    const row = await env.DB.prepare(
      `INSERT INTO schedules (parish_id, day_of_week, start_time, end_time, title, event_type,
        languages, week_of_month, hide_live, parish_scoped)
       VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`
    ).bind(
      parish_id,
      day_of_week,
      start_time,
      b.end_time || null,
      title,
      b.event_type || "liturgy",
      b.languages || null,
      b.week_of_month || null,
      b.hide_live ? 1 : 0,
      b.parish_scoped ? 1 : 0
    ).first();
    return json(row, 201);
  }));
  const SCHEDULE_EDITABLE = [
    "day_of_week",
    "start_time",
    "end_time",
    "title",
    "event_type",
    "active",
    "languages",
    "week_of_month",
    "concurrent",
    "hide_live",
    "parish_scoped",
    "effective_from",
    "effective_to"
  ];
  const BOOL_FIELDS = /* @__PURE__ */ new Set(["active", "concurrent", "hide_live", "parish_scoped"]);
  router2.patch("/api/admin/schedules/:id", guarded(async ({ env, params, request }) => {
    if (!await env.DB.prepare("SELECT id FROM schedules WHERE id = ?").bind(params.id).first()) {
      return json({ error: "Schedule not found" }, 404);
    }
    const b = await readJson(request);
    const sets = [], vals = [];
    for (const k of SCHEDULE_EDITABLE) {
      if (b[k] !== void 0) {
        sets.push(`${k} = ?`);
        vals.push(BOOL_FIELDS.has(k) ? b[k] ? 1 : 0 : b[k]);
      }
    }
    if (!sets.length) return json({ error: "No valid fields to update" }, 400);
    await env.DB.prepare(`UPDATE schedules SET ${sets.join(", ")} WHERE id = ?`).bind(...vals, params.id).run();
    return json(await env.DB.prepare("SELECT * FROM schedules WHERE id = ?").bind(params.id).first());
  }));
  router2.delete("/api/admin/schedules/:id", guarded(async ({ env, params }) => {
    if (!await env.DB.prepare("SELECT id FROM schedules WHERE id = ?").bind(params.id).first()) {
      return json({ error: "Schedule not found" }, 404);
    }
    await env.DB.prepare("DELETE FROM schedules WHERE id = ?").bind(params.id).run();
    return json({ ok: true });
  }));
  router2.get("/api/admin/adapters", guarded(async () => json(ADAPTERS.map((a) => ({ id: a.id, parishId: a.parishId, sourceType: a.sourceType, schedule: a.schedule })))));
  router2.post("/api/admin/adapters/:id/run", guarded(async ({ env, params }) => {
    const adapter = getAdapter(params.id);
    if (!adapter) return json({ error: "Adapter not found" }, 404);
    try {
      return json({ status: "success", ...await runAdapter(adapter, env) });
    } catch (err) {
      return json({ status: "failed", error: err.message }, 500);
    }
  }));
}
__name(registerAdminRoutes, "registerAdminRoutes");

// worker/index.mjs
var router = new Router();
registerPublicRoutes(router);
registerAdminRoutes(router);
router.get("/health", async ({ env }) => {
  try {
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM parishes WHERE id != '_unassigned'"
    ).first();
    return json({ status: "ok", parishes: row.n, timestamp: (/* @__PURE__ */ new Date()).toISOString() });
  } catch (err) {
    return json({ status: "error", error: err.message }, 500);
  }
});
var PAY_LINK_COLUMNS = {
  donate: "donation_url",
  raffle: "raffle_url",
  payment: "payment_url",
  gala: "gala_url"
};
var DONATE_JURISDICTIONS = /* @__PURE__ */ new Set([
  "antiochian",
  "greek",
  "serbian",
  "russian",
  "romanian",
  "macedonian"
]);
for (const [kind, column] of Object.entries(PAY_LINK_COLUMNS)) {
  router.get(`/:slug/${kind}`, async ({ env, params }) => {
    const slug = (params.slug || "").toLowerCase().replace(/\s+/g, "");
    if (kind === "donate" && DONATE_JURISDICTIONS.has(slug)) return null;
    const row = await env.DB.prepare(
      `SELECT ${column} AS url FROM parishes
       WHERE id != '_unassigned' AND lower(replace(acronym, ' ', '')) = ?`
    ).bind(slug).first();
    if (row && row.url) return Response.redirect(row.url, 302);
    return null;
  });
}
var worker_default = {
  async fetch(request, env, ctx) {
    try {
      const res = await router.handle(request, env, ctx);
      if (res) return res;
    } catch (err) {
      return json({ error: "Internal error", detail: err.message }, 500);
    }
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/") || path === "/health") {
      return json({ error: "Not found" }, 404);
    }
    return env.ASSETS.fetch(request);
  },
  // Cron Trigger — replaces node-cron's in-process timer.
  //
  // node-cron kept one long-lived process with a timer per adapter; a Cron
  // Trigger invokes this instead. One adapter failing must not stop the others,
  // and the failure is already recorded in adapter_runs by runAdapter.
  async scheduled(event, env, ctx) {
    console.log(`[cron] ${event.cron} at ${new Date(event.scheduledTime).toISOString()}`);
    const results = await Promise.allSettled(
      ADAPTERS.map((a) => runAdapter(a, env))
    );
    results.forEach((r, i) => {
      if (r.status === "rejected") {
        console.error(`[cron] ${ADAPTERS[i].id} failed: ${r.reason?.message || r.reason}`);
      }
    });
  }
};

// node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-H48m2R/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-H48m2R/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=index.js.map
