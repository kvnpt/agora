// Who may do what, once more than one person has a login.
//
// THE PROBLEM. `state.isAdmin` was a single boolean. Anyone Cloudflare Access
// let through could delete any parish, change any acronym — a URL namespace
// change, so /smg stops resolving for everyone holding that link — repaint
// every jurisdiction site-wide, pause every scraper and delete any rule.
// VISION.md already anticipated the answer: "no user profiles beyond admin
// roles."
//
// WHY A D1 TABLE AND NOT AN ACCESS GROUP CLAIM. The obvious design is to read
// a group out of the Access JWT. It was rejected for three reasons: it needs
// the identity provider to emit groups and the Access application to forward
// them, neither of which this code can check; it puts "who is a sub-admin"
// in a Cloudflare dashboard rather than in the panel the owner already uses;
// and it cannot be tested. A table is the same shape as every other piece of
// configuration here — adapter_settings, jurisdiction_colors,
// pdf_source_overrides — where the file or the default is the fallback and D1
// holds only what somebody deliberately set.
//
// Access still decides who gets through the door at all. This decides what
// they may touch once inside, which is a second question and not a substitute
// for the first.
//
// ── THE BOOTSTRAP RULE ──
//
// An empty table means EVERY authenticated user is an owner.
//
// That is deliberate and it is the only safe migration: the deploy that adds
// this code must not lock the existing admin out of their own panel, and
// before this existed every authenticated user was effectively an owner
// anyway. So an empty table reproduces exactly today's behaviour.
//
// The moment ANY row exists, absence stops meaning owner and starts meaning
// no access. That flip is the dangerous edge — add a sub-admin to Access,
// forget their row, and they would silently be an owner under a "missing means
// default" rule. So the rule inverts itself the first time it is used, and the
// panel says so loudly before the first row is written.
//
// Elsewhere in this codebase absence deliberately means "carry on" — a missing
// adapter_settings row must never be the thing that stops a scrape. The
// asymmetry is the point: a missed scrape is fixed by the next one, and a
// wrongly-granted delete is not.

/** Every role, most privileged first. */
export const ROLES = ['owner', 'editor', 'parish'];

/**
 * What each role may do.
 *
 * Capabilities rather than routes, so the guard reads as a sentence and the
 * panel can grey out the same control the API refuses. A route asks for a
 * capability; it never asks for a role.
 */
const CAPABILITIES = {
  owner: new Set([
    'parish.edit', 'parish.create', 'parish.delete', 'parish.acronym',
    'schedule.edit', 'schedule.create', 'schedule.delete',
    'override.edit', 'event.edit',
    'adapter.run', 'adapter.pace', 'adapter.source',
    'colors.edit', 'links.edit', 'logo.edit',
    'people.manage',
  ]),
  // Everything the day-to-day work needs, minus the three that are hard to
  // undo or reach beyond one parish: a delete, an acronym (a URL namespace
  // change), and the jurisdiction colours (site-wide, and they repaint cards).
  editor: new Set([
    'parish.edit', 'parish.create',
    'schedule.edit', 'schedule.create', 'schedule.delete',
    'override.edit', 'event.edit',
    'adapter.run', 'adapter.pace', 'adapter.source',
    'links.edit', 'logo.edit',
  ]),
  // A parish contact. Same verbs as an editor, but every one of them is
  // additionally checked against their own parish list — see mayTouchParish.
  // No create: a new parish is not their business, and it would be a way out
  // of their own scope.
  parish: new Set([
    'parish.edit',
    'schedule.edit', 'schedule.create', 'schedule.delete',
    'override.edit', 'event.edit',
    'links.edit', 'logo.edit',
  ]),
};

/** The role for somebody with no row, in a table that has rows. */
export const NO_ROLE = null;

/**
 * Resolve one person's role.
 *
 * Returns `{ role, parishIds, bootstrap }`. `bootstrap` is true when the table
 * was empty and the caller was granted owner by the rule above — the panel
 * renders a notice for it, because a deployment silently in that state looks
 * exactly like a configured one.
 *
 * A missing table reads as empty, so the code can deploy before the schema
 * change lands rather than 500ing for the window in between.
 */
export async function resolveRole(db, email) {
  let rows = [];
  try {
    const r = await db.prepare(
      'SELECT email, role, parish_ids FROM admin_roles'
    ).all();
    rows = r.results || [];
  } catch {
    return { role: 'owner', parishIds: [], bootstrap: true };
  }

  if (!rows.length) return { role: 'owner', parishIds: [], bootstrap: true };

  // Case-insensitive: an identity provider may hand back a different casing
  // than whoever typed the row, and "why can't Fr John get in" is a poor
  // afternoon.
  const want = String(email || '').trim().toLowerCase();
  const row = rows.find(r => String(r.email || '').trim().toLowerCase() === want);
  if (!row || !ROLES.includes(row.role)) return { role: NO_ROLE, parishIds: [], bootstrap: false };

  return {
    role: row.role,
    parishIds: parseParishIds(row.parish_ids),
    bootstrap: false,
  };
}

/** `parish_ids` is a JSON array of parish ids. Anything else reads as none. */
export function parseParishIds(raw) {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : [];
  } catch {
    return [];
  }
}

/** May this role do this thing at all, ignoring which parish it is done to? */
export function can(role, capability) {
  if (!role) return false;
  const set = CAPABILITIES[role];
  return !!set && set.has(capability);
}

/**
 * May this person act on this particular parish?
 *
 * Only the `parish` role is scoped; owner and editor act across the table. A
 * parish-scoped user with an empty list can touch nothing, which is the right
 * reading of "scoped to these parishes" when the list is empty — and is why
 * the panel refuses to save that combination.
 */
export function mayTouchParish({ role, parishIds }, parishId) {
  if (!role) return false;
  if (role !== 'parish') return true;
  return !!parishId && parishIds.includes(parishId);
}

/**
 * The refusal, as a sentence worth reading.
 *
 * Says which role you have and what it lacks, because "Forbidden" sends
 * somebody to ask the owner a question the panel could have answered.
 */
export function denial(role, capability) {
  if (!role) {
    return 'Your account is not on the admin list for this site. Ask an owner to add you.';
  }
  return `A ${role} cannot ${CAPABILITY_WORDS[capability] || capability}.`;
}

const CAPABILITY_WORDS = {
  'parish.delete': 'delete a parish',
  'parish.create': 'add a parish',
  'parish.acronym': "change a parish's acronym, because that changes its public link",
  'colors.edit': 'change the jurisdiction colours, because they apply site-wide',
  'people.manage': 'manage who has access',
  'adapter.pace': 'change how often a scraper runs',
  'adapter.run': 'run a scraper',
  'adapter.source': "change where a parish's file is fetched from",
};

/** Everything the panel needs to render itself for this person. */
export function rolePayload({ role, parishIds, bootstrap }) {
  return {
    role,
    parishIds,
    bootstrap,
    can: Object.fromEntries(
      [...(CAPABILITIES.owner)].map(c => [c, can(role, c)])
    ),
  };
}
