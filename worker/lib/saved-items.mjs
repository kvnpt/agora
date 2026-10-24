// A signed-in person's favourites, lists, bookmarks and saved views: one row
// per account, the four parts as one JSON document (public/shared/saved.js
// says what a valid one is and how two become one).
//
// One row rather than a row per star because the page only ever wants all of
// it, and writes it whole: the account is the copy, so "unstarred on the
// phone" has to win over "still starred on the laptop", and replacing the
// document says that where a table of rows would need tombstones.
//
// Keyed by the address Access verified, lower-cased — the same key as
// admin_roles, parish_claims and parish_suggestions — and nothing the bundle
// reads, so a write here never bumps the data version (lib/data-version.mjs).
//
// The Worker creates the table IF NOT EXISTS on first use, with the DDL of
// migration 029, so the deploy and the migration land in either order.

import saved from '../../public/shared/saved.js';

export const SAVED_DDL = [
  `CREATE TABLE IF NOT EXISTS saved_items (
  email      TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
)`,
];

const ensured = new WeakSet();
export async function ensureSavedTable(db) {
  if (ensured.has(db)) return;
  await db.batch(SAVED_DDL.map(sql => db.prepare(sql)));
  ensured.add(db);
}

const keyOf = (identity) => String(identity).trim().toLowerCase();

/** The account's copy, or null when it has never saved one. */
export async function readSaved(db, identity) {
  await ensureSavedTable(db);
  const row = await db.prepare('SELECT data, updated_at FROM saved_items WHERE email = ?')
    .bind(keyOf(identity)).first();
  if (!row) return null;
  let data = null;
  try { data = JSON.parse(row.data); } catch { /* a bad row reads as empty */ }
  return { saved: saved.clean(data), updated_at: row.updated_at };
}

/**
 * Store `doc` as the account's copy — or, with `merge`, everything in it and
 * in the stored copy together, which is what a browser signing in for the
 * first time sends. The merge is made here, against the row as it is now,
 * rather than against whatever the browser read a moment before.
 */
export async function writeSaved(db, identity, doc, { merge = false } = {}) {
  await ensureSavedTable(db);
  let next = saved.clean(doc);
  if (merge) {
    const had = await readSaved(db, identity);
    if (had) next = saved.merge(had.saved, next);
  }
  const row = await db.prepare(
    `INSERT INTO saved_items (email, data, updated_at)
     VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     ON CONFLICT(email) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
     RETURNING updated_at`
  ).bind(keyOf(identity), JSON.stringify(next)).first();
  return { saved: next, updated_at: row ? row.updated_at : null };
}

/**
 * How many accounts have starred a parish: a count across every row's
 * favourites, read straight from the JSON, so a star needs no table of its
 * own and no migration. A scan, which is fine while accounts are counted in
 * the hundreds; past that, a counts table the PUT keeps would replace it.
 */
export async function favouriteCount(db, parishId) {
  await ensureSavedTable(db);
  const row = await db.prepare(
    `SELECT COUNT(DISTINCT s.email) AS n
     FROM saved_items s, json_each(s.data, '$.favourites') f
     WHERE json_extract(f.value, '$.id') = ?`
  ).bind(String(parishId)).first();
  return row ? row.n || 0 : 0;
}
