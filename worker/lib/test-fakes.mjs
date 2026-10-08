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

// ── The Messages API, for the poster reader ──
//
// What Claude streams back, in the event shapes the API uses, and a fetch that
// answers with it in uneven byte chunks — so a chunk boundary lands inside an
// event, inside a line, inside a UTF-8 sequence.

/** A Messages API event stream carrying `text` in several deltas. */
export function haikuStream(text, { stop = 'end_turn', pieces = 7, extra = [] } = {}) {
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const size = Math.ceil(text.length / pieces);
  let out = ev('message_start', { message: { model: 'claude-haiku-4-5', usage: { input_tokens: 1800 } } })
    + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    + ev('ping', {});
  for (let i = 0; i < text.length; i += size) {
    out += ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(i, i + size) } });
  }
  for (const x of extra) out += x;
  out += ev('content_block_stop', { index: 0 })
    + ev('message_delta', { delta: { stop_reason: stop }, usage: { output_tokens: 412 } })
    + ev('message_stop', {});
  return out;
}

/** A fetch that answers once, streaming `body` in uneven byte chunks. */
export function fakeFetch(body, { status = 200 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const bytes = new TextEncoder().encode(body);
    let i = 0;
    const stream = new ReadableStream({
      pull(c) {
        if (i >= bytes.length) return c.close();
        const n = 1 + ((i * 7) % 53);
        c.enqueue(bytes.slice(i, i + n));
        i += n;
      },
    });
    return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
  };
  impl.calls = calls;
  return impl;
}

