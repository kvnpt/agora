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
//   openPoster(value, at)  the page's viewer, at picture `at` of a gallery
(function (root) {
  let host = null;
  /** A poster full size: the page's viewer (a gallery to swipe), or its first picture in a tab. */
  const viewPoster = (value, at = 0) => {
    if (host && host.openPoster) return host.openPoster(value, at);
    const P = root.AgoraPosters;
    window.open(P ? P.list(value)[at] || P.first(value) : value, '_blank', 'noopener');
  };
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
      // A poster at full size, in the page's viewer: a gallery to swipe.
      openPoster: (value, at) => viewPoster(value, at),
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
  // Edit (a date's "Edit series") on `schedule.edit` and Delete on `schedule.delete`, each at
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

  /**
   * What a poster upload sends: one picture as itself, raw, as ever; several
   * as a form, a `picture` each in the order chosen — a gallery to swipe
   * (shared/posters.js), never joined into one — each made the size the
   * editor stores a poster first (event-editor.js shrinkPoster). `files` is
   * a File or a list of them.
   */
  async function posterUpload(files) {
    const all = (Array.isArray(files) ? files : [files]).filter(Boolean);
    const max = (root.AgoraPosters && root.AgoraPosters.MAX) || 10;
    const pics = all.filter(f => /^image\//.test(f.type || '')).slice(0, max);
    if (pics.length <= 1) {
      const f = pics[0] || all[0];
      return { body: f, headers: { 'Content-Type': f.type || 'image/jpeg' } };
    }
    const shrink = root.AgoraEventEditor && root.AgoraEventEditor.shrinkPoster;
    const form = new FormData();
    for (let i = 0; i < pics.length; i++) {
      const b = shrink ? await shrink(pics[i]).catch(() => pics[i]) : pics[i];
      form.append('picture', b, pics[i].name || `picture-${i + 1}.jpg`);
    }
    return { body: form, headers: {} };
  }
  /** Too big to send as it is: one picture over the Worker's 8 MB (several are made smaller first). */
  const tooBig = (files) => {
    const all = (Array.isArray(files) ? files : [files]).filter(Boolean);
    return all.length === 1 && all[0].size > 8 * 1024 * 1024;
  };

  /** Upload (or, with no file, take off) a rule's own poster: one picture or several. */
  async function rulePoster(id, files) {
    const url = `/api/admin/schedules/${encodeURIComponent(id)}/poster`;
    const some = (Array.isArray(files) ? files : [files]).filter(Boolean);
    const res = await (some.length
      ? posterUpload(some).then(up => fetch(url, { method: 'POST', headers: up.headers, body: up.body }))
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
      openPoster: (value, at) => viewPoster(value, at),
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
    // Paste too, as the editor's own box has (readClipboardImage).
    const EE = root.AgoraEventEditor;
    const canPaste = !!(EE && EE.canReadClipboard());
    d.form.insertAdjacentHTML('afterbegin', `
      <div class="drop-box${canPaste ? ' can-paste' : ''}">
        <button type="button" class="sap-drop" data-sign>
          <span class="sap-title">Add an image</span>
          <span class="sap-sub">A photo of the board out the front, or a printed timetable. Nothing is added until you say so.</span>
        </button>
        ${canPaste ? EE.pastePillHTML('data-sign-paste') : ''}
      </div>
      <p class="paste-note" data-sign-note aria-live="polite" hidden></p>
      <input type="file" accept="image/*" multiple hidden data-sign-input>
      <div class="schedule-add-or">or type it in</div>`);
    const sign = d.form.querySelector('[data-sign-input]');
    const signNote = d.form.querySelector('[data-sign-note]');
    // One photo, or several of one board: a gallery, read as one.
    const fromSign = (files) => {
      const images = [].concat(files || []).filter(f => f && /^image\//.test(f.type || ''));
      if (!images.length) return;
      d.f.close();
      addEvent(parishId, { file: images, intent: 'timetable' });
    };
    d.form.querySelector('[data-sign]').addEventListener('click', () => { sign.value = ''; sign.click(); });
    sign.addEventListener('change', () => fromSign([...(sign.files || [])]));
    if (canPaste) d.form.querySelector('[data-sign-paste]').addEventListener('click', () => {
      signNote.hidden = true;
      // Straight from the tap, nothing awaited first: Safari's Paste bubble needs it.
      EE.readClipboardImage().then((r) => {
        if (!d.form.isConnected) return;   // closed while the bubble was up
        if (r.file) return fromSign(r.file);
        signNote.textContent = EE.pasteNote(r.error);
        signNote.hidden = !signNote.textContent;
      });
    });
    const drop = d.form.querySelector('[data-sign]');
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('is-dragging'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('is-dragging'));
    drop.addEventListener('drop', (e) => {
      e.preventDefault();
      drop.classList.remove('is-dragging');
      fromSign([...((e.dataTransfer && e.dataTransfer.files) || [])]);
    });

    const block = exceptionsBlock(d, { ids: [], parishId });
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
          const up = await rulePoster(made.id, file);   // one picture or several
          // A service on several days is a rule for each, and each shows it.
          for (const r of (made.rules || []).slice(1)) {
            if (up.error) break;
            await fetch(`/api/admin/schedules/${encodeURIComponent(r.id)}`, {
              method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ poster_path: up.poster_path }),
            }).catch(() => null);
          }
          if (up.error) host.toast(`Added, but not its poster: ${up.error}`);
        }
        // Its exceptions, now there is a rule to hang them on.
        if (block && made && !made.duplicate) {
          const bad = await block.write([], made.rules || [made]);
          if (bad) host.toast(`Added, but not its exceptions: ${bad}`);
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

  /** A rule's form: Save, Delete. */
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
      posterNow: async (files) => {
        const r = await rulePoster(first.id, files);
        if (!r.error && rules.length > 1) {
          const err = await patchEach(rules.slice(1), { poster_path: files ? r.poster_path : null });
          if (err) return { error: err };
        }
        if (!r.error) host.reload();
        return r;
      },
    });
    // What the form said when it opened: Save sends only what moved from it.
    const before = d.live.body();
    const block = exceptionsBlock(d, { ids: rules.map(r => r.id), parishId: first.parish_id });
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
        let fresh = [];
        if (Object.keys(changes).length) err = await patchEach(kept, changes);
        for (const m of moved) if (!err) err = await patchEach([m.r], { ...changes, day_of_week: m.day });
        if (!err && added.length) {
          const res = await fetch('/api/admin/schedules', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ parish_id: first.parish_id, ...body, days: added, poster_path: first.poster_path || null }),
          }).catch(() => null);
          if (!res || !res.ok) err = res ? await errorText(res) : 'It did not go through. Check the connection.';
          // A day ticked keeps the service's exceptions, so it stays the one line (block.write).
          else fresh = ((await res.json().catch(() => null)) || {}).rules || [];
        }
        const today = host.today();
        for (const r of gone) {
          if (err) break;
          if (r.effective_from && r.effective_from >= today) {
            const res = await fetch(`/api/admin/schedules/${encodeURIComponent(r.id)}`, { method: 'DELETE' }).catch(() => null);
            if (!res || !res.ok) err = res ? await errorText(res) : 'It did not go through. Check the connection.';
          } else err = await patchEach([r], { effective_to: dayBefore(today) });
        }
        // Its exceptions once the service is as the form says: the Worker checks each against it.
        if (!err && block) err = await block.write([...kept, ...moved.map(m => m.r)], fresh);
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
   * A timetable line's service, from a date's "Edit series" (or the
   * line itself, when it has no date to open). A line can be several rules
   * ("Mon–Fri 6pm Vespers" is five), edited together as the one service, or
   * one day of it on its own.
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

  // ── A service's exceptions ────────────────────────────────────────────
  //
  // Under Runs on the service's form: the weeks it is held otherwise ("Except
  // the last Sunday: English, until 11:30am", schedule_week_exceptions), then
  // its dates coming up that are (an override, a break). One list, because
  // to a person they are one idea (Kevin, 4 Nov 2026: "we're just collapsing
  // overrides and one-offs into the idea of exceptions").
  //
  // A weekly exception's card is part of the form it opens over: what it says
  // is the FORM's to save, with the rest of it. A service and its exceptions
  // are one panel, so "every week, but not the 1st" is written before the
  // form is saved — the card used to save on its own, against the service as
  // saved, which still ran on some weeks only and would not take the 1st
  // (Kevin, Mays Hill's Bible study, 4 Nov 2026). The form's Save writes the
  // service first and then them (write()), so the Worker checks each against
  // the service as it now is. A dated row is its date's own card, and saves
  // on its own, as it always has.
  //
  // The rules of a line share their exceptions (timetable-lines.js keys a
  // line on them), so a form for several days lists the first's, and writes
  // the same on each.

  const WX = 'data-wx';
  const WEEK_TAP = { first: '1st', second: '2nd', third: '3rd', fourth: '4th', last: 'Last' };
  const shortDay = (iso) => new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  // Every refresh of the bundle repaints the lists that are open.
  const afterReload = new Set();

  /** What a date's override makes of it, in a few words; null for a poster or a subtitle alone. */
  function overrideSummary(rule, o) {
    if (STATE[o.kind]) return STATE[o.kind];
    const parts = [];
    if (o.patch_title && o.patch_title !== rule.title) parts.push(o.patch_title);
    if (o.patch_languages) { try { parts.push(JSON.parse(o.patch_languages).join(', ')); } catch { /* skip */ } }
    if (o.patch_start_time && o.patch_start_time !== rule.start_time) parts.push(`at ${clock(o.patch_start_time)}`);
    if (o.patch_end_time && o.patch_end_time !== rule.end_time) parts.push(`until ${clock(o.patch_end_time)}`);
    if (o.patch_location_override || o.patch_location_parish_id || o.patch_location_lat != null) parts.push('somewhere else');
    if (o.patch_event_type && o.patch_event_type !== rule.event_type) parts.push('another kind');
    return parts.length ? parts.join(', ') : null;
  }

  /** Is `rule` ever held on the `week` of the month? Two years of its weekday is enough to say. */
  function everHeld(P, R, rule, week) {
    const r = { ...rule, effective_from: null, effective_to: null };
    const start = Date.parse(host.today() + 'T00:00:00Z');
    for (let i = 0; i < 731; i++) {
      const iso = new Date(start + i * 86400000).toISOString().slice(0, 10);
      if (P.isValidOccurrence(r, iso) && R.matchesWeekOfMonth(iso, week)) return true;
    }
    return false;
  }

  /**
   * The Exceptions block on a service's form (`ids` its rules; none for one
   * being added). Returns { write(existing, fresh) }: the form's Save calls it
   * once the service is written, with the rules it kept and the ones it made,
   * and gets an error or null.
   */
  function exceptionsBlock(d, { ids = [], parishId }) {
    const runs = d.form.querySelector('[data-cadence]');
    if (!runs || !RF().exceptionPatch) return null;
    runs.closest('.edit-row').insertAdjacentHTML('afterend',
      `<div class="edit-row rf-except" data-rf-except><label>Exceptions</label><div class="rf-except-list" data-rf-except-list></div></div>`);
    const list = d.form.querySelector('[data-rf-except-list]');
    const placeName = (pid) => (host.parish(pid) || {}).name || null;
    const savedRules = () => ids.map(id => host.rule(id)).filter(Boolean);

    /** The service as the form holds it now, saved or not. */
    const live = () => {
      const b = d.live.body();
      const saved = savedRules()[0] || {};
      return { ...saved, ...b, id: saved.id, parish_id: saved.parish_id || parishId,
        day_of_week: b.days.length ? b.days[0] : saved.day_of_week };
    };
    const daysOf = (r) => (r.days && r.days.length ? r.days : [r.day_of_week]);

    // Each exception as the form holds it: its saved row (`x`), the card's
    // body over it (`body`, unsaved), or `gone`.
    let entries = [];
    const sync = () => {
      const saved = (savedRules()[0] || {}).exceptions || [];
      const next = entries.filter(e => !e.x || saved.some(x => x.id === e.x.id))
        .map(e => (e.x ? { ...e, x: saved.find(x => x.id === e.x.id) } : e));
      for (const x of saved) if (!next.some(e => e.x && e.x.id === x.id)) next.push({ x, body: null, gone: false });
      entries = next;
    };
    const rowOf = (e, r) => (e.body ? RF().exceptionPatch(e.body, r) : e.x);
    const weeksOfEntry = (e, r) => String(rowOf(e, r).weeks).split(',').filter(Boolean);
    const unsaved = () => entries.some(e => e.body || (e.gone && e.x));

    const paint = () => {
      if (d.f.closed) { afterReload.delete(paint); return; }
      sync();
      const r = live();
      const days = daysOf(r);
      const shownEntries = entries.filter(e => !e.gone);
      const weekly = shownEntries.map(e => ({
        open: () => openCard(e), text: RF().exceptionSummary(r, rowOf(e, r), { days, placeName }),
      }));
      // Its dates coming up that somebody changed, a few: the date's own card says the rest.
      const today = host.today();
      const rules = savedRules();
      const raw = (root.agoraBundle && root.agoraBundle.raw) || {};
      const dated = (raw.overrides || [])
        .filter(o => ids.some(id => String(id) === String(o.schedule_id)) && o.occurrence_date >= today)
        .map(o => {
          const what = overrideSummary(rules.find(x => String(x.id) === String(o.schedule_id)) || r, o);
          return what && { date: o.occurrence_date, text: `${shortDay(o.occurrence_date)}: ${what}`,
            open: () => editEvent(`${o.schedule_id}:${o.occurrence_date}`) };
        })
        .filter(Boolean);
      const seen = new Set();
      for (const rule of rules) {
        for (const b of breaksOf(rule)) {
          if (b.to_date < today || seen.has(b.id)) continue;
          seen.add(b.id);
          const from = b.from_date > today ? b.from_date : today;
          dated.push({ date: from, text: `${shortDay(b.from_date)} – ${shortDay(b.to_date)}: on a break${b.note ? ` (${b.note})` : ''}`,
            open: () => editBreak(`${rule.id}:${from}`) });
        }
      }
      dated.sort((a, b) => a.date.localeCompare(b.date));
      const shown = dated.slice(0, 4);
      const rows = [...weekly, ...shown];
      const full = shownEntries.reduce((n, e) => n + weeksOfEntry(e, r).length, 0) >= RF().WEEKS_OF_MONTH.length;
      list.innerHTML = `${rows.map((x, i) =>
        `<button type="button" class="rf-except-row" data-rf-except-open="${i}"><span>${esc(x.text)}</span>${PENCIL}</button>`).join('')}
        ${dated.length > shown.length ? `<p class="edit-row-hint">And ${dated.length - shown.length} more ${dated.length - shown.length === 1 ? 'date' : 'dates'} after, on their own cards.</p>` : ''}
        ${full ? '' : `<button type="button" class="rf-btn rf-except-add" data-rf-except-add>+ Except…</button>`}
        ${unsaved() ? '<p class="edit-row-hint" data-rf-except-unsaved>Saved with the service.</p>'
          : rows.length ? '' : '<p class="edit-row-hint">Weeks of the month it is held otherwise, or not held. A single date is changed on its own card.</p>'}`;
      list.querySelectorAll('[data-rf-except-open]').forEach(b => b.addEventListener('click', () => rows[Number(b.dataset.rfExceptOpen)].open()));
      const add = list.querySelector('[data-rf-except-add]');
      if (add) add.addEventListener('click', () => openCard(null));
    };
    paint();
    afterReload.add(paint);
    // The days and how often it runs are the form's: the list says them as they stand.
    d.form.addEventListener('change', (e) => { if (!list.contains(e.target)) paint(); });

    /**
     * One exception's card, over the form: Which weeks, Held differently or
     * Not held, and the fields as it is held those weeks — a date's edit form
     * with weeks in place of the date. `entry` null is a new one. Done hands
     * it back to the form.
     */
    async function openCard(entry) {
      const [P, R] = await Promise.all([import('/shared/project.mjs'), import('/shared/recurrence.mjs')]);
      const r = live();
      const days = daysOf(r);
      const x = entry ? rowOf(entry, r) : null;
      const parish = host.parish(r.parish_id);
      // As it is held those weeks: the card's own body, else the saved row over the service.
      const b = entry && entry.body;
      const held = !x || x.kind !== 'modified' ? r : b ? {
        ...r, title: b.title || r.title, feast: b.feast || r.feast, start_time: b.start_time || r.start_time,
        end_time: b.end_time || r.end_time, description: b.description || r.description,
        languages: b.languages && b.languages.length ? JSON.stringify(b.languages) : r.languages,
        ...Object.fromEntries(VENUE.map(k => [k, b[k] == null ? null : b[k]])),
      } : P.withException(r, x);
      const notHeld = !!x && x.kind === 'not_held';
      const mine = x ? String(x.weeks).split(',') : [];
      // A week another exception has, or one the service (as the form has it) is never held on, cannot be picked.
      const taken = new Set(entries.filter(e => e !== entry && !e.gone).flatMap(e => weeksOfEntry(e, r)));
      const never = new Set(RF().WEEKS_OF_MONTH.filter(w => !mine.includes(w)
        && !days.every(day => everHeld(P, R, { ...r, day_of_week: day }, w))));
      const langs = (() => { try { return JSON.parse(held.languages || '[]'); } catch { return []; } })();
      const title = r.title || 'The service';
      const f = frame({ title: RF().exceptionTitle(mine, days), sub: [r.title, parish && parish.name].filter(Boolean).join(' · '), cls: 'rule-backdrop' });
      const a = (name) => `${WX}="${name}"`;
      const time = (name, value, extra) =>
        `<input type="hidden" ${a(name)} value="${esc(value || '')}" data-time-field data-tf-name="${name}"${extra}>`;
      f.body.innerHTML = `<div class="detail-edit-form wx-form">
          <div class="edit-row"><div class="edit-row-head"><label>Which</label>
            <button type="button" class="scope-pill wx-pill${notHeld ? ' on' : ''}" aria-pressed="${notHeld}" data-wx-pill>${notHeld ? 'Not held' : 'Held differently'}</button>
            <input type="checkbox" ${a('not_held')}${notHeld ? ' checked' : ''} hidden></div>
            <div class="rf-days wx-weeks" data-wx-weeks role="group" aria-label="Which weeks">
              ${RF().WEEKS_OF_MONTH.map(w => {
                const off = taken.has(w) || never.has(w);
                return `<label class="rf-day"${off ? ` title="${taken.has(w) ? 'It has an exception already' : `${esc(title)} is not held then`}"` : ''}><input type="checkbox" value="${w}"${mine.includes(w) ? ' checked' : ''}${off ? ' disabled' : ''}><span>${WEEK_TAP[w]}</span></label>`;
              }).join('')}
            </div>
            <div class="edit-row-hint" data-wx-hint></div>
          </div>
          <div data-wx-fields${notHeld ? ' hidden' : ''}>
            <div class="edit-row"><label>Title</label><input ${a('title')} value="${esc(held.title || '')}" autocomplete="off"></div>
            <div class="edit-row"><label>Subtitle</label><input ${a('feast')} value="${esc(held.feast || '')}" placeholder="Shown under the title those weeks (optional)" autocomplete="off"></div>
            <div class="edit-row edit-pair">
              <div><label>Starts</label>${time('start_time', held.start_time, ' data-tf-label="Starts"')}</div>
              <div><label>Ends</label>${time('end_time', held.end_time, ' data-tf-label="Ends" data-tf-optional data-tf-none="No end time" data-tf-near="start_time"')}</div>
            </div>
            ${isService(r.event_type) ? `<div class="edit-row"><label>Languages</label><input ${a('languages')} value="${esc(langs.join(', '))}" data-lang-picker data-lp-jurisdiction="${esc((parish && parish.jurisdiction) || '')}" autocomplete="off"></div>` : ''}
            <div class="edit-row"><label>Where</label>
              <div class="vp-mount" data-venue-mount></div>
              ${VENUE.map(k => `<input type="hidden" ${a(k)} value="${esc(held[k] == null ? '' : held[k])}">`).join('')}
            </div>
            <div class="edit-row"><label>Description</label><textarea ${a('description')} rows="2" placeholder="Shown those weeks (optional)">${esc(held.description || '')}</textarea></div>
          </div>
          <p class="rf-error" role="alert" hidden></p>
          <div class="form-actions">
            <button class="btn-save" type="button" data-wx-done>Done</button>
            <button class="btn-outline" type="button" data-frame-close>Cancel</button>
            ${entry ? '<button class="btn-danger" type="button" data-wx-delete>Remove exception</button>' : ''}
          </div>
        </div>`;
      const form = f.body.firstElementChild;
      const q = (name) => form.querySelector(`[${WX}="${name}"]`);
      const err = form.querySelector('.rf-error');
      const fail = (msg) => { err.textContent = msg; err.hidden = !msg; if (msg) err.scrollIntoView({ block: 'nearest' }); };
      const weeksBox = form.querySelector('[data-wx-weeks]');
      const picked = () => [...weeksBox.querySelectorAll('input:checked')].map(c => c.value);
      const hint = form.querySelector('[data-wx-hint]');
      const day = DAY_NAMES[days[0]];
      const repaint = () => {
        f.setTitle(RF().exceptionTitle(picked(), days));
        const p = picked();
        hint.textContent = p.includes('fourth') || p.includes('last')
          ? `In a month with four ${day}s, the 4th is the last as well.` : '';
        hint.hidden = !hint.textContent;
      };
      weeksBox.addEventListener('change', repaint);
      repaint();
      // Held differently, or not held: a pill at the end of Which's line, as Date's Single day is.
      const pill = form.querySelector('[data-wx-pill]');
      const box = q('not_held');
      pill.addEventListener('click', () => {
        box.checked = !box.checked;
        pill.classList.toggle('on', box.checked);
        pill.setAttribute('aria-pressed', String(box.checked));
        pill.textContent = box.checked ? 'Not held' : 'Held differently';
        form.querySelector('[data-wx-fields]').hidden = box.checked;
        box.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const mount = form.querySelector('[data-venue-mount]');
      if (mount && root.AgoraVenuePicker) {
        const value = {};
        for (const k of VENUE) value[k] = held[k] != null && held[k] !== '' ? held[k] : null;
        root.AgoraVenuePicker.mount(mount, {
          value, host: parish || { id: r.parish_id }, parishes: host.parishes(), geocode, pickPin,
          onChange: (v) => { for (const k of VENUE) q(k).value = v[k] == null ? '' : v[k]; },
        });
      }
      const handBack = () => { f.close(); paint(); d.f.markDirty(); };
      form.querySelector('[data-wx-done]').addEventListener('click', () => {
        fail('');
        if (root.AgoraTimeField && root.AgoraTimeField.commitAll && !root.AgoraTimeField.commitAll(form)) {
          return fail('One of the times is not a time. Pick one from the list, or type it like 6:30 pm.');
        }
        const v = { weeks: picked(), not_held: box.checked };
        form.querySelectorAll(`[${WX}]`).forEach(el => { const k = el.getAttribute(WX); if (k !== 'not_held') v[k] = el.value; });
        const body = RF().exceptionBody(v);
        if (!body.weeks.length) return fail('Which weeks? Tap at least one.');
        if (RF().exceptionEmpty(RF().exceptionPatch(body, live()))) {
          return fail('Nothing those weeks differs from the service. Change what is different, or choose Not held.');
        }
        if (entry) entry.body = body; else entries.push({ x: null, body, gone: false });
        handBack();
      });
      const del = form.querySelector('[data-wx-delete]');
      if (del) del.addEventListener('click', () => {
        if (entry.x) entry.gone = true; else entries = entries.filter(e => e !== entry);
        handBack();
      });
    }

    /** Write what the form holds: on the rules it kept (each one's own, by its weeks), and all of it on new ones. */
    async function write(existing, fresh = []) {
      const send = async (method, url, body) => {
        const res = await fetch(url, {
          method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
        }).catch(() => null);
        return !res ? 'It did not go through. Check the connection.' : res.ok ? null : await errorText(res);
      };
      const twin = (r, x) => (r.exceptions || []).find(y => y.weeks === x.weeks && y.kind === x.kind);
      // A new rule (a day ticked, a service added) gets them as they now stand.
      const standing = entries.filter(e => !e.gone).map(e => e.body || RF().exceptionCopy(e.x));
      // What went first, so a week given up is free for another; each done is dropped, so a retry does the rest.
      for (const e of [...entries.filter(e => e.gone && e.x), ...entries.filter(e => !e.gone && e.body)]) {
        for (const r of existing) {
          const t = e.x && twin(r, e.x);
          const bad = e.gone ? (t ? await send('DELETE', `/api/admin/week-exceptions/${encodeURIComponent(t.id)}`) : null)
            : t ? await send('PATCH', `/api/admin/week-exceptions/${encodeURIComponent(t.id)}`, e.body)
            : await send('POST', `/api/admin/schedules/${encodeURIComponent(r.id)}/exceptions`, e.body);
          if (bad) return bad;
        }
        if (e.gone || !e.x) entries = entries.filter(y => y !== e); else e.body = null;
      }
      for (const r of fresh) {
        for (const body of standing) {
          const bad = await send('POST', `/api/admin/schedules/${encodeURIComponent(r.id)}/exceptions`, body);
          if (bad) return bad;
        }
      }
      return null;
    }
    return { write, unsaved };
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
  function posterHTML(e, series, parish, face = null) {
    const has = !!e.poster_path;
    const P = root.AgoraPosters;
    const cover = P.first(e.poster_path);
    // The service's own poster shows here because this date has none; it is
    // the service's to change.
    const ruleOwn = has && !!e.rule_poster;
    // Shared: not the file this one's own upload writes, so taking it off
    // here leaves it on the others (worker/lib/poster-range.mjs). A
    // gallery's pictures are its own under the same name (`<id>.…`).
    const shared = has && !ruleOwn && !String(cover).startsWith(`/posters/${String(e.id).replace(':', '-')}.`);
    // Several pictures: the gallery, to swipe, each opening full size.
    const pictureHTML = (cls) => (P.isGallery(e.poster_path)
      ? P.galleryHTML(e.poster_path, { cls: `${cls}-gallery`, keep: false, link: false, picAttrs: () => `class="${cls}" data-evp-view` })
      : `<img class="${cls}" alt="The poster" src="${esc(cover)}" data-evp-view>`);
    const day = series ? series.date : (e._date || host.today());
    const [y, m] = day.split('-').map(Number);
    const monthEnd = `${day.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0')}`;
    const name = e.title || 'service like this';
    const DF = RF().dateFieldHTML;
    // As the card (Kevin, 20 Nov 2026): at its top where the poster is, a
    // low blank box to add one, or the poster with Replace (drawn as Add an
    // image, which it is) and Remove floated on its corner; a poster on
    // several dates asks which to take it off. Which dates it goes on is
    // asked in a menu as Add an image or Replace is tapped (wirePoster).
    const box = face ? (has ? `
      <div class="rf-poster cf-poster">
        ${pictureHTML('cf-poster-img')}
        <div class="cf-fabs">
          <button class="cf-fab" type="button" data-evp-pick aria-haspopup="menu" aria-label="${ruleOwn ? 'Put a different poster on this date' : 'Replace the poster'}" title="${ruleOwn ? 'A different one here' : 'Replace'}">${face.ICON.picture}</button>
          ${!ruleOwn ? `<button class="cf-fab cf-fab-danger" type="button" data-evp-clear="${shared ? 'ask' : ''}" aria-label="Remove the poster" title="Remove">${face.ICON.trash}</button>` : ''}
        </div>
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden data-evp-input>
      </div>` : `
      <div class="rf-poster cf-poster">
        <button class="cf-poster-blank" type="button" data-evp-pick aria-haspopup="menu">${face.ICON.picture}<span><b>Add an image</b><small>A poster or flyer for ${series ? 'this date' : 'this event'}</small></span></button>
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden data-evp-input>
      </div>`) : `
      <div class="rf-poster">
        <span class="rf-poster-pic pg-thumb"><img class="rf-poster-thumb" alt="The poster"${has ? ` src="${esc(cover)}"` : ' hidden'} data-evp-view>${has ? P.markHTML(e.poster_path) : ''}</span>
        <div class="rf-poster-actions">
          <button class="rf-btn" type="button" data-evp-pick>${PICTURE}<span>${has && !ruleOwn ? 'Replace' : 'Add an image'}</span></button>
          ${has && !ruleOwn ? `<button class="rf-btn danger" type="button" data-evp-clear>${shared ? 'Remove from this one' : 'Remove'}</button>` : ''}
          ${shared ? '<button class="rf-btn danger" type="button" data-evp-clear="everywhere">Remove everywhere</button>' : ''}
        </div>
        <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden data-evp-input>
      </div>`;
    const hint = ruleOwn ? `<div class="edit-row-hint">On every ${esc(name)}: the service’s own poster.
        ${series && host.may('schedule.edit', series.rule.parish_id) ? '<button type="button" class="ev-link" data-ev-series>Change it on the service</button>' : ''}</div>` : '';
    // A range picked from the menu: its days, then the picture.
    if (face) {
      return `${box}${hint}
      <div class="ev-poster-range cf-poster-range" data-evp-range hidden>
        <p data-evp-for></p>
        <div class="edit-pair">
          <div><label>From</label>${DF('from', `${day.slice(0, 7)}-01`, 'From', { attr: 'data-evp-date', required: true })}</div>
          <div><label>Until</label>${DF('until', monthEnd, 'Until', { attr: 'data-evp-date', required: true })}</div>
        </div>
        <div class="cf-poster-go">
          <button class="rf-btn" type="button" data-evp-go>${face.ICON.picture}<span>Choose the image</span></button>
          <button class="ev-link" type="button" data-evp-back>Not now</button>
        </div>
      </div>
      <div class="edit-row-hint" data-evp-status></div>`;
    }
    return `${box}${hint}
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
  function wirePoster(box, cur, { onSeries, face = null }) {
    // Where the card's menu said to put it ('' this one, 'series', 'rule', 'parish').
    let picked = '';
    const paint = (msg = '', bad = false) => {
      const e = host.event(cur);
      if (!e) return;
      picked = '';
      const parish = host.parish(e.parish_id);
      box.innerHTML = posterHTML(e, seriesOf(e.id), parish, face);
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
      const scope = face ? picked : box.querySelector('[data-evp-scope]').value;
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
      // Several chosen at once are one poster of several pictures: a gallery.
      const files = [...(ev.target.files || [])];
      if (!files.length) return;
      if (tooBig(files)) return say('That poster is over 8 MB, the most the Worker takes.', true);
      const r = range();
      say(files.length > 1 ? `Uploading ${files.length} pictures…` : 'Uploading…');
      if (r.series) {
        const up = await rulePoster(r.series, files);
        return up.error ? say(up.error, true) : after('Saved on the service. It shows on every date.');
      }
      const res = await posterUpload(files).then(up => fetch(`/api/admin/events/${encodeURIComponent(cur)}/poster${r.query}`, {
        method: 'POST', headers: up.headers, body: up.body,
      })).catch(() => null);
      if (!res || !res.ok) return say(res ? await errorText(res) : 'The poster did not go through. Check the connection.', true);
      const body = await res.json().catch(() => ({}));
      after(body.count > 1 ? `Saved on ${body.count} dates.` : 'Saved.');
    });
    box.addEventListener('click', async (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.matches('[data-ev-series]')) return onSeries();
      if (face && b.matches('[data-evp-pick]')) return putItOn(b);
      if (b.matches('[data-evp-back]')) { picked = ''; box.querySelector('[data-evp-range]').hidden = true; return say(''); }
      if (b.matches('[data-evp-pick], [data-evp-go]')) {
        // Said before the file picker opens, not after somebody has gone looking for the file.
        const r = range();
        if (r.error) return say(r.error, true);
        const input = box.querySelector('[data-evp-input]');
        input.value = '';
        return input.click();
      }
      if (b.matches('[data-evp-clear]')) {
        // The card's one bin, on a poster other dates show too: which.
        if (b.dataset.evpClear === 'ask') {
          const which = await askChoice({
            title: 'Take the poster off?',
            body: '<p>Other dates at this parish show this poster too.</p>',
            choices: [{ value: 'one', label: 'From this one', danger: true },
              { value: 'everywhere', label: 'From everything that shows it', danger: true }],
          });
          if (!which) return;
          say('Removing…');
          const res = await fetch(`/api/admin/events/${encodeURIComponent(cur)}/poster${which === 'everywhere' ? '?everywhere' : ''}`, { method: 'DELETE' }).catch(() => null);
          if (!res || !res.ok) return say(res ? await errorText(res) : 'That did not go through. Check the connection.', true);
          return after('Removed.');
        }
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
    // "Put it on", asked as Add an image or Replace is tapped (Kevin, 20 Nov
    // 2026), in place of a select under the poster: one date (or event), every
    // date of the service as its own, or a range, whose days come first. The
    // picker opens in the tap on the menu's row, which a phone requires.
    function putItOn(btn) {
      const e = host.event(cur);
      const series = seriesOf(cur);
      const parish = host.parish(e.parish_id);
      const name = e.title || 'service like this';
      const pickFile = () => { say(''); const input = box.querySelector('[data-evp-input]'); input.value = ''; input.click(); };
      const go = (v) => {
        picked = v;
        const rangeBox = box.querySelector('[data-evp-range]');
        if (!v || v === 'series') { rangeBox.hidden = true; return pickFile(); }
        rangeBox.querySelector('[data-evp-for]').textContent = v === 'rule'
          ? `On every ${name} in these days:` : `On everything at ${parish ? parish.name : 'the parish'} in these days:`;
        rangeBox.hidden = false;
        say('');
        requestAnimationFrame(() => rangeBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
      };
      face.menu(btn, [
        { head: e.poster_path && e.rule_poster ? 'Put a different one on' : 'Put it on' },
        { label: series ? 'This date only' : 'This event only', run: () => go('') },
        ...(series ? [
          { label: `Every ${name}`, sub: 'The service’s own: every date shows it', run: () => go('series') },
          { label: `Every ${name} from…`, sub: 'Between two dates', run: () => go('rule') },
        ] : []),
        { label: `Everything at ${parish ? parish.name : 'the parish'} from…`, sub: 'Between two dates', run: () => go('parish') },
      ]);
    }
    box.addEventListener('click', (ev) => {
      const img = ev.target.closest('[data-evp-view]');
      if (!img || !img.src) return;
      const e = host.event(cur);
      const at = img.closest('[data-poster-at]');
      viewPoster((e && e.poster_path) || img.src, at ? Number(at.dataset.posterAt) : 0);
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
      <div class="edit-row" data-cf-row="title"><label>Title</label><input ${f('title')} value="${esc(e.title || '')}" autocomplete="off"></div>
      <div class="edit-row" data-cf-row="feast"><label>Subtitle</label><input ${f('feast')} value="${esc(e.feast || '')}" placeholder="The saint or feast, or the topic (optional)" autocomplete="off"></div>
      <div class="edit-row" data-cf-row="description"><label>Description</label><textarea ${f('description')} rows="2" placeholder="Optional">${esc(e.description || '')}</textarea></div>
      ${RF().kindRowHTML('Kind', `<select ${f('event_type')} data-kind-picker="buttons">${kinds}</select>`, EV, !!e.parish_scoped)}
      ${parishes.length > 1 ? `<div class="edit-row" data-cf-row="parish"><label>Parish</label><div data-ev-parish></div><input type="hidden" ${f('parish_id')} value="${esc(e.parish_id)}"></div>` : ''}
      <div class="edit-row" data-cf-row="languages" data-ev-langrow${isService(e.event_type) ? '' : ' hidden'}><label>Languages</label><input ${f('languages')} value="${esc(langs.join(', '))}" data-lang-picker data-lp-jurisdiction="${esc((parish && parish.jurisdiction) || '')}" autocomplete="off"><p class="rf-error" data-ev-langerr role="alert" hidden></p></div>
      ${series ? '' : `<div class="edit-row" data-cf-row="date"><div class="edit-row-head"><label>Date</label>${RF().daysHTML(EV, multi)}</div>${DF('date', start.date, 'Pick a date', { attr: EV, required: true })}</div>`}
      <div class="edit-row edit-pair" data-cf-row="time">
        <div><label>Starts</label>${time('start_time', start.time, ' data-tf-label="Starts"')}</div>
        <div><label data-ev-endlabel>${multi ? 'Ends, last day' : 'Ends'}</label>${time('end_time', end ? end.time : '', ' data-tf-label="Ends" data-tf-optional data-tf-none="No end time" data-tf-near="start_time"')}</div>
      </div>
      ${series ? '' : `<div class="edit-row" data-cf-row="lastday" data-ev-lastday${multi ? '' : ' hidden'}><label>Last day</label>${DF('last', multi && end ? end.date : '', 'Pick the last day', { attr: EV, required: true })}</div>`}
      <div class="edit-row" data-cf-row="where"><label>Where</label>
        <div class="vp-mount" data-venue-mount></div>
        ${VENUE.map(k => `<input type="hidden" ${f(k)} value="${esc(e[k] == null ? '' : e[k])}">`).join('')}
      </div>
      <div class="edit-row" data-cf-row="poster"><label>Poster</label><div data-ev-poster></div></div>
      ${live ? `<div class="edit-row" data-cf-row="live">
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
          <button class="rf-btn" type="button" data-ev-tool="cancel" data-ev-status="${cancelled ? 'approved' : 'cancelled'}">${cancelled ? 'Uncancel event' : 'Cancel event'}</button>
          ${series && host.may('override.edit', series.rule.parish_id) ? `<button class="rf-btn" type="button" data-ev-break>${e.status === 'break' ? 'Edit the break' : 'Break…'}</button>` : ''}
          ${series ? `<button class="rf-btn" type="button" data-ev-tool="suppress" data-ev-status="${hidden ? 'approved' : 'hidden'}">${hidden ? 'Unsuppress' : 'Suppress'}</button>` : ''}
          ${series && e.status === 'combined' ? '' : '<button class="rf-btn" type="button" data-ev-combine>Include other parishes…</button>'}
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
    // The service, as its timetable line is: Mon–Fri Vespers offers its days
    // together or this one (the line's pencil did, until 19 Nov 2026).
    const toService = () => { f.close(); editLine(host.line ? host.line(series.rule.id) : [series.rule.id]); };
    form.querySelectorAll('.ev-series [data-ev-series]').forEach(b => b.addEventListener('click', toService));

    RF().wireDates(form, host.today());
    const multiBox = q('multi');
    RF().wireDays(form, multiBox);
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
        onChange: (v) => { for (const k of VENUE) q(k).value = v[k] == null ? '' : v[k]; f.markDirty(); },
      });
    }
    // Whose it is, from the one list every parish is chosen from (parish-picker.js).
    const whose = form.querySelector('[data-ev-parish]');
    if (whose) {
      root.AgoraParishPicker.field(whose, {
        parishes, value: e.parish_id, title: 'Choose the parish',
        origin: parish && parish.lat != null ? { lat: parish.lat, lng: parish.lng, label: parish.name } : null,
        first: parish && parish.jurisdiction,
        onChange: (id) => { q('parish_id').value = id; f.markDirty(); },
      });
    }
    wirePoster(form.querySelector('[data-ev-poster]'), e.id, { onSeries: toService, face: root.AgoraCardFace || null });

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
    // The form as the event's card, where card-face.js is loaded; the
    // fields stay the form, so Save reads them as it always has.
    if (root.AgoraCardFace) return editFace(form, { e, series, f, q, parish, state, cancelled, hidden, headless });
    const first = q('title');
    if (first && !touchFirst()) first.focus({ preventScroll: true });
  }

  // ── Edit event, as the event's card ────────────────────────────────────
  //
  // Kevin, 19 Nov 2026: "not a bunch of fields and buttons. Rather a WYSIWYG
  // event card", every part that can be changed dotted under (card-face.js).
  // Each part opens its field under it, or is typed where it stands (the
  // title, the subtitle, the words); the kind is a menu. What this date
  // changes of its service, and what is changed and not yet saved, is
  // violet; anything needed and not there, red; the rest grey.
  //
  // A date of a service: what the date is goes in a menu out of the date
  // (Kevin, 20 Nov 2026: "cancel, break, more should all just go into a menu
  // presented when tapping the date"): Edit series, Cancel, Break…, Suppress,
  // No live badge. It carries ⟳ after it, as part of it, and is violet while
  // one of those holds it (cancelled, on a break, suppressed, no live badge
  // where its service has one).
  //
  // A one-off (Kevin, the same night): its date opens the date's fields, as
  // any part does; Include other parishes and No live badge are at the foot
  // with whose event it is, the card's context; Cancel and Delete are a
  // neutral bin floating at the bottom, where the card's own toolbar is.

  const FACE_GROUPS = { title: ['title'], feast: ['feast'], description: ['description'], date: ['date', 'lastday'],
    time: ['time'], where: ['where'], languages: ['languages'] };
  const FACE_OF = { title: 'title', feast: 'feast', description: 'description', date: 'date',
    start_time: 'time', end_time: 'time', where: 'where', languages: 'languages' };

  function editFace(form, { e, series, f, q, parish, state, cancelled, hidden, headless }) {
    const F = root.AgoraCardFace;
    const T = root.AgoraEventTypes;
    const rule = series ? series.rule : null;
    const dark = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches;
    const may = (cap) => !!series && host.may(cap, series.rule.parish_id);
    const tool = (sel) => form.querySelector(`.ev-tools ${sel}`);
    form.classList.add('cf-card', 'is-face');
    const kindRow = q('event_type') && q('event_type').closest('.edit-row');
    if (kindRow) kindRow.dataset.cfRow = 'kind';

    const breakBtn = tool('[data-ev-break]');
    // The service it is a date of, for whoever may edit the service: the
    // date menu's Edit series presses the hidden box's own button.
    const seriesBtn = form.querySelector('.ev-series [data-ev-series]');
    form.insertAdjacentHTML('afterbegin', `
      <div class="cf-kind" data-f="kind">${state ? `<span class="ev-state ${esc(e.status)}">${esc(state)}</span>` : ''}<span class="cf-kslot"></span></div>
      <h2 class="cf-title" data-f="title"></h2>
      <p class="cf-sub" data-f="feast"></p>
      <div class="cf-fact" data-f="date">${F.ICON.cal}<span class="cf-fact-t"></span></div>
      <div class="cf-fact" data-f="time">${F.ICON.clock}<span class="cf-fact-t"></span></div>
      <div class="cf-fact" data-f="where">${F.ICON.where}<span class="cf-fact-t"></span></div>
      <div class="cf-fact" data-f="languages">${F.ICON.chat}<span class="cf-fact-t"></span></div>
      <div class="cf-desc" data-f="description"></div>
      <div class="cf-context" data-f="context"></div>`);
    const P = (name) => form.querySelector(`[data-f="${name}"]`);
    const rows = (name) => (FACE_GROUPS[name] || []).map(r => form.querySelector(`[data-cf-row="${r}"]`)).filter(Boolean);
    // Public / Parish only beside the kind's pill, where the card says it.
    const scope = form.querySelector('[data-scope-pill]');
    if (scope) P('kind').append(scope);

    // What it was when the form opened: a field changed from it is unsaved.
    const KEYS = ['title', 'feast', 'description', 'event_type', 'languages', 'date', 'last', 'multi', 'start_time', 'end_time', 'parish_scoped', 'hide_live', ...VENUE];
    const val = (k) => { const el = q(k); return !el ? '' : el.type === 'checkbox' ? el.checked : String(el.value == null ? '' : el.value).trim(); };
    const was = {};
    for (const k of KEYS) was[k] = val(k);
    const dirty = (...ks) => ks.some(k => val(k) !== was[k]);
    const s = (x) => (x == null ? '' : String(x).trim());
    const langsOf = (x) => { try { return (Array.isArray(x) ? x : JSON.parse(x || '[]')).map(String).sort().join(','); } catch { return String(x || '').split(',').map(t => t.trim()).filter(Boolean).sort().join(','); } };
    // What this date makes different from its service (violet while it does).
    const fromRule = (k) => {
      if (!rule) return false;
      if (k === 'title') return val('title') !== s(rule.title);
      if (k === 'feast') return !!val('feast') && val('feast') !== s(rule.feast);
      if (k === 'description') return !!val('description') && val('description') !== s(rule.description);
      if (k === 'event_type') return val('event_type') !== s(rule.event_type);
      if (k === 'start_time') return val('start_time') !== s(rule.start_time);
      if (k === 'end_time') return val('end_time') !== s(rule.end_time);
      if (k === 'where') return VENUE.some(v => s(val(v)) !== s(rule[v]));
      if (k === 'languages') return rule.languages != null && langsOf(val('languages')) !== langsOf(rule.languages);
      return false;
    };
    let open = null;
    // A date of a service held otherwise than it would be: what its menu sets.
    const altered = () => {
      const live = q('hide_live') ? q('hide_live').checked : false;
      return !!state || dirty('hide_live') || (rule ? live !== !!rule.hide_live : live);
    };

    function paintFace() {
      const kind = val('event_type');
      const service = isService(kind);
      const st = (o) => F.stateOf({ value: true, ...o });

      const col = T && kind ? T.kindColors(kind, dark()) : null;
      const kState = st({ changed: dirty('event_type') || fromRule('event_type') });
      F.draw(P('kind').querySelector('.cf-kslot'), `<button type="button" class="cf-kpill${col ? '' : ' cf-kpill-none'}${kState ? ` cf-${kState}` : ''}" data-face="event_type" data-key="event_type" aria-haspopup="menu"`
        + `${col ? ` style="--k-bg:${col.bg};--k-fg:${col.fg}"` : ''} aria-label="Kind: ${esc(kind ? T.eventTypeLabel(kind) : 'none')}. Tap to change.">`
        + `${esc(kind ? T.eventTypeLabel(kind) : 'Choose a kind')}${F.ICON.down}</button>`);

      const title = val('title');
      F.draw(P('title'), F.part('title', title || 'Add a title', st({ value: !!title, doubt: !title, changed: dirty('title') || fromRule('title') }), { empty: !title, label: 'Title' }));
      const feast = val('feast');
      F.draw(P('feast'), F.part('feast', feast || 'Add a subtitle', st({ value: !!feast, changed: dirty('feast') || fromRule('feast') }), { empty: !feast, label: 'Subtitle' }));

      // The date opens its menu (dateMenu). A date of a service is that
      // date, ⟳ after it; a one-off's is changed from the menu's first row.
      const thisYear = +host.today().slice(0, 4);
      const multi = !!val('multi');
      const date = series ? series.date : val('date');
      const day = F.dayText(date, multi ? val('last') : '', thisYear);
      F.draw(P('date').querySelector('.cf-fact-t'), series
        ? F.part('date', day, st({ changed: altered() }), { label: `Date, one of ${repeatsText(series.rule).replace(/^Repeats /, '')}`, after: `<span class="cf-rep">${F.ICON.repeat}</span>` })
        : F.part('date', day || 'Add a date', st({ value: !!day, doubt: !day || (multi && !(val('last') > date)), changed: dirty('date', 'last', 'multi') }), { empty: !day, label: 'Date' }));

      const a = val('start_time'), b = val('end_time');
      const usual = rule && (fromRule('start_time') || fromRule('end_time')) && rule.start_time
        ? `<span class="cf-was">usually <s>${esc(F.hm12(rule.start_time))}${rule.end_time ? ` – ${esc(F.hm12(rule.end_time))}` : ''}</s></span>` : '';
      const days = multi && !series && val('last') > date;
      F.draw(P('time').querySelector('.cf-fact-t'),
        F.part('start_time', a ? (days ? F.timeWithDay(a, date) : F.hm12(a)) : 'Add a start time', st({ value: !!a, doubt: !a, changed: dirty('start_time') || fromRule('start_time') }), { empty: !a, label: 'Starts' })
        + '<span class="cf-dash"> – </span>'
        + F.part('end_time', b ? (days ? F.timeWithDay(b, val('last')) : F.hm12(b)) : 'end', st({ value: !!b, doubt: days && !b, changed: dirty('end_time') || fromRule('end_time') }), { empty: !b, label: 'Ends' })
        + usual);

      const pid = val('location_parish_id');
      const at = pid && pid !== e.parish_id ? host.parish(pid) : null;
      const placed = val('location_override');
      const pinned = val('location_lat') !== '';
      const home = host.parish(val('parish_id') || e.parish_id) || parish;
      const whereText = at ? at.name || 'Another parish' : placed || (pinned ? 'A place of its own, by its pin' : (home && home.address) || 'At the parish');
      F.draw(P('where').querySelector('.cf-fact-t'), F.part('where', whereText, st({ changed: dirty(...VENUE) || fromRule('where') }), { label: 'Where', cls: at ? 'cf-strong' : '' })
        + (at && at.address ? `<small>${esc(at.address)}</small>` : ''));

      P('languages').hidden = !service;
      if (service) {
        const langs = val('languages');
        F.draw(P('languages').querySelector('.cf-fact-t'), F.part('languages', langs || 'No language',
          st({ value: !!langs, doubt: !series && !langs, changed: dirty('languages') || fromRule('languages') }), { empty: !langs, label: 'Languages' }));
      }

      const desc = val('description');
      P('description').classList.toggle('cf-desc-empty', !desc);
      F.draw(P('description'), F.part('description', desc || 'Add a description', st({ value: !!desc, changed: dirty('description') || fromRule('description') }), { empty: !desc, label: 'Description' }));

      // What is open: its fields under its line, or the words where they stand.
      for (const name of Object.keys(FACE_GROUPS)) {
        const on = name === open;
        const shown = rows(name).filter(r => !r.hidden);
        rows(name).forEach(r => r.classList.toggle('cf-on', on));
        shown.forEach((r, i) => r.classList.toggle('cf-last', on && i === shown.length - 1));
        if (P(name)) P(name).classList.toggle('is-open', on);
      }
      for (const name of ['title', 'feast', 'description']) P(name).classList.toggle('cf-off', open === name);
    }

    function openPart(key, btn) {
      if (key === 'event_type') return kindMenu(btn);
      if (key === 'date' && series) return dateMenu(btn);
      const g = FACE_OF[key];
      if (!g || (g === 'date' && series)) return;
      if (open === g) return closePart();
      open = g;
      paintFace();
      if (g === 'title' || g === 'feast' || g === 'description') {
        const inp = q(g);
        inp.focus({ preventScroll: true });
        try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch { /* no caret */ }
      }
      const last = rows(g).filter(r => !r.hidden).pop();
      if (last) requestAnimationFrame(() => last.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
    }
    function closePart() {
      if (!open) return;
      open = null;
      paintFace();
    }

    function kindMenu(btn) {
      if (!T) return;
      const sel = q('event_type'), box = q('parish_scoped');
      const scoped = !!(box && box.checked);
      F.menu(btn, T.EVENT_TYPES.map(k => {
        const c = T.kindColors(k, dark());
        const label = T.eventTypeLabel(k);
        return { label, value: k, on: sel.value === k,
          icon: `<span class="cf-roundel" style="--k-bg:${c.bg};--k-fg:${c.fg}">${esc(label.charAt(0))}</span>`,
          run: (v) => { sel.value = v; sel.dispatchEvent(new Event('change', { bubbles: true })); f.markDirty(); paintFace(); } };
      }).concat(box ? [
        { sep: true },
        { label: 'Public', sub: 'In the feed, for everyone', on: !scoped, run: () => { RF().scopeTo(box, false); f.markDirty(); } },
        { label: 'Parish only', sub: 'On its card, and for whoever starred the parish', on: scoped, run: () => { RF().scopeTo(box, true); f.markDirty(); } },
      ] : []));
    }

    // What a date of a service is, in one menu out of it: the service, then
    // what holds this date. Each row presses the hidden form's own button
    // (.ev-tools), so it asks and does what it always has.
    function dateMenu(btn) {
      const items = [];
      if (seriesBtn) items.push({ label: 'Edit series', sub: repeatsText(series.rule), icon: F.ICON.repeat, run: () => seriesBtn.click() }, { sep: true });
      const can = tool('[data-ev-tool="cancel"]');
      if (can) items.push(cancelled
        ? { label: 'Uncancel', sub: 'Back on, as usual', icon: F.ICON.undo, run: () => can.click() }
        : { label: 'Cancel this date', sub: 'Stays on show, struck through', icon: F.ICON.cancel, run: () => can.click() });
      if (breakBtn) items.push(e.status === 'break'
        ? { label: 'The break', sub: 'Change it, or lift it', icon: F.ICON.pause, run: () => breakBtn.click() }
        : { label: 'Break…', sub: 'Not on for a while', icon: F.ICON.pause, run: () => breakBtn.click() });
      const sup = tool('[data-ev-tool="suppress"]');
      if (sup) items.push(hidden
        ? { label: 'Unsuppress', sub: 'Back in the feed', icon: F.ICON.eye, run: () => sup.click() }
        : { label: 'Suppress this date', sub: 'Gone from the feed, not cancelled', icon: F.ICON.eyeoff, run: () => sup.click() });
      const live = q('hide_live');
      if (live) items.push({ label: 'No live badge', icon: F.ICON.live, toggle: live.checked,
        run: () => { live.checked = !live.checked; f.markDirty(); paintFace(); } });
      F.menu(btn, items);
    }

    // The foot is the card's context, where an event card has its calendar
    // feeds: the parishes it includes, for a one-off and for one date of a
    // service alike (Kevin, 20 Nov 2026: "Same with editing 1 event in a
    // series, there needs to be an option to include other parishes down the
    // bottom similarly"). A date held at another event that day has none:
    // that one says where everybody went.
    {
      const ctx = P('context');
      const comb = tool('[data-ev-combine]');
      const added = (e.combined_parishes || ((root.agoraBundle && root.agoraBundle.raw && root.agoraBundle.raw.event_parishes) || [])
        .filter(x => String(x.event_id) === String(e.id)).map(x => x.parish_id))
        .map(id => host.parish(id)).filter(p => p && p.id !== e.parish_id);
      if (comb) {
        F.draw(ctx, `<button type="button" class="pill-btn cf-include" data-cf-include>${F.ICON.plus}<span>Include other parishes…</span></button>`
          + (added.length ? `<p class="cf-taking">Taking part: ${added.map(p => esc(p.name)).join(', ')}</p>` : ''));
        ctx.addEventListener('click', (ev) => { if (ev.target.closest('[data-cf-include]')) comb.click(); });
      }
    }
    // A one-off's foot goes on: whose it is (the parish row, when there is a
    // choice), then No live badge; and its bin.
    if (!series) {
      const liveRow = form.querySelector('[data-cf-row="live"]');
      if (liveRow) liveRow.classList.add('cf-live');
      // The bin, floating at the bottom of the card where its toolbar is
      // (next.css .floatbar): neutral, and it asks which.
      const can = tool('[data-ev-tool="cancel"]');
      const del = tool('[data-ev-delete]');
      const sheet = form.closest('.form-sheet');
      if (sheet && (can || del)) {
        const bar = document.createElement('div');
        bar.className = 'cf-floatbar';
        bar.setAttribute('role', 'toolbar');
        bar.innerHTML = `<button type="button" aria-label="${del ? 'Cancel or delete' : 'Cancel'}" aria-haspopup="menu" title="${del ? 'Cancel or delete' : 'Cancel'}">${F.ICON.trash}</button>`;
        sheet.append(bar);
        sheet.classList.add('has-cf-floatbar');
        bar.firstElementChild.addEventListener('click', (ev) => {
          const items = [];
          if (can) items.push(cancelled
            ? { label: 'Uncancel', sub: 'Back on, as it was', icon: F.ICON.undo, run: () => can.click() }
            : { label: 'Cancel the event', sub: 'Stays on show, struck through', icon: F.ICON.cancel, run: () => can.click() });
          if (del) items.push({ label: 'Delete', sub: 'Gone for good', icon: F.ICON.trash, danger: true, run: () => del.click() });
          F.menu(ev.currentTarget, items);
        });
      }
    }

    form.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-face]');
      if (!b || !form.contains(b)) return;
      ev.preventDefault();
      openPart(b.dataset.face, b);
    });
    // Anything left open closes when somewhere else on the card is tapped:
    // on the click, so what was pressed under it has not moved by then.
    form.addEventListener('click', (ev) => {
      if (!open) return;
      const inside = rows(open).some(r => r.contains(ev.target)) || P(open).contains(ev.target);
      if (!inside) closePart();
    }, true);
    for (const k of ['title', 'feast']) {
      q(k).addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); closePart(); } });
    }
    form.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && open && !ev.defaultPrevented) { ev.stopPropagation(); closePart(); } });
    // Every field's change, and a place picked (the picker writes its hidden fields).
    form.addEventListener('input', paintFace);
    form.addEventListener('change', paintFace);
    form.addEventListener('click', () => setTimeout(paintFace, 0));
    paintFace();
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
  // every card, its parishes chosen from the one list (parish-picker.js) with
  // its "needs an owner". A tick that is not this person's to make becomes an
  // ask: their own part goes ahead, and an owner is asked for the rest.

  async function combine(id) {
    const e = host.event(id);
    const EE = root.AgoraEventEditor;
    if (!e || !EE || !host.may('event.edit', e.parish_id)) return;
    // One date of a service is a host too (migration 041): its parishes and
    // the other services' dates it stands in for, by the date's own id. It
    // stands in for services' dates only; an event that day is the event's
    // to combine into it.
    const series = seriesOf(id);
    const parish = host.parish(e.parish_id) || { id: e.parish_id, name: e.parish_name };
    const zone = e.timezone || parish.timezone || 'Australia/Sydney';
    const date = series ? series.date : (await tz()).localPartsOf(zone, Date.parse(e.start_utc)).date;
    const f = frame({ title: 'Include other parishes', sub: `${e.title} · ${longDate(date)}`, cls: 'combine-backdrop' });
    f.body.innerHTML = `<div class="detail-edit-form cb-form">
        <div class="ee-section-title">Also appears at</div>
        <div data-list="also"></div>
        <div class="ee-section-title">In place of their own services that day</div>
        <div class="ee-list" data-list="replaces"><div class="ee-empty">Loading…</div></div>
        <div class="edit-row-hint">Whatever is ticked here stops being its own card and shows as a tombstone pointing at this ${series ? 'date' : 'event'}: nothing disappears.</div>
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

    const also = new Set();
    const replaces = new Set();
    let candidates = null;
    let refused = false;
    const zoneOf = (pid) => (host.parish(pid) || {}).timezone || zone;

    // The parishes, as chips, chosen from the one list every parish is
    // chosen from (parish-picker.js): every parish, this one in and staying
    // in, and one that is not this person's to write marked.
    let alsoField = null;
    const paintAlso = () => {
      const o = {
        multiple: true, title: 'Add parishes', add: 'Add parishes',
        parishes: host.parishes().filter(p => p.id !== '_unassigned'),
        value: [...also], fixed: [parish.id], fixedTag: 'own',
        origin: parish.lat != null ? { lat: parish.lat, lng: parish.lng, label: parish.name } : null,
        first: parish.jurisdiction,
        tagOf: (p) => (host.may('event.edit', p.id) ? '' : 'needs an owner'),
        onChange: (ids) => {
          also.clear();
          for (const id of ids) also.add(id);
          f.markDirty();
          paintReplaces();
          paintAsk();
        },
      };
      if (alsoField) alsoField.update(o);
      else alsoField = root.AgoraParishPicker.field(alsoBox, o);
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

    replBox.addEventListener('change', (ev) => {
      const cb = ev.target;
      if (cb.checked) replaces.add(cb.value); else replaces.delete(cb.value);
      paintAsk();
    });
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
    const standIn = (c) => !series || /:/.test(String(c.id));
    candidates = [...cands.filter(standIn), ...(current.replaced_events || []).filter(c => !ids.has(String(c.id)))];
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

  /**
   * Where a pasted Google Maps link puts the place, when the link says.
   *
   * A place link carries the place itself as `!3d<lat>!4d<lng>`; a pin link
   * carries it as `?q=<lat>,<lng>` (or query=, ll=). `@<lat>,<lng>` is only
   * where the map was looking, often beside the place to clear the side panel,
   * so it is not read. A short link (maps.app.goo.gl) or a `?cid=` link says
   * nothing until Google is asked, so those answer null and the pin stays put.
   */
  function mapsLinkCoords(link) {
    let text = String(link || '');
    try { text = decodeURIComponent(text); } catch { /* keep it as typed */ }
    const num = '(-?\\d{1,3}(?:\\.\\d+)?)';
    const found = text.match(new RegExp(`!3d${num}!4d${num}`))
      || text.match(new RegExp(`[?&](?:q|query|ll)=${num},\\s*${num}(?:[&#]|$)`));
    if (!found) return null;
    const lat = Number(found[1]), lng = Number(found[2]);
    if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
    return { lat, lng };
  }

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

    // The pin. Nothing here writes: a pin located, placed, or taken from the
    // Google Maps place is kept in the dialog until Save, which sends it as
    // lat/lng (the route re-geocodes only an address that changed and came
    // without them).
    let pin = null;
    const pinBox = form.querySelector('[data-pd-pin]');
    const pinFrom = (x) => (x.from === 'maps' ? 'from Google Maps' : x.manual ? 'placed by hand' : 'from the address');
    const paintPin = (problem = '') => {
      const now = host.parish(pid) || p;
      pinBox.innerHTML = problem ? `<span class="bad">${esc(problem)}</span>`
        : pin ? `<span class="staged">New pin: ${coord(pin.lat)}, ${coord(pin.lng)}</span>, ${pinFrom(pin)}. Save to keep it.`
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
    //
    // A place chosen also moves the pin to it (Kevin, 2 Nov 2026: /sjf kept a
    // pin 2 km from its church after its place was picked). Google's place is
    // where somebody stood and dropped it; the address's geocode is a guess at
    // the street. So the place's own coordinates are staged as the pin, and
    // the Directions button and the dot on the map agree.
    const mapsNow = form.querySelector('[data-pd-maps-now]');
    const usePin = form.querySelector('[data-pd-usepin]');
    const paintMaps = (text) => {
      mapsNow.textContent = text || (q('maps_url').value.trim() ? 'A place on Google Maps.' : 'The pin, from the address.');
      usePin.hidden = !q('maps_url').value.trim();
    };
    paintMaps();
    // A pin taken from a place no longer stands once that place is cleared or replaced.
    const pinFromPlace = (c) => {
      if (c) pin = { lat: c.lat, lng: c.lng, manual: true, from: 'maps' };
      else if (pin && pin.from === 'maps') pin = null;
      paintPin();
    };
    q('maps_url').addEventListener('input', () => {
      const link = q('maps_url').value.trim();
      form.querySelectorAll('.pd-result').forEach(x => x.classList.remove('chosen'));
      const c = mapsLinkCoords(link);
      pinFromPlace(c);
      paintMaps(link ? (c ? 'This link. The pin moves there too. Save to keep it.' : 'This link. Save to keep it.') : '');
    });
    usePin.addEventListener('click', () => {
      q('maps_url').value = '';
      form.querySelectorAll('.pd-result').forEach(x => x.classList.remove('chosen'));
      pinFromPlace(null);
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
        const at = pl.lat != null && pl.lng != null && isFinite(pl.lat) && isFinite(pl.lng) ? { lat: Number(pl.lat), lng: Number(pl.lng) } : null;
        pinFromPlace(at);
        paintMaps(`Chosen: ${pl.name}${pl.address ? `, ${pl.address}` : ''}.${at ? ' The pin moves there too.' : ''} Save to keep it.`);
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
    init(h) {
      // A re-read repaints the forms open on what it read: a service's
      // Exceptions, after a card over it saved one.
      host = { ...h, reload: async (...args) => {
        const out = await h.reload(...args);
        for (const paint of [...afterReload]) { try { paint(); } catch (err) { console.error(err); } }
        return out;
      } };
    },
    askChoice, keepByHand, errorText, frame, pickPin, addEvent, addService, editService, editLine, editEvent, editBreak, combine,
    editDetails, editLogo, editLinks,
  };
})(typeof window !== 'undefined' ? window : globalThis);
