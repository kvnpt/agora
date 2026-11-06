// /api/ingest/whatsapp — a poster forwarded to Agora's WhatsApp number becomes a draft.
// /api/suggest/whatsapp — the Suggest dialog's "Confirm on WhatsApp".
//
// Somebody who may add events links their phone once (the account menu's
// "Link WhatsApp" shows a code; they send it here). From then on, a poster
// they forward — with the words it came with, in its caption or in a text
// beside it — is read into a draft at their parish, exactly as if they had
// dropped it on the editor, and the number replies with the draft's link.
// The app shows it on the parish's + and on their home page until somebody
// opens it (routes/admin.mjs, GET /api/admin/ping). Nothing is published:
// the draft waits for a person, like every draft (docs/editing.md).
//
// OUTSIDE ACCESS. Meta calls this, so Cloudflare Access cannot guard it; the
// app secret's signature on every POST does, and a phone drafts nothing until
// it is linked to an account that admin_roles lets add events — read again
// for every message, so a role taken away stops the phone too.
//
// A PHONE NOBODY LINKED SUGGESTS (Kevin, 6 Nov 2026: WhatsApp alone, no
// email). Linking needs an account, and an account an email; somebody with
// only WhatsApp still has something to tell a parish. So what an unlinked
// phone sends — a poster, or words a read finds an event or a service in, or
// that carry a parish's link — is a suggestion to whoever keeps that parish
// (lib/suggestions.mjs), filed under the phone, as an emailed one is under
// the address Access verified. WhatsApp vouches for the number: Meta signed
// the message, and the number is the one it came from. Nothing is drafted
// and nothing published; a suggestion is a message. Words that are neither
// (a greeting, a question) are told how, once an hour. Every read is paid
// for, so a phone gets POSTER_DAILY_LIMIT reads a day and OPEN_LIMIT
// suggestions waiting, the limits an emailed sender has.
//
// The Suggest dialog's other way to send. Beside "Confirm email" it offers
// "Confirm on WhatsApp": what was typed (and its poster) is held here under a
// code, unread, and filed the moment the phone sends the message the dialog
// wrote, "… Code: 482 193". The dialog is outside Access too, so it holds
// nothing but that, for half an hour, ten codes an hour to an address.
//
// TIME. Meta wants its 200 at once, and work after a response gets 30
// seconds (waitUntil). So the message is logged and answered first, and the
// rest runs after: a wait of SETTLE_MS for the rest of the forward (its
// other pictures, and the text that comes with them), the pictures, the read
// (most take 7–10 seconds, a full programme 25), and the reply, sent by REPLY_BY_MS whether the read has finished or
// not. A read cut short leaves the draft 'reading', which the editor shows as
// one to read again.
//
// ONE FORWARD, ONE DRAFT. WhatsApp sends each picture of a forward as a
// message of its own, the caption on the first. The first of them to be
// handled takes the others and every word sent with them (whatsapp.mjs
// picturesFor), and they are read together. The draft's poster is the first
// picture; the rest wait in drafts.images until the editor joins them all,
// side by side, into the one poster (docs/editing.md).
//
// lib/whatsapp.mjs has the API; lib/draft-read.mjs the read.

import { json, readJson } from '../lib/router.mjs';
import { readSecret } from '../lib/secrets.mjs';
import { resolveRole, can, mayTouchParish } from '../lib/roles.mjs';
import { ensureDraftTables, draftPosterKey, getDraft, moveDraft } from '../lib/drafts.mjs';
import { readIntoDraft, readForSuggestion } from '../lib/draft-read.mjs';
import { ensureSuggestionsTable, suggestionPosterKey, fillFromRead, OPEN_LIMIT, POSTER_DAILY_LIMIT } from '../lib/suggestions.mjs';
import {
  whatsappConfig, ensureWhatsappTables, verifySignature, messagesOf, kindOf, fetchMedia, sendText,
  codeIn, groupOf, picturesFor, parishNamed, pruneStatements, readSummary, draftLink, draftAt, REPLIES,
  IMAGE_TYPES, DAILY_LIMIT, LATE_TEXT_S, READ_BYTES, MAX_IMAGE_BYTES, TICKET_MINUTES, TICKETS_PER_HOUR,
  phoneIdentity, ticketIn, ticketText, ticketUrl, newCode, newSecret, ticketsPastKeeping, keeperOf,
} from '../lib/whatsapp.mjs';

/** How long to wait for the rest of an announcement: a poster's text, sent a moment after it. */
export const SETTLE_MS = 3000;
/** When the reply goes, read or not: inside waitUntil's 30 seconds, with room to send it. */
export const REPLY_BY_MS = 22000;
/** Codes that did not work, per phone per day, before it is told to stop. */
const BAD_CODES = 5;

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const iso = (t = Date.now()) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
const realSleep = (ms) => new Promise(r => setTimeout(r, ms));
/** The most a Suggest dialog's words may be: a suggestion's own (lib/suggestions.mjs). */
const MAX = { name: 120, about: 200, body: 2000 };
const clip = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

/**
 * @param {Router} router
 * @param {object} [o]  for the tests: `sleep`, `fetchImpl` (the Graph API)
 */
export function registerIngestRoutes(router, { sleep = realSleep, fetchImpl = null } = {}) {
  // Meta's one-time check that the URL is ours: it echoes the challenge only
  // to whoever knows the verify token set in the Meta app.
  router.get('/api/ingest/whatsapp', async (c) => {
    const cfg = await whatsappConfig(c.env, readSecret);
    if (!cfg.verifyToken) return new Response('WhatsApp is not set up on this site.', { status: 503 });
    const q = c.query;
    if (q.get('hub.mode') !== 'subscribe' || q.get('hub.verify_token') !== cfg.verifyToken) {
      return new Response('Forbidden', { status: 403 });
    }
    return new Response(q.get('hub.challenge') || '', { headers: { 'content-type': 'text/plain' } });
  });

  router.post('/api/ingest/whatsapp', async (c) => {
    const { env, ctx } = c;
    const cfg = await whatsappConfig(env, readSecret);
    if (!cfg.ready) return json({ error: 'WhatsApp is not set up on this site.' }, 503);
    const raw = await c.request.arrayBuffer();
    if (!await verifySignature(cfg.appSecret, raw, c.request.headers.get('x-hub-signature-256'))) {
      return json({ error: 'Bad signature' }, 401);
    }
    let payload = null;
    try { payload = JSON.parse(new TextDecoder().decode(raw)); } catch { /* answered below */ }
    const msgs = messagesOf(payload, cfg.phoneNumberId);
    if (!msgs.length) return json({ ok: true });

    const db = env.DB;
    await ensureWhatsappTables(db);
    await ensureDraftTables(db);
    // Logged first, by WhatsApp's own id: a delivery Meta repeats — it does,
    // whenever an answer is slow — finds its row there and does nothing.
    const logged = await db.batch([
      ...msgs.map(m => db.prepare(
        `INSERT INTO whatsapp_messages (id, phone, type, body, media_id, media_type, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING RETURNING id`
      ).bind(m.id, m.from, kindOf(m), m.text || null, m.mediaId, m.mediaType, m.sentAt)),
      ...pruneStatements(db),
    ]);
    const fresh = msgs.filter((m, i) => logged[i] && (logged[i].results || []).length);
    if (!fresh.length) return json({ ok: true });

    const io = { cfg, origin: new URL(c.request.url).origin, sleep, fetchImpl: fetchImpl || fetch, started: Date.now() };
    const work = Promise.all(fresh.map(m => handle(env, io, m).catch(e => {
      console.error(`[whatsapp] ${m.id}: ${e && (e.stack || e.message)}`);
    })));
    if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
    else await work;   // the tests, which have no ctx
    return json({ ok: true });
  });

  // ── the Suggest dialog's "Confirm on WhatsApp" ──
  //
  // Whether to offer it, and the number to show somebody on a laptop.
  router.get('/api/suggest/whatsapp', async (c) => {
    const cfg = await whatsappConfig(c.env, readSecret);
    return json({ ready: cfg.ready, number: cfg.ready ? cfg.number : null });
  });

  // What they typed, held under a code until the phone sends it. Answered
  // with the code, the message that carries it, and a secret that is this
  // browser's alone: for its poster, and for asking whether it went.
  router.post('/api/suggest/whatsapp', async (c) => {
    const { env, request } = c;
    const cfg = await whatsappConfig(env, readSecret);
    if (!cfg.ready) return json({ error: 'WhatsApp is not set up on this site.' }, 503);
    const b = await readJson(request);
    const parish = await env.DB.prepare("SELECT id, name FROM parishes WHERE id = ? AND id != '_unassigned'")
      .bind(clip(b.parish_id, 200)).first();
    if (!parish) return json({ error: 'That parish was not found.' }, 404);
    const about = clip(b.about, MAX.about) || null;
    const body = clip(b.body, MAX.body) || null;
    const name = clip(b.name, MAX.name) || null;
    if (!body && b.poster !== true) return json({ error: 'Say what should change.', field: 'body' }, 400);

    const db = env.DB;
    await ensureWhatsappTables(db);
    await sweepTickets(env);
    const ip = request.headers.get('cf-connecting-ip') || '';
    const recent = await db.prepare('SELECT COUNT(*) AS n FROM whatsapp_tickets WHERE ip = ? AND created_at > ?')
      .bind(ip, iso(Date.now() - 3600e3)).first();
    if (recent && recent.n >= TICKETS_PER_HOUR) {
      return json({ error: 'That is a lot of suggestions from here in an hour. Try again later.' }, 429);
    }
    const expires = iso(Date.now() + TICKET_MINUTES * 60e3);
    const secret = newSecret();
    // A code nobody is waiting on; a clash with a live one is drawn again.
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      const row = await db.prepare(
        `INSERT INTO whatsapp_tickets (code, secret, parish_id, about, body, name, ip, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(code) DO NOTHING RETURNING code`
      ).bind(code, secret, parish.id, about, body, name, ip, expires).first().catch(() => null);
      if (row) {
        return json({
          secret, code, expires_at: expires, number: cfg.number,
          text: ticketText(parish.name, code), url: ticketUrl(cfg.number, parish.name, code),
        }, 201);
      }
    }
    return json({ error: 'Could not make a code — try again.' }, 503);
  });

  // Its poster, held in R2 unread: it is read once the code has come, and
  // goes with the row if it never does.
  router.post('/api/suggest/whatsapp/:secret/poster', async (c) => {
    const { env, request } = c;
    if (!env.ASSETS_BUCKET) return json({ error: 'Poster storage is not set up on this site.' }, 503);
    await ensureWhatsappTables(env.DB);
    const t = await env.DB.prepare('SELECT * FROM whatsapp_tickets WHERE secret = ? AND phone IS NULL AND expires_at >= ?')
      .bind(c.params.secret, iso()).first();
    if (!t) return json({ error: 'That has run out. Send your suggestion again.' }, 404);
    const mediaType = (request.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const ext = IMAGE_TYPES[mediaType];
    if (!ext) return json({ error: 'A poster has to be a JPEG, PNG, WebP or GIF image.' }, 415);
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength) return json({ error: 'No image received' }, 400);
    if (bytes.byteLength > MAX_IMAGE_BYTES) return json({ error: 'That image is over 5 MB, the most the reader takes.' }, 413);
    const key = suggestionPosterKey(t.parish_id, ext);
    await env.ASSETS_BUCKET.put(key, bytes, {
      httpMetadata: { contentType: mediaType, cacheControl: 'public, max-age=86400' },
    });
    const was = await env.DB.prepare(
      'UPDATE whatsapp_tickets SET poster_path = ? WHERE code = ? AND phone IS NULL RETURNING code'
    ).bind(`/${key}`, t.code).first();
    // The code came while this was on its way: the suggestion went without it.
    if (!was) { await env.ASSETS_BUCKET.delete(key); return json({ error: 'Your suggestion went without the poster.' }, 409); }
    if (t.poster_path) await env.ASSETS_BUCKET.delete(t.poster_path.replace(/^\//, ''));
    return json({ ok: true }, 201);
  });

  // Has it gone? The dialog asks while it waits, and says so when it has.
  router.get('/api/suggest/whatsapp/:secret', async (c) => {
    await ensureWhatsappTables(c.env.DB);
    const t = await c.env.DB.prepare(
      `SELECT t.outcome, t.phone, t.expires_at, p.name AS parish_name FROM whatsapp_tickets t
       LEFT JOIN parishes p ON p.id = t.parish_id WHERE t.secret = ?`
    ).bind(c.params.secret).first();
    if (!t) return json({ status: 'expired' }, 404);
    const status = t.outcome === 'sent' ? 'sent' : t.outcome ? 'refused' : t.phone ? 'sending'
      : t.expires_at < iso() ? 'expired' : 'waiting';
    return json({ status, parish: t.parish_name || null, ...(status === 'refused' ? { reason: t.outcome } : {}) });
  });
}

/** Codes nobody sent: their posters out of R2 once they run out, and the rows a day later. */
async function sweepTickets(env) {
  const db = env.DB;
  const lapsed = (await db.prepare(
    'SELECT code, poster_path FROM whatsapp_tickets WHERE phone IS NULL AND poster_path IS NOT NULL AND expires_at < ? LIMIT 20'
  ).bind(iso()).all()).results || [];
  if (lapsed.length && env.ASSETS_BUCKET) {
    await env.ASSETS_BUCKET.delete(lapsed.map(t => t.poster_path.replace(/^\//, '')));
    await db.prepare('UPDATE whatsapp_tickets SET poster_path = NULL WHERE code IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(lapsed.map(t => t.code))).run();
  }
  await db.prepare('DELETE FROM whatsapp_tickets WHERE expires_at < ? AND (poster_path IS NULL OR phone IS NOT NULL)')
    .bind(ticketsPastKeeping()).run();
}

/** One message, from logged to answered. */
async function handle(env, io, m) {
  const db = env.DB;
  const { cfg, origin } = io;
  const kind = kindOf(m);
  const reply = (body) => sendText({ token: cfg.token, phoneNumberId: cfg.phoneNumberId, to: m.from, body,
    replyTo: m.id, graph: cfg.graph, fetchImpl: io.fetchImpl });
  const mark = (outcome, draftId = null, suggestionId = null) => db.prepare(
    `UPDATE whatsapp_messages SET outcome = ?, draft_id = COALESCE(?, draft_id),
       suggestion_id = COALESCE(?, suggestion_id) WHERE id = ?`
  ).bind(outcome, draftId, suggestionId, m.id).run();
  const since = (seconds) => m.sentAt - seconds;
  if (kind === 'ignore') return mark('ignored');

  // The Suggest dialog's code, from whichever phone sends it: what was typed
  // there is filed now, under this phone.
  const ticket = kind === 'text' && !m.forwarded ? ticketIn(m.text) : null;
  if (ticket) return confirmTicket(env, io, m, ticket, { mark, reply });
  // A link code: it is how a phone nobody knows becomes somebody's.
  const code = kind === 'text' ? codeIn(m.text) : null;
  if (code) return linkPhone(db, m, code, { mark, reply });

  // Where what it sends goes: a linked phone's is a draft, as its account;
  // anybody else's a suggestion, as the phone itself.
  const link = await db.prepare('SELECT email, name FROM whatsapp_links WHERE phone = ?').bind(m.from).first();
  let door;
  if (link) {
    if (m.name && m.name !== link.name) {
      await db.prepare('UPDATE whatsapp_links SET name = ? WHERE phone = ?').bind(m.name, m.from).run();
    }
    const who = await resolveRole(db, link.email, { bootstrap: env.AGORA_DEV_ADMIN === 'true' });
    if (!can(who.role, 'event.edit')) { await mark('refused'); return reply(REPLIES.noRole(link.email, origin)); }
    door = {
      column: 'draft_id', outcome: 'draft',
      add: (id) => addToDraft(env, io, m, id, who, { mark, reply }),
      make: (o) => makeDraft(env, io, m, { who, link, mark, reply, ...o }),
    };
  } else {
    door = {
      column: 'suggestion_id', outcome: 'suggestion',
      add: (id) => addToSuggestion(env, io, m, id, { mark, reply }),
      make: (o) => makeSuggestion(env, io, m, { mark, reply, ...o }),
    };
  }
  if (kind === 'pdf') { await mark('refused'); return reply(REPLIES.pdf()); }
  if (kind === 'other') { await mark('refused'); return reply(REPLIES.other()); }

  // The rest of the announcement: a forward's other pictures, and its
  // words, which come a moment after the pictures or a moment before.
  await io.sleep(SETTLE_MS);
  const recent = async () => (await db.prepare(
    `SELECT id, type, body, media_id, media_type, sent_at, draft_id, suggestion_id, outcome FROM whatsapp_messages
     WHERE phone = ? AND sent_at >= ? ORDER BY sent_at, rowid`
  ).bind(m.from, since(LATE_TEXT_S)).all()).results || [];
  const isImageRow = (r) => r.type === 'image';
  const made = (r) => r[door.column];

  if (kind === 'text') {
    for (let tries = 0; ; tries++) {
      const rows = await recent();
      const me = rows.find(r => r.id === m.id);
      if (!me || me.outcome) return;                     // a picture took it
      const group = groupOf(rows, m.id);
      const pictures = group.filter(isImageRow);
      if (pictures.some(r => !r.outcome) && tries < 2) { await io.sleep(2500); continue; }   // one will take it
      // Here after its picture's draft (or suggestion) was made: the nearest
      // such picture before it, or after it when the words came first.
      const before = pictures.filter(r => made(r) && r.sent_at <= m.sentAt).pop();
      const owner = before || pictures.find(made);
      if (owner) return door.add(made(owner));
      // Typed after a poster rather than forwarded with it ("it's at the hall",
      // "/snp"): a word about the draft just made, not an announcement of its own.
      const typed = !m.forwarded && [...rows].reverse().find(r => r.id !== m.id && r.outcome === door.outcome && made(r)
        && r.sent_at <= m.sentAt);
      if (typed) return door.add(made(typed));
      break;
    }
    // Words alone: an announcement with no poster. The first of a run takes
    // the run; a text whose poster never came to anything goes on its own.
    const rows = await recent();
    const group = groupOf(rows, m.id);
    const ids = group.some(isImageRow) ? [m.id] : group.filter(r => r.type === 'text' && !r.outcome).map(r => r.id);
    const claimed = await claim(db, ids, 'joined');
    if (!claimed.includes(m.id)) return;
    const text = group.filter(r => claimed.includes(r.id)).map(r => r.body).filter(Boolean).join('\n\n');
    return door.make({ text, claimed });
  }

  // A picture: with the forward's other pictures and its words, one draft —
  // unless another of its pictures has taken it.
  const rows = await recent();
  const group = groupOf(rows, m.id);
  const pictures = picturesFor(group, m.id, isImageRow);
  if (!pictures.length) return;
  const texts = group.filter(r => r.type === 'text' && !r.outcome);
  const claimed = await claim(db, [...pictures, ...texts].map(r => r.id), 'joined');
  if (!claimed.includes(m.id)) return release(db, claimed);   // another picture's run has it
  const mine = group.filter(r => claimed.includes(r.id));
  const text = mine.map(r => r.body).filter(Boolean).join('\n\n');
  return door.make({
    text,
    claimed: mine.filter(r => !isImageRow(r)).map(r => r.id),
    pictures: mine.filter(isImageRow).map(r => ({ id: r.id, mediaId: r.media_id, mediaType: r.media_type })),
  });
}

/** Take these messages for one draft, if nobody has: the ids this call got. */
async function claim(db, ids, outcome) {
  if (!ids.length) return [];
  const rows = (await db.prepare(
    `UPDATE whatsapp_messages SET outcome = ? WHERE id IN (${ids.map(() => '?').join(',')}) AND outcome IS NULL RETURNING id`
  ).bind(outcome, ...ids).all()).results || [];
  return rows.map(r => r.id);
}

/** Give messages back, for whoever comes for them next. */
async function release(db, ids) {
  if (!ids.length) return;
  await db.prepare(`UPDATE whatsapp_messages SET outcome = NULL WHERE id IN (${ids.map(() => '?').join(',')})`)
    .bind(...ids).run();
}

/** Five codes that did not work in a day, link codes and the dialog's alike, and a phone is told to stop. */
async function tooManyBadCodes(db, m) {
  const bad = await db.prepare(
    "SELECT COUNT(*) AS n FROM whatsapp_messages WHERE phone = ? AND outcome = 'bad-code' AND sent_at > ?"
  ).bind(m.from, m.sentAt - 86400).first();
  return !!bad && bad.n >= BAD_CODES;
}

async function linkPhone(db, m, code, { mark, reply }) {
  if (await tooManyBadCodes(db, m)) { await mark('bad-code'); return reply(REPLIES.tooManyCodes()); }
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const row = await db.prepare('DELETE FROM whatsapp_codes WHERE code = ? AND expires_at >= ? RETURNING email')
    .bind(code, now).first();
  if (!row) { await mark('bad-code'); return reply(REPLIES.badCode()); }
  await db.prepare(
    `INSERT INTO whatsapp_links (phone, email, name) VALUES (?, ?, ?)
     ON CONFLICT(phone) DO UPDATE SET email = excluded.email, name = excluded.name, linked_at = ${NOW}`
  ).bind(m.from, row.email, m.name).run();
  await mark('linked');
  return reply(REPLIES.linked(row.email));
}

/**
 * Which parish a sender's draft starts at, and whether the read may move it.
 * A parish link in their words is theirs to say; a contact with one parish
 * has no choice to make. A contact of several starts where they last drafted
 * (or at their first parish). Somebody who may edit every parish (an owner,
 * an editor) starts at no parish: their posters are anybody's, and the last
 * one's parish says nothing about this one's — Kevin's run club poster went
 * to Kamariani that way. Either way the read moves it to whose poster it is,
 * if they may edit that one (lib/draft-read.mjs `choose`).
 */
async function parishFor(db, who, email, text) {
  const mine = who.role === 'parish' ? who.parishIds : null;
  const listed = (await db.prepare(
    "SELECT id, acronym FROM parishes WHERE id != '_unassigned' AND acronym IS NOT NULL AND trim(acronym) != ''"
  ).all()).results || [];
  const named = parishNamed(text, listed.filter(p => mayTouchParish(who, p.id)));
  if (named) return { parishId: named, fixed: true };
  if (mine && mine.length === 1) return { parishId: mine[0], fixed: true };
  const none = async () => {
    const row = await db.prepare("SELECT id FROM parishes WHERE id = '_unassigned'").first();
    return row ? { parishId: row.id, fixed: false } : null;
  };
  if (!mine) return none();
  const last = (await db.prepare(
    "SELECT parish_id FROM drafts WHERE lower(created_by) = lower(?) AND parish_id != '_unassigned' ORDER BY id DESC LIMIT 20"
  ).bind(email).all()).results || [];
  const at = last.map(r => r.parish_id).find(id => mayTouchParish(who, id));
  if (at) return { parishId: at, fixed: false };
  if (mine.length) return { parishId: mine[0], fixed: false };
  return none();
}

async function parishRow(db, id) {
  return db.prepare('SELECT id, name, acronym FROM parishes WHERE id = ?').bind(id).first();
}

/**
 * The draft, its pictures in R2, the read, and the reply.
 *
 * @param {object} o
 * @param {string} o.text        every word of the forward, in the order sent
 * @param {string[]} o.claimed   its texts, taken for this draft
 * @param {{id, mediaId, mediaType}[]} [o.pictures]  its pictures, in the order sent (m among them); none for words alone
 */
async function makeDraft(env, io, m, { who, link, text, claimed, pictures = [], mark, reply }) {
  const db = env.DB;
  const { cfg, origin } = io;
  const others = pictures.map(p => p.id).filter(id => id !== m.id);
  const markAll = (outcome) => Promise.all([mark(outcome), others.length ? db.prepare(
    `UPDATE whatsapp_messages SET outcome = ? WHERE id IN (${others.map(() => '?').join(',')})`
  ).bind(outcome, ...others).run() : null]);
  const today = await db.prepare(
    "SELECT COUNT(*) AS n FROM whatsapp_messages WHERE phone = ? AND outcome = 'draft' AND sent_at > ? AND id != ?"
  ).bind(m.from, m.sentAt - 86400, m.id).first();
  if (today && today.n >= DAILY_LIMIT) {
    await markAll('limit');
    return reply(REPLIES.limit(origin));
  }

  // Every picture, or as many as WhatsApp gives: one it will not is left out.
  const fetched = await Promise.all(pictures.map(async (p) => {
    const media = await fetchMedia({ token: cfg.token, mediaId: p.mediaId, graph: cfg.graph, fetchImpl: io.fetchImpl });
    if (!media.ok) { console.error(`[whatsapp] ${p.id}: ${media.error}`); return { ...p, media }; }
    if (!IMAGE_TYPES[media.mediaType]) media.mediaType = p.mediaType;
    return { ...p, media };
  }));
  const got = fetched.filter(p => p.media.ok);
  const failed = fetched.filter(p => !p.media.ok);
  if (pictures.length && !got.length) {
    await markAll('media-failed');
    // What it took goes back, to be read on its own.
    await release(db, claimed);
    return reply(failed.some(p => p.media.tooLarge) ? REPLIES.tooLarge() : REPLIES.mediaFailed());
  }
  if (failed.length) {
    await db.prepare(`UPDATE whatsapp_messages SET outcome = 'media-failed' WHERE id IN (${failed.map(() => '?').join(',')})`)
      .bind(...failed.map(p => p.id)).run();
  }

  const place = await parishFor(db, who, link.email, text);
  if (!place) { await markAll('refused'); return reply(REPLIES.noRole(link.email, origin)); }
  const paths = [];
  for (const p of got) {
    const key = draftPosterKey(place.parishId, IMAGE_TYPES[p.media.mediaType] || 'jpg');
    await env.ASSETS_BUCKET.put(key, p.media.bytes, {
      httpMetadata: { contentType: p.media.mediaType, cacheControl: 'public, max-age=86400' },
    });
    paths.push(`/${key}`);
  }
  // Its poster is the first picture; the rest wait in images for the editor
  // to join them all into one.
  const [posterPath = null, ...rest] = paths;
  const d = await db.prepare(
    `INSERT INTO drafts (parish_id, created_by, poster_path, images, source, message_text, sender_name)
     VALUES (?, ?, ?, ?, 'whatsapp', ?, ?) RETURNING id`
  ).bind(place.parishId, link.email, posterPath, rest.length ? JSON.stringify(rest) : null, text || null,
    m.name || link.name || null).first();
  // The draft is the first picture's (one a day's count counts); the rest of
  // the forward points at it.
  const joined = [...claimed, ...got.map(p => p.id).filter(id => id !== m.id)];
  await db.batch([
    db.prepare("UPDATE whatsapp_messages SET outcome = 'draft', draft_id = ? WHERE id = ?").bind(d.id, m.id),
    ...(joined.length ? [db.prepare(
      `UPDATE whatsapp_messages SET outcome = 'joined', draft_id = ? WHERE id IN (${joined.map(() => '?').join(',')})`
    ).bind(d.id, ...joined)] : []),
  ]);
  const draft = { id: d.id, parish_id: place.parishId };

  // A picture WhatsApp would not give is said, since the draft lacks it.
  const missing = failed.length
    ? ` I couldn't download ${failed.length === 1 ? 'one of the pictures' : `${failed.length} of the pictures`}; send ${failed.length === 1 ? 'it' : 'them'} again for a draft of ${failed.length === 1 ? 'its' : 'their'} own.`
    : '';
  const answer = async (draftNow, line) => {
    const p = await parishRow(db, (draftNow && draftNow.parish_id) || draft.parish_id);
    return reply(line(draftAt(p), draftLink(origin, p, draft.id)) + missing);
  };

  const apiKey = await readSecret(env.ANTHROPIC_API_KEY);
  if (!apiKey) return answer(null, (name, url) => REPLIES.unread(name, url));

  const choose = place.fixed ? null : (read) => {
    const to = read.parish && read.parish.parish_id;
    return to && to !== '_unassigned' && mayTouchParish(who, to) ? to : null;
  };
  // Read together, as many as the reader's request holds (READ_BYTES).
  const images = [];
  let bytes = 0;
  for (const p of got) {
    if (images.length && bytes + p.media.bytes.byteLength > READ_BYTES) break;
    bytes += p.media.bytes.byteLength;
    images.push({ bytes: p.media.bytes, mediaType: p.media.mediaType });
  }
  const reading = readIntoDraft(env, draft, { apiKey, images, note: text, whatsapp: true, choose }).catch(e => {
    console.error(`[whatsapp] read ${draft.id}: ${e && (e.stack || e.message)}`);
    return { ok: false, error: 'something went wrong', retry: true };
  });
  const left = Math.max(1000, REPLY_BY_MS - (Date.now() - io.started));
  const late = Symbol('late');
  const done = await Promise.race([reading, io.sleep(left).then(() => late)]);
  if (done === late) {
    await answer(await getDraft(db, draft.id), (name, url) => REPLIES.reading(name, url));
    await reading;   // and keep reading, for as long as there is
    return;
  }
  if (!done.ok) return answer(null, (name, url) => REPLIES.readFailed(done.error, name, url));
  return answer(done.draft, (name, url) => REPLIES.read(done.draft ? readSummary(done.draft) : '', name, url));
}

/**
 * Words about a draft just made: added to what it came with, which the
 * editor shows. A parish link among them moves it there, if the sender may
 * edit that parish and the read has finished with it.
 */
async function addToDraft(env, io, m, draftId, who, { mark, reply }) {
  const db = env.DB;
  const d = await db.prepare('SELECT id, parish_id, message_text, read_status, seen_at FROM drafts WHERE id = ?')
    .bind(draftId).first();
  if (!d) { await mark('ignored'); return; }
  await db.prepare(`UPDATE drafts SET message_text = ?, updated_at = ${NOW} WHERE id = ?`)
    .bind([d.message_text, m.text].filter(Boolean).join('\n\n'), d.id).run();
  await mark('added', d.id);
  let parishId = d.parish_id;
  const listed = (await db.prepare(
    "SELECT id, acronym FROM parishes WHERE id != '_unassigned' AND acronym IS NOT NULL AND trim(acronym) != ''"
  ).all()).results || [];
  const named = parishNamed(m.text, listed.filter(p => mayTouchParish(who, p.id)));
  if (named && named !== d.parish_id && d.read_status !== 'reading') {
    const draft = await getDraft(db, d.id);
    const to = await db.prepare('SELECT id, name, address FROM parishes WHERE id = ?').bind(named).first();
    await moveDraft(db, draft, to);
    parishId = named;
  }
  const p = await parishRow(db, parishId);
  const url = draftLink(io.origin, p, d.id);
  return reply(parishId !== d.parish_id ? REPLIES.moved(draftAt(p), url) : REPLIES.added(draftAt(p), url));
}

// ── a phone nobody linked: suggestions ──

/**
 * Suggestions this phone made today, and reads that found nothing: each was
 * read, and every read is paid for. The same day's limit as an emailed
 * sender's posters (lib/suggestions.mjs POSTER_DAILY_LIMIT).
 */
async function readsToday(db, m) {
  const r = await db.prepare(
    `SELECT COUNT(*) AS n FROM whatsapp_messages WHERE phone = ? AND outcome IN ('suggestion', 'not-a-suggestion')
     AND sent_at > ? AND id != ?`
  ).bind(m.from, m.sentAt - 86400, m.id).first();
  return r ? r.n : 0;
}

async function openSuggestions(db, identity) {
  await ensureSuggestionsTable(db);
  const r = await db.prepare("SELECT COUNT(*) AS n FROM parish_suggestions WHERE email = ? AND status = 'open'")
    .bind(identity).first();
  return r ? r.n : 0;
}

/** Every parish with a link of its own, for naming one in words ("/snp"). */
async function linkedParishes(db) {
  return (await db.prepare(
    "SELECT id, acronym FROM parishes WHERE id != '_unassigned' AND acronym IS NOT NULL AND trim(acronym) != ''"
  ).all()).results || [];
}

/** What a read found, in a line, for the reply (whatsapp.mjs readSummary). */
const summaryOf = (read) => (read ? readSummary({ cards: read.events || [], read_services: read.services || [] }) : '');

/** Did a read find anything a parish could be told: an event, or a service. */
const foundIn = (read) => !!read && read.kind !== 'not_an_event' && ((read.events || []).length + (read.services || []).length) > 0;

/** A suggestion, filed under a phone (or a linked phone's account), with its poster and pictures. */
async function fileSuggestion(db, { parishId, identity, name, kind, about = null, body = null, read = null, posterPath = null, images = [] }) {
  const f = fillFromRead({ title: null, date: null, start_time: null, end_time: null, place: null }, kind === 'event' ? read : null);
  const row = await db.prepare(
    `INSERT INTO parish_suggestions (parish_id, email, name, kind, about, body, title, date, start_time, end_time, place, images)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`
  ).bind(parishId, identity, clip(name, MAX.name) || null, kind, about, clip(body, MAX.body) || null,
    f.title, f.date, f.start_time, f.end_time, f.place, images.length ? JSON.stringify(images) : null).first();
  if (posterPath) {
    await db.prepare('INSERT INTO suggestion_posters (parish_id, email, poster_path, suggestion_id) VALUES (?, ?, ?, ?)')
      .bind(parishId, identity, posterPath, row.id).run();
  }
  return row.id;
}

/** A finished read, onto a suggestion filed before it: whose it is, and what it said, where still empty. */
async function applyRead(db, suggestionId, { read, parishId }) {
  const s = await db.prepare('SELECT * FROM parish_suggestions WHERE id = ?').bind(suggestionId).first();
  if (!s || s.status !== 'open') return;
  const f = fillFromRead(s, read);
  await db.batch([
    db.prepare('UPDATE parish_suggestions SET parish_id = ?, title = ?, date = ?, start_time = ?, end_time = ?, place = ? WHERE id = ?')
      .bind(parishId, f.title, f.date, f.start_time, f.end_time, f.place, s.id),
    db.prepare('UPDATE suggestion_posters SET parish_id = ? WHERE suggestion_id = ?').bind(parishId, s.id),
  ]);
}

/** Words that are not a suggestion: told how, once an hour, not at every message. */
async function notASuggestion(db, io, m, { read, mark, reply }) {
  const told = await db.prepare(
    `SELECT 1 FROM whatsapp_messages WHERE phone = ? AND outcome IN ('unlinked', 'not-a-suggestion')
     AND sent_at > ? AND id != ? LIMIT 1`
  ).bind(m.from, m.sentAt - 3600, m.id).first();
  await mark(read ? 'not-a-suggestion' : 'unlinked');
  if (!told) await reply(REPLIES.howToSuggest(io.origin));
}

/**
 * What a phone nobody linked sent, as a suggestion to whoever keeps the
 * parish. Its parish is the one its words link to; failing that, whose the
 * read says it is; failing that, none — and the reply asks for the link,
 * which a word typed after it gives (addToSuggestion). Owners and editors see
 * a suggestion with no parish; a parish's contacts see their own.
 *
 * Pictures are always one: somebody sent a poster. Words alone are one only
 * when they link a parish, or a read finds an event or a service in them.
 * A poster's suggestion is an event (Start a draft); words are a change,
 * unless the read found an event in them.
 */
async function makeSuggestion(env, io, m, { text, claimed, pictures = [], mark, reply }) {
  const db = env.DB;
  const { cfg } = io;
  const identity = phoneIdentity(m.from);
  const others = pictures.map(p => p.id).filter(id => id !== m.id);
  const markAll = (outcome) => Promise.all([mark(outcome), others.length ? db.prepare(
    `UPDATE whatsapp_messages SET outcome = ? WHERE id IN (${others.map(() => '?').join(',')})`
  ).bind(outcome, ...others).run() : null]);

  const open = await openSuggestions(db, identity);
  if (open >= OPEN_LIMIT) { await markAll('limit'); return reply(REPLIES.tooManyOpen(open)); }
  const named = parishNamed(text, await linkedParishes(db));
  const apiKey = await readSecret(env.ANTHROPIC_API_KEY);
  // Words that name their parish need no read; everything else is read.
  if (apiKey && (pictures.length || !named) && (await readsToday(db, m)) >= POSTER_DAILY_LIMIT) {
    await markAll('limit');
    return reply(REPLIES.suggestLimit(POSTER_DAILY_LIMIT));
  }
  const start = named || '_unassigned';
  const keeper = async (id) => keeperOf(await parishRow(db, id));

  if (!pictures.length) {
    let read = null, parishId = start;
    if (!named) {
      if (!apiKey) return notASuggestion(db, io, m, { read: false, mark, reply });
      const r = await readForSuggestion(env, start, { apiKey, note: text }).catch(e => {
        console.error(`[whatsapp] read ${m.id}: ${e && (e.stack || e.message)}`);
        return { ok: false };
      });
      if (!r.ok || !foundIn(r.read)) return notASuggestion(db, io, m, { read: true, mark, reply });
      ({ read, parishId } = r);
    }
    const kind = read && read.events.length ? 'event' : 'change';
    const id = await fileSuggestion(db, { parishId, identity, name: m.name, kind, body: text, read });
    await db.prepare(
      `UPDATE whatsapp_messages SET outcome = CASE id WHEN ? THEN 'suggestion' ELSE 'joined' END, suggestion_id = ?
       WHERE id IN (SELECT value FROM json_each(?))`
    ).bind(m.id, id, JSON.stringify([m.id, ...claimed])).run();
    return reply(REPLIES.suggested(await keeper(parishId), summaryOf(read)));
  }

  // Every picture, or as many as WhatsApp gives: one it will not is left out.
  const fetched = await Promise.all(pictures.map(async (p) => {
    const media = await fetchMedia({ token: cfg.token, mediaId: p.mediaId, graph: cfg.graph, fetchImpl: io.fetchImpl });
    if (!media.ok) { console.error(`[whatsapp] ${p.id}: ${media.error}`); return { ...p, media }; }
    if (!IMAGE_TYPES[media.mediaType]) media.mediaType = p.mediaType;
    return { ...p, media };
  }));
  const got = fetched.filter(p => p.media.ok);
  const failed = fetched.filter(p => !p.media.ok);
  if (!got.length) {
    await markAll('media-failed');
    await release(db, claimed);
    return reply(failed.some(p => p.media.tooLarge) ? REPLIES.tooLarge() : REPLIES.mediaFailed());
  }
  if (failed.length) {
    await db.prepare(`UPDATE whatsapp_messages SET outcome = 'media-failed' WHERE id IN (${failed.map(() => '?').join(',')})`)
      .bind(...failed.map(p => p.id)).run();
  }
  const paths = [];
  for (const p of got) {
    const key = suggestionPosterKey(start, IMAGE_TYPES[p.media.mediaType] || 'jpg');
    await env.ASSETS_BUCKET.put(key, p.media.bytes, {
      httpMetadata: { contentType: p.media.mediaType, cacheControl: 'public, max-age=86400' },
    });
    paths.push(`/${key}`);
  }
  // Filed before it is read, so neither the reply nor the list waits on the
  // reader; the read fills it in, and moves it to whose poster it is.
  const [posterPath, ...rest] = paths;
  const id = await fileSuggestion(db, { parishId: start, identity, name: m.name, kind: 'event', body: text, posterPath, images: rest });
  const joined = [...claimed, ...got.map(p => p.id).filter(x => x !== m.id)];
  await db.batch([
    db.prepare("UPDATE whatsapp_messages SET outcome = 'suggestion', suggestion_id = ? WHERE id = ?").bind(id, m.id),
    ...(joined.length ? [db.prepare(
      `UPDATE whatsapp_messages SET outcome = 'joined', suggestion_id = ? WHERE id IN (${joined.map(() => '?').join(',')})`
    ).bind(id, ...joined)] : []),
  ]);
  const missing = failed.length
    ? ` I couldn't download ${failed.length === 1 ? 'one of the pictures' : `${failed.length} of the pictures`}; send ${failed.length === 1 ? 'it' : 'them'} again.`
    : '';
  if (!apiKey) return reply(REPLIES.suggested(await keeper(start), '') + missing);

  const images = [];
  let bytes = 0;
  for (const p of got) {
    if (images.length && bytes + p.media.bytes.byteLength > READ_BYTES) break;
    bytes += p.media.bytes.byteLength;
    images.push({ bytes: p.media.bytes, mediaType: p.media.mediaType });
  }
  const reading = readForSuggestion(env, start, { apiKey, images, note: text, fixed: !!named })
    .then(async (r) => { if (r.ok) await applyRead(db, id, r); return r; })
    .catch(e => {
      console.error(`[whatsapp] read ${m.id}: ${e && (e.stack || e.message)}`);
      return { ok: false };
    });
  const left = Math.max(1000, REPLY_BY_MS - (Date.now() - io.started));
  const late = Symbol('late');
  const done = await Promise.race([reading, io.sleep(left).then(() => late)]);
  if (done === late) {
    await reply(REPLIES.suggestReading(await keeper(start)) + missing);
    await reading;
    return;
  }
  if (!done.ok) return reply(REPLIES.suggested(await keeper(start), '') + missing);
  return reply(REPLIES.suggested(await keeper(done.parishId), summaryOf(done.read)) + missing);
}

/**
 * Words typed after a suggestion just made, from the same phone: added to
 * it. A parish's link among them moves it there — the answer to "I couldn't
 * tell which parish it's for" — and a link alone is only that.
 */
async function addToSuggestion(env, io, m, suggestionId, { mark, reply }) {
  const db = env.DB;
  const s = await db.prepare('SELECT id, parish_id, body, status, email FROM parish_suggestions WHERE id = ?')
    .bind(suggestionId).first();
  if (!s || s.status !== 'open' || s.email !== phoneIdentity(m.from)) { await mark('ignored'); return; }
  const named = parishNamed(m.text, await linkedParishes(db));
  const parishId = named || s.parish_id;
  const rest = m.text.replace(/(?:https?:\/\/)?(?:www\.)?orthodoxy\.au\/[a-z0-9-]+/gi, '').trim();
  const onlyTheLink = !!named && (!rest || /^\/?[a-z0-9-]{2,16}$/i.test(rest));
  const body = onlyTheLink ? s.body : [s.body, m.text].filter(Boolean).join('\n\n');
  await db.batch([
    db.prepare('UPDATE parish_suggestions SET body = ?, parish_id = ? WHERE id = ?').bind(clip(body, MAX.body) || null, parishId, s.id),
    db.prepare('UPDATE suggestion_posters SET parish_id = ? WHERE suggestion_id = ?').bind(parishId, s.id),
  ]);
  await mark('added', null, s.id);
  const keeper = keeperOf(await parishRow(db, parishId));
  return reply(parishId !== s.parish_id && keeper ? REPLIES.suggestionMoved(keeper) : REPLIES.suggestionAdded(keeper));
}

/**
 * The Suggest dialog's code, arriving from a phone: what was typed there is
 * filed under it — or under its account, when the phone is linked to one —
 * and read, if it has a poster. The dialog sees it go (GET …/:secret).
 */
async function confirmTicket(env, io, m, code, { mark, reply }) {
  const db = env.DB;
  await ensureWhatsappTables(db);
  if (await tooManyBadCodes(db, m)) { await mark('bad-code'); return reply(REPLIES.tooManyCodes()); }
  const t = await db.prepare(
    'UPDATE whatsapp_tickets SET phone = ? WHERE code = ? AND phone IS NULL AND expires_at >= ? RETURNING *'
  ).bind(m.from, code, iso()).first();
  if (!t) { await mark('bad-code'); return reply(REPLIES.badTicket()); }
  const settle = (outcome, id = null) => db.prepare('UPDATE whatsapp_tickets SET outcome = ?, suggestion_id = ? WHERE code = ?')
    .bind(outcome, id, code).run();
  const parish = await db.prepare("SELECT id, name FROM parishes WHERE id = ? AND id != '_unassigned'").bind(t.parish_id).first();
  if (!parish) { await settle('gone'); await mark('refused'); return reply(REPLIES.badTicket()); }
  const link = await db.prepare('SELECT email FROM whatsapp_links WHERE phone = ?').bind(m.from).first();
  const identity = link ? link.email : phoneIdentity(m.from);
  const open = await openSuggestions(db, identity);
  if (open >= OPEN_LIMIT) { await settle('limit'); await mark('limit'); return reply(REPLIES.tooManyOpen(open)); }

  // Their poster makes it an event, its details what they wrote (the
  // dialog joined a service time to them); without one it is the change.
  const kind = t.poster_path ? 'event' : 'change';
  const id = await fileSuggestion(db, {
    parishId: parish.id, identity, name: t.name || m.name, kind,
    about: kind === 'change' ? t.about : null, body: t.body, posterPath: t.poster_path,
  });
  await settle('sent', id);
  await mark('suggestion', null, id);
  const keeper = keeperOf(parish);
  const apiKey = await readSecret(env.ANTHROPIC_API_KEY);
  const key = t.poster_path && t.poster_path.replace(/^\//, '');
  const obj = key && apiKey && env.ASSETS_BUCKET && (await readsToday(db, m)) < POSTER_DAILY_LIMIT
    ? await env.ASSETS_BUCKET.get(key) : null;
  if (!obj) return reply(REPLIES.suggested(keeper, ''));
  const images = [{ bytes: await obj.arrayBuffer(), mediaType: (obj.httpMetadata && obj.httpMetadata.contentType) || 'image/jpeg' }];
  const reading = readForSuggestion(env, parish.id, { apiKey, images, note: t.body || '', whatsapp: false, fixed: true })
    .then(async (r) => { if (r.ok) await applyRead(db, id, r); return r; })
    .catch(e => {
      console.error(`[whatsapp] read ${m.id}: ${e && (e.stack || e.message)}`);
      return { ok: false };
    });
  const left = Math.max(1000, REPLY_BY_MS - (Date.now() - io.started));
  const late = Symbol('late');
  const done = await Promise.race([reading, io.sleep(left).then(() => late)]);
  if (done === late) { await reply(REPLIES.suggested(keeper, '')); await reading; return; }
  return reply(REPLIES.suggested(keeper, done.ok ? summaryOf(done.read) : ''));
}
