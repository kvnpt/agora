// Reading a secret out of `env`.
//
// Cloudflare hands one over in two shapes and does not tell you which:
//
//   Worker secret        (wrangler secret put, or Settings -> Variables)  -> a string
//   Secrets Store secret ([[secrets_store_secrets]] in wrangler.toml)     -> an object
//
// The object needs an awaited .get(). Reading it as a string is silently
// truthy, so a `if (!env.X) throw` guard passes and the value lands in a URL as
// "[object Object]" — the failure then surfaces wherever that URL was used,
// which is never where the mistake is.
//
// Both shapes are legitimate, so resolve rather than pick a side.

// A DECLARED binding whose secret is missing THROWS on .get(). Cloudflare
// answers `Secret "X" not found`, and wrangler.toml is the complete set of
// bindings, so this happens whenever a binding outlives the secret it names —
// a value deleted from the store, a store rotated, or a local dev session that
// never had it.
//
// Letting that throw defeats the thing this module exists for. requireAdmin is
// built to FAIL CLOSED with a 503 naming which of ACCESS_TEAM_DOMAIN and
// ACCESS_AUD is unreadable; a throw turns that into an opaque 500 and the
// guard's careful message is never seen. And an optional secret — the GitHub
// token — must be allowed to be absent without taking a route down with it.
//
// So a secret that cannot be read is the same as one that was never set. Both
// mean "not configured", every caller already handles null, and null is the
// answer that keeps the refusal readable.

/** @returns {Promise<string|null>} the value, or null if unset, empty or unreadable. */
export async function readSecret(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v.get === 'function') {
    try {
      return ((await v.get()) || '').trim() || null;
    } catch {
      return null;
    }
  }
  return null;
}
