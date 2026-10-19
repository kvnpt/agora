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
          <button class="rf-btn" type="button" data-evp-pick>${PICTURE}<span>${has && !ruleOwn ? 'Replace' : 'Add a poster'}</span></button>
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
      ${series ? `<div class="edit-row"><label>Commemoration</label><input ${f('feast')} value="${esc(e.feast || '')}" placeholder="St Luke the Evangelist (optional)" autocomplete="off"></div>` : ''}
      <div class="edit-row"><label>Description</label><textarea ${f('description')} rows="2" placeholder="Optional">${esc(e.description || '')}</textarea></div>
      <div class="edit-row${parishes.length > 1 ? ' edit-pair' : ''}">
        <div><label>Kind</label><select ${f('event_type')} data-kind-picker>${kinds}</select></div>
        ${parishes.length > 1 ? `<div><label>Parish</label><select ${f('parish_id')}>${parishes.map(p =>
          `<option value="${esc(p.id)}"${p.id === e.parish_id ? ' selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>` : ''}
      </div>
      <div class="edit-row"><label>Languages</label><input ${f('languages')} value="${esc(langs.join(', '))}" placeholder="English, Arabic" autocomplete="off"></div>
      ${series ? '' : `<div class="edit-row"><label>Date</label>${DF('date', start.date, 'Pick a date', { attr: EV, required: true })}</div>`}
      <div class="edit-row edit-pair">
        <div><label>Starts</label>${time('start_time', start.time, ' data-tf-label="Starts"')}</div>
        <div><label data-ev-endlabel>${multi ? 'Ends, last day' : 'Ends'}</label>${time('end_time', end ? end.time : '', ' data-tf-label="Ends" data-tf-optional data-tf-none="No end time" data-tf-near="start_time"')}</div>
      </div>
      ${series ? '' : `<div class="edit-row edit-checks"><label class="edit-check"><input type="checkbox" ${f('multi')}${multi ? ' checked' : ''}> Over several days</label></div>
      <div class="edit-row" data-ev-lastday${multi ? '' : ' hidden'}><label>Last day</label>${DF('last', multi && end ? end.date : '', 'Pick the last day', { attr: EV, required: true })}</div>`}
      <div class="edit-row"><label>Where</label>
        <div class="vp-mount" data-venue-mount></div>
        ${VENUE.map(k => `<input type="hidden" ${f(k)} value="${esc(e[k] == null ? '' : e[k])}">`).join('')}
      </div>
      <div class="edit-row"><label>Poster</label><div data-ev-poster></div></div>
      <div class="edit-row edit-checks">
        ${live ? `<label class="edit-check"><input type="checkbox" ${f('hide_live')}${e.hide_live ? ' checked' : ''}> No live badge</label>` : ''}
        <label class="edit-check"><input type="checkbox" ${f('parish_scoped')}${e.parish_scoped ? ' checked' : ''}> Parish only</label>
      </div>`;
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
          <button class="rf-btn" type="button" data-ev-status="${cancelled ? 'approved' : 'cancelled'}">${cancelled ? 'Uncancel' : 'Cancel'}</button>
          ${series ? `<button class="rf-btn" type="button" data-ev-status="${hidden ? 'approved' : 'hidden'}">${hidden ? 'Unsuppress' : 'Suppress'}</button>` : ''}
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
    q('event_type').addEventListener('change', () => { if (q('event_type').value === 'other') q('parish_scoped').checked = true; });
    const mount = form.querySelector('[data-venue-mount]');
    if (mount && root.AgoraVenuePicker) {
      const value = {};
      for (const k of VENUE) value[k] = e[k] != null && e[k] !== '' ? e[k] : null;
      root.AgoraVenuePicker.mount(mount, {
        value, host: parish || { id: e.parish_id }, parishes: host.parishes(), geocode,
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
      const langs = String(v('languages') || '').split(',').map(s => s.trim()).filter(Boolean);
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
      if (series) body.feast = v('feast') || null;
      else body.parish_id = pid;

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
    if (first) first.focus({ preventScroll: true });
  }

  root.NextEdit = {
    init(h) { host = h; },
    askChoice, keepByHand, errorText, frame, addEvent, addService, editService, editLine, editEvent,
  };
})(typeof window !== 'undefined' ? window : globalThis);
