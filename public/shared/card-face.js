// An event's form as the event's card (Kevin, 19 Nov 2026): "not a bunch of
// fields and buttons. Rather a WYSIWYG event card", each part that can be
// changed underlined in dots, the dots in a colour that says what the poster
// reader made of that part.
//
// The card's head is drawn as the event card draws it (next.js
// eventBodyHTML: the kind's pill, the title, the subtitle, then a line each
// for the day, the time, the place and the languages), and each part of it
// is a button. Tapping one opens what changes it right there, under it: the
// form's own field, with what the reader said about it (event-editor.js,
// editing.js editEvent). The rarer controls go behind a styled menu (`menu`).
//
// THE COLOURS. One per answer the reader can give about a part, so an
// editor sees at a glance what is left to them:
//   read   green   read off the poster, or the WhatsApp words, as printed
//   guess  amber   worked out, not printed: a weekday made a date, a time
//                  after a service, an end from the usual length, a language
//                  from the parish's other services
//   miss   red     needed and not there, or the reader doubts it; Publish waits
//   chg    violet  differs from what is on file: a programme's 8:15 against
//                  the timetable's 8am, or an edit not yet saved
//   ''     grey    as it is: on file, typed by you, or the parish's own
// Green and amber turn grey once somebody has looked (tapped it open); red
// stays until it is answered, violet while it still differs.
//
// Classic script: window.AgoraCardFace, and module.exports for the tests
// (d1/card-face.test.mjs). Everything a person or the model wrote reaches
// the page through esc().
(function (root) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
  const isTime = (v) => typeof v === 'string' && /^\d{2}:\d{2}$/.test(v);

  /** '18:00' -> '6pm', '19:30' -> '7:30pm': the event card's clock (next.js hm12). */
  function hm12(hm) {
    if (!isTime(hm)) return '';
    const h = +hm.slice(0, 2), m = +hm.slice(3, 5);
    return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''}${h < 12 ? 'am' : 'pm'}`;
  }

  /** '2026-11-29' -> 'Sunday 29 November', with the year only when it is not `thisYear`. */
  function fullDate(date, thisYear) {
    if (!isDate(date)) return '';
    const d = new Date(`${date}T00:00:00Z`);
    return `${WD_LONG[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_LONG[d.getUTCMonth()]}${thisYear && +date.slice(0, 4) !== +thisYear ? ` ${date.slice(0, 4)}` : ''}`;
  }

  /**
   * The day line, as the card says it: "Sunday 29 November", or over several
   * days "Friday 27 – Sunday 29 November" (one month's said once).
   */
  function dayText(date, end, thisYear) {
    if (!isDate(date)) return '';
    if (!isDate(end) || end <= date) return fullDate(date, thisYear);
    const a = new Date(`${date}T00:00:00Z`);
    const from = date.slice(0, 7) === end.slice(0, 7) ? `${WD_LONG[a.getUTCDay()]} ${a.getUTCDate()}` : fullDate(date, thisYear);
    return `${from} – ${fullDate(end, thisYear)}`;
  }

  /** Over several days, each end of the time names its day: "7pm Fri – 2pm Sun". */
  function timeWithDay(hm, date) {
    if (!hm || !isDate(date)) return hm12(hm);
    return `${hm12(hm)} ${WD[new Date(`${date}T00:00:00Z`).getUTCDay()]}`;
  }

  /**
   * What colour a part's dots are (the key above). `value` whether it has
   * one; `read` printed on the poster or the WhatsApp words; `noted` the
   * reader said something about it (it was worked out, or is to be checked);
   * `doubt` a check stops it or doubts it; `changed` it differs from what is
   * on file; `looked` somebody has tapped it open since.
   */
  function stateOf({ value = true, read = false, noted = false, doubt = false, changed = false, looked = false }) {
    if (doubt) return 'miss';
    if (changed) return 'chg';
    if (!value || looked) return '';
    if (noted) return 'guess';
    if (read) return 'read';
    return '';
  }

  const WORDS = { read: 'Read off the poster', guess: 'Worked out, not printed: check it', miss: 'Missing or doubtful', chg: 'Changes what is on file', '': '' };

  /**
   * A part's box drawn again, touching only what changed (morph.js where the
   * page has it): the button stays the element it was, so a tap whose
   * pointerdown closes another part, and so draws this one again, still
   * lands as a click on it.
   */
  function draw(box, html) {
    if (!box || box._cfHtml === html) return;
    box._cfHtml = html;
    if (root && root.AgoraMorph) root.AgoraMorph.morph(box, html);
    else box.innerHTML = html;
  }

  /**
   * One part of the card, a button underlined in its state's dots. `text` is
   * plain; `empty` draws it as what to tap to add one ("Add a subtitle"), in
   * red when it is needed (`state` 'miss').
   */
  function part(key, text, state = '', { empty = false, label = '', cls = '' } = {}) {
    const word = WORDS[state] || '';
    const aria = `${label || key}: ${empty ? 'none' : text}${word ? `. ${word}` : ''}. Tap to change.`;
    return `<button type="button" class="cf-u${state ? ` cf-${state}` : ''}${empty ? ' cf-empty' : ''}${cls ? ` ${cls}` : ''}" data-face="${esc(key)}" data-key="${esc(key)}" aria-label="${esc(aria)}">${esc(text)}</button>`;
  }

  // The event card's signs (next.js I.cal, I.clock, I.where, I.chat).
  const ICON = {
    cal: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
    clock: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
    where: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 21s-6.5-6.4-6.5-11.3a6.5 6.5 0 0 1 13 0C18.5 14.6 12 21 12 21z"/><circle cx="12" cy="9.7" r="2.3"/></svg>',
    chat: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.5L3 21l2-5.4A8.5 8.5 0 1 1 21 11.5z"/></svg>',
    down: '<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
    tick: '<svg class="cf-tick" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    more: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    // The edit form's actions and its More menu's rows.
    cancel: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg>',
    undo: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M10 9v6M14 9v6"/></svg>',
    eyeoff: '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.1A10 10 0 0 1 12 5c5 0 9 4.5 10 7-0.4 1-1.3 2.4-2.6 3.7M6.6 6.6C4.4 8 2.9 10.2 2 12c1 2.5 5 7 10 7 1.9 0 3.6-.6 5-1.5"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>',
    eye: '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12c1-2.5 5-7 10-7s9 4.5 10 7c-1 2.5-5 7-10 7S3 14.5 2 12z"/><circle cx="12" cy="12" r="3"/></svg>',
    plus: '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
    live: '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.6 5.6a9 9 0 0 0 0 12.8M18.4 5.6a9 9 0 0 1 0 12.8"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 2l4 4-4 4"/><path d="M3 11V9a3 3 0 0 1 3-3h15M7 22l-4-4 4-4"/><path d="M21 13v2a3 3 0 0 1-3 3H3"/></svg>',
    trash: '<svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16"/><path d="M10 11v6m4-6v6"/><path d="m6 7 1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/></svg>',
  };

  /** A line of the card's facts: its sign, and what is in it. `inner` is markup. */
  const fact = (name, icon, inner, extra = '') =>
    `<div class="cf-fact cf-${name}" data-fact="${name}"${extra}>${ICON[icon]}<span>${inner}</span></div>`;

  /**
   * How many parts are in each colour, as chips: "1 to fill in", "2 to
   * check", "4 read", "1 changes what's on file". Empty when none are coloured.
   */
  function tallyHTML(counts) {
    const n = (k) => counts[k] || 0;
    const chips = [
      n('miss') && `<span class="cf-chip cf-miss">${n('miss')} to fill in</span>`,
      n('chg') && `<span class="cf-chip cf-chg">${n('chg')} change${n('chg') === 1 ? 's' : ''} what's on file</span>`,
      n('guess') && `<span class="cf-chip cf-guess">${n('guess')} to check</span>`,
      n('read') && `<span class="cf-chip cf-read">${n('read')} read</span>`,
    ].filter(Boolean);
    return chips.join('');
  }

  /** The key, folded under its button until asked for. */
  const legendHTML = () => `<div class="cf-key" role="list">
      <i class="cf-read"></i><div role="listitem"><b>Read</b> off the poster or the WhatsApp words, as printed.</div>
      <i class="cf-guess"></i><div role="listitem"><b>Worked out,</b> not printed: a weekday made a date, a time after a service, an end from the usual length, a language from the parish's other services. Check it.</div>
      <i class="cf-miss"></i><div role="listitem"><b>Missing or doubtful:</b> needed and not there, or the reader doubts it. Publish waits for these.</div>
      <i class="cf-chg"></i><div role="listitem"><b>Changes what's on file:</b> differs from the timetable, or from the event as it was.</div>
      <i class="cf-as"></i><div role="listitem"><b>As it is:</b> on file, typed by you, or the parish's own. Green and amber go grey once you have looked.</div>
    </div>`;

  // ── a styled menu, out of the part or button tapped ──
  //
  // The app's own (next.js openMenu, .popmenu) is the page's; this one is the
  // forms', in both hosts, /admin included. Rows: { label, sub, icon (markup),
  // on, danger, sep, value, run }. Tapping a row runs it and closes the menu;
  // a tap anywhere else, Escape or a scroll closes it.
  let openMenuEl = null;
  function closeMenu() {
    if (!openMenuEl) return;
    const m = openMenuEl;
    openMenuEl = null;
    if (m._btn) m._btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', m._outside, true);
    document.removeEventListener('keydown', m._key, true);
    document.removeEventListener('scroll', m._scroll, true);
    m.remove();
  }
  function menu(btn, rows) {
    closeMenu();
    const el = document.createElement('div');
    el.className = 'cf-menu';
    el.setAttribute('role', 'menu');
    el.innerHTML = rows.map((r, i) => (r.sep ? '<div class="cf-sep" role="separator"></div>'
      : `<button type="button" class="cf-row${r.danger ? ' cf-danger' : ''}" role="${r.on != null ? 'menuitemradio' : 'menuitem'}"${r.on != null ? ` aria-checked="${!!r.on}"` : ''} data-i="${i}">${r.icon || ''}<span class="cf-row-t"><b>${esc(r.label)}</b>${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span>${r.on ? ICON.tick : ''}${r.toggle != null ? `<span class="cf-switch${r.toggle ? ' on' : ''}" aria-hidden="true"></span>` : ''}</button>`)).join('');
    document.body.appendChild(el);
    const r = btn.getBoundingClientRect();
    const vw = root.innerWidth, vh = root.innerHeight;
    // Under the button, or over it when it is in the lower half; its left
    // edge on the button's, kept on the screen.
    const left = Math.max(10, Math.min(r.left, vw - el.offsetWidth - 10));
    el.style.left = `${left}px`;
    if (r.top > vh * 0.55) el.style.bottom = `${vh - r.top + 8}px`;
    else el.style.top = `${r.bottom + 8}px`;
    el._btn = btn;
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'true');
    el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const row = rows[+b.dataset.i];
      closeMenu();
      if (row && row.run) row.run(row.value);
    });
    el._outside = (e) => { if (!el.contains(e.target) && !btn.contains(e.target)) closeMenu(); };
    el._key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); btn.focus(); } };
    el._scroll = (e) => { if (!el.contains(e.target)) closeMenu(); };
    document.addEventListener('pointerdown', el._outside, true);
    document.addEventListener('keydown', el._key, true);
    document.addEventListener('scroll', el._scroll, { capture: true, passive: true });
    openMenuEl = el;
    const first = el.querySelector('[aria-checked="true"]') || el.querySelector('.cf-row');
    if (first) first.focus({ preventScroll: true });
    return closeMenu;
  }

  const api = { esc, hm12, fullDate, dayText, timeWithDay, stateOf, part, draw, fact, ICON, WORDS, tallyHTML, legendHTML, menu, closeMenu, isDate, isTime };
  if (root) root.AgoraCardFace = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : null);
