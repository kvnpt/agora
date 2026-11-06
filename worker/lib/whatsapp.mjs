// Agora's WhatsApp number: what the Cloud API sends us, and what we send back.
//
// Parishes announce on WhatsApp — a poster, and its words in the caption or
// in a message beside it. Copying the image into the editor and then the
// words is two trips (Kevin, 6 Nov 2026); forwarding the post to Agora's
// number is one. routes/ingest.mjs turns what arrives into a draft at the
// sender's parish; this file is everything about WhatsApp it needs, kept
// apart so the tests can drive it with a fake Graph API.
//
// Meta's Cloud API (developers.facebook.com/docs/whatsapp/cloud-api):
//   * a webhook: GET to verify it once (hub.verify_token), then a POST per
//     event, signed with the app secret (X-Hub-Signature-256);
//   * an image arrives as a media id, fetched in two steps with the token;
//   * a reply inside 24 hours of their message is a free "service" message.
//
// The phone is WhatsApp's wa_id: digits, country code first, no "+".
// docs/adapters.md ("door 1") and docs/people-and-access.md have the why.

export const GRAPH = 'https://graph.facebook.com/v23.0';

/** What a forwarded image can be, for the reader (routes/admin.mjs POSTER_TYPES). */
export const IMAGE_TYPES = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };
/** The reader's own limit. WhatsApp sends images far under it. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Drafts one phone may make in a day. */
export const DAILY_LIMIT = 30;
/** How long a link code lasts. */
export const CODE_MINUTES = 15;
/** A poster and a text this close together (seconds, each to the next) were sent as one. */
export const GROUP_GAP_S = 5;
/** A text this soon after a draft from the same phone (seconds) is added to it. */
export const LATE_TEXT_S = 120;
/** How long received messages are kept. */
const KEEP_DAYS = 30;

/**
 * The tables, made on first use as well as by migration 036 — the same
 * belt-and-braces as drafts.mjs. Identical DDL to d1/schema.sql; the test
 * compares them.
 */
export const WHATSAPP_DDL = [
  `CREATE TABLE IF NOT EXISTS whatsapp_links (
  phone      TEXT PRIMARY KEY,
  email      TEXT NOT NULL,
  name       TEXT,
  linked_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
)`,
  'CREATE INDEX IF NOT EXISTS idx_whatsapp_links_email ON whatsapp_links(email)',
  `CREATE TABLE IF NOT EXISTS whatsapp_codes (
  code       TEXT PRIMARY KEY,
  email      TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL
)`,
  `CREATE TABLE IF NOT EXISTS whatsapp_messages (
  id          TEXT PRIMARY KEY,
  phone       TEXT NOT NULL,
  type        TEXT NOT NULL,
  body        TEXT,
  media_id    TEXT,
  media_type  TEXT,
  sent_at     INTEGER NOT NULL,
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  draft_id    INTEGER,
  outcome     TEXT
)`,
  'CREATE INDEX IF NOT EXISTS idx_whatsapp_messages_phone ON whatsapp_messages(phone, sent_at)',
];

const ensured = new WeakSet();
export async function ensureWhatsappTables(db) {
  if (ensured.has(db)) return;
  await db.batch(WHATSAPP_DDL.map(sql => db.prepare(sql)));
  ensured.add(db);
}

/** What the number needs to work. Null when any of it is missing: the feature is off. */
export async function whatsappConfig(env, readSecret) {
  const [token, appSecret, verifyToken] = await Promise.all([
    readSecret(env.WHATSAPP_TOKEN), readSecret(env.WHATSAPP_APP_SECRET), readSecret(env.WHATSAPP_VERIFY_TOKEN),
  ]);
  const phoneNumberId = String(env.WHATSAPP_PHONE_NUMBER_ID || '').trim();
  const number = String(env.WHATSAPP_NUMBER || '').replace(/[^\d]/g, '');
  // WHATSAPP_GRAPH_URL is for `wrangler dev` against a local stand-in
  // (scripts/mock-whatsapp.mjs), as ANTHROPIC_BASE_URL is for the reader.
  const graph = String(env.WHATSAPP_GRAPH_URL || GRAPH).replace(/\/+$/, '');
  return { token, appSecret, verifyToken, phoneNumberId, number, graph,
    ready: !!(token && appSecret && verifyToken && phoneNumberId && number) };
}

// ── the webhook ──

const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

/**
 * Is this POST from Meta? X-Hub-Signature-256 is "sha256=" and the HMAC of
 * the raw body under the app secret. Compared in constant time.
 */
export async function verifySignature(secret, raw, header) {
  const want = /^sha256=([0-9a-f]{64})$/i.exec(String(header || '').trim());
  if (!secret || !want) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const body = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
  const got = hex(await crypto.subtle.sign('HMAC', key, body));
  const a = want[1].toLowerCase();
  let diff = 0;
  for (let i = 0; i < 64; i++) diff |= a.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

/**
 * The messages in a webhook POST, flattened: one per message, for our number
 * only. Status updates (sent, delivered, read) carry no messages and give none.
 *
 * @returns {Array<{id, from, name, type, text, mediaId, mediaType, filename, forwarded, sentAt}>}
 *   `type` is WhatsApp's — 'image', 'text', 'document', 'sticker', … — and
 *   `text` the body or the caption.
 */
export function messagesOf(payload, phoneNumberId) {
  const out = [];
  for (const entry of (payload && payload.entry) || []) {
    for (const change of entry.changes || []) {
      const v = change && change.value;
      if (!v || change.field !== 'messages' || !Array.isArray(v.messages)) continue;
      if (phoneNumberId && v.metadata && String(v.metadata.phone_number_id) !== String(phoneNumberId)) continue;
      const names = new Map((v.contacts || []).map(c => [String(c.wa_id), c.profile && c.profile.name]));
      for (const m of v.messages) {
        if (!m || !m.id || !m.from) continue;
        const media = m[m.type] && typeof m[m.type] === 'object' ? m[m.type] : {};
        out.push({
          id: String(m.id),
          from: String(m.from).replace(/[^\d]/g, ''),
          name: names.get(String(m.from)) || null,
          type: String(m.type || 'unknown'),
          text: m.type === 'text' ? String((m.text && m.text.body) || '') : String(media.caption || ''),
          mediaId: media.id ? String(media.id) : null,
          mediaType: media.mime_type ? String(media.mime_type).split(';')[0].trim().toLowerCase() : null,
          filename: media.filename ? String(media.filename) : null,
          // Forwarded from somewhere — a parish group — rather than typed.
          forwarded: !!(m.context && (m.context.forwarded || m.context.frequently_forwarded)),
          sentAt: Number(m.timestamp) || Math.floor(Date.now() / 1000),
        });
      }
    }
  }
  return out;
}

/** An image sent as a document (to keep its quality) is still an image. */
export const isImage = (m) => (m.type === 'image' || m.type === 'document') && !!IMAGE_TYPES[m.mediaType];

/**
 * A message as the reader takes it: 'image', 'text', 'pdf', 'ignore' (a
 * reaction, a status: nothing to answer) or 'other' (a video, a voice note).
 */
export function kindOf(m) {
  if (isImage(m)) return 'image';
  if (m.type === 'text') return m.text.trim() ? 'text' : 'ignore';
  if (m.type === 'document' && m.mediaType === 'application/pdf') return 'pdf';
  if (['reaction', 'system', 'unsupported', 'request_welcome', 'errors'].includes(m.type)) return 'ignore';
  return 'other';
}

// ── the Graph API ──

/**
 * An image's bytes: the media id gives a short-lived URL, which is fetched
 * with the same token.
 * @returns {Promise<{ok: true, bytes: ArrayBuffer, mediaType: string}|{ok: false, error: string}>}
 */
export async function fetchMedia({ token, mediaId, graph = GRAPH, fetchImpl = fetch }) {
  const auth = { authorization: `Bearer ${token}` };
  const meta = await fetchImpl(`${graph}/${encodeURIComponent(mediaId)}`, { headers: auth }).catch(() => null);
  if (!meta || !meta.ok) return { ok: false, error: `media lookup ${meta ? meta.status : 'failed'}` };
  const m = await meta.json().catch(() => ({}));
  if (!m.url) return { ok: false, error: 'media has no url' };
  if (m.file_size && Number(m.file_size) > MAX_IMAGE_BYTES) return { ok: false, error: 'too large', tooLarge: true };
  const res = await fetchImpl(m.url, { headers: auth }).catch(() => null);
  if (!res || !res.ok) return { ok: false, error: `media download ${res ? res.status : 'failed'}` };
  const bytes = await res.arrayBuffer();
  if (bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, error: 'too large', tooLarge: true };
  const mediaType = String(m.mime_type || res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  return { ok: true, bytes, mediaType };
}

/** A text back to the sender, quoting the message it answers. Never throws. */
export async function sendText({ token, phoneNumberId, to, body, replyTo = null, graph = GRAPH, fetchImpl = fetch }) {
  const res = await fetchImpl(`${graph}/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text',
      text: { body, preview_url: false },
      ...(replyTo ? { context: { message_id: replyTo } } : {}),
    }),
  }).catch(() => null);
  if (!res || !res.ok) {
    // 131030 is the test number's "not on the allowed list": a phone Meta has
    // not been told about can send to it, and is never answered.
    const detail = res ? await res.text().catch(() => '') : 'no response';
    console.error(`[whatsapp] reply to ${maskPhone(to)} failed: ${res ? res.status : ''} ${detail.slice(0, 300)}`);
    return false;
  }
  return true;
}

// ── linking a phone to an account ──

/** Six digits, from the platform's random source. */
export function newCode() {
  const n = new Uint32Array(1);
  crypto.getRandomValues(n);
  return String(n[0] % 1000000).padStart(6, '0');
}

/** "LINK 482193", as the account menu's button writes it — or the six digits alone. */
export function codeIn(text) {
  const m = /^\s*(?:link\s*)?(\d{3})\s*(\d{3})\s*$/i.exec(String(text || ''));
  return m ? m[1] + m[2] : null;
}

/** "+61 4•• ••• 678": enough to tell your phones apart, not enough to ring one. */
export function maskPhone(phone) {
  const d = String(phone || '').replace(/[^\d]/g, '');
  if (d.length < 6) return d ? '•••' : '';
  return `+${d.slice(0, 2)} ${d.slice(2, 3)}•• ••• ${d.slice(-3)}`;
}

/** https://wa.me/<number>?text=LINK%20482193: opens WhatsApp with the message written. */
export const linkUrl = (number, code) => `https://wa.me/${number}?text=${encodeURIComponent(`LINK ${code}`)}`;

// ── what goes with what ──

/**
 * A message's group: the run of messages from its phone, each within
 * GROUP_GAP_S of the next. Forwarding a poster and the text under it sends
 * two messages a second apart, which are one announcement.
 *
 * @param {Array<{id, sent_at}>} rows  the phone's recent messages, in the order they came
 */
export function groupOf(rows, id) {
  const i = rows.findIndex(r => r.id === id);
  if (i < 0) return [];
  let a = i, b = i;
  while (a > 0 && rows[a].sent_at - rows[a - 1].sent_at <= GROUP_GAP_S) a--;
  while (b < rows.length - 1 && rows[b + 1].sent_at - rows[b].sent_at <= GROUP_GAP_S) b++;
  return rows.slice(a, b + 1);
}

/**
 * The texts in a group that go with this image: each text goes with the
 * image before it, or the first image if it came before them all. So
 * [poster, words] and [words, poster] are one each, and [poster 1, words 1,
 * poster 2, words 2] two.
 */
export function textsFor(group, imageId, isImageRow) {
  const images = group.filter(isImageRow).map(r => r.id);
  if (!images.includes(imageId)) return [];
  let owner = images[0];
  const out = [];
  for (const r of group) {
    if (isImageRow(r)) { owner = r.id; continue; }
    if (r.type === 'text' && owner === imageId) out.push(r);
  }
  return out;
}

/**
 * A parish the words name: orthodoxy.au/snp anywhere in them, or words that
 * are only a link — "/snp", "snp". Among `parishes` ({id, acronym}) only.
 */
export function parishNamed(text, parishes) {
  const norm = (a) => String(a || '').toLowerCase().replace(/\s+/g, '');
  const by = new Map(parishes.filter(p => p.acronym).map(p => [norm(p.acronym), p.id]));
  const t = String(text || '');
  for (const m of t.matchAll(/orthodoxy\.au\/([a-z0-9-]{2,16})(?![a-z0-9-])/gi)) {
    if (by.has(norm(m[1]))) return by.get(norm(m[1]));
  }
  const only = /^\s*\/?([a-z0-9-]{2,16})\s*$/i.exec(t);
  return only && by.has(norm(only[1])) ? by.get(norm(only[1])) : null;
}

/** Delete what is past keeping: messages, and codes nobody sent. */
export function pruneStatements(db) {
  const cut = new Date(Date.now() - KEEP_DAYS * 86400e3).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  return [
    db.prepare('DELETE FROM whatsapp_messages WHERE received_at < ?').bind(cut),
    db.prepare('DELETE FROM whatsapp_codes WHERE expires_at < ?').bind(now),
  ];
}

// ── what we say back ──
//
// Plain, short, and always with the link: the person is on their phone.

const WEEKDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function when(card) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(card.date || '');
  if (!m) return '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  let s = `${WEEKDAY[d.getUTCDay()]} ${+m[3]} ${MONTH[+m[2] - 1]}`;
  const t = /^(\d{2}):(\d{2})$/.exec(card.start_time || '');
  if (t) {
    const h = +t[1];
    s += ` ${h % 12 || 12}${t[2] !== '00' ? `:${t[2]}` : ''}${h < 12 ? 'am' : 'pm'}`;
  }
  return s;
}

/** What a read made, in a line: "Mums Group, Fri 6 Nov 10am, and 2 more". */
export function readSummary(draft) {
  const cards = (draft.cards || []).filter(c => c.title || c.date);
  const services = (draft.read_services || []).length;
  const parts = [];
  if (cards.length) {
    const first = cards[0];
    const w = when(first);
    parts.push(`${first.title || 'an event'}${w ? `, ${w}` : ''}${cards.length > 1 ? `, and ${cards.length - 1} more` : ''}`);
  }
  if (services) parts.push(`${services} ${services === 1 ? 'service' : 'services'} for the timetable`);
  return parts.join('; ');
}

export const REPLIES = {
  notLinked: (origin) => `This is Agora (${host(origin)}). To add a parish's posters by sending them here, link this phone first: sign in at ${origin}, open the account menu, choose Link WhatsApp, and send the code it shows.`,
  linked: (email) => `Linked. Posters you send here become drafts for ${email}. Forward a poster with its words and I'll read it.`,
  badCode: () => 'That code didn\'t work. It may have run out: open Link WhatsApp again for a new one.',
  tooManyCodes: () => 'Too many codes that didn\'t work from this phone today. Try again tomorrow.',
  noRole: (email, origin) => `${email} can't add events at any parish yet. To become an editor, open ${origin} and choose Become an editor at the foot of the page.`,
  limit: (origin) => `That's ${DAILY_LIMIT} posters from this phone today, the most for one day. Send it again tomorrow, or add it at ${origin}.`,
  pdf: () => 'I can read pictures and text, not PDFs yet. Send a screenshot of it instead.',
  other: () => 'I can read posters (pictures) and text. Send a picture of it instead.',
  tooLarge: () => 'That picture is too large for me to read. Send a screenshot of it instead.',
  mediaFailed: () => 'I couldn\'t download that picture from WhatsApp. Send it again in a minute.',
  // `at` is "at St Nicholas, Punchbowl", or "without a parish yet".
  read: (summary, at, link) => summary
    ? `Got it: ${summary}. It's a draft ${at} until it's published: ${link}`
    : `Got it, but I couldn't find an event in it. It's a draft ${at}, to fill in: ${link}`,
  reading: (at, link) => `Got it. It's still being read, and will be a draft ${at}: ${link}`,
  readFailed: (error, at, link) => `Got it, but reading it didn't work (${String(error || '').replace(/[.\s]+$/, '')}). It's a draft ${at}; open it to read it again or fill it in: ${link}`,
  unread: (at, link) => `Got it. It's a draft ${at}: ${link}`,
  added: (at, link) => `Added that to the draft ${at}: ${link}`,
  moved: (at, link) => `Moved the draft to ${at.replace(/^at /, '')}: ${link}`,
};

/** Where a draft is, for a reply. */
export const draftAt = (parish) => (parish && parish.id !== '_unassigned' ? `at ${parish.name}` : 'without a parish yet');

function host(origin) {
  try { return new URL(origin).host; } catch { return 'orthodoxy.au'; }
}

/** The draft's link: its parish's card with the draft open over it. */
export function draftLink(origin, parish, draftId) {
  const slug = parish && parish.acronym ? String(parish.acronym).toLowerCase().replace(/\s+/g, '') : '';
  return `${origin}/${slug ? encodeURIComponent(slug) : ''}?draft=${draftId}`;
}
