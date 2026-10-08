// The add-event editor: one component, two hosts.
//
// The app's parish-sheet + button and /admin's Events section both mount this,
// so the two ways of adding an event cannot drift apart — the old dialog lived
// only in app.js, and /admin had none.
//
// WHAT IT EDITS IS A DRAFT (worker/lib/drafts.mjs). Every card saves itself a
// moment after the typing stops, so closing the dialog loses nothing, and only
// Publish writes `events`. A draft is made by the first thing typed or by a
// dropped poster — never by opening the editor, so looking costs nothing.
//
// A POSTER IS READ INTO IT. Dropped, pasted or chosen, the image is shrunk here
// (a Worker has no image pipeline), stored once, and read by Claude; the read
// streams back as Server-Sent Events and the cards fill in as it is written —
// the title typing itself in, then the date, then the times. A poster with
// several events becomes several cards, collapsed to one line each so they can
// be checked at a glance. Nothing a person has typed is ever overwritten: the
// read only fills empty fields, here and on the server.
//
// EVERY CARD CARRIES THE COMBINE the old dialog did — "also appears at" and
// "replaces" — because an event entered because it replaces the 9am liturgy
// should never exist for a round trip beside it (docs/editing.md). A target at
// a parish the person may not write turns that card's publish into an ask.
//
// Model output and everything a person typed reach the page through
// textContent or esc(), never as markup.
//
// Classic script: window.AgoraEventEditor, and module.exports for the pure
// helpers' tests. Needs AgoraEventTypes, AgoraEventChecks, AgoraSSE and (for
// the shrink) AgoraLogo loaded first.
(function (root) {
  // ── pure helpers (d1/event-editor.test.mjs) ───────────────────────────────

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const isTime = (v) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);

  /** '19:30' -> { text: '7:30', ampm: 'pm' } */
  function clock(t) {
    const h = +t.slice(0, 2), m = t.slice(3, 5);
    return { text: `${h % 12 || 12}:${m}`, ampm: h < 12 ? 'am' : 'pm' };
  }

  /** '19:00','21:30' -> '7:00–9:30 pm'; '11:00','13:00' -> '11:00 am–1:00 pm'. */
  function timeRange(start, end) {
    if (!isTime(start)) return '';
    const s = clock(start);
    if (!isTime(end)) return `${s.text} ${s.ampm}`;
    const e = clock(end);
    return s.ampm === e.ampm ? `${s.text}–${e.text} ${e.ampm}` : `${s.text} ${s.ampm}–${e.text} ${e.ampm}`;
  }

  /** '2026-11-14' -> 'Sat 14 Nov', with the year only when it is not this one. */
  function dateLabel(date, thisYear) {
    if (!isDate(date)) return '';
    const [y, m, d] = date.split('-').map(Number);
    const wd = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
    return `${wd} ${d} ${MONTHS[m - 1]}${thisYear && y !== thisYear ? ` ${y}` : ''}`;
  }

  const kindLabel = (id) => {
    if (!id) return '';
    const T = root.AgoraEventTypes;
    return T ? T.eventTypeLabel(id) : id.charAt(0).toUpperCase() + id.slice(1);
  };

  /**
   * A card as one line, for scanning a poster's worth at a glance:
   * "Sat 14 Nov · 7:00–9:30 pm · Youth Night · Youth".
   */
  function summaryLine(f, { thisYear } = {}) {
    return [
      dateLabel(f.date, thisYear) || 'No date',
      timeRange(f.start_time, f.end_time) || 'No time',
      (f.title || '').trim() || 'Untitled',
      kindLabel(f.event_type),
    ].filter(Boolean).join(' · ');
  }

  /** "Greek, English" <-> ['Greek', 'English']. */
  const textToLangs = (text) => String(text || '').split(',').map(s => s.trim()).filter(Boolean);
  const langsToText = (list) => (Array.isArray(list) ? list.join(', ') : String(list || ''));

  function haversineKm(lat1, lng1, lat2, lng2) {
    const rad = (x) => x * Math.PI / 180;
    const a = Math.sin(rad(lat2 - lat1) / 2) ** 2
      + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.sqrt(a));
  }

  /** "12 km" — the distance that decides the order, said out loud. */
  const kmLabel = (km) => (km == null || !Number.isFinite(km))
    ? '' : (km < 10 ? `${km.toFixed(1)} km` : `${Math.round(km)} km`);

  /**
   * Every parish the event could be listed at, own parish first.
   *
   * NOT narrowed to the ones this account may write: a parish contact's list
   * once came back holding only their own parish, which made the ask
   * unreachable by the only people it is for. `_needsAsk` marks the rest.
   *
   * Then the event's own jurisdiction, then distance from the EVENT'S parish —
   * a deanery liturgy at Redfern is attended by the parishes near Redfern, and
   * the order is the same for everybody who opens it.
   */
  function orderParishRows(parish, parishes, may) {
    const km = (p) => (parish.lat != null && p.lat != null)
      ? haversineKm(parish.lat, parish.lng, p.lat, p.lng) : Infinity;
    const others = (parishes || [])
      .filter(p => p.id !== parish.id && p.id !== '_unassigned')
      .map(p => ({ ...p, _needsAsk: !may('event.edit', p.id), _km: km(p) }))
      .sort((a, b) => {
        const ah = a.jurisdiction === parish.jurisdiction ? 0 : 1;
        const bh = b.jurisdiction === parish.jurisdiction ? 0 : 1;
        return ah - bh
          || String(a.jurisdiction || '').localeCompare(String(b.jurisdiction || ''))
          || a._km - b._km
          || String(a.name || '').localeCompare(String(b.name || ''));
      });
    return [{ ...parish, _isOwn: true }, ...others];
  }

  /**
   * Is anything ticked on this card that the person may not write themselves?
   * `parishOf(id)` names the parish of a replace target, from the candidates.
   */
  function askNeeded(fields, may, parishOf) {
    return (fields.also_at || []).some(pid => !may('event.edit', pid))
      || (fields.replaces || []).some(rid => {
        const pid = parishOf(rid);
        return pid != null && !may('event.edit', pid);
      });
  }

  /**
   * May the read put a value into this field? Not if a person has typed in it,
   * and not if it already holds something the read did not put there — the
   * same rule the server applies when it merges (drafts.mjs mergeRead).
   */
  function takesRead(card, field) {
    if (card.touched.has(field)) return false;
    if (card.readFilling.has(field)) return true;
    const v = card.fields[field];
    return v == null || v === '' || (Array.isArray(v) && !v.length);
  }

  // ── the editor ────────────────────────────────────────────────────────────

  const MAX_EDGE = 2048;           // what is stored and shown; Claude reads it smaller
  const SAVE_DELAY = 700;
  const TEXT_FIELDS = ['title', 'description', 'languages', 'location_override', 'ask_reason'];

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not open that image'));
      img.src = src;
    });
  }

  /**
   * The poster at the size it is stored and shown: 2048px on the long side,
   * WebP where the browser can write it (AgoraLogo.encodeCanvas says why that
   * needs checking), never scaled up. A photo off a phone is 4–12 MB; this is
   * a few hundred KB, which is the whole upload on a parish hall's mobile data.
   */
  async function shrinkPoster(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const w = img.naturalWidth, h = img.naturalHeight;
      const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
      if (scale === 1 && file.size <= 1.5 * 1024 * 1024 && /^image\/(jpeg|png|webp)$/.test(file.type)) return file;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(w * scale);
      canvas.height = Math.round(h * scale);
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      let blob = root.AgoraLogo
        ? await root.AgoraLogo.encodeCanvas(canvas)
        : await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
      // A transparent PNG that stayed PNG can still be large; the reader takes 5 MB.
      if (blob && blob.size > 4.5 * 1024 * 1024) {
        ctx.globalCompositeOperation = 'destination-over';
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
      }
      if (!blob) throw new Error('Could not encode the image');
      return blob;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  async function http(method, url, body) {
    try {
      const init = { method, headers: {} };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
      }
      const res = await fetch(url, init);
      const json = await res.json().catch(() => null);
      return { ok: res.ok, status: res.status, body: json };
    } catch {
      return { ok: false, status: 0, body: null };
    }
  }

  const blankFields = () => ({
    title: '', date: '', start_time: '', end_time: '', event_type: '', description: '',
    languages: '', location_override: '', also_at: [], replaces: [], ask_reason: '',
  });

  /** A field's value as the Worker stores it. */
  function toPatchValue(field, v) {
    if (field === 'languages') { const l = textToLangs(v); return l.length ? l : null; }
    if (field === 'also_at' || field === 'replaces') return v && v.length ? v : null;
    return v === '' ? null : v;
  }

  /**
   * @param {HTMLElement} mount
   * @param {object} opts
   *   parish      {id, name, timezone, lat, lng, jurisdiction, address}
   *   parishes    every parish, for "also appears at"
   *   may         (capability, parishId) => boolean — the same two questions the Worker asks
   *   draftId     continue this draft instead of starting blank
   *   onPublished ({events, proposals}) once every card is on the site
   *   onClose     () — Save draft, Discard, or nothing left to do
   *   openPoster  (url) — the host's full-screen viewer, if it has one
   */
  function open(mount, opts) {
    const parish = opts.parish;
    const may = opts.may || (() => true);
    const tz = parish.timezone || 'Australia/Sydney';
    const C = root.AgoraEventChecks;
    const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());

    const state = {
      draft: null,            // {id, poster_path, read_status, read_kind, read_notes}
      creating: null,         // the POST that makes the draft, while it is in flight
      cards: [],
      nextKey: 1,
      multi: false,
      read: null,             // {ctrl, active, kind, items, blob}
      posterUrl: null,        // what the thumbnail shows
      objectUrl: null,        // to revoke
      publishing: false,
      closed: false,
    };

    // ── skeleton ──
    mount.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'ee';
    el.innerHTML = `
      <div class="ee-strip" data-ee="strip" hidden></div>
      <div class="ee-poster">
        <input type="file" accept="image/*" data-ee="poster-input" hidden>
        <button type="button" class="ee-drop" data-ee="drop">
          <span class="ee-drop-title">Start from a poster</span>
          <span class="ee-drop-sub">Drop it here, paste it, or tap to choose one. The details are read into the form for you to check — nothing is published until you say so.</span>
        </button>
        <div class="ee-poster-card" data-ee="poster" hidden>
          <button type="button" class="ee-thumb-btn" data-ee="thumb" aria-label="Look at the poster full size"><img class="ee-thumb" alt="The poster"></button>
          <div class="ee-poster-side">
            <div class="ee-status" data-ee="status" aria-live="polite"></div>
            <div class="ee-poster-actions">
              <button type="button" class="ee-link" data-ee="retry" hidden>Try again</button>
              <button type="button" class="ee-link" data-ee="stop" hidden>Stop watching</button>
              <button type="button" class="ee-link" data-ee="replace">Replace</button>
              <button type="button" class="ee-link ee-link-danger" data-ee="remove-poster">Remove poster</button>
            </div>
          </div>
        </div>
      </div>
      <div class="ee-main">
        <div class="ee-head" data-ee="head" hidden></div>
        <div class="ee-cards" data-ee="cards"></div>
        <button type="button" class="ee-add" data-ee="add-card">+ Add another event</button>
        <div class="ee-readiness" data-ee="readiness" aria-live="polite"></div>
        <div class="ee-message" data-ee="error" hidden></div>
        <div class="ee-actions">
          <button type="button" class="ee-btn ee-btn-ghost ee-btn-danger" data-ee="discard">Discard</button>
          <span class="ee-actions-gap"></span>
          <button type="button" class="ee-btn ee-btn-ghost" data-ee="save-draft">Save draft</button>
          <button type="button" class="ee-btn ee-btn-primary" data-ee="publish">Publish</button>
        </div>
      </div>`;
    mount.appendChild(el);
    const $ = (name) => el.querySelector(`[data-ee="${name}"]`);
    const fileInput = $('poster-input');

    // ── status lines ──
    function setStatus(text, tone = '', { retry = false, stop = false } = {}) {
      const s = $('status');
      s.textContent = text || '';
      s.className = `ee-status${tone ? ` ee-status-${tone}` : ''}`;
      $('retry').hidden = !retry;
      $('stop').hidden = !stop;
    }
    /** The line above the buttons: what publishing or saving has to say. */
    function showMessage(text, tone = 'error') {
      const e = $('error');
      e.textContent = text || '';
      e.className = `ee-message ee-message-${tone}`;
      e.hidden = !text;
    }
    const showError = (text) => showMessage(text, 'error');

    // ── the poster panel ──
    function showPoster(url) {
      state.posterUrl = url;
      $('drop').hidden = !!url;
      $('poster').hidden = !url;
      el.classList.toggle('has-poster', !!url);
      if (url) el.querySelector('.ee-thumb').src = url;
    }

    $('drop').addEventListener('click', () => fileInput.click());
    $('replace').addEventListener('click', () => fileInput.click());
    $('thumb').addEventListener('click', () => {
      const url = (state.draft && state.draft.poster_path) || state.posterUrl;
      if (!url) return;
      if (opts.openPoster) opts.openPoster(url);
      else window.open(url, '_blank', 'noopener');
    });
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      fileInput.value = '';
      if (f) dropFile(f);
    });
    el.addEventListener('dragover', (e) => {
      if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) {
        e.preventDefault();
        el.classList.add('is-dragging');
      }
    });
    el.addEventListener('dragleave', (e) => { if (e.target === el) el.classList.remove('is-dragging'); });
    el.addEventListener('drop', (e) => {
      el.classList.remove('is-dragging');
      const f = e.dataTransfer && [...(e.dataTransfer.files || [])].find(x => /^image\//.test(x.type));
      if (!f) return;
      e.preventDefault();
      dropFile(f);
    });
    // A poster copied out of WhatsApp Web or Facebook pastes straight in.
    const onPaste = (e) => {
      const f = e.clipboardData && [...(e.clipboardData.files || [])].find(x => /^image\//.test(x.type));
      if (!f) return;
      e.preventDefault();
      dropFile(f);
    };
    document.addEventListener('paste', onPaste);

    $('retry').addEventListener('click', () => {
      if (state.read && state.read.blob) startRead(state.read.blob);
      else startRead(null);
    });
    // Closes the stream on this side only: the Worker finishes the read and
    // saves it either way, so "stop" is stop WATCHING.
    $('stop').addEventListener('click', () => {
      abortRead();
      setStatus('Still being read on the server — the cards will be filled when you open this draft again.', 'note');
      sync();
    });
    $('remove-poster').addEventListener('click', async () => {
      abortRead();
      if (state.draft && state.draft.poster_path) {
        const r = await http('DELETE', `/api/admin/drafts/${state.draft.id}/poster`);
        if (!r.ok) return showError((r.body && r.body.error) || 'The poster could not be removed.');
        state.draft.poster_path = null;
      }
      if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
      showPoster(null);
      setStatus('');
      sync();
    });

    // ── the draft ──

    /** Make the draft if there is none yet, carrying the first card's typing. */
    function ensureDraft() {
      if (state.draft) return Promise.resolve(true);
      if (state.creating) return state.creating;
      const first = state.cards[0];
      const card = first ? takePending(first) : {};
      state.creating = (async () => {
        const r = await http('POST', '/api/admin/drafts', { parish_id: parish.id, card });
        state.creating = null;
        if (!r.ok) {
          if (first) Object.assign(first.pending, card, first.pending);
          showError((r.body && r.body.error) || 'The draft could not be saved — check the connection.');
          return false;
        }
        setDraft(r.body);
        if (first && r.body.cards[0]) first.id = r.body.cards[0].id;
        if (first) setSaved(first, 'saved');
        refreshStrip();
        return true;
      })();
      return state.creating;
    }

    function setDraft(d) {
      state.draft = { id: d.id, poster_path: d.poster_path, read_status: d.read_status,
        read_kind: d.read_kind, read_notes: d.read_notes || [] };
    }

    function takePending(card) {
      const p = card.pending;
      card.pending = {};
      return p;
    }

    // ── cards ──

    function newCard(extra = {}) {
      const card = {
        key: `c${state.nextKey++}`,
        id: null,
        fields: blankFields(),
        hints: { printed_weekday: null, year_printed: null },
        fromPoster: new Set(),
        notes: [],
        touched: new Set(),
        readFilling: new Set(),
        pending: {},
        timer: null,
        saving: null,
        saveState: '',
        candidates: null,
        candSeq: 0,
        open: false,
        publish: { state: 'idle', message: '' },
        els: null,
        ...extra,
      };
      state.cards.push(card);
      buildCard(card);
      return card;
    }

    function cardFromServer(card, row, { keepLocal = false } = {}) {
      card.id = row.id;
      const server = {
        title: row.title || '', date: row.date || '', start_time: row.start_time || '',
        end_time: row.end_time || '', event_type: row.event_type || '', description: row.description || '',
        languages: langsToText(row.languages), location_override: row.location_override || '',
        also_at: row.also_at || [], replaces: row.replaces || [], ask_reason: row.ask_reason || '',
      };
      for (const f of Object.keys(server)) {
        // What a person changed and the server has not heard yet stays.
        if (keepLocal && (f in card.pending)) continue;
        card.fields[f] = server[f];
        setInput(card, f, server[f]);
      }
      card.fromPoster = new Set((row.read_fields || []).filter(f => !(f in card.pending)));
      card.notes = (row.read_notes || []).filter(n => !(n.field in card.pending));
      card.hints = { printed_weekday: row.printed_weekday, year_printed: row.year_printed };
      card.readFilling = new Set();
    }

    const fieldId = (card, f) => `ee-${card.key}-${f}`;

    function buildCard(card) {
      const node = document.createElement('div');
      node.className = 'ee-card';
      node.dataset.eeCard = card.key;
      const kinds = (window.AgoraEventTypes ? window.AgoraEventTypes.KINDS : [])
        .map(k => `<option value="${esc(k.id)}">${esc(k.label)}</option>`).join('');
      const row = (f, label, input, extra = '') =>
        `<div class="ee-row" data-row="${f}"><label for="${fieldId(card, f)}">${label}<span class="ee-mark" hidden>from poster</span></label>${input}<div class="ee-notes"></div>${extra}</div>`;
      node.innerHTML = `
        <button type="button" class="ee-sum" aria-expanded="false">
          <span class="ee-sum-line"></span>
          <span class="ee-chips"></span>
          <span class="ee-saved"></span>
        </button>
        <div class="ee-body">
          ${row('title', 'Title', `<input id="${fieldId(card, 'title')}" data-ee-field="title" placeholder="Feast of the Dormition" autocomplete="off">`)}
          ${row('date', 'Date', `<input type="date" id="${fieldId(card, 'date')}" data-ee-field="date">`)}
          <div class="ee-grid">
            ${row('start_time', 'Starts', `<input type="time" id="${fieldId(card, 'start_time')}" data-ee-field="start_time">`)}
            ${row('end_time', 'Ends', `<input type="time" id="${fieldId(card, 'end_time')}" data-ee-field="end_time">`)}
          </div>
          <div class="ee-hint">${esc(tz.split('/').pop().replace(/_/g, ' '))} time, the way the parish publishes it.</div>
          ${row('event_type', 'Kind', `<select id="${fieldId(card, 'event_type')}" data-ee-field="event_type"><option value="">Choose a kind</option>${kinds}</select>`)}
          ${row('description', 'Description', `<textarea id="${fieldId(card, 'description')}" data-ee-field="description" rows="3" placeholder="Optional"></textarea>`)}
          ${row('languages', 'Languages', `<input id="${fieldId(card, 'languages')}" data-ee-field="languages" placeholder="English, Greek" autocomplete="off">`)}
          ${row('location_override', 'Held elsewhere', `<input id="${fieldId(card, 'location_override')}" data-ee-field="location_override" placeholder="Leave empty if it is at the parish" autocomplete="off">`,
            '<div class="ee-hint">A venue for this one event. The parish’s own address and pin are untouched.</div>')}
          <details class="ee-combine">
            <summary>Also at other parishes, or replaces a service</summary>
            <div class="ee-section-title">Also appears at</div>
            <div class="ee-list" data-list="also"></div>
            <div class="ee-section-title">Replaces at those parishes</div>
            <div class="ee-list" data-list="replaces"><div class="ee-empty">Pick a date to see what it could replace</div></div>
            <div class="ee-hint">Whatever is ticked here stops being its own card and shows as a tombstone pointing at this event — nothing disappears.</div>
          </details>
          <div class="ee-ask" hidden>
            <div class="ee-ask-what"></div>
            <input data-ee-field="ask_reason" placeholder="Why — the owner reads this" autocomplete="off">
          </div>
          <div class="ee-card-error" hidden></div>
          <button type="button" class="ee-link ee-link-danger ee-remove">Remove this event</button>
        </div>`;
      card.els = {
        root: node,
        sum: node.querySelector('.ee-sum'),
        line: node.querySelector('.ee-sum-line'),
        chips: node.querySelector('.ee-chips'),
        saved: node.querySelector('.ee-saved'),
        body: node.querySelector('.ee-body'),
        combine: node.querySelector('.ee-combine'),
        also: node.querySelector('[data-list="also"]'),
        repl: node.querySelector('[data-list="replaces"]'),
        ask: node.querySelector('.ee-ask'),
        askWhat: node.querySelector('.ee-ask-what'),
        err: node.querySelector('.ee-card-error'),
        inputs: {},
      };
      node.querySelectorAll('[data-ee-field]').forEach(inp => {
        const f = inp.dataset.eeField;
        card.els.inputs[f] = inp;
        const isText = TEXT_FIELDS.includes(f);
        inp.addEventListener(isText ? 'input' : 'change', () => onInput(card, f, inp.value, isText));
        if (isText) inp.addEventListener('blur', () => flush(card));
      });
      card.els.sum.addEventListener('click', () => toggleCard(card));
      card.els.combine.addEventListener('toggle', () => { if (card.els.combine.open) renderCombine(card); });
      node.querySelector('.ee-remove').addEventListener('click', () => removeCard(card));
      $('cards').appendChild(node);
      for (const f of Object.keys(card.els.inputs)) setInput(card, f, card.fields[f]);
      refreshCard(card);
    }

    function setInput(card, f, v) {
      const inp = card.els && card.els.inputs[f];
      if (!inp) return;
      // Never under somebody's typing — but a field that merely has the focus
      // (the title does, on open) is still the read's to fill.
      if (inp === document.activeElement && card.touched.has(f)) return;
      if (inp.value !== String(v == null ? '' : v)) inp.value = v == null ? '' : v;
    }

    function onInput(card, f, value, isText) {
      card.fields[f] = value;
      card.touched.add(f);
      card.readFilling.delete(f);
      card.fromPoster.delete(f);
      card.notes = card.notes.filter(n => n.field !== f);
      if (f === 'date') {
        card.hints = { printed_weekday: null, year_printed: null };
        loadCandidates(card);
      }
      card.pending[f] = toPatchValue(f, value);
      // A refusal for scope is about the combine's targets, and stands until
      // they change (setList) — typing the reason it asks for must not clear
      // it, or the next press goes without the ask and is refused again.
      if (card.publish.state !== 'refused') card.publish = { state: 'idle', message: '' };
      schedule(card, isText ? SAVE_DELAY : 0);
      refreshCard(card);
      sync();
    }

    function setList(card, f, list) {
      card.fields[f] = list;
      card.touched.add(f);
      card.pending[f] = toPatchValue(f, list);
      card.publish = { state: 'idle', message: '' };
      schedule(card, 0);
      refreshAsk(card);
      refreshCard(card);
    }

    // ── autosave ──

    function schedule(card, delay) {
      clearTimeout(card.timer);
      card.timer = setTimeout(() => save(card), delay);
    }

    function flush(card) {
      clearTimeout(card.timer);
      return save(card);
    }

    function flushAll() {
      return Promise.all(state.cards.map(c => flush(c)));
    }

    function setSaved(card, s, message = '') {
      card.saveState = s;
      if (!card.els) return;
      card.els.saved.textContent = s === 'saving' ? 'Saving…' : s === 'saved' ? 'Saved ✓' : s === 'error' ? 'Not saved' : '';
      card.els.saved.className = `ee-saved${s === 'error' ? ' ee-saved-bad' : ''}`;
      card.els.err.textContent = message;
      card.els.err.hidden = !message;
    }

    async function save(card) {
      if (card.saving) { await card.saving; if (!Object.keys(card.pending).length) return; }
      if (!Object.keys(card.pending).length) return;
      // A card the read is still filling gets its id with the read's result;
      // what was typed into it waits for that and goes then.
      if (!card.id && card.provisional) return;
      card.saving = (async () => {
        setSaved(card, 'saving');
        if (!state.draft) {
          const ok = await ensureDraft();
          if (!ok || card.id || !Object.keys(card.pending).length) { if (ok) setSaved(card, 'saved'); return; }
        }
        const patch = takePending(card);
        let r;
        if (card.id) r = await http('PATCH', `/api/admin/draft-events/${card.id}`, patch);
        else {
          r = await http('POST', `/api/admin/drafts/${state.draft.id}/events`, patch);
          if (r.ok) card.id = r.body.id;
        }
        if (r.ok) return setSaved(card, 'saved');
        if (r.status === 400 && r.body && r.body.field) {
          // A value the Worker will never take: say so rather than retry it forever.
          delete patch[r.body.field];
          Object.assign(card.pending, patch, card.pending);
          return setSaved(card, 'error', r.body.error);
        }
        Object.assign(card.pending, patch, card.pending);
        setSaved(card, 'error', r.status === 404 ? 'This draft is gone — published or discarded elsewhere.'
          : 'Not saved yet — check the connection; it will try again on the next change.');
      })();
      try { await card.saving; } finally { card.saving = null; }
      if (Object.keys(card.pending).length && card.saveState !== 'error') schedule(card, SAVE_DELAY);
    }

    // ── showing a card ──

    function checksFor(card) {
      if (!C) return [];
      return C.checkDraftEvent({ ...card.fields, ...card.hints }, { today: today() });
    }

    /** Nothing typed and nothing read: too early to say what is missing. */
    const isPristine = (card) => !Object.values(card.fields).some(v => (Array.isArray(v) ? v.length : String(v || '').trim()));

    function refreshCard(card) {
      if (!card.els) return;
      const checks = isPristine(card) ? [] : checksFor(card);
      const thisYear = +today().slice(0, 4);
      card.els.line.textContent = summaryLine(card.fields, { thisYear });
      card.els.chips.innerHTML = checks
        .filter(c => c.level !== 'info' || c.field === 'date')
        .map(c => `<span class="ee-chip ee-chip-${c.level}">${esc(chipText(c))}</span>`).join('')
        + (card.publish.state === 'refused' ? '<span class="ee-chip ee-chip-warn">needs an owner</span>' : '')
        + (card.publish.state === 'error' ? '<span class="ee-chip ee-chip-block">not published</span>' : '');
      for (const [f, inp] of Object.entries(card.els.inputs)) {
        const rowEl = inp.closest('.ee-row');
        if (!rowEl) continue;
        rowEl.querySelector('.ee-mark').hidden = !card.fromPoster.has(f);
        const notes = rowEl.querySelector('.ee-notes');
        const mine = checks.filter(c => c.field === f);
        const read = card.notes.filter(n => n.field === f);
        notes.innerHTML = mine.map(c => `<div class="ee-note ee-note-${c.level}">${esc(c.text)}</div>`).join('')
          + read.map(n => `<div class="ee-note ee-note-read">${esc(n.text)}</div>`).join('');
      }
      if (card.publish.message) {
        card.els.err.textContent = card.publish.message;
        card.els.err.hidden = false;
      }
      const single = !state.multi;
      card.els.sum.hidden = single;
      card.els.body.hidden = !single && !card.open;
      card.els.sum.setAttribute('aria-expanded', String(single || card.open));
      card.els.root.classList.toggle('is-open', single || card.open);
      card.els.root.classList.toggle('is-published', card.publish.state === 'done');
      refreshAsk(card);
    }

    function chipText(c) {
      if (c.level === 'block') return c.text.replace(/^Needs /, 'needs ').replace(/\.$/, '');
      if (c.field === 'date' && c.level === 'warn' && /poster says/.test(c.text)) return 'check the date';
      if (c.field === 'date' && c.level === 'info') return 'year assumed';
      if (/passed/.test(c.text)) return 'date has passed';
      return c.text.replace(/\.$/, '');
    }

    function toggleCard(card) {
      const opening = !card.open;
      for (const c of state.cards) c.open = false;
      card.open = opening;
      state.cards.forEach(refreshCard);
      if (opening) {
        if (card.fields.also_at.length || card.fields.replaces.length) {
          card.els.combine.open = true;
          renderCombine(card);
        }
        const first = card.els.inputs.title;
        if (first) requestAnimationFrame(() => first.focus({ preventScroll: true }));
        card.els.root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }

    function enterMulti() {
      if (state.multi) return;
      state.multi = true;
      for (const c of state.cards) c.open = false;
      state.cards.forEach(refreshCard);
    }

    function updateHead() {
      const h = $('head');
      const n = state.cards.length;
      h.hidden = !state.multi;
      h.textContent = state.read && state.read.active ? `${n} events found so far…`
        : `${n} events${state.draft && state.draft.poster_path ? ' detected' : ''} — saved as a draft, not yet published. Tap one to check or change it.`;
    }

    async function removeCard(card) {
      if (state.cards.length === 1) return discard();
      clearTimeout(card.timer);
      if (card.id) {
        const r = await http('DELETE', `/api/admin/draft-events/${card.id}`);
        if (!r.ok && r.status !== 404) return setSaved(card, 'error', (r.body && r.body.error) || 'Could not remove it.');
      }
      state.cards = state.cards.filter(c => c !== card);
      card.els.root.remove();
      if (state.cards.length === 1) { state.multi = false; }
      state.cards.forEach(refreshCard);
      sync();
    }

    $('add-card').addEventListener('click', async () => {
      enterMulti();
      const card = newCard({ open: true });
      for (const c of state.cards) c.open = c === card;
      state.cards.forEach(refreshCard);
      sync();
      if (await ensureDraft()) {
        const r = await http('POST', `/api/admin/drafts/${state.draft.id}/events`, {});
        if (r.ok) card.id = r.body.id;
        if (Object.keys(card.pending).length) schedule(card, 0);
      }
      requestAnimationFrame(() => card.els.inputs.title.focus());
    });

    // ── the combine, per card ──

    let parishRows = null;
    const rowsFor = () => parishRows || (parishRows = orderParishRows(parish, opts.parishes, may));

    function renderCombine(card) {
      const rows = rowsFor();
      const ticked = new Set(card.fields.also_at);
      let lastJuris = null;
      card.els.also.innerHTML = rows.map(p => {
        let head = '';
        if (!p._isOwn && p.jurisdiction !== lastJuris) {
          lastJuris = p.jurisdiction;
          const j = String(p.jurisdiction || 'Other');
          head = `<div class="ee-group">${esc(j.charAt(0).toUpperCase() + j.slice(1))} Orthodox</div>`;
        }
        const tag = p._isOwn ? '<em class="ee-tag">own</em>' : p._needsAsk ? '<em class="ee-tag ee-tag-ask">needs an owner</em>' : '';
        const sub = p._isOwn ? '' : kmLabel(p._km);
        return `${head}<label class="ee-item"><input type="checkbox" value="${esc(p.id)}"${p._isOwn ? ' checked disabled' : ticked.has(p.id) ? ' checked' : ''}>`
          + `<span>${esc(p.name)}${tag}${sub ? `<small>${esc(sub)}</small>` : ''}</span></label>`;
      }).join('');
      card.els.also.querySelectorAll('input:not([disabled])').forEach(cb => cb.addEventListener('change', () => {
        const list = [...card.els.also.querySelectorAll('input:not([disabled]):checked')].map(x => x.value);
        setList(card, 'also_at', list);
        renderReplaces(card);
      }));
      if (card.candidates == null) loadCandidates(card);
      else renderReplaces(card);
    }

    async function loadCandidates(card) {
      const date = card.fields.date;
      const seq = ++card.candSeq;
      if (!isDate(date)) { card.candidates = []; return renderReplaces(card); }
      card.els.repl.innerHTML = '<div class="ee-empty">Loading…</div>';
      const r = await http('GET', `/api/admin/events/candidates?date=${encodeURIComponent(date)}&tz=${encodeURIComponent(tz)}`);
      if (seq !== card.candSeq) return;
      card.candidates = r.ok && Array.isArray(r.body) ? r.body : [];
      // A date change takes the old day's ticks with it: they named services
      // on a day this event is no longer on.
      const ids = new Set(card.candidates.map(x => String(x.id)));
      const kept = card.fields.replaces.filter(id => ids.has(String(id)));
      if (kept.length !== card.fields.replaces.length) setList(card, 'replaces', kept);
      renderReplaces(card);
      refreshAsk(card);
    }

    function renderReplaces(card) {
      const list = card.els.repl;
      if (!isDate(card.fields.date)) {
        list.innerHTML = '<div class="ee-empty">Pick a date to see what it could replace</div>';
        return;
      }
      if (card.candidates == null) return;
      const at = new Set([parish.id, ...card.fields.also_at]);
      const visible = card.candidates.filter(e => at.has(e.parish_id));
      if (!visible.length) {
        list.innerHTML = '<div class="ee-empty">Nothing on file at the ticked parishes that day</div>';
        return;
      }
      const ticked = new Set(card.fields.replaces.map(String));
      const zoneOf = (pid) => ((opts.parishes || []).find(p => p.id === pid) || {}).timezone || tz;
      list.innerHTML = visible.map(e => {
        const when = new Intl.DateTimeFormat('en-AU', { timeZone: zoneOf(e.parish_id), hour: 'numeric', minute: '2-digit' })
          .format(new Date(e.start_utc));
        const tag = may('event.edit', e.parish_id) ? '' : '<em class="ee-tag ee-tag-ask">needs an owner</em>';
        return `<label class="ee-item"><input type="checkbox" value="${esc(String(e.id))}"${ticked.has(String(e.id)) ? ' checked' : ''}>`
          + `<span>${esc(e.title)}${tag}<small>${esc(when)} · ${esc(e.parish_name || '')}</small></span></label>`;
      }).join('');
      list.querySelectorAll('input').forEach(cb => cb.addEventListener('change', () => {
        setList(card, 'replaces', [...list.querySelectorAll('input:checked')].map(x => x.value));
      }));
    }

    const parishOfTarget = (card) => (rid) => {
      const hit = (card.candidates || []).find(x => String(x.id) === String(rid));
      return hit ? hit.parish_id : null;
    };

    function needsAsk(card) {
      return card.publish.state === 'refused' || askNeeded(card.fields, may, parishOfTarget(card));
    }

    function refreshAsk(card) {
      if (!card.els) return;
      const show = needsAsk(card);
      card.els.ask.hidden = !show;
      if (!show) return;
      const outside = card.publish.outside || [];
      card.els.askWhat.innerHTML = outside.length
        ? `These belong to other parishes, so an owner decides:<br>${outside.map(o => `<b>${esc(o.label)}</b>`).join('<br>')}<br>Your event is published at your own parish either way.`
        : 'Some of what is ticked belongs to another parish, so an owner decides that part. Your event is published at your own parish either way.';
    }

    // ── reading a poster ──

    function abortRead() {
      if (state.read && state.read.ctrl) state.read.ctrl.abort();
      if (state.read) state.read.active = false;
    }

    async function dropFile(file) {
      if (state.publishing) return;
      if (!/^image\//.test(file.type || '')) return showError('That is not an image — a poster has to be a photo or a picture file.');
      showError('');
      if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
      state.objectUrl = URL.createObjectURL(file);
      showPoster(state.objectUrl);
      setStatus('Getting the poster ready…', 'busy');
      let blob;
      try {
        blob = await shrinkPoster(file);
      } catch {
        return setStatus('This image cannot be opened here — try a JPEG or PNG.', 'error');
      }
      await flushAll();
      if (!(await ensureDraft())) return setStatus('The poster could not be saved — check the connection.', 'error', { retry: false });
      startRead(blob);
    }

    async function startRead(blob) {
      abortRead();
      const ctrl = new AbortController();
      state.read = { ctrl, active: true, kind: null, items: 0, blob };
      for (const c of state.cards) c.readFilling = new Set();
      setStatus('Reading the poster…', 'busy', { stop: true });
      sync();
      const url = `/api/admin/drafts/${state.draft.id}/poster${blob ? '' : '?reread=1'}`;
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          body: blob || undefined,
          headers: blob ? { 'Content-Type': blob.type || 'image/jpeg' } : {},
          signal: ctrl.signal,
        });
      } catch {
        if (ctrl.signal.aborted) return;
        state.read.active = false;
        sync();
        return setStatus('The poster could not be sent — check the connection.', 'error', { retry: true });
      }
      if (!res.ok || !String(res.headers.get('content-type') || '').startsWith('text/event-stream')) {
        const b = await res.json().catch(() => null);
        state.read.active = false;
        sync();
        return setStatus((b && b.error) || `The poster was refused (${res.status}).`, 'error');
      }
      const parser = root.AgoraSSE.createSseParser(onFrame);
      try {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        parser.push(decoder.decode());
        parser.end();
      } catch {
        if (ctrl.signal.aborted) return;
        setStatus('The connection dropped — the poster is still being read; reopen this draft in a minute.', 'note');
      } finally {
        if (state.read && state.read.ctrl === ctrl) state.read.active = false;
        $('stop').hidden = true;
        updateHead();
        sync();
      }
    }

    function onFrame({ event, data }) {
      let d;
      try { d = JSON.parse(data); } catch { return; }
      if (state.closed) return;
      if (event === 'poster') {
        if (state.draft) state.draft.poster_path = d.poster_path;
      } else if (event === 'kind') {
        state.read.kind = d.kind;
      } else if (event === 'field') {
        readField(d);
      } else if (event === 'item') {
        state.read.items = Math.max(state.read.items, d.index + 1);
        if (state.multi) setStatus(`Reading the poster… ${state.read.items} found so far.`, 'busy', { stop: true });
      } else if (event === 'error') {
        setStatus(d.error, 'error', { retry: !!d.retry });
      } else if (event === 'result') {
        readResult(d);
      }
    }

    /** A field as the model writes it — into the card, unless a person has it. */
    function readField({ index, name, value, done }) {
      if (index >= 1) enterMulti();
      let card = state.cards[index];
      if (!card) {
        card = newCard({ provisional: true });
        updateHead();
      }
      if (name === 'printed_weekday' || name === 'year_printed') {
        if (takesRead(card, 'date')) card.hints[name] = value;
        return;
      }
      if (!(name in card.fields) || !takesRead(card, name)) return;
      if (!done && name !== 'title' && name !== 'description') return;
      const v = name === 'languages' ? langsToText(value) : (value == null ? '' : String(value));
      card.fields[name] = v;
      card.readFilling.add(name);
      if (done && v !== '') card.fromPoster.add(name);
      setInput(card, name, v);
      refreshCard(card);
    }

    function readResult(d) {
      if (!d.draft) {
        setStatus('This draft was discarded while the poster was being read.', 'note');
        return;
      }
      setDraft(d.draft);
      const rows = d.draft.cards || [];
      rows.forEach((row, i) => {
        const card = state.cards[i] || newCard();
        card.provisional = false;
        cardFromServer(card, row, { keepLocal: true });
        if (!Object.keys(card.pending).length) setSaved(card, 'saved');
      });
      // Anything typed into a card while it was being read goes now.
      for (const c of state.cards) if (Object.keys(c.pending).length) schedule(c, 0);
      if (state.cards.length > 1) enterMulti();
      state.cards.forEach(refreshCard);
      if (d.configured === false) {
        setStatus(d.error || 'Reading posters is not set up on this site — fill in the details by hand.', 'note');
      } else if (d.draft.read_status === 'read') {
        setStatus(readSummary(d.draft), 'done');
      }
      updateHead();
      sync();
    }

    function readSummary(draft) {
      const n = state.cards.length;
      const kind = draft.read_kind;
      const general = (draft.read_notes || []).join(' ');
      let text;
      if (kind === 'not_an_event') text = 'This does not look like an event poster — fill in the details by hand.';
      else if (kind === 'bulletin') text = `Regular services change on the timetable — ${n === 1 && !state.cards[0].fields.title ? 'no' : n} one-off event${n === 1 ? '' : 's'} found.`;
      else if (n > 1) text = `${n} events read from the poster. Check each one against it, then publish.`;
      else text = 'Read from the poster. Check the details against it, then publish.';
      return general ? `${text} ${general}` : text;
    }

    // ── saved drafts at this parish ──

    async function refreshStrip() {
      const strip = $('strip');
      const r = await http('GET', `/api/admin/drafts?parish=${encodeURIComponent(parish.id)}`);
      const others = (r.ok && Array.isArray(r.body) ? r.body : [])
        .filter(d => !state.draft || d.id !== state.draft.id);
      if (state.closed || !others.length) { strip.hidden = true; strip.innerHTML = ''; return; }
      strip.hidden = false;
      const SHOWN = 3;
      strip.innerHTML = `<div class="ee-section-title">Saved drafts here</div>` + others.map((d, i) => {
        const n = d.cards.length;
        const dates = d.cards.map(c => c.date).filter(Boolean).sort();
        const when = dates.length ? ` · ${dateLabel(dates[0])}${dates.length > 1 ? ` – ${dateLabel(dates[dates.length - 1])}` : ''}` : '';
        const title = (d.cards[0] && d.cards[0].title) || 'Untitled';
        return `<div class="ee-strip-row" data-draft="${d.id}"${i >= SHOWN ? ' hidden' : ''}>`
          + (d.poster_path ? `<img class="ee-strip-thumb" src="${esc(d.poster_path)}" alt="">` : '<span class="ee-strip-thumb ee-strip-nothumb"></span>')
          + `<span class="ee-strip-text"><b>${esc(n > 1 ? `${n} events` : title)}</b>${esc(when)}<small>${esc(savedAgo(d))}</small></span>`
          + '<button type="button" class="ee-link" data-act="continue">Continue</button>'
          + '<button type="button" class="ee-link ee-link-danger" data-act="discard">Discard</button></div>';
      }).join('') + (others.length > SHOWN
        ? `<button type="button" class="ee-link" data-act="more">${others.length - SHOWN} more saved draft${others.length - SHOWN > 1 ? 's' : ''}</button>` : '');
      const more = strip.querySelector('[data-act="more"]');
      if (more) more.addEventListener('click', () => {
        strip.querySelectorAll('.ee-strip-row[hidden]').forEach(r => { r.hidden = false; });
        more.remove();
      });
      strip.querySelectorAll('.ee-strip-row').forEach(rowEl => {
        const id = Number(rowEl.dataset.draft);
        rowEl.querySelector('[data-act="continue"]').addEventListener('click', () => loadDraft(id));
        rowEl.querySelector('[data-act="discard"]').addEventListener('click', async () => {
          if (!confirm('Discard that draft? Nothing in it is published, and it cannot be brought back.')) return;
          await http('DELETE', `/api/admin/drafts/${id}`);
          refreshStrip();
        });
      });
    }

    function savedAgo(d) {
      const mins = Math.round((Date.now() - Date.parse(d.updated_at)) / 60000);
      const ago = mins < 2 ? 'just now' : mins < 60 ? `${mins} minutes ago` : mins < 1440
        ? `${Math.round(mins / 60)} hours ago` : `${Math.round(mins / 1440)} days ago`;
      const who = String(d.created_by || '').split('@')[0];
      return `Saved ${ago}${who ? ` · started by ${who}` : ''}`;
    }

    async function loadDraft(id) {
      await flushAll();
      abortRead();
      const r = await http('GET', `/api/admin/drafts/${id}`);
      if (!r.ok) return showError((r.body && r.body.error) || 'That draft could not be opened.');
      for (const c of state.cards) c.els.root.remove();
      state.cards = [];
      state.multi = false;
      setDraft(r.body);
      for (const row of r.body.cards) cardFromServer(newCard(), row);
      if (!state.cards.length) newCard();
      if (state.cards.length > 1) enterMulti();
      if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
      showPoster(r.body.poster_path || null);
      if (r.body.read_status === 'reading') {
        setStatus('This poster is still being read. Read it again if nothing appears in a minute.', 'note', { retry: true });
        state.read = { ctrl: null, active: false, blob: null };
      } else if (r.body.read_status === 'failed') {
        setStatus('Reading this poster did not finish.', 'error', { retry: true });
        state.read = { ctrl: null, active: false, blob: null };
      } else if (r.body.poster_path) {
        setStatus(readSummary(r.body), 'done');
      } else setStatus('');
      state.cards.forEach(refreshCard);
      updateHead();
      sync();
      refreshStrip();
    }

    // ── publishing ──

    function sync() {
      if (state.closed) return;
      const reading = !!(state.read && state.read.active);
      const n = state.cards.filter(c => c.publish.state !== 'done').length;
      const blocked = state.cards.filter(c => C && C.blockers(checksFor(c)).length);
      const quiet = state.cards.every(isPristine);
      const pub = $('publish');
      pub.textContent = state.publishing ? 'Publishing…' : n > 1 ? `Publish all ${n}` : 'Publish';
      pub.disabled = reading || state.publishing || !n || blocked.length > 0;
      $('save-draft').disabled = state.publishing;
      $('discard').disabled = state.publishing;
      $('add-card').disabled = state.publishing;
      const ready = $('readiness');
      if (reading) ready.textContent = 'Publish opens once the poster has been read.';
      else if (blocked.length && !quiet) {
        const first = blocked[0];
        const what = C.blockers(checksFor(first)).map(c => c.text.replace(/\.$/, '').toLowerCase()).join(', ');
        const name = state.multi ? `“${first.fields.title || dateLabel(first.fields.date) || 'An event'}” ` : '';
        const sentence = `${name}${name ? what : what.charAt(0).toUpperCase() + what.slice(1)}`;
        ready.textContent = `${sentence}${blocked.length > 1 ? ` — and ${blocked.length - 1} more` : ''}.`;
      } else ready.textContent = '';
      updateHead();
    }

    async function ensureCandidates(card) {
      if (card.fields.replaces.length && card.candidates == null) await loadCandidates(card);
    }

    $('publish').addEventListener('click', async () => {
      showError('');
      await flushAll();
      if (state.cards.some(c => c.saveState === 'error')) {
        return showError('Some changes have not been saved yet — fix what is marked, then publish.');
      }
      if (!(await ensureDraft())) return;
      state.publishing = true;
      sync();
      const events = [], proposals = [];
      let stopped = null;
      for (const card of state.cards) {
        if (card.publish.state === 'done') continue;
        if (!card.id) { await save(card); if (!card.id) { card.publish = { state: 'error', message: 'Not saved yet.' }; continue; } }
        await ensureCandidates(card);
        const asking = needsAsk(card);
        card.publish = { state: 'busy', message: '' };
        showMessage(`Publishing ${events.length + 1} of ${state.cards.filter(c => c.publish.state !== 'done').length + events.length}…`, 'busy');
        const r = await http('POST', `/api/admin/draft-events/${card.id}/publish`,
          asking ? { propose: (card.fields.ask_reason || '').trim() || true } : {});
        if (r.ok) {
          card.publish = { state: 'done', message: '' };
          events.push(r.body.event);
          if (r.body.proposal_id) proposals.push(r.body.proposal_id);
        } else if (r.status === 403 && r.body && r.body.proposable) {
          card.publish = { state: 'refused', message: r.body.error || '', outside: r.body.outside || [] };
        } else {
          card.publish = { state: 'error', message: (r.body && r.body.error) || (r.status ? `Not published (${r.status}).` : 'Not published — check the connection.') };
          if (!r.status) { stopped = card; break; }
        }
        refreshCard(card);
      }
      state.publishing = false;
      // Published cards leave the list; what is left is what still needs a person.
      for (const c of state.cards.filter(x => x.publish.state === 'done')) c.els.root.remove();
      state.cards = state.cards.filter(c => c.publish.state !== 'done');
      if (!state.cards.length) {
        state.draft = null;
        showMessage('');
        close();
        if (opts.onPublished) opts.onPublished({ events, proposals });
        return;
      }
      if (state.cards.length === 1) state.multi = false;
      for (const c of state.cards) c.open = c.publish.state !== 'idle' && c === state.cards.find(x => x.publish.state !== 'idle');
      state.cards.forEach(refreshCard);
      const asks = state.cards.filter(c => c.publish.state === 'refused').length;
      showMessage(events.length
        ? `${events.length} published. ${state.cards.length} still to go${asks ? ' — part of it needs an owner, so add a reason and publish again' : ''}.`
        : asks ? 'Part of this needs an owner — add a reason and publish again; your own parish’s half goes up either way.'
          : stopped ? 'Publishing stopped — check the connection and try again.' : 'Nothing was published — see what is marked.',
      asks && !stopped ? 'note' : 'error');
      sync();
    });

    $('save-draft').addEventListener('click', async () => {
      await flushAll();
      if (state.cards.some(c => c.saveState === 'error')) {
        return showError('Some changes have not been saved — check the connection, or fix what is marked.');
      }
      close();
      if (opts.onClose) opts.onClose();
    });

    async function discard() {
      const hasAnything = state.draft || state.cards.some(c => Object.values(c.fields).some(v => v && v.length));
      const poster = state.draft && state.draft.poster_path;
      const question = state.cards.length > 1
        ? `Discard these ${state.cards.length} events${poster ? ' and the poster' : ''}? Nothing is published.`
        : `Discard this event${poster ? ' and its poster' : ''}? Nothing is published.`;
      if (hasAnything && !confirm(question)) return;
      abortRead();
      for (const c of state.cards) clearTimeout(c.timer);
      if (state.creating) await state.creating;
      if (state.draft) {
        const r = await http('DELETE', `/api/admin/drafts/${state.draft.id}`);
        if (!r.ok && r.status !== 404) return showError((r.body && r.body.error) || 'It could not be discarded — check the connection.');
        state.draft = null;
      }
      close();
      if (opts.onClose) opts.onClose();
    }
    $('discard').addEventListener('click', discard);

    function close() {
      if (state.closed) return;
      // Whatever is still waiting to save goes now — the page outlives the
      // dialog, so these finish after it has closed.
      for (const c of state.cards) flush(c);
      abortRead();
      state.closed = true;
      document.removeEventListener('paste', onPaste);
      if (state.objectUrl) setTimeout(() => URL.revokeObjectURL(state.objectUrl), 60000);
    }

    // ── start ──
    if (opts.draftId) loadDraft(opts.draftId);
    else {
      newCard();
      refreshStrip();
      requestAnimationFrame(() => { const t = state.cards[0] && state.cards[0].els.inputs.title; if (t) t.focus(); });
    }
    sync();

    return {
      close,
      dropFile,
      get draftId() { return state.draft && state.draft.id; },
    };
  }

  const api = { open, summaryLine, timeRange, dateLabel, orderParishRows, kmLabel, askNeeded,
    textToLangs, langsToText, takesRead };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.AgoraEventEditor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
