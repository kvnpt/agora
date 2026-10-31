// Asking Claude Haiku what the rules in pairing.mjs cannot say, once.
//
// pairing.mjs has what is asked and what an answer may do. This is the asking:
// one request a run at most, only for questions never answered before, and
// every answer kept in `adapter_reads` keyed by the question's text. A cron
// run every four hours asking afresh would cost a little and, worse, could
// answer differently each time — a card that flickers between "Liturgy, St
// Nicholas" and two cards. Asked once, the answer is the answer until the
// calendar changes the entry (a new title or time is a new question).
//
// RAW fetch, NOT the SDK, like poster-read.mjs and acronym-suggest.mjs: the
// Worker carries no third-party runtime code (docs/adapters.md). Haiku 5.5
// thinks by default; `effort: 'low'` keeps that short, and the answer is
// structured output in a fixed shape. No temperature (Haiku 5.5 rejects it),
// no prefill, no fallbacks (it has none): a refusal or a failure leaves the
// question unanswered, which pairing.mjs reads as "the rules decide".

async function sha256Hex(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export const PAIRING_MODEL = 'claude-haiku-5-5';
const TIMEOUT_MS = 30000;
// Enough for a bad week of feasts; the rest wait for the next run.
export const MAX_QUESTIONS = 30;

export const SYSTEM_PROMPT = `You help Agora, a site listing Orthodox Christian parish services in Australia and New Zealand, read a parish's own online calendar against the parish's regular timetable. Each question is one of two kinds. Answer every question, by its id.

subtitle: the calendar entry is already known to be the parish's regular service that day. Give the commemoration it names: the saint or feast of the day ("St Nicholas", "Sunday of the Prodigal Son", "Entrance of the Theotokos"), in English, as the calendar names it. Give "" if it names none. The name of a service is not a commemoration: "Divine Liturgy of St John Chrysostom", "Liturgy of St Basil", "Matins (Orthros)", "Hierarchical Divine Liturgy", and a language ("in English") all give "". For this kind set entry to 0, sure to true and service to "".

which: a regular service due that day has no calendar entry with its name. The entries listed are the calendar's entries that day that nothing else claimed. Say which one, if any, IS that regular service: held at another time that day, or titled after the day's feast. Set entry to its number, or 0 if none of them is. A different service, a talk, a meal, a meeting, a bookshop, a course, a fast or a reminder is not it. Set sure to false when you cannot tell; a person will then decide, so do not guess. When you pick an entry, give the service's own name in service ("Vesperal Liturgy", "Divine Liturgy") and the day's commemoration in feast, or "" for either.`;

export const PAIRING_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answers'],
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'entry', 'sure', 'service', 'feast'],
        properties: {
          id: { type: 'string' },
          entry: { type: 'integer' },
          sure: { type: 'boolean' },
          service: { type: 'string' },
          feast: { type: 'string' },
        },
      },
    },
  },
};

export function buildPairingRequest(questions) {
  return {
    model: PAIRING_MODEL,
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: PAIRING_SCHEMA } },
    messages: [{
      role: 'user',
      content: questions.map((q, i) => `id: q${i + 1}\n${q.text}`).join('\n\n'),
    }],
  };
}

/**
 * The cache. Made on first use as well as by migration 032, the same
 * belt-and-braces as suggestions.mjs: a run must not fail for want of a table
 * that only remembers answers. Identical DDL to d1/schema.sql; a test compares.
 */
export const ADAPTER_READS_DDL = [
  `CREATE TABLE IF NOT EXISTS adapter_reads (
  question_hash TEXT PRIMARY KEY,
  adapter_id    TEXT NOT NULL,
  question      TEXT NOT NULL,
  answer        TEXT NOT NULL,
  model         TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
)`,
];

const ensured = new WeakSet();
async function ensureTable(db) {
  if (ensured.has(db)) return;
  await db.batch(ADAPTER_READS_DDL.map(sql => db.prepare(sql)));
  ensured.add(db);
}

/** A parsed answer as pairing.mjs reads it, or null if it is not one. */
function asAnswer(a) {
  if (!a || typeof a !== 'object') return null;
  const entry = Number.isInteger(a.entry) ? a.entry : 0;
  return { entry, sure: a.sure === true, service: String(a.service || ''), feast: String(a.feast || '') };
}

/** One request for every question; a Map(index → answer). Empty on any failure. */
export async function askModel(questions, { apiKey, baseUrl, fetchImpl = fetch } = {}) {
  const out = new Map();
  try {
    const res = await fetchImpl(`${baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(buildPairingRequest(questions)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[pairing-read] HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
      return out;
    }
    const msg = await res.json();
    // A response can open with thinking blocks; the answer is the text.
    const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    if (msg.stop_reason !== 'end_turn' || !text) {
      console.error(`[pairing-read] no answer: stop_reason ${msg.stop_reason}`);
      return out;
    }
    for (const a of JSON.parse(text).answers || []) {
      const m = /^q(\d+)$/.exec(String(a.id || ''));
      const i = m ? Number(m[1]) - 1 : -1;
      const answer = asAnswer(a);
      if (i >= 0 && i < questions.length && answer) out.set(i, answer);
    }
  } catch (e) {
    console.error(`[pairing-read] ${e && e.message}`);
  }
  return out;
}

/**
 * Answers for these questions: remembered ones from `adapter_reads`, the rest
 * asked in one request and remembered. Never throws — a cache or a model that
 * is not there leaves questions unanswered, and the rules decide.
 *
 * @returns {Promise<{answers: Map<string, object>, fresh: Set<string>, asked: number}>}
 *   answers  question text → answer
 *   fresh    the texts answered by THIS run, so an unsure one is passed on once
 */
export async function answersFor(questions, { db, adapterId, apiKey, baseUrl, fetchImpl } = {}) {
  const answers = new Map(), fresh = new Set();
  const unique = [...new Map(questions.map(q => [q.text, q])).values()];
  if (!unique.length || !db) return { answers, fresh, asked: 0 };

  const hashOf = new Map();
  for (const q of unique) hashOf.set(q.text, await sha256Hex(q.text));

  let cacheUp = true;
  try {
    await ensureTable(db);
    const { results = [] } = await db.prepare(
      'SELECT question_hash, answer FROM adapter_reads WHERE question_hash IN (SELECT value FROM json_each(?))'
    ).bind(JSON.stringify([...hashOf.values()])).all();
    const byHash = new Map(results.map(r => [r.question_hash, r.answer]));
    for (const q of unique) {
      const raw = byHash.get(hashOf.get(q.text));
      if (!raw) continue;
      try { const a = asAnswer(JSON.parse(raw)); if (a) answers.set(q.text, a); } catch { /* re-ask */ }
    }
  } catch (e) {
    // Without somewhere to keep an answer, asking every run is the flicker
    // this file exists to prevent. The rules decide until the table is there.
    console.error(`[pairing-read] cache unavailable: ${e && e.message}`);
    cacheUp = false;
  }

  const open = unique.filter(q => !answers.has(q.text)).slice(0, MAX_QUESTIONS);
  if (!open.length || !apiKey || !cacheUp) return { answers, fresh, asked: 0 };

  const got = await askModel(open, { apiKey, baseUrl, fetchImpl });
  const writes = [];
  got.forEach((a, i) => {
    const q = open[i];
    answers.set(q.text, a);
    fresh.add(q.text);
    writes.push(db.prepare(
      `INSERT OR REPLACE INTO adapter_reads (question_hash, adapter_id, question, answer, model)
       VALUES (?,?,?,?,?)`
    ).bind(hashOf.get(q.text), adapterId || 'unknown', q.text, JSON.stringify(a), PAIRING_MODEL));
  });
  if (writes.length) await db.batch(writes).catch(e => console.error(`[pairing-read] not kept: ${e && e.message}`));
  return { answers, fresh, asked: open.length };
}
