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
// A PROGRAMME'S SUNDAYS ARE THE SUNDAYS ALREADY ON FILE. A month's programme
// gives each regular service with that day's saint; the Worker matches those
// to their occurrences when it reads them (`occurrence`), and such a card
// publishes onto that service — its commemoration and the poster — instead of
// beside it. The card says so where the combine would be, and can be unlinked.
//
// A SIGN IS READ INTO THE TIMETABLE. A photo of the board out the front gives
// weekly services and the parish's details, not events: they are shown beside
// what is on file (public/shared/signs.js) and added one by one through the
// routes a person adding them by hand uses, with the sign as their source.
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
// helpers' tests. Needs AgoraEventTypes, AgoraEventChecks, AgoraSSE, AgoraSigns
// and (for the shrink) AgoraLogo loaded first.
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
   * "Sat 14 Nov · 7:00–9:30 pm · Youth Night · Youth". A programme's cards
   * share one title — every Sunday is the Liturgy — so the day's saint is what
   * tells them apart, and stands where the kind would.
   */
  function summaryLine(f, { thisYear } = {}) {
    const feast = String(f.feast || '').trim();
    return [
      dateLabel(f.date, thisYear) || 'No date',
      timeRange(f.start_time, f.end_time) || 'No time',
      (f.title || '').trim() || 'Untitled',
      feast ? `✛ ${feast}` : kindLabel(f.event_type),
    ].filter(Boolean).join(' · ');
  }

  /**
   * What a saved draft is, in a few words, for the lists that offer to
   * continue one: "Youth Night", "3 events", "9 dates of regular services" (a
   * programme), "A church sign · 2 weekly services" (whose one card is empty).
   */
  function draftTitle(d) {
    const cards = (d && d.cards) || [];
    const typed = cards.filter(c => String(c.title || '').trim() || c.date);
    const svcs = ((d && d.read_services) || []).length;
    if (svcs && !typed.length) return `A church sign · ${svcs} weekly service${svcs === 1 ? '' : 's'}`;
    if (cards.length > 1 && cards.every(c => c.occurrence)) return `${cards.length} dates of regular services`;
    if (cards.length > 1) return `${cards.length} events`;
    return (cards[0] && String(cards[0].title || '').trim()) || 'Untitled event';
  }

  const DAY_PLURALS = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];

  /**
   * A weekly service — a rule on file, or one read off a sign — as one line:
   * "2nd & 4th Sundays · 6:00 pm · Divine Liturgy · English".
   */
  function serviceLine(s) {
    const weeks = root.AgoraSigns ? root.AgoraSigns.weeksLabel(s.week_of_month) : '';
    const day = DAY_PLURALS[s.day_of_week] || 'No day';
    let langs = s.languages;
    if (typeof langs === 'string') { try { langs = JSON.parse(langs); } catch { langs = null; } }
    return [
      weeks ? `${weeks} ${day}` : day,
      timeRange(s.start_time, s.end_time) || 'No time',
      (s.title || '').trim() || 'Untitled',
      Array.isArray(langs) && langs.length ? langs.join(', ') : '',
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
   * The parishes a draft can belong to, for the picker: the ones this person
   * may add events to, by name. Unlike orderParishRows this IS narrowed — a
   * draft is somewhere the person can publish, and the Worker refuses a move
   * anywhere else. The current parish is always in it, so the picker can show
   * where the draft is even when the list somehow does not hold it.
   */
  function editableParishes(parishes, may, current) {
    const list = (parishes || []).filter(p => p && p.id && p.id !== '_unassigned' && may('event.edit', p.id));
    if (current && !list.some(p => p.id === current.id)) list.push(current);
    return list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  }

  /**
   * What to say about whose poster this is, from the read's `read_parish`
   * ({name, place, parish_id}, worker/lib/drafts.mjs placeRead):
   *   'move'     — a parish on file this person may add to: one tap moves it
   *   'notYours' — a parish on file they may not: say so, and whose
   *   'named'    — no clear match: the name as printed, and the picker
   *   null       — nothing to say, or the draft is already there.
   */
  function parishSuggestion(readParish, currentId, parishes, may) {
    if (!readParish || !readParish.name) return null;
    const printed = [readParish.name, readParish.place].filter(Boolean).join(', ');
    if (!readParish.parish_id) return { kind: 'named', name: printed };
    if (readParish.parish_id === currentId) return null;
    const p = (parishes || []).find(x => x.id === readParish.parish_id);
    if (!p) return { kind: 'named', name: printed };
    return { kind: may('event.edit', p.id) ? 'move' : 'notYours', parish: p };
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
  const TEXT_FIELDS = ['title', 'feast', 'description', 'languages', 'location_override', 'ask_reason'];

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
    title: '', feast: '', date: '', start_time: '', end_time: '', event_type: '', description: '',
    languages: '', location_override: '', also_at: [], replaces: [], ask_reason: '', occurrence: '',
  });

  /** A field's value as the Worker stores it. */
  function toPatchValue(field, v) {
    if (field === 'languages') { const l = textToLangs(v); return l.length ? l : null; }
    if (field === 'also_at' || field === 'replaces') return v && v.length ? v : null;
    return v === '' ? null : v;
  }

  let editors = 0;

  /**
   * @param {HTMLElement} mount
   * @param {object} opts
   *   parish      {id, name, timezone, lat, lng, jurisdiction, address} — or null,
   *               and the editor asks for one first (/admin, more than one parish)
   *   parishes    every parish: the picker's choices and "also appears at"
   *   may         (capability, parishId) => boolean — the same two questions the Worker asks
   *   draftId     continue this draft instead of starting blank; its parish wins
   *   onPublished ({events, proposals}) once every card is on the site
   *   onClose     () — Save draft, Discard, or nothing left to do
   *   onParishChange (parish) — the picker moved the draft, or a draft was opened
   *   openPoster  (url) — the host's full-screen viewer, if it has one
   *   keepByHand  (parishId) => Promise<boolean> — the host's "keep it by hand
   *               from now on?" before the first write a sign makes to a parish
   *               still read from a source; false stops the write
   *   onChanged   ({parishId, what: 'timetable'|'details'}) — a sign changed the
   *               parish itself, which the host shows and the cards do not
   */
  function open(mount, opts) {
    const may = opts.may || (() => true);
    const C = root.AgoraEventChecks;
    const uid = `ee${++editors}`;

    const state = {
      // Where the draft is. A poster dropped at the wrong parish says whose it
      // is, and the picker moves the draft there — so this is state, not a given.
      parish: opts.parish || null,
      draft: null,            // {id, poster_path, read_status, read_kind, read_notes, read_parish}
      creating: null,         // the POST that makes the draft, while it is in flight
      cards: [],
      nextKey: 1,
      multi: false,
      read: null,             // {ctrl, active, kind, items, blob}
      posterUrl: null,        // what the thumbnail shows
      objectUrl: null,        // to revoke
      publishing: false,
      moving: false,          // the PATCH that moves the draft, while it is in flight
      closed: false,
      // The parish's timetable, every rule (GET /api/admin/schedules): what a
      // sign is set beside, and what a programme's cards were matched to.
      rules: null,
      // A sign's weekly services, as the person has corrected them, and which
      // rows are open for that.
      services: [],
      svcOpen: new Set(),
      svcTimer: null,
      signBusy: false,
      keptByHand: false,
      // A sign's draft shows its (empty) card only once somebody asks to add an event too.
      wantCards: false,
    };
    const zone = () => (state.parish && state.parish.timezone) || 'Australia/Sydney';
    const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: zone() }).format(new Date());
    const tzHint = () => `${zone().split('/').pop().replace(/_/g, ' ')} time, the way the parish publishes it.`;
    const parishById = (id) => (opts.parishes || []).find(p => p.id === id)
      || (state.parish && state.parish.id === id ? state.parish : null);

    // ── skeleton ──
    mount.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'ee';
    el.innerHTML = `
      <div class="ee-parish">
        <label for="${uid}-parish">Parish</label>
        <select id="${uid}-parish" data-ee="parish"></select>
      </div>
      <div class="ee-suggest" data-ee="suggest" aria-live="polite" hidden></div>
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
        <div class="ee-sign" data-ee="sign" aria-live="polite" hidden></div>
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
          <button type="button" class="ee-btn ee-btn-primary" data-ee="done" hidden>Done</button>
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
        state.draft.read_details = null;
        state.draft.read_kind = null;
      }
      // A sign's proposals were the poster's; without it there is nothing to add from.
      clearTimeout(state.svcTimer);
      state.svcTimer = null;
      state.services = [];
      renderSign();
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
        const r = await http('POST', '/api/admin/drafts', { parish_id: state.parish.id, card });
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
        read_kind: d.read_kind, read_notes: d.read_notes || [], read_parish: d.read_parish || null,
        read_language: d.read_language || null, read_details: d.read_details || null };
      // What the person is still correcting stays theirs until it has saved.
      if (!state.svcTimer) state.services = (d.read_services || []).map(x => ({ ...x }));
      renderSuggestion();
      renderSign();
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
        title: row.title || '', feast: row.feast || '', occurrence: row.occurrence || '',
        date: row.date || '', start_time: row.start_time || '',
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
          ${row('feast', 'Commemoration', `<input id="${fieldId(card, 'feast')}" data-ee-field="feast" placeholder="Optional — the saint or feast of the day" autocomplete="off">`,
            '<div class="ee-hint" data-hint="feast"></div>')}
          ${row('date', 'Date', `<input type="date" id="${fieldId(card, 'date')}" data-ee-field="date">`)}
          <div class="ee-grid">
            ${row('start_time', 'Starts', `<input type="time" id="${fieldId(card, 'start_time')}" data-ee-field="start_time">`)}
            ${row('end_time', 'Ends', `<input type="time" id="${fieldId(card, 'end_time')}" data-ee-field="end_time">`)}
          </div>
          <div class="ee-hint" data-hint="zone">${esc(tzHint())}</div>
          ${row('event_type', 'Kind', `<select id="${fieldId(card, 'event_type')}" data-ee-field="event_type"><option value="">Choose a kind</option>${kinds}</select>`)}
          ${row('description', 'Description', `<textarea id="${fieldId(card, 'description')}" data-ee-field="description" rows="3" placeholder="Optional"></textarea>`)}
          ${row('languages', 'Languages', `<input id="${fieldId(card, 'languages')}" data-ee-field="languages" placeholder="English, Greek" autocomplete="off">`)}
          ${row('location_override', 'Held elsewhere', `<input id="${fieldId(card, 'location_override')}" data-ee-field="location_override" placeholder="Leave empty if it is at the parish" autocomplete="off">`,
            '<div class="ee-hint">A venue for this one event. The parish’s own address and pin are untouched.</div>')}
          <div class="ee-occ" hidden>
            <div class="ee-occ-what"></div>
            <button type="button" class="ee-link" data-act="unlink">Make it a separate event instead</button>
          </div>
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
        zone: node.querySelector('[data-hint="zone"]'),
        feastHint: node.querySelector('[data-hint="feast"]'),
        occ: node.querySelector('.ee-occ'),
        occWhat: node.querySelector('.ee-occ-what'),
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
      node.querySelector('[data-act="unlink"]').addEventListener('click', () => unlinkCard(card));
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
        // A programme's Sunday on another date is not that Sunday any more.
        if (card.fields.occurrence && card.fields.occurrence.split(':')[1] !== value) {
          unlinkCard(card, { quiet: true });
          card.notes.push({ field: 'date', text: 'A new date, so this is an event of its own now — not a change to the regular service.' });
        }
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

    /** A card matched to a regular service, made an event of its own. */
    function unlinkCard(card, { quiet = false } = {}) {
      if (!card.fields.occurrence) return;
      card.fields.occurrence = '';
      card.touched.add('occurrence');
      card.pending.occurrence = null;
      if (!quiet) {
        card.publish = { state: 'idle', message: '' };
        schedule(card, 0);
        refreshCard(card);
        sync();
      }
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
      // One save per card at a time, in order: two in flight could land the
      // older value of a field last.
      while (card.saving) await card.saving;
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
      card.els.chips.innerHTML = (card.fields.occurrence ? '<span class="ee-chip ee-chip-occ">regular service</span>' : '')
        + checks
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
      refreshOccurrence(card);
      const single = !state.multi;
      card.els.sum.hidden = single;
      card.els.body.hidden = !single && !card.open;
      card.els.sum.setAttribute('aria-expanded', String(single || card.open));
      card.els.root.classList.toggle('is-open', single || card.open);
      card.els.root.classList.toggle('is-published', card.publish.state === 'done');
      refreshAsk(card);
    }

    /**
     * A card matched to a regular service says which, where the combine would
     * be — publishing writes onto that service, so there is nothing to combine.
     */
    function refreshOccurrence(card) {
      const occ = card.fields.occurrence;
      card.els.occ.hidden = !occ;
      card.els.combine.hidden = !!occ;
      card.els.feastHint.textContent = occ
        ? 'Shown under the service’s name on that day.'
        : 'A one-off event has no line for it, so it is added to the title when published.';
      card.els.feastHint.hidden = !String(card.fields.feast || '').trim();
      if (!occ) return;
      const rule = (state.rules || []).find(r => String(r.id) === occ.split(':')[0]);
      const which = rule ? `<b>${esc(timeRange(rule.start_time, rule.end_time))} ${esc(rule.title)}</b>` : 'service';
      card.els.occWhat.innerHTML = `On the timetable: this is the parish’s regular ${which} on ${esc(dateLabel(occ.split(':')[1]))}. Publishing adds what is here, and the poster, to that service — no second card beside it.`;
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
      // A programme's cards are dates of services already on file, not events.
      const what = n && state.cards.every(c => c.fields.occurrence) ? 'dates' : 'events';
      h.textContent = state.read && state.read.active ? `${n} ${what} found so far…`
        : `${n} ${what}${state.draft && state.draft.poster_path ? ' read' : ''} — saved as a draft, not yet published. Tap one to check or change it.`;
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
      // A sign's draft keeps its one empty card out of sight; asking to add
      // an event is asking for that card, not a second one.
      if (signOnly()) {
        state.wantCards = true;
        renderSign();
        sync();
        const t = state.cards[0] && state.cards[0].els.inputs.title;
        if (t) requestAnimationFrame(() => t.focus());
        return;
      }
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

    let parishRows = null;    // ordered from the draft's parish; a move starts them again
    const rowsFor = () => parishRows || (parishRows = orderParishRows(state.parish, opts.parishes, may));

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
      const r = await http('GET', `/api/admin/events/candidates?date=${encodeURIComponent(date)}&tz=${encodeURIComponent(zone())}`);
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
      const at = new Set([state.parish.id, ...card.fields.also_at]);
      const visible = card.candidates.filter(e => at.has(e.parish_id));
      // A tick on a service this list no longer shows — its parish unticked
      // above, or the draft moved away from it — goes: a hidden tick would
      // still combine that service into this event on Publish.
      const shown = new Set(visible.map(e => String(e.id)));
      const kept = card.fields.replaces.filter(id => shown.has(String(id)));
      if (kept.length !== card.fields.replaces.length) setList(card, 'replaces', kept);
      if (!visible.length) {
        list.innerHTML = '<div class="ee-empty">Nothing on file at the ticked parishes that day</div>';
        return;
      }
      const ticked = new Set(card.fields.replaces.map(String));
      const zoneOf = (pid) => ((opts.parishes || []).find(p => p.id === pid) || {}).timezone || zone();
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
      // The draft a poster goes on belongs to a parish; until one is chosen
      // there is nowhere to put it (the poster panel is not shown either).
      if (state.publishing || !state.parish) return;
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
        if (d.kind === 'timetable') setStatus('Reading the sign…', 'busy', { stop: true });
      } else if (event === 'service') {
        setStatus(`Reading the sign… ${d.index + 1} service${d.index ? 's' : ''} found so far.`, 'busy', { stop: true });
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
      renderSign();
      updateHead();
      sync();
    }

    function readSummary(draft) {
      const n = state.cards.length;
      const kind = draft.read_kind;
      const general = (draft.read_notes || []).join(' ');
      const regular = state.cards.filter(c => c.fields.occurrence).length;
      const svcs = (draft.read_services || state.services || []).length;
      let text;
      if (svcs && (kind === 'timetable' || state.cards.every(isPristine))) {
        text = `Read as the parish’s timetable: ${svcs} weekly service${svcs === 1 ? '' : 's'}${draft.read_details ? ' and its details' : ''}. Check each against the photo, then add it.`;
      } else if (kind === 'timetable') text = 'This looks like a sign, but no weekly services could be read from it — add them on the timetable by hand.';
      else if (kind === 'not_an_event') text = 'This does not look like an event poster — fill in the details by hand.';
      else if (regular) {
        text = `${n} date${n === 1 ? '' : 's'} read. ${regular === n ? (n === 1 ? 'It is' : 'All are') : `${regular} ${regular === 1 ? 'is' : 'are'}`} the parish’s regular services: publishing adds each day’s details and the poster to that service rather than a second card.`;
      } else if (kind === 'bulletin') text = `Regular services change on the timetable — ${n === 1 && !state.cards[0].fields.title ? 'no' : n} one-off event${n === 1 ? '' : 's'} found.`;
      else if (n > 1) text = `${n} events read from the poster. Check each one against it, then publish.`;
      else text = 'Read from the poster. Check the details against it, then publish.';
      // The read is in English; the poster stays attached in the original.
      if (draft.read_language) text += ` Translated from ${draft.read_language} — the poster keeps the original.`;
      return general ? `${text} ${general}` : text;
    }

    // ── the timetable: what a programme was matched to, and what a sign is set beside ──

    async function loadRules() {
      if (!state.parish) return;
      const pid = state.parish.id;
      const r = await http('GET', `/api/admin/schedules?parish=${encodeURIComponent(pid)}`);
      if (state.closed || !state.parish || state.parish.id !== pid) return;
      state.rules = r.ok && Array.isArray(r.body) ? r.body.filter(x => x.parish_id === pid) : [];
      state.cards.forEach(refreshCard);
      renderSign();
    }

    const signShown = () => !!(state.draft && (state.services.length
      || (state.draft.read_kind === 'timetable' && state.draft.read_details)));

    /** Nothing in the cards and a sign above them: the cards are not what this is for. */
    const signOnly = () => signShown() && !state.wantCards && state.cards.every(isPristine);

    const LANG_SPLIT = (t) => String(t || '').split(',').map(x => x.trim()).filter(Boolean);
    const DETAIL_LABELS = { address: 'Address', phone: 'Phone', email: 'Email', website: 'Website' };

    function signError(text) {
      const e = $('sign').querySelector('.ee-sign-error');
      if (!e) return showError(text);
      e.textContent = text || '';
      e.hidden = !text;
    }

    function renderSign() {
      const box = $('sign');
      const show = signShown();
      box.hidden = !show;
      el.classList.toggle('ee-sign-only', signOnly());
      if (!show) { box.innerHTML = ''; return; }
      const S = root.AgoraSigns;
      if (!S || !state.rules) { box.innerHTML = '<div class="ee-empty">Checking the parish’s timetable…</div>'; return; }
      const pid = state.parish.id;
      const busy = state.signBusy || state.publishing;
      const { rows, missing } = S.compareSign(state.services, state.rules, today());
      const canAdd = may('schedule.create', pid);
      const canFill = may('schedule.edit', pid);
      const fresh = rows.map((r, i) => ({ ...r, i })).filter(r => r.status === 'new');
      const dis = busy ? ' disabled' : '';
      const types = (root.AgoraEventTypes ? root.AgoraEventTypes.KINDS : []);

      const svcRow = (r, i) => {
        const sv = r.service;
        const notes = (sv.read_notes || []).map(n => `<div class="ee-note ee-note-read">${esc(n.text)}</div>`).join('');
        if (r.status === 'weeks') {
          const was = S.weeksLabel(r.rule.week_of_month) || 'every';
          const now = S.weeksLabel(sv.week_of_month) || 'every';
          return `<div class="ee-svc is-new" data-i="${i}">
            <div class="ee-svc-top"><span class="ee-svc-line">${esc(serviceLine(sv))}</span></div>
            <div class="ee-svc-state">On the timetable as “${esc(r.rule.title)}” on ${esc(was)} ${esc(DAY_PLURALS[r.rule.day_of_week])}; the sign says ${esc(now)}.</div>
            ${canFill ? `<button type="button" class="ee-btn ee-btn-small" data-act="fill" data-i="${i}"${dis}>Change it to ${esc(now)} ${esc(DAY_PLURALS[sv.day_of_week])}</button>` : ''}
            ${notes}</div>`;
        }
        if (r.status === 'on_file') {
          const fills = Object.keys(r.fills);
          const what = fills.map(f => (f === 'end_time' ? 'end time' : 'languages')).join(' and ');
          const named = r.rule.title && r.rule.title !== sv.title ? ` as “${esc(r.rule.title)}”` : '';
          return `<div class="ee-svc is-on" data-i="${i}">
            <div class="ee-svc-top"><span class="ee-svc-line">${esc(serviceLine(sv))}</span></div>
            <div class="ee-svc-state">✓ On the timetable${named}${fills.length ? ` — the sign adds its ${what}.` : '.'}</div>
            ${fills.length && canFill ? `<button type="button" class="ee-btn ee-btn-small" data-act="fill" data-i="${i}"${dis}>Add its ${what}</button>` : ''}
            ${notes}</div>`;
        }
        const open = state.svcOpen.has(i);
        const weeks = String(sv.week_of_month || '').split(',');
        const field = (label, input) => `<label class="ee-svc-field"><span>${label}</span>${input}</label>`;
        return `<div class="ee-svc is-new${open ? ' is-open' : ''}" data-i="${i}">
          <div class="ee-svc-top">
            <button type="button" class="ee-svc-sum" data-act="toggle" data-i="${i}" aria-expanded="${open}"><span class="ee-svc-line">${esc(serviceLine(sv))}</span></button>
            ${canAdd ? `<button type="button" class="ee-btn ee-btn-small ee-btn-add" data-act="add" data-i="${i}"${dis}>Add to timetable</button>` : ''}
          </div>
          ${notes}
          <div class="ee-svc-form"${open ? '' : ' hidden'}>
            ${field('Service', `<input data-sf="title" data-i="${i}" value="${esc(sv.title || '')}" placeholder="Divine Liturgy" autocomplete="off">`)}
            <div class="ee-grid ee-grid-3">
              ${field('Day', `<select data-sf="day_of_week" data-i="${i}">${DAY_PLURALS.map((d, k) => `<option value="${k}"${k === sv.day_of_week ? ' selected' : ''}>${d}</option>`).join('')}</select>`)}
              ${field('Starts', `<input type="time" data-sf="start_time" data-i="${i}" value="${esc(sv.start_time || '')}">`)}
              ${field('Ends', `<input type="time" data-sf="end_time" data-i="${i}" value="${esc(sv.end_time || '')}">`)}
            </div>
            <div class="ee-svc-weeks"><span>Weeks of the month</span>${S.WEEKS.map(w => `<label><input type="checkbox" data-sf="week" data-week="${w}" data-i="${i}"${weeks.includes(w) ? ' checked' : ''}> ${w === 'last' ? 'Last' : ({ first: '1st', second: '2nd', third: '3rd', fourth: '4th' })[w]}</label>`).join('')}<small>None ticked is every week.</small></div>
            <div class="ee-grid">
              ${field('Languages', `<input data-sf="languages" data-i="${i}" value="${esc((sv.languages || []).join(', '))}" placeholder="English, Greek" autocomplete="off">`)}
              ${field('Kind', `<select data-sf="event_type" data-i="${i}">${types.map(k => `<option value="${esc(k.id)}"${k.id === (sv.event_type || 'liturgy') ? ' selected' : ''}>${esc(k.label)}</option>`).join('')}</select>`)}
            </div>
          </div>
        </div>`;
      };

      // Nothing to add, and the timetable does not yet say this sign is where
      // it was last checked: a sign that agrees is still somebody having looked.
      const pidRules = state.rules.filter(r => r.active !== 0);
      const confirmable = canFill && rows.length && rows.every(r => r.status === 'on_file' && !Object.keys(r.fills).length)
        && pidRules.some(r => r.source_ref !== state.draft.poster_path);
      const details = S.compareDetails(state.draft.read_details, state.parish);
      const canDetail = may('parish.edit', pid);
      const detailRow = (d) => {
        const label = DETAIL_LABELS[d.field];
        let act = '';
        if (d.status === 'same') act = '<span class="ee-svc-state">✓ Same as on file</span>';
        else if (d.field === 'address') {
          act = `<span class="ee-svc-state">${d.onFile ? `On file: ${esc(d.onFile)}. ` : ''}Change the address in the parish’s details, where its pin moves with it.</span>`;
        } else if (canDetail) {
          act = (d.onFile ? `<span class="ee-svc-state">On file: ${esc(d.onFile)}</span>` : '')
            + `<button type="button" class="ee-btn ee-btn-small" data-act="detail" data-field="${d.field}"${dis}>${d.onFile ? 'Use the sign’s' : 'Add it'}</button>`;
        }
        return `<div class="ee-detail"><span class="ee-detail-label">${label}</span><span class="ee-detail-value">${esc(d.sign)}</span>${act}</div>`;
      };

      box.innerHTML = `
        ${rows.length ? `<div class="ee-section-title">Weekly services on the sign</div>
        <div class="ee-svcs">${rows.map((r, i) => svcRow(r, i)).join('')}</div>` : ''}
        ${fresh.length > 1 && canAdd ? `<button type="button" class="ee-btn ee-btn-small" data-act="add-all"${dis}>Add all ${fresh.length} to the timetable</button>` : ''}
        ${rows.length && !canAdd && fresh.length ? '<div class="ee-hint">Somebody who edits this parish’s timetable can add these.</div>' : ''}
        ${confirmable ? `<div class="ee-svc-state">Everything on the sign is on the timetable.</div>
          <button type="button" class="ee-btn ee-btn-small" data-act="confirm"${dis}>Mark the timetable as checked against this sign</button>` : ''}
        ${missing.length && rows.length ? `<details class="ee-missing"><summary>${missing.length} on the timetable ${missing.length === 1 ? 'is' : 'are'} not on the sign</summary>
          ${missing.map(r => `<div class="ee-svc-line">${esc(serviceLine(r))}</div>`).join('')}
          <div class="ee-hint">Nothing changes for these: a sign often leaves out the weekday services. If one has stopped, end it from the parish’s timetable.</div></details>` : ''}
        ${details.length ? `<div class="ee-section-title">The parish’s details on the sign</div><div class="ee-details">${details.map(detailRow).join('')}</div>` : ''}
        <div class="ee-hint">What you add shows “${esc(S.SIGN_SOURCE)}” as its source, linking to this photo.</div>
        <div class="ee-message ee-message-error ee-sign-error" hidden></div>`;
    }

    // One listener for the panel, which is redrawn whole.
    $('sign').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-act]');
      if (!b || b.disabled) return;
      const i = Number(b.dataset.i);
      const act = b.dataset.act;
      if (act === 'toggle') {
        if (state.svcOpen.has(i)) state.svcOpen.delete(i); else state.svcOpen.add(i);
        renderSign();
        return;
      }
      signError('');
      state.signBusy = true;
      renderSign();
      try {
        if (act === 'add') await addServices([i]);
        else if (act === 'add-all') {
          const { rows } = root.AgoraSigns.compareSign(state.services, state.rules, today());
          await addServices(rows.map((r, k) => (r.status === 'new' ? k : -1)).filter(k => k >= 0));
        } else if (act === 'fill') await fillRule(i);
        else if (act === 'confirm') await confirmTimetable();
        else if (act === 'detail') await useDetail(b.dataset.field);
      } finally {
        state.signBusy = false;
        renderSign();
        sync();
      }
    });

    function onServiceEdit(e) {
      const inp = e.target.closest('[data-sf]');
      if (!inp) return;
      const i = Number(inp.dataset.i);
      const sv = state.services[i];
      if (!sv) return;
      const f = inp.dataset.sf;
      if (f === 'week') {
        const box = inp.closest('.ee-svc-weeks');
        const ticked = [...box.querySelectorAll('input:checked')].map(x => x.dataset.week);
        sv.week_of_month = ticked.length ? ticked.join(',') : null;
      } else if (f === 'day_of_week') sv.day_of_week = Number(inp.value);
      else if (f === 'languages') sv.languages = LANG_SPLIT(inp.value);
      else sv[f] = inp.value || null;
      // A person has checked this field: the model's doubt about it goes.
      sv.read_notes = (sv.read_notes || []).filter(n => n.field !== f && !(f === 'week' && n.field === 'weeks')
        && !(f === 'day_of_week' && n.field === 'day'));
      const line = inp.closest('.ee-svc').querySelector('.ee-svc-line');
      if (line) line.textContent = serviceLine(sv);
      clearTimeout(state.svcTimer);
      state.svcTimer = setTimeout(saveServices, e.type === 'input' ? SAVE_DELAY : 0);
      // Whether it is on file may have changed; redraw once the field is left.
      if (e.type === 'change') { state.svcOpen.add(i); renderSign(); }
    }
    $('done').addEventListener('click', () => doneWithSign());
    $('sign').addEventListener('input', onServiceEdit);
    $('sign').addEventListener('change', onServiceEdit);

    async function saveServices() {
      state.svcTimer = null;
      if (!state.draft) return;
      const r = await http('PUT', `/api/admin/drafts/${state.draft.id}/services`, { services: state.services });
      if (!r.ok) signError((r.body && r.body.error) || 'The changes to the services were not saved — check the connection.');
    }

    /** The first hand edit at a parish still read from a source asks, once (the host's question). */
    async function keepByHand() {
      if (state.keptByHand || !opts.keepByHand) return true;
      const ok = await opts.keepByHand(state.parish.id);
      if (ok) state.keptByHand = true;
      return ok;
    }

    const changed = (what) => { if (opts.onChanged) opts.onChanged({ parishId: state.parish.id, what }); };

    /** Add these services, as read and corrected, to the timetable — the sign as their source. */
    async function addServices(indices) {
      if (state.svcTimer) { clearTimeout(state.svcTimer); await saveServices(); }
      for (const i of indices) {
        const sv = state.services[i];
        if (!sv || !String(sv.title || '').trim()) {
          state.svcOpen.add(i);
          return signError('Give each service a name before adding it.');
        }
      }
      if (!indices.length || !(await keepByHand())) return;
      let added = 0;
      for (const i of indices) {
        const sv = state.services[i];
        const r = await http('POST', '/api/admin/schedules', {
          parish_id: state.parish.id,
          title: sv.title.trim(),
          day_of_week: sv.day_of_week,
          start_time: sv.start_time,
          end_time: sv.end_time || null,
          event_type: sv.event_type || 'liturgy',
          languages: sv.languages && sv.languages.length ? JSON.stringify(sv.languages) : null,
          week_of_month: sv.week_of_month || null,
          source_name: root.AgoraSigns.SIGN_SOURCE,
          source_ref: state.draft.poster_path,
        });
        if (!r.ok) { signError((r.body && r.body.error) || 'That service could not be added — check the connection.'); break; }
        state.svcOpen.delete(i);
        added++;
      }
      if (added) { await loadRules(); changed('timetable'); }
    }

    /** What the sign says that a rule on file leaves empty. */
    async function fillRule(i) {
      const { rows } = root.AgoraSigns.compareSign(state.services, state.rules, today());
      const row = rows[i];
      if (!row || row.status === 'new' || !Object.keys(row.fills).length) return;
      if (!(await keepByHand())) return;
      const body = { source_name: root.AgoraSigns.SIGN_SOURCE, source_ref: state.draft.poster_path };
      if (row.fills.end_time) body.end_time = row.fills.end_time;
      if (row.fills.languages) body.languages = JSON.stringify(row.fills.languages);
      // The sign's weeks replace the rule's, and a fortnightly parity with them:
      // a rule holds one or the other.
      if (row.status === 'weeks') { body.week_of_month = row.fills.week_of_month; body.week_parity = null; }
      const r = await http('PATCH', `/api/admin/schedules/${row.rule.id}`, body);
      if (!r.ok) return signError((r.body && r.body.error) || 'It could not be added — check the connection.');
      await loadRules();
      changed('timetable');
    }

    /**
     * The sign agrees with the timetable: say so on its source line. Any rule
     * edit that names a source restamps the whole timetable with it
     * (stampTimetable — one timetable, one source), so naming it on one rule
     * is the whole write.
     */
    async function confirmTimetable() {
      const rule = (state.rules || []).find(r => r.active !== 0);
      if (!rule || !(await keepByHand())) return;
      const r = await http('PATCH', `/api/admin/schedules/${rule.id}`,
        { source_name: root.AgoraSigns.SIGN_SOURCE, source_ref: state.draft.poster_path });
      if (!r.ok) return signError((r.body && r.body.error) || 'It could not be saved — check the connection.');
      await loadRules();
      changed('timetable');
    }

    /** One of the parish's details, as the sign prints it — a person's choice, the sign its source. */
    async function useDetail(field) {
      const value = state.draft.read_details && state.draft.read_details[field];
      if (!value || field === 'address') return;
      if (!(await keepByHand())) return;
      const r = await http('PATCH', `/api/admin/parishes/${encodeURIComponent(state.parish.id)}`, {
        [field]: value,
        info_source_type: 'person',
        info_source_name: root.AgoraSigns.SIGN_SOURCE,
        info_source_ref: state.draft.poster_path,
      });
      if (!r.ok) return signError((r.body && r.body.error) || 'It could not be saved — check the connection.');
      // The host's copy of the parish, so its card shows the detail and the
      // source line it now has without a reload.
      const stamp = { [field]: value, info_source_type: 'person', info_source_name: root.AgoraSigns.SIGN_SOURCE,
        info_source_ref: state.draft.poster_path, info_checked_at: new Date().toISOString() };
      Object.assign(state.parish, stamp);
      const listed = (opts.parishes || []).find(p => p.id === state.parish.id);
      if (listed && listed !== state.parish) Object.assign(listed, stamp);
      changed('details');
    }

    /** Close a sign's draft. The photo stays wherever a service or a detail names it. */
    async function doneWithSign() {
      const { rows } = root.AgoraSigns.compareSign(state.services, state.rules || [], today());
      const left = rows.filter(r => r.status === 'new').length;
      if (left && !confirm(`${left} service${left === 1 ? '' : 's'} on the sign ${left === 1 ? 'is' : 'are'} not on the timetable. Close it anyway?`)) return;
      clearTimeout(state.svcTimer);
      state.svcTimer = null;
      if (state.draft) {
        const r = await http('DELETE', `/api/admin/drafts/${state.draft.id}`);
        if (!r.ok && r.status !== 404) return signError((r.body && r.body.error) || 'It could not be closed — check the connection.');
        state.draft = null;
      }
      close();
      if (opts.onClose) opts.onClose();
    }

    // ── saved drafts at this parish ──

    async function refreshStrip() {
      const strip = $('strip');
      if (!state.parish) { strip.hidden = true; return; }
      const r = await http('GET', `/api/admin/drafts?parish=${encodeURIComponent(state.parish.id)}`);
      const others = (r.ok && Array.isArray(r.body) ? r.body : [])
        .filter(d => !state.draft || d.id !== state.draft.id);
      if (state.closed || !others.length) { strip.hidden = true; strip.innerHTML = ''; return; }
      strip.hidden = false;
      const SHOWN = 3;
      strip.innerHTML = `<div class="ee-section-title">Saved drafts here</div>` + others.map((d, i) => {
        const n = d.cards.length;
        const dates = d.cards.map(c => c.date).filter(Boolean).sort();
        const when = dates.length ? ` · ${dateLabel(dates[0])}${dates.length > 1 ? ` – ${dateLabel(dates[dates.length - 1])}` : ''}` : '';
        return `<div class="ee-strip-row" data-draft="${d.id}"${i >= SHOWN ? ' hidden' : ''}>`
          + (d.poster_path ? `<img class="ee-strip-thumb" src="${esc(d.poster_path)}" alt="">` : '<span class="ee-strip-thumb ee-strip-nothumb"></span>')
          + `<span class="ee-strip-text"><b>${esc(draftTitle(d))}</b>${esc(when)}<small>${esc(savedAgo(d))}</small></span>`
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
      clearTimeout(state.svcTimer);
      state.svcTimer = null;
      state.svcOpen = new Set();
      state.wantCards = false;
      // The draft says where it is — it may have been moved since it was listed.
      const at = parishById(r.body.parish_id) || { id: r.body.parish_id, name: r.body.parish_name };
      if (!state.parish || at.id !== state.parish.id) setParish(at);
      else if (!state.rules) loadRules();
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
      renderSign();
      updateHead();
      sync();
      refreshStrip();
    }

    // ── the parish ──
    //
    // A poster dropped at the wrong parish is the usual reason to change it:
    // the read says whose poster it is (worker/lib/drafts.mjs placeRead), and
    // the editor offers that parish in one tap. The picker does the rest. The
    // cards move with the draft, on the Worker, which also takes off a venue
    // that was only the new parish's own address (moveDraft).

    function renderPicker() {
      const sel = $('parish');
      const list = editableParishes(opts.parishes, may, state.parish);
      sel.innerHTML = (state.parish ? '' : '<option value="">Choose the parish…</option>')
        + list.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('');
      sel.value = state.parish ? state.parish.id : '';
      el.classList.toggle('ee-no-parish', !state.parish);
    }

    function renderSuggestion() {
      const box = $('suggest');
      const s = state.parish && state.draft
        && parishSuggestion(state.draft.read_parish, state.parish.id, opts.parishes, may);
      box.hidden = !s;
      if (!s) { box.innerHTML = ''; return; }
      if (s.kind === 'move') {
        box.innerHTML = `<span>This poster looks like it is from <b>${esc(s.parish.name)}</b>, not ${esc(state.parish.name)}.</span>`
          + '<button type="button" class="ee-btn ee-btn-small" data-ee="move-suggested">Move it there</button>';
        box.querySelector('[data-ee="move-suggested"]').addEventListener('click', () => moveTo(s.parish.id));
      } else if (s.kind === 'notYours') {
        box.innerHTML = `<span>This poster looks like it is from <b>${esc(s.parish.name)}</b>, which is not one of your parishes — somebody who edits it can add it there.</span>`;
      } else {
        box.innerHTML = `<span>The poster names <b>${esc(s.name)}</b>. If that is not ${esc(state.parish.name)}, choose its parish above.</span>`;
      }
      sync();
    }

    /** Point everything that hangs off the parish at a new one. */
    function setParish(next) {
      state.parish = next;
      parishRows = null;
      // Another parish, another timetable: what a sign is set beside, and what
      // a card can be a change to (the move unlinks them on the Worker).
      state.rules = null;
      state.keptByHand = false;
      loadRules();
      for (const c of state.cards) {
        if (c.els && c.els.zone) c.els.zone.textContent = tzHint();
        // The day's services are looked up in the parish's zone, and "replaces"
        // shows the new parish's: both start again, and a tick on a service the
        // list no longer shows goes with them (renderReplaces).
        c.candidates = null;
        if (c.els && c.els.combine.open) renderCombine(c);
        else if (c.fields.replaces.length) loadCandidates(c);
      }
      renderPicker();
      renderSuggestion();
      refreshStrip();
      state.cards.forEach(refreshCard);
      if (opts.onParishChange) opts.onParishChange(next);
    }

    /** Move the draft — or, before there is one, just the editor — to another parish. */
    async function moveTo(pid) {
      const sel = $('parish');
      const next = parishById(pid);
      if (!next || (state.parish && next.id === state.parish.id)) {
        sel.value = state.parish ? state.parish.id : '';
        return;
      }
      if (!state.parish) { setParish(next); begin(); return; }
      showError('');
      // Nothing saved yet: the draft is made where the editor now is.
      if (!state.draft && !state.creating) { setParish(next); sync(); return; }
      state.moving = true;
      sync();
      // What is typed goes first, to the draft where it is; then the draft goes.
      await flushAll();
      if (state.creating) await state.creating;
      if (state.closed) return;
      if (state.draft) {
        const r = await http('PATCH', `/api/admin/drafts/${state.draft.id}`, { parish_id: next.id });
        state.moving = false;
        if (!r.ok) {
          sel.value = state.parish.id;
          sync();
          return showError((r.body && r.body.error) || 'The draft could not be moved — check the connection.');
        }
        setParish(next);
        setDraft(r.body);
        for (const row of r.body.cards || []) {
          const card = state.cards.find(c => c.id === row.id);
          if (card) cardFromServer(card, row, { keepLocal: true });
        }
        state.cards.forEach(refreshCard);
      } else {
        state.moving = false;
        setParish(next);
      }
      showMessage(`Moved to ${next.name}. Nothing is published until you say so.`, 'note');
      sync();
    }

    $('parish').addEventListener('change', (e) => moveTo(e.target.value));

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
      // Not while the poster is read (the Worker squares the read with the
      // parish it started at), published, or already on its way somewhere.
      const still = reading || state.publishing || state.moving;
      $('parish').disabled = still;
      const mv = el.querySelector('[data-ee="move-suggested"]');
      if (mv) mv.disabled = still;
      // A sign's draft ends with Done where Publish would be: what it adds is
      // added as it goes, and its one card is empty.
      const only = signOnly();
      el.classList.toggle('ee-sign-only', only);
      $('add-card').textContent = only ? '+ Add an event from it as well' : '+ Add another event';
      $('done').hidden = !only;
      $('done').disabled = reading || state.signBusy;
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
          // A service written onto an occurrence the timetable no longer runs
          // answers with no event to show.
          if (r.body.event) events.push(r.body.event);
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
      if (state.svcTimer) { clearTimeout(state.svcTimer); saveServices(); }
      abortRead();
      state.closed = true;
      document.removeEventListener('paste', onPaste);
      if (state.objectUrl) setTimeout(() => URL.revokeObjectURL(state.objectUrl), 60000);
    }

    // ── start ──

    /** A blank card at the chosen parish. */
    function begin() {
      newCard();
      loadRules();
      refreshStrip();
      requestAnimationFrame(() => { const t = state.cards[0] && state.cards[0].els.inputs.title; if (t) t.focus(); });
      sync();
    }

    renderPicker();
    if (opts.draftId) loadDraft(opts.draftId);
    else if (state.parish) begin();
    else requestAnimationFrame(() => $('parish').focus());
    sync();

    return {
      close,
      dropFile,
      get draftId() { return state.draft && state.draft.id; },
      get parishId() { return state.parish && state.parish.id; },
    };
  }

  const api = { open, summaryLine, serviceLine, draftTitle, timeRange, dateLabel, orderParishRows, kmLabel, askNeeded,
    textToLangs, langsToText, takesRead, editableParishes, parishSuggestion };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else if (root) root.AgoraEventEditor = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
