# Design: Materialize-on-read schedules (`schedule_overrides`, schema v26)

Status: **proposed** — awaiting sign-off before implementation.
Author: design session 2026-06-04 (dev). Revised same day with tombstone / Combined / Temporal refinements.
Supersedes: the nightly `generateEvents()` materialize-on-write model.

---

## 1. Problem

Schedules are recurring rules. Today a nightly cron (`scheduler.js` → `schedule-generator.js::generateEvents`)
**bakes** each rule into concrete `events` rows for the next 10 weeks (`source_hash = schedule-{id}-{date}`).
That makes the generated rows a *second source of truth*, which drifts from the rule that spawned it.

### Root cause of the duplicate bug

`routes/admin.js:384` — editing a schedule calls `generateEvents(10, id)`. The generator inserts rows at
the **new** day/time, but its cleanup (`schedule-generator.js:165–199`) only deletes rows for `week_of_month`
mismatch and `active = 0`. Change `start_time` or `day_of_week` and **neither** cleanup fires → the old-slot
rows orphan → **duplicates**. Second symptom: a hand-edited instance (`mutation_type='adapted'`) is
CASE-guarded against overwrite (`schedule-generator.js:98–103`), so a later schedule edit silently fails to
propagate. One cause: derived data stored as truth.

## 2. Paradigm

Switch to **materialize-on-read** (expand-on-read) — the iCalendar / RFC 5545 model:

- The recurring rule is stored **once** (`schedules` = `RRULE`).
- Instances are **computed at read time**, never stored.
- Per-occurrence changes are small **override** rows keyed by `(schedule_id, occurrence_date)`:
  - `RECURRENCE-ID` → `modified` (feast day: changed time/title/feast).
  - `EXDATE` → `cancelled`.
  - `combined` → our abstraction = suppress-original **+** pointer to the event it folds into.

The day becomes a **lens / pure projection**: `events(window) = applyOverrides(expand(schedules)) ∪ oneOffs`.
The duplicate class of bug cannot exist, because there is no stored derived row to drift.

## 3. Decisions (locked 2026-06-04)

1. **Forward-only, no history.** Feed already filters `start_utc >= now` (`routes/events.js:48`); we expand
   `now → +N weeks` only. Editing a rule never touches the past because the past is never expanded.
   `schedules.effective_from/effective_to` columns are added but left `NULL` as an upgrade hook.
2. **Nothing disappears.** Every `(schedule, date)` in the window emits exactly **one** instance — the
   expander never skips. Overrides only change how that instance *renders*:
   - `modified` → the modified instance (a real, globally-visible event).
   - `cancelled` → a **CANCELLED tombstone**.
   - `combined` → a **"Combined" tombstone** linking to the event it folds into.
3. **Reversibility is inherent.** A cancellation is *one* override row — no attached one-off event.
   Un-cancel = **delete the override row**; the instance recomputes from the rule and reappears. Same for
   un-combining. `audit_log` (v24) records both. (No EXDATE-plus-shadow-event bookkeeping.)
4. **Tombstones are parish-page-only.** Cancelled and Combined tombstones must NOT clutter the open feed or
   map; they appear only when the user is scoped to that single parish. **This is already implemented** at
   `public/app.js:2240-2243` for `cancelled`; v26 just widens that filter to include `combined`. The map
   inherits it (`map.js:644` builds dots from `applyFilters(state.events)`).
5. **"Combined" is the only word.** Internal `kind='combined'`, column `combined_into_event_id`, UI label
   "Combined". "absorb" / "replace" retired. (`badge-combined` / `event_parishes` already say COMBINED.)
6. **Combined target = a one-off `events` row** (the deanery/feast liturgy), at the host parish or anywhere.
   *Every* merged slot — including the host's own slot — tombstones into it. Keeps the FK clean (schedule
   instances have no `events` row) and reuses `event_parishes` for which parishes it spans.
7. **Temporal for time math** (see §9). **Design doc first**, implement after sign-off.

## 4. Schema — migration v26

Current `user_version` = 25 (donation feature). This is **26**.

```sql
-- v26: materialize-on-read — schedule_overrides replaces stored schedule events
CREATE TABLE schedule_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schedule_id      INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  occurrence_date  TEXT NOT NULL,          -- 'YYYY-MM-DD', the Sydney-local date the RULE produced (join key)
  kind             TEXT NOT NULL CHECK(kind IN ('modified','cancelled','combined')),

  -- RECURRENCE-ID patch (kind='modified'); NULL column = inherit from schedule
  patch_title             TEXT,
  patch_start_time        TEXT,            -- 'HH:MM' Sydney local
  patch_end_time          TEXT,
  patch_event_type        TEXT,
  patch_languages         TEXT,
  patch_feast             TEXT,            -- NEW field, surfaced only on the day
  patch_description       TEXT,
  patch_location_override TEXT,
  patch_hide_live         INTEGER,
  patch_parish_scoped     INTEGER,

  -- combine (kind='combined'): the one-off event this slot folds into (any parish)
  combined_into_event_id  INTEGER REFERENCES events(id) ON DELETE CASCADE,

  note           TEXT,
  source_run_id  INTEGER REFERENCES adapter_runs(id),   -- provenance (WhatsApp ingestor)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(schedule_id, occurrence_date)
);
CREATE INDEX idx_overrides_schedule ON schedule_overrides(schedule_id);
CREATE INDEX idx_overrides_combined ON schedule_overrides(combined_into_event_id);

-- upgrade hook for historical accuracy (NULL = open-ended; unused in v26)
ALTER TABLE schedules ADD COLUMN effective_from TEXT;
ALTER TABLE schedules ADD COLUMN effective_to   TEXT;
```

Mapping from existing mechanisms:

| Today | Becomes |
|-------|---------|
| `events.mutation_type='adapted'` (admin edited instance) | override `kind='modified'` + patch columns |
| escalate / `event_replaces` | override `kind='combined'`, `combined_into_event_id` → combining event |
| `event_parishes` (Combined) | **unchanged** — stays on the combining one-off event |
| WhatsApp cancellation / `pending_cancellations` | override `kind='cancelled'` |
| `events.schedule_id`, `events.mutation_type`, `event_replaces` | dead after backfill; keep 1 release for rollback, drop in v27 |

## 5. The expand core (the "lens")

New `schedule-expand.js`. Reuses `matchesWeekOfMonth` / `weekOfMonthLabel`; `localToUtc` is reimplemented on
Temporal (§9). The write half of `schedule-generator.js` is then deleted.

```js
function expandWindow(db, fromUtc, toUtc, { scheduleId = null } = {}) {
  const schedules = db.prepare(`
    SELECT s.*, p.lat, p.lng, p.name AS parish_name /* …other parish cols the GET / query joins… */
    FROM schedules s JOIN parishes p ON s.parish_id = p.id
    WHERE s.active = 1 ${scheduleId ? 'AND s.id = ?' : ''}
      AND (s.effective_from IS NULL OR s.effective_from <= ?)   -- always-true while NULL
      AND (s.effective_to   IS NULL OR s.effective_to   >= ?)
  `).all(...(scheduleId ? [scheduleId] : []), toUtc.slice(0,10), fromUtc.slice(0,10));

  const ov = {};   // one cheap query, keyed `${schedule_id}:${date}`
  for (const r of db.prepare(`SELECT * FROM schedule_overrides`).all())
    ov[`${r.schedule_id}:${r.occurrence_date}`] = r;

  const out = [];
  for (const s of schedules) {
    for (const date of datesInWindow(s.day_of_week, fromUtc, toUtc)) {
      if (!matchesWeekOfMonth(date, s.week_of_month)) continue;   // rule says no occurrence — not an override
      out.push(project(s, date, ov[`${s.id}:${date}`]));          // NEVER skips on override
    }
  }
  return out;
}

function project(s, date, o) {
  const startTime = o?.patch_start_time || s.start_time;
  const endTime   = o?.patch_end_time   ?? s.end_time;
  const kind = o?.kind || null;
  const isTombstone = kind === 'cancelled' || kind === 'combined';
  return {
    id: `${s.id}:${date}`,                          // stable synthetic id (= the service_key TODO)
    parish_id: s.parish_id,
    schedule_id: s.id,
    source_adapter: 'schedule',
    title: o?.patch_title || s.title,
    feast: o?.patch_feast || null,
    start_utc: localToUtc(date, startTime),         // Temporal-backed (§9)
    end_utc: endTime ? localToUtc(date, endTime) : null,
    event_type: o?.patch_event_type || s.event_type,
    languages: o?.patch_languages ?? s.languages,
    hide_live: o?.patch_hide_live ?? s.hide_live,
    parish_scoped: o?.patch_parish_scoped ?? s.parish_scoped,
    mutation_type: kind === 'modified' ? 'adapted' : 'scheduled',
    // status drives the existing parish-only tombstone filter (app.js:2240):
    status: kind === 'cancelled' ? 'cancelled'
          : kind === 'combined'  ? 'combined'
          : 'approved',
    is_tombstone: isTombstone,
    combined_into_event_id: o?.combined_into_event_id || null,
    lat: s.lat, lng: s.lng,
    // …parish_name / jurisdiction / parish_color / etc the current query joins…
  };
}
```

`datesInWindow(dow, from, to)` is a day-of-week walk over the window (lift `schedule-generator.js:123–134`).

## 6. Read / write surfaces (the 5-surface propagation rule)

| Surface | Change |
|---|---|
| `routes/events.js GET /` | replace stored-rows query with `expandWindow()` **∪** one-off events; keep distance/sort, `extra_parishes`, and the cross-source dedup (§7) |
| `routes/events.js GET /:id` | id contains `:` → expand that single occurrence; else integer → one-off lookup |
| `routes/admin.js POST/PATCH/DELETE /schedules` | **delete the `generateEvents()` calls** (this alone fixes the dup bug); DELETE cascades overrides |
| `routes/admin.js PATCH /events/:id` | target `"sid:date"` → upsert `kind='modified'` override; **Cancel** → upsert `kind='cancelled'`; **Uncancel** → DELETE the override; plain integer (one-off) unchanged |
| `routes/admin.js escalate` | write `kind='combined'` override + ensure combining event is a one-off with `event_parishes` |
| WhatsApp ingestor (`adapters/whatsapp-poster.js`, `routes/webhook.js`) | `parish_updates`/`event_updates`/cancellation intents → override writes (additive-not-destructive) |
| `scheduler.js` | delete the nightly `generateEvents` cron — nothing to generate |
| `public/app.js` | (a) widen `app.js:2240` `scoped` test to `cancelled || combined` (or `e.is_tombstone`); (b) add a "Combined → {event}" tombstone badge beside the existing CANCELLED badge; (c) `id` may contain `:`; (d) render `feast` |

## 7. What does NOT change: cross-source dedup

The `ROW_NUMBER() OVER (PARTITION BY parish||start||title …)` block (`routes/events.js:20–30`) is **kept** — two
*different sources* can still collide on the same slot: a generic-weekly schedule and a `week_of_month='first'`
schedule both firing on the 1st Sunday; or an adapter one-off (gcal) duplicating a schedule instance. The lens
eliminates *intra-schedule stored-row orphaning* (the dup bug), not read-time collision resolution. (Folding
week-variants into overrides is a possible future simplification; out of scope.)

## 8. Backfill (the one fiddly part — run on dev first)

Per migration-discipline, run against nightly-refreshed dev and eyeball results before prod. For each `events`
row with `source_adapter='schedule'`:

1. `mutation_type='scheduled'` → **delete** (re-expanded on read).
2. `mutation_type='adapted'` → `kind='modified'` override; `occurrence_date = date(start_utc)` in Sydney-local
   (best-effort); set each `patch_*` only where the event value differs from the rule's base projection; delete row.
3. `mutation_type='replaced'` (suppressed base; `status='replaced'`) → for each `event_replaces` row whose
   `replaced_event_id` has a `schedule_id`: create `kind='combined'` override on `(schedule_id, date)` with
   `combined_into_event_id = replacing_event_id`; strip `schedule_id` from the replacing event so it persists as a
   one-off; delete the replaced base row.
4. `mutation_type='headless'` → already a standalone one-off; **keep**.
5. Delete remaining `source_adapter='schedule'` rows.

**Caveat:** an `adapted` event shifted to a *different day* has an ambiguous original `occurrence_date`; backfill
uses `date(start_utc)` and logs these for manual review (expected ~0).

## 9. Temporal (time-math correctness)

Replace hand-rolled DST math — `schedule-generator.js:8-37` (`sydneyOffset`) and the two client window
calculations (`public/app.js:~839`, `~4004`) — with the Temporal API. **Display stays on
`Intl.DateTimeFormat({ timeZone: 'Australia/Sydney' })`** (already robust); Temporal is scoped to *arithmetic*
only.

```js
// backend localToUtc replacement
const { Temporal } = require('@js-temporal/polyfill');
function localToUtc(dateStr, timeStr) {                 // 'YYYY-MM-DD', 'HH:MM'
  return Temporal.PlainDateTime.from(`${dateStr}T${timeStr}`)
    .toZonedDateTime('Australia/Sydney')
    .toInstant().toString();                            // UTC ISO, DST handled by IANA db
}
```

Availability: Safari and Node lack **stable native** Temporal as of 2026 → `@js-temporal/polyfill` required
(backend dependency; vendor the browser build into `public/vendor/` for the no-build frontend, ~200KB).

**Frontend (decided 2026-06-04): server-side window, no client polyfill.** Move the two client window
calcs (`app.js:~839`, `~4004`) into the backend — the API computes the default `from`/`to` from Sydney
"today" using Temporal, and the client stops sending those params. No `@js-temporal/polyfill` on the
frontend; the no-build vanilla bundle stays lean. Backend is the only place Temporal runs. (Client keeps
`Intl.DateTimeFormat` for display, and `isoDateSyd`/`setDateFocus` continue to pass explicit dates when the
user picks a specific day.)

## 10. Performance / caching

Expanding ~hundreds of schedules × N weeks is a few thousand JS iterations per request — sub-ms to low-ms in
better-sqlite3. Existing `Cache-Control: max-age=60` stays. If ever needed: memoize keyed by
`(window, max(schedules.updated_at, overrides.updated_at))`, invalidated on any rule/override write. The cache
may exist but is **never** the source of truth and **never** hand-edited. Premature for now.

## 11. Rollout / rollback

1. Ship v26 migration + `schedule-expand.js` + Temporal + read-path swap + backfill on **dev**; verify the feed
   matches prod for sample parishes (feast `modified`, a `cancelled` tombstone, a `combined` deanery event).
2. Then write-path rewrites (admin override upserts, cancel/uncancel, escalate→combined, WhatsApp).
3. Keep `events.schedule_id` / `mutation_type` / `event_replaces` one release for rollback; drop in **v27**.
4. Delete the nightly cron last.

## 12. Open questions

- Should a `combined` tombstone deep-link to its combining event ("Combined → Deanery Liturgy at St X")? (Lean yes.)
- Expose `feast` in `/api/schedules` too, or only on expanded instances?
- Fold week-of-month variants into overrides (one rule + overrides) vs keep as separate schedules? (Deferred.)
