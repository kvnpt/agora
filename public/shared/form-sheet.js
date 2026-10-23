// A form as a card of its own, not a dialog (Kevin, 23 Oct 2026: "too many
// moving parts on the dialogs with keyboards"). Below the wide layout it
// slides up from the foot and fills what the keyboard leaves; wide, it sits
// in the middle. Its bar is Cancel · title · the form's Save, and the form
// scrolls under it and no further.
//
// Leaving asks in the bar itself: Cancel (or Close) turns into the ways out,
// say Save draft and Discard, and any other tap turns it back. A form with
// nothing to lose just goes.
//
// The editors (next/editing.js frame()) and the visitor's "Suggest edits"
// (suggest-dialog.js) both open one. Styles are next.css .form-sheet.
(function (root) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /**
   * Open a form card. `leave()` is the ways out, as buttons the bar's left
   * button becomes: [{ label, danger, run }], nothing to just close, or false
   * to stay put (it is busy). Left
   * out, a form a person has typed in offers Discard (when `guard`). `close`
   * label is what that button says ('Cancel'). The returned `body` is where
   * the form goes; its Save (`.form-actions .btn-save`, or `primary()`'s
   * button) is carried in the bar, and a `[data-frame-close]` in it is Cancel.
   */
  function open({ title, sub = '', cls = '', label = 'Cancel', guard = true, leave = null, primary: findPrimary = null, onClose = null }) {
    const back = document.createElement('div');
    back.className = `escalate-backdrop open form-sheet-back ${cls}`;
    back.innerHTML = `
      <div class="escalate-modal form-modal form-sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="fs-bar">
          <div class="fs-left">
            <button class="fs-btn fs-cancel" type="button" data-frame-cancel>${esc(label)}</button>
            <span class="fs-ways" hidden></span>
          </div>
          <div class="fs-title"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
          <button class="fs-btn fs-primary" type="button" data-frame-primary hidden></button>
        </div>
        <div class="frame-body"></div>
      </div>`;
    const sheet = back.querySelector('.form-sheet');
    const bar = back.querySelector('.fs-bar');
    const body = back.querySelector('.frame-body');
    const primary = back.querySelector('[data-frame-primary]');
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
    const hoisted = () => (findPrimary && findPrimary(body))
      || body.querySelector('.form-actions:not([hidden]) .btn-save:not([hidden])');
    const hoist = () => {
      const b = hoisted();
      body.querySelectorAll('.fs-hoisted').forEach(x => { if (x !== b) x.classList.remove('fs-hoisted'); });
      primary.hidden = !b;
      if (!b) return;
      b.classList.add('fs-hoisted');
      const text = b.dataset.fsLabel || b.textContent.trim();
      if (primary.textContent !== text) primary.textContent = text;
      primary.disabled = !!b.disabled;
    };
    primary.addEventListener('click', () => { const b = hoisted(); if (b && !b.disabled) b.click(); });
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
    document.body.classList.add('dialog-open');
    requestAnimationFrame(() => requestAnimationFrame(() => back.classList.add('in')));
    // With the keyboard up, iOS scrolls the page under anything fixed. So
    // the card keeps to the part of the screen the keyboard leaves, its bar
    // at the top of that, and the form scrolls inside it and no further.
    const vv = root.visualViewport;
    const fit = () => {
      back.style.top = `${vv.offsetTop}px`;
      back.style.height = `${vv.height}px`;
      back.style.bottom = 'auto';
    };
    if (vv) { vv.addEventListener('resize', fit); vv.addEventListener('scroll', fit); fit(); }
    const unfit = () => { if (vv) { vv.removeEventListener('resize', fit); vv.removeEventListener('scroll', fit); } };
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
