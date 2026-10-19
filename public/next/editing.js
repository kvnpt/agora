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
  function frame({ title, cls = '', onClose = null }) {
    const back = document.createElement('div');
    back.className = `escalate-backdrop open ${cls}`;
    back.innerHTML = `
      <div class="escalate-modal form-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <button class="donate-close" type="button" aria-label="Close" data-frame-close>&times;</button>
        <h2>${esc(title)}</h2>
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

  root.NextEdit = {
    init(h) { host = h; },
    askChoice, keepByHand, errorText, frame, addEvent,
  };
})(typeof window !== 'undefined' ? window : globalThis);
