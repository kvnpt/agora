// One weekly service's form: what it is, which days, when, how often, in what
// language, where, between which dates, its poster. ONE form for adding a rule and for
// editing one, so a service is written whole the first time (docs/editing.md).
//
// HOW OFTEN is one control with three answers, because week_of_month and
// week_parity cannot both be set: as two pickers, "1st and 3rd Saturday" AND
// "fortnightly" would look askable, and the Worker refuses the pair. The
// fortnight is offered as its next DATES, never "week A": the only thing a
// person cannot work out for themselves is which of the two weeks is theirs.
//
// DAYS are ticked, not picked: a rule is one weekday, but Compline every night
// is one service to the person typing it, and seven forms was the price of
// that (Kevin, 26 Oct 2026). Each ticked day becomes a rule of its own, and
// the timetable reads them back as one line (timetable-lines.js).
//
// Times are time-field.js's quarter-hours, the kind kind-picker.js's chips and
// where venue-picker.js's three answers, each dressing a field in this form.
// A date is a field-shaped button over the browser's own calendar.
//
// The app's copy (app.js ruleFieldsHTML, cadencePickerHTML, ruleDatesHTML)
// goes when v3 replaces it; /next (public/next/editing.js) uses this one.
// Classic script and CommonJS, like its neighbours: the reading of a form into
// a request is pure, and tested (d1/rule-form.test.mjs).
(function (root) {
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const WEEKS_OF_MONTH = ['first', 'second', 'third', 'fourth', 'last'];
  const WEEKDAYS = [1, 2, 3, 4, 5];
  const VENUE_FIELDS = ['location_override', 'location_parish_id', 'location_lat', 'location_lng'];
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // ── pure ──────────────────────────────────────────────────────────────

  const dayAfter = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
  const weekday = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();
  const shortDate = (iso) => { const d = new Date(iso + 'T00:00:00Z'); return `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`; };

  /**
   * The next `n` dates, from `today`, of a rule on weekday `dow` in fortnight
   * `parity`, by the projection's own week count (`weekAbOf`, the bundle's).
   */
  function fortnightDates(dow, parity, today, weekAbOf, n = 3) {
    if (!weekAbOf || !today) return [];
    const out = [];
    for (let i = 0; i < 400 && out.length < n; i++) {
      const iso = dayAfter(today, i);
      if (weekday(iso) === dow && weekAbOf(iso) === parity) out.push(iso);
    }
    return out;
  }
  /** Which fortnight comes round first, so it is offered first. */
  function parityOrder(dow, today, weekAbOf) {
    const a = fortnightDates(dow, 'a', today, weekAbOf, 1)[0] || '';
    const b = fortnightDates(dow, 'b', today, weekAbOf, 1)[0] || '';
    return b && (!a || b < a) ? ['b', 'a'] : ['a', 'b'];
  }
  /**
   * A first date the way a person says it: "This Sunday, 27 Sep" against
   * "Next Sunday, 4 Oct". The date stays, because "next Sunday" means the
   * coming one to half of Australia and the one after to the other half.
   */
  function naturalFirstDate(iso, today) {
    const days = Math.round((Date.parse(iso + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
    const day = DAYS[weekday(iso)];
    if (days === 0) return `Today, ${shortDate(iso)}`;
    if (days === 1) return `Tomorrow, ${shortDate(iso)}`;
    if (days < 7) return `This ${day}, ${shortDate(iso)}`;
    if (days < 14) return `Next ${day}, ${shortDate(iso)}`;
    return `${day} ${shortDate(iso)}`;
  }
  /** "This Sunday, 27 Sep · then 11 Oct, 25 Oct": where a fortnight lands. */
  function fortnightPreview(dow, parity, today, weekAbOf) {
    const dates = fortnightDates(dow, parity, today, weekAbOf);
    if (!dates.length) return '';
    const rest = dates.slice(1).map(shortDate);
    return naturalFirstDate(dates[0], today) + (rest.length ? ` · then ${rest.join(', ')}` : '');
  }

  /**
   * How often, in the two columns: both, every time. Sending only the one
   * that changed is how a rule ends up holding a qualifier somebody thought
   * they had swapped away from. No week ticked is every week, and is null,
   * not '' (which the route refuses).
   */
  // The kinds that are services, the only ones held in a language (timetable.js isService).
  const SERVICE_TYPES = ['liturgy', 'prayer', 'feast', 'vespers', 'matins'];

  function cadence(mode, weeks = [], parity = 'a') {
    if (mode === 'wom') return { week_of_month: weeks.length ? weeks.join(',') : null, week_parity: null };
    if (mode === 'fortnight') return { week_of_month: null, week_parity: parity === 'b' ? 'b' : 'a' };
    return { week_of_month: null, week_parity: null };
  }

  /** The days a form's values name, Sunday first, each once. */
  function daysOf(v) {
    const raw = Array.isArray(v.days) ? v.days : (v.day_of_week == null || v.day_of_week === '' ? [] : [v.day_of_week]);
    return [...new Set(raw.map(d => parseInt(d, 10)).filter(d => d >= 0 && d <= 6))].sort((a, b) => a - b);
  }

  /**
   * A form's values as the schedule routes take them; every empty is null.
   * `days` is every day ticked, `day_of_week` the first of them, for a route
   * that writes one rule.
   */
  function requestBody(v) {
    const days = daysOf(v);
    // Only a service is held in a language; anything else carries none.
    const langs = SERVICE_TYPES.includes(v.event_type || 'liturgy')
      ? String(v.languages || '').split(',').map(s => s.trim()).filter(Boolean) : [];
    const text = (x) => String(x == null ? '' : x).trim() || null;
    const num = (x) => (x === '' || x == null || !Number.isFinite(Number(x)) ? null : Number(x));
    return {
      title: text(v.title),
      feast: text(v.feast),
      day_of_week: days.length ? days[0] : null,
      days,
      start_time: v.start_time || null,
      end_time: v.end_time || null,
      event_type: v.event_type || 'liturgy',
      languages: langs.length ? JSON.stringify(langs) : null,
      description: text(v.description),
      hide_live: v.hide_live ? 1 : 0,
      parish_scoped: v.parish_scoped ? 1 : 0,
      effective_from: v.effective_from || null,
      effective_to: v.effective_to || null,
      location_override: text(v.location_override),
      location_parish_id: v.location_parish_id || null,
      location_lat: num(v.location_lat),
      location_lng: num(v.location_lng),
      ...cadence(v.cadence, v.weeks || [], v.parity),
    };
  }

  /**
   * What stops a save, in words, or null. An end before the start is a typo
   * far more often than a service past midnight, so it is a question
   * (`late`), not a refusal.
   */
  function problem(body) {
    if (!body.title) return { error: 'Give the service a name.' };
    if (body.days && !body.days.length) return { error: 'Tick the days it runs.' };
    if (!body.start_time) return { error: 'When does it start?' };
    if (body.effective_from && body.effective_to && body.effective_to < body.effective_from) {
      return { error: 'Its last date is before its first.' };
    }
    if (body.end_time && body.end_time <= body.start_time) return { late: true };
    return null;
  }

  const api = { DAYS, WEEKS_OF_MONTH, WEEKDAYS, daysOf, fortnightDates, parityOrder, naturalFirstDate, fortnightPreview, cadence, requestBody, problem };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.AgoraRuleForm = api;
  if (typeof document === 'undefined') return;

  // ── the form ──────────────────────────────────────────────────────────

  const ATTR = 'data-rf';
  const field = (name) => `${ATTR}="${name}"`;
  const PICTURE = '<svg viewBox="0 0 256 256" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M216 40H40a16 16 0 0 0-16 16v144a16 16 0 0 0 16 16h176a16 16 0 0 0 16-16V56a16 16 0 0 0-16-16m0 16v102.75l-26.07-26.06a16 16 0 0 0-22.63 0l-20 20-44-44a16 16 0 0 0-22.62 0L40 149.37V56ZM40 172l52-52 80 80H40Zm176 28h-21.37l-36-36 20-20L216 181.37zm-72-100a12 12 0 1 1 12 12 12 12 0 0 1-12-12"/></svg>';

  /** "Sun 20 Dec", or "20 Dec 2027" when it is not this year: it fits half a dialog. */
  function dateLabel(iso) {
    const d = new Date(iso + 'T00:00:00Z');
    return d.getUTCFullYear() === new Date().getFullYear()
      ? `${DAYS[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`
      : `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  }
  /**
   * A date: the value, hidden, under `attr`; a button saying it; the
   * browser's calendar under it. `required` has no clear. An event's form
   * uses it too (public/next/editing.js).
   */
  function dateFieldHTML(name, value, empty, { attr = ATTR, required = false } = {}) {
    return `<div class="df" data-date-field>
        <input type="hidden" ${attr}="${name}" value="${esc(value || '')}">
        <button type="button" class="df-btn" data-df-open data-df-empty="${esc(empty)}">${value ? esc(dateLabel(value)) : `<span class="df-empty">${esc(empty)}</span>`}</button>
        ${required ? '' : `<button type="button" class="df-clear" data-df-clear aria-label="Clear the date"${value ? '' : ' hidden'}>&times;</button>`}
        <input type="date" class="df-native" tabindex="-1" aria-hidden="true">
      </div>`;
  }
  /** Make every date field under `scope` live; `today` is where an empty one opens. */
  function wireDates(scope, today) {
    scope.querySelectorAll('[data-date-field]').forEach(df => {
      if (df._dfLive) return;
      df._dfLive = true;
      const hidden = df.querySelector('input[type=hidden]');
      const btn = df.querySelector('[data-df-open]');
      const clear = df.querySelector('[data-df-clear]');
      const native = df.querySelector('.df-native');
      // On a phone the native field lies over the button and takes the tap
      // itself (next.css), so it holds where the calendar opens all along.
      native.value = hidden.value || today || '';
      const set = (iso) => {
        hidden.value = iso || '';
        native.value = iso || today || '';
        btn.innerHTML = iso ? esc(dateLabel(iso)) : `<span class="df-empty">${esc(btn.dataset.dfEmpty || '')}</span>`;
        if (clear) clear.hidden = !iso;
        hidden.dispatchEvent(new Event('change', { bubbles: true }));
      };
      btn.addEventListener('click', () => {
        native.value = hidden.value || today || '';
        try { native.showPicker(); } catch { native.focus(); }
      });
      native.addEventListener('change', () => { if (native.value) set(native.value); });
      if (clear) clear.addEventListener('click', () => set(''));
    });
  }

  /** Seven days to tick, and the two sets people ask for by name. */
  function daysHTML(days) {
    return `<div class="rf-days" data-rf-days role="group" aria-label="Days">
        ${DAYS.map((d, i) => `<label class="rf-day"><input type="checkbox" value="${i}"${days.includes(i) ? ' checked' : ''}><span>${d.slice(0, 3)}</span></label>`).join('')}
      </div>
      <div class="rf-days-quick">
        <button type="button" class="rf-link" data-rf-days-set="all">Every day</button>
        <button type="button" class="rf-link" data-rf-days-set="weekdays">Mon–Fri</button>
      </div>`;
  }

  function cadenceHTML(rule, ctx) {
    const uid = `cad${Math.random().toString(36).slice(2, 8)}`;
    const wom = rule.week_of_month ? String(rule.week_of_month).split(',').map(w => w.trim()) : [];
    const parity = rule.week_parity ? String(rule.week_parity).toLowerCase() : null;
    const mode = parity ? 'fortnight' : (wom.length ? 'wom' : 'weekly');
    const dow = daysOf(rule)[0] || 0;
    const radio = (value, label) =>
      `<label class="cad-mode"><input type="radio" name="${uid}" data-cad-mode value="${value}"${mode === value ? ' checked' : ''}> ${label}</label>`;
    const week = (value) =>
      `<label class="cad-week"><input type="radio" name="${uid}p" value="${value}"${(parity || 'a') === value ? ' checked' : ''}><span class="cad-week-dates" data-cad-dates="${value}">${
        esc(fortnightPreview(dow, value, ctx.today, ctx.weekAbOf)) || '…'}</span></label>`;
    return `<div class="cadence" data-cadence>
        <div class="cad-modes">${radio('weekly', 'every week')}${radio('wom', 'some weeks of the month')}${radio('fortnight', 'fortnightly')}</div>
        <div class="cad-body" data-cad-body="wom"${mode === 'wom' ? '' : ' hidden'}>
          ${WEEKS_OF_MONTH.map(w => `<label class="wom-check"><input type="checkbox" value="${w}"${wom.includes(w) ? ' checked' : ''}> ${w}</label>`).join('')}
        </div>
        <div class="cad-body cad-fortnight" data-cad-body="fortnight"${mode === 'fortnight' ? '' : ' hidden'}>
          <span class="wom-label">starting</span>
          ${parityOrder(dow, ctx.today, ctx.weekAbOf).map(week).join('')}
        </div>
      </div>`;
  }

  function posterHTML(rule) {
    const has = !!rule.poster_path;
    return `<div class="rf-poster" data-rf-poster>
        <img class="rf-poster-thumb" alt="The poster"${has ? ` src="${esc(rule.poster_path)}"` : ' hidden'} data-rf-poster-view>
        <div class="rf-poster-actions">
          <button class="rf-btn" type="button" data-rf-poster-pick>${PICTURE}<span>${has ? 'Replace' : 'Add an image'}</span></button>
          <button class="rf-btn danger" type="button" data-rf-poster-clear${has ? '' : ' hidden'}>Remove</button>
        </div>
        <input type="file" accept="image/*" hidden data-rf-poster-input>
      </div>
      <div class="edit-row-hint" data-rf-poster-status>On every date that has no poster of its own.</div>`;
  }

  /**
   * Every field of a rule, in the order a person thinks of a service.
   * `ctx`: today (the parish's 'YYYY-MM-DD') and weekAbOf, for the fortnight;
   * jurisdiction, for the languages shown first.
   */
  function fieldsHTML(rule = {}, ctx = {}) {
    const langs = (() => { try { return JSON.parse(rule.languages || '[]'); } catch { return []; } })();
    const days = daysOf(rule);
    const kind = rule.event_type || 'liturgy';
    const T = root.AgoraEventTypes;
    const kinds = (T ? T.EVENT_TYPES : ['liturgy', 'prayer', 'feast', 'talk', 'youth', 'social', 'other'])
      .map(k => `<option value="${k}"${kind === k ? ' selected' : ''}>${esc(T ? T.eventTypeLabel(k) : k)}</option>`).join('');
    const time = (name, value, extra) =>
      `<input type="hidden" ${field(name)} value="${esc(value || '')}" data-time-field data-tf-name="${name}"${extra}>`;
    return `
      <div class="edit-row"><label>Title</label><input ${field('title')} value="${esc(rule.title || '')}" placeholder="Divine Liturgy" autocomplete="off"></div>
      <div class="edit-row"><label>Subtitle</label><input ${field('feast')} value="${esc(rule.feast || '')}" placeholder="Shown under the title on every date (optional)" autocomplete="off"></div>
      <div class="edit-row"><label>Kind</label><select ${field('event_type')} data-kind-picker="buttons">${kinds}</select></div>
      <div class="edit-row"><label>Days</label>${daysHTML(days)}</div>
      <div class="edit-row edit-pair">
        <div><label>Starts</label>${time('start_time', rule.start_time || (rule.id ? '' : '09:00'), ' data-tf-label="Starts"')}</div>
        <div><label>Ends</label>${time('end_time', rule.end_time, ' data-tf-label="Ends" data-tf-optional data-tf-none="No end time" data-tf-near="start_time"')}</div>
      </div>
      <div class="edit-row"><label>Runs</label>${cadenceHTML(rule, ctx)}</div>
      <div class="edit-row" data-rf-langrow${SERVICE_TYPES.includes(kind) ? '' : ' hidden'}><label>Languages</label><input ${field('languages')} value="${esc(langs.join(', '))}" data-lang-picker data-lp-jurisdiction="${esc(ctx.jurisdiction || '')}" autocomplete="off"></div>
      <div class="edit-row"><label>Description</label><textarea ${field('description')} rows="2" placeholder="Shown on every date (optional)">${esc(rule.description || '')}</textarea></div>
      <div class="edit-row"><label>Where</label>
        <div class="vp-mount" data-venue-mount></div>
        ${VENUE_FIELDS.map(f => `<input type="hidden" ${field(f)} value="${esc(rule[f] == null ? '' : rule[f])}">`).join('')}
      </div>
      <div class="edit-row edit-pair">
        <div><label>First date</label>${dateFieldHTML('effective_from', rule.effective_from, 'From now')}</div>
        <div><label>Last date</label>${dateFieldHTML('effective_to', rule.effective_to, 'No end')}</div>
      </div>
      <div class="edit-row-hint rf-dates-hint">After its last date a service leaves the timetable. For a pause, use Break on one of its dates.</div>
      <div class="edit-row"><label>Poster</label>${posterHTML(rule)}</div>
      <div class="edit-row edit-checks">
        <label class="edit-check"><input type="checkbox" ${field('hide_live')}${rule.hide_live ? ' checked' : ''}> No live badge</label>
        <label class="edit-check"><input type="checkbox" ${field('parish_scoped')}${rule.parish_scoped ? ' checked' : ''}> Parish only</label>
      </div>`;
  }

  /**
   * Make a form built from fieldsHTML live. Returns { values, body, poster }:
   * the fields as they stand, the request they make, and the poster picked
   * on a form whose rule does not exist yet (it goes on once it does).
   *
   *   rule        the rule being edited, or {} for a new one
   *   ctx         { today, weekAbOf }, as fieldsHTML had it
   *   host        the parish running it, and `parishes`, for the venue picker
   *   geocode     async (address) => {lat, lng} | null
   *   pickPin     the host's map for a pin, if it has one
   *   posterNow   async (file | null) => {poster_path} | {error}: an existing
   *               rule's poster goes on (or off) as it is picked, outside Save
   *   openPoster  (url) => void
   */
  function wire(form, o = {}) {
    const ctx = o.ctx || {};
    const q = (name) => form.querySelector(`[${ATTR}="${name}"]`);

    // Days: ticked, or set all at once.
    const dayBox = form.querySelector('[data-rf-days]');
    const ticked = () => [...dayBox.querySelectorAll('input:checked')].map(c => parseInt(c.value, 10));
    form.querySelectorAll('[data-rf-days-set]').forEach(b => b.addEventListener('click', () => {
      const want = b.dataset.rfDaysSet === 'all' ? [0, 1, 2, 3, 4, 5, 6] : WEEKDAYS;
      dayBox.querySelectorAll('input').forEach(c => { c.checked = want.includes(parseInt(c.value, 10)); });
      dayBox.dispatchEvent(new Event('change', { bubbles: true }));
    }));

    // How often: the body its mode names, and the fortnight's dates kept
    // honest when the weekday changes under it (the first ticked: a
    // fortnight's weeks are the same weeks for every day of it).
    const cad = form.querySelector('[data-cadence]');
    const paint = () => {
      const mode = (cad.querySelector('input[data-cad-mode]:checked') || {}).value || 'weekly';
      cad.querySelectorAll('[data-cad-body]').forEach(b => { b.hidden = b.dataset.cadBody !== mode; });
    };
    const repaintDates = () => {
      const dow = ticked()[0] || 0;
      cad.querySelectorAll('[data-cad-dates]').forEach(span => {
        span.textContent = fortnightPreview(dow, span.dataset.cadDates, ctx.today, ctx.weekAbOf) || '…';
      });
      const body = cad.querySelector('[data-cad-body="fortnight"]');
      for (const p of parityOrder(dow, ctx.today, ctx.weekAbOf)) {
        const label = body.querySelector(`[data-cad-dates="${p}"]`).closest('label');
        body.appendChild(label);
      }
    };
    cad.addEventListener('change', () => { paint(); repaintDates(); });
    const kindSel = q('event_type'), langRow = form.querySelector('[data-rf-langrow]');
    if (kindSel && langRow) kindSel.addEventListener('change', () => { langRow.hidden = !SERVICE_TYPES.includes(kindSel.value); });
    dayBox.addEventListener('change', repaintDates);

    // An Other is the parish's own business (a working bee) until somebody
    // says otherwise: picking it ticks Parish only. Only on the change TO
    // Other; unticking it after is the person's, and sticks.
    q('event_type').addEventListener('change', () => { if (q('event_type').value === 'other') q('parish_scoped').checked = true; });

    // Dates: the button opens the browser's calendar; × clears.
    wireDates(form, ctx.today);

    // Where.
    const mount = form.querySelector('[data-venue-mount]');
    if (mount && root.AgoraVenuePicker) {
      const value = {};
      for (const f of VENUE_FIELDS) { const v = (o.rule || {})[f]; value[f] = v != null && v !== '' ? v : null; }
      root.AgoraVenuePicker.mount(mount, {
        value,
        host: o.host || {},
        parishes: o.parishes || [],
        geocode: o.geocode,
        pickPin: o.pickPin,
        onChange: (v) => { for (const f of VENUE_FIELDS) q(f).value = v[f] == null ? '' : v[f]; },
      });
    }

    // The poster: an existing rule's goes on as it is picked; a new rule's
    // waits for the rule, which has no address to upload to until Add.
    let waiting = null;
    const box = form.querySelector('[data-rf-poster]');
    const thumb = box.querySelector('[data-rf-poster-view]');
    const pickBtn = box.querySelector('[data-rf-poster-pick]');
    const clearBtn = box.querySelector('[data-rf-poster-clear]');
    const input = box.querySelector('[data-rf-poster-input]');
    const status = form.querySelector('[data-rf-poster-status]');
    const say = (msg, bad = false) => { status.textContent = msg; status.classList.toggle('edit-row-hint-bad', bad); };
    const show = (src) => {
      if (thumb._url) { URL.revokeObjectURL(thumb._url); thumb._url = null; }
      if (src) thumb.src = src; else thumb.removeAttribute('src');
      thumb.hidden = !src;
      clearBtn.hidden = !src;
      pickBtn.querySelector('span').textContent = src ? 'Replace' : 'Add an image';
    };
    pickBtn.addEventListener('click', () => { input.value = ''; input.click(); });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) return say('That poster is over 8 MB, the most the Worker takes.', true);
      if (!o.posterNow) {
        waiting = file;
        show(URL.createObjectURL(file));
        thumb._url = thumb.src;
        return say('It goes on with the service.');
      }
      say('Uploading…');
      const r = await o.posterNow(file);
      if (r.error) return say(r.error, true);
      show(r.poster_path);
      say('Saved. It shows on every date.');
    });
    clearBtn.addEventListener('click', async () => {
      if (!o.posterNow) { waiting = null; show(null); return say('On every date that has no poster of its own.'); }
      const r = await o.posterNow(null);
      if (r.error) return say(r.error, true);
      show(null);
      say('Removed. Dates with a poster of their own keep theirs.');
    });
    thumb.addEventListener('click', () => { if (thumb.src && o.openPoster) o.openPoster(thumb.src); });

    function values() {
      const mode = (cad.querySelector('input[data-cad-mode]:checked') || {}).value || 'weekly';
      const v = { cadence: mode,
        weeks: [...cad.querySelectorAll('[data-cad-body="wom"] input:checked')].map(c => c.value),
        parity: (cad.querySelector('[data-cad-body="fortnight"] input:checked') || {}).value || 'a',
        days: ticked() };
      form.querySelectorAll(`[${ATTR}]`).forEach(el => {
        const k = el.getAttribute(ATTR);
        v[k] = el.type === 'checkbox' ? el.checked : el.value;
      });
      return v;
    }
    return {
      values,
      body: () => requestBody(values()),
      // A box holding something that is not a time is red, and the save waits.
      timesRead: () => !root.AgoraTimeField || !root.AgoraTimeField.commitAll || root.AgoraTimeField.commitAll(form),
      poster: () => waiting,
    };
  }

  Object.assign(api, { fieldsHTML, wire, dateFieldHTML, wireDates });
})(typeof window !== 'undefined' ? window : globalThis);
