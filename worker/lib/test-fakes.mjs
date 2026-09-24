// Stand-ins for R2 and the Cache API, for tests that need a version to be
// stored and a body to be cached without a Cloudflare runtime underneath.

export function fakeBucket() {
  const store = new Map();
  return {
    store,
    async get(k) { return store.has(k) ? { text: async () => store.get(k) } : null; },
    async put(k, v) { store.set(k, String(v)); },
  };
}

// The Cache API, minus expiry: enough to see what was stored and served.
export function fakeCache() {
  const store = new Map();
  return {
    store,
    async match(k) {
      const e = store.get(String(k));
      return e ? new Response(e.body, { headers: e.headers }) : undefined;
    },
    async put(k, res) {
      store.set(String(k), { body: await res.text(), headers: Object.fromEntries(res.headers) });
    },
  };
}
