// Adapters — the scrape path. Ported from adapters/base.js and
// adapters/google-calendar.js.
//
// CHANGES FROM THE EXPRESS VERSION:
//   1. Static registry. adapters/registry.js discovered modules with
//      fs.readdirSync, which cannot work in Workers. Two adapters, listed here.
//   2. WebCrypto instead of node:crypto for source_hash.
//   3. env instead of process.env for the API key.
//   4. `confidence` is gone from the upsert — the column no longer exists.
//   5. THE COUNTERS ARE FIXED. events_updated was declared, passed to the
//      UPDATE and never incremented, so it was always 0; events_created counted
//      ON CONFLICT updates too, so "created" really meant "touched". With
//      scraping as the primary ingestion path these numbers are the health
//      signal, so they now mean what they say: existing source_hashes are
//      looked up first and the two are counted separately.

import { readSecret } from './secrets.mjs';
import { expandFrom } from '../../public/shared/project.mjs';
import { reconcile, coveredLocalDates } from './reconcile.mjs';
import { decideTombstones, adapterSource } from './tombstone.mjs';
import { questionsFor, resolvePairing, overrideFor, suggestionFor, occurrenceKey } from './pairing.mjs';
import { answersFor } from './pairing-read.mjs';
import { parseSchedulePdfText } from './pdf-schedule.mjs';
import { PDF_SOURCES, r2KeyFor } from './pdf-sources.mjs';
import { OffsetCache, localPartsOf } from '../../public/shared/tz.mjs';

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Google says 403 for at least three unrelated things, and the reason is only
// ever in the body:
//
//   ipRefererBlocked     the API key is restricted to HTTP referrers, and a
//                        Worker sends none — restrict by API instead
//   accessNotConfigured  the Calendar API is not enabled on the project
//   forbidden            the calendar is not shared publicly, so an API key
//                        (as opposed to OAuth) cannot read it
//
// Same status, same message without this, and three different places to go.
// adapter_runs is the only record of a scrape, so what lands there has to be
// enough to act on.
async function googleError(res, apiKey) {
  // Read the body ONCE. res.json() consumes it, so a res.text() fallback after
  // a parse failure gets nothing — which is exactly the case this exists for.
  const raw = await res.text().catch(() => '');
  let detail;
  try {
    const e = JSON.parse(raw)?.error;
    const reason = e?.errors?.[0]?.reason;
    detail = [e?.message, reason && `(${reason})`].filter(Boolean).join(' ');
  } catch {
    detail = raw.slice(0, 200);
  }
  // The key travels in a header, not the URL, so Google has no URL of ours to
  // echo it in. Redacted anyway: adapter_runs is served unauthenticated at
  // /api/adapters/status, and a key that reached it would be published.
  if (apiKey) detail = detail.split(apiKey).join('<redacted>');
  return `Google Calendar API error: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`;
}

class GoogleCalendarAdapter {
  constructor({ parishId, calendarId, schedule }) {
    this.id = `gcal-${parishId}`;
    this.parishId = parishId;
    this.calendarId = calendarId;
    this.sourceType = 'google-calendar';
    this.schedule = schedule || '0 */4 * * *';
  }

  // What a RULE inferred from this adapter's events should cite.
  //
  // Not an event's own `source_url`: that is a deep link to one occurrence, and
  // a rule is inferred from dozens of them, so citing the first would point a
  // reader at an arbitrary Sunday rather than at the calendar that says it
  // happens every Sunday. The human-facing calendar page, not the API endpoint,
  // because the ref is meant to be opened.
  get sourceName() { return 'Parish calendar'; }

  get sourceUrl() {
    return `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(this.calendarId)}`;
  }

  async fetchEvents(env) {
    const apiKey = await readSecret(env.GOOGLE_API_KEY);
    if (!apiKey) throw new Error('GOOGLE_API_KEY not set');

    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events`
    );
    // Reported alongside the events, because absence only means anything
    // inside the range actually asked for. A PDF adapter reports whatever
    // month its table covers; the shape is the same.
    const window = {
      from: new Date().toISOString(),
      to: new Date(Date.now() + 90 * 86400000).toISOString(),
    };
    url.searchParams.set('timeMin', window.from);
    url.searchParams.set('timeMax', window.to);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '100');

    // X-Goog-Api-Key, the way the Places search sends it, rather than ?key=.
    // A URL is what logs, traces and error messages record; a header is not.
    const res = await fetch(url.toString(), { headers: { 'X-Goog-Api-Key': apiKey } });
    if (!res.ok) throw new Error(await googleError(res, apiKey));
    const data = await res.json();

    const events = await Promise.all((data.items || []).map(async (item) => {
      const start = item.start?.dateTime || item.start?.date;
      const end = item.end?.dateTime || item.end?.date;
      const title = item.summary || 'Untitled Event';
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
        parish_scoped: isParishScoped(title) ? 1 : 0,
      };
    }));

    return { events, window };
  }
}

// A parish that publishes a PDF instead of a calendar.
//
// The PDF is never opened here. A GitHub Action fetches it, runs it through
// poppler and leaves the text in R2 as JSON; this reads that document and hands
// the text to the pure parser. See scripts/extract-parish-pdf.mjs for why the
// split is where it is — in short, one of the surveyed files is a photograph of
// a piece of paper, and nothing a Worker can do reaches it.
//
// One instance per entry in PDF_SOURCES, so each parish keeps its own source
// URL, publishing cadence and layout quirks rather than sharing a guess.
class ParishPdfAdapter {
  constructor(source) {
    this.id = `pdf-${source.key}`;
    this.parishId = source.parishId;
    this.sourceType = 'parish-pdf';
    this.source = source;
    // Informational, like every other adapter's: pacing is adapter_settings'
    // job. Worth pacing slowly from /admin — the Worker is reading an R2 object
    // that only changes when the Action runs, and the Action is what actually
    // touches the parish's website.
    this.schedule = '0 */12 * * *';
  }

  // The parish's own PDF, which is what a rule inferred from it should cite —
  // pdf-sources.mjs already remembers the URL for the fetching half.
  get sourceName() { return 'Parish schedule (PDF)'; }

  get sourceUrl() { return this.source.sourceUrl || null; }

  async fetchEvents(env) {
    const key = r2KeyFor(this.source.key);
    if (!env.ASSETS_BUCKET) throw new Error('ASSETS_BUCKET is not bound; cannot read extracted PDF text');

    const object = await env.ASSETS_BUCKET.get(key);
    if (!object) {
      throw new Error(
        `No extracted text at ${key}. Run the "Extract parish PDFs" GitHub Action ` +
        `(.github/workflows/parish-pdf.yml) — the Worker cannot read the PDF itself.`
      );
    }
    const doc = await object.json();
    const parsed = parseSchedulePdfText(doc.text, this.source.parse || {});

    // A layout the parser will not guess at. Fail loudly: this lands in
    // adapter_runs.error_message, which is the only record anyone sees, and a
    // parish that has changed their layout needs a person, not a retry.
    if (parsed.refused) {
      throw new Error(
        `${doc.source_url || this.source.sourceUrl} is a ${parsed.refused.reason} ` +
        `(${parsed.refused.detail}), which this parser does not read. See docs/adapters.md.`
      );
    }

    // parishes.timezone is what makes a wall clock an instant. Falling back to
    // the source's own declaration keeps the error that matters — "that parish
    // is not in the database" — coming from runAdapter, which says it properly.
    const parish = await env.DB.prepare('SELECT timezone FROM parishes WHERE id = ?')
      .bind(this.parishId).first();
    const timezone = parish?.timezone || this.source.timezone || 'Australia/Sydney';

    const events = [];
    const seen = new Map();
    const cache = new OffsetCache();

    for (const o of parsed.occurrences) {
      // Identity is date + start time, NOT the title. Parishes decorate titles
      // on the day — "Divine Liturgy" becomes "Divine Liturgy, Sunday of the
      // Prodigal Son" — and reconcile.mjs already reasons this way. Hashing the
      // title would file every decorated liturgy as a brand new event and leave
      // the old one behind as a duplicate card.
      const identity = `${this.source.key}|${o.date}|${o.start}`;
      const n = (seen.get(identity) || 0) + 1;
      seen.set(identity, n);

      events.push({
        title: o.title,
        description: null,
        start_utc: cache.toUtcISO(timezone, o.date, o.start),
        end_utc: o.end ? cache.toUtcISO(timezone, endDateOf(o), o.end) : null,
        event_type: guessEventType(o.title),
        source_url: doc.source_url || this.source.sourceUrl,
        source_hash: await sha256Hex(n === 1 ? identity : `${identity}#${n}`),
        location_override: o.location || null,
        hide_live: shouldHideLive(o.title) ? 1 : 0,
        parish_scoped: isParishScoped(o.title) ? 1 : 0,
      });
    }

    // No coverage means nothing was read, and a window claimed over text we did
    // not understand would tombstone every service in it. Report the events —
    // there are none — and no window, which costs this adapter its tombstoning
    // and is exactly the trade docs/adapters.md describes.
    if (!parsed.coverage) {
      console.warn(`[${this.id}] no dates parsed from ${key}; reporting no window`);
      return { events };
    }

    // Local midnight at both ends, and the END is the midnight AFTER the last
    // covered day: coveredLocalDates() rounds inward, dropping the day a range
    // stops inside, so naming the last day itself would silently give up on it.
    return {
      events,
      window: {
        from: cache.toUtcISO(timezone, parsed.coverage.from, '00:00'),
        to: cache.toUtcISO(timezone, addLocalDay(parsed.coverage.to), '00:00'),
      },
    };
  }
}

// A service that ends earlier than it starts has run past midnight — the
// paschal vigil is 11pm to 2.30am. Without this its end lands twenty and a half
// hours before its start and the card renders as a negative-length service.
function endDateOf(o) {
  return o.end && o.end < o.start ? addLocalDay(o.date) : o.date;
}

const addLocalDay = (date) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);

// Services never livestreamed at any parish.
const shouldHideLive = (t) => /confession|setup|prayer ministry|retreat|camp/i.test(t);
// Operational entries that should only surface when filtered to the parish.
const isParishScoped = (t) => /^\s*(setup|cleaning|confession)\s*$/i.test(t);

function guessEventType(title) {
  const t = title.toLowerCase();
  if (/liturgy|θεία λειτουργία/.test(t)) return 'liturgy';
  if (/vespers|εσπερινός|matins|orthros|compline|bridegroom|holy unction|lamentations|passion gospels/.test(t)) return 'prayer';
  if (/feast|nameday/.test(t)) return 'feast';
  if (/youth|young|teens/.test(t)) return 'youth';
  if (/talk|lecture|class|study/.test(t)) return 'talk';
  if (/festival|paniyiri|fete|fundrais|dinner|gala|charity/.test(t)) return 'social';
  return 'other';
}

// The registry. Replaces fs.readdirSync discovery — add a parish by adding a line.
export const ADAPTERS = [
  new GoogleCalendarAdapter({
    parishId: 'antiochian-good-shepherd-antiochian-church',
    // Verbatim from the VM's adapters/gcal-good-shepherd-clayton.js (6e57231),
    // which is the only place this value has ever been known to work. The port
    // replaced it with goodshepherdclayton@gmail.com — a plausible-looking
    // address that is not a published calendar, so Google answered 404, which
    // is what it returns for a calendar an API key cannot see rather than
    // admitting one exists. Do not "tidy" this into something more readable.
    calendarId: 'australianorthodox.org.au_q9qd8e01360qb3210pkb0ql160@group.calendar.google.com',
  }),

  // One per parish that publishes a PDF. The list of parishes is data, in
  // pdf-sources.mjs, because the same list drives the GitHub Action that does
  // the extraction — adding a parish there adds both halves at once.
  ...PDF_SOURCES.map(source => new ParishPdfAdapter(source)),
];

export const getAdapter = (id) => ADAPTERS.find(a => a.id === id) || null;

export const DEFAULT_INTERVAL_MINUTES = 240;

/**
 * Should this adapter run on this tick?
 *
 * PURE, so the pacing rule is testable without a clock or a database.
 *
 * A missing settings row means enabled at the default interval: adding an
 * adapter needs no accompanying row, and forgetting one cannot quietly disable
 * a scrape. Absence should never be the thing that stops work happening.
 *
 * Paced from the last SUCCESS, not the last attempt. A failing adapter that
 * reset the clock on every attempt would wait out its whole interval before
 * retrying, which is backwards — a broken scrape is the one you want to retry
 * soonest.
 */
export function isDue(setting, lastSuccessAtIso, nowMs) {
  if (setting && setting.enabled === 0) return { due: false, why: 'disabled' };
  const interval = (setting && setting.interval_minutes) || DEFAULT_INTERVAL_MINUTES;
  if (!lastSuccessAtIso) return { due: true, why: 'never-run' };
  const since = (nowMs - Date.parse(lastSuccessAtIso)) / 60000;
  if (Number.isNaN(since)) return { due: true, why: 'never-run' };
  return since >= interval
    ? { due: true, why: 'due' }
    : { due: false, why: `next in ${Math.ceil(interval - since)}m` };
}

/** Settings and last success for every adapter, in two queries rather than 2N. */
export async function adapterPacing(db) {
  const [{ results: settings = [] }, { results: last = [] }] = await Promise.all([
    db.prepare('SELECT adapter_id, enabled, interval_minutes FROM adapter_settings').all(),
    db.prepare(
      `SELECT adapter_id, MAX(finished_at) AS last_success FROM adapter_runs
       WHERE status = 'success' GROUP BY adapter_id`
    ).all(),
  ]);
  const byId = new Map(settings.map(r => [r.adapter_id, r]));
  const lastById = new Map(last.map(r => [r.adapter_id, r.last_success]));
  return { setting: (id) => byId.get(id) || null, lastSuccess: (id) => lastById.get(id) || null };
}

// Adapters whose parish is not in the seed yet, and so cannot run.
//
// Every adapter names a parish, and events.parish_id is a foreign key, so an
// adapter whose parish does not exist fails on its first write. The old
// production database had this parish — it was created through the admin panel,
// not the seed — and that database was not recovered. Nothing in the repo can
// recreate the row, because a parish needs a street address and coordinates
// that have to be confirmed against the parish rather than guessed: the
// archdiocese lists Good Shepherd as a mission at the Monash University
// Religious Centre in Clayton, while other listings put it at Canterbury, and
// putting the wrong pin on a map sends someone to the wrong building.
//
// Listing it here keeps the gap visible and keeps the registry honest: the
// test asserts that every OTHER adapter's parish is seeded, so a new adapter
// cannot drift in unnoticed. Delete the entry once the parish is seeded.
export const PENDING_PARISHES = new Map([
  // Empty, and a test keeps it honest: an entry here whose parish IS seeded
  // fails, so a stale line cannot sit disabling a working adapter forever.
]);

/**
 * Everything a run writes besides its one-off events, worked out before any of
 * it is written.
 *
 * Two questions, both answered against the parish's rules:
 *
 * WHAT EACH ENTRY IS (pairing.mjs). An entry that is an occurrence of a rule
 * lands on it — nothing written when it says what the rule says, else an
 * override of ours with what it changes — and only the rest are events. Good
 * Shepherd's calendar lists every Sunday's Liturgy; written beside the rule,
 * each Sunday was two cards.
 *
 * WHAT THE SOURCE STOPPED PUBLISHING (reconcile.mjs, tombstone.mjs). Absence is
 * a dangerous signal, so the policy that reads it lives in tombstone.mjs where
 * every guard is visible at once, and this only fetches what it needs and
 * carries out what it decides.
 *
 * A person's overrides are part of what the rules say — a Sunday somebody
 * moved to 9:30 is at 9:30, and their word on it stands. Our own are not:
 * feeding them back in would make an override, or a tombstone, self-justifying.
 */
async function planRun(db, env, adapter, events, window) {
  const pass = { oneOffs: events, consumed: [], statements: [], unsure: [], paired: 0, asked: 0,
    tomb: { windowFrom: null, windowTo: null, created: 0, withdrawn: 0, refused: null } };
  // A source that cannot say what range it covered is still a valid source; it
  // just gets neither pairing nor tombstoning, and every entry is an event.
  if (!window) return pass;

  const parish = await db.prepare('SELECT timezone FROM parishes WHERE id = ?')
    .bind(adapter.parishId).first();
  const timezone = parish?.timezone || 'Australia/Sydney';
  // Only whole local days the source actually covered — see coveredLocalDates.
  const covered = coveredLocalDates(timezone, window.from, window.to);
  pass.tomb.windowFrom = covered?.windowFrom ?? null;
  pass.tomb.windowTo = covered?.windowTo ?? null;

  const { results: schedules = [] } = await db.prepare(
    `SELECT s.*, p.timezone AS p_timezone, p.lat AS p_lat, p.lng AS p_lng
     FROM schedules s JOIN parishes p ON s.parish_id = p.id
     WHERE s.parish_id = ? AND s.active = 1`
  ).bind(adapter.parishId).all();
  if (!schedules.length) return pass;   // no timetable: every entry is an event, nothing to cancel

  const ids = schedules.map(s => s.id);
  const fromDate = localPartsOf(timezone, Date.parse(window.from)).date;
  const toDate = localPartsOf(timezone, Date.parse(window.to)).date;
  const { results: onFile = [] } = await db.prepare(
    `SELECT * FROM schedule_overrides
     WHERE occurrence_date BETWEEN ? AND ?
       AND schedule_id IN (${ids.map(() => '?').join(',')})`
  ).bind(fromDate, toDate, ...ids).all();

  const source = adapterSource(adapter.id);
  const keyOf = (r) => `${r.schedule_id}:${r.occurrence_date}`;
  const theirs = onFile.filter(r => r.source !== source);
  const ours = new Map(onFile.filter(r => r.source === source).map(r => [keyOf(r), r]));
  const spoken = new Set(theirs.map(keyOf));

  const projected = expandFrom({ schedules, overrides: theirs }, window.from, window.to);
  const diff = reconcile({ projected, scraped: events, timezone,
    windowFrom: covered?.windowFrom, windowTo: covered?.windowTo });

  const questions = questionsFor({ diff, timezone, spoken });
  const { answers, fresh, asked } = await answersFor(questions, {
    db, adapterId: adapter.id,
    apiKey: await readSecret(env.ANTHROPIC_API_KEY), baseUrl: env.ANTHROPIC_BASE_URL,
  });
  const plan = resolvePairing({ diff, questions, answers, spoken });

  const stmts = [];
  const same = (a, b) => ['patch_title', 'patch_start_time', 'patch_end_time', 'patch_event_type', 'patch_feast', 'note']
    .every(f => (a[f] ?? null) === (b[f] ?? null)) && a.kind === 'modified';

  // Each pair: the override it needs, written only if it differs from ours;
  // or, when the entry says what the rule says, none — and a tombstone of
  // ours on a service the source is publishing again goes too.
  const paired = new Set();
  for (const p of plan.pairs) {
    const key = occurrenceKey(p.instance);
    paired.add(key);
    if (spoken.has(key)) continue;   // a person's word stands
    const o = overrideFor(p, timezone, guessEventType);
    const mine = ours.get(key);
    if (o && !(mine && same(mine, o))) {
      stmts.push(db.prepare(
        `INSERT INTO schedule_overrides (schedule_id, occurrence_date, kind, patch_title, patch_start_time,
           patch_end_time, patch_event_type, patch_feast, note, source)
         VALUES (?,?,'modified',?,?,?,?,?,?,?)
         ON CONFLICT(schedule_id, occurrence_date) DO UPDATE SET
           kind='modified', patch_title=excluded.patch_title, patch_start_time=excluded.patch_start_time,
           patch_end_time=excluded.patch_end_time, patch_event_type=excluded.patch_event_type,
           patch_feast=excluded.patch_feast, note=excluded.note,
           updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
         WHERE schedule_overrides.source = excluded.source`
      ).bind(o.schedule_id, o.occurrence_date, o.patch_title, o.patch_start_time, o.patch_end_time,
        o.patch_event_type, o.patch_feast, o.note, source));
    } else if (!o && mine) {
      stmts.push(db.prepare(
        `DELETE FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?
           AND source = ? AND kind IN ('modified','cancelled')`
      ).bind(mine.schedule_id, mine.occurrence_date, source));
    }
  }

  // A change of ours to an occurrence the source no longer lists is stale:
  // inside the window, and not held back by an unsure answer.
  const withheld = new Set(plan.withheld.map(occurrenceKey));
  const stale = covered ? [...ours.values()].filter(r => r.kind === 'modified'
    && !paired.has(keyOf(r)) && !withheld.has(keyOf(r))
    && r.occurrence_date >= covered.windowFrom && r.occurrence_date <= covered.windowTo) : [];
  const staleKeys = new Set(stale.map(keyOf));

  let tomb = pass.tomb;
  if (covered) {
    const decision = decideTombstones({
      diff: { matched: plan.pairs.map(p => ({ instance: p.instance })), moved: [], missing: plan.missing },
      projectedCount: projected.length, scrapedCount: events.length,
      // Our stale changes are going; the occurrence is then nobody's, and absence may speak.
      existing: onFile.filter(r => !(r.source === source && staleKeys.has(keyOf(r)))),
      adapterId: adapter.id,
    });
    if (decision.refused) {
      // A run that looks broken changes nothing it would have to be right
      // about absence to change.
      console.warn(`[${adapter.id}] tombstones refused: ${decision.refused.detail}`);
      tomb = { ...tomb, refused: decision.refused };
    } else {
      for (const r of stale) {
        stmts.push(db.prepare(
          `DELETE FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?
             AND source = ? AND kind = 'modified'`
        ).bind(r.schedule_id, r.occurrence_date, source));
      }
      // Scoped to our own rows twice over — by source and by kind — so a
      // person's cancellation can never be undone by a scrape that disagrees.
      for (const w of decision.withdraw) {
        stmts.push(db.prepare(
          `DELETE FROM schedule_overrides WHERE schedule_id = ? AND occurrence_date = ?
             AND source = ? AND kind = 'cancelled'`
        ).bind(w.schedule_id, w.occurrence_date, source));
      }
      for (const c of decision.create) {
        stmts.push(db.prepare(
          `INSERT INTO schedule_overrides (schedule_id, occurrence_date, kind, note, source)
           VALUES (?,?,'cancelled',?,?)`
        ).bind(c.schedule_id, c.occurrence_date, c.note, source));
      }
      tomb = { ...tomb, created: decision.create.length, withdrawn: decision.withdraw.length };
    }
  }

  return {
    oneOffs: plan.oneOffs,
    consumed: plan.pairs.map(p => p.event.source_hash).filter(Boolean),
    statements: stmts,
    // Passed on once: an answer remembered from an earlier run already was.
    unsure: plan.unsure.filter(u => fresh.has(u.question.text)),
    paired: plan.pairs.length,
    asked,
    tomb,
  };
}

/** "Parish calendar" → "The parish calendar", for a suggestion's first words. */
const sourcePhrase = (adapter) =>
  `The ${String(adapter.sourceName || 'source').replace(/\s*\(.*\)\s*$/, '').toLowerCase()}`;

/**
 * Run one adapter: fetch, pair with the timetable, write, log the run.
 * Returns the run's counters.
 */
export async function runAdapter(adapter, env) {
  const db = env.DB;
  const started = await db.prepare(
    "INSERT INTO adapter_runs (adapter_id, status) VALUES (?, 'running') RETURNING id"
  ).bind(adapter.id).first();
  const runId = started.id;

  try {
    // An adapter returns either a bare array or { events, window }. The window
    // is what makes absence mean anything, so it is worth having — but an
    // adapter that cannot say what range it covered is still a valid adapter;
    // it just gets no tombstoning.
    const fetched = await adapter.fetchEvents(env);
    const events = Array.isArray(fetched) ? fetched : (fetched.events || []);
    const window = Array.isArray(fetched) ? null : (fetched.window || null);
    const eventsFound = events.length;

    // The adapter names its parish; the parish must already exist. Without this
    // the first write dies on `FOREIGN KEY constraint failed`, which lands in
    // adapter_runs.error_message and says nothing about which parish is missing
    // or that the seed is the thing to fix. adapter_runs is the only visibility
    // into scraping, so the message it stores has to be worth reading.
    const parish = await db.prepare('SELECT lat, lng, read_from FROM parishes WHERE id = ?')
      .bind(adapter.parishId).first();
    if (!parish) {
      throw new Error(
        `${adapter.id} targets parish '${adapter.parishId}', which is not in the database. ` +
        'Add it (seeds/parishes.js, then `npm run gen:seed` and `npm run db:seed`) before this adapter can run.'
      );
    }
    // An adapter reads the parish's own website, PDF or calendar — a
    // 'website' import (public/shared/read-from.js). A parish kept by hand is
    // not read at all; one still on its directory is taken over, the same as
    // the Greek site reader does.
    if (parish.read_from === 'hand') {
      throw new Error(`${adapter.parishId} is kept by hand, so ${adapter.id} does not write to it. `
        + 'Switch the parish to "Read from its own website" on its sheet to let it run.');
    }

    // What each entry is, and everything besides events the run will write —
    // all decided before anything is written (planRun).
    const plan = await planRun(db, env, adapter, events, window);

    // Classify before writing, so created/updated are honest. The old code
    // could not tell them apart because ON CONFLICT DO UPDATE reports a change
    // either way. They count events: an entry that landed on the timetable is
    // counted as paired instead.
    let eventsCreated = 0, eventsUpdated = 0;
    const hashes = plan.oneOffs.map(e => e.source_hash).filter(Boolean);
    const existing = new Set();
    if (hashes.length) {
      const q = await db.prepare(
        `SELECT source_hash FROM events WHERE source_hash IN (${hashes.map(() => '?').join(',')})`
      ).bind(...hashes).all();
      for (const r of q.results || []) existing.add(r.source_hash);
    }

    const upsert = db.prepare(`
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

    const writes = [];
    // An entry an earlier run wrote as an event, now known to be a rule's
    // occurrence, is retired: it was the second card. Only ours, and only one
    // nothing else hangs on — a poster, a combine, another parish showing it.
    if (plan.consumed.length) {
      writes.push(db.prepare(
        `DELETE FROM events WHERE source_adapter = ? AND source_hash IN (SELECT value FROM json_each(?))
           AND poster_path IS NULL
           AND NOT EXISTS (SELECT 1 FROM event_parishes ep WHERE ep.event_id = events.id)
           AND NOT EXISTS (SELECT 1 FROM schedule_overrides so WHERE so.combined_into_event_id = events.id)`
      ).bind(adapter.id, JSON.stringify(plan.consumed)));
    }
    for (const e of plan.oneOffs) {
      if (e.source_hash && existing.has(e.source_hash)) eventsUpdated++; else eventsCreated++;
      writes.push(upsert.bind(
        adapter.parishId, adapter.id, e.title, e.description || null,
        e.start_utc, e.end_utc || null, e.location_override || null,
        e.lat ?? parish.lat, e.lng ?? parish.lng,
        e.event_type || 'other', e.source_url || null, e.source_hash || null,
        e.hide_live ? 1 : 0, e.parish_scoped ? 1 : 0,
      ));
    }
    writes.push(...plan.statements);
    // One batch, so a run lands whole or not at all: an event retired without
    // its override written would be a service gone from the page.
    if (writes.length) await db.batch(writes);
    const tomb = plan.tomb;

    // An answer the model was unsure of goes to whoever keeps the parish, as a
    // suggestion (suggestions.mjs: a message, not an edit). Best effort — the
    // run has already written what it knows.
    for (const u of plan.unsure) {
      const sg = suggestionFor(u, sourcePhrase(adapter));
      await db.prepare(
        `INSERT INTO parish_suggestions (parish_id, email, name, kind, about, body)
         VALUES (?,?,?,'change',?,?)`
      ).bind(adapter.parishId, adapterSource(adapter.id), adapter.sourceName || adapter.id, sg.about, sg.body)
        .run().catch(e => console.error(`[${adapter.id}] suggestion not sent: ${e.message}`));
    }

    await db.prepare(
      `UPDATE adapter_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
       status='success', events_found=?, events_created=?, events_updated=?,
       window_from=?, window_to=?, tombstones_refused=? WHERE id=?`
    ).bind(eventsFound, eventsCreated, eventsUpdated,
           tomb.windowFrom, tomb.windowTo, tomb.refused?.reason || null, runId).run();

    console.log(`[${adapter.id}] found=${eventsFound} paired=${plan.paired} asked=${plan.asked}` +
      ` created=${eventsCreated} updated=${eventsUpdated}` +
      (tomb.refused ? ` tombstones=refused(${tomb.refused.reason})`
                    : ` cancelled=${tomb.created} restored=${tomb.withdrawn}`));
    return { eventsFound, eventsCreated, eventsUpdated, eventsPaired: plan.paired, tombstones: tomb };
  } catch (err) {
    await db.prepare(
      `UPDATE adapter_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
       status='failed', error_message=? WHERE id=?`
    ).bind(err.message, runId).run();
    console.error(`[${adapter.id}] failed:`, err.message);
    throw err;
  }
}

export { sha256Hex, guessEventType, shouldHideLive, isParishScoped };
