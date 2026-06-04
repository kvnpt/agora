const { Router } = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDb, syncEventCoordsForParish } = require('../db');
const { geocode } = require('../geocode');
const { sendText } = require('../adapters/whatsapp-send');
const { expandWindow, parseInstanceId } = require('../schedule-expand');
const { applyAdminEdit, findInstanceOccurrence } = require('../schedule-overrides');

// Public-facing admin URL for deep links in outbound replies.
const ADMIN_BASE_URL = process.env.AGORA_ADMIN_URL || 'https://orthodoxy.au/admin';

const router = Router();

// Buffer messages by sender for batched processing
const BATCH_WINDOW_MS = 20000; // 20 seconds
const senderBuffers = new Map(); // sender -> { messages: [], timer: timeout }

/**
 * Get or create a sender record. New senders auto-approved by default.
 * Returns { phone, name, status }
 */
function getOrCreateSender(phone) {
  const db = getDb();
  let sender = db.prepare('SELECT * FROM senders WHERE phone = ?').get(phone);
  if (!sender) {
    db.prepare(
      "INSERT INTO senders (phone, status) VALUES (?, 'review')"
    ).run(phone);
    sender = db.prepare('SELECT * FROM senders WHERE phone = ?').get(phone);
    console.log(`[webhook] New sender registered: ${phone} (review)`);
  } else {
    db.prepare("UPDATE senders SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE phone = ?").run(phone);
  }
  return sender;
}

// GET /api/webhooks/whatsapp — Meta verification handshake
router.get('/', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (!verifyToken) {
    console.error('[webhook] WHATSAPP_VERIFY_TOKEN not configured');
    return res.sendStatus(500);
  }

  if (mode === 'subscribe' && token === verifyToken) {
    console.log('[webhook] WhatsApp verification successful');
    return res.status(200).send(challenge);
  }

  console.warn('[webhook] WhatsApp verification failed');
  return res.sendStatus(403);
});

// POST /api/webhooks/whatsapp — Receive incoming messages
router.post('/', (req, res) => {
  // Respond immediately — Meta expects 200 within ~20s
  res.sendStatus(200);

  try {
    const body = req.body;
    if (body.object !== 'whatsapp_business_account') return;

    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;
        const value = change.value;
        for (const message of value.messages || []) {
          bufferMessage(message);
        }
      }
    }
  } catch (err) {
    console.error('[webhook] POST handler error:', err.message);
  }
});

function bufferMessage(message) {
  const sender = message.from;
  const msgType = message.type;

  // Only buffer supported types
  if (!['text', 'image', 'document'].includes(msgType)) {
    console.log(`[webhook] Skipping unsupported message type: ${msgType}`);
    return;
  }

  // Admin keyword fast-path: skip ACK, skip batch window, reply immediately.
  if (msgType === 'text') {
    const kw = (message.text?.body || '').trim().toLowerCase();
    if (['admin', 'login', 'link', 'access'].includes(kw)) {
      const senderRecord = getOrCreateSender(sender);
      if (senderRecord.role === 'admin') {
        const { generateAdminToken } = require('./magic-auth');
        sendText(sender, 'Your Agora admin link:\n' + generateAdminToken(sender, null)).catch(() => {});
        return;
      }
    }
  }

  // Deduplicate by message.id across restarts — Meta retries unacknowledged
  // deliveries for up to 24h, so in-memory dedup alone isn't enough.
  if (message.id) {
    const db = getDb();
    const alreadySeen = db.prepare('SELECT 1 FROM wa_seen_message_ids WHERE id = ?').get(message.id);
    if (alreadySeen) {
      console.log(`[webhook] Skipping already-processed message id=${message.id} from ${sender}`);
      return;
    }
    db.prepare('INSERT OR IGNORE INTO wa_seen_message_ids (id) VALUES (?)').run(message.id);
    // Prune IDs older than 48h so the table stays small
    db.prepare("DELETE FROM wa_seen_message_ids WHERE seen_at < strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-48 hours')").run();
  }

  if (!senderBuffers.has(sender)) {
    senderBuffers.set(sender, { messages: [], seenIds: new Set(), timer: null });
    // ACK on the first message of a new batch window. Fire-and-forget so a
    // Meta outage never holds up the inbound handler. One ACK per batch —
    // subsequent messages inside the 10s sliding window reuse the buffer.
    sendText(sender, 'Listening for 20s…').catch(() => {});
  }

  const buffer = senderBuffers.get(sender);

  // Secondary in-memory dedup for same-session duplicates (multi-device delivery)
  if (message.id && buffer.seenIds.has(message.id)) {
    console.log(`[webhook] Skipping duplicate message id=${message.id} from ${sender}`);
    return;
  }
  if (message.id) buffer.seenIds.add(message.id);

  buffer.messages.push(message);

  // Reset the timer on each new message — the window slides
  if (buffer.timer) clearTimeout(buffer.timer);
  buffer.timer = setTimeout(() => {
    const batch = buffer.messages;
    senderBuffers.delete(sender);
    console.log(`[webhook] Batch from ${sender}: ${batch.length} message(s), processing...`);
    // Second ACK at window close — signals the batch is now locked and
    // Claude parsing has started. Fills the silent gap between the initial
    // ACK and the final result reply (which can take 10–30s after this).
    const closeText = batch.length > 1
      ? `Got your ${batch.length} messages. Processing…`
      : 'Processing…';
    sendText(sender, closeText).catch(() => {});
    processBatch(sender, batch).catch(err => {
      console.error('[webhook] processBatch error:', err.message);
    });
  }, BATCH_WINDOW_MS);
}

async function downloadMedia(mediaId) {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) throw new Error('WHATSAPP_ACCESS_TOKEN not set');

  // Step 1: Get media URL
  const metaResp = await fetch(
    `https://graph.facebook.com/v21.0/${mediaId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!metaResp.ok) throw new Error(`Media metadata fetch failed: ${metaResp.status}`);
  const metaJson = await metaResp.json();

  // Step 2: Download the actual media
  const mediaResp = await fetch(metaJson.url, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!mediaResp.ok) throw new Error(`Media download failed: ${mediaResp.status}`);

  // Step 3: Determine extension from MIME type
  const contentType = mediaResp.headers.get('content-type') || 'image/jpeg';
  const extMap = {
    'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
    'image/gif': '.gif', 'application/pdf': '.pdf'
  };
  const ext = extMap[contentType] || '.jpg';

  // Step 4: Write to disk
  const filename = `${crypto.randomBytes(8).toString('hex')}${ext}`;
  const filepath = path.join(__dirname, '..', 'data', 'posters', filename);
  const buffer = Buffer.from(await mediaResp.arrayBuffer());
  fs.writeFileSync(filepath, buffer);

  return { filepath, filename, mimeType: contentType };
}

// ── Deterministic parish matching ─────────────────────────────────────────
// Haiku extracts signals (saint_name, suburb, jurisdiction, explicit_new).
// This code does the actual lookup — no LLM needed for comparison.

const NOISE_WORDS = new Set([
  'church','orthodox','parish','community','cathedral','monastery',
  'chapel','archdiocese','diocese','the','of','and','a','an'
]);
const SAINT_SYNONYMS = [
  [/\barchangel michael\b/i, 'st michael'],
  [/\barchangel gabriel\b/i, 'st gabriel'],
  [/\barchangel raphael\b/i, 'st raphael'],
  [/\btheotokos\b/i,         'mary'],
  [/\bdormition\b/i,         'st mary'],
  [/\bannunciation\b/i,      'st mary'],
];
function expandSaints(s) {
  if (!s) return s;
  for (const [pat, repl] of SAINT_SYNONYMS) if (pat.test(s)) return s.replace(pat, repl);
  return s;
}
function normalizeTokens(str) {
  if (!str) return [];
  return str.toLowerCase()
    .replace(/[‘’‚‛]/g, "'")  // curly single quotes → ASCII
    .replace(/[“”„‟]/g, '"')  // curly double quotes → ASCII
    .replace(/\bsaint\b/g, 'st')
    .split(/[\s\-\&\/,\.'"]+/)
    .filter(t => t.length > 0 && !NOISE_WORDS.has(t));
}
function buildClarifierQ(candidates, saintName) {
  const list = candidates
    .map(p => p.name.split(',').pop().trim() + ' (' + p.jurisdiction + ')')
    .join(' or ');
  return `Which ${saintName || 'parish'} — ${list}?`;
}
// Jurisdictions Haiku is allowed to assert. Anything else (e.g. "other")
// is treated as null — don't constrain the search on unrecognized values.
const RECOGNIZED_JURISDICTIONS = new Set([
  'serbian','greek','antiochian','russian','romanian','macedonian'
]);

function matchParish(signal, parishes) {
  const { saint_name, suburb, explicit_new } = signal || {};
  // Only apply jurisdiction filter for values the prompt actually allows
  const jurisdiction = RECOGNIZED_JURISDICTIONS.has(signal && signal.jurisdiction)
    ? signal.jurisdiction : null;

  if (explicit_new) return { result: 'new' };
  if (!saint_name)  return { result: 'unknown' };

  const direct = scoreCandidates(saint_name, suburb, jurisdiction, parishes, false);
  if (direct.result !== 'new') return direct;

  // Fallback: try once more with saint synonym expansion. Signals like
  // "Archangel Michael" need this to match a parish stored as "St Michael";
  // signals like "Dormition" generally already match verbatim, so the
  // direct pass above succeeds and we never run the destructive replace.
  const expanded = scoreCandidates(saint_name, suburb, jurisdiction, parishes, true);
  return expanded;
}

function scoreCandidates(saintName, suburb, jurisdiction, parishes, useSynonyms) {
  const source = useSynonyms ? expandSaints(saintName) : saintName;
  const core = normalizeTokens(source).filter(t => t !== 'st' && t !== 'sts' && t !== 'ss');
  if (!core.length) return { result: 'unknown' };

  const suburbLc = suburb ? suburb.toLowerCase() : null;
  const scored = [];

  for (const p of parishes) {
    if (p.id === '_unassigned') continue;
    if (jurisdiction && p.jurisdiction !== jurisdiction) continue;

    const nameTokens = new Set(
      normalizeTokens((p.name + ' ' + (p.full_name || '')).replace(/\bsaint\b/g, 'st'))
    );
    if (!core.every(t => nameTokens.has(t))) continue;

    let score = 10;
    if (suburbLc) {
      const addr = (p.address || '').toLowerCase();
      if (addr.includes(suburbLc) || p.name.toLowerCase().includes(suburbLc)) score += 5;
    }
    if (jurisdiction) score += 5;
    scored.push({ parish: p, score });
  }

  if (!scored.length) return { result: 'new' };
  scored.sort((a, b) => b.score - a.score);

  const top = scored[0].score;
  const topGroup = scored.filter(s => s.score === top);

  if (topGroup.length === 1 && (top >= 15 || scored.length === 1))
    return { result: 'match', id: topGroup[0].parish.id };

  return {
    result: 'ambiguous',
    candidates: topGroup.map(s => s.parish),
    question: buildClarifierQ(topGroup.map(s => s.parish), saintName)
  };
}
function buildNewParish(signal) {
  const d = (signal && signal.explicit_new && signal.details) ? signal.details : {};
  const nameParts = [signal && signal.saint_name, signal && signal.suburb].filter(Boolean);
  return {
    name:         d.name         || nameParts.join(', ') || 'Unknown Parish',
    full_name:    d.full_name    || null,
    jurisdiction: d.jurisdiction || (signal && signal.jurisdiction) || 'other',
    address:      d.address      || null,
    lat:          d.lat          || null,
    lng:          d.lng          || null,
    website:      d.website      || null,
    email:        d.email        || null,
    phone:        d.phone        || null,
    acronym:      d.acronym      || null,
    chant_style:  d.chant_style  || null,
    live_url:     d.live_url     || null,
    languages:    d.languages    || ['English'],
  };
}

async function processBatch(sender, messages) {
  const db = getDb();
  const posterAdapter = require('../adapters/whatsapp-poster');

  const images = [];
  const texts = [];

  // Extract content from all messages in the batch
  for (const message of messages) {
    const msgType = message.type;

    if (msgType === 'text') {
      const body = message.text?.body;
      if (body) texts.push(body);
    } else if (msgType === 'image') {
      const media = await downloadMedia(message.image.id);
      images.push(media.filepath);
      if (message.image.caption) texts.push(message.image.caption);
    } else if (msgType === 'document') {
      const media = await downloadMedia(message.document.id);
      if (media.mimeType.startsWith('image/') || media.mimeType === 'application/pdf') {
        images.push(media.filepath);
      } else {
        console.log(`[webhook] Document type ${media.mimeType} not visually parseable, using caption/filename only`);
      }
      if (message.document.caption) texts.push(message.document.caption);
      if (message.document.filename) texts.push(`Filename: ${message.document.filename}`);
    }
  }

  if (images.length === 0 && texts.length === 0) return;

  // Log the adapter run. Persist sender_phone up-front so the By-Message
  // admin view can surface it even if processing fails mid-flight.
  const runRecord = db.prepare(
    'INSERT INTO adapter_runs (adapter_id, status, sender_phone) VALUES (?, ?, ?)'
  ).run('whatsapp-webhook', 'running', sender);
  const runId = runRecord.lastInsertRowid;

  try {
    // Fetch sender record early: needed for keyword check and blocked guard
    // before spending a Haiku call on the batch.
    const senderRecord = getOrCreateSender(sender);
    if (senderRecord.status === 'blocked') {
      console.log(`[webhook] Sender ${sender} is blocked, skipping batch`);
      db.prepare("UPDATE adapter_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), status = 'skipped', error_message = 'sender blocked' WHERE id = ?").run(runId);
      return;
    }

    // Admin keyword shortcut: single-word text from an admin sender requests
    // a magic login link without invoking Haiku.
    if (senderRecord.role === 'admin' && images.length === 0 && texts.length === 1) {
      const kw = texts[0].trim().toLowerCase();
      if (['admin', 'login', 'link', 'access'].includes(kw)) {
        const { generateAdminToken } = require('./magic-auth');
        const link = generateAdminToken(sender, null);
        sendText(sender, 'Your Agora admin link:\n' + link).catch(() => {});
        db.prepare("UPDATE adapter_runs SET status = 'success', finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(runId);
        return;
      }
    }

    // Upcoming events across all parishes so Claude can target a specific event
    // for a cancellation/consolidation (otherwise it invents a "CANCELLED" row).
    // v26: schedule occurrences are computed, so the list is the expanded feed
    // (instances with synthetic ids) UNION genuine one-offs — same as the public
    // feed. The model echoes these ids back in cancellations[].
    const upFrom = new Date(Date.now() - 86400000).toISOString();
    const upTo = new Date(Date.now() + 14 * 86400000).toISOString();
    const upcomingEvents = [
      ...expandWindow(db, upFrom, upTo)
        .filter(e => e.status === 'approved')
        .map(e => ({ id: e.id, parish_id: e.parish_id, title: e.title, start_utc: e.start_utc, event_type: e.event_type, languages: e.languages })),
      ...db.prepare(`
        SELECT id, parish_id, title, start_utc, event_type, languages
        FROM events
        WHERE source_adapter != 'schedule'
          AND status IN ('approved','pending_review')
          AND start_utc BETWEEN ? AND ?
      `).all(upFrom, upTo),
    ].sort((a, b) => (a.parish_id < b.parish_id ? -1 : a.parish_id > b.parish_id ? 1 : new Date(a.start_utc) - new Date(b.start_utc)));

    // If this is a text-only batch, check for a recent low-confidence run
    // still unresolved (no output). The new texts are likely the sender's
    // answer to that clarifier — pass the original context to Haiku so it
    // can interpret the answer correctly.
    let clarifierContext = null;
    if (images.length === 0) {
      const pendingLow = db.prepare(`
        SELECT r.input_texts, r.parish_match_question FROM adapter_runs r
        WHERE r.adapter_id = 'whatsapp-webhook'
          AND r.sender_phone = ?
          AND r.parish_match_confidence = 'low'
          AND r.events_created = 0
          AND r.status = 'success'
          AND r.started_at > datetime('now', '-24 hours')
          AND NOT EXISTS (
            SELECT 1 FROM adapter_runs r2
            WHERE r2.adapter_id = 'whatsapp-webhook'
              AND r2.sender_phone = ?
              AND r2.started_at > r.started_at
              AND (
                r2.events_created > 0
                OR EXISTS (SELECT 1 FROM schedules s       WHERE s.source_run_id = r2.id)
                OR EXISTS (SELECT 1 FROM pending_parish_updates ppu WHERE ppu.source_run_id = r2.id)
                OR EXISTS (SELECT 1 FROM pending_cancellations pc  WHERE pc.source_run_id = r2.id)
                OR EXISTS (SELECT 1 FROM parishes p         WHERE p.source_run_id = r2.id)
              )
          )
        ORDER BY r.started_at DESC LIMIT 1
      `).get(sender, sender);
      if (pendingLow && pendingLow.parish_match_question) {
        clarifierContext = {
          originalTexts: JSON.parse(pendingLow.input_texts || '[]'),
          question: pendingLow.parish_match_question,
        };
      }
    }

    let result = await posterAdapter.parseMessage({ images, texts, upcomingEvents, clarifierContext });
    let modelUsed = posterAdapter.defaultModel;

    // Escalate complex batches to the larger model. The default model flags
    // coupled multi-intent / ambiguous consolidations (and malformed output)
    // via result.escalate; re-parse the same batch with Sonnet and use that
    // richer result. Single `if`, not a loop — the escalation pass is told it
    // is final, so it never re-escalates.
    if (result.escalate) {
      console.log(`[webhook] Batch from ${sender} flagged complex — escalating ${posterAdapter.defaultModel} → ${posterAdapter.escalationModel}`);
      try {
        result = await posterAdapter.parseMessage({
          images, texts, upcomingEvents, clarifierContext,
          model: posterAdapter.escalationModel, escalated: true
        });
        modelUsed = posterAdapter.escalationModel;
      } catch (escErr) {
        console.error(`[webhook] Escalation parse failed, keeping ${posterAdapter.defaultModel} result: ${escErr.message}`);
      }
    }

    // Persist model I/O immediately so any crash in downstream DB writes still
    // leaves the raw response visible in admin review for debugging. Stores the
    // final model's response when escalation occurred.
    db.prepare(`
      UPDATE adapter_runs SET input_texts = ?, claude_response = ? WHERE id = ?
    `).run(JSON.stringify(texts), result.rawResponse || null, runId);

    // Deterministic parish matching — Haiku extracted signals, code does lookup.
    const allParishes = db.prepare(
      "SELECT id, name, full_name, jurisdiction, address, acronym FROM parishes WHERE id != '_unassigned'"
    ).all();

    // Acronym pre-check: if raw texts contain a known parish acronym (word-boundary,
    // case-insensitive), use that match directly — takes priority over signal analysis.
    // Covers cases where Haiku can't extract a saint name (e.g. input is just "AMCN")
    // AND cases where bad jurisdiction from Haiku would otherwise exclude the right parish.
    let acronymParishId = null;
    if (texts.length > 0) {
      const combined = texts.join(' ');
      const byAcronym = allParishes.filter(p => {
        if (!p.acronym) return false;
        const esc = p.acronym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp('\\b' + esc + '\\b', 'i').test(combined);
      });
      if (byAcronym.length === 1) {
        acronymParishId = byAcronym[0].id;
        console.log(`[webhook] Matched parish by acronym: ${acronymParishId} (${byAcronym[0].acronym})`);
      }
    }

    const matchResult = acronymParishId
      ? { result: 'match', id: acronymParishId }
      : matchParish(result.parishSignal || {}, allParishes);

    let parishMatchConfidence, parishMatchQuestion, newParishData;
    let parishId;

    if (matchResult.result === 'match') {
      parishMatchConfidence = 'high'; parishMatchQuestion = null;
      parishId = matchResult.id;      newParishData = null;
    } else if (matchResult.result === 'new') {
      parishMatchConfidence = 'high'; parishMatchQuestion = null;
      parishId = '_unassigned';
      newParishData = buildNewParish(result.parishSignal);
    } else if (matchResult.result === 'ambiguous') {
      parishMatchConfidence = 'low';  parishMatchQuestion = matchResult.question;
      parishId = '_unassigned';       newParishData = null;
    } else { // 'unknown'
      parishMatchConfidence = 'high'; parishMatchQuestion = null;
      parishId = '_unassigned';       newParishData = null;
    }

    // Low-confidence (ambiguous) overrides sender trust — route everything to
    // pending_review and send a clarifier. New parishes are always confident.
    const ambiguous = parishMatchConfidence === 'low';
    const effectiveStatus = ambiguous ? 'review' : senderRecord.status;
    const eventStatus = effectiveStatus === 'approved' ? 'approved' : 'pending_review';

    // Counters used to build the outbound result-reply summary below.
    let parishChangesN = 0;
    let newParishCreated = false;

    // Create new parish row when matchParish returned 'new'
    if (newParishData) {
      const np = newParishData;
      const newId = (np.jurisdiction || 'other') + '-' + (np.name || 'unknown').toLowerCase()
        .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      const existing = db.prepare('SELECT id FROM parishes WHERE id = ?').get(newId);
      if (!existing && np.name) {
        const lat = np.lat || -33.8688, lng = np.lng || 151.2093;
        db.prepare(`
          INSERT INTO parishes (id, name, full_name, jurisdiction, address, lat, lng, website, email, phone, languages, source_run_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(newId, np.name, np.full_name || null, np.jurisdiction || 'other',
          np.address || null, lat, lng, np.website || null, np.email || null, np.phone || null,
          np.languages ? JSON.stringify(np.languages) : '["English"]', runId);
        newParishCreated = true;
        console.log(`[webhook] Created new parish: ${newId} (${np.name})`);
        if (np.address) {
          geocode(np.address).then(coords => {
            if (coords) {
              db.prepare('UPDATE parishes SET lat = ?, lng = ? WHERE id = ?').run(coords.lat, coords.lng, newId);
              syncEventCoordsForParish(db, newId);
              console.log(`[webhook] Geocoded new parish ${newId}: ${coords.lat}, ${coords.lng}`);
            }
          });
        }
        parishId = newId;
      } else if (existing) {
        parishId = newId;
      }
    }

    // Handle parish updates + clears — additive by default, explicit-clear
    // via a separate allow-list so null in parish_updates can never be
    // destructive (prior bug: Claude emitted null for unmentioned fields,
    // which wiped every legitimate field on the row when approved).
    if (parishId !== '_unassigned') {
      const pu = result.parish_updates || {};
      const rawClears = Array.isArray(result.parish_clears) ? result.parish_clears : [];
      const puFields = ['name', 'full_name', 'address', 'website', 'email', 'phone', 'acronym', 'chant_style', 'live_url'];
      const allFields = new Set([...puFields, 'languages']);

      // Sets: drop nulls/empties defensively regardless of what the prompt said.
      const sets = {};
      for (const f of puFields) {
        if (f in pu && pu[f] != null && pu[f] !== '') sets[f] = pu[f];
      }
      if ('languages' in pu && Array.isArray(pu.languages) && pu.languages.length) {
        sets.languages = pu.languages;
      }

      // Clears: whitelisted field names only; dedupe; drop any that collide
      // with a set in the same payload (a set wins — can't set and clear same field).
      const clears = [...new Set(rawClears)]
        .filter(f => typeof f === 'string' && allFields.has(f) && !(f in sets));

      parishChangesN = Object.keys(sets).length + clears.length;
      if (Object.keys(sets).length || clears.length) {
        if (effectiveStatus === 'approved') {
          const frags = [];
          const vals = [];
          for (const [f, v] of Object.entries(sets)) {
            frags.push(`${f} = ?`);
            vals.push(f === 'languages' ? JSON.stringify(v) : v);
          }
          for (const f of clears) frags.push(`${f} = NULL`);
          vals.push(parishId);
          db.prepare(`UPDATE parishes SET ${frags.join(', ')} WHERE id = ?`).run(...vals);
          console.log(`[webhook] Updated parish ${parishId}: sets=[${Object.keys(sets).join(',')}] clears=[${clears.join(',')}]`);
          if (sets.address) {
            geocode(sets.address).then(coords => {
              if (coords) {
                db.prepare('UPDATE parishes SET lat = ?, lng = ? WHERE id = ?').run(coords.lat, coords.lng, parishId);
                syncEventCoordsForParish(db, parishId);
                console.log(`[webhook] Geocoded parish ${parishId}: ${coords.lat}, ${coords.lng}`);
              }
            });
          }
        } else {
          const changesJson = JSON.stringify({ sets, clears });
          const dupUpdate = db.prepare(
            "SELECT id FROM pending_parish_updates WHERE parish_id = ? AND proposed_changes = ? AND status = 'pending'"
          ).get(parishId, changesJson);
          if (dupUpdate) {
            console.log(`[webhook] Skipping duplicate parish update for ${parishId} (existing id=${dupUpdate.id})`);
          } else {
            db.prepare(`INSERT INTO pending_parish_updates (parish_id, proposed_changes, sender_phone, source_run_id)
                        VALUES (?, ?, ?, ?)`).run(parishId, changesJson, sender, runId);
            console.log(`[webhook] Queued parish update for review: ${parishId} sets=[${Object.keys(sets).join(',')}] clears=[${clears.join(',')}]`);
          }
        }
      }
    }

    // Handle schedules — respect sender status
    let schedulesCreated = 0;
    if (result.schedules && result.schedules.length && parishId !== '_unassigned') {
      const schedStatus = effectiveStatus === 'approved' ? 'approved' : 'pending_review';
      const schedActive = schedStatus === 'approved' ? 1 : 0;
      const insertSched = db.prepare(`
        INSERT INTO schedules (parish_id, day_of_week, start_time, end_time, title, event_type, languages, week_of_month, concurrent, active, status, source_run_id, hide_live)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const s of result.schedules) {
        // Directory screenshots often say "Sunday Liturgy" without a time.
        // Haiku returns the schedule with start_time:null; the column is NOT NULL,
        // so inserting would crash the entire batch. Skip and warn instead.
        if (!s.start_time || typeof s.day_of_week !== 'number') {
          console.warn(`[webhook] Skipping schedule with missing start_time/day_of_week (parish=${parishId}, title=${s.title})`);
          continue;
        }
        const r = insertSched.run(parishId, s.day_of_week, s.start_time,
          s.end_time || null, s.title, s.event_type || 'liturgy',
          s.languages ? JSON.stringify(s.languages) : null,
          s.week_of_month || null, s.concurrent ? 1 : 0, schedActive, schedStatus, runId, s.hide_live ? 1 : 0);
        if (r.changes > 0) schedulesCreated++;
      }
      if (schedulesCreated) console.log(`[webhook] Created ${schedulesCreated} schedules for ${parishId} (status=${schedStatus})`);
    }

    // Handle cancellations. For approved senders, flip the matched event
    // to status='cancelled' directly. For others, queue a pending_cancellation
    // row that the admin review UI surfaces inline with other review items.
    let cancellationsApplied = 0;
    let cancellationsQueued = 0;
    if (result.cancellations && result.cancellations.length && parishId !== '_unassigned') {
      for (const c of result.cancellations) {
        // Schedule instance (synthetic id) → cancelled override.
        const inst = parseInstanceId(c.event_id);
        if (inst) {
          const sched = db.prepare('SELECT parish_id FROM schedules WHERE id = ?').get(inst.scheduleId);
          if (!sched) { console.warn(`[webhook] Cancellation references unknown schedule instance ${c.event_id}, skipping`); continue; }
          if (sched.parish_id !== parishId) { console.warn(`[webhook] Cancellation instance ${c.event_id} belongs to ${sched.parish_id}, not ${parishId}, skipping`); continue; }
          if (effectiveStatus === 'approved') {
            const r = applyAdminEdit(db, inst.scheduleId, inst.date, { status: 'cancelled' });
            if (!r.error) { cancellationsApplied++; console.log(`[webhook] Cancelled instance ${c.event_id} (${parishId}) from approved sender ${sender}`); }
          } else {
            const existing = db.prepare(`SELECT id FROM pending_cancellations WHERE instance_id = ? AND status = 'pending'`).get(String(c.event_id));
            if (!existing) {
              db.prepare(`INSERT INTO pending_cancellations (instance_id, reason, sender_phone, source_run_id) VALUES (?, ?, ?, ?)`)
                .run(String(c.event_id), c.reason || null, sender, runId);
              cancellationsQueued++;
            }
          }
          continue;
        }
        const eventId = Number(c.event_id);
        if (!Number.isInteger(eventId) || eventId <= 0) continue;
        const target = db.prepare('SELECT id, parish_id, status FROM events WHERE id = ?').get(eventId);
        if (!target) {
          console.warn(`[webhook] Cancellation references unknown event id=${eventId}, skipping`);
          continue;
        }
        if (target.parish_id !== parishId) {
          console.warn(`[webhook] Cancellation event id=${eventId} belongs to ${target.parish_id}, not inferred parish ${parishId}, skipping`);
          continue;
        }
        if (target.status === 'cancelled') continue; // already cancelled
        if (effectiveStatus === 'approved') {
          db.prepare(`UPDATE events SET status = 'cancelled', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?`).run(eventId);
          cancellationsApplied++;
          console.log(`[webhook] Cancelled event ${eventId} (${target.parish_id}) from approved sender ${sender}`);
        } else {
          // Avoid duplicate pending rows for the same event
          const existing = db.prepare(`SELECT id FROM pending_cancellations WHERE event_id = ? AND status = 'pending'`).get(eventId);
          if (!existing) {
            db.prepare(`INSERT INTO pending_cancellations (event_id, reason, sender_phone, source_run_id) VALUES (?, ?, ?, ?)`)
              .run(eventId, c.reason || null, sender, runId);
            cancellationsQueued++;
          }
        }
      }
      if (cancellationsApplied || cancellationsQueued) {
        console.log(`[webhook] Cancellations: ${cancellationsApplied} applied, ${cancellationsQueued} queued for review`);
      }
    }

    // Use first poster image as the source poster for all events in batch
    const posterPath = images.length > 0 ? '/posters/' + path.basename(images[0]) : null;

    // Handle events
    // Headless upsert: used when no schedule occurrence matches (or sender is pending_review)
    const upsert = db.prepare(`
      INSERT INTO events (parish_id, source_adapter, title, description, start_utc, end_utc,
        event_type, source_hash, confidence, status, lat, lng, location_override, languages, poster_path, source_run_id, hide_live, parish_scoped, mutation_type)
      SELECT @parish_id, 'whatsapp-webhook', @title, @description, @start_utc, @end_utc,
        @event_type, @source_hash, 'ai-parsed', @status,
        p.lat, p.lng, @location_override, @languages, @poster_path, @source_run_id, @hide_live, @parish_scoped, 'headless'
      FROM parishes p WHERE p.id = @parish_id
      ON CONFLICT(source_hash) DO UPDATE SET
        status = CASE WHEN events.status = 'rejected' THEN excluded.status ELSE events.status END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `);

    // v26: the "adapt a schedule occurrence" match is computed, not a stored-row
    // query — see findInstanceOccurrence + applyAdminEdit in the loop below.

    let eventsCreated = 0;
    const tx = db.transaction(() => {
      for (const evt of result.events) {
        const hash = crypto.createHash('sha256')
          .update(`wa-webhook-${parishId}-${evt.date_str}-${evt.title}`)
          .digest('hex');

        // Adapted detection (trusted senders, known parish): a message event that
        // lands on a single schedule occurrence at the same parish (±3h) edits
        // that occurrence via a 'modified' override instead of creating a
        // duplicate one-off. 0 or 2+ matches → headless (admin can escalate).
        let adapted = false;
        if (eventStatus === 'approved' && parishId && parishId !== '_unassigned') {
          const occ = findInstanceOccurrence(db, parishId, evt.start_utc);
          if (occ) {
            const r = applyAdminEdit(db, occ.scheduleId, occ.date, {
              title: evt.title,
              start_utc: evt.start_utc,
              end_utc: evt.end_utc || null,
              description: evt.description || null,
              event_type: evt.event_type,
              languages: evt.languages ? JSON.stringify(evt.languages) : null,
              hide_live: evt.hide_live ? 1 : 0,
              parish_scoped: evt.parish_scoped ? 1 : 0,
            });
            if (!r.error) { eventsCreated++; adapted = true; }
          }
        }

        if (!adapted) {
          const r = upsert.run({
            parish_id: parishId,
            title: evt.title,
            description: evt.description,
            start_utc: evt.start_utc,
            end_utc: evt.end_utc,
            event_type: evt.event_type,
            source_hash: hash,
            location_override: evt.location_override,
            status: eventStatus,
            languages: evt.languages ? JSON.stringify(evt.languages) : null,
            poster_path: posterPath,
            source_run_id: runId,
            hide_live: evt.hide_live ? 1 : 0,
            parish_scoped: evt.parish_scoped ? 1 : 0
          });
          if (r.changes > 0) eventsCreated++;
        }
      }
    });
    tx();

    db.prepare(`
      UPDATE adapter_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
      status = 'success', events_found = ?, events_created = ?,
      parish_match_confidence = ?, parish_match_question = ? WHERE id = ?
    `).run(result.events.length, eventsCreated,
      parishMatchConfidence, parishMatchQuestion || null, runId);

    console.log(`[webhook] Batch from ${sender}: ${images.length} image(s), ${texts.length} text(s) → ${result.events.length} events, ${schedulesCreated} schedules, ${cancellationsApplied + cancellationsQueued} cancellations, parish=${parishId}, status=${eventStatus}, confidence=${parishMatchConfidence}, model=${modelUsed}`);

    // Result reply back to sender. Fire-and-forget — a Meta send failure must
    // not flip the already-processed batch to failed status.
    const cancellationsN = cancellationsApplied + cancellationsQueued;

    // Admin senders get a single-use magic link so tapping the reply opens
    // the admin review page with an active session.
    let magicLink = null;
    if (senderRecord.role === 'admin') {
      const { generateAdminToken } = require('./magic-auth');
      magicLink = generateAdminToken(sender, runId);
    }

    const summary = buildResultReply({
      ambiguous,
      question: parishMatchQuestion,
      eventsN: result.events.length,
      schedulesN: schedulesCreated,
      parishChangesN,
      cancellationsN,
      newParishCreated,
      applied: effectiveStatus === 'approved',
      magicLink
    });
    sendText(sender, summary, { runId }).catch(() => {});

  } catch (err) {
    db.prepare(`
      UPDATE adapter_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
      status = 'failed', error_message = ? WHERE id = ?
    `).run(err.message, runId);
    console.error('[webhook] Batch processing failed:', err.message);
    sendText(sender,
      `Hit a snag parsing that — admin will take a look.`,
      { runId }
    ).catch(() => {});
  }
}

// Compose the outbound WhatsApp summary for a finished batch.
// magicLink, when present, is appended to every reply variant so the sender
// can tap straight into the admin review page with an active session.
function buildResultReply({ ambiguous, question, eventsN, schedulesN, parishChangesN, cancellationsN, newParishCreated, applied, magicLink }) {
  const link = magicLink ? '\n' + magicLink : '';
  if (ambiguous) {
    return (question || "I wasn't sure which parish this is for. Can you clarify?") + link;
  }
  const total = eventsN + schedulesN + parishChangesN + cancellationsN + (newParishCreated ? 1 : 0);
  if (total === 0) {
    return `Couldn't find anything actionable in that. Want to rephrase?` + link;
  }
  const parts = [];
  if (eventsN) parts.push(`${eventsN} event${eventsN > 1 ? 's' : ''}`);
  if (schedulesN) parts.push(`${schedulesN} schedule${schedulesN > 1 ? 's' : ''}`);
  if (parishChangesN) parts.push(`${parishChangesN} parish change${parishChangesN > 1 ? 's' : ''}`);
  if (cancellationsN) parts.push(`${cancellationsN} cancellation${cancellationsN > 1 ? 's' : ''}`);
  if (newParishCreated) parts.push('new parish');
  const verdict = applied ? 'Applied.' : 'Pending review.';
  return `Parsed ${parts.join(', ')}. ${verdict}` + link;
}

module.exports = router;
