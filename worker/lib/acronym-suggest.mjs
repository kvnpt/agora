// A parish's acronym, suggested from its names.
//
// The acronym is the parish's short link — orthodoxy.au/sgy — so it is worth
// getting right the first time: changing it later takes the link away from
// everybody holding it. The house style is the dedication's initials and the
// suburb's ("St George, Yellow Rock" → sgy), which a rule gets most of the way
// to, and Claude Haiku the rest (a dedication with no saint in it, a suburb
// two parishes share, a name that reads better another way).
//
// Nothing here writes. The suggestion fills the field; a person saves it.
// Every candidate, the model's included, passes the same checks a save does
// (slugs.js, and no other parish holding it), so what is offered can be saved.

import slugs from '../../public/shared/slugs.js';

const { normaliseSlug, reservedSlugReason } = slugs;

export const ACRONYM_MODEL = 'claude-haiku-5-5';
const TIMEOUT_MS = 8000;

// Two to eight letters or digits, starting with a letter: short enough to type
// from a bulletin, and never all digits (an event id) — reservedSlugReason
// says the rest.
const SHAPE = /^[a-z][a-z0-9]{1,7}$/;

// Words that say what kind of place it is, not which one.
const GENERIC = new Set([
  'church', 'parish', 'monastery', 'convent', 'cathedral', 'chapel', 'mission',
  'community', 'orthodox', 'christian', 'archdiocese', 'diocese',
  'antiochian', 'greek', 'serbian', 'russian', 'romanian', 'macedonian',
  'of', 'the', 'and', 'in', 'at', 'for',
]);

const words = (s) => String(s || '').toLowerCase().replace(/['’]/g, '')
  .split(/[^a-z0-9]+/).filter(Boolean);
const initials = (s) => words(s).filter(w => !GENERIC.has(w)).map(w => w[0]).join('');

/**
 * What the house style makes of the names, best first, before anything is
 * checked. The short name is "Dedication, Suburb" by convention; the full name
 * is the fallback for one that is not.
 */
export function ruleCandidates(name, fullName) {
  const [dedication, ...rest] = String(name || '').split(',');
  const d = initials(dedication);
  const p = initials(rest.join(' '));
  const out = [];
  if (d && p) out.push(d + p[0], d + p);
  if (d) out.push(d);
  const f = initials(fullName);
  if (f) out.push(p ? f + p[0] : f, f);
  return [...new Set(out)];
}

export const SYSTEM_PROMPT = `You suggest the acronym for an Orthodox Christian parish in Australia or New Zealand on Agora, a site that lists parish services. The acronym is the parish's short link: orthodoxy.au/<acronym>. People type it from a bulletin, so it is short (2 to 6 lowercase letters is usual) and easy to say.

The house style is the initials of the dedication, then the initial of the suburb: "St George, Redfern" is sgr; "St George Monastery, Yellow Rock" is sgy. Leave out words that say what kind of place it is (church, monastery, cathedral, parish, Orthodox, Greek…). Follow the examples from the site when there are any — they are the style. Never offer one that is already taken.

Offer three candidates, best first, lowercase letters and digits only.`;

export const ACRONYM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: { type: 'array', items: { type: 'string' } },
  },
};

/** What the model is told: this parish, the site's own examples, and what is taken. */
export function acronymContext({ name, fullName, jurisdiction }, examples = [], taken = []) {
  return [
    `Short name: ${name || '(none)'}`,
    `Full name: ${fullName || '(none)'}`,
    jurisdiction ? `Jurisdiction: ${jurisdiction}` : '',
    examples.length
      ? `Acronyms on the site now:\n${examples.map(e => `- ${e.name}${e.full_name && e.full_name !== e.name ? ` (${e.full_name})` : ''} → ${e.acronym}`).join('\n')}`
      : '',
    taken.length ? `Already taken: ${taken.join(', ')}` : '',
  ].filter(Boolean).join('\n\n');
}

export function buildAcronymRequest(context) {
  return {
    model: ACRONYM_MODEL,
    // Room for a little thinking ahead of a few words of JSON.
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: ACRONYM_SCHEMA } },
    messages: [{ role: 'user', content: context }],
  };
}

/** The model's candidates, or [] — a suggestion that fails is the rule's to make. */
export async function askModel(context, { apiKey, baseUrl, fetchImpl = fetch } = {}) {
  try {
    const res = await fetchImpl(`${baseUrl || 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(buildAcronymRequest(context)),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      console.error(`[acronym-suggest] HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
      return [];
    }
    const msg = await res.json();
    // A response can open with thinking blocks; the answer is the text.
    const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    if (msg.stop_reason !== 'end_turn' || !text) return [];
    const doc = JSON.parse(text);
    return Array.isArray(doc.candidates) ? doc.candidates.map(String) : [];
  } catch (e) {
    console.error(`[acronym-suggest] ${e && e.message}`);
    return [];
  }
}

/**
 * The suggestion: the first candidate a save would accept, the model's before
 * the rule's, and a numbered rule one if every name is taken.
 *
 * @returns {Promise<{acronym: string|null, source: 'model'|'rule'|null, alternatives: string[]}>}
 */
export async function suggestAcronym({ name, fullName, jurisdiction, parishId }, { db, apiKey, baseUrl, fetchImpl } = {}) {
  const { results: rows = [] } = await db.prepare(
    `SELECT id, name, full_name, acronym FROM parishes
     WHERE id != '_unassigned' AND acronym IS NOT NULL AND trim(acronym) != ''
     ORDER BY updated_at DESC`
  ).all();
  const others = rows.filter(r => r.id !== parishId);
  const taken = new Set(others.map(r => normaliseSlug(r.acronym)));
  const usable = (c) => {
    const s = normaliseSlug(c).replace(/[^a-z0-9]/g, '');
    return SHAPE.test(s) && !reservedSlugReason(s) && !taken.has(s) ? s : null;
  };

  const fromRule = ruleCandidates(name, fullName);
  let fromModel = [];
  if (apiKey && (name || fullName)) {
    const context = acronymContext({ name, fullName, jurisdiction }, others.slice(0, 40), [...taken].sort());
    fromModel = await askModel(context, { apiKey, baseUrl, fetchImpl });
  }

  const offered = [];
  const offer = (c, source) => {
    const s = usable(c);
    if (s && !offered.some(o => o.acronym === s)) offered.push({ acronym: s, source });
  };
  fromModel.forEach(c => offer(c, 'model'));
  fromRule.forEach(c => offer(c, 'rule'));
  if (!offered.length && fromRule[0]) {
    for (let n = 2; n <= 9 && !offered.length; n++) offer(fromRule[0] + n, 'rule');
  }
  const [best, ...rest] = offered;
  return {
    acronym: best ? best.acronym : null,
    source: best ? best.source : null,
    alternatives: rest.slice(0, 3).map(o => o.acronym),
  };
}
