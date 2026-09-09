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

/** @returns {Promise<string|null>} the value, or null if unset or empty. */
export async function readSecret(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v.get === 'function') return ((await v.get()) || '').trim() || null;
  return null;
}
