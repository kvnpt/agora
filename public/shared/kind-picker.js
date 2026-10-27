// The kind of an event or a rule — Liturgy, Prayer, Feast, Talk, Youth,
// Social, Other — picked from a list in the page, each kind in its own colours
// as the feed shows them, instead of the system's select sheet.
//
// It DRESSES a real <select data-kind-picker> rather than replacing it. The
// select stays in the form, hidden, holding the value: every reader of
// `.value`, every `change` listener and every form that collects it keeps
// working untouched, and the picker only ever does what a person choosing
// from the select would — set the value and fire `input` and `change`. Code
// that sets `.value` itself (a poster read filling a card) is followed too.
//
// `data-kind-picker="buttons"` lays every kind out as a button to tap instead
// of a list to open (Kevin, 26 Oct 2026: "just a list of buttons to tap"), the
// way the rule form's days are. /admin keeps the list: it dresses a picker in
// every one of a hundred rule rows.
//
// Any select carrying the attribute is dressed as it appears — the forms are
// rebuilt often (a refresh, a poster landing) and none of them has to call
// anything. Colours from public/shared/event-types.js, so /admin, which has
// no app.css, gets them as well.
(function (root) {
  if (typeof document === 'undefined') return;
  const SEL = 'select[data-kind-picker]';
  const dark = () => !!(root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches);
  const kinds = () => root.AgoraEventTypes || { kindColors: () => ({ bg: '#e8e8e8', fg: '#555' }), eventTypeLabel: (x) => x };
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  /** One kind as a chip in its colours: the initial in a dot, then the name. */
  function chipHTML(value, label) {
    const { bg, fg } = kinds().kindColors(value, dark());
    return `<span class="kp-chip" style="background:${bg};color:${fg}"><span class="kp-dot" style="background:${fg};color:${bg}">${esc(String(label || value).trim()[0] || '?').toUpperCase()}</span>${esc(label)}</span>`;
  }

  const labelOf = (opt) => (opt.value ? kinds().eventTypeLabel(opt.value) : opt.textContent);

  /** The buttons form: every kind on show, the one picked in its colours. */
  function dressButtons(select) {
    const layout = [...select.classList];
    select.classList.add('kp-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    const wrap = document.createElement('div');
    wrap.className = ['kp-row', ...layout].join(' ');
    wrap.setAttribute('role', 'radiogroup');
    const named = select.id && document.querySelector(`label[for="${CSS.escape(select.id)}"]`);
    if (named) wrap.setAttribute('aria-label', named.textContent.trim());
    select.after(wrap);
    const render = () => {
      wrap.innerHTML = [...select.options].filter(o => o.value && !o.disabled).map((o) => {
        const on = o.value === select.value;
        const { bg, fg } = kinds().kindColors(o.value, dark());
        const label = labelOf(o);
        return `<button type="button" class="kp-tap${on ? ' on' : ''}" role="radio" aria-checked="${on}" data-kp-value="${esc(o.value)}"${on ? ` style="background:${bg};color:${fg};border-color:${fg}"` : ''}><span class="kp-dot" style="background:${fg};color:${bg}">${esc(String(label).trim()[0] || '?').toUpperCase()}</span>${esc(label)}</button>`;
      }).join('');
    };
    const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() { return proto.get.call(this); },
      set(v) { proto.set.call(this, v); render(); },
    });
    select.addEventListener('change', render);
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('[data-kp-value]');
      if (!b || b.dataset.kpValue === select.value) return;
      proto.set.call(select, b.dataset.kpValue);
      select.dispatchEvent(new Event('input', { bubbles: true }));
      select.dispatchEvent(new Event('change', { bubbles: true }));
      render();
      wrap.querySelector(`[data-kp-value="${CSS.escape(b.dataset.kpValue)}"]`)?.focus({ preventScroll: true });
    });
    wrap._kpRender = render;
    render();
  }

  function dress(select) {
    if (!select || select.dataset.kpDressed) return;
    if (select.dataset.kindPicker === 'buttons') { select.dataset.kpDressed = '1'; return dressButtons(select); }
    select.dataset.kpDressed = '1';
    // The wrapper takes the select's place in its grid, so it takes its
    // layout classes too (.sef-full spans the row).
    const layout = [...select.classList];
    select.classList.add('kp-native');
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');

    const wrap = document.createElement('div');
    wrap.className = ['kp', ...layout].join(' ');
    wrap.innerHTML = `<button type="button" class="kp-btn" aria-haspopup="listbox" aria-expanded="false"></button>
      <div class="kp-list" role="listbox" hidden></div>`;
    select.after(wrap);
    const btn = wrap.querySelector('.kp-btn');
    const list = wrap.querySelector('.kp-list');
    // The field's own label names the button too.
    const named = select.id && document.querySelector(`label[for="${CSS.escape(select.id)}"]`);
    if (named) btn.setAttribute('aria-label', named.textContent.trim());

    // The button always; the list only while it is open — /admin dresses a
    // picker in every one of its hundred rule rows, and nobody opens them all.
    const render = () => {
      const opt = select.options[select.selectedIndex];
      btn.innerHTML = opt && opt.value
        ? chipHTML(opt.value, labelOf(opt))
        : `<span class="kp-placeholder">${esc(opt ? opt.textContent : 'Choose a kind')}</span>`;
      if (!list.hidden) renderList();
    };
    const renderList = () => {
      list.innerHTML = [...select.options].filter(o => o.value && !o.disabled).map(o =>
        `<button type="button" class="kp-item${o.value === select.value ? ' on' : ''}" role="option" aria-selected="${o.value === select.value}" data-kp-value="${esc(o.value)}">${chipHTML(o.value, labelOf(o))}</button>`
      ).join('');
    };

    // Code that sets .value directly fires no event; follow it anyway.
    const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
    Object.defineProperty(select, 'value', {
      configurable: true,
      get() { return proto.get.call(this); },
      set(v) { proto.set.call(this, v); render(); },
    });
    select.addEventListener('change', render);

    const open = (focusOn) => {
      list.hidden = false;
      render();
      btn.setAttribute('aria-expanded', 'true');
      wrap.classList.add('open');
      // Up rather than down when the field is near the bottom of the screen.
      const r = btn.getBoundingClientRect();
      wrap.classList.toggle('kp-up', r.bottom + list.offsetHeight + 8 > root.innerHeight && r.top > list.offsetHeight + 8);
      const items = [...list.querySelectorAll('.kp-item')];
      (items.find(i => i.classList.contains('on')) || items[focusOn === 'last' ? items.length - 1 : 0])?.focus({ preventScroll: true });
    };
    const close = (refocus) => {
      if (list.hidden) return;
      list.hidden = true;
      list.innerHTML = '';
      btn.setAttribute('aria-expanded', 'false');
      wrap.classList.remove('open', 'kp-up');
      if (refocus) btn.focus({ preventScroll: true });
    };
    const choose = (v) => {
      if (v !== select.value) {
        proto.set.call(select, v);
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      render();
      close(true);
    };

    btn.addEventListener('click', () => (list.hidden ? open() : close(true)));
    btn.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(e.key === 'ArrowUp' ? 'last' : 'first'); }
    });
    list.addEventListener('click', (e) => {
      const item = e.target.closest('[data-kp-value]');
      if (item) choose(item.dataset.kpValue);
    });
    list.addEventListener('keydown', (e) => {
      const items = [...list.querySelectorAll('.kp-item')];
      const i = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); items[Math.min(items.length - 1, i + 1)].focus(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); items[Math.max(0, i - 1)].focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
      else if (e.key === 'Tab') close(false);
    });
    // For the document-wide listeners below: one of each, however many
    // pickers the forms build and throw away.
    wrap._kpClose = close;
    wrap._kpRender = render;
    render();
  }

  function dressAll(scope = document) {
    if (scope.matches && scope.matches(SEL)) dress(scope);
    if (scope.querySelectorAll) scope.querySelectorAll(SEL).forEach(dress);
  }

  const start = () => {
    // A tap anywhere else closes an open list; a scheme flip repaints the chips.
    document.addEventListener('pointerdown', (e) => {
      document.querySelectorAll('.kp.open').forEach(w => { if (!w.contains(e.target)) w._kpClose(false); });
    }, true);
    if (root.matchMedia) {
      root.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () =>
        document.querySelectorAll('.kp, .kp-row').forEach(w => w._kpRender && w._kpRender()));
    }
    dressAll(document);
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) dressAll(n);
    }).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  root.AgoraKindPicker = { dress, dressAll };
})(typeof globalThis !== 'undefined' ? globalThis : this);
