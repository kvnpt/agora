// "This and every following": ending a rule, or changing it from a date on.
//
// Calendar apps taught everybody the question — this event, or this and the
// ones after it — and an admin opening one Sunday's Liturgy expected to be
// asked it. The answer is NOT to edit the rule in place: that rewrites every
// past Sunday too, and the feed would say the old 10am services happened at
// 9am. It is to close the rule the day before and open a new one on the day,
// which is what `effective_from` / `effective_to` were always for.
//
//   end    the rule's last day becomes the day before this one. Nothing
//          after it is projected — no tombstones, because a service that has
//          stopped is not "cancelled" every week forever. Reversible: clear
//          the end date and the rule, and every override it still holds, is
//          back.
//   split  the old rule ends the day before; a new rule, the old one with the
//          changes applied, starts on the day. Anything already decided about
//          a later date — a cancellation, a commemoration, a poster, a break —
//          hangs off the OLD rule and would silently stop showing, so the
//          person is asked whether to carry it across or let it go.
//
// Pure where it can be (rows in, plans out) so node --test covers the parts
// that decide things; the route in admin.mjs does the writing.

import { isValidOccurrence } from './expand.mjs';
import { localPartsOf } from '../../public/shared/tz.mjs';

const DAY_MS = 86400000;
export const dayBefore = (d) => new Date(Date.parse(d + 'T00:00:00Z') - DAY_MS).toISOString().slice(0, 10);

/** The columns a new rule copies from the one it continues. */
export const RULE_COLS = ['parish_id', 'day_of_week', 'start_time', 'end_time', 'title', 'event_type',
  'active', 'languages', 'week_of_month', 'concurrent', 'hide_live', 'parish_scoped',
  'effective_from', 'effective_to', 'location_override', 'source_name', 'source_ref',
  'source_checked_at', 'week_parity'];

/**
 * The drawer's form, read as a change to the RULE.
 *
 * The drawer edits an occurrence, so it speaks in instants (start_utc) and
 * display fields; a rule speaks in a weekday and a local wall-clock time. The
 * instant is read in the PARISH's zone — the same reading the rule's own
 * start_time has — so 9am in Perth is "09:00", not Sydney's 11am.
 *
 * Only what the body names, and only the fields a rule has: a description is
 * one occurrence's, and is applied to the first date of the new rule instead.
 */
export function ruleChangesFrom(body, zone) {
  const out = {};
  if (body.title !== undefined && body.title) out.title = body.title;
  if (body.event_type !== undefined && body.event_type) out.event_type = body.event_type;
  if (body.languages !== undefined) out.languages = body.languages || null;
  if (body.location_override !== undefined) out.location_override = body.location_override || null;
  if (body.hide_live !== undefined) out.hide_live = body.hide_live ? 1 : 0;
  if (body.parish_scoped !== undefined) out.parish_scoped = body.parish_scoped ? 1 : 0;
  if (body.start_utc) {
    const p = localPartsOf(zone, Date.parse(body.start_utc));
    out.start_time = p.time;
    out.day_of_week = p.dow;
  }
  if (body.end_utc !== undefined) {
    out.end_time = body.end_utc ? localPartsOf(zone, Date.parse(body.end_utc)).time : null;
  }
  return out;
}

/** A later decision, said the way the person made it. */
export function describeLater(o) {
  if (o.kind === 'cancelled') return 'cancelled';
  if (o.kind === 'hidden') return 'suppressed';
  if (o.kind === 'combined') return 'combined with another service';
  const bits = [];
  if (o.patch_feast) bits.push(o.patch_feast);
  if (o.patch_start_time) bits.push(`at ${o.patch_start_time}`);
  if (o.patch_title) bits.push(`as “${o.patch_title}”`);
  if (o.patch_poster_path) bits.push('a poster');
  if (o.patch_location_override) bits.push('elsewhere');
  if (o.patch_description) bits.push('a note');
  return bits.length ? bits.join(', ') : 'changed';
}

/**
 * What a split would do to the decisions already made about later dates.
 *
 * `movable` are the overrides whose date the NEW rule still produces — a
 * cancellation on Sunday 19 Oct can follow a Sunday rule moved from 10am to
 * 9am, but not one moved to Monday, because there is no Monday 19 Oct to
 * cancel. The rest can only be let go.
 */
export function planCarry(overrides, breaks, newRule) {
  const movable = [], stranded = [];
  for (const o of overrides || []) {
    (isValidOccurrence(newRule, o.occurrence_date) ? movable : stranded).push(o);
  }
  return { movable, stranded, breaks: breaks || [] };
}

/** The 409 body that asks the question, with enough to answer it. */
export function carryQuestion(plan) {
  const list = (os) => os.map(o => ({ date: o.occurrence_date, what: describeLater(o) }));
  return {
    error: 'Later dates of this service already have their own changes.',
    needs_choice: true,
    movable: list(plan.movable),
    stranded: list(plan.stranded),
    breaks: plan.breaks.map(b => ({ from: b.from_date, to: b.to_date, note: b.note })),
  };
}

/** The new rule's row: the old one, the changes, and its own dates. */
export function continuation(rule, changes, date) {
  const row = {};
  for (const c of RULE_COLS) row[c] = rule[c] ?? null;
  Object.assign(row, changes);
  row.effective_from = date;
  // An end the old rule already had still applies to what continues it — a
  // Lenten rule changed mid-Lent still stops at Pascha.
  row.effective_to = rule.effective_to && rule.effective_to >= date ? rule.effective_to : null;
  row.active = 1;
  return row;
}

/**
 * Is there anything BEFORE `date` to keep? A rule that only starts on or after
 * the day has no past to protect, so "this and following" is just an edit of
 * the whole rule — splitting it would leave an empty rule behind.
 */
export const hasPastBefore = (rule, date) => !rule.effective_from || rule.effective_from < date;
