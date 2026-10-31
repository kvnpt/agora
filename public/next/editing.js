// Editing in v3: the signed-in half of the app, moved over from the app
// v3 replaced (app.js, in the history) a piece at a time.
//
// Signed in is not editing (docs/editing.md). A card reads as a visitor's,
// and a form is built when its control is pressed, in one dialog over the
// page, never hidden in the card. Every control asks `may(capability,
// parish)` first, and every route asks again: a control this hides is one the
// route refuses, never the other way round.
//
// The forms are the app's, through the shared pieces where it has them
// (public/shared/event-editor.js and the field helpers it loads). After a
// write the page re-reads the bundle fresh, as the app does, rather than
// patching what it holds.
//
// next.js hands this its page through init(host):
//   parish(id)   the parish row
//   avatar(p, size)  a parish's round logo, as the card draws it
//   parishes()   every parish
//   may(cap, id) the signed-in account's answer
//   rule(id)     a rule
//   event(id)    an event, or a date of a service, as the page reads it
//   today()      'YYYY-MM-DD'
//   reload()     re-read the bundle fresh and repaint what is open
//   retarget(from, to)  an open event card is now this id (a date moved onto a new rule)
//   openParish(id), toast(text), recheck() (the account's counts)
(function (root) {
  let host = null;
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** The server's own words, when it has any. */
  async function errorText(res) {
    try {
      const body = await res.json();
      if (body && body.error) return body.error;
    } catch { /* not json */ }
    return `Could not save (${res.status})`;
  }

  /**
   * One question with two or more answers, each a button that says what it
   * does; Back, Escape or a tap outside answers null. The app's askChoice.
   */
  function askChoice({ title, body = '', choices, back: backLabel = 'Back' }) {
    return new Promise((resolve) => {
      const back = document.createElement('div');
      back.className = 'escalate-backdrop open choice-backdrop';
      back.innerHTML = `
        <div class="escalate-modal choice-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
          <h2>${esc(title)}</h2>
          ${body ? `<div class="choice-body">${body}</div>` : ''}
          <div class="choice-list">
            ${choices.map((c, i) => `
              <button type="button" class="choice-opt${c.danger ? ' danger' : ''}" data-i="${i}">
                <span class="choice-label">${esc(c.label)}</span>
                ${c.hint ? `<span class="choice-hint">${esc(c.hint)}</span>` : ''}
              </button>`).join('')}
          </div>
          <div class="form-actions"><button type="button" class="btn-outline" data-back>${esc(backLabel)}</button></div>
        </div>`;
      const done = (v) => {
        document.removeEventListener('keydown', onKey, true);
        back.remove();
        resolve(v);
      };
      const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } };
      back.addEventListener('click', (e) => {
        if (e.target === back || e.target.closest('[data-back]')) return done(null);
        const opt = e.target.closest('.choice-opt');
        if (opt) done(choices[Number(opt.dataset.i)].value);
      });
      document.addEventListener('keydown', onKey, true);
      document.body.appendChild(back);
      const first = back.querySelector('.choice-opt');
      if (first) first.focus({ preventScroll: true });
    });
  }

  /**
   * The first hand edit at a parish that is read from somewhere asks, once,
   * whether to keep it by hand from now on (docs/sources-and-ingestion.md):
   * otherwise the next import quietly undoes the correction. "Keep reading"
   * is remembered in this browser. True to go ahead, false if they backed out.
   */
  async function keepByHand(parishId) {
    const RF = root.AgoraReadFrom;
    const parish = host.parish(parishId);
    if (!RF || !parish) return true;
    const rf = RF.readFrom(parish);
    if (rf === 'hand') return true;
    try { if (localStorage.getItem(`agora-keep-reading:${parishId}`)) return true; } catch { /* ask */ }
    const pick = await askChoice({
      title: `${parish.name} is ${RF.LABELS[rf].charAt(0).toLowerCase()}${RF.LABELS[rf].slice(1)}`,
      body: `<p>${esc(RF.HINTS[rf])}</p>`,
      choices: [
        { value: 'hand', label: 'Keep it by hand from now on',
          hint: 'Stop reading it. Your change, and every change after it, stays.' },
        { value: 'read', label: 'Keep reading it',
          hint: 'The next import may overwrite this change. You will not be asked again in this browser.' },
      ],
    });
    if (!pick) return false;
    if (pick === 'read') {
      try { localStorage.setItem(`agora-keep-reading:${parishId}`, '1'); } catch { /* fine */ }
      return true;
    }
    const res = await fetch(`/api/admin/parishes/${encodeURIComponent(parishId)}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ read_from: 'hand' }),
    });
    if (!res.ok) { host.toast(await errorText(res)); return false; }
    parish.read_from = 'hand';
    return true;
  }

  /**
   * A phone or a tablet: a field focused on opening brings the keyboard up
   * over the form before anybody asked to type, so a form there opens with
   * nothing focused.
   */
  const touchFirst = () => !!(root.matchMedia && root.matchMedia('(pointer: coarse)').matches);

  /**
   * A form, as a card that slides up over the page (public/shared/form-sheet.js).
   * Its bar is Cancel, the title, and the form's own Save or Publish, which
   * the bar carries for it, so it never sits under the keyboard.
   *
   * Cancel, Escape, a tap beside it or a pull down on its bar turns Cancel
   * into Discard when something was changed (`guard: false` for a form that
   * saves as it goes), or into `leave()`'s ways out. The form's own Save
   * closes it with `close()`, which never asks.
   */
  function frame(opts) {
    return root.AgoraFormSheet.open(opts);
  }

  // ── Add an event ──────────────────────────────────────────────────────
  //
  // The app's add-event editor (public/shared/event-editor.js), the same one
  // /admin mounts: a draft that saves itself until Publish, one card per
  // event, a poster read into it. Gated per parish on `event.edit`.

  let editor = null;
  // What the read says the image is: its heading (app.js _newEventHeading).
  const HEADINGS = { sign: 'Add to the timetable', regular: 'Add to the timetable', both: 'Add from the poster', event: 'Add an event' };

  function addEvent(parishId, { draftId = null, file = null, intent = 'event' } = {}) {
    const parish = host.parish(parishId);
    if (!parish || !root.AgoraEventEditor || !host.may('event.edit', parishId)) return;
    if (editor) editor.close();
    const f = frame({
      title: HEADINGS[intent === 'timetable' ? 'sign' : 'event'],
      cls: 'new-event-backdrop',
      // No foot (Kevin, 23 Oct 2026): Close, which asks Save draft or
      // Discard in its place; a draft with nothing in it just goes.
      label: 'Close',
      leave: () => (!editor || !editor.hasAnything ? null : editor.busy ? false : [
        { label: 'Save draft', run: () => editor.saveDraft() },
        { label: 'Discard', danger: true, run: () => editor.discard() },
      ]),
      // Publish, then Done for a sign, in the bar.
      primary: (body) => body.querySelector('.ee-actions [data-ee="done"]:not([hidden])')
        || body.querySelector('.ee-actions [data-ee="publish"]:not([hidden])'),
      // Closing saves whatever was still waiting to save; the draft is there next time.
      onClose: () => { if (editor) { const e = editor; editor = null; e.close(); } },
    });
    f.el.querySelector('.escalate-modal').classList.add('new-event-modal');
    editor = root.AgoraEventEditor.open(f.body, {
      parish,
      parishes: host.parishes().filter(p => p.id !== '_unassigned'),
      may: host.may,
      draftId,
      intent,
      onRead: (draft) => {
        const services = (draft.read_services || []).length > 0;
        const events = (draft.cards || []).some(c => c.title || c.date);
        f.setTitle(HEADINGS[draft.read_kind === 'timetable' ? 'sign'
          : services && events ? 'both' : services ? 'regular'
            : intent === 'timetable' && !events ? 'sign' : 'event']);
      },
      // A poster at full size: this page has no viewer of its own yet.
      openPoster: (url) => window.open(url, '_blank', 'noopener'),
      // A sign writes to the parish itself, and asks first like any hand edit.
      keepByHand: (pid) => keepByHand(pid),
      pickPin,
      onChanged: () => host.reload(),
      onPublished: async ({ events, proposals }) => {
        editor = null;
        f.close();
        // Published at the parish it was moved to: that parish's card, where it is.
        const at = events && events[0] && events[0].parish_id;
        await host.reload({ through: lastDate(events) });
        if (at && at !== parishId) host.openParish(at);
        host.toast(events && events.length > 1 ? `${events.length} events published` : 'Published');
        // The dot, in case the person who asked can also decide.
        if (proposals && proposals.length) host.recheck();
      },
      onClose: () => { editor = null; f.close(); },
    });
    if (file) editor.dropFile(file);
  }
  /** The last date a list of new events reaches, so the page holds it. */
  function lastDate(events) {
    const ends = (events || []).map(e => String(e.start_utc || '').slice(0, 10)).filter(Boolean).sort();
    return ends.length ? ends[ends.length - 1] : null;
  }

  // ── Service times ─────────────────────────────────────────────────────
  //
  // A rule's form (public/shared/rule-form.js), the same fields to add a
  // service as to edit one, in a dialog. Add is gated on `schedule.create`,
  // the pencil on `schedule.edit` and Delete on `schedule.delete`, each at
  // the rule's parish. Every write at a parish read from somewhere asks
  // first whether to keep it by hand.

  const RF = () => root.AgoraRuleForm;
  const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const clock = (t) => {
    const [h, m] = String(t || '').split(':').map(Number);
    if (!Number.isFinite(h)) return t || '';
    return `${h % 12 || 12}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`;
  };
  /** "5 Oct 2026". */
  const longDate = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  /** "Saturday 6pm · Vespers", a rule as a person names it. */
  const ruleName = (r) => `${DAY_NAMES[r.day_of_week]} ${clock(r.start_time)} · ${r.title}`;

  /** POST /api/admin/geocode, the parish form's own lookup. {lat, lng} or null. */
  async function geocode(address) {
    const res = await fetch('/api/admin/geocode', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }),
    }).catch(() => null);
    if (!res || !res.ok) return null;
    const c = await res.json().catch(() => null);
    return c && Number.isFinite(c.lat) ? { lat: c.lat, lng: c.lng } : null;
  }

  /** Upload (or, with no file, take off) a rule's own poster. */
  async function rulePoster(id, file) {
    const url = `/api/admin/schedules/${encodeURIComponent(id)}/poster`;
    const res = await (file
      ? fetch(url, { method: 'POST', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file })
      : fetch(url, { method: 'DELETE' })).catch(() => null);
    if (!res) return { error: 'The poster did not go through. Check the connection.' };
    if (!res.ok) return { error: await errorText(res) };
    return (await res.json().catch(() => null)) || {};
  }

  /** A rule's form in a frame: the fields, a line for what stops it, its buttons. */
  function ruleDialog({ title, sub, rule, parishId, actions, posterNow }) {
    const f = frame({ title, sub, cls: 'rule-backdrop' });
    const ctx = { today: host.today(), weekAbOf: window.agoraBundle && window.agoraBundle.weekAbOf,
      jurisdiction: (host.parish(parishId) || {}).jurisdiction || '' };
    f.body.innerHTML = `<div class="detail-edit-form rule-form">
        ${RF().fieldsHTML(rule, ctx)}
        <p class="rf-error" role="alert" hidden></p>
        <div class="form-actions">${actions}</div>
      </div>`;
    const form = f.body.firstElementChild;
    const live = RF().wire(form, {
      rule, ctx,
      host: host.parish(parishId) || { id: parishId },
      parishes: host.parishes(),
      geocode,
      pickPin,
      posterNow,
      openPoster: (url) => window.open(url, '_blank', 'noopener'),
    });
    const err = form.querySelector('.rf-error');
    const fail = (msg) => { err.textContent = msg; err.hidden = !msg; if (msg) err.scrollIntoView({ block: 'nearest' }); };
    /** The request, once nothing stops it; null if something does (and it is said). */
    async function ready() {
      fail('');
      if (!live.timesRead()) { fail('One of the times is not a time. Pick one from the list, or type it like 6:30 pm.'); return null; }
      const body = live.body();
      const p = RF().problem(body);
      if (p && p.error) { fail(p.error); return null; }
      if (p && p.late) {
        const go = await askChoice({
          title: 'It ends before it starts',
          choices: [{ value: 'keep', label: 'It runs past midnight' }, { value: 'fix', label: 'Fix the times' }],
        });
        if (go !== 'keep') return null;
      }
      return body;
    }
    return { f, form, live, ready, fail };
  }

  /** "Add +" under a parish's service times: a new rule, or a photo of the sign. */
  function addService(parishId) {
    const parish = host.parish(parishId);
    if (!parish || !RF() || !host.may('schedule.create', parishId)) return;
    const d = ruleDialog({
      title: 'Add a service',
      sub: parish.name,
      rule: {},
      parishId,
      actions: `<button class="btn-save" type="button" data-rf-add>Add service</button>
        <button class="btn-outline" type="button" data-frame-close>Cancel</button>`,
    });
    // The sign first: the add-event editor reads it, and offers its services
    // one by one beside what is on file (event-editor.js, intent 'timetable').
    d.form.insertAdjacentHTML('afterbegin', `
      <button type="button" class="sap-drop" data-sign>
        <span class="sap-title">Add an image</span>
        <span class="sap-sub">A photo of the board out the front, or a printed timetable. Nothing is added until you say so.</span>
      </button>
      <input type="file" accept="image/*" hidden data-sign-input>
      <div class="schedule-add-or">or type it in</div>`);
    const sign = d.form.querySelector('[data-sign-input]');
    const fromSign = (file) => {
      if (!file || !/^image\//.test(file.type || '')) return;
      d.f.close();
      addEvent(parishId, { file, intent: 'timetable' });
    };
    d.form.querySelector('[data-sign]').addEventListener('click', () => { sign.value = ''; sign.click(); });
    sign.addEventListener('change', () => fromSign(sign.files && sign.files[0]));
    const drop = d.form.querySelector('[data-sign]');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-dragging'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-dragging'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-dragging');
      fromSign([...((e.dataTransfer && e.dataTransfer.files) || [])].find(x => /^image\//.test(x.type)));
    });

    const btn = d.form.querySelector('[data-rf-add]');
    btn.addEventListener('click', async () => {
      // One request at a time: a second tap while the first was out made two rules.
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const body = await d.ready();
        if (!body || !(await keepByHand(parishId))) return;
        const res = await fetch('/api/admin/schedules', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ parish_id: parishId, ...body }),
        }).catch(() => null);
        if (!res || !res.ok) return d.fail(res ? await errorText(res) : 'It did not go through. Check the connection.');
        const made = await res.json().catch(() => null);
        // The poster goes on once the rule is there to take it.
        const file = d.live.poster();
        if (file && made && made.id) {
          btn.textContent = 'Adding the poster…';
          const up = await rulePoster(made.id, file);
          // A service on several days is a rule for each, and each shows it.
          for (const r of (made.rules || []).slice(1)) {
            if (up.error) break;
            await fetch(`/api/admin/schedules/${encodeURIComponent(r.id)}`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ poster_path: up.poster_path }),
            }).catch(() => null);
          }
          if (up.error) host.toast(`Added, but not its poster: ${up.error}`);
        }
        d.f.close();
        await host.reload();
        const n = made && made.rules ? made.rules.length : 1;
        host.toast(made && made.duplicate ? 'That service was already there' : n > 1 ? `Service added on ${n} days` : 'Service added');
      } finally { btn.disabled = false; btn.textContent = 'Add service'; }
    });

    endedServices(parishId, d.form);
    const first = d.form.querySelector('[data-rf="title"]');
    if (first && !touchFirst()) first.focus({ preventScroll: true });
  }

  /**
   * A service that has ended, to bring back: ending is the one deliberate
   * exception to "nothing disappears", so Add offers what ended here.
   */
  async function endedServices(parishId, form) {
    const res = await fetch(`/api/admin/schedules?parish=${encodeURIComponent(parishId)}`).catch(() => null);
    const rows = res && res.ok ? await res.json().catch(() => []) : [];
    const today = host.today();
    const ended = rows.filter(r => r.active && r.effective_to && r.effective_to < today);
    if (!ended.length || !form.isConnected) return;
    form.insertAdjacentHTML('beforeend', `
      <details class="rf-ended">
        <summary>Ended services (${ended.length})</summary>
        ${ended.map(r => `<div class="rf-ended-row">
            <span>${esc(ruleName(r))} <em>ended ${esc(longDate(r.effective_to))}</em></span>
            <button type="button" class="rf-btn" data-reopen="${esc(r.id)}">Bring back</button>
          </div>`).join('')}
      </details>`);
    form.querySelector('.rf-ended').addEventListener('click', async (e) => {
      const b = e.target.closest('[data-reopen]');
      if (!b) return;
      const r = ended.find(x => String(x.id) === b.dataset.reopen);
      const go = await askChoice({
        title: `Bring back ${r.title}?`,
        body: '<p>It runs again from its next date. If another service replaced it, bring it back only if both really run.</p>',
        choices: [{ value: 'yes', label: 'Bring it back' }],
      });
      if (go !== 'yes' || !(await keepByHand(parishId))) return;
      const res2 = await fetch(`/api/admin/schedules/${encodeURIComponent(r.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ effective_to: null }),
      });
      if (!res2.ok) return host.toast(await errorText(res2));
      b.closest('.rf-ended-row').remove();
      await host.reload();
      host.toast(`${r.title} is back`);
    });
  }

  /** "Every day 9pm · Compline", rules of one line as a person names them. */
  const linesName = (rules) => {
    if (rules.length === 1) return ruleName(rules[0]);
    const TL = root.AgoraTimetableLines;
    const days = TL ? TL.dayList(rules.map(r => r.day_of_week)) : rules.map(r => DAY_NAMES[r.day_of_week].slice(0, 3)).join(', ');
    return `${days} ${clock(rules[0].start_time)} · ${rules[0].title}`;
  };
  const dayBefore = (iso) => new Date(Date.parse(iso + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);

  /** A rule's pencil: its form, Save, Delete. */
  function editService(id) { editRules([id]); }

  /**
   * One form for the rules of a line: "Every day 9pm Compline" is seven, and
   * is edited as the one service it is (rule-form.js). Save sends each rule
   * only what changed, so a description or a poster one day has of its own
   * stays. A day ticked is a new rule; a day unticked is a rule that stops,
   * ended before today (or deleted, if it never ran) after asking. With one
   * day moved to another, the rule moves, as the old Day picker did.
   */
  function editRules(ids) {
    const rules = ids.map(id => host.rule(id)).filter(Boolean);
    if (!rules.length || !RF()) return;
    const first = rules[0];
    if (!host.may('schedule.edit', first.parish_id)) return;
    const parish = host.parish(first.parish_id);
    const patchEach = async (list, body) => {
      for (const r of list) {
        const res = await fetch(`/api/admin/schedules/${encodeURIComponent(r.id)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }).catch(() => null);
        if (!res || !res.ok) return res ? await errorText(res) : 'It did not go through. Check the connection.';
      }
      return null;
    };
    const d = ruleDialog({
      title: 'Edit service',
      sub: [linesName(rules), parish && parish.name].filter(Boolean).join(' · '),
      rule: { ...first, days: rules.map(r => r.day_of_week) },
      parishId: first.parish_id,
      actions: `<button class="btn-save" type="button" data-rf-save>Save</button>
        <button class="btn-outline" type="button" data-frame-close>Cancel</button>
        ${host.may('schedule.delete', first.parish_id) ? '<button class="btn-danger" type="button" data-rf-delete>Delete</button>' : ''}`,
      // Outside Save, as the app's: it goes on as it is picked, on every day.
      posterNow: async (file) => {
        const r = await rulePoster(first.id, file);
        if (!r.error && rules.length > 1) {
          const err = await patchEach(rules.slice(1), { poster_path: file ? r.poster_path : null });
          if (err) return { error: err };
        }
        if (!r.error) host.reload();
        return r;
      },
    });
    // What the form said when it opened: Save sends only what moved from it.
    const before = d.live.body();
    d.form.querySelector('[data-rf-save]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const body = await d.ready();
        if (!body) return;
        const changes = {};
        for (const k of Object.keys(body)) {
          if (k === 'days' || k === 'day_of_week') continue;
          if (JSON.stringify(body[k]) !== JSON.stringify(before[k])) changes[k] = body[k];
        }
        // How often is both columns, every time (rule-form.js cadence).
        if ('week_of_month' in changes || 'week_parity' in changes) {
          changes.week_of_month = body.week_of_month;
          changes.week_parity = body.week_parity;
        }
        const had = rules.map(r => r.day_of_week);
        const added = body.days.filter(x => !had.includes(x));
        let gone = rules.filter(r => !body.days.includes(r.day_of_week));
        const kept = rules.filter(r => body.days.includes(r.day_of_week));
        // A day swapped for another moves its rule.
        const moved = [];
        while (gone.length && added.length) moved.push({ r: gone.shift(), day: added.shift() });
        if (gone.length) {
          const go = await askChoice({
            title: `Stop it on ${gone.map(r => DAY_NAMES[r.day_of_week]).join(', ')}?`,
            body: `<p>${first.title} will no longer show on ${gone.map(r => DAY_NAMES[r.day_of_week] + 's').join(' or ')}. Past dates stay as they were. Tick ${gone.length === 1 ? 'it' : 'them'} again here to restart.</p>`,
            choices: [{ value: 'stop', label: gone.length === 1 ? 'Stop that day' : 'Stop those days' }],
          });
          if (go !== 'stop') return;
        }
        if (!(await keepByHand(first.parish_id))) return;
        let err = null;
        if (Object.keys(changes).length) err = await patchEach(kept, changes);
        for (const m of moved) if (!err) err = await patchEach([m.r], { ...changes, day_of_week: m.day });
        if (!err && added.length) {
          const res = await fetch('/api/admin/schedules', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parish_id: first.parish_id, ...body, days: added, poster_path: first.poster_path || null }),
          }).catch(() => null);
          if (!res || !res.ok) err = res ? await errorText(res) : 'It did not go through. Check the connection.';
        }
        const today = host.today();
        for (const r of gone) {
          if (err) break;
          if (r.effective_from && r.effective_from >= today) {
            const res = await fetch(`/api/admin/schedules/${encodeURIComponent(r.id)}`, { method: 'DELETE' }).catch(() => null);
            if (!res || !res.ok) err = res ? await errorText(res) : 'It did not go through. Check the connection.';
          } else err = await patchEach([r], { effective_to: dayBefore(today) });
        }
        if (err) { await host.reload(); return d.fail(err); }
        d.f.close();
        await host.reload();
        host.toast('Saved');
      } finally { btn.disabled = false; }
    });
    const del = d.form.querySelector('[data-rf-delete]');
    if (del) del.addEventListener('click', async () => {
      const go = await askChoice({
        title: rules.length > 1 ? `Delete ${first.title} on all ${rules.length} days?` : `Delete ${first.title}?`,
        body: '<p>Every date of it goes from the timetable. A service that has stopped can end instead: give it a last date.</p>',
        choices: [{ value: 'delete', label: 'Delete the service', danger: true }],
      });
      if (go !== 'delete' || !(await keepByHand(first.parish_id))) return;
      for (const r of rules) {
        const res = await fetch(`/api/admin/schedules/${encodeURIComponent(r.id)}`, { method: 'DELETE' }).catch(() => null);
        if (!res || !res.ok) { await host.reload(); return d.fail(res ? await errorText(res) : 'It did not go through. Check the connection.'); }
      }
      d.f.close();
      await host.reload();
      host.toast('Deleted');
    });
  }

  /**
   * A timetable line's pencil. A line can be several rules ("Mon–Fri 6pm
   * Vespers" is five), edited together as the one service, or one day of it
   * on its own.
   */
  async function editLine(ids) {
    const rules = ids.map(id => host.rule(id)).filter(Boolean)
      .sort((a, b) => ((a.day_of_week + 6) % 7) - ((b.day_of_week + 6) % 7));
    if (rules.length === 1) return editService(rules[0].id);
    const pick = await askChoice({
      title: 'Which one?',
      choices: [{ value: 'all', label: `All ${rules.length} days together`, hint: linesName(rules) },
        ...rules.map(r => ({ value: String(r.id), label: ruleName(r) }))],
    });
    if (pick === 'all') editRules(rules.map(r => r.id));
    else if (pick) editService(pick);
  }

  // ── An event, or one date of a service ────────────────────────────────
  //
  // The app's event form (app.js eventEditFormHTML) behind the card's pencil:
  // what the date is (Cancel, Suppress, Delete) above its fields, and the
  // poster, which goes on as it is picked. A date of a repeating service says
  // which service it is, with the way to the service itself, and asks which
  // dates a change is for. Gated on `event.edit` at its parish; "this and
  // every following" changes the rule, and asks `schedule.edit`, as its route
  // does (worker/lib/series.mjs).

  const EV = 'data-ev';
  const tz = () => import('/shared/tz.mjs');
  const PICTURE = '<svg viewBox="0 0 256 256" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="M216 40H40a16 16 0 0 0-16 16v144a16 16 0 0 0 16 16h176a16 16 0 0 0 16-16V56a16 16 0 0 0-16-16m0 16v102.75l-26.07-26.06a16 16 0 0 0-22.63 0l-20 20-44-44a16 16 0 0 0-22.62 0L40 149.37V56ZM40 172l52-52 80 80H40Zm176 28h-21.37l-36-36 20-20L216 181.37zm-72-100a12 12 0 1 1 12 12 12 12 0 0 1-12-12"/></svg>';
  const STATE = { cancelled: 'Cancelled', combined: 'Combined', break: 'On a break', hidden: 'Suppressed' };
  const dayLabel = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'short', timeZone: 'UTC' });

  /** The rule behind a date of a service, and the date; null for a one-off. */
  function seriesOf(id) {
    const m = /^(\d+):(\d{4}-\d{2}-\d{2})$/.exec(String(id));
    const rule = m && host.rule(m[1]);
    if (!rule) return null;
    return { rule, date: m[2], day: DAY_NAMES[rule.day_of_week], dateLabel: dayLabel(m[2]) };
  }

  /** "Repeats every other Sunday at 9am · until 5 Oct 2027". */
  function repeatsText(r) {
    const day = DAY_NAMES[r.day_of_week];
    const weeks = String(r.week_of_month || '').split(',').filter(Boolean);
    const how = r.week_parity ? `every other ${day}`
      : weeks.length ? `the ${weeks.length > 1 ? `${weeks.slice(0, -1).join(', ')} and ${weeks[weeks.length - 1]}` : weeks[0]} ${day} of the month`
        : `every ${day}`;
    const range = [r.effective_from && r.effective_from > host.today() ? `from ${longDate(r.effective_from)}` : '',
      r.effective_to ? `until ${longDate(r.effective_to)}` : ''].filter(Boolean).join(' ');
    return `Repeats ${how} at ${clock(r.start_time)}${range ? ` · ${range}` : ''}`;
  }

  /** The poster: this date's or this event's, a range of them, or the service's own. */
  function posterHTML(e, series, parish) {
    const has = !!e.poster_path;
    // The service's own poster shows here because this date has none; it is
    // the service's to change.
    const ruleOwn = has && !!e.rule_poster;
    // Shared: not the file this one's own upload writes, so taking it off
    // here leaves it on the others (worker/lib/poster-range.mjs).
    const shared = has && !ruleOwn && !String(e.poster_path).startsWith(`/posters/${String(e.id).replace(':', '-')}.`);
    const day = series ? series.date : (e._date || host.today());
    const [y, m] = day.split('-').map(Number);
    const monthEnd = `${day.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
    const name = e.title || 'service like this';
    const DF = RF().dateFieldHTML;
    return `
      <div class="rf-poster">
        <img class="rf-poster-thumb" alt="The poster"${has ? ` src="${esc(e.poster_path)}"` : ' hidden'} data-evp-view>
        <div class="rf-poster-actions">
          <button class="rf-btn" type="button" data-evp-pick>${PICTURE}<span>${has && !ruleOwn ? 'Replace' : 'Add an image'}</span></button>
          ${has && !ruleOwn ? `<button class="rf-btn danger" type="button" data-evp-clear>${shared ? 'Remove from this one' : 'Remove'}</button>` : ''}
          ${shared ? '<button class="rf-btn danger" type="button" data-evp-clear="everywhere">Remove everywhere</button>' : ''}
        </div>
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden data-evp-input>
      </div>
      ${ruleOwn ? `<div class="edit-row-hint">On every ${esc(name)}: the service’s own poster.
        ${series && host.may('schedule.edit', series.rule.parish_id) ? '<button type="button" class="ev-link" data-ev-series>Change it on the service</button>' : ''}</div>` : ''}
      <div class="ev-poster-scope"><span>Put ${ruleOwn ? 'a different one' : 'it'} on</span>
        <select data-evp-scope>
          <option value="">${series ? 'this date only' : 'this event only'}</option>
          ${series ? `<option value="series">every ${esc(name)}, the service’s own</option>
            <option value="rule">every ${esc(name)} from…</option>` : ''}
          <option value="parish">everything at ${esc(parish ? parish.name : 'this parish')} from…</option>
        </select>
      </div>
      <div class="edit-pair ev-poster-range" data-evp-range hidden>
        <div><label>From</label>${DF('from', `${day.slice(0, 7)}-01`, 'From', { attr: 'data-evp-date', required: true })}</div>
        <div><label>Until</label>${DF('until', monthEnd, 'Until', { attr: 'data-evp-date', required: true })}</div>
      </div>
      <div class="edit-row-hint" data-evp-status></div>`;
  }

  /**
   * The poster box, live. It is drawn again from the bundle after each
   * upload, so what it offers (Remove, Remove everywhere) is what is there.
   */
  function wirePoster(box, cur, { onSeries }) {
    const paint = (msg = '', bad = false) => {
      const e = host.event(cur);
      if (!e) return;
      const parish = host.parish(e.parish_id);
      box.innerHTML = posterHTML(e, seriesOf(e.id), parish);
      RF().wireDates(box, host.today());
      const st = box.querySelector('[data-evp-status]');
      st.textContent = msg;
      st.classList.toggle('edit-row-hint-bad', bad);
    };
    const say = (msg, bad = false) => {
      const st = box.querySelector('[data-evp-status]');
      st.textContent = msg;
      st.classList.toggle('edit-row-hint-bad', bad);
    };
    /** What the scope asks for: one, the service's own, or a range as a query. */
    const range = () => {
      const scope = box.querySelector('[data-evp-scope]').value;
      if (!scope) return { query: '' };
      if (scope === 'series') return { series: String(cur).split(':')[0] };
      const from = box.querySelector('[data-evp-date="from"]').value;
      const until = box.querySelector('[data-evp-date="until"]').value;
      if (!from || !until) return { error: 'Pick the first and last day the poster covers.' };
      if (from > until) return { error: 'The last day is before the first.' };
      return { query: `?scope=${scope}&from=${from}&until=${until}` };
    };
    const after = async (msg) => { await host.reload(); paint(msg); };
    box.addEventListener('change', async (ev) => {
      if (ev.target.matches('[data-evp-scope]')) {
        const v = ev.target.value;
        box.querySelector('[data-evp-range]').hidden = !v || v === 'series';
        return;
      }
      if (!ev.target.matches('[data-evp-input]')) return;
      const file = ev.target.files && ev.target.files[0];
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) return say('That poster is over 8 MB, the most the Worker takes.', true);
      const r = range();
      say('Uploading…');
      if (r.series) {
        const up = await rulePoster(r.series, file);
        return up.error ? say(up.error, true) : after('Saved on the service. It shows on every date.');
      }
      const res = await fetch(`/api/admin/events/${encodeURIComponent(cur)}/poster${r.query}`, {
        method: 'POST', headers: { 'Content-Type': file.type || 'image/jpeg' }, body: file,
      }).catch(() => null);
      if (!res || !res.ok) return say(res ? await errorText(res) : 'The poster did not go through. Check the connection.', true);
      const body = await res.json().catch(() => ({}));
      after(body.count > 1 ? `Saved on ${body.count} dates.` : 'Saved.');
    });
    box.addEventListener('click', async (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.matches('[data-ev-series]')) return onSeries();
      if (b.matches('[data-evp-pick]')) {
        // Said before the file picker opens, not after somebody has gone looking for the file.
        const r = range();
        if (r.error) return say(r.error, true);
        const input = box.querySelector('[data-evp-input]');
        input.value = '';
        return input.click();
      }
      if (b.matches('[data-evp-clear]')) {
        const everywhere = b.dataset.evpClear === 'everywhere';
        const go = await askChoice({
          title: everywhere ? 'Take this poster off everything that shows it?' : 'Take the poster off?',
          body: everywhere ? '<p>Every date at this parish that shows this poster loses it.</p>' : '',
          choices: [{ value: 'yes', label: everywhere ? 'Remove it everywhere' : 'Remove it', danger: true }],
        });
        if (go !== 'yes') return;
        say('Removing…');
        const res = await fetch(`/api/admin/events/${encodeURIComponent(cur)}/poster${everywhere ? '?everywhere' : ''}`, { method: 'DELETE' }).catch(() => null);
        if (!res || !res.ok) return say(res ? await errorText(res) : 'That did not go through. Check the connection.', true);
        return after('Removed.');
      }
    });
    box.addEventListener('click', (ev) => {
      const img = ev.target.closest('[data-evp-view]');
      if (img && img.src) window.open(img.src, '_blank', 'noopener');
    });
    paint();
  }

  /** Only a service (a Liturgy, prayers, a feast) is held in a language (timetable.js). */
  const isService = (type) => !!root.AgoraTimetable && root.AgoraTimetable.isService({ event_type: type });

  /** The form's fields, from the event as it is now. */
  function eventFieldsHTML(e, { series, parish, start, end, multi, parishes }) {
    const langs = (() => { try { return JSON.parse(e.languages || '[]'); } catch { return []; } })();
    const T = root.AgoraEventTypes;
    const kinds = (T ? T.EVENT_TYPES : ['liturgy', 'prayer', 'feast', 'talk', 'youth', 'social', 'other'])
      .map(k => `<option value="${k}"${e.event_type === k ? ' selected' : ''}>${esc(T ? T.eventTypeLabel(k) : k)}</option>`).join('');
    const f = (name) => `${EV}="${name}"`;
    const time = (name, value, extra) =>
      `<input type="hidden" ${f(name)} value="${esc(value || '')}" data-time-field data-tf-name="${name}"${extra}>`;
    const live = e.parish_live_url || (parish && parish.live_url);
    const DF = RF().dateFieldHTML;
    return `
      ${series ? `<div class="ev-series">
          <span>${esc(repeatsText(series.rule))}</span>
          ${host.may('schedule.edit', series.rule.parish_id) ? '<button type="button" class="ev-link" data-ev-series>Edit the service</button>' : ''}
        </div>` : ''}
      <div class="edit-row"><label>Title</label><input ${f('title')} value="${esc(e.title || '')}" autocomplete="off"></div>
      <div class="edit-row"><label>Subtitle</label><input ${f('feast')} value="${esc(e.feast || '')}" placeholder="The saint or feast, or the topic (optional)" autocomplete="off"></div>
      <div class="edit-row"><label>Description</label><textarea ${f('description')} rows="2" placeholder="Optional">${esc(e.description || '')}</textarea></div>
      ${RF().kindRowHTML('Kind', `<select ${f('event_type')} data-kind-picker="buttons">${kinds}</select>`, EV, !!e.parish_scoped)}
      ${parishes.length > 1 ? `<div class="edit-row"><label>Parish</label><select ${f('parish_id')}>${parishes.map(p =>
        `<option value="${esc(p.id)}"${p.id === e.parish_id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>` : ''}
      <div class="edit-row" data-ev-langrow${isService(e.event_type) ? '' : ' hidden'}><label>Languages</label><input ${f('languages')} value="${esc(langs.join(', '))}" data-lang-picker data-lp-jurisdiction="${esc((parish && parish.jurisdiction) || '')}" autocomplete="off"><p class="rf-error" data-ev-langerr role="alert" hidden></p></div>
      ${series ? '' : `<div class="edit-row"><label>Date</label>${DF('date', start.date, 'Pick a date', { attr: EV, required: true })}</div>`}
      <div class="edit-row edit-pair">
        <div><label>Starts</label>${time('start_time', start.time, ' data-tf-label="Starts"')}</div>
        <div><label data-ev-endlabel>${multi ? 'Ends, last day' : 'Ends'}</label>${time('end_time', end ? end.time : '', ' data-tf-label="Ends" data-tf-optional data-tf-none="No end time" data-tf-near="start_time"')}</div>
      </div>
      ${series ? '' : `<div class="edit-row"><label class="toggle-row"><span>Over several days</span><input type="checkbox" role="switch" class="toggle" ${f('multi')}${multi ? ' checked' : ''}></label></div>
      <div class="edit-row" data-ev-lastday${multi ? '' : ' hidden'}><label>Last day</label>${DF('last', multi && end ? end.date : '', 'Pick the last day', { attr: EV, required: true })}</div>`}
      <div class="edit-row"><label>Where</label>
        <div class="vp-mount" data-venue-mount></div>
        ${VENUE.map(k => `<input type="hidden" ${f(k)} value="${esc(e[k] == null ? '' : e[k])}">`).join('')}
      </div>
      <div class="edit-row"><label>Poster</label><div data-ev-poster></div></div>
      ${live ? `<div class="edit-row">
        <label class="toggle-row"><span>No live badge</span><input type="checkbox" role="switch" class="toggle" ${f('hide_live')}${e.hide_live ? ' checked' : ''}></label>
      </div>` : ''}`;
  }
  const VENUE = ['location_override', 'location_parish_id', 'location_lat', 'location_lng'];

  /**
   * A following-dates change (worker/lib/series.mjs). Later dates that have
   * their own changes are asked about: carried to the changed service, or let
   * go. The answer, or null if they backed out or it failed (and it is said).
   */
  async function postFollowing(id, body, fail) {
    const send = (extra = {}) => fetch(`/api/admin/events/${encodeURIComponent(id)}/following`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, ...extra }),
    }).catch(() => null);
    let res = await send();
    if (res && res.status === 409) {
      const q = await res.clone().json().catch(() => null);
      if (q && q.needs_choice) {
        const day = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', timeZone: 'UTC' });
        const items = [
          ...q.movable.map(o => `<li>${esc(day(o.date))}: ${esc(o.what)}</li>`),
          ...q.stranded.map(o => `<li>${esc(day(o.date))}: ${esc(o.what)} <em>(no service that day any more, so it cannot move)</em></li>`),
          ...q.breaks.map(b => `<li>A break, ${esc(day(b.from))} to ${esc(day(b.to))}${b.note ? `: ${esc(b.note)}` : ''}</li>`),
        ];
        const keep = await askChoice({
          title: 'Later dates already have their own changes',
          body: `<ul class="choice-items">${items.join('')}</ul>`,
          choices: [
            { value: 'carry', label: 'Keep them', hint: 'They apply to the changed service too.' },
            { value: 'discard', label: 'Let them go', hint: 'The changed service starts clean.', danger: true },
          ],
        });
        if (!keep) return null;
        res = await send({ keep });
      }
    }
    if (!res || !res.ok) { fail(res ? await errorText(res) : 'It did not go through. Check the connection.'); return null; }
    return (await res.json().catch(() => null)) || {};
  }

  /** An event card's pencil. */
  async function editEvent(id) {
    const e = host.event(id);
    if (!e || !host.may('event.edit', e.parish_id)) return;
    const { localPartsOf, localSpanToUtc } = await tz();
    const series = seriesOf(e.id);
    const parish = host.parish(e.parish_id);
    const zoneOf = (pid) => e.timezone || (host.parish(pid) || {}).timezone || 'Australia/Sydney';
    const zone = zoneOf(e.parish_id);
    // The parish's own wall clock, which is what a person types.
    const partsOf = (iso, local) => (local ? { date: local.slice(0, 10), time: local.slice(11, 16) }
      : iso ? localPartsOf(zone, Date.parse(iso)) : null);
    const start = partsOf(e.start_utc, e.start_local);
    const end = partsOf(e.end_utc, e.end_local);
    e._date = start.date;
    const multi = !series && !!end && end.date > start.date && Date.parse(e.end_utc) - Date.parse(e.start_utc) >= 12 * 3600000;
    // A one-off can move to any parish this person may add to; a service's date stays with its service.
    const parishes = series ? [] : host.parishes()
      .filter(p => p.id === e.parish_id || (p.id !== '_unassigned' && host.may('event.edit', p.id)))
      .sort((a, b) => a.name.localeCompare(b.name));
    const state = STATE[e.status] || null;
    const cancelled = e.status === 'cancelled', hidden = e.status === 'hidden';
    const headless = !series && e.mutation_type === 'headless';

    const f = frame({
      title: series ? `Edit ${series.dateLabel}` : 'Edit event',
      sub: [series ? `${e.title} · ${clock(start.time)}` : `${e.title} · ${longDate(start.date)}`, parish && parish.name].filter(Boolean).join(' · '),
      cls: 'event-edit-backdrop',
    });
    f.body.innerHTML = `<div class="detail-edit-form ev-form">
        <div class="ev-tools">
          ${state ? `<span class="ev-state ${esc(e.status)}">${esc(state)}</span>` : ''}
          <button class="rf-btn" type="button" data-ev-status="${cancelled ? 'approved' : 'cancelled'}">${cancelled ? 'Uncancel event' : 'Cancel event'}</button>
          ${series && host.may('override.edit', series.rule.parish_id) ? `<button class="rf-btn" type="button" data-ev-break>${e.status === 'break' ? 'Edit the break' : 'Break…'}</button>` : ''}
          ${series ? `<button class="rf-btn" type="button" data-ev-status="${hidden ? 'approved' : 'hidden'}">${hidden ? 'Unsuppress' : 'Suppress'}</button>` : ''}
          ${series ? '' : '<button class="rf-btn" type="button" data-ev-combine>Include other parishes…</button>'}
          ${headless ? '<button class="rf-btn danger" type="button" data-ev-delete>Delete</button>' : ''}
        </div>
        ${eventFieldsHTML(e, { series, parish, start, end, multi, parishes })}
        <p class="rf-error" role="alert" hidden></p>
        <div class="form-actions">
          <button class="btn-save" type="button" data-ev-save>Save</button>
          <button class="btn-outline" type="button" data-frame-close>Close</button>
        </div>
      </div>`;
    const form = f.body.firstElementChild;
    const q = (name) => form.querySelector(`[${EV}="${name}"]`);
    const err = form.querySelector('.rf-error');
    const fail = (msg) => { err.textContent = msg; err.hidden = !msg; if (msg) err.scrollIntoView({ block: 'nearest' }); };
    const toService = () => { f.close(); editService(series.rule.id); };
    form.querySelectorAll('.ev-series [data-ev-series]').forEach(b => b.addEventListener('click', toService));

    RF().wireDates(form, host.today());
    const multiBox = q('multi');
    if (multiBox) multiBox.addEventListener('change', () => {
      form.querySelector('[data-ev-lastday]').hidden = !multiBox.checked;
      form.querySelector('[data-ev-endlabel]').textContent = multiBox.checked ? 'Ends, last day' : 'Ends';
    });
    RF().wireScope(form, q('parish_scoped'));
    q('event_type').addEventListener('change', () => {
      if (q('event_type').value === 'other') RF().scopeTo(q('parish_scoped'), true);
      // Only a service is held in a language.
      form.querySelector('[data-ev-langrow]').hidden = !isService(q('event_type').value);
    });
    const mount = form.querySelector('[data-venue-mount]');
    if (mount && root.AgoraVenuePicker) {
      const value = {};
      for (const k of VENUE) value[k] = e[k] != null && e[k] !== '' ? e[k] : null;
      root.AgoraVenuePicker.mount(mount, {
        value, host: parish || { id: e.parish_id }, parishes: host.parishes(), geocode, pickPin,
        onChange: (v) => { for (const k of VENUE) q(k).value = v[k] == null ? '' : v[k]; },
      });
    }
    wirePoster(form.querySelector('[data-ev-poster]'), e.id, { onSeries: toService });

    /** After a write: the page again from the bundle, and this card where it now is. */
    const done = async (msg, { to = e.id, through = null } = {}) => {
      if (to !== e.id) host.retarget(e.id, to);
      f.close();
      await host.reload({ through });
      host.toast(msg);
    };

    // What the date is.
    form.querySelector('.ev-tools').addEventListener('click', async (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      // A break is its own dialog, in place of this one: what it changes is
      // the card's, which is drawn again when it is done. Include other
      // parishes opens over this form and closes back to it.
      if (b.matches('[data-ev-break]')) { f.close(); return editBreak(e.id); }
      if (b.matches('[data-ev-combine]')) return combine(e.id);
      if (b.matches('[data-ev-delete]')) {
        const go = await askChoice({
          title: `Delete ${e.title}?`,
          body: '<p>It goes for good, from the site and the parish page. To tell people it is off, cancel it instead.</p>',
          choices: [{ value: 'delete', label: 'Delete it', danger: true },
            { value: 'cancel', label: 'Cancel it instead', hint: 'It stays on the parish page, struck through.' }],
        });
        if (go === 'cancel') return setStatus('cancelled', { asked: true });
        if (go !== 'delete') return;
        const res = await fetch(`/api/admin/events/${encodeURIComponent(e.id)}`, { method: 'DELETE' }).catch(() => null);
        if (!res || !res.ok) return fail(res ? await errorText(res) : 'It did not go through. Check the connection.');
        return done('Deleted');
      }
      if (b.dataset.evStatus) setStatus(b.dataset.evStatus);
    });
    // Cancel and Suppress look alike and are not (docs/editing.md), so both
    // say what they do first; Uncancel and Unsuppress just do it.
    async function setStatus(status, { asked = false } = {}) {
      fail('');
      if (status === 'cancelled' && !asked) {
        const choices = [{ value: 'one', label: series ? `Only ${series.dateLabel}` : 'Cancel it',
          hint: 'It stays on the parish page, struck through, so anyone who would have come sees it is off.' }];
        if (series && host.may('schedule.edit', series.rule.parish_id)) {
          choices.push({ value: 'following', label: `This and every following ${series.day}`, danger: true,
            hint: 'The service ends. Later dates leave the timetable and are not shown as cancelled. If it is coming back, use a break instead.' });
        }
        const pick = await askChoice({ title: `Cancel ${e.title}?`, choices });
        if (!pick) return;
        if (pick === 'following') {
          if (!(await keepByHand(series.rule.parish_id))) return;
          const r = await postFollowing(e.id, { action: 'end' }, fail);
          if (r) await done(`${series.rule.title} ends before ${series.dateLabel}`);
          return;
        }
      }
      if (status === 'hidden') {
        const pick = await askChoice({
          title: `Suppress ${e.title}?`,
          body: '<p>It leaves the site with no notice: nobody is told it is off. For a service that is simply not on this week, cancel it instead.</p>',
          choices: [{ value: 'hidden', label: 'Suppress it', danger: true },
            { value: 'cancelled', label: 'Cancel it instead', hint: 'It stays on the parish page, struck through.' }],
        });
        if (!pick) return;
        status = pick;
      }
      const res = await fetch(`/api/admin/events/${encodeURIComponent(e.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
      }).catch(() => null);
      if (!res || !res.ok) return fail(res ? await errorText(res) : 'It did not go through. Check the connection.');
      await done({ cancelled: 'Cancelled. It shows struck through.', hidden: 'Suppressed', approved: 'It is back on' }[status]);
    }

    // The fields.
    const save = form.querySelector('[data-ev-save]');
    save.addEventListener('click', async () => {
      if (save.disabled) return;
      save.disabled = true;
      try { await saveFields(); } finally { save.disabled = false; }
    });
    async function saveFields() {
      fail('');
      if (root.AgoraTimeField && root.AgoraTimeField.commitAll && !root.AgoraTimeField.commitAll(form)) {
        return fail('One of the times is not a time. Pick one from the list, or type it like 6:30 pm.');
      }
      const v = (k) => { const el = q(k); return el ? (el.type === 'checkbox' ? el.checked : el.value.trim()) : undefined; };
      const date = series ? series.date : v('date');
      const st = v('start_time'), et = v('end_time') || null;
      const isMulti = !!v('multi');
      const last = isMulti ? v('last') : null;
      if (!v('title')) return fail('Give it a name.');
      if (!date) return fail('Which day is it?');
      if (!st) return fail('When does it start?');
      if (isMulti && (!last || last <= date)) return fail('The last day must be after the first.');
      if (isMulti && !et) return fail('Give the time it ends on its last day.');
      if (!isMulti && et && et <= st) {
        const go = await askChoice({
          title: 'It ends before it starts',
          choices: [{ value: 'keep', label: 'It runs past midnight' }, { value: 'fix', label: 'Fix the times' }],
        });
        if (go !== 'keep') return;
      }
      const pid = v('parish_id') || e.parish_id;
      const span = localSpanToUtc(series ? zone : zoneOf(pid), date, st, et, last);
      // A service says its language (a one-off must: it has no timetable to
      // go by); anything else carries none.
      const langs = isService(v('event_type')) ? String(v('languages') || '').split(',').map(s => s.trim()).filter(Boolean) : [];
      const langErr = form.querySelector('[data-ev-langerr]');
      langErr.hidden = true;
      if (!series && isService(v('event_type')) && !langs.length) {
        // Said where it is answered, which on a phone is well above the button.
        langErr.textContent = 'Which language is it in? Pick at least one.';
        langErr.hidden = false;
        form.querySelector('[data-ev-langrow]').scrollIntoView({ block: 'center', behavior: 'smooth' });
        return;
      }
      const body = {
        title: v('title'),
        description: v('description') || null,
        event_type: v('event_type'),
        languages: langs.length ? JSON.stringify(langs) : null,
        start_utc: span.start_utc,
        end_utc: span.end_utc,
        parish_scoped: v('parish_scoped'),
      };
      for (const k of VENUE) { const x = v(k); body[k] = x === '' || x == null ? null : (k.endsWith('_lat') || k.endsWith('_lng') ? Number(x) : x); }
      if (q('hide_live')) body.hide_live = v('hide_live');
      body.feast = v('feast') || null;
      if (!series) body.parish_id = pid;

      // A date of a service asks which dates: the earlier ones keep what
      // they were, and this card follows the date onto the new rule.
      if (series && host.may('schedule.edit', series.rule.parish_id)) {
        const pick = await askChoice({
          title: 'Save the change for…',
          choices: [
            { value: 'one', label: `Only ${series.dateLabel}` },
            { value: 'following', label: `This and every following ${series.day}`, hint: 'Earlier dates keep what they were.' },
          ],
        });
        if (!pick) return;
        if (pick === 'following') {
          if (!(await keepByHand(series.rule.parish_id))) return;
          const r = await postFollowing(e.id, { action: 'edit', ...body }, fail);
          if (!r) return;
          return done(`Saved for every ${series.day} from ${series.dateLabel.replace(/^\S+ /, '')}`, { to: r.schedule_id ? `${r.schedule_id}:${series.date}` : e.id });
        }
      }
      const res = await fetch(`/api/admin/events/${encodeURIComponent(e.id)}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }).catch(() => null);
      if (!res || !res.ok) return fail(res ? await errorText(res) : 'It did not go through. Check the connection.');
      await done('Saved', { through: isMulti ? last : date });
    }
    const first = q('title');
    if (first && !touchFirst()) first.focus({ preventScroll: true });
  }

  // ── A break ───────────────────────────────────────────────────────────
  //
  // A stretch of dates a service is not on: shut between Christmas and
  // Theophany, the priest away. The third answer beside Cancel and Suppress,
  // and like neither: a range that still renders, each date a BREAK tombstone
  // with its reason (app.js openBreakEditor). One rule, or everything at the
  // parish. Gated on `override.edit`, as its route is.

  const dayAfter = (iso) => new Date(Date.parse(iso + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  /** The breaks that speak for a rule: its own, and its parish's. */
  const breaksOf = (rule) => ((root.agoraBundle && root.agoraBundle.breaks()) || [])
    .filter(b => (b.schedule_id != null ? String(b.schedule_id) === String(rule.id) : b.parish_id === rule.parish_id));

  function editBreak(id) {
    const series = seriesOf(id);
    if (!series || !host.may('override.edit', series.rule.parish_id)) return;
    const { rule, date } = series;
    const parish = host.parish(rule.parish_id);
    const DF = RF().dateFieldHTML;
    const f = frame({ title: 'Break', sub: [rule.title, parish && parish.name].filter(Boolean).join(' · '), cls: 'break-backdrop' });
    f.body.innerHTML = `<div class="detail-edit-form bk-form">
        <p class="bk-lead">Dates it is not on, for a while. Each one still shows, struck through, with the reason, and the timetable says when it is back.</p>
        <div data-bk-existing></div>
        <div class="edit-row"><label>For</label>
          <div class="cad-modes">
            <label class="cad-mode"><input type="radio" name="bk-scope" value="rule" checked> Just ${esc(rule.title)}</label>
            <label class="cad-mode"><input type="radio" name="bk-scope" value="parish"> Everything at ${esc(parish ? parish.name : 'the parish')}</label>
          </div>
        </div>
        <div class="edit-row edit-pair">
          <div><label>From</label>${DF('from', date, 'Pick a date', { attr: 'data-bk', required: true })}</div>
          <div><label>To</label>${DF('to', date, 'Pick a date', { attr: 'data-bk', required: true })}</div>
        </div>
        <div class="edit-row"><label>Why</label><input data-bk="note" placeholder="Christmas break" maxlength="120" autocomplete="off"></div>
        <div class="edit-row-hint" data-bk-hint></div>
        <p class="rf-error" role="alert" hidden></p>
        <div class="form-actions">
          <button class="btn-save" type="button" data-bk-save>Set break</button>
          <button class="btn-outline" type="button" data-frame-close>Close</button>
        </div>
      </div>`;
    const form = f.body.firstElementChild;
    const q = (k) => form.querySelector(`[data-bk="${k}"]`);
    const scope = () => (form.querySelector('input[name="bk-scope"]:checked') || {}).value || 'rule';
    const err = form.querySelector('.rf-error');
    const fail = (msg) => { err.textContent = msg; err.hidden = !msg; if (msg) err.scrollIntoView({ block: 'nearest' }); };
    RF().wireDates(form, host.today());

    // What the window does, in this service's own dates rather than in days.
    const hint = () => {
      const el = form.querySelector('[data-bk-hint]');
      const from = q('from').value, to = q('to').value;
      const also = scope() === 'parish' ? ` Every other service at ${parish ? parish.name : 'the parish'} in those days is on the break too.` : '';
      if (!from || !to) { el.textContent = ''; return; }
      if (to < from) { el.textContent = 'It ends before it starts.'; return; }
      let n = 0;
      for (let d = from, i = 0; d <= to && i < 400; d = dayAfter(d), i++) {
        if (root.agoraBundle.resolveEvent(`${rule.id}:${d}`)) n++;
      }
      el.textContent = (n ? `${n === 1 ? 'One date' : `${n} dates`} of ${rule.title} will show as a break.` : `${rule.title} has no date in those days.`) + also;
    };
    form.addEventListener('change', hint);
    hint();

    // What is on file already, each liftable.
    const paintExisting = () => {
      const box = form.querySelector('[data-bk-existing]');
      const rows = breaksOf(rule);
      box.innerHTML = rows.length ? `<div class="bk-head">On file</div>${rows.map(b => `
          <div class="bk-row">
            <div><b>${esc(longDate(b.from_date))} – ${esc(longDate(b.to_date))}</b>
              <span>${b.schedule_id == null ? 'Everything at the parish' : esc(rule.title)}</span>
              ${b.note ? `<small>${esc(b.note)}</small>` : ''}</div>
            <button class="rf-btn" type="button" data-lift="${esc(b.id)}">Lift</button>
          </div>`).join('')}` : '';
    };
    paintExisting();
    form.querySelector('[data-bk-existing]').addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-lift]');
      if (!b) return;
      const go = await askChoice({
        title: 'Lift this break?',
        body: '<p>The dates it covers run again as the timetable says.</p>',
        choices: [{ value: 'lift', label: 'Lift it' }],
      });
      if (go !== 'lift') return;
      const res = await fetch(`/api/admin/breaks/${encodeURIComponent(b.dataset.lift)}`, { method: 'DELETE' }).catch(() => null);
      if (!res || !res.ok) return fail(res ? await errorText(res) : 'It did not go through. Check the connection.');
      await host.reload();
      paintExisting();
      hint();
      host.toast('Break lifted');
    });

    const save = form.querySelector('[data-bk-save]');
    save.addEventListener('click', async () => {
      if (save.disabled) return;
      fail('');
      const from = q('from').value, to = q('to').value, note = q('note').value.trim();
      if (!from || !to) return fail('A break needs a first and a last day.');
      if (to < from) return fail('It ends before it starts.');
      // The note is all a visitor is told in place of the service.
      if (!note) return fail('Say why. It is what each date shows in place of the service.');
      save.disabled = true;
      try {
        const res = await fetch('/api/admin/breaks', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ schedule_id: scope() === 'parish' ? null : rule.id, parish_id: rule.parish_id, from_date: from, to_date: to, note }),
        }).catch(() => null);
        if (!res || !res.ok) return fail(res ? await errorText(res) : 'It did not go through. Check the connection.');
        f.close();
        await host.reload({ through: to });
        host.toast('Break set');
      } finally { save.disabled = false; }
    });
    q('note').focus({ preventScroll: true });
  }

  // ── Include other parishes ────────────────────────────────────────────
  //
  // One event at several parishes, and in place of their own services that
  // day: the combine (docs/editing.md), as the add-event editor offers it on
  // every card, with its parish list (nearest first, by jurisdiction) and its
  // "needs an owner". A tick that is not this person's to make becomes an
  // ask: their own part goes ahead, and an owner is asked for the rest.

  async function combine(id) {
    const e = host.event(id);
    const EE = root.AgoraEventEditor;
    if (!e || seriesOf(id) || !EE || !host.may('event.edit', e.parish_id)) return;
    const parish = host.parish(e.parish_id) || { id: e.parish_id, name: e.parish_name };
    const zone = e.timezone || parish.timezone || 'Australia/Sydney';
    const date = (await tz()).localPartsOf(zone, Date.parse(e.start_utc)).date;
    const f = frame({ title: 'Include other parishes', sub: `${e.title} · ${longDate(date)}`, cls: 'combine-backdrop' });
    f.body.innerHTML = `<div class="detail-edit-form cb-form">
        <div class="ee-section-title">Also appears at</div>
        <input type="search" class="cb-find" placeholder="Find a parish" autocomplete="off" aria-label="Find a parish">
        <div class="ee-list" data-list="also"></div>
        <div class="ee-section-title">In place of their own services that day</div>
        <div class="ee-list" data-list="replaces"><div class="ee-empty">Loading…</div></div>
        <div class="edit-row-hint">Whatever is ticked here stops being its own card and shows as a tombstone pointing at this event: nothing disappears.</div>
        <div class="cb-ask" hidden>
          <p>Some of what is ticked is not yours. Yours goes ahead now, and an owner is asked for the rest.</p>
          <input data-cb-reason placeholder="Why: the owner reads this" autocomplete="off">
        </div>
        <p class="rf-error" role="alert" hidden></p>
        <div class="form-actions">
          <button class="btn-save" type="button" data-cb-save>Save</button>
          <button class="btn-outline" type="button" data-frame-close>Close</button>
        </div>
      </div>`;
    const form = f.body.firstElementChild;
    const err = form.querySelector('.rf-error');
    const fail = (msg) => { err.textContent = msg; err.hidden = !msg; if (msg) err.scrollIntoView({ block: 'nearest' }); };
    const alsoBox = form.querySelector('[data-list="also"]');
    const replBox = form.querySelector('[data-list="replaces"]');
    const askBox = form.querySelector('.cb-ask');
    const find = form.querySelector('.cb-find');

    const also = new Set();
    const replaces = new Set();
    let candidates = null;
    let refused = false;
    const rows = EE.orderParishRows(parish, host.parishes(), host.may);
    const zoneOf = (pid) => (host.parish(pid) || {}).timezone || zone;

    const paintAlso = () => {
      const needle = find.value.trim().toLowerCase();
      let lastJuris = null;
      alsoBox.innerHTML = rows.filter(p => p._isOwn || also.has(p.id) || !needle || String(p.name).toLowerCase().includes(needle)).map(p => {
        let head = '';
        if (!p._isOwn && p.jurisdiction !== lastJuris) {
          lastJuris = p.jurisdiction;
          const j = String(p.jurisdiction || 'Other');
          head = `<div class="ee-group">${esc(j.charAt(0).toUpperCase() + j.slice(1))} Orthodox</div>`;
        }
        const tag = p._isOwn ? '<em class="ee-tag">own</em>' : p._needsAsk ? '<em class="ee-tag ee-tag-ask">needs an owner</em>' : '';
        const sub = p._isOwn ? '' : EE.kmLabel(p._km);
        return `${head}<label class="ee-item"><input type="checkbox" value="${esc(p.id)}"${p._isOwn ? ' checked disabled' : also.has(p.id) ? ' checked' : ''}>`
          + `<span>${esc(p.name)}${tag}${sub ? `<small>${esc(sub)}</small>` : ''}</span></label>`;
      }).join('');
    };
    const paintReplaces = () => {
      if (candidates == null) return;
      const at = new Set([parish.id, ...also]);
      const shown = candidates.filter(c => at.has(c.parish_id));
      // A tick this list no longer shows goes: hidden, it would still combine.
      for (const rid of [...replaces]) if (!shown.some(c => String(c.id) === rid)) replaces.delete(rid);
      replBox.innerHTML = shown.length ? shown.map(c => {
        const when = new Intl.DateTimeFormat('en-AU', { timeZone: zoneOf(c.parish_id), hour: 'numeric', minute: '2-digit' }).format(new Date(c.start_utc));
        const tag = host.may('event.edit', c.parish_id) ? '' : '<em class="ee-tag ee-tag-ask">needs an owner</em>';
        return `<label class="ee-item"><input type="checkbox" value="${esc(String(c.id))}"${replaces.has(String(c.id)) ? ' checked' : ''}>`
          + `<span>${esc(c.title)}${tag}<small>${esc(when)} · ${esc(c.parish_name || '')}</small></span></label>`;
      }).join('') : '<div class="ee-empty">Nothing on file at the ticked parishes that day</div>';
    };
    const needsAsk = () => refused || EE.askNeeded({ also_at: [...also], replaces: [...replaces] }, host.may,
      (rid) => ((candidates || []).find(c => String(c.id) === String(rid)) || {}).parish_id ?? null);
    const paintAsk = () => { askBox.hidden = !needsAsk(); };

    alsoBox.addEventListener('change', (ev) => {
      const cb = ev.target;
      if (cb.checked) also.add(cb.value); else also.delete(cb.value);
      paintReplaces();
      paintAsk();
    });
    replBox.addEventListener('change', (ev) => {
      const cb = ev.target;
      if (cb.checked) replaces.add(cb.value); else replaces.delete(cb.value);
      paintAsk();
    });
    find.addEventListener('input', paintAlso);

    // What it is combined with now, and what that day holds.
    const get = (url) => fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null);
    const [cands, current] = await Promise.all([
      get(`/api/admin/events/candidates?date=${encodeURIComponent(date)}&tz=${encodeURIComponent(zone)}&exclude_id=${encodeURIComponent(e.id)}`),
      get(`/api/admin/events/${encodeURIComponent(e.id)}/escalation`),
    ]);
    if (!form.isConnected) return;
    if (!cands || !current) { replBox.innerHTML = '<div class="ee-empty">Could not load that day. Close and try again.</div>'; return; }
    for (const pid of current.additive_parish_ids || []) also.add(pid);
    const ids = new Set(cands.map(c => String(c.id)));
    candidates = [...cands, ...(current.replaced_events || []).filter(c => !ids.has(String(c.id)))];
    for (const c of current.replaced_events || []) replaces.add(String(c.id));
    paintAlso();
    paintReplaces();
    paintAsk();

    const save = form.querySelector('[data-cb-save]');
    save.addEventListener('click', async () => {
      if (save.disabled) return;
      fail('');
      const asking = needsAsk();
      const reason = form.querySelector('[data-cb-reason]').value.trim();
      save.disabled = true;
      try {
        const res = await fetch(`/api/admin/events/${encodeURIComponent(e.id)}/escalate`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ additive_parish_ids: [...also], replaced_event_ids: [...replaces], ...(asking ? { propose: reason || true } : {}) }),
        }).catch(() => null);
        if (res && res.status === 403) {
          const body = await res.clone().json().catch(() => null);
          // Somewhere to go: the same request, as an ask.
          if (body && body.proposable) {
            refused = true;
            paintAsk();
            return fail(`${body.error} Save again to ask an owner.`);
          }
        }
        if (!res || !res.ok) return fail(res ? await errorText(res) : 'It did not go through. Check the connection.');
        const out = await res.json().catch(() => ({}));
        f.close();
        await host.reload();
        host.toast(out.proposal_id ? 'Yours is done; an owner is asked for the rest' : 'Saved');
        if (out.proposal_id) host.recheck();
      } finally { save.disabled = false; }
    });
  }


  // ── A pin, on a map of its own ────────────────────────────────────────
  //
  // The app's pin mover (app.js openPinPicker): a crosshair fixed dead centre
  // and a map that moves under it, so the thumb never covers the spot being
  // aimed at, and a live readout of exactly what will be kept. A second
  // MapLibre map on the page map's basemap alone (the parish layers' images
  // belong to the other map), made when it opens and removed when it closes.
  // For a parish's pin, and for "Move the pin" wherever a venue is picked.

  const coord = (n) => Number(n).toFixed(6);
  function basemapStyle() {
    let style = null;
    try { style = root.agoraMap && root.agoraMap.getStyle(); } catch { return null; }
    if (!style || !style.sources || !style.sources.protomaps) return null;
    return {
      ...style,
      sources: { protomaps: style.sources.protomaps },
      layers: (style.layers || []).filter(l => l.type === 'background' || l.source === 'protomaps'),
    };
  }
  /** Opens on `lat`/`lng` (Sydney if none); `done({lat, lng})` on "Use this spot". */
  function pickPin({ lat = null, lng = null, title = '' } = {}, done) {
    let m = null;
    const f = frame({ title: 'Move the pin', sub: title, cls: 'pin-backdrop', onClose: () => { if (m) m.remove(); m = null; } });
    f.body.innerHTML = `<div class="pin-form">
        <div class="pin-stage"><div class="pin-map"></div><div class="pin-cross" aria-hidden="true"></div></div>
        <div class="pin-readout" aria-live="polite"></div>
        <p class="pin-hint">Drag the map until the circle sits on the church door. It is the dot people tap for directions.</p>
        <div class="form-actions">
          <button class="btn-save" type="button" data-pin-use>Use this spot</button>
          <button class="btn-outline" type="button" data-frame-close>Back</button>
        </div>
      </div>`;
    const readout = f.body.querySelector('.pin-readout');
    const use = f.body.querySelector('[data-pin-use]');
    const style = basemapStyle();
    if (!style || !root.maplibregl) {
      readout.textContent = 'The map is still loading. Close this and try again.';
      use.disabled = true;
      return;
    }
    const at = lat != null && lng != null && Number.isFinite(+lat) ? [+lng, +lat] : null;
    m = new root.maplibregl.Map({
      container: f.body.querySelector('.pin-map'), style,
      center: at || [151.21, -33.87], zoom: at ? 17 : 12,
      attributionControl: false, dragRotate: false, pitchWithRotate: false, touchPitch: false, boxZoom: false,
    });
    m.touchZoomRotate.disableRotation();
    const sync = () => { const c = m.getCenter(); readout.textContent = `${coord(c.lat)}, ${coord(c.lng)}`; };
    m.on('move', sync);
    sync();
    use.addEventListener('click', () => {
      const c = m.getCenter();
      f.close();
      done({ lat: c.lat, lng: c.lng });
    });
  }

  // ── A parish's details ────────────────────────────────────────────────
  //
  // The app's "Edit details" (app.js openParishDetailsDialog), behind the
  // pencil on the card's Details: the logo and names, each line of Details
  // as the field that edits it, the address with its pin and the Google Maps
  // place Directions opens, and where the parish is read from. Save is one
  // PATCH, which works out from what changed whose edit it is
  // (worker/lib/provenance.mjs). The logo and the links are dialogs of their
  // own over it, each kept by its own button, as in the app.

  // Mirrors the jurisdiction CHECK in d1/schema.sql.
  const JURISDICTIONS = ['antiochian', 'greek', 'macedonian', 'romanian', 'russian', 'serbian', 'other'];
  const PD = 'data-pd';
  const PENCIL = '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>';
  const PAY_LINKS = [['donate', 'donation_url', 'Donate'], ['payment', 'payment_url', 'Payment'], ['raffle', 'raffle_url', 'Raffle'], ['gala', 'gala_url', 'Gala']];
  const linksOf = (pid) => ((root.agoraBundle && root.agoraBundle.raw && root.agoraBundle.raw.parish_links) || [])
    .filter(l => l.parish_id === pid);
  /** "Donate, Raffle and 2 more", or "None yet". */
  function linksSummary(pid) {
    const p = host.parish(pid) || {};
    const names = [...PAY_LINKS.filter(([, col]) => p[col]).map(([, , label]) => label), ...linksOf(pid).map(l => l.label || l.slug)];
    if (!names.length) return 'None yet';
    return names.length > 3 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(', ').replace(/, ([^,]*)$/, ' and $1');
  }
  const slugOf = (p) => (p.acronym || '').toLowerCase().replace(/\s+/g, '') || p.id;

  function editDetails(pid) {
    const p = host.parish(pid);
    if (!p || !host.may('parish.edit', pid)) return;
    const RFrom = root.AgoraReadFrom;
    const mayAcronym = host.may('parish.acronym', pid);
    const v = (k) => esc(p[k] == null ? '' : p[k]);
    const fld = (name) => `${PD}="${name}"`;
    const cap = (j) => j.charAt(0).toUpperCase() + j.slice(1);
    const suburb = String(p.address || '').split(',').slice(-2, -1)[0] || '';
    const rfNow = RFrom ? RFrom.readFrom(p) : null;
    const logoHTML = () => `${host.avatar(host.parish(pid) || p, 'xl')}<span class="pd-logo-pen">${PENCIL}</span>`;

    const f = frame({ title: 'Edit details', sub: p.full_name || p.name, cls: 'details-backdrop' });
    f.body.innerHTML = `<div class="detail-edit-form pd-form">
        <div class="pd-head">
          ${host.may('logo.edit', pid) ? `<button type="button" class="pd-logo" data-pd-logo aria-label="Change the logo">${logoHTML()}</button>` : host.avatar(p, 'xl')}
          <div class="edit-row pd-names"><label>Full name</label><input ${fld('full_name')} value="${v('full_name')}" placeholder="St Nicholas Orthodox Church" autocomplete="off"></div>
        </div>
        <div class="edit-row edit-pair">
          <div><label>Short name</label><input ${fld('name')} value="${v('name')}" autocomplete="off"></div>
          <div><label>Jurisdiction</label><select ${fld('jurisdiction')}>${JURISDICTIONS.map(j =>
            `<option value="${j}"${p.jurisdiction === j ? ' selected' : ''}>${cap(j)}</option>`).join('')}</select></div>
        </div>
        <div class="edit-row"><label>Phone</label><input type="tel" ${fld('phone')} value="${v('phone')}" placeholder="02 9000 0000" autocomplete="off"></div>
        <div class="edit-row"><label>Website</label><input type="url" ${fld('website')} value="${v('website')}" placeholder="https://" autocomplete="off"></div>
        <div class="edit-row"><label>Email</label><input type="email" ${fld('email')} value="${v('email')}" placeholder="office@…" autocomplete="off"></div>
        <div class="edit-row"><label>Address</label>
          <input ${fld('address')} value="${v('address')}" placeholder="Where the service is: the door somebody walks through" autocomplete="off">
          <div class="pd-pin">
            <button class="rf-btn" type="button" data-pd-locate>Locate pin</button>
            <button class="rf-btn" type="button" data-pd-move>Move pin</button>
          </div>
          <div class="pin-status" data-pd-pin></div>
        </div>
        <div class="edit-row"><label>Directions open</label>
          <div class="pd-maps-now" data-pd-maps-now></div>
          <div class="pd-find">
            <input data-pd-q value="${esc(`${p.full_name || p.name || ''} ${suburb}`.trim())}" aria-label="Search Google Maps" autocomplete="off">
            <button class="rf-btn" type="button" data-pd-find>Find</button>
          </div>
          <div class="pd-results" data-pd-results></div>
          <input ${fld('maps_url')} value="${v('maps_url')}" placeholder="Or paste its Google Maps link" aria-label="Google Maps link" autocomplete="off">
          <button class="ev-link pd-usepin" type="button" data-pd-usepin>Use the pin instead</button>
        </div>
        <div class="edit-row"><label>Short link</label>
          <input ${fld('acronym')} value="${v('acronym')}" placeholder="acronym" autocomplete="off" autocapitalize="none" spellcheck="false"${mayAcronym ? '' : ' disabled'}>
          <div class="edit-row-hint" data-pd-acro></div>
          ${mayAcronym ? '<div class="edit-row-hint" data-pd-suggested hidden>Suggested from the names. Keep it, change it, or clear it.</div>'
            : '<button class="ev-link pd-ask" type="button" data-pd-ask>Ask an owner to change it</button>'}
        </div>
        <div class="edit-row"><label>Live stream</label><input type="url" ${fld('live_url')} value="${v('live_url')}" placeholder="https://youtube.com/…" autocomplete="off"></div>
        ${host.may('links.edit', pid) ? `<div class="edit-row"><label>Donate and short links</label>
          <div class="pd-links"><span data-pd-links-now>${esc(linksSummary(pid))}</span><button class="rf-btn" type="button" data-pd-links>Edit links…</button></div>
        </div>` : ''}
        ${RFrom ? `<div class="edit-row"><label>Details and service times</label>
          <select ${fld('read_from')}>${RFrom.READ_FROM.map(x => `<option value="${x}"${x === rfNow ? ' selected' : ''}>${esc(RFrom.LABELS[x])}</option>`).join('')}</select>
          <div class="edit-row-hint" data-pd-rf-hint>${esc(RFrom.HINTS[rfNow])}</div>
        </div>` : ''}
        ${root.AgoraSourceLine ? root.AgoraSourceLine.detailsSourceHTML(p, { cls: 'src-line' }) : ''}
        ${host.may('parish.delete', pid) ? '<div class="pd-delete"><button class="rf-btn danger" type="button" data-pd-delete>Delete parish</button></div>' : ''}
        <p class="rf-error" role="alert" hidden></p>
        <div class="form-actions">
          <button class="btn-save" type="button" data-pd-save>Save</button>
          <button class="btn-outline" type="button" data-frame-close>Close</button>
        </div>
      </div>`;
    const form = f.body.firstElementChild;
    const q = (name) => form.querySelector(`[${PD}="${name}"]`);
    const on = (sel, fn) => { const el = form.querySelector(sel); if (el) el.addEventListener('click', fn); };
    const err = form.querySelector('.rf-error');
    const fail = (msg) => { err.textContent = msg; err.hidden = !msg; if (msg) err.scrollIntoView({ block: 'nearest' }); };

    // The pin. Nothing here writes: a pin located or placed is kept in the
    // dialog until Save, which sends it as lat/lng (the route re-geocodes only
    // an address that comes without them).
    let pin = null;
    const pinBox = form.querySelector('[data-pd-pin]');
    const paintPin = (problem = '') => {
      const now = host.parish(pid) || p;
      pinBox.innerHTML = problem ? `<span class="bad">${esc(problem)}</span>`
        : pin ? `<span class="staged">New pin: ${coord(pin.lat)}, ${coord(pin.lng)}</span>, ${pin.manual ? 'placed by hand' : 'from the address'}. Save to keep it.`
          : now.lat == null || now.lng == null ? 'No pin yet. Locate it from the address, or place it by hand.'
            : `Pin: ${coord(now.lat)}, ${coord(now.lng)}`;
    };
    paintPin();
    // A pin read from the address no longer describes an address that changed;
    // one placed by hand stays, since tidying the street's wording has not moved the church.
    q('address').addEventListener('input', () => { if (pin && !pin.manual) pin = null; paintPin(); });
    on('[data-pd-locate]', async (ev) => {
      const address = q('address').value.trim();
      if (!address) return paintPin('Type an address first.');
      ev.currentTarget.disabled = true;
      pinBox.textContent = 'Looking that address up…';
      const res = await fetch('/api/admin/geocode', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ address }),
      }).catch(() => null);
      form.querySelector('[data-pd-locate]').disabled = false;
      if (!res || !res.ok) {
        return paintPin(res && res.status === 404 ? 'No match for that address. Place the pin by hand instead.'
          : res ? await errorText(res) : 'The lookup did not go through.');
      }
      const c = await res.json();
      pin = { lat: c.lat, lng: c.lng, manual: false };
      paintPin();
    });
    on('[data-pd-move]', () => {
      const now = pin || host.parish(pid) || p;
      pickPin({ lat: now.lat, lng: now.lng, title: p.name }, (c) => { pin = { ...c, manual: true }; paintPin(); });
    });

    // What Directions opens: a place chosen on Google Maps, or the pin.
    const mapsNow = form.querySelector('[data-pd-maps-now]');
    const usePin = form.querySelector('[data-pd-usepin]');
    const paintMaps = (text) => {
      mapsNow.textContent = text || (q('maps_url').value.trim() ? 'A place on Google Maps.' : 'The pin, from the address.');
      usePin.hidden = !q('maps_url').value.trim();
    };
    paintMaps();
    q('maps_url').addEventListener('input', () => paintMaps(q('maps_url').value.trim() ? 'This link. Save to keep it.' : ''));
    usePin.addEventListener('click', () => {
      q('maps_url').value = '';
      form.querySelectorAll('.pd-result').forEach(x => x.classList.remove('chosen'));
      paintMaps('The pin, from the address. Save to keep it.');
    });
    const results = form.querySelector('[data-pd-results]');
    // Through the Worker, which holds the key. A deployment whose key cannot
    // search Places says so, and the pasted link and the pin are right there.
    async function findPlace() {
      const query = form.querySelector('[data-pd-q]').value.trim();
      if (!query) return;
      results.innerHTML = '<div class="pd-note">Searching…</div>';
      const now = host.parish(pid) || p;
      const res = await fetch('/api/admin/places', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, lat: now.lat, lng: now.lng }),
      }).catch(() => null);
      const body = res ? await res.json().catch(() => null) : null;
      const places = (body && body.places) || [];
      if (!places.length) {
        results.innerHTML = `<div class="pd-note">${esc((body && body.error) || 'Nothing found. Try the church’s name and suburb, or paste its link below.')}</div>`;
        return;
      }
      results.innerHTML = places.map((pl, i) => `<button type="button" class="pd-result" data-i="${i}"><b>${esc(pl.name || '')}</b><small>${esc(pl.address || '')}</small></button>`).join('');
      results.onclick = (ev) => {
        const b = ev.target.closest('.pd-result');
        if (!b) return;
        const pl = places[Number(b.dataset.i)];
        q('maps_url').value = pl.url || `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(pl.name || '')}&query_place_id=${encodeURIComponent(pl.id)}`;
        results.querySelectorAll('.pd-result').forEach(x => x.classList.toggle('chosen', x === b));
        paintMaps(`Chosen: ${pl.name}${pl.address ? `, ${pl.address}` : ''}. Save to keep it.`);
      };
    }
    on('[data-pd-find]', findPlace);
    form.querySelector('[data-pd-q]').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); findPlace(); } });

    // The short link: what it will be, or why it cannot (app.js wireAcronymHint).
    const acro = q('acronym');
    const acroHint = form.querySelector('[data-pd-acro]');
    const paintAcro = () => {
      const S = root.AgoraSlugs;
      const slug = S ? S.normaliseSlug(acro.value) : acro.value.trim().toLowerCase();
      let problem = mayAcronym && S ? S.reservedSlugReason(slug) : null;
      if (!problem && mayAcronym && slug && S) {
        const clash = host.parishes().find(x => x.id !== pid && x.id !== '_unassigned' && S.normaliseSlug(x.acronym) === slug);
        if (clash) problem = `“${slug}” is already the short link for ${clash.name}.`;
      }
      acroHint.classList.toggle('edit-row-hint-bad', !!problem);
      acroHint.textContent = problem || (mayAcronym
        ? (slug ? `orthodoxy.au/${slug}` : 'None. The parish has no short link.')
        : `${slug ? `orthodoxy.au/${slug}. ` : ''}Changing it changes the parish’s link, so an owner does it.`);
    };
    acro.addEventListener('input', paintAcro);
    paintAcro();
    // A parish with no short link gets one suggested from its names, for
    // whoever may set it. Nothing is kept until Save.
    if (mayAcronym && root.AgoraAcronymSuggest && !String(p.acronym || '').trim()) {
      const note = form.querySelector('[data-pd-suggested]');
      acro.addEventListener('input', (ev) => { if (ev.isTrusted) note.hidden = true; });
      root.AgoraAcronymSuggest.wire({
        input: acro, parishId: pid,
        names: () => ({ name: q('name').value, full_name: q('full_name').value, jurisdiction: q('jurisdiction').value }),
        watch: [q('name'), q('full_name')],
        onFill: () => { note.hidden = false; },
        now: true,
      });
    }
    on('[data-pd-ask]', () => askAcronym(pid));

    const rf = q('read_from');
    if (rf) rf.addEventListener('change', () => { form.querySelector('[data-pd-rf-hint]').textContent = RFrom.HINTS[rf.value]; });
    on('[data-pd-logo]', () => editLogo(pid, {
      onChange: () => { const b = form.querySelector('[data-pd-logo]'); if (b) b.innerHTML = logoHTML(); },
    }));
    on('[data-pd-links]', () => editLinks(pid, {
      onSaved: () => { const s = form.querySelector('[data-pd-links-now]'); if (s) s.textContent = linksSummary(pid); },
    }));

    on('[data-pd-save]', async (ev) => {
      fail('');
      const save = ev.currentTarget;
      const val = (k) => { const el = q(k); return el ? el.value.trim() : ''; };
      if (!val('name')) { fail('The short name is what the card and the map call it, so it cannot be empty.'); q('name').focus(); return; }
      const data = { name: val('name'), jurisdiction: val('jurisdiction') };
      for (const k of ['full_name', 'phone', 'website', 'email', 'address', 'maps_url', 'live_url']) data[k] = val(k) || null;
      if (mayAcronym) data.acronym = val('acronym') || null;
      const now = host.parish(pid) || p;
      if (rf && RFrom && rf.value !== RFrom.readFrom(now)) data.read_from = rf.value;
      if (pin) { data.lat = pin.lat; data.lng = pin.lng; }
      // Choosing where it is read from in this same save is the answer to the question.
      if (data.read_from === undefined && !(await keepByHand(pid))) return;
      save.disabled = true;
      try {
        const res = await fetch(`/api/admin/parishes/${encodeURIComponent(pid)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
        }).catch(() => null);
        if (!res || !res.ok) { fail(res ? await errorText(res) : 'It did not go through. Check the connection.'); return; }
        const out = (await res.json().catch(() => null)) || {};
        f.close();
        await host.reload();
        host.toast(out.pin_errors && out.pin_errors.length
          ? `Saved, but the pin could not be held: ${out.pin_errors.map(x => x.error).join(' ')}` : 'Saved');
      } finally { save.disabled = false; }
    });

    on('[data-pd-delete]', async () => {
      fail('');
      const go = await askChoice({
        title: `Delete ${p.name}?`,
        body: '<p>Its card, its pin and its service times go. This cannot be undone.</p>',
        choices: [{ value: 'yes', label: 'Delete it', danger: true }],
      });
      if (!go) return;
      const send = (qs = '') => fetch(`/api/admin/parishes/${encodeURIComponent(pid)}${qs}`, { method: 'DELETE' }).catch(() => null);
      let res = await send();
      if (res && res.status === 400) {
        const b = await res.clone().json().catch(() => ({}));
        if (b.event_count) {
          const also = await askChoice({
            title: `${b.event_count} ${b.event_count === 1 ? 'event is' : 'events are'} on file at ${p.name}`,
            choices: [{ value: 'yes', label: 'Delete them too', hint: 'The parish cannot go while they point at it.', danger: true }],
          });
          if (!also) return;
          res = await send('?delete_events=1');
        }
      }
      if (!res || !res.ok) { fail(res ? await errorText(res) : 'It did not go through. Check the connection.'); return; }
      f.close();
      await host.reload();
      host.toast(`${p.name} deleted`);
    });
  }

  /**
   * A short link is an owner's to change, since it takes a link away from
   * everybody holding it; anybody else who may edit the parish asks for one
   * (/admin's offerProposal, worker/lib/proposals.mjs).
   */
  function askAcronym(pid) {
    const p = host.parish(pid);
    if (!p) return;
    const f = frame({ title: 'Ask for a new short link', sub: p.name, cls: 'ask-backdrop' });
    f.body.innerHTML = `<div class="detail-edit-form">
        <p class="bk-lead">An owner decides, because it changes the parish’s public link. Leave it empty to ask for it to be taken away.</p>
        <div class="edit-row"><label>The short link you want</label><input data-ak="acronym" value="${esc(p.acronym || '')}" autocomplete="off" autocapitalize="none" spellcheck="false"></div>
        <div class="edit-row"><label>Why</label><textarea data-ak="reason" rows="2" placeholder="Optional"></textarea></div>
        <p class="rf-error" role="alert" hidden></p>
        <div class="form-actions">
          <button class="btn-save" type="button" data-ak-send>Ask</button>
          <button class="btn-outline" type="button" data-frame-close>Back</button>
        </div>
      </div>`;
    const err = f.body.querySelector('.rf-error');
    f.body.querySelector('[data-ak-send]').addEventListener('click', async (ev) => {
      const val = (k) => f.body.querySelector(`[data-ak="${k}"]`).value.trim();
      ev.currentTarget.disabled = true;
      const res = await fetch('/api/admin/proposals', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capability: 'parish.acronym', subject: pid, payload: { acronym: val('acronym') }, reason: val('reason') || null }),
      }).catch(() => null);
      if (!res || !res.ok) {
        err.textContent = res ? await errorText(res) : 'It did not go through. Check the connection.';
        err.hidden = false;
        f.body.querySelector('[data-ak-send]').disabled = false;
        return;
      }
      f.close();
      host.toast('Asked. An owner decides.');
      host.recheck();
    });
  }

  // ── A parish's logo ───────────────────────────────────────────────────
  //
  // The app's logo editor (app.js openParishLogoEditor): the logo as it
  // stands, with Upload, Crop and Remove, and a cropper, a canvas the image is
  // drawn into under a circular mask, dragged to pan and zoomed by a slider.
  // The crop goes up square, AgoraLogo.LOGO_SIZE on a side, as WebP where the
  // browser can (public/shared/logo-image.js). An SVG goes up as it is.

  function editLogo(pid, { onChange = null } = {}) {
    const p = host.parish(pid);
    if (!p || !host.may('logo.edit', pid)) return;
    const SIZE = (root.AgoraLogo && root.AgoraLogo.LOGO_SIZE) || 192;
    const L = { img: null, scale: 1, fit: 1, x: 0, y: 0, side: 0, drag: null };
    const f = frame({ title: 'Logo', sub: p.name, cls: 'logo-backdrop' });
    f.body.innerHTML = `<div class="lg-form">
        <div data-lg-pane="choose">
          <div class="lg-preview"></div>
          <div class="lg-actions"></div>
        </div>
        <div data-lg-pane="crop" hidden>
          <div class="lg-stage"><canvas class="lg-canvas"></canvas><div class="lg-mask" aria-hidden="true"></div></div>
          <label class="lg-zoom"><span>Zoom</span><input type="range" min="100" max="400" value="100" step="1" data-lg-zoom></label>
          <p class="lg-hint">Drag the image to move it. What is inside the circle shows.</p>
        </div>
        <p class="rf-error" role="alert" hidden></p>
        <div class="form-actions" data-lg-crop-actions hidden>
          <button class="btn-save" type="button" data-lg-save>Save logo</button>
          <button class="btn-outline" type="button" data-lg-back>Back</button>
        </div>
        <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" hidden data-lg-file>
      </div>`;
    const box = f.body.firstElementChild;
    const $ = (sel) => box.querySelector(sel);
    const err = $('.rf-error');
    const fail = (msg) => { err.textContent = msg; err.hidden = !msg; };
    const stage = $('.lg-stage'), canvas = $('.lg-canvas');

    const pane = (which) => {
      $('[data-lg-pane="choose"]').hidden = which !== 'choose';
      $('[data-lg-pane="crop"]').hidden = which !== 'crop';
      $('[data-lg-crop-actions]').hidden = which !== 'crop';
    };
    // Crop offers itself only when there is a logo to crop, and Remove only
    // when there is one to remove.
    function paintChoose() {
      const now = host.parish(pid) || p;
      $('.lg-preview').innerHTML = host.avatar(now, 'xl');
      $('.lg-actions').innerHTML = `<button class="rf-btn" type="button" data-lg-upload>${now.logo_path ? 'Upload a new one' : 'Upload'}</button>
        ${now.logo_path ? '<button class="rf-btn" type="button" data-lg-crop>Crop</button><button class="rf-btn danger" type="button" data-lg-remove>Remove</button>' : ''}`;
      pane('choose');
    }
    paintChoose();

    const draw = () => {
      const ctx = canvas.getContext('2d');
      const dpr = canvas.width / L.side;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, L.side, L.side);
      ctx.drawImage(L.img, L.x, L.y, L.img.naturalWidth * L.scale, L.img.naturalHeight * L.scale);
    };
    // The image always covers the stage: a pan never drags an empty edge into the circle.
    const clamp = () => {
      L.x = Math.min(0, Math.max(L.side - L.img.naturalWidth * L.scale, L.x));
      L.y = Math.min(0, Math.max(L.side - L.img.naturalHeight * L.scale, L.y));
    };
    const zoom = (z, centre = false) => {
      const prev = L.scale, next = L.fit * z;
      if (centre) {
        L.x = (L.side - L.img.naturalWidth * next) / 2;
        L.y = (L.side - L.img.naturalHeight * next) / 2;
      } else {
        // About the stage's centre, so the part being looked at stays put.
        const cx = (L.side / 2 - L.x) / prev, cy = (L.side / 2 - L.y) / prev;
        L.x = L.side / 2 - cx * next;
        L.y = L.side / 2 - cy * next;
      }
      L.scale = next;
      clamp();
      draw();
    };
    function crop(src) {
      fail('');
      const img = new Image();
      // Same-origin for a stored /logos/… path and a blob: alike, so the canvas stays clean to export.
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        L.img = img;
        pane('crop');
        const side = Math.round(stage.getBoundingClientRect().width);
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        L.side = side;
        canvas.width = canvas.height = side * dpr;
        canvas.style.width = canvas.style.height = `${side}px`;
        // Cover, not contain: the circle never opens onto empty canvas.
        L.fit = L.scale = Math.max(side / img.naturalWidth, side / img.naturalHeight);
        $('[data-lg-zoom]').value = 100;
        zoom(1, true);
      };
      img.onerror = () => fail('That image could not be opened.');
      img.src = src;
    }
    $('[data-lg-zoom]').addEventListener('input', (ev) => { if (L.img) zoom(Number(ev.target.value) / 100); });
    stage.addEventListener('pointerdown', (ev) => { stage.setPointerCapture(ev.pointerId); L.drag = { x: ev.clientX, y: ev.clientY }; });
    stage.addEventListener('pointermove', (ev) => {
      if (!L.drag || !L.img) return;
      ev.preventDefault();
      L.x += ev.clientX - L.drag.x;
      L.y += ev.clientY - L.drag.y;
      L.drag = { x: ev.clientX, y: ev.clientY };
      clamp();
      draw();
    });
    const up = () => { L.drag = null; };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);

    /** After a change: the page again, the map's own copy of the logo, and the dialog it came from. */
    const after = async (msg) => {
      await host.reload();
      if (typeof root.agoraRefreshParishLogo === 'function') root.agoraRefreshParishLogo(pid);
      if (onChange) onChange();
      f.close();
      host.toast(msg);
    };
    async function upload(body, type) {
      const save = $('[data-lg-save]');
      save.disabled = true;
      const res = await fetch(`/api/admin/parishes/${encodeURIComponent(pid)}/logo`, {
        method: 'POST', headers: { 'Content-Type': type }, body,
      }).catch(() => null);
      save.disabled = false;
      if (!res || !res.ok) return fail(res ? await errorText(res) : 'The logo did not go through. Check the connection.');
      await after('Logo saved');
    }

    box.addEventListener('click', async (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.matches('[data-lg-upload]')) $('[data-lg-file]').click();
      else if (b.matches('[data-lg-crop]')) crop((host.parish(pid) || p).logo_path);
      else if (b.matches('[data-lg-back]')) { L.img = null; fail(''); paintChoose(); }
      else if (b.matches('[data-lg-remove]')) {
        const go = await askChoice({
          title: 'Take the logo off?',
          body: `<p>${esc(p.name)} shows its short name in its colour instead.</p>`,
          choices: [{ value: 'yes', label: 'Take it off', danger: true }],
        });
        if (!go) return;
        const res = await fetch(`/api/admin/parishes/${encodeURIComponent(pid)}/logo`, { method: 'DELETE' }).catch(() => null);
        if (!res || !res.ok) return fail(res ? await errorText(res) : 'It did not go through. Check the connection.');
        await after('Logo taken off');
      } else if (b.matches('[data-lg-save]')) {
        if (!L.img) return;
        const out = document.createElement('canvas');
        out.width = out.height = SIZE;
        // The stage is the crop: the same framing, scaled to the export.
        const k = SIZE / L.side;
        out.getContext('2d').drawImage(L.img, L.x * k, L.y * k, L.img.naturalWidth * L.scale * k, L.img.naturalHeight * L.scale * k);
        // Square, not round: everything that shows a logo rounds it already.
        const blob = root.AgoraLogo ? await root.AgoraLogo.encodeCanvas(out) : await new Promise(r => out.toBlob(r, 'image/png'));
        if (!blob) return fail('The crop could not be made.');
        await upload(blob, blob.type || 'image/png');
      }
    });
    $('[data-lg-file]').addEventListener('change', (ev) => {
      const file = ev.target.files && ev.target.files[0];
      ev.target.value = '';
      if (!file) return;
      // An SVG is already the right thing, sharp at any size: it goes up as it is.
      if (file.type === 'image/svg+xml') { pane('crop'); return upload(file, file.type); }
      crop(URL.createObjectURL(file));
    });
  }

  // ── A parish's short links ────────────────────────────────────────────
  //
  // The app's links dialog (app.js openParishLinks). The four payment kinds
  // are columns on `parishes`, anything else a row of `parish_links`; they
  // are edited together, as "the links we hand out", and saved as the two
  // writes they are, the columns first, so a refused slug does not lose those
  // too. Each row shows the link it makes.

  function editLinks(pid, { onSaved = null } = {}) {
    const p = host.parish(pid);
    if (!p || !host.may('links.edit', pid)) return;
    const base = `orthodoxy.au/${slugOf(p)}/`;
    const custom = linksOf(pid).map(l => ({ slug: l.slug, url: l.url, label: l.label || '' }));
    const f = frame({ title: 'Donate and short links', sub: p.name, cls: 'links-backdrop' });
    f.body.innerHTML = `<div class="detail-edit-form lk-form">
        <p class="bk-lead">Short links to hand out. Each one opens the page it is set to.</p>
        ${PAY_LINKS.map(([slug, col, label]) => `<div class="edit-row"><label>${esc(label)}<span class="lk-slug">${esc(base + slug)}</span></label>
          <input type="url" data-lk-col="${col}" value="${esc(p[col] || '')}" placeholder="https://…" autocomplete="off"></div>`).join('')}
        <div data-lk-custom></div>
        <button class="rf-btn" type="button" data-lk-add>Add a link</button>
        <p class="rf-error" role="alert" hidden></p>
        <div class="form-actions">
          <button class="btn-save" type="button" data-lk-save>Save</button>
          <button class="btn-outline" type="button" data-frame-close>Close</button>
        </div>
      </div>`;
    const form = f.body.firstElementChild;
    const list = form.querySelector('[data-lk-custom]');
    const err = form.querySelector('.rf-error');
    const fail = (msg) => { err.textContent = msg; err.hidden = !msg; if (msg) err.scrollIntoView({ block: 'nearest' }); };
    const paint = () => {
      list.innerHTML = custom.map((l, i) => `<div class="lk-row" data-i="${i}">
          <div class="lk-head">
            <input class="lk-name" data-lk="slug" value="${esc(l.slug)}" placeholder="name" aria-label="Its name in the link" autocomplete="off" autocapitalize="none" spellcheck="false">
            <button class="lk-del" type="button" data-lk-del aria-label="Remove">&times;</button>
          </div>
          <div class="lk-preview">${esc(base)}<b>${esc(l.slug || 'name')}</b></div>
          <input type="url" data-lk="url" value="${esc(l.url)}" placeholder="https://…" aria-label="Where it goes" autocomplete="off">
          <input data-lk="label" value="${esc(l.label)}" placeholder="What to call it" aria-label="What to call it" autocomplete="off">
        </div>`).join('');
    };
    paint();
    // Kept as it is typed, because adding or removing a row draws them all again.
    list.addEventListener('input', (ev) => {
      const row = ev.target.closest('.lk-row');
      const k = ev.target.dataset.lk;
      if (!row || !k) return;
      const l = custom[Number(row.dataset.i)];
      if (k === 'slug') {
        l.slug = ev.target.value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
        row.querySelector('.lk-preview b').textContent = l.slug || 'name';
      } else l[k] = k === 'url' ? ev.target.value.trim() : ev.target.value;
    });
    list.addEventListener('click', (ev) => {
      const row = ev.target.closest('[data-lk-del]') && ev.target.closest('.lk-row');
      if (row) { custom.splice(Number(row.dataset.i), 1); paint(); }
    });
    form.querySelector('[data-lk-add]').addEventListener('click', () => {
      custom.push({ slug: '', url: '', label: '' });
      paint();
      list.querySelector('.lk-row:last-child .lk-name').focus();
    });
    form.querySelector('[data-lk-save]').addEventListener('click', async (ev) => {
      fail('');
      const save = ev.currentTarget;
      const cols = {};
      form.querySelectorAll('[data-lk-col]').forEach(i => { cols[i.dataset.lkCol] = i.value.trim() || null; });
      save.disabled = true;
      try {
        const res = await fetch(`/api/admin/parishes/${encodeURIComponent(pid)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(cols),
        }).catch(() => null);
        if (!res || !res.ok) return fail(res ? await errorText(res) : 'It did not go through. Check the connection.');
        const res2 = await fetch(`/api/admin/parishes/${encodeURIComponent(pid)}/links`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ links: custom.filter(l => l.slug && l.url) }),
        }).catch(() => null);
        if (!res2 || !res2.ok) {
          await host.reload();
          return fail(`The four above are saved, but not the others: ${res2 ? await errorText(res2) : 'it did not go through.'}`);
        }
        f.close();
        await host.reload();
        if (onSaved) onSaved();
        host.toast('Links saved');
      } finally { save.disabled = false; }
    });
  }

  root.NextEdit = {
    init(h) { host = h; },
    askChoice, keepByHand, errorText, frame, pickPin, addEvent, addService, editService, editLine, editEvent, editBreak, combine,
    editDetails, editLogo, editLinks,
  };
})(typeof window !== 'undefined' ? window : globalThis);
