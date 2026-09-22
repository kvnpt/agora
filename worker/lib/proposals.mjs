// The asks an editor cannot carry out themselves.
//
// Roles draw three hard lines — an editor may not delete a parish, change an
// acronym, or repaint a jurisdiction. Each is right: a delete is unrecoverable,
// an acronym takes a public link away from everybody holding it, and a colour
// applies site-wide. But a bare 403 turns the owner into a help desk reached
// by some other channel, and the request arrives stripped of the context that
// produced it — "can you delete a parish for me" rather than "this one is a
// duplicate of that one, here is which".
//
// So the refusal offers to carry the ask. This module is the part worth testing
// on its own: what may be proposed, whether a proposal is well-formed, and how
// to describe it to the person deciding.
//
// NOT A MODERATION QUEUE. Ordinary edits are never proposed — they just happen.
// The WhatsApp moderation subsystem died with the VM and is not coming back.
// Only an ask with nowhere else to go becomes a proposal.
//
// 'event.combine' is the fourth, and it is a different shape from the other
// three. Those are capability refusals — an editor may not delete a parish,
// anywhere. This is a SCOPE refusal: a parish contact may combine freely at
// their own parish, and a combine is the one write whose target belongs to
// somebody else. Listing an event at the cathedral, or absorbing the
// cathedral's Sunday into a deanery liturgy, writes rows about a parish that is
// not theirs. Same predicament, same shape of ask, so the same table.


/**
 * What may be asked for.
 *
 * The first three are exactly the capabilities an editor is refused. The
 * fourth is not a capability at all — nothing in roles.mjs grants
 * 'event.combine', and `can()` answers false for every role including owner —
 * which is why the events routes raise it themselves rather than letting
 * `guarded`'s capability refusal do it.
 */
export const PROPOSABLE = ['parish.delete', 'parish.acronym', 'colors.edit', 'event.combine'];

/** The one that is a scope refusal rather than a capability refusal. */
export const SCOPE_PROPOSABLE = 'event.combine';

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** A list of ids as trimmed, deduped, non-empty strings. Anything else drops. */
const strings = (v) => (Array.isArray(v) ? v : [])
  .map(x => (typeof x === 'string' || typeof x === 'number') ? String(x).trim() : '')
  .filter((x, i, all) => x && all.indexOf(x) === i);

/** "A", "A and B", "A, B and C" — a sentence, not a join. */
const list = (items) => items.length <= 1
  ? (items[0] || '')
  : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;

/**
 * Check a proposal before it is stored.
 *
 * Returns `{ ok: true, payload }` with the payload normalised, or
 * `{ ok: false, error }`.
 *
 * Validating on the way IN is not the same as trusting it later: the approving
 * route re-validates, because a row can sit in this table for a week while the
 * parish it names is renamed, deleted, or given the very acronym being asked
 * for. This is the cheap check that keeps obvious nonsense out; that one is the
 * check that matters.
 */
export function validateProposal({ capability, subject, payload }) {
  if (!PROPOSABLE.includes(capability)) {
    return { ok: false, error: `${capability} is not something that can be proposed.` };
  }
  if (typeof subject !== 'string' || !subject.trim()) {
    return { ok: false, error: 'A proposal has to name what it is about.' };
  }
  const p = payload && typeof payload === 'object' ? payload : {};

  if (capability === 'parish.acronym') {
    const acronym = typeof p.acronym === 'string' ? p.acronym.trim() : '';
    // An empty acronym is a legitimate ask — "take this link away" — so it is
    // allowed, and only the shape is checked here. Whether it clashes with a
    // reserved slug or another parish is the approving route's question,
    // because the answer changes while the proposal waits.
    return { ok: true, payload: { acronym } };
  }

  if (capability === 'colors.edit') {
    const color = typeof p.color === 'string' ? p.color.trim() : '';
    if (!HEX.test(color)) {
      return { ok: false, error: 'A colour proposal needs a hex value like #0d5eaf.' };
    }
    return { ok: true, payload: { color } };
  }

  if (capability === 'event.combine') {
    // The WHOLE desired state, not the refused half. Approving replays it
    // through the same idempotent path the proposer's own press took, and that
    // path removes anything the body does not name — so a payload carrying
    // only the out-of-scope targets would strip the in-scope ones on approval.
    const parishes = strings(p.additive_parish_ids);
    // Left as strings and not classified here: an integer is a stored one-off
    // and "sid:date" a projected occurrence, and which is which is the
    // approving route's question, asked against the database as it is then.
    const targets = strings(p.replaced_event_ids);
    if (!parishes.length && !targets.length) {
      return { ok: false, error: 'A combine has to name a parish to appear at, or a service to absorb.' };
    }
    return { ok: true, payload: { additive_parish_ids: parishes, replaced_event_ids: targets } };
  }

  // parish.delete. The disposition of the events is part of the ask, not
  // something for the owner to guess at — "delete this parish" and "delete this
  // parish and its 80 events" are different requests.
  const disposition = p.disposition === 'purge' ? 'purge' : 'transfer';
  if (disposition === 'transfer' && (typeof p.transferTo !== 'string' || !p.transferTo.trim())) {
    return { ok: false, error: 'Say which parish the events should move to, or ask for them to be deleted too.' };
  }
  return {
    ok: true,
    payload: disposition === 'purge'
      ? { disposition }
      : { disposition, transferTo: p.transferTo.trim() },
  };
}

/**
 * One line describing what a proposal would do, for the owner's list.
 *
 * Written from the deciding person's side: they are about to do something
 * irreversible on somebody else's say-so, so the sentence has to carry the
 * consequence, not just the verb.
 */
export function describeProposal(capability, payload, names = {}) {
  const who = names.subject || 'it';
  if (capability === 'parish.acronym') {
    return payload.acronym
      ? `Give ${who} the acronym “${payload.acronym}” — its public link becomes /${payload.acronym}.`
      : `Remove ${who}’s acronym, so its current public link stops resolving.`;
  }
  if (capability === 'colors.edit') {
    return `Repaint every ${who} parish ${payload.color} on the map and in the feed.`;
  }
  if (capability === 'event.combine') {
    // Names rather than ids, resolved by the caller — an owner deciding this
    // should not have to know that "6:2026-09-27" is Bankstown's Sunday.
    const at = list(names.parishes || []);
    const absorbs = list(names.targets || []);
    if (!at && !absorbs) {
      return `Take “${who}” off every other parish and undo everything it absorbs, leaving it at its own parish alone.`;
    }
    const halves = [];
    if (at) halves.push(`list “${who}” at ${at}`);
    if (absorbs) halves.push(`absorb ${absorbs}`);
    const sentence = halves.join(', and ');
    return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.' +
      (absorbs ? ' What it absorbs still renders, as a tombstone pointing at it.' : '');
  }
  if (payload.disposition === 'purge') {
    return `Delete ${who} and all of its events. This cannot be undone.`;
  }
  return `Delete ${who}, moving its events and rules to ${names.transferTo || payload.transferTo}.`;
}

/** Is this row still actionable? A predicate, so it answers true or false. */
export const isOpen = (row) => !!row && row.status === 'open';

/**
 * Parse a stored payload back out.
 *
 * Never throws: a row written by an older version, or by hand, should make the
 * proposal un-approvable rather than break the list it sits in.
 */
export function readPayload(raw) {
  try {
    const v = JSON.parse(raw);
    // An array is typeof 'object' and is never a payload here. Letting one
    // through would give the approving route a shape it reads as all-undefined
    // — a delete with no disposition, which defaults to something.
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
