const { Router } = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db');
const { geocode } = require('../geocode');

const router = Router();

// Buffer messages by sender for batched processing
const BATCH_WINDOW_MS = 10000; // 10 seconds
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

  if (!senderBuffers.has(sender)) {
    senderBuffers.set(sender, { messages: [], timer: null });
  }

  const buffer = senderBuffers.get(sender);
  buffer.messages.push(message);

  // Reset the timer on each new message — the window slides
  if (buffer.timer) clearTimeout(buffer.timer);
  buffer.timer = setTimeout(() => {
    const batch = buffer.messages;
    senderBuffers.delete(sender);
    console.log(`[webhook] Batch from ${sender}: ${batch.length} message(s), processing...`);
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

function resolveParish(db, inferredParish) {
  if (!inferredParish) return null;

  // Exact ID match
  const exact = db.prepare('SELECT id FROM parishes WHERE id = ?').get(inferredParish);
  if (exact) return exact.id;

  // Case-insensitive name match
  const byName = db.prepare('SELECT id FROM parishes WHERE LOWER(name) = LOWER(?)').get(inferredParish);
  if (byName) return byName.id;

  // Substring match
  const byLike = db.prepare('SELECT id FROM parishes WHERE LOWER(name) LIKE ?').get(`%${inferredParish.toLowerCase()}%`);
  if (byLike) return byLike.id;

  return null;
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

  // Log the adapter run
  const runRecord = db.prepare(
    'INSERT INTO adapter_runs (adapter_id, status) VALUES (?, ?)'
  ).run('whatsapp-webhook', 'running');
  const runId = runRecord.lastInsertRowid;

  try {
    // Fetch upcoming events across all parishes so Claude can target a
    // specific event when the message announces a cancellation (otherwise
    // the model invents a new "CANCELLED" row that never dedupes).
    const upcomingEvents = db.prepare(`
      SELECT id, parish_id, title, start_utc, event_type
      FROM events
      WHERE status IN ('approved','pending_review')
        AND start_utc BETWEEN datetime('now','-1 day') AND datetime('now','+14 days')
      ORDER BY parish_id, start_utc
    `).all();

    const result = await posterAdapter.parseMessage({ images, texts, upcomingEvents });
    const senderRecord = getOrCreateSender(sender);
    if (senderRecord.status === 'blocked') {
      console.log(`[webhook] Sender ${sender} is blocked, skipping batch`);
      db.prepare("UPDATE adapter_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), status = 'skipped', error_message = 'sender blocked' WHERE id = ?").run(runId);
      return;
    }
    const eventStatus = senderRecord.status === 'approved' ? 'approved' : 'pending_review';

    // Handle new parish creation
    let parishId = resolveParish(db, result.inferred_parish) || '_unassigned';
    if (!resolveParish(db, result.inferred_parish) && result.new_parish) {
      const np = result.new_parish;
      const newId = (np.jurisdiction || 'other') + '-' + (np.name || 'unknown').toLowerCase()
        .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      const existing = db.prepare('SELECT id FROM parishes WHERE id = ?').get(newId);
      if (!existing && np.name) {
        // Default to Sydney CBD; geocode async if address provided
        const lat = -33.8688, lng = 151.2093;
        db.prepare(`
          INSERT INTO parishes (id, name, full_name, jurisdiction, address, lat, lng, website, phone, languages)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(newId, np.name, np.full_name || null, np.jurisdiction || 'other',
          np.address || null, lat, lng, np.website || null, np.phone || null,
          np.languages ? JSON.stringify(np.languages) : '["English"]');
        console.log(`[webhook] Created new parish: ${newId} (${np.name})`);
        if (np.address) {
          geocode(np.address).then(coords => {
            if (coords) {
              db.prepare('UPDATE parishes SET lat = ?, lng = ? WHERE id = ?').run(coords.lat, coords.lng, newId);
              console.log(`[webhook] Geocoded new parish ${newId}: ${coords.lat}, ${coords.lng}`);
            }
          });
        }
        parishId = newId;
      } else if (existing) {
        parishId = newId;
      }
    }

    // Handle parish updates — buffer for review if sender is not auto-approved
    if (result.parish_updates && parishId !== '_unassigned') {
      const pu = result.parish_updates;
      if (senderRecord.status === 'approved') {
        // Apply directly
        const updates = [];
        const vals = [];
        const puFields = ['name', 'full_name', 'address', 'website', 'email', 'phone', 'acronym', 'chant_style', 'live_url'];
        for (const f of puFields) {
          if (f in pu) {
            const v = pu[f];
            updates.push(`${f} = ?`);
            vals.push(v === '' || v == null ? null : v);
          }
        }
        if ('languages' in pu) {
          updates.push('languages = ?');
          vals.push(pu.languages ? JSON.stringify(pu.languages) : null);
        }
        if (updates.length) {
          vals.push(parishId);
          db.prepare(`UPDATE parishes SET ${updates.join(', ')} WHERE id = ?`).run(...vals);
          console.log(`[webhook] Updated parish ${parishId}: ${updates.map(u => u.split(' =')[0]).join(', ')}`);
          // Auto-geocode if address was updated
          if (pu.address) {
            geocode(pu.address).then(coords => {
              if (coords) {
                db.prepare('UPDATE parishes SET lat = ?, lng = ? WHERE id = ?').run(coords.lat, coords.lng, parishId);
                console.log(`[webhook] Geocoded parish ${parishId}: ${coords.lat}, ${coords.lng}`);
              }
            });
          }
        }
      } else {
        // Buffer for admin review
        const proposed = {};
        const puFields = ['name', 'full_name', 'address', 'website', 'email', 'phone', 'acronym', 'chant_style', 'live_url'];
        for (const f of puFields) {
          if (f in pu) {
            const v = pu[f];
            proposed[f] = (v === '' || v == null) ? null : v;
          }
        }
        if ('languages' in pu) proposed.languages = pu.languages || null;
        if (Object.keys(proposed).length) {
          db.prepare(`INSERT INTO pending_parish_updates (parish_id, proposed_changes, sender_phone, source_run_id)
                      VALUES (?, ?, ?, ?)`).run(parishId, JSON.stringify(proposed), sender, runId);
          console.log(`[webhook] Queued parish update for review: ${parishId}`);
        }
      }
    }

    // Handle schedules — respect sender status
    let schedulesCreated = 0;
    if (result.schedules && result.schedules.length && parishId !== '_unassigned') {
      const schedStatus = senderRecord.status === 'approved' ? 'approved' : 'pending_review';
      const schedActive = schedStatus === 'approved' ? 1 : 0;
      const insertSched = db.prepare(`
        INSERT INTO schedules (parish_id, day_of_week, start_time, end_time, title, event_type, languages, week_of_month, concurrent, active, status, source_run_id, hide_live)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const s of result.schedules) {
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
        if (senderRecord.status === 'approved') {
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
    const upsert = db.prepare(`
      INSERT INTO events (parish_id, source_adapter, title, description, start_utc, end_utc,
        event_type, source_hash, confidence, status, lat, lng, location_override, languages, poster_path, source_run_id, hide_live, parish_scoped)
      SELECT @parish_id, 'whatsapp-webhook', @title, @description, @start_utc, @end_utc,
        @event_type, @source_hash, 'ai-parsed', @status,
        p.lat, p.lng, @location_override, @languages, @poster_path, @source_run_id, @hide_live, @parish_scoped
      FROM parishes p WHERE p.id = @parish_id
      ON CONFLICT(source_hash) DO UPDATE SET
        title = excluded.title, description = excluded.description,
        start_utc = excluded.start_utc, end_utc = excluded.end_utc,
        poster_path = COALESCE(excluded.poster_path, events.poster_path),
        hide_live = excluded.hide_live,
        parish_scoped = excluded.parish_scoped,
        updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    `);

    let eventsCreated = 0;
    const tx = db.transaction(() => {
      for (const evt of result.events) {
        const hash = crypto.createHash('sha256')
          .update(`wa-webhook-${parishId}-${evt.date_str}-${evt.title}`)
          .digest('hex');
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
    });
    tx();

    db.prepare(`
      UPDATE adapter_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
      status = 'success', events_found = ?, events_created = ?,
      input_texts = ?, claude_response = ? WHERE id = ?
    `).run(result.events.length, eventsCreated, JSON.stringify(texts), result.rawResponse || null, runId);

    console.log(`[webhook] Batch from ${sender}: ${images.length} image(s), ${texts.length} text(s) → ${result.events.length} events, ${schedulesCreated} schedules, ${cancellationsApplied + cancellationsQueued} cancellations, parish=${parishId}, status=${eventStatus}`);

  } catch (err) {
    db.prepare(`
      UPDATE adapter_runs SET finished_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
      status = 'failed', error_message = ? WHERE id = ?
    `).run(err.message, runId);
    console.error('[webhook] Batch processing failed:', err.message);
  }
}

module.exports = router;
