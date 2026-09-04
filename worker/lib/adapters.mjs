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

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

class GoogleCalendarAdapter {
  constructor({ parishId, calendarId, schedule }) {
    this.id = `gcal-${parishId}`;
    this.parishId = parishId;
    this.calendarId = calendarId;
    this.sourceType = 'google-calendar';
    this.schedule = schedule || '0 */4 * * *';
  }

  async fetchEvents(env) {
    const apiKey = env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('GOOGLE_API_KEY not set');

    const url = new URL(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events`
    );
    url.searchParams.set('key', apiKey);
    url.searchParams.set('timeMin', new Date().toISOString());
    url.searchParams.set('timeMax', new Date(Date.now() + 90 * 86400000).toISOString());
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '100');

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Google Calendar API error: ${res.status} ${res.statusText}`);
    const data = await res.json();

    return Promise.all((data.items || []).map(async (item) => {
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
  }
}

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
    calendarId: 'goodshepherdclayton@gmail.com',
  }),
];

export const getAdapter = (id) => ADAPTERS.find(a => a.id === id) || null;

/**
 * Run one adapter: fetch, upsert, log the run. Returns the run's counters.
 */
export async function runAdapter(adapter, env) {
  const db = env.DB;
  const started = await db.prepare(
    "INSERT INTO adapter_runs (adapter_id, status) VALUES (?, 'running') RETURNING id"
  ).bind(adapter.id).first();
  const runId = started.id;

  try {
    const events = await adapter.fetchEvents(env);
    const eventsFound = events.length;

    // Classify before writing, so created/updated are honest. The old code
    // could not tell them apart because ON CONFLICT DO UPDATE reports a change
    // either way.
    let eventsCreated = 0, eventsUpdated = 0;
    const hashes = events.map(e => e.source_hash).filter(Boolean);
    const existing = new Set();
    if (hashes.length) {
      const q = await db.prepare(
        `SELECT source_hash FROM events WHERE source_hash IN (${hashes.map(() => '?').join(',')})`
      ).bind(...hashes).all();
      for (const r of q.results || []) existing.add(r.source_hash);
    }

    const parish = await db.prepare('SELECT lat, lng FROM parishes WHERE id = ?')
      .bind(adapter.parishId).first();

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

    const writes = events.map(e => {
      if (e.source_hash && existing.has(e.source_hash)) eventsUpdated++; else eventsCreated++;
      return upsert.bind(
        adapter.parishId, adapter.id, e.title, e.description || null,
        e.start_utc, e.end_utc || null, e.location_override || null,
        e.lat ?? parish?.lat ?? null, e.lng ?? parish?.lng ?? null,
        e.event_type || 'other', e.source_url || null, e.source_hash || null,
        e.hide_live ? 1 : 0, e.parish_scoped ? 1 : 0,
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

export { sha256Hex, guessEventType, shouldHideLive, isParishScoped };
