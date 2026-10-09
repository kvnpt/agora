// "Become a contributor" — somebody asking to keep one parish's page right.
//
// The bottleneck is not code, it is coverage: hundreds of parishes and a few
// dozen timetables, because one person cannot keep three hundred parishes
// current. The roles, the asks, the bulletin poster and the series editor are
// all built for a parish contact; what was missing was a way to BECOME one
// that did not start with emailing the owner.
//
// THE DOOR IS IDENTITY, NOT A LIST. Cloudflare Access proves who somebody is
// (a one-time PIN to their own email address), and `admin_roles` decides what
// they may do — a signed-in person with no row is refused by every guarded
// route. So a claim is made by a VERIFIED address: the claimant signs in
// first, and the email on the claim is the one Access vouched for, never one
// they typed. An owner approving it is then granting a role to a mailbox that
// has demonstrably been opened by the person asking.
//
// Why a table of its own rather than an admin_proposals row: that table's
// `capability` is a CHECK constraint, and widening a CHECK in SQLite is a
// table rebuild. A claim is also not an ask an editor was refused — it is a
// stranger asking to be let in — and it carries different fields.
//
// Approving GRANTS, it never demotes: an owner or editor who claims a parish
// already covers it, and a parish contact gains the parish beside the ones
// they already hold.

const MAX = { name: 120, relation: 120, phone: 40, note: 1000 };

const clean = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/**
 * Check a claim before it is stored. Returns { ok, claim } or { ok: false, error }.
 * The email is NOT read from the body — the route supplies the verified one.
 */
export function validateClaim(body) {
  const b = body && typeof body === 'object' ? body : {};
  const parishId = clean(b.parish_id, 200);
  const name = clean(b.name, MAX.name);
  if (!parishId) return { ok: false, error: 'Which parish is this about?' };
  if (!name) return { ok: false, error: 'Tell us your name, so the owner knows who is asking.' };
  return {
    ok: true,
    claim: {
      parish_id: parishId,
      name,
      relation: clean(b.relation, MAX.relation) || null,
      phone: clean(b.phone, MAX.phone) || null,
      note: clean(b.note, MAX.note) || null,
    },
  };
}

/** May this person already edit that parish? Then there is nothing to claim. */
export function alreadyCovers(who, parishId) {
  if (!who || !who.role) return false;
  if (who.role === 'owner' || who.role === 'editor') return true;
  return (who.parishIds || []).includes(parishId);
}

/**
 * What approving a claim writes to admin_roles, given the row (if any) the
 * claimant already has. Grants only — never lowers a role.
 *
 * @returns {{ action: 'insert'|'update'|'none', role?: string, parishIds?: string[] }}
 */
export function planGrant(existing, parishId) {
  if (!existing) return { action: 'insert', role: 'parish', parishIds: [parishId] };
  if (existing.role === 'owner' || existing.role === 'editor') return { action: 'none' };
  const ids = Array.isArray(existing.parishIds) ? existing.parishIds : [];
  if (ids.includes(parishId)) return { action: 'none' };
  return { action: 'update', role: 'parish', parishIds: [...ids, parishId] };
}

/** One line for the owner's list. */
export function describeClaim(c, parishName) {
  const who = c.relation ? `${c.name} (${c.relation})` : c.name;
  return `${who} asks to keep ${parishName || c.parish_id} up to date.`;
}

/**
 * The table, made on first use as well as by migration 016.
 *
 * Identical DDL to d1/schema.sql — `npm run check:migrations` compares the
 * baseline with the migration, and this has to agree with both. It is here so
 * a deploy that lands before the migration is applied creates the table on the
 * first claim instead of failing it.
 */
export const CLAIMS_DDL = [
  `CREATE TABLE IF NOT EXISTS parish_claims (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  parish_id     TEXT NOT NULL REFERENCES parishes(id) ON DELETE CASCADE,
  email         TEXT NOT NULL,
  name          TEXT NOT NULL,
  relation      TEXT,
  phone         TEXT,
  note          TEXT,
  status        TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','approved','declined','withdrawn')),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  decided_by    TEXT,
  decided_at    TEXT,
  decision_note TEXT
)`,
  'CREATE INDEX IF NOT EXISTS idx_parish_claims_open ON parish_claims(status, created_at)',
];

export async function ensureClaimsTable(db) {
  await db.batch(CLAIMS_DDL.map(sql => db.prepare(sql)));
}
