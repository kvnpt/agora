// A person's own calendar: one private link per account, which a phone
// subscribes to once and which follows what they Save from then on (Kevin,
// 19 Nov 2026: one subscription each, collected by Save, rather than one per
// service). routes/calendar.mjs serves it at /saved/<token>.ics.
//
// The token is the only key: a link that named the address would put it in
// every calendar server that fetches it. Random, 128 bits, and nothing else
// about the person. Keyed back to the address Access verified, lower-cased,
// as saved_items is, so the calendar reads the same row the page writes.
//
// Created IF NOT EXISTS on first use with migration 040's DDL, as
// saved_items is, so the deploy and the migration land in either order.

export const CALENDAR_LINKS_DDL = [
  `CREATE TABLE IF NOT EXISTS calendar_links (
  token      TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
)`,
];

const ensured = new WeakSet();
async function ensureTable(db) {
  if (ensured.has(db)) return;
  await db.batch(CALENDAR_LINKS_DDL.map(sql => db.prepare(sql)));
  ensured.add(db);
}

const keyOf = (identity) => String(identity).trim().toLowerCase();

/** 22 characters of base64url: 128 random bits. */
export function newToken() {
  const b = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** What a token looks like, checked before it costs a read. */
export const isToken = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{22}$/.test(t);

/** The account's token, made the first time it is asked for. */
export async function tokenFor(db, identity) {
  await ensureTable(db);
  const email = keyOf(identity);
  const had = await db.prepare('SELECT token FROM calendar_links WHERE email = ?').bind(email).first();
  if (had) return had.token;
  const token = newToken();
  // Two first asks at once: the second insert is ignored and both read back the winner.
  await db.prepare('INSERT INTO calendar_links (token, email) VALUES (?, ?) ON CONFLICT(email) DO NOTHING')
    .bind(token, email).run();
  const row = await db.prepare('SELECT token FROM calendar_links WHERE email = ?').bind(email).first();
  return row ? row.token : token;
}

/** Whose calendar a token is, or null. */
export async function identityOf(db, token) {
  if (!isToken(token)) return null;
  await ensureTable(db);
  const row = await db.prepare('SELECT email FROM calendar_links WHERE token = ?').bind(token).first();
  return row ? row.email : null;
}
