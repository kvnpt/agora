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
// rest runs after: a wait of SETTLE_MS for the text that comes with a
// poster, the image, the read (most take 7–10 seconds, a full programme
// 25), and the reply, sent by REPLY_BY_MS whether the read has finished or
// not. A read cut short leaves the draft 'reading', which the editor shows as
// one to read again.
//
// lib/whatsapp.mjs has the API; lib/draft-read.mjs the read.

import { json } from '../lib/router.mjs';
import { readSecret } from '../lib/secrets.mjs';
import { resolveRole, can, mayTouchParish } from '../lib/roles.mjs';
import { ensureDraftTables, draftPosterKey, getDraft, moveDraft } from '../lib/drafts.mjs';
import { readIntoDraft } from '../lib/draft-read.mjs';
import {
  whatsappConfig, ensureWhatsappTables, verifySignature, messagesOf, kindOf, fetchMedia, sendText,
  codeIn, groupOf, textsFor, parishNamed, pruneStatements, readSummary, draftLink, draftAt, REPLIES,
  IMAGE_TYPES, DAILY_LIMIT, LATE_TEXT_S,
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

  // The rest of the announcement: a poster's words come a moment after it,
  // or a moment before.
  await io.sleep(SETTLE_MS);
  const recent = async () => (await db.prepare(
    `SELECT id, type, body, sent_at, draft_id, outcome FROM whatsapp_messages
     WHERE phone = ? AND sent_at >= ? ORDER BY sent_at, rowid`
  ).bind(m.from, since(LATE_TEXT_S)).all()).results || [];
  const isImageRow = (r) => r.type === 'image';

  if (kind === 'text') {
    for (let tries = 0; ; tries++) {
      const rows = await recent();
      const me = rows.find(r => r.id === m.id);
      if (!me || me.outcome) return;                     // an image took it
      const group = groupOf(rows, m.id);
      const owner = group.filter(isImageRow).find(img => textsFor(group, img.id, isImageRow).some(t => t.id === m.id));
      if (owner && !owner.outcome && tries < 2) { await io.sleep(2500); continue; }   // it will take it
      if (owner && owner.draft_id) return addToDraft(env, io, m, owner.draft_id, who, { mark, reply });
      // Typed after a poster rather than forwarded with it ("it's at the hall",
      // "/snp"): a word about the draft just made, not an announcement of its own.
      const before = !m.forwarded && [...rows].reverse().find(r => r.id !== m.id && r.outcome === 'draft' && r.draft_id
        && r.sent_at <= m.sentAt);
      if (before) return addToDraft(env, io, m, before.draft_id, who, { mark, reply });
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

  // An image, with the texts that go with it.
  const rows = await recent();
  const group = groupOf(rows, m.id);
  const texts = textsFor(group, m.id, isImageRow).filter(r => !r.outcome);
  const claimed = await claim(db, texts.map(r => r.id), 'joined');
  const text = [m.text, ...texts.filter(r => claimed.includes(r.id)).map(r => r.body)].filter(Boolean).join('\n\n');
  return makeDraft(env, io, m, { who, link, text, claimed, image: true, mark, reply });
}

/** Take these messages for one draft, if nobody has: the ids this call got. */
async function claim(db, ids, outcome) {
  if (!ids.length) return [];
  const rows = (await db.prepare(
    `UPDATE whatsapp_messages SET outcome = ? WHERE id IN (${ids.map(() => '?').join(',')}) AND outcome IS NULL RETURNING id`
  ).bind(outcome, ...ids).all()).results || [];
  return rows.map(r => r.id);
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
 * has no choice to make. Otherwise it starts where they last drafted (or at
 * their first parish) and the read moves it to whose poster it is, if they
 * may edit that one (lib/draft-read.mjs `choose`).
 */
async function parishFor(db, who, email, text) {
  const mine = who.role === 'parish' ? who.parishIds : null;
  const listed = (await db.prepare(
    "SELECT id, acronym FROM parishes WHERE id != '_unassigned' AND acronym IS NOT NULL AND trim(acronym) != ''"
  ).all()).results || [];
  const named = parishNamed(text, listed.filter(p => mayTouchParish(who, p.id)));
  if (named) return { parishId: named, fixed: true };
  if (mine && mine.length === 1) return { parishId: mine[0], fixed: true };
  const last = (await db.prepare(
    "SELECT parish_id FROM drafts WHERE lower(created_by) = lower(?) AND parish_id != '_unassigned' ORDER BY id DESC LIMIT 20"
  ).bind(email).all()).results || [];
  const at = last.map(r => r.parish_id).find(id => mayTouchParish(who, id));
  if (at) return { parishId: at, fixed: false };
  if (mine && mine.length) return { parishId: mine[0], fixed: false };
  const none = await db.prepare("SELECT id FROM parishes WHERE id = '_unassigned'").first();
  return none ? { parishId: none.id, fixed: false } : null;
}

async function parishRow(db, id) {
  return db.prepare('SELECT id, name, acronym FROM parishes WHERE id = ?').bind(id).first();
}

async function makeDraft(env, io, m, { who, link, text, claimed, image = false, mark, reply }) {
  const db = env.DB;
  const { cfg, origin } = io;
  const today = await db.prepare(
    "SELECT COUNT(*) AS n FROM whatsapp_messages WHERE phone = ? AND outcome = 'draft' AND sent_at > ? AND id != ?"
  ).bind(m.from, m.sentAt - 86400, m.id).first();
  if (today && today.n >= DAILY_LIMIT) {
    await mark('limit');
    return reply(REPLIES.limit(origin));
  }

  let media = null;
  if (image) {
    media = await fetchMedia({ token: cfg.token, mediaId: m.mediaId, graph: cfg.graph, fetchImpl: io.fetchImpl });
    if (!media.ok) {
      console.error(`[whatsapp] ${m.id}: ${media.error}`);
      await mark('media-failed');
      // What it took goes back, to be read on its own.
      if (claimed.length) {
        await db.prepare(`UPDATE whatsapp_messages SET outcome = NULL WHERE id IN (${claimed.map(() => '?').join(',')})`)
          .bind(...claimed).run();
      }
      return reply(media.tooLarge ? REPLIES.tooLarge() : REPLIES.mediaFailed());
    }
    if (!IMAGE_TYPES[media.mediaType]) media.mediaType = m.mediaType;
  }

  const place = await parishFor(db, who, link.email, text);
  if (!place) { await mark('refused'); return reply(REPLIES.noRole(link.email, origin)); }
  let posterPath = null;
  if (media) {
    const key = draftPosterKey(place.parishId, IMAGE_TYPES[media.mediaType] || 'jpg');
    await env.ASSETS_BUCKET.put(key, media.bytes, {
      httpMetadata: { contentType: media.mediaType, cacheControl: 'public, max-age=86400' },
    });
    posterPath = `/${key}`;
  }
  const d = await db.prepare(
    `INSERT INTO drafts (parish_id, created_by, poster_path, source, message_text) VALUES (?, ?, ?, 'whatsapp', ?) RETURNING id`
  ).bind(place.parishId, link.email, posterPath, text || null).first();
  await db.batch([
    db.prepare("UPDATE whatsapp_messages SET outcome = 'draft', draft_id = ? WHERE id = ?").bind(d.id, m.id),
    ...(claimed.length ? [db.prepare(
      `UPDATE whatsapp_messages SET draft_id = ? WHERE id IN (${claimed.map(() => '?').join(',')})`
    ).bind(d.id, ...claimed)] : []),
  ]);
  const draft = { id: d.id, parish_id: place.parishId };

  const answer = async (draftNow, line) => {
    const p = await parishRow(db, (draftNow && draftNow.parish_id) || draft.parish_id);
    return reply(line(draftAt(p), draftLink(origin, p, draft.id)));
  };

  const apiKey = await readSecret(env.ANTHROPIC_API_KEY);
  if (!apiKey) return answer(null, (name, url) => REPLIES.unread(name, url));

  const choose = place.fixed ? null : (read) => {
    const to = read.parish && read.parish.parish_id;
    return to && to !== '_unassigned' && mayTouchParish(who, to) ? to : null;
  };
  const reading = readIntoDraft(env, draft, {
    apiKey, bytes: media ? media.bytes : null, mediaType: media ? media.mediaType : null,
    note: text, whatsapp: true, choose,
  }).catch(e => {
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
