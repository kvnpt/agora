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
Assume timezone is Australia/Sydney (AEDT/AEST).`
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

  async fetchEvents() {
    // This adapter is triggered on-demand via parseImage(), not via scheduled fetch
    return [];
  }
}

module.exports = new WhatsAppPosterAdapter();
