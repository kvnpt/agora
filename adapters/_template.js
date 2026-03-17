/**
 * Template adapter — copy this file and customise.
 *
 * 1. Copy to a new file: cp _template.js my-parish.js
 * 2. Set id, parishId, schedule, sourceType
 * 3. Implement fetchEvents()
 * 4. Restart the server — registry auto-discovers it
 */
const BaseAdapter = require('./base');

class TemplateAdapter extends BaseAdapter {
  constructor() {
    super({
      id: 'parish-slug',          // unique adapter slug
      parishId: 'parish-id',      // FK to parishes table
      schedule: '0 */6 * * *',    // cron: every 6 hours
      sourceType: 'manual'        // whatsapp-poster | google-calendar | facebook | website | manual
    });
  }

  async fetchEvents() {
    // Return array of event objects:
    // {
    //   title: 'Event Name',
    //   description: 'Details...',
    //   start_utc: '2026-03-20T09:00:00Z',
    //   end_utc: '2026-03-20T11:00:00Z',
    //   event_type: 'liturgy',  // liturgy|vespers|feast|festival|youth|talk|fundraiser|other
    //   source_url: 'https://...',
    //   source_hash: 'unique-dedup-key',
    // }
    return [];
  }
}

// module.exports = new TemplateAdapter();
