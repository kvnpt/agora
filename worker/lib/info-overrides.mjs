// Rulings on which source wins, and the guards that make them bite.
//
// The ladder is public/shared/source-tiers.js; the rows are `info_overrides`;
// this is the part in between — what a ruling may be about, whether a given
// source is allowed past it, and how to say it in a sentence.
//
// WHY THIS IS A LIBRARY AND NOT A ROUTE. Three readers, none of which can be
// the others: the Worker serves the rows and enforces them on an /admin write,
// the import scripts read them over HTTP and enforce them when planning, and
// the panel renders them. The first two have to agree exactly about what
// `'0|18:00'` means or a suppression silently misses, which is the same
// argument that put the PDF sources in one shared module.

import tiers from '../../public/shared/source-tiers.js';

const { outranks, isTier, tierLabel, SOURCE_TIERS } = tiers;

export { outranks, isTier, tierLabel, SOURCE_TIERS };

/**
 * The parish columns a ruling may be made about.
 *
 * Deliberately the REFRESHABLE list from scripts/parish-import.mjs and nothing
 * more: pinning a column no import ever writes would be a control that does
 * nothing, and pinning `id` or `jurisdiction` would be a way to break a join.
 * `info_*` is absent for the same reason — a ruling about where a fact came
 * from cannot itself be a fact a scrape refreshes, or the pin would argue with
 * its own provenance.
 */
export const PINNABLE_FIELDS = [
  'name', 'address', 'lat', 'lng', 'timezone', 'website', 'phone', 'email',
  'feast_day', 'acronym', 'languages', 'full_name',
];

/** Latitude and longitude are one fact; pinning an address and not its pin is how a dot ends up in a car park. */
export const FIELD_GROUPS = { address: ['address', 'lat', 'lng'] };

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * A rule's slot, as `info_overrides.subject` spells it.
 *
 * Weekday and local start time, and nothing else — the same three things
 * `planWrite` treats as a rule's identity in every importer. A suppression
 * keyed on the title too would miss the day the source renames "Vespers" to
 * "Great Vespers", which is exactly the kind of change a source makes without
 * meaning anything by it.
 */
export function slotKey(dayOfWeek, startTime) {
  const d = Number(dayOfWeek);
  const t = String(startTime || '').trim();
  if (!Number.isInteger(d) || d < 0 || d > 6) return null;
  if (!TIME.test(t)) return null;
  return `${d}|${t}`;
}

const SLOT = /^([0-6])\|((?:[01]\d|2[0-3]):[0-5]\d)$/;

export function parseSlot(subject) {
  const m = SLOT.exec(String(subject || ''));
  if (!m) return null;
  return { day_of_week: Number(m[1]), start_time: m[2] };
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Read the rulings. One parish, or all of them. */
export async function readInfoOverrides(db, parishId = null) {
  const sql = `SELECT id, parish_id, target, subject, decision, tier, source_label,
                      source_name, source_ref, checked_at, note, created_at, updated_at, updated_by
               FROM info_overrides${parishId ? ' WHERE parish_id = ?' : ''}
               ORDER BY parish_id, target, subject`;
  const stmt = parishId ? db.prepare(sql).bind(parishId) : db.prepare(sql);
  const r = await stmt.all();
  return r.results || [];
}

/**
 * The rows, arranged the way the two guards ask about them.
 *
 * Maps rather than repeated finds because the parish importer asks once per
 * scraped row and the schedule importer once per parsed rule — a few hundred
 * lookups per run against 293 parishes.
 */
export function indexOverrides(rows) {
  const fields = new Map();
  const slots = new Map();
  for (const r of rows || []) {
    const bucket = r.target === 'field' ? fields : slots;
    if (!bucket.has(r.parish_id)) bucket.set(r.parish_id, new Map());
    bucket.get(r.parish_id).set(r.subject, r);
  }
  return { fields, slots };
}

/**
 * May a source at `tier` write this field?
 *
 * No ruling means yes — absence is not a refusal, and every import that ran
 * before this table existed has to keep behaving the same way. A ruling means
 * the source must STRICTLY outrank it: a jurisdiction re-read cannot touch a
 * field pinned from the parish's own website, and a second read of that same
 * website cannot either, because two sources at one tier disagreeing is not
 * something a ladder settles.
 */
export function mayWriteField(index, parishId, field, tier) {
  const row = index.fields.get(parishId)?.get(field);
  if (!row) return true;
  return outranks(tier, row.tier);
}

/** Every field a source at `tier` must leave alone for this parish. */
export function pinnedFields(index, parishId, tier) {
  const out = [];
  for (const [field, row] of index.fields.get(parishId) || []) {
    if (!outranks(tier, row.tier)) out.push({ field, ...row });
  }
  return out;
}

/**
 * Is this rule refused, and by whom?
 *
 * Returns the ruling row, so the caller can say why rather than just skipping.
 * A silent skip is the failure this whole table exists to end.
 */
export function suppressionFor(index, parishId, dayOfWeek, startTime, tier) {
  const key = slotKey(dayOfWeek, startTime);
  if (!key) return null;
  const row = index.slots.get(parishId)?.get(key);
  if (!row || row.decision !== 'suppress') return null;
  return outranks(tier, row.tier) ? null : row;
}

/** Is this rule's stored shape protected from a source at `tier`? */
export function pinFor(index, parishId, dayOfWeek, startTime, tier) {
  const key = slotKey(dayOfWeek, startTime);
  if (!key) return null;
  const row = index.slots.get(parishId)?.get(key);
  if (!row || row.decision !== 'pin') return null;
  return outranks(tier, row.tier) ? null : row;
}

/**
 * Check a ruling on the way in.
 *
 * `note` is required and that is not a formality. An import that refuses half
 * a page is indistinguishable from an import that is broken, unless the
 * refusal says why — and the person who will need to know is not the person
 * typing.
 */
export function validateOverride(input, { parishExists = true } = {}) {
  const target = input?.target;
  if (target !== 'field' && target !== 'schedule') {
    return { ok: false, error: 'A ruling is about a field or about a schedule rule.' };
  }
  if (!parishExists) return { ok: false, error: 'No such parish.' };

  const decision = input?.decision;
  if (decision !== 'pin' && decision !== 'suppress') {
    return { ok: false, error: 'A ruling either pins what is stored or suppresses what the source publishes.' };
  }
  if (target === 'field' && decision === 'suppress') {
    // Not a CHECK constraint talking: pinning an emptied field already says
    // "stop filling this in", so a second way to say it would only be a second
    // thing to explain.
    return { ok: false, error: 'A field is pinned, never suppressed — clear it and pin it empty instead.' };
  }

  const tier = String(input?.tier || '').trim();
  if (!isTier(tier)) {
    return { ok: false, error: `Say where the better information came from: ${SOURCE_TIERS.map((t) => t.id).join(', ')}.` };
  }

  const note = typeof input?.note === 'string' ? input.note.trim() : '';
  if (!note) {
    return { ok: false, error: 'Say why. An unexplained ruling reads as a broken import to whoever meets it next.' };
  }

  let subject;
  if (target === 'field') {
    subject = String(input?.field ?? input?.subject ?? '').trim();
    if (!PINNABLE_FIELDS.includes(subject)) {
      return { ok: false, error: `${subject || 'That'} is not a field a ruling can be made about.` };
    }
  } else {
    subject = input?.subject && !input?.start_time
      ? String(input.subject).trim()
      : slotKey(input?.day_of_week, input?.start_time);
    if (!subject || !parseSlot(subject)) {
      return { ok: false, error: 'A schedule ruling needs a weekday and a local start time.' };
    }
  }

  const str = (v) => {
    const s = typeof v === 'string' ? v.trim() : '';
    return s || null;
  };
  return {
    ok: true,
    row: {
      parish_id: String(input.parish_id || '').trim(),
      target,
      subject,
      decision,
      tier,
      source_label: str(input.source_label),
      source_name: str(input.source_name),
      source_ref: str(input.source_ref),
      checked_at: str(input.checked_at),
      note,
    },
  };
}

/**
 * One line for the panel and for an import's plan.
 *
 * Written from the side of somebody who did NOT make the ruling, because that
 * is the only reader who matters: they are looking at an import that left
 * something out and deciding whether it is a decision or a bug.
 */
export function describeOverride(row) {
  if (!row) return '';
  const on = row.tier === 'admin'
    ? 'an admin’s decision'
    : `the ${tierLabel(row.tier).toLowerCase()}`;
  if (row.target === 'schedule') {
    const slot = parseSlot(row.subject);
    const when = slot ? `${DAYS[slot.day_of_week]} ${slot.start_time}` : row.subject;
    if (row.decision === 'suppress') {
      const what = row.source_label ? `“${row.source_label}”` : 'a service';
      return `${when} — the source publishes ${what} and it does not run. Refused on ${on}.`;
    }
    return `${when} — kept as stored, on ${on}. A weaker source may not rewrite it.`;
  }
  return `${row.subject} — held on ${on}. A weaker source may not overwrite it.`;
}

/**
 * The rows as the import scripts get them.
 *
 * `updated_by` is an admin's email address and this endpoint has no
 * authentication, so it does not go. Everything else is about a parish's
 * public timetable and is the reason the endpoint exists — a script with no
 * Cloudflare credential has to see the same rulings the Worker does, or it
 * plans a write the panel has already refused.
 */
export function publicOverridePayload(rows) {
  return (rows || []).map(({ updated_by, id, ...rest }) => rest);
}
