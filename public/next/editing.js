// Editing in /next: the signed-in half of the app (app.js), moved over a
// piece at a time.
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
//   parishes()   every parish
//   may(cap, id) the signed-in account's answer
//   rule(id)     a rule, and rules(id), a parish's
//   today()      'YYYY-MM-DD'
//   reload()     re-read the bundle fresh and repaint what is open
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
  function askChoice({ title, body = '', choices }) {
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
          <div class="form-actions"><button type="button" class="btn-outline" data-back>Back</button></div>
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
   * A dialog over the page: a heading, a close, and a body for a form to be
   * mounted in. Escape and a tap outside close it, unless a dialog opened
   * over it is the one on top. Returns { el, body, setTitle, close }.
   */
  function frame({ title, sub = '', cls = '', onClose = null }) {
    const back = document.createElement('div');
    back.className = `escalate-backdrop open ${cls}`;
    back.innerHTML = `
      <div class="escalate-modal form-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <button class="donate-close" type="button" aria-label="Close" data-frame-close>&times;</button>
        <h2>${esc(title)}</h2>
        ${sub ? `<div class="escalate-modal-sub">${esc(sub)}</div>` : ''}
        <div class="frame-body"></div>
      </div>`;
    let closed = false;
    const top = () => {
      const open = [...document.querySelectorAll('.escalate-backdrop.open')];
      return open[open.length - 1] === back;
    };
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      back.remove();
      document.body.classList.remove('dialog-open');
      if (onClose) onClose();
    };
    const onKey = (e) => { if (e.key === 'Escape' && top()) { e.stopPropagation(); close(); } };
    back.addEventListener('click', (e) => {
      if (e.target === back || e.target.closest('[data-frame-close]')) close();
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(back);
    document.body.classList.add('dialog-open');
    return {
      el: back,
      body: back.querySelector('.frame-body'),
      setTitle: (t) => { back.querySelector('h2').textContent = t; },
      close,
    };
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
    const ctx = { today: host.today(), weekAbOf: window.agoraBundle && window.agoraBundle.weekAbOf };
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
        <span class="sap-title">From a photo of the sign</span>
        <span class="sap-sub">The board out the front, or a printed timetable. Nothing is added until you say so.</span>
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
          if (up.error) host.toast(`Added, but not its poster: ${up.error}`);
        }
        d.f.close();
        await host.reload();
        host.toast(made && made.duplicate ? 'That service was already there' : 'Service added');
      } finally { btn.disabled = false; btn.textContent = 'Add service'; }
    });

    endedServices(parishId, d.form);
    const first = d.form.querySelector('[data-rf="title"]');
    if (first) first.focus({ preventScroll: true });
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

  /** A rule's pencil: its form, Save, Delete. */
  function editService(id) {
    const rule = host.rule(id);
    if (!rule || !RF() || !host.may('schedule.edit', rule.parish_id)) return;
    const parish = host.parish(rule.parish_id);
    const d = ruleDialog({
      title: 'Edit service',
      sub: [ruleName(rule), parish && parish.name].filter(Boolean).join(' · '),
      rule,
      parishId: rule.parish_id,
      actions: `<button class="btn-save" type="button" data-rf-save>Save</button>
        <button class="btn-outline" type="button" data-frame-close>Cancel</button>
        ${host.may('schedule.delete', rule.parish_id) ? '<button class="btn-danger" type="button" data-rf-delete>Delete</button>' : ''}`,
      // Outside Save, as the app's: it goes on as it is picked.
      posterNow: async (file) => {
        const r = await rulePoster(rule.id, file);
        if (!r.error) host.reload();
        return r;
      },
    });
    d.form.querySelector('[data-rf-save]').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      if (btn.disabled) return;
      btn.disabled = true;
      try {
        const body = await d.ready();
        if (!body || !(await keepByHand(rule.parish_id))) return;
        const res = await fetch(`/api/admin/schedules/${encodeURIComponent(rule.id)}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }).catch(() => null);
        if (!res || !res.ok) return d.fail(res ? await errorText(res) : 'It did not go through. Check the connection.');
        d.f.close();
        await host.reload();
        host.toast('Saved');
      } finally { btn.disabled = false; }
    });
    const del = d.form.querySelector('[data-rf-delete]');
    if (del) del.addEventListener('click', async () => {
      const go = await askChoice({
        title: `Delete ${rule.title}?`,
        body: '<p>Every date of it goes from the timetable. A service that has stopped can end instead: give it a last date.</p>',
        choices: [{ value: 'delete', label: 'Delete the service', danger: true }],
      });
      if (go !== 'delete' || !(await keepByHand(rule.parish_id))) return;
      const res = await fetch(`/api/admin/schedules/${encodeURIComponent(rule.id)}`, { method: 'DELETE' }).catch(() => null);
      if (!res || !res.ok) return d.fail(res ? await errorText(res) : 'It did not go through. Check the connection.');
      d.f.close();
      await host.reload();
      host.toast('Deleted');
    });
  }

  /**
   * A timetable line's pencil. A line can be several rules ("Mon–Fri 6pm
   * Vespers" is five), and each is edited on its own, so a line of more
   * than one asks which.
   */
  async function editLine(ids) {
    const rules = ids.map(id => host.rule(id)).filter(Boolean)
      .sort((a, b) => ((a.day_of_week + 6) % 7) - ((b.day_of_week + 6) % 7));
    if (rules.length === 1) return editService(rules[0].id);
    const pick = await askChoice({
      title: 'Which one?',
      choices: rules.map(r => ({ value: String(r.id), label: ruleName(r) })),
    });
    if (pick) editService(pick);
  }

  root.NextEdit = {
    init(h) { host = h; },
    askChoice, keepByHand, errorText, frame, addEvent, addService, editService, editLine,
  };
})(typeof window !== 'undefined' ? window : globalThis);
