// A stand-in for Meta's WhatsApp Cloud API, for driving /api/ingest/whatsapp
// under `wrangler dev` without a Meta app, a number or a phone. It serves an
// image as a media id, records every reply the Worker sends, and sends the
// Worker webhook POSTs signed as Meta signs them. docs/browser-checks.md has
// the recipe.
//
//   node scripts/mock-whatsapp.mjs serve [port]       # default 8789
//   wrangler dev ... --var WHATSAPP_GRAPH_URL:http://127.0.0.1:8789 \
//     --var WHATSAPP_TOKEN:local --var WHATSAPP_APP_SECRET:local-secret \
//     --var WHATSAPP_VERIFY_TOKEN:local --var WHATSAPP_PHONE_NUMBER_ID:111 \
//     --var WHATSAPP_NUMBER:15551234567
//
//   # A forwarded poster and its caption, from +61 412 345 678:
//   node scripts/mock-whatsapp.mjs send --image poster.png --caption "Mums Group…"
//   # Words alone (forwarded from a group), or a link code:
//   node scripts/mock-whatsapp.mjs send --forwarded --text "Youth night…"
//   node scripts/mock-whatsapp.mjs send --text "LINK 123456"
//   # What the Worker answered:
//   curl localhost:8789/__replies
//
// `send` takes --worker (default http://localhost:8787), --secret (default
// local-secret), --from (default 61412345678), --name (default Kevin) and
// --at (the message's second; a forward's pictures share one, so give each
// `send --image` of a forward the same --at).
//   AT=$(date +%s); node scripts/mock-whatsapp.mjs send --at $AT --image a.png --caption "…" &
//   node scripts/mock-whatsapp.mjs send --at $AT --image b.png

import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';

const [, , cmd = 'serve', ...rest] = process.argv;
const arg = (name, fallback = null) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 && rest[i + 1] != null ? rest[i + 1] : fallback;
};

if (cmd === 'serve') {
  const port = Number(rest[0]) || 8789;
  const media = new Map();   // id -> { bytes, mime }
  const replies = [];
  const read = (req) => new Promise(r => { const b = []; req.on('data', c => b.push(c)); req.on('end', () => r(Buffer.concat(b))); });
  http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type });
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
    };
    // The sender's half: put an image up as a media id.
    if (req.method === 'POST' && url.pathname === '/__media') {
      const id = `M${media.size + 1}`;
      media.set(id, { bytes: await read(req), mime: req.headers['content-type'] || 'image/jpeg' });
      return send(201, { id });
    }
    if (url.pathname === '/__replies') return send(200, replies);
    // The Worker's half: Graph API calls.
    if (req.method === 'POST' && /^\/[^/]+\/messages$/.test(url.pathname)) {
      const body = JSON.parse((await read(req)).toString() || '{}');
      replies.push({ at: new Date().toISOString(), to: body.to, text: body.text && body.text.body, reply_to: body.context && body.context.message_id });
      console.log(`reply to ${body.to}: ${body.text && body.text.body}`);
      return send(200, { messages: [{ id: `wamid.out${replies.length}` }] });
    }
    const dl = /^\/__download\/(.+)$/.exec(url.pathname);
    if (dl && media.has(dl[1])) return send(200, media.get(dl[1]).bytes, media.get(dl[1]).mime);
    const id = url.pathname.slice(1);
    if (req.method === 'GET' && media.has(id)) {
      const m = media.get(id);
      return send(200, { url: `http://127.0.0.1:${port}/__download/${id}`, mime_type: m.mime, file_size: m.bytes.length, id });
    }
    send(404, { error: { message: 'not found' } });
  }).listen(port, () => console.log(`mock whatsapp on ${port}`));
} else if (cmd === 'send') {
  const worker = arg('worker', 'http://localhost:8787');
  const graph = arg('graph', 'http://127.0.0.1:8789');
  const secret = arg('secret', 'local-secret');
  const from = arg('from', '61412345678');
  const id = `wamid.${crypto.randomUUID()}`;
  let message;
  const image = arg('image');
  if (image) {
    const mime = /\.png$/i.test(image) ? 'image/png' : 'image/jpeg';
    const up = await fetch(`${graph}/__media`, { method: 'POST', headers: { 'content-type': mime }, body: fs.readFileSync(image) });
    const { id: mediaId } = await up.json();
    const caption = arg('caption');
    message = { type: 'image', image: { id: mediaId, mime_type: mime, ...(caption ? { caption } : {}) }, context: { forwarded: true } };
  } else {
    // --forwarded: words forwarded from a group, read on their own; without
    // it, words typed a moment after a poster are a note on its draft.
    message = { type: 'text', text: { body: arg('text', 'hello') }, ...(rest.includes('--forwarded') ? { context: { forwarded: true } } : {}) };
  }
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15551234567', phone_number_id: '111' },
    contacts: [{ wa_id: from, profile: { name: arg('name', 'Kevin') } }],
    messages: [{ from, id, timestamp: String(arg('at', Math.floor(Date.now() / 1000))), ...message }],
  } }] }] });
  const sig = `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
  const res = await fetch(`${worker}/api/ingest/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig }, body });
  console.log(res.status, await res.text());
} else {
  console.error('usage: mock-whatsapp.mjs serve [port] | send [--image f --caption t | --text t]');
  process.exit(2);
}
