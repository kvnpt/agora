// A time of day, picked from a list in quarter-hours or typed — instead of the
// system's time picker, which on a phone is a wheel of every minute and on a
// desktop a box of segments that will not take "6:30pm".
//
// Like kind-picker.js it DRESSES a real field rather than replacing it: an
// <input type="hidden" data-time-field> holding 'HH:MM' (or '' for none) stays
// in the form, and every reader of `.value` keeps working untouched. The
// visible box shows "9:30 am"; tapping it opens the quarter-hours, the first
// entry of which is "Custom time", for the 6:05 Vespers nobody rounds. Typing
// works too — straight away with a keyboard, and on a phone in "Custom
// time", a field of its own at the top of the list (the box holds back the
// on-screen keyboard, since most picks are a tap on the list).
//
//   data-tf-optional     the field may be empty; the list offers "No time"
//   data-tf-none="…"     what that entry says ("No end time")
//   data-tf-name="…"     its name, for data-tf-near on another field
//   data-tf-near="…"     opened empty, the list starts an hour after that one
//   data-tf-label="…"    what a screen reader calls the box
//
// Classic script, the dual shape of its neighbours: the parsing is a module
// export for the tests (d1/time-field.test.mjs), the dressing a browser global.
(function (root) {
  const STEP = 15;

  /**
   * 'HH:MM' for what somebody typed, or null if it is not a time.
   * "9", "9am", "9:30", "930", "0930", "9.30 pm", "18:05", "noon", "midnight".
   */
  function parseTime(text) {
    let s = String(text == null ? '' : text).trim().toLowerCase();
    if (!s) return null;
    if (s === 'noon' || s === 'midday') return '12:00';
    if (s === 'midnight') return '00:00';
    // "p.m." first, so its dots are not read as the hour's.
    s = s.replace(/([ap])\.?\s*m\.?$/, '$1m').replace(/\./g, ':').replace(/\s+/g, '');
    const m = s.match(/^(\d{1,2})(?::?(\d{2}))?(am|pm|a|p)?$/);
    if (!m) return null;
    let h = Number(m[1]);
    const min = m[2] == null ? 0 : Number(m[2]);
    const mer = m[3] ? m[3][0] : null;
    if (min > 59) return null;
    if (mer) {
      if (h < 1 || h > 12) return null;
      if (mer === 'p' && h !== 12) h += 12;
      if (mer === 'a' && h === 12) h = 0;
    } else if (h > 23) {
      return null;
    }
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }

  /** '18:30' → '6:30 pm'; '' for anything that is not 'HH:MM'. */
  function formatTime(hhmm) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
    if (!m) return '';
    const h = Number(m[1]);
    return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'am' : 'pm'}`;
  }

  /** Every quarter-hour of the day, as 'HH:MM'. */
  function slots(step = STEP) {
    const out = [];
    for (let t = 0; t < 24 * 60; t += step) {
      out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
    }
    return out;
  }

  /** The slot to scroll to for `hhmm`: itself, or the one before it. */
  function nearestSlot(hhmm, step = STEP) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const t = Math.floor((Number(m[1]) * 60 + Number(m[2])) / step) * step;
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }

  /** `hhmm` plus `mins`, within the day. */
  function addMinutes(hhmm, mins) {
    const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    const t = Math.min(24 * 60 - STEP, Math.max(0, Number(m[1]) * 60 + Number(m[2]) + mins));
    return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  }

  const api = { parseTime, formatTime, slots, nearestSlot, addMinutes };
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AgoraTimeField = api;
  if (typeof document === 'undefined') return;

  // ── the dressing ──

  const SEL = 'input[data-time-field]';
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const CHEVRON = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.5 8 10.5 12 6.5"/></svg>';

  function dress(field) {
    if (!field || field.dataset.tfDressed) return;
    field.dataset.tfDressed = '1';
    const optional = field.hasAttribute('data-tf-optional');
    const noneLabel = field.dataset.tfNone || 'No time';

    const wrap = document.createElement('div');
    wrap.className = 'tf';
    wrap.innerHTML = `<input type="text" class="tf-text" autocomplete="off" autocapitalize="off" spellcheck="false"
        inputmode="none" enterkeyhint="done" placeholder="${optional ? esc(noneLabel) : 'Pick or type a time'}"
        aria-label="${esc(field.dataset.tfLabel || 'Time')}" aria-haspopup="listbox" aria-expanded="false">
      <button type="button" class="tf-btn" tabindex="-1" aria-hidden="true">${CHEVRON}</button>
      <div class="tf-list" role="listbox" hidden></div>`;
    field.after(wrap);
    const text = wrap.querySelector('.tf-text');
    const list = wrap.querySelector('.tf-list');
    const scope = () => field.closest('form, .detail-edit-form, [data-tf-scope]') || document;

    const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const show = () => {
      text.value = formatTime(proto.get.call(field));
      wrap.classList.remove('tf-bad');
    };
    // Code that sets .value directly fires no event; follow it anyway.
    Object.defineProperty(field, 'value', {
      configurable: true,
      get() { return proto.get.call(this); },
      set(v) { proto.set.call(this, v); show(); },
    });

    const set = (v) => {
      const was = proto.get.call(field);
      proto.set.call(field, v || '');
      show();
      if (was !== (v || '')) {
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };

    // "Custom time" (and "No end time") stay put above the quarter-hours,
    // which scroll: the way to type a time is never scrolled out of sight.
    // It is a field a person taps, not a button that focuses the box for
    // them: iOS brings its keyboard up for a tap on a field, and not
    // reliably for a focus() from code (Kevin, 27 Oct 2026).
    const renderList = () => {
      const cur = proto.get.call(field);
      list.innerHTML = `<div class="tf-head"><input type="text" class="tf-custom" data-tf-custom placeholder="Custom time…"
          inputmode="text" enterkeyhint="done" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Custom time">`
        + (optional ? `<button type="button" class="tf-item tf-none${cur ? '' : ' on'}" data-tf-value="">${esc(noneLabel)}</button>` : '')
        + `</div><div class="tf-slots">`
        + slots().map(s => `<button type="button" class="tf-item${s === cur ? ' on' : ''}" role="option" aria-selected="${s === cur}" data-tf-value="${s}">${formatTime(s)}</button>`).join('')
        + '</div>';
    };

    const open = () => {
      if (!list.hidden) return;
      renderList();
      list.hidden = false;
      wrap.classList.add('open');
      text.setAttribute('aria-expanded', 'true');
      const r = wrap.getBoundingClientRect();
      wrap.classList.toggle('tf-up', r.bottom + 240 > root.innerHeight && r.top > 260);
      // Scroll to the time it holds, or for an empty end time to an hour after
      // the start, or to the morning.
      const cur = proto.get.call(field);
      let near = cur;
      if (!near && field.dataset.tfNear) {
        const other = scope().querySelector(`[data-time-field][data-tf-name="${CSS.escape(field.dataset.tfNear)}"]`);
        near = other && other.value ? addMinutes(other.value, 60) : null;
      }
      const pane = list.querySelector('.tf-slots');
      const target = pane.querySelector(`[data-tf-value="${nearestSlot(near || '09:00')}"]`);
      if (target) pane.scrollTop = target.offsetTop - pane.offsetTop - pane.clientHeight / 2 + target.offsetHeight / 2;
    };
    // Closed with something in "Custom time", by a tap anywhere else, that
    // is the time: one that will not read goes into the box, red, as a typed
    // one does, so Save stops on it.
    const close = () => {
      if (list.hidden) return;
      const custom = list.querySelector('[data-tf-custom]');
      const typed = custom ? custom.value.trim() : '';
      list.hidden = true;
      list.innerHTML = '';
      wrap.classList.remove('open', 'tf-up');
      text.setAttribute('aria-expanded', 'false');
      if (!typed) return;
      const t = parseTime(typed);
      if (t) set(t);
      else { text.value = typed; wrap.classList.add('tf-bad'); }
    };
    // What was typed, taken when the box is left or Enter is pressed. A time
    // that will not read keeps the box red and the field as it was, so Save
    // sends nothing invented.
    const commit = () => {
      const typed = text.value.trim();
      if (!typed) {
        if (optional) set('');
        else show();
        return true;
      }
      const t = parseTime(typed);
      if (t) { set(t); return true; }
      wrap.classList.add('tf-bad');
      return false;
    };

    text.addEventListener('focus', () => { if (text.getAttribute('inputmode') === 'none') open(); });
    text.addEventListener('click', open);
    wrap.querySelector('.tf-btn').addEventListener('click', () => (list.hidden ? open() : close()));
    text.addEventListener('input', () => { wrap.classList.remove('tf-bad'); close(); });
    text.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); close(); }
      else if (e.key === 'Escape' && !list.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); open(); }
    });
    text.addEventListener('blur', () => {
      // Leaving for the list is not leaving.
      setTimeout(() => {
        if (wrap.contains(document.activeElement)) return;
        commit();
        text.setAttribute('inputmode', 'none');
      }, 0);
    });
    // pointerdown, so a tap on the list does not first blur the box; the
    // custom field takes its tap, and the keyboard with it.
    list.addEventListener('pointerdown', (e) => { if (!e.target.closest('[data-tf-custom]')) e.preventDefault(); });
    list.addEventListener('input', (e) => { if (e.target.closest('[data-tf-custom]')) e.target.classList.remove('tf-bad'); });
    list.addEventListener('keydown', (e) => {
      const custom = e.target.closest('[data-tf-custom]');
      if (!custom) return;
      if (e.key === 'Enter') {
        // Done with one that will not read keeps it, red, to fix.
        e.preventDefault();
        const typed = custom.value.trim();
        if (typed && !parseTime(typed)) { custom.classList.add('tf-bad'); return; }
        close();
      } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); custom.value = ''; close(); }
    });
    list.addEventListener('focusout', (e) => {
      if (!e.target.closest('[data-tf-custom]')) return;
      setTimeout(() => { if (!wrap.contains(document.activeElement)) close(); }, 0);
    });
    list.addEventListener('click', (e) => {
      const item = e.target.closest('[data-tf-value]');
      if (!item) return;
      // A time picked from the list, not what was half typed above it.
      const custom = list.querySelector('[data-tf-custom]');
      if (custom) custom.value = '';
      set(item.dataset.tfValue);
      close();
      text.setAttribute('inputmode', 'none');
      text.blur();
    });

    wrap._tfClose = close;
    wrap._tfCommit = commit;
    show();
  }

  function dressAll(scope = document) {
    if (scope.matches && scope.matches(SEL)) dress(scope);
    if (scope.querySelectorAll) scope.querySelectorAll(SEL).forEach(dress);
  }

  /** Commit every box under `scope`; false if one holds something that is not a time. */
  function commitAll(scope = document) {
    let ok = true;
    scope.querySelectorAll('.tf').forEach(w => { if (w._tfCommit && !w._tfCommit()) ok = false; });
    return ok;
  }

  const start = () => {
    document.addEventListener('pointerdown', (e) => {
      document.querySelectorAll('.tf.open').forEach(w => { if (!w.contains(e.target)) w._tfClose(); });
    }, true);
    dressAll(document);
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n.nodeType === 1) dressAll(n);
    }).observe(document.documentElement, { childList: true, subtree: true });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  Object.assign(api, { dress, dressAll, commitAll });
})(typeof globalThis !== 'undefined' ? globalThis : this);
