// Month: a card's Calendar as a grid of days (Kevin, 6 Nov 2026).
//
// List and Month are two views of one Calendar, as in any calendar app: the
// same days, the same rows, the same filters and the same editing controls.
// Month lets you pick a day by where it sits, so in Month it takes Date's
// place, and the list under it carries on from the day picked, a FROM as
// every date is. It is for everyone, and not in index.html: next.js fetches
// this file (and month.css) the first time somebody taps Month, as it does
// editing.js for an editor, so a visitor who never taps it downloads nothing.
//
// Two sizes. In a card (a phone, or a card with no map beside it), a small
// month under the Calendar's title: a dot for each service, up to three. On
// a wide screen, the page's map beside the card gives way to a big month
// with each day's services in it, a Map button to have the map back, and the
// card's list beside it following the day picked (#194 put the map there).
//
// Notices: with more than a few parishes a day holds dozens of regular
// services, which say nothing a timetable does not. So a card of several
// parishes starts on Notices: a day's one-offs, and the dates changed or
// cancelled, with the rest as a grey count. A card of a few parishes (a
// list, Favourites) can switch each one off and on, like the calendars in a
// calendar app; the list under it follows.
//
// next.js hands this its page through init(host):
//   list(el, start, days)  what the card's Calendar holds on those days (its filters, its parishes on)
//   parishes(el)           the card's parishes, all of them
//   ensure(end)            the bundle holds every day to `end`
//   local(e)               { date, hm } in the parish's own zone
//   colour(e)              the jurisdiction colour of where it is held
//   tomb(e)                'Cancelled', 'Combined', 'Break', or null
//   today(), addDays(k, n), weekday(k)  dates as the page keeps them
//   timeHTML(hm), avatar(p, size)
//   pick(el, k)            the card's list from that day
//   refresh(el)            the card's Calendar again (its parishes switched)
//   setMonth(el, on)       Month on or off
//   stack()                the open cards, bottom first
//   wide()                 is the page wide (the card a panel beside the map)
//   raise(on)              the page's map box over the dimmed page, and the room the card takes
(function (root) {
  let host = null;
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const HEAD = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
  const HEAD_WIDE = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  // How far ahead a card's Calendar goes (next.js: Date's max, moreIO's year).
  const AHEAD = 365;
  // More parishes than this start on Notices; up to LAYERS can be switched one by one.
  const MANY = 4;
  const LAYERS = 12;
  // A day's rows in a big cell before it is measured; then as many as fit (fitRows).
  const ROWS = 3;

  const monthOf = (k) => k.slice(0, 7);
  function addMonths(m, n) {
    const d = new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7) - 1 + n, 1));
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  const lastDay = (m) => new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate();
  const monthTitle = (m) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
  const daysBetween = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 86400000);
  const dayWords = (k) => { const d = new Date(k + 'T00:00:00Z'); return `${WD_SHORT[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; };

  /** A date changed or cancelled, or a one-off: what the rhythm does not already say. */
  const isNotice = (e) => !e.schedule_id || e.mutation_type === 'adapted' || !!host.tomb(e);

  function init(h) { host = h; }

  /** The card's parishes, and whether it starts on Notices. */
  const parishesOf = (el) => host.parishes(el);
  const noticesOn = (el) => (el._notices != null ? el._notices : parishesOf(el).length > MANY);

  /**
   * The month on show: the one the card was turned to, else the one with
   * its picked day (its FROM), else this one; never before this month or
   * past the Calendar's year.
   */
  function shownMonth(el) {
    const t = host.today();
    const first = monthOf(t), last = monthOf(host.addDays(t, AHEAD));
    let m = el._monthAt || monthOf(el._from || t);
    if (m < first) m = first;
    if (m > last) m = last;
    el._monthAt = m;
    return m;
  }

  /** The days a month's grid shows, Monday first, and what is on each from today on. */
  function monthDays(el, m) {
    const t = host.today(), end = host.addDays(t, AHEAD);
    const first = `${m}-01`, last = `${m}-${String(lastDay(m)).padStart(2, '0')}`;
    const lead = (host.weekday(first) + 6) % 7;
    const gridStart = host.addDays(first, -lead);
    const cells = Math.ceil((lead + lastDay(m)) / 7) * 7;
    const from = first > t ? first : t, to = last < end ? last : end;
    const byDay = new Map();
    if (from <= to) {
      for (const e of host.list(el, from, daysBetween(from, to) + 1)) {
        const k = host.local(e).date;
        if (!byDay.has(k)) byDay.set(k, []);
        byDay.get(k).push(e);
      }
    }
    const days = [];
    for (let i = 0; i < cells; i++) {
      const k = host.addDays(gridStart, i);
      days.push({ k, inMonth: monthOf(k) === m, open: k >= t && k <= end, es: byDay.get(k) || [] });
    }
    return { days, last };
  }

  // ── Drawing ───────────────────────────────────────────────────────────

  function headHTML(el, m, { wide, mapBack }) {
    const t = host.today();
    const many = parishesOf(el).length > 1;
    const notices = noticesOn(el);
    const here = m === monthOf(t);
    const picked = el._from || t;
    return `<div class="mg-head">
        <button class="mg-nav" type="button" data-mg-step="-1" aria-label="Previous month"${here ? ' disabled' : ''}>‹</button>
        <h3 class="mg-title" aria-live="polite">${esc(monthTitle(m))}</h3>
        <button class="mg-nav" type="button" data-mg-step="1" aria-label="Next month"${m >= monthOf(host.addDays(t, AHEAD)) ? ' disabled' : ''}>›</button>
        <span class="mg-sp"></span>
        ${!here || picked !== t ? '<button class="fpill" type="button" data-mg-today>Today</button>' : ''}
        ${many ? `<button class="fpill${notices ? ' on' : ''}" type="button" data-mg-notices aria-pressed="${notices}" title="Only what is new or changed: one-offs, and dates moved or cancelled">Notices</button>` : ''}
        ${mapBack ? '<button class="fpill" type="button" data-mg-map>Map</button>' : ''}
      </div>`;
  }

  /** A card of a few parishes: each one switched on or off, as a calendar app's calendars are. */
  function layersHTML(el) {
    const ps = parishesOf(el);
    if (ps.length < 2 || ps.length > LAYERS) return '';
    const off = el._off || new Set();
    return `<div class="mg-layers" role="group" aria-label="Parishes shown">${ps.map(p => {
      const on = !off.has(p.id);
      return `<button class="mg-layer${on ? '' : ' off'}" type="button" data-mg-layer="${esc(p.id)}" aria-pressed="${on}" title="${esc(p.name)}">${host.avatar(p, 'xs')}<span>${esc(p.acronym || p.name)}</span></button>`;
    }).join('')}</div>`;
  }

  /** What a small day holds: a dot for each service (each notice, on Notices), up to three, and on Notices the rest as a count. */
  function smallDay(d, sel, notices) {
    if (!d.inMonth) return '<span class="mg-d out" aria-hidden="true"></span>';
    const n = +d.k.slice(8);
    if (!d.open) return `<span class="mg-d past"><span class="mg-n">${n}</span></span>`;
    const shown = notices ? d.es.filter(isNotice) : d.es;
    const rest = notices ? d.es.length - shown.length : 0;
    const dots = shown.slice(0, 3).map(e => `<i class="${host.tomb(e) ? 'tomb' : ''}" style="--c:${host.colour(e)}"></i>`).join('');
    const say = `${dayWords(d.k)}: ${d.es.length ? `${d.es.length} on` : 'nothing on file'}${notices && shown.length ? `, ${shown.length} new or changed` : ''}`;
    return `<button class="mg-d${d.k === host.today() ? ' today' : ''}${d.k === sel ? ' sel' : ''}${host.weekday(d.k) === 0 ? ' sun' : ''}" type="button" data-mg-day="${d.k}" aria-label="${esc(say)}"${d.k === sel ? ' aria-current="date"' : ''}>
        <span class="mg-n">${n}</span><span class="mg-dots">${dots}${shown.length > 3 ? '<b>+</b>' : ''}</span>${rest ? `<span class="mg-c">${rest}</span>` : ''}
      </button>`;
  }

  /** What a big day holds: its first few rows, each opening its card, and how many more. */
  function bigDay(d, sel, notices, fit) {
    if (!d.inMonth) return '<div class="mg-d out" aria-hidden="true"></div>';
    const n = +d.k.slice(8);
    if (!d.open) return `<div class="mg-d past"><div class="mg-top"><span class="mg-n">${n}</span></div></div>`;
    const shown = notices ? d.es.filter(isNotice) : d.es;
    const rest = notices ? d.es.length - shown.length : 0;
    // A day with more than fits gives its last row to "+ n more".
    const take = shown.length > fit ? Math.max(0, fit - 1) : shown.length;
    const rows = shown.slice(0, take).map(e => {
      const tomb = host.tomb(e);
      const l = host.local(e);
      return `<button class="mg-e${tomb ? ' tomb' : ''}${e.schedule_id ? '' : ' one'}" type="button" data-event="${esc(e.id)}" style="--c:${host.colour(e)}" title="${esc(`${e.title}${tomb ? ` (${tomb})` : ''}`)}">${host.timeHTML(l.hm)} <span>${esc(e.title)}</span></button>`;
    }).join('');
    const more = shown.length - take;
    return `<div class="mg-d${d.k === host.today() ? ' today' : ''}${d.k === sel ? ' sel' : ''}${host.weekday(d.k) === 0 ? ' sun' : ''}" data-mg-day="${d.k}">
        <div class="mg-top"><button class="mg-n" type="button" data-mg-day="${d.k}" aria-label="${esc(`${dayWords(d.k)}: ${d.es.length ? `${d.es.length} on` : 'nothing on file'}`)}">${n}</button>${rest ? `<span class="mg-c" title="${rest} regular ${rest === 1 ? 'service' : 'services'}">${rest}</span>` : ''}</div>
        ${rows}${more > 0 ? `<button class="mg-more" type="button" data-mg-day="${d.k}">+ ${more} more</button>` : ''}
      </div>`;
  }

  function gridHTML(el, { wide, fit = ROWS }) {
    const m = shownMonth(el);
    const sel = el._from || host.today();
    const notices = noticesOn(el);
    const { days } = monthDays(el, m);
    // Map, where Month has taken its place: beside the card, or at the top of a card of parishes.
    const mapBack = wide || el.classList.contains('has-map');
    return `${headHTML(el, m, { wide, mapBack })}
      ${layersHTML(el)}
      <div class="mg-wk" aria-hidden="true">${(wide ? HEAD_WIDE : HEAD).map((x, i) => `<span${i === 6 ? ' class="sun"' : ''}>${x}</span>`).join('')}</div>
      <div class="mg-grid" style="--weeks:${days.length / 7}">${days.map(d => wide ? bigDay(d, sel, notices, fit) : smallDay(d, sel, notices)).join('')}</div>`;
  }

  // ── Where it goes ─────────────────────────────────────────────────────

  /** The card whose month the wide page shows: the top one in Month, with only event cards over it. */
  function wideCard() {
    if (!host.wide()) return null;
    const stack = host.stack();
    for (let i = stack.length - 1; i >= 0; i--) {
      const el = stack[i];
      if (el._month) return el;
      if (!el.classList.contains('event')) return null;
    }
    return null;
  }
  let wideEl = null;      // the big month on the page, while a card has it
  let wideFor = null;     // whose it is
  let wideFit = ROWS;     // rows a big day has room for, as last measured

  /** The small month in a card, under its Calendar's title. */
  function paintSmall(el) {
    let box = el.querySelector(':scope .cu-band > .mg');
    if (!el._month || host.wide()) { if (box) box.remove(); return; }
    if (!box) {
      const head = el.querySelector('.cu-band > .cal-head');
      if (!head) return;
      box = document.createElement('div');
      box.className = 'mg mg-small';
      head.after(box);
    }
    box.innerHTML = gridHTML(el, { wide: false });
  }
  function paintWide() {
    const el = wideCard();
    if (!el) {
      if (wideEl) { wideEl.remove(); wideEl = null; wideFor = null; host.raise(false); }
      return;
    }
    if (!wideEl) {
      wideEl = document.createElement('div');
      wideEl.className = 'mg mg-wide';
      wideEl.setAttribute('role', 'region');
      wideEl.setAttribute('aria-label', 'Month');
      host.viewport().appendChild(wideEl);
      host.raise(true);
      // The map's place is as tall as the window allows: a resize may fit more rows, or fewer.
      if (window.ResizeObserver) new ResizeObserver(() => { if (wideEl && fitRows() !== wideFit) paintWide(); }).observe(wideEl);
    }
    wideFor = el;
    wideEl.innerHTML = gridHTML(el, { wide: true, fit: wideFit });
    const fit = fitRows();
    if (fit !== wideFit) { wideFit = fit; wideEl.innerHTML = gridHTML(el, { wide: true, fit }); }
  }
  /** How many rows a big day has room for under its number: every day is as tall as the others. */
  function fitRows() {
    const cell = wideEl && wideEl.querySelector('.mg-grid > .mg-d');
    if (!cell || !cell.clientHeight) return wideFit;
    const cs = getComputedStyle(cell);
    const top = cell.querySelector('.mg-top');
    const room = cell.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - (top ? top.offsetHeight : 26);
    const e = wideEl.querySelector('.mg-e');
    const gap = parseFloat(cs.rowGap) || 0;
    const row = (e ? e.offsetHeight : 18) + gap;
    return Math.max(1, Math.floor((room + gap) / row));
  }

  /** Everything in Month drawn where it belongs, from the bundle as it is. */
  function follow() {
    for (const el of host.stack()) paintSmall(el);
    paintWide();
  }
  /** One card's month again (its days, its parishes, its date), and the bundle asked for the month shown. */
  async function paint(el) {
    if (!el || !el._month) { follow(); return; }
    const m = shownMonth(el);
    paintSmall(el);
    paintWide();
    // A month further out than the bundle holds fills in once it has it.
    const end = `${m}-${String(lastDay(m)).padStart(2, '0')}`;
    try { await host.ensure(host.addDays(end, 1)); } catch (err) { console.warn(err); return; }
    if (el._monthAt === m && el._month) { paintSmall(el); if (wideFor === el) paintWide(); }
  }

  /** A tap the page passes on: true when it was one of the month's own. */
  function click(t) {
    const box = t.closest('.mg');
    if (!box) return false;
    const el = box.classList.contains('mg-wide') ? wideFor : box.closest('.sheet');
    if (!el) return false;
    let b;
    if ((b = t.closest('[data-mg-step]'))) {
      el._monthAt = addMonths(shownMonth(el), +b.dataset.mgStep);
      paint(el);
      return true;
    }
    if (t.closest('[data-mg-today]')) {
      el._monthAt = monthOf(host.today());
      host.pick(el, host.today());
      return true;
    }
    if (t.closest('[data-mg-notices]')) { el._notices = !noticesOn(el); paint(el); return true; }
    if (t.closest('[data-mg-map]')) { host.setMonth(el, false); return true; }
    if ((b = t.closest('[data-mg-layer]'))) {
      const off = el._off || (el._off = new Set());
      const id = b.dataset.mgLayer;
      if (off.has(id)) off.delete(id); else off.add(id);
      host.refresh(el);
      return true;
    }
    if ((b = t.closest('[data-mg-day]'))) {
      host.pick(el, b.dataset.mgDay);
      return true;
    }
    return box.contains(t);
  }

  root.NextMonth = { init, paint, follow, click, isNotice };
})(window);
