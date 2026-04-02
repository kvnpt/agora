const BaseAdapter = require('./base');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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
      '.webp': 'image/webp'
    }[ext] || 'image/jpeg';

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 }
          },
          {
            type: 'text',
            text: `Extract event details from this poster image. The event is from an Orthodox Christian parish in Sydney, Australia.

Return ONLY a JSON array of events. Each event object should have:
- "title": string (event name)
- "description": string (any additional details)
- "date": string (ISO date, e.g. "2026-03-20")
- "start_time": string (24h format, e.g. "09:00")
- "end_time": string or null (24h format)
- "event_type": one of: liturgy, vespers, feast, festival, youth, talk, fundraiser, other
- "location": string or null (if different from the parish)

If you cannot extract event details, return an empty array [].
Today's date is ${new Date().toISOString().split('T')[0]}. If the poster does not specify a year, assume the nearest future occurrence of that date. Assume timezone is Australia/Sydney (AEDT/AEST).`
          }
        ]
      }]
    });

    const text = response.content[0].text;
    let events;
    try {
      // Extract JSON from response (might be wrapped in markdown code blocks)
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
      const startLocal = `${dateStr}T${startTime}:00`;

      // Convert AEDT/AEST to UTC (approximate: subtract 11h for AEDT, 10h for AEST)
      const startDate = new Date(startLocal + '+11:00'); // assume AEDT
      const startUtc = startDate.toISOString();

      let endUtc = null;
      if (evt.end_time) {
        const endDate = new Date(`${dateStr}T${evt.end_time}:00+11:00`);
        endUtc = endDate.toISOString();
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
      "SELECT id, name, jurisdiction, address FROM parishes WHERE id != '_unassigned'"
    ).all();

    const parishList = parishes.map(p =>
      `- "${p.name}" (id: ${p.id}, ${p.jurisdiction}, ${p.address})`
    ).join('\n');

    // Build message content array
    const content = [];

    for (const imagePath of images) {
      const imageData = fs.readFileSync(imagePath);
      const base64 = imageData.toString('base64');
      const ext = path.extname(imagePath).toLowerCase();
      const mediaType = {
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
        '.gif': 'image/gif', '.webp': 'image/webp'
      }[ext] || 'image/jpeg';

      content.push({
        type: 'image',
        source: { type: 'base64', media_type: mediaType, data: base64 }
      });
    }

    for (const text of texts) {
      content.push({ type: 'text', text: `Forwarded message: "${text}"` });
    }

    const imageCount = images.length;
    const textCount = texts.length;

    content.push({
      type: 'text',
      text: `You are extracting Orthodox Christian parish event details from WhatsApp messages forwarded from a parish group chat in Sydney, Australia.

${imageCount > 0 ? `${imageCount} poster image(s) attached above.` : 'No images were attached.'}
${textCount > 0 ? `${textCount} text message(s) shown above.` : 'No text was provided.'}

These messages were sent together by the same person. Text messages may provide context for the poster images (e.g. identifying the parish). Use ALL available context across images and text to extract events and identify the parish.

KNOWN PARISHES:
${parishList}

TASKS:
1. Extract all events from the images and/or text.
2. Infer which parish these events belong to based on any clues: parish name, logo, address, priest name, context text, or any other identifying information. Match against the known parishes list above. If you cannot confidently identify the parish, set inferred_parish to null.

Return ONLY valid JSON in this exact format:
{
  "inferred_parish": "<parish id from the list above, or null if uncertain>",
  "events": [
    {
      "title": "Event Name",
      "description": "Details",
      "date": "2026-03-20",
      "start_time": "09:00",
      "end_time": "11:00",
      "event_type": "liturgy|vespers|feast|festival|youth|talk|fundraiser|other",
      "location": "venue if different from parish, or null"
    }
  ]
}

If you cannot extract any events, return: {"inferred_parish": null, "events": []}
Today's date is ${new Date().toISOString().split('T')[0]}. If a poster does not specify a year, assume the nearest future occurrence of that date. Assume timezone is Australia/Sydney (AEDT/AEST).`
    });

    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      messages: [{ role: 'user', content }]
    });

    const responseText = response.content[0].text;
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
      const startDate = new Date(`${dateStr}T${startTime}:00+11:00`);
      const startUtc = startDate.toISOString();

      let endUtc = null;
      if (evt.end_time) {
        endUtc = new Date(`${dateStr}T${evt.end_time}:00+11:00`).toISOString();
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
      inferred_parish: parsed.inferred_parish || null
    };
  }

  async fetchEvents() {
    // This adapter is triggered on-demand via parseImage/parseMessage, not via scheduled fetch
    return [];
  }
}

module.exports = new WhatsAppPosterAdapter();
