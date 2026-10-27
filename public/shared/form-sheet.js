// A form as a card of its own, not a dialog (Kevin, 23 Oct 2026: "too many
// moving parts on the dialogs with keyboards"). Below the wide layout it
// slides up from the foot and fills what the keyboard leaves; wide, it sits
// in the middle. Its bar is Cancel · title · the form's Delete (a bin) and Save, and the form
// scrolls under it and no further.
//
// Leaving asks in the bar itself: Cancel (or Close) turns into the ways out,
// say Save draft and Discard, and any other tap turns it back. A form with
// nothing to lose just goes.
//
// The editors (next/editing.js frame()) and the visitor's "Suggest edits"
// (suggest-dialog.js) both open one. Styles are next.css .form-sheet.
(function (root) {
  const TRASH = '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6m4-6v6"/><path d="m6 7 1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/></svg>';
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /**
   * Open a form card. `leave()` is the ways out, as buttons the bar's left
   * button becomes: [{ label, danger, run }], nothing to just close, or false
   * to stay put (it is busy). Left
   * out, a form a person has typed in offers Discard (when `guard`). `close`
   * label is what that button says ('Cancel', or '‹ ' and the form under it). The returned `body` is where
   * the form goes; its Save (`.form-actions .btn-save`, or `primary()`'s
   * button) is carried in the bar, and a `[data-frame-close]` in it is Cancel.
   */
  function open({ title, sub = '', cls = '', label = null, guard = true, leave = null, primary: findPrimary = null, onClose = null }) {
    // A form opened from another (an event's "Include other parishes") is a
    // card on top of that one, which steps back behind it, and its way back
    // names it: "‹ Edit event", so a person knows where they will land.
    const under = [...document.querySelectorAll('.form-sheet-back.open')].pop() || null;
    const underTitle = under ? (under.querySelector('.fs-title b') || {}).textContent || '' : '';
    if (!label) label = underTitle ? `‹ ${underTitle}` : 'Cancel';
    const back = document.createElement('div');
    back.className = `escalate-backdrop open form-sheet-back ${under ? 'fs-nested ' : ''}${cls}`;
    back.innerHTML = `
      <div class="escalate-modal form-modal form-sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="fs-bar">
          <div class="fs-left">
            <button class="fs-btn fs-cancel" type="button" data-frame-cancel>${esc(label)}</button>
            <span class="fs-ways" hidden></span>
          </div>
          <div class="fs-title"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
          <div class="fs-right">
            <button class="fs-btn fs-delete" type="button" data-frame-delete hidden>${TRASH}</button>
            <button class="fs-btn fs-primary" type="button" data-frame-primary hidden></button>
          </div>
        </div>
        <div class="frame-body"></div>
      </div>`;
    const sheet = back.querySelector('.form-sheet');
    const bar = back.querySelector('.fs-bar');
    const body = back.querySelector('.frame-body');
    const primary = back.querySelector('[data-frame-primary]');
    const delBtn = back.querySelector('[data-frame-delete]');
    const cancelBtn = back.querySelector('[data-frame-cancel]');
    const ways = back.querySelector('.fs-ways');
    let closed = false, dirty = false, asking = null, swallow = false;
    const top = () => {
      const all = [...document.querySelectorAll('.escalate-backdrop.open')];
      return all[all.length - 1] === back;
    };
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      unfit();
      watch.disconnect();
      back.classList.remove('in');
      const gone = () => {
        back.remove();
        // A form under this one keeps the page held still.
        if (!document.querySelector('.escalate-backdrop.open')) document.body.classList.remove('dialog-open');
      };
      back.classList.remove('open');
      if (under) under.classList.remove('fs-under');
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) gone(); else setTimeout(gone, 220);
      if (onClose) onClose();
    };

    // The ways out, in the bar, until something else is tapped.
    const waysOut = () => (leave ? leave() : guard && dirty
      ? [{ label: 'Discard', danger: true, run: close }] : null);
    const settle = () => {
      if (!asking) return;
      asking = null;
      bar.classList.remove('fs-asking');
      ways.hidden = true;
      ways.innerHTML = '';
      cancelBtn.hidden = false;
    };
    const ask = () => {
      sheet.style.transform = '';
      const list = waysOut();
      if (list === false) return; // not now: it is busy
      if (!list || !list.length) return close();
      asking = list;
      ways.innerHTML = list.map((w, i) =>
        `<button class="fs-btn fs-way${w.danger ? ' fs-danger' : ''}" type="button" data-way="${i}">${esc(w.label)}</button>`).join('');
      ways.hidden = false;
      cancelBtn.hidden = true;
      bar.classList.add('fs-asking');
      ways.querySelector('button').focus({ preventScroll: true });
    };
    const cancel = () => { if (!closed) (asking ? settle() : ask()); };
    ways.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-way]');
      if (!b || !asking) return;
      const w = asking[Number(b.dataset.way)];
      ways.querySelectorAll('button').forEach(x => { x.disabled = true; });
      const kept = await w.run();
      // A way that could not finish (the draft did not save) leaves the form open.
      if (!closed) { settle(); if (kept === false) return; }
    });
    // Any other tap is a no.
    back.addEventListener('pointerdown', (e) => {
      swallow = false;
      if (asking && !e.target.closest('.fs-ways')) { settle(); swallow = true; }
    }, true);

    // A person's typing or picking, not a field the form sets up itself.
    body.addEventListener('input', (e) => { if (e.isTrusted) dirty = true; });
    body.addEventListener('change', (e) => { if (e.isTrusted) dirty = true; });
    const onKey = (e) => {
      if (e.key !== 'Escape' || !top()) return;
      e.stopPropagation();
      if (asking) settle(); else cancel();
    };
    back.addEventListener('click', (e) => {
      // The tap that said no is not a Cancel as well.
      if (swallow) { swallow = false; return; }
      if (e.target === back || e.target.closest('[data-frame-cancel]')) return cancel();
      // A form's own Close or Cancel in its foot is the bar's Cancel.
      if (e.target.closest('[data-frame-close]')) return cancel();
    });

    // The form's Save, carried in the bar: the same button, pressed for it,
    // saying what it says (or its `data-fs-label`, when that is shorter).
    // Its Delete goes there too, as a red bin beside Save (Kevin, 27 Oct
    // 2026): a form has no foot.
    const hoisted = () => (findPrimary && findPrimary(body))
      || body.querySelector('.form-actions:not([hidden]) .btn-save:not([hidden])');
    const hoistedDel = () => body.querySelector('.form-actions:not([hidden]) .btn-danger:not([hidden])');
    const hoist = () => {
      const b = hoisted(), d = hoistedDel();
      body.querySelectorAll('.fs-hoisted').forEach(x => { if (x !== b && x !== d) x.classList.remove('fs-hoisted'); });
      delBtn.hidden = !d;
      if (d) {
        d.classList.add('fs-hoisted');
        const name = d.textContent.trim() || 'Delete';
        if (delBtn.getAttribute('aria-label') !== name) { delBtn.setAttribute('aria-label', name); delBtn.title = name; }
        delBtn.disabled = !!d.disabled;
      }
      primary.hidden = !b;
      if (!b) return;
      b.classList.add('fs-hoisted');
      const text = b.dataset.fsLabel || b.textContent.trim();
      if (primary.textContent !== text) primary.textContent = text;
      primary.disabled = !!b.disabled;
    };
    primary.addEventListener('click', () => { const b = hoisted(); if (b && !b.disabled) b.click(); });
    delBtn.addEventListener('click', () => { const d = hoistedDel(); if (d && !d.disabled) d.click(); });
    const watch = new MutationObserver(hoist);
    watch.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled'], characterData: true });

    // Pulled down by its bar, it goes, or asks first as Cancel does.
    let drag = null;
    bar.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1 || e.target.closest('button')) return;
      drag = { y: e.touches[0].clientY, dy: 0 };
      sheet.classList.add('dragging');
    }, { passive: true });
    bar.addEventListener('touchmove', (e) => {
      if (!drag) return;
      drag.dy = Math.max(0, e.touches[0].clientY - drag.y);
      sheet.style.transform = `translateY(${drag.dy}px)`;
      if (e.cancelable) e.preventDefault();
    }, { passive: false });
    const endDrag = () => {
      if (!drag) return;
      const far = drag.dy > 90;
      drag = null;
      sheet.classList.remove('dragging');
      sheet.style.transform = '';
      if (far) ask();
    };
    bar.addEventListener('touchend', endDrag);
    bar.addEventListener('touchcancel', endDrag);

    document.addEventListener('keydown', onKey);
    document.body.appendChild(back);
    if (under) under.classList.add('fs-under');
    document.body.classList.add('dialog-open');
    requestAnimationFrame(() => requestAnimationFrame(() => back.classList.add('in')));
    // With the keyboard up, iOS scrolls the page under anything fixed. So
    // the card keeps to the part of the screen the keyboard leaves, its bar
    // at the top of that, and the form scrolls inside it and no further.
    // Behind the keyboard (glass, on iOS 26) the card carries on down
    // (next.css .form-sheet-back::after), so the page never shows through or
    // in the moment before this catches up; the form gets room below its
    // end, and the field being typed in is brought up above the keyboard
    // (Kevin, 27 Oct 2026).
    const vv = root.visualViewport;
    const reveal = () => requestAnimationFrame(() => {
      const el = document.activeElement;
      if (!el || !body.contains(el) || !el.matches('input, textarea, select, [contenteditable]')) return;
      const r = el.getBoundingClientRect(), b = body.getBoundingClientRect(), room = 24;
      if (r.top < b.top + room || r.height > b.height - 2 * room) body.scrollTop -= b.top + room - r.top;
      else if (r.bottom > b.bottom - room) body.scrollTop += r.bottom - b.bottom + room;
    });
    const keyboardUp = () => document.documentElement.clientHeight - vv.height * vv.scale > 120;
    const fit = () => {
      back.style.top = `${vv.offsetTop}px`;
      back.style.height = `${vv.height}px`;
      back.style.bottom = 'auto';
      back.classList.toggle('fs-kb', keyboardUp());
    };
    // The keyboard coming up (or changing height), not a scroll: a person
    // scrolling the form to read it is not pulled back to the field.
    const refit = () => { fit(); if (keyboardUp()) reveal(); };
    if (vv) {
      vv.addEventListener('resize', refit); vv.addEventListener('scroll', fit); fit();
      body.addEventListener('focusin', () => { if (keyboardUp()) reveal(); });
    }
    const unfit = () => { if (vv) { vv.removeEventListener('resize', refit); vv.removeEventListener('scroll', fit); } };
    hoist();
    return {
      el: back,
      body,
      setTitle: (t) => { back.querySelector('.fs-title b').textContent = t; },
      close,
      get closed() { return closed; },
    };
  }

  /** A phone or tablet: a field focused for them would put the keyboard over the form. */
  const touchFirst = () => !!(root.matchMedia && root.matchMedia('(pointer: coarse)').matches);

  root.AgoraFormSheet = { open, touchFirst };
})(typeof globalThis !== 'undefined' ? globalThis : this);
