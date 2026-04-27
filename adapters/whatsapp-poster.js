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
   * @returns {{ events: Array, parishSignal: Object }}
   */
  async parseMessage({ images = [], texts = [], upcomingEvents = [], clarifierContext = null }) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

    const client = new Anthropic();

    // Group upcoming events by parish for the prompt. Claude needs these to
    // target a specific event when a message announces a cancellation, rather
    // than inventing a new "CANCELLED" event row.
    const eventsByParish = new Map();
    for (const e of upcomingEvents) {
      if (!eventsByParish.has(e.parish_id)) eventsByParish.set(e.parish_id, []);
      eventsByParish.get(e.parish_id).push(e);
    }
    const upcomingList = upcomingEvents.length
      ? [...eventsByParish.entries()].map(([pid, evts]) => {
          const lines = evts.map(e => {
            const localDate = new Date(e.start_utc).toLocaleString('en-AU', {
              timeZone: 'Australia/Sydney', year: 'numeric', month: '2-digit',
              day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
            });
            return `    - id=${e.id} ${localDate} ${e.event_type}: ${e.title}`;
          }).join('\n');
          return `  ${pid}:\n${lines}`;
        }).join('\n')
      : '  (none)';

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

UPCOMING EVENTS (next 14 days, Sydney local time):
${upcomingList}
${clarifierContext ? `
CLARIFIER IN PROGRESS: A previous message from this sender was ambiguous. The system asked a clarifying question and the sender's current message is their answer. Resolve the original message using that answer.

Previous message(s): ${clarifierContext.originalTexts.map(t => `"${t}"`).join(' | ')}
Question asked: "${clarifierContext.question}"
Sender's answer (current message): ${texts.map(t => `"${t}"`).join(' | ')}

IMPORTANT: If the question text above contains extracted details (church name, address, etc.) from a previous image, use those directly to populate parish_signal.details — do not ask for information already present in the question text.
` : ''}
TASKS:
1. Extract parish identification signals — do NOT attempt to match against any list, just describe what you see:
   - saint_name: the HOSTING CHURCH's patron saint — NOT a saint mentioned in an event title, ministry name, or group name (e.g. "St Joseph Men's Group" hosted at St John the Baptist → saint_name is "St John the Baptist"). If a caption or text message names a parish, that takes priority over anything visible in a poster image. Look for venue indicators at the bottom of posters (church name, address, "hosted by") to identify the host. null if not identifiable.
   - suburb: the suburb or city the message refers to. null if not stated.
   - jurisdiction: ONLY populate if the message explicitly uses one of these words (set lowercase): "serbian", "greek", "antiochian", "russian", "romanian", "macedonian". null if not mentioned.
   - explicit_new: true ONLY when the message says "new parish", "new church", "new community", or "new congregation". false otherwise.
   - details: ONLY when explicit_new=true — extract every field visible in the text and images: name, full_name, jurisdiction, address, lat, lng, website, email, phone, acronym, chant_style, live_url, languages. null when explicit_new=false.
2. Extract any one-off EVENTS explicitly stated in the sender's message. NEVER generate events from the Orthodox calendar, from the UPCOMING EVENTS context above, or from your own knowledge — only from what the sender wrote.
3. Extract any recurring SCHEDULES (weekly services like "Sunday Divine Liturgy 9:30am").
4. Extract any parish info UPDATES (address, phone, website, languages).
5. Detect CANCELLATIONS of upcoming events listed above. If the message announces that a specific upcoming service is cancelled, not happening, postponed, or moved (e.g. "no Liturgy tonight", "Vespers cancelled this week", "no mid-week Liturgy"), emit a cancellations[] entry referencing the exact id of the matching upcoming event. Do NOT also emit a duplicate row in events[] for the same service — either cancel it OR create it, never both.

Return ONLY valid JSON (no markdown fences) in this exact format:
{
  "parish_signal": {
    "saint_name": "St John the Baptist or null",
    "suburb": "Wollongong or null",
    "jurisdiction": "antiochian|greek|serbian|russian|romanian|macedonian|other|null",
    "explicit_new": false,
    "details": null
  },
  "events": [
    {
      "title": "Event Name",
      "description": "Details or null",
      "date": "2026-03-20",
      "start_time": "09:00",
      "end_time": "11:00 or null",
      "event_type": "liturgy|prayer|feast|talk|youth|social|other",
      "location": "venue if different from parish address, or null",
      "languages": ["English"],
      "hide_live": false,
      "parish_scoped": false
    }
  ],
  "schedules": [
    {
      "day_of_week": 0,
      "start_time": "09:30",
      "end_time": "12:00 or null",
      "title": "Sunday Divine Liturgy",
      "event_type": "liturgy|prayer|feast|talk|youth|social|other",
      "languages": ["English", "Arabic"],
      "week_of_month": "first,third or null (null means every week; comma-separated values from: first second third fourth last)",
      "concurrent": false,
      "hide_live": false
    }
  ],
  "cancellations": [
    {
      "event_id": 12345,
      "reason": "Short quote from the message, e.g. 'no mid-week Liturgy tonight'"
    }
  ],
  "parish_updates": null or {
    "website": "https://example.org",
    "phone": "0411 222 333"
  },
  "parish_clears": []
}

IMPORTANT type rules: "Vesperal Liturgy" and any service with "Liturgy" = liturgy. Vespers, Matins, Compline, Bridegroom, Holy Unction, Lamentations, Passion Gospels = prayer.
day_of_week: 0=Sunday, 1=Monday, ..., 6=Saturday.
week_of_month: only set if the schedule explicitly specifies which week(s) of the month (e.g. "first Sunday", "last Saturday"). Null means every week.
Only include schedules if the message describes RECURRING weekly services, not one-off events.
concurrent: true if this service runs simultaneously alongside another service at the same parish at the same time (e.g. English and Arabic liturgies in separate rooms at the same hour). False otherwise.
hide_live: true if the message indicates the event will NOT be livestreamed (e.g. "no livestream", "in-person only", "not streamed"). Also true for events at external venues (retreats, camps, outings), and for private/non-service entries like Confession, Setup, Prayer Ministry. False by default — only set true when there's a clear signal it won't be streamed. For schedules: set true for any weekly recurring item that will never be streamed (e.g. Confession slots).
parish_scoped: true for internal/operational entries that should only surface when a user has filtered the feed to this parish alone (e.g. "SETUP", "Pack-down", "Cleaning roster"). False by default. These are things the parish wants tracked but not broadcast to the general public feed.
parish_updates: include ONLY keys for fields the message is setting to a new non-null value (name, address, contact details, acronym, chant style, languages, live stream URL, etc). OMIT keys entirely for fields the message does not mention. NEVER emit null inside parish_updates — null is not a meaningful value here.
parish_clears: an array of field names. Include a field name here ONLY when the message explicitly states the parish no longer has that attribute — e.g. "we no longer livestream" → "live_url"; "stream has been discontinued" → "live_url"; "phone disconnected" → "phone"; "website closed" → "website". Valid field names: name, full_name, address, website, email, phone, acronym, chant_style, live_url, languages. Empty [] when no removal is requested. DO NOT add a field here just because the message didn't mention it — silence is not a removal.
Only pick an event_id from the UPCOMING EVENTS list above. Do not invent ids. Only list a cancellation if you are confident about the specific event (matching date and title/type). If the message is ambiguous, leave cancellations empty and do not create a stand-in event row.
When explicit_new=true, details has the same shape as parish_signal but with full fields: { name, full_name, jurisdiction, address, lat, lng, website, email, phone, acronym, chant_style, live_url, languages }.
If you cannot extract anything, return: {"parish_signal": {"saint_name": null, "suburb": null, "jurisdiction": null, "explicit_new": false, "details": null}, "events": [], "schedules": [], "cancellations": [], "parish_updates": null, "parish_clears": []}

DATE EXTRACTION RULES (read carefully — past posters have been misread by +14 days):
- If the poster has a header/title naming a month and year (e.g. "HOLY WEEK SERVICES - APRIL 2026", "MARCH 2026 PROGRAM"), those ARE the authoritative month and year for every row. Do NOT shift to a future occurrence.
- If a tabular poster has a leftmost numeric column, treat those numbers as DAY-OF-MONTH (not row indices), even when values are non-contiguous (e.g. 1, 2, 3, 5, 6 — gaps are normal, the 4th simply isn't listed). Combine with the header month/year.
- The day-of-week column is a CROSS-CHECK, not the primary date source. If the day-of-week implied by the numeric date column disagrees with the written day-of-week, trust the numeric column + header month/year and note the mismatch in description.
- Only fall back to "nearest future occurrence" when the poster has day-of-week labels ALONE with no month/year header and no day-of-month column.
- After extracting, sanity-check: every event date must fall within the header month (± one week into adjacent months for spillover). If any date falls outside, re-read the poster.

Today's date is ${new Date().toISOString().split('T')[0]}. Timezone: Australia/Sydney (AEDT/AEST).`
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
      parsed = jsonMatch ? JSON.parse(jsonMatch[0]) : { parish_signal: null, events: [] };
    } catch {
      console.error('[whatsapp-poster] Failed to parse Claude response:', responseText);
      return { events: [], parishSignal: null };
    }

    // Convert events to internal format. source_hash is computed by the
    // caller once the parish is resolved — without a parish salt, common
    // titles like "Presanctified Liturgy" collide across parishes.
    const events = (parsed.events || []).map(evt => {
      const dateStr = evt.date || new Date().toISOString().split('T')[0];
      const startTime = evt.start_time || '09:00';
      const startUtc = localToUtc(dateStr, startTime);

      let endUtc = null;
      if (evt.end_time) {
        endUtc = localToUtc(dateStr, evt.end_time);
      }

      return {
        title: evt.title,
        description: evt.description || null,
        start_utc: startUtc,
        end_utc: endUtc,
        event_type: evt.event_type || 'other',
        location_override: evt.location || null,
        date_str: dateStr,
        confidence: 'ai-parsed',
        status: 'pending_review',
        hide_live: evt.hide_live || false,
        parish_scoped: evt.parish_scoped || false
      };
    });

    const defaultSignal = { saint_name: null, suburb: null, jurisdiction: null, explicit_new: false, details: null };
    return {
      events,
      parishSignal: parsed.parish_signal || defaultSignal,
      schedules: parsed.schedules || [],
      cancellations: Array.isArray(parsed.cancellations) ? parsed.cancellations : [],
      parish_updates: parsed.parish_updates || null,
      parish_clears: Array.isArray(parsed.parish_clears) ? parsed.parish_clears : [],
      rawResponse: response.content[0].text
    };
  }

  async fetchEvents() {
    // This adapter is triggered on-demand via parseImage/parseMessage, not via scheduled fetch
    return [];
  }
}

module.exports = new WhatsAppPosterAdapter();
