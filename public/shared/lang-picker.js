// The languages of a parish, a service or an event, picked from the fixed list
// (languages.js) as chips you tap on and off, instead of typed.
//
// Like kind-picker.js it DRESSES a real field rather than replacing it: an
// <input data-lang-picker> stays in the form, hidden, holding "Greek, English"
// as it always has. Every form that reads it, splits it on commas and saves it
// keeps working untouched; the picker only writes the value and fires `input`
// and `change`, as typing would. Code that sets `.value` itself (a poster read
// filling a card, a form reset) is followed too.
//
// The order is the order chosen, because the first language means something
// (a Greek parish with some English is not an English one with some Greek):
// a chip turned on goes to the end, one turned off leaves. A value that is not
// on the list (an old row's) shows as a chip of its own until it is tapped off.
(function (root) {
  if (typeof document === 'undefined') return;
  const SEL = 'input[data-lang-picker]';
  const langs = () => root.AgoraLanguages;
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const split = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

  /** The chosen: list names where they are on the list, as typed where not. */
  function chosen(input) {
    const out = [];
    for (const v of split(input.value)) {
      const n = langs().canonical(v) || v;
      if (!out.includes(n)) out.push(n);
    }
    return out;
  }

  function dress(input) {
    if (!input || input.dataset.lpDressed || !langs()) return;
    input.dataset.lpDressed = '1';
    const layout = [...input.classList];
    input.classList.add('lp-native');
    input.type = 'hidden';

    const wrap = document.createElement('div');
    wrap.className = ['lp', ...layout].join(' ');
    wrap.setAttribute('role', 'group');
    const named = input.id && document.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (named) wrap.setAttribute('aria-label', named.textContent.trim());
    input.after(wrap);

    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const render = () => {
      const on = chosen(input);
      const extra = on.filter(n => !langs().NAMES.includes(n));
      wrap.innerHTML = [...langs().NAMES, ...extra].map((n) => {
        const i = on.indexOf(n);
        return `<button type="button" class="lp-chip${i >= 0 ? ' on' : ''}${extra.includes(n) ? ' lp-extra' : ''}" aria-pressed="${i >= 0}" data-lp-value="${esc(n)}">${esc(n)}</button>`;
      }).join('');
    };

    Object.defineProperty(input, 'value', {
      configurable: true,
      get() { return proto.get.call(this); },
      set(v) { proto.set.call(this, v); render(); },
    });

    wrap.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-lp-value]');
      if (!chip) return;
      const n = chip.dataset.lpValue;
      const on = chosen(input);
      const next = on.includes(n) ? on.filter(x => x !== n) : [...on, n];
      proto.set.call(input, next.join(', '));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      render();
      wrap.querySelector(`[data-lp-value="${CSS.escape(n)}"]`)?.focus({ preventScroll: true });
    });
    render();
  }

  function dressAll(scope = document) {
    if (scope.matches && scope.matches(SEL)) dress(scope);
    if (scope.querySelectorAll) scope.querySelectorAll(SEL).forEach(dress);
  }

  const start = () => {
    dressAll(document);
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) dressAll(n);
    }).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  root.AgoraLangPicker = { dress, dressAll };
})(typeof globalThis !== 'undefined' ? globalThis : this);
