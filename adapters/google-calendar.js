const BaseAdapter = require('./base');
const crypto = require('crypto');

/**
 * Google Calendar adapter — reusable, parameterised by calendar ID.
 * Create one instance per parish that has a public Google Calendar.
 *
 * Usage:
 *   module.exports = new GoogleCalendarAdapter({
 *     parishId: 'antiochian-stmichael-ryde',
 *     calendarId: 'abc123@group.calendar.google.com'
 *   });
 */
class GoogleCalendarAdapter extends BaseAdapter {
  constructor({ parishId, calendarId, schedule }) {
    super({
      id: `gcal-${parishId}`,
      parishId,
      schedule: schedule || '0 */4 * * *',
      sourceType: 'google-calendar'
    });
    this.calendarId = calendarId;
  }

  async fetchEvents() {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) {
      throw new Error('GOOGLE_API_KEY not set');
    }

    const now = new Date().toISOString();
    const maxDate = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString(); // 90 days ahead

    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events`);
    url.searchParams.set('key', apiKey);
    url.searchParams.set('timeMin', now);
    url.searchParams.set('timeMax', maxDate);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('maxResults', '100');

    const res = await fetch(url.toString());
    if (!res.ok) {
      throw new Error(`Google Calendar API error: ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    const items = data.items || [];

    return items.map(item => {
      const start = item.start?.dateTime || item.start?.date;
      const end = item.end?.dateTime || item.end?.date;

      return {
        title: item.summary || 'Untitled Event',
        description: item.description || null,
        start_utc: new Date(start).toISOString(),
        end_utc: end ? new Date(end).toISOString() : null,
        event_type: this._guessEventType(item.summary || ''),
        source_url: item.htmlLink || null,
        source_hash: crypto.createHash('sha256').update(`gcal-${this.calendarId}-${item.id}`).digest('hex'),
        location_override: item.location || null,
        confidence: 'api'
      };
    });
  }

  _guessEventType(title) {
    const t = title.toLowerCase();
    if (/liturgy|θεία λειτουργία/.test(t)) return 'liturgy';
    if (/vespers|εσπερινός|matins|orthros|compline|bridegroom|holy unction|lamentations|passion gospels/.test(t)) return 'prayer';
    if (/feast|nameday/.test(t)) return 'feast';
    if (/youth|young|teens/.test(t)) return 'youth';
    if (/talk|lecture|class|study/.test(t)) return 'talk';
    if (/festival|paniyiri|fete|fundrais|dinner|gala|charity/.test(t)) return 'social';
    return 'other';
  }

  _defaultConfidence() {
    return 'api';
  }
}

// No instances exported by default — create instances in parish-specific adapter files.
// Example:
// module.exports = new GoogleCalendarAdapter({
//   parishId: 'antiochian-stmichael-ryde',
//   calendarId: 'your-calendar-id@group.calendar.google.com'
// });

module.exports = GoogleCalendarAdapter;
