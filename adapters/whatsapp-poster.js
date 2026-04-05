const BaseAdapter = require('./base');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { localToUtc } = require('../schedule-generator');

/**
 * WhatsApp Poster adapter — uses Claude Haiku vision to extract event
 * details from uploaded poster images. Events go to pending_review.
 */
class WhatsAppPosterAdapter extends BaseAdapter {
  constructor() {
    super({
      id: 'whatsapp-poster',
      parishId: '*',
      schedule: null, // triggered on-demand, not scheduled
      sourceType: 'whatsapp-poster'
    });
  }

  /**
   * Parse a single poster image and return extracted events.
   * @param {string} imagePath - Path to the poster image file
   * @param {string} parishId - The parish this poster belongs to
   * @returns {Array} Extracted event objects
   */
  async parseImage(imagePath, parishId) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

    const client = new Anthropic();

    const imageData = fs.readFileSync(imagePath);
    const base64 = imageData.toString('base64');
    const ext = path.extname(imagePath).toLowerCase();
    const mediaType = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.pdf': 'application/pdf'
    }[ext] || 'image/jpeg';
    const isPdf = mediaType === 'application/pdf';

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: [
          isPdf
            ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
            : { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
          {
            type: 'text',
            text: `Extract event details from this poster image. The event is from an Orthodox Christian parish in Sydney, Australia.

Return ONLY a JSON array of events. Each event object should have:
- "title": string (event name)
- "description": string (any additional details)
- "date": string (ISO date, e.g. "2026-03-20")
- "start_time": string (24h format, e.g. "09:00")
- "end_time": string or null (24h format)
- "event_type": one of: liturgy, prayer, feast, talk, youth, social, other
  NOTE: "Vesperal Liturgy" and any service containing "Liturgy" = liturgy. Vespers, Matins, Compline, Bridegroom, Holy Unction, Lamentations, Passion Gospels = prayer.
- "location": string or null (if different from the parish)

If you cannot extract event details, return an empty array [].
Today's date is ${new Date().toISOString().split('T')[0]}. If the poster does not specify a year, assume the nearest future occurrence of that date. Assume timezone is Australia/Sydney (AEDT/AEST).`
          }
        ]
      }]
    });

    const text = response.content[0].text.replace(/```json\s*/g, '').replace(/```/g, '').trim();
    let events;
    try {
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      events = jsonMatch ? JSON.parse(jsonMatch[0]) : [];
    } catch {
      console.error('[whatsapp-poster] Failed to parse Claude response:', text);
      return [];
    }

    // Convert to our event format
    return events.map(evt => {
      const dateStr = evt.date || new Date().toISOString().split('T')[0];
      const startTime = evt.start_time || '09:00';
      const startUtc = localToUtc(dateStr, startTime);

      let endUtc = null;
      if (evt.end_time) {
        endUtc = localToUtc(dateStr, evt.end_time);
      }

      const hash = crypto.createHash('sha256')
        .update(`poster-${parishId}-${dateStr}-${evt.title}`)
        .digest('hex');

      return {
        title: evt.title,
        description: evt.description || null,
        start_utc: startUtc,
        end_utc: endUtc,
        event_type: evt.event_type || 'other',
        location_override: evt.location || null,
        source_hash: hash,
        confidence: 'ai-parsed',
        status: 'pending_review'
      };
    });
  }

  /**
   * Parse a batch of WhatsApp messages (multiple images + text) and return events + inferred parish.
   * @param {Object} opts
   * @param {string[]} opts.images - Paths to image files
   * @param {string[]} opts.texts - Text messages and captions
   * @returns {{ events: Array, inferred_parish: string|null }}
   */
  async parseMessage({ images = [], texts = [] }) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

    const client = new Anthropic();

    // Fetch known parishes for the prompt
    const { getDb } = require('../db');
    const db = getDb();
    const parishes = db.prepare(
      "SELECT id, name, acronym, jurisdiction, address FROM parishes WHERE id != '_unassigned'"
    ).all();

    const parishList = parishes.map(p =>
      `- "${p.name}"${p.acronym ? ` [${p.acronym}]` : ''} (id: ${p.id}, ${p.jurisdiction}, ${p.address})`
    ).join('\n');

    // Build message content array
    const content = [];

    for (const imagePath of images) {
      const imageData = fs.readFileSync(imagePath);
      const base64 = imageData.toString('base64');
      const ext = path.extname(imagePath).toLowerCase();
      const mediaType = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf'
      }[ext] || 'image/jpeg';

      if (mediaType === 'application/pdf') {
        content.push({
          type: 'document',
          source: { type: 'base64', media_type: 'application/pdf', data: base64 }
        });
      } else {
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 }
        });
      }
    }

    for (const text of texts) {
      content.push({ type: 'text', text: `Forwarded message: "${text}"` });
    }

    const imageCount = images.length;
    const textCount = texts.length;

    content.push({
      type: 'text',
      text: `You are extracting Orthodox Christian parish information from WhatsApp messages forwarded from Sydney, Australia.

${imageCount > 0 ? `${imageCount} poster image(s) attached above.` : 'No images were attached.'}
${textCount > 0 ? `${textCount} text message(s) shown above.` : 'No text was provided.'}

These messages were sent together by the same person. Use ALL available context across images and text.

KNOWN PARISHES:
${parishList}

TASKS:
1. Identify which parish the message relates to. Match against the known parishes list above. If it's a NEW parish not in the list, populate new_parish.
2. Extract any one-off EVENTS (dated services, feasts, social events, talks, etc).
3. Extract any recurring SCHEDULES (weekly services like "Sunday Divine Liturgy 9:30am").
4. Extract any parish info UPDATES (address, phone, website, languages).

Return ONLY valid JSON (no markdown fences) in this exact format:
{
  "inferred_parish": "<parish id from list, or null>",
  "new_parish": null or {
    "name": "Short name, e.g. St George, Carlton",
    "full_name": "Full official name",
    "jurisdiction": "antiochian|greek|serbian|russian|romanian|macedonian|other",
    "address": "Full street address",
    "website": "url or null",
    "phone": "phone or null",
    "languages": ["English", "Slavonic"]
  },
  "events": [
    {
      "title": "Event Name",
      "description": "Details or null",
      "date": "2026-03-20",
      "start_time": "09:00",
      "end_time": "11:00 or null",
      "event_type": "liturgy|prayer|feast|talk|youth|social|other",
      "location": "venue if different from parish, or null",
      "languages": ["English"]
    }
  ],
  "schedules": [
    {
      "day_of_week": 0,
      "start_time": "09:30",
      "end_time": "12:00 or null",
      "title": "Sunday Divine Liturgy",
      "event_type": "liturgy|prayer|feast|talk|youth|social|other",
      "languages": ["English", "Arabic"]
    }
  ],
  "parish_updates": null or {
    "address": "new address or null",
    "website": "new url or null",
    "phone": "new phone or null",
    "languages": ["English", "Arabic"]
  }
}

IMPORTANT type rules: "Vesperal Liturgy" and any service with "Liturgy" = liturgy. Vespers, Matins, Compline, Bridegroom, Holy Unction, Lamentations, Passion Gospels = prayer.
day_of_week: 0=Sunday, 1=Monday, ..., 6=Saturday.
Only include schedules if the message describes RECURRING weekly services, not one-off events.
Only include parish_updates if the message explicitly provides new/changed parish contact info.
If you cannot extract anything, return: {"inferred_parish": null, "events": [], "schedules": [], "parish_updates": null, "new_parish": null}
Today's date is ${new Date().toISOString().split('T')[0]}. If a poster does not specify a year, assume the nearest future occurrence. Timezone: Australia/Sydney (AEDT/AEST).`
    });

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      messages: [{ role: 'user', content }]
    });

    const responseText = response.content[0].text.replace(/```json\s*/g, '').replace(/```/g, '').trim();
    let parsed;
    try {
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { inferred_parish: null, events: [] };
    } catch {
      console.error('[whatsapp-poster] Failed to parse Claude response:', responseText);
      return { events: [], inferred_parish: null };
    }

    // Convert events to internal format
    const events = (parsed.events || []).map(evt => {
      const dateStr = evt.date || new Date().toISOString().split('T')[0];
      const startTime = evt.start_time || '09:00';
      const startUtc = localToUtc(dateStr, startTime);

      let endUtc = null;
      if (evt.end_time) {
        endUtc = localToUtc(dateStr, evt.end_time);
      }

      const hash = crypto.createHash('sha256')
        .update(`wa-webhook-${dateStr}-${evt.title}`)
        .digest('hex');

      return {
        title: evt.title,
        description: evt.description || null,
        start_utc: startUtc,
        end_utc: endUtc,
        event_type: evt.event_type || 'other',
        location_override: evt.location || null,
        source_hash: hash,
        confidence: 'ai-parsed',
        status: 'pending_review'
      };
    });

    return {
      events,
      inferred_parish: parsed.inferred_parish || null,
      schedules: parsed.schedules || [],
      parish_updates: parsed.parish_updates || null,
      new_parish: parsed.new_parish || null
    };
  }

  async fetchEvents() {
    // This adapter is triggered on-demand via parseImage/parseMessage, not via scheduled fetch
    return [];
  }
}

module.exports = new WhatsAppPosterAdapter();
