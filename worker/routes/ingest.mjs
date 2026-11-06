// /api/ingest/whatsapp — a poster forwarded to Agora's WhatsApp number becomes a draft.
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
// app secret's signature on every POST does, and a phone is nobody until it
// is linked to an account that admin_roles lets add events — read again for
// every message, so a role taken away stops the phone too.
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

import { json } from '../lib/router.mjs';
import { readSecret } from '../lib/secrets.mjs';
import { resolveRole, can, mayTouchParish } from '../lib/roles.mjs';
import { ensureDraftTables, draftPosterKey, getDraft, moveDraft } from '../lib/drafts.mjs';
import { readIntoDraft } from '../lib/draft-read.mjs';
import {
  whatsappConfig, ensureWhatsappTables, verifySignature, messagesOf, kindOf, fetchMedia, sendText,
  codeIn, groupOf, picturesFor, parishNamed, pruneStatements, readSummary, draftLink, draftAt, REPLIES,
  IMAGE_TYPES, DAILY_LIMIT, LATE_TEXT_S, READ_BYTES,
} from '../lib/whatsapp.mjs';

/** How long to wait for the rest of an announcement: a poster's text, sent a moment after it. */
export const SETTLE_MS = 3000;
/** When the reply goes, read or not: inside waitUntil's 30 seconds, with room to send it. */
export const REPLY_BY_MS = 22000;
/** Codes that did not work, per phone per day, before it is told to stop. */
const BAD_CODES = 5;

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ','now')";
const realSleep = (ms) => new Promise(r => setTimeout(r, ms));

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
}

/** One message, from logged to answered. */
async function handle(env, io, m) {
  const db = env.DB;
  const { cfg, origin } = io;
  const kind = kindOf(m);
  const reply = (body) => sendText({ token: cfg.token, phoneNumberId: cfg.phoneNumberId, to: m.from, body,
    replyTo: m.id, graph: cfg.graph, fetchImpl: io.fetchImpl });
  const mark = (outcome, draftId = null) => db.prepare(
    'UPDATE whatsapp_messages SET outcome = ?, draft_id = COALESCE(?, draft_id) WHERE id = ?'
  ).bind(outcome, draftId, m.id).run();
  const since = (seconds) => m.sentAt - seconds;
  if (kind === 'ignore') return mark('ignored');

  // A code first: it is how a phone nobody knows becomes somebody's.
  const code = kind === 'text' ? codeIn(m.text) : null;
  if (code) return linkPhone(db, m, code, { mark, reply });

  const link = await db.prepare('SELECT email, name FROM whatsapp_links WHERE phone = ?').bind(m.from).first();
  if (!link) {
    // Told how once an hour, not at every message.
    const told = await db.prepare(
      "SELECT 1 FROM whatsapp_messages WHERE phone = ? AND outcome = 'unlinked' AND sent_at > ? LIMIT 1"
    ).bind(m.from, since(3600)).first();
    await mark('unlinked');
    if (!told) await reply(REPLIES.notLinked(origin));
    return;
  }
  if (m.name && m.name !== link.name) {
    await db.prepare('UPDATE whatsapp_links SET name = ? WHERE phone = ?').bind(m.name, m.from).run();
  }
  const who = await resolveRole(db, link.email, { bootstrap: env.AGORA_DEV_ADMIN === 'true' });
  if (!can(who.role, 'event.edit')) { await mark('refused'); return reply(REPLIES.noRole(link.email, origin)); }
  if (kind === 'pdf') { await mark('refused'); return reply(REPLIES.pdf()); }
  if (kind === 'other') { await mark('refused'); return reply(REPLIES.other()); }

  // The rest of the announcement: a forward's other pictures, and its
  // words, which come a moment after the pictures or a moment before.
  await io.sleep(SETTLE_MS);
  const recent = async () => (await db.prepare(
    `SELECT id, type, body, media_id, media_type, sent_at, draft_id, outcome FROM whatsapp_messages
     WHERE phone = ? AND sent_at >= ? ORDER BY sent_at, rowid`
  ).bind(m.from, since(LATE_TEXT_S)).all()).results || [];
  const isImageRow = (r) => r.type === 'image';

  if (kind === 'text') {
    for (let tries = 0; ; tries++) {
      const rows = await recent();
      const me = rows.find(r => r.id === m.id);
      if (!me || me.outcome) return;                     // a picture took it
      const group = groupOf(rows, m.id);
      const pictures = group.filter(isImageRow);
      if (pictures.some(r => !r.outcome) && tries < 2) { await io.sleep(2500); continue; }   // one will take it
      // Here after its picture's draft was made: the nearest such picture
      // before it, or after it when the words came first.
      const before = pictures.filter(r => r.draft_id && r.sent_at <= m.sentAt).pop();
      const owner = before || pictures.find(r => r.draft_id);
      if (owner) return addToDraft(env, io, m, owner.draft_id, who, { mark, reply });
      // Typed after a poster rather than forwarded with it ("it's at the hall",
      // "/snp"): a word about the draft just made, not an announcement of its own.
      const typed = !m.forwarded && [...rows].reverse().find(r => r.id !== m.id && r.outcome === 'draft' && r.draft_id
        && r.sent_at <= m.sentAt);
      if (typed) return addToDraft(env, io, m, typed.draft_id, who, { mark, reply });
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
    return makeDraft(env, io, m, { who, link, text, claimed, mark, reply });
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
  return makeDraft(env, io, m, {
    who, link, text, mark, reply,
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

async function linkPhone(db, m, code, { mark, reply }) {
  const bad = await db.prepare(
    "SELECT COUNT(*) AS n FROM whatsapp_messages WHERE phone = ? AND outcome = 'bad-code' AND sent_at > ?"
  ).bind(m.from, m.sentAt - 86400).first();
  if (bad && bad.n >= BAD_CODES) { await mark('bad-code'); return reply(REPLIES.tooManyCodes()); }
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
