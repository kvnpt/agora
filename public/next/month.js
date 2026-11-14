// Month: a card's Calendar as a grid of days (Kevin, 6–7 Nov 2026).
//
// List and Month are two views of one Calendar, as in any calendar app: the
// same days, the same rows, the same filters and the same editing controls.
// Over the list sits the week bar (next.js weekBarHTML), Fantastical's week
// drawer: the month's name, a week of days, the day the list is on. The
// month's name, or Month beside Filters, opens the whole month, and a day
// tapped in it takes the list there as a day in the week bar does. It is for
// everyone, and not in index.html: next.js fetches this file (and month.css)
// the first time somebody opens a month, as it does editing.js for an editor,
// so a visitor who never does downloads nothing.
//
// Two sizes. In a card (a phone, or a card with no map beside it), the month
// opens in the week bar in place of its week, a dot for each service, up to
// three, and swiped sideways like a gallery to the month after. On a wide
// screen, the page's map beside the card gives way to a big month with each
// day's services in it, and a Map button to have the map back (#194 put the
// map there).
//
// Notices: with more than a few parishes a day holds dozens of regular
// services, which say nothing a timetable does not. So a card of several
// parishes marks only its notices: a day's one-offs, and the dates changed or
// cancelled, with the rest as a grey count (next.js noticesOn). A card of a
// few parishes (a list, Favourites) can switch each one off and on, like the
// calendars in a calendar app; the list under it follows.
//
// Two views of a card's month on a phone (Kevin, 14 Nov 2026), switched in
// the month itself and kept on the phone (next.js S.calView). Schedule, for
// everyone unless they pick otherwise: the month folds away to the week again
// when a day is tapped, as above. Month, for whoever wants the month to stay:
// a grid as tall as a phone allows under the Calendar's head, each day's
// titles in it as a calendar app's month has them, the day tapped filled and
// the list under the grid going on from it (a FROM, as a dated link is).
// Nothing folds. Week and day views can join the switch later. Wide, the big
// month beside the card already stays, and nothing here changes it.
//
// Nothing here draws a picture twice: a parish's chip, logo and all, is drawn
// when the month opens and only its state changes after (Kevin, 7 Nov 2026:
// the logos flashed as days were tapped).
//
// next.js hands this its page through init(host):
//   list(el, start, days)  what the card's Calendar holds on those days (its filters, its parishes on)
//   parishes(el)           the card's parishes, all of them
//   ensure(end)            the bundle holds every day to `end`
//   holds(end)             does it already (no wait)
//   notices(el)            does the card mark only its notices
//   isNotice(e)            a one-off, or a date changed or cancelled
//   current(el)            the day the card's list is on
//   title(el, k)           the week bar's month name, for the month of `k`
//   local(e)               { date, hm } in the parish's own zone
//   colour(e)              the jurisdiction colour of where it is held
//   tomb(e)                'Cancelled', 'Combined', 'Break', or null
//   today(), addDays(k, n), weekday(k)  dates as the page keeps them
//   timeHTML(hm), avatar(p, size)
//   pick(el, k)            the card's list to that day
//   picked(el)             the day the card's list starts on
//   monthView(el)          is this card's month the Month view (a phone, Month picked)
//   setView(v)             'schedule' or 'month', for every card, kept on the phone
//   refresh(el)            the card's Calendar again (its parishes switched)
//   redot(el)              the week bar's dots again (Notices)
//   setMonth(el, on)       the month open or closed
//   stack()                the open cards, bottom first
//   wide()                 is the page wide (the card a panel beside the map)
//   raise(on)              the page's map box over the dimmed page, and the room the card takes
(function (root) {
  let host = null;
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const WD_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // Sunday first, as the week bar (Kevin, 7 Nov 2026).
  const HEAD = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  const HEAD_WIDE = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  // How far ahead a card's Calendar goes (next.js moreIO's year).
  const AHEAD = 365;
  // Up to this many parishes can be switched one by one.
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
  /** The day after a month's last, which the bundle must reach for the month to be whole. */
  const pastEnd = (m) => host.addDays(`${m}-${String(lastDay(m)).padStart(2, '0')}`, 1);
  const firstMonth = () => monthOf(host.today());
  const lastMonth = () => monthOf(host.addDays(host.today(), AHEAD));

  function init(h) { host = h; }
  const parishesOf = (el) => host.parishes(el);

  /** The months a card's month goes through: this one to the Calendar's last. */
  function monthsAhead() {
    const out = [];
    for (let m = firstMonth(); m <= lastMonth(); m = addMonths(m, 1)) out.push(m);
    return out;
  }
  /** The big month on show: the one it was turned to, else the one the list is on. */
  function shownMonth(el) {
    let m = el._monthAt || monthOf(host.current(el));
    if (m < firstMonth()) m = firstMonth();
    if (m > lastMonth()) m = lastMonth();
    el._monthAt = m;
    return m;
  }

  /**
   * The days a month's grid shows, Sunday first, and what is on each from
   * today on. `weeks`: always that many rows (the small months, all one
   * height as they are swiped), else as many as the month needs.
   */
  function monthDays(el, m, { weeks = 0, empty = false, around = false } = {}) {
    const t = host.today(), end = host.addDays(t, AHEAD);
    const first = `${m}-01`, last = `${m}-${String(lastDay(m)).padStart(2, '0')}`;
    const lead = host.weekday(first);
    const gridStart = host.addDays(first, -lead);
    const cells = (weeks || Math.ceil((lead + lastDay(m)) / 7)) * 7;
    // `around`: what is on the days either side of the month too, as a calendar app's month shows them.
    const lo = around ? gridStart : first, hi = around ? host.addDays(gridStart, cells - 1) : last;
    const from = lo > t ? lo : t, to = hi < end ? hi : end;
    const byDay = new Map();
    if (!empty && from <= to) {
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
    return days;
  }

  // ── Drawing ───────────────────────────────────────────────────────────

  const noticesPill = (el) => {
    if (parishesOf(el).length < 2) return '';
    const on = host.notices(el);
    return `<button class="fpill${on ? ' on' : ''}" type="button" data-mg-notices aria-pressed="${on}" title="Only what is new or changed: one-offs, and dates moved or cancelled">Notices</button>`;
  };
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
  /** The chips and Notices as they now are, the chips' pictures left alone. */
  function syncTools(box, el) {
    if (!box) return;
    const off = el._off || new Set();
    box.querySelectorAll('[data-mg-layer]').forEach(b => {
      const on = !off.has(b.dataset.mgLayer);
      b.classList.toggle('off', !on);
      b.setAttribute('aria-pressed', on);
    });
    const n = box.querySelector('[data-mg-notices]');
    if (n) { const on = host.notices(el); n.classList.toggle('on', on); n.setAttribute('aria-pressed', on); }
  }

  /**
   * What a small day holds: a dot for each service (each notice, on Notices)
   * in its kind's colour, up to four and + for a fifth (the page's dotsHTML,
   * as its week bar), and on Notices the rest as a count.
   */
  function smallDay(d, notices) {
    if (!d.inMonth) return '<span class="mg-d out" aria-hidden="true"></span>';
    const n = +d.k.slice(8);
    if (!d.open) return `<span class="mg-d past"><span class="mg-n">${n}</span></span>`;
    const shown = notices ? d.es.filter(host.isNotice) : d.es;
    const rest = notices ? d.es.length - shown.length : 0;
    const say = `${dayWords(d.k)}: ${d.es.length ? `${d.es.length} on` : 'nothing on file'}${notices && shown.length ? `, ${shown.length} new or changed` : ''}`;
    return `<button class="mg-d${d.k === host.today() ? ' today' : ''}" type="button" data-mg-day="${d.k}" aria-label="${esc(say)}">
        <span class="mg-n">${n}</span><span class="mg-dots">${host.dots(shown)}</span>${rest ? `<span class="mg-c">${rest}</span>` : ''}
      </button>`;
  }

  /** What a big day holds: its first few rows, each opening its card, and how many more. */
  function bigDay(d, notices, fit) {
    if (!d.inMonth) return '<div class="mg-d out" aria-hidden="true"></div>';
    const n = +d.k.slice(8);
    if (!d.open) return `<div class="mg-d past"><div class="mg-top"><span class="mg-n">${n}</span></div></div>`;
    const shown = notices ? d.es.filter(host.isNotice) : d.es;
    const rest = notices ? d.es.length - shown.length : 0;
    // A day with more than fits gives its last row to "+ n more".
    const take = shown.length > fit ? Math.max(0, fit - 1) : shown.length;
    const rows = shown.slice(0, take).map(e => {
      const tomb = host.tomb(e);
      const l = host.local(e);
      return `<button class="mg-e${tomb ? ' tomb' : ''}${e.schedule_id ? '' : ' one'}" type="button" data-event="${esc(e.id)}" style="--c:${host.colour(e)}" title="${esc(`${e.title}${tomb ? ` (${tomb})` : ''}`)}">${host.timeHTML(l.hm)} <span>${esc(e.title)}</span></button>`;
    }).join('');
    const more = shown.length - take;
    return `<div class="mg-d${d.k === host.today() ? ' today' : ''}" data-mg-day="${d.k}">
        <div class="mg-top"><button class="mg-n" type="button" data-mg-day="${d.k}" aria-label="${esc(`${dayWords(d.k)}: ${d.es.length ? `${d.es.length} on` : 'nothing on file'}`)}">${n}</button>${rest ? `<span class="mg-c" title="${rest} regular ${rest === 1 ? 'service' : 'services'}">${rest}</span>` : ''}</div>
        ${rows}${more > 0 ? `<button class="mg-more" type="button" data-mg-day="${d.k}">+ ${more} more</button>` : ''}
      </div>`;
  }

  /** Schedule or Month: the switch at the top of a card's month, on a phone. */
  function viewsHTML(el) {
    const big = host.monthView(el);
    const b = (v, words, on) => `<button type="button" data-mg-view="${v}" aria-pressed="${on}"${on ? ' class="on"' : ''}>${words}</button>`;
    return `<div class="mg-views" role="group" aria-label="View">${b('schedule', 'Schedule', !big)}${b('month', 'Month', big)}</div>`;
  }

  /**
   * A day in the Month view: its number, filled on the day the list starts
   * from, and its first two titles, the second's line given to "n more"
   * when there is more than fits. On Notices only its notices are titles,
   * and its regular services are in the "n more", or, with no notice that
   * day, a grey count, as in the week bar's month. The whole day is one
   * button: a title is too small to aim at. The days either side of the
   * month are there too, fainter.
   */
  const VIEW_ROWS = 2;
  function viewDay(d, notices, picked) {
    const n = +d.k.slice(8);
    const cls = `${d.inMonth ? '' : ' out'}${d.k === host.today() ? ' today' : ''}${d.k === picked ? ' picked' : ''}`;
    if (!d.open) return `<span class="mg-d past${cls}" aria-hidden="${!d.inMonth}"><span class="mg-top"><span class="mg-n">${n}</span></span></span>`;
    const shown = notices ? d.es.filter(host.isNotice) : d.es;
    const take = d.es.length > VIEW_ROWS && shown.length ? Math.min(shown.length, VIEW_ROWS - 1) : shown.length;
    const rows = shown.slice(0, take).map(e => {
      const tomb = host.tomb(e);
      return `<span class="mg-t${tomb ? ' tomb' : ''}${e.schedule_id ? '' : ' one'}" style="--c:${host.colour(e)}">${esc(e.title)}</span>`;
    }).join('');
    const more = d.es.length - take;
    const foot = !more ? '' : take ? `<span class="mg-more">${more} more</span>` : `<span class="mg-c">${more}</span>`;
    const say = `${dayWords(d.k)}: ${d.es.length ? `${d.es.length} on` : 'nothing on file'}${notices && shown.length ? `, ${shown.length} new or changed` : ''}`;
    return `<button class="mg-d${cls}" type="button" data-mg-day="${d.k}" aria-label="${esc(say)}"${d.k === picked ? ' aria-current="date"' : ''}>
        <span class="mg-top"><span class="mg-n">${n}</span></span>${rows}${foot}
      </button>`;
  }

  // ── In a card: the month in the week bar ──────────────────────────────

  // In Schedule, the month is in the week bar, in place of its week; in the
  // Month view it is under it, so the head is held over the list as ever and
  // the grid scrolls away under it like the rest of the card.
  const smallOf = (el) => el.querySelector(':scope .cu-band > .wk > .mg, :scope .cu-band > .mg-view');
  /** The month open in a card's week bar, in place of its week; or closed. */
  function paintSmall(el) {
    const wk = el.querySelector('.cu-band > .wk');
    if (!wk) return;
    let box = smallOf(el);
    const open = !!el._month && !host.wide();
    const big = open && host.monthView(el);
    wk.classList.toggle('open', open);
    const head = wk.querySelector('[data-wk-month]');
    if (head) head.setAttribute('aria-expanded', !!el._month);
    // The other view's month goes; this one's is drawn in its place.
    if (box && (!open || box._big !== big)) { if (box._io) box._io.disconnect(); box.remove(); box = null; }
    if (!open) return;
    if (box) {
      // Open already: its days again (the parishes switched, Notices), the
      // chips left alone. The month in view and those beside it now; the
      // rest as they are swiped to.
      syncTools(box, el);
      box._ver = (box._ver || 0) + 1;
      const months = box.querySelector('.mg-months');
      const i = Math.round(months.scrollLeft / Math.max(1, months.clientWidth));
      for (const g of [months.children[i - 1], months.children[i], months.children[i + 1]]) if (g) fillMonth(el, box, g);
      return;
    }
    box = document.createElement('div');
    box.className = big ? 'mg mg-view' : 'mg mg-small';
    box._big = big;
    const tools = `${viewsHTML(el)}${layersHTML(el)}${noticesPill(el)}`;
    const blank = (m) => (big
      ? monthDays(el, m, { weeks: 6, empty: true, around: true }).map(d => viewDay(d, false, null))
      : monthDays(el, m, { weeks: 6, empty: true }).map(d => smallDay(d, false))).join('');
    box.innerHTML = `<div class="mg-tools">${tools}</div>
      <div class="mg-wk" aria-hidden="true">${HEAD.map((x, i) => `<span${i === 0 ? ' class="sun"' : ''}>${x}</span>`).join('')}</div>
      <div class="mg-months">${monthsAhead().map(m => `<div class="mg-month" data-m="${m}" aria-label="${esc(monthTitle(m))}"><div class="mg-grid">${blank(m)}</div></div>`).join('')}</div>`;
    if (big) wk.after(box); else wk.querySelector('.wk-head').after(box);
    box._ver = 0;
    const months = box.querySelector('.mg-months');
    // Each month's dots as it comes into view, and the next one's ready.
    box._io = new IntersectionObserver((ents) => {
      for (const en of ents) if (en.isIntersecting) fillMonth(el, box, en.target);
    }, { root: months, rootMargin: '0px 100%' });
    months.querySelectorAll('.mg-month').forEach(g => box._io.observe(g));
    // Swiped to another month: its name over it.
    let raf = 0;
    months.addEventListener('scroll', () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const g = months.children[Math.round(months.scrollLeft / Math.max(1, months.clientWidth))];
        if (g) host.title(el, `${g.dataset.m}-01`);
      });
    }, { passive: true });
    showMonth(el, box, monthOf(host.current(el)), false);
  }
  /** A small month's days, with what is on them. Its own picture, drawn again: there are none in it. */
  async function fillMonth(el, box, g) {
    const ver = box._ver;
    if (g._ver === ver) return;
    g._ver = ver;
    const m = g.dataset.m;
    if (!host.holds(pastEnd(m))) {
      g.classList.add('waiting');
      try { await host.ensure(pastEnd(m)); } catch (err) { console.warn(err); }
      g.classList.remove('waiting');
      if (!g.isConnected || g._ver !== ver) return;
    }
    const notices = host.notices(el);
    g.querySelector('.mg-grid').innerHTML = box._big
      ? monthDays(el, m, { weeks: 6, around: true }).map(d => viewDay(d, notices, host.picked(el))).join('')
      : monthDays(el, m, { weeks: 6 }).map(d => smallDay(d, notices)).join('');
  }
  function showMonth(el, box, m, smooth) {
    const months = box.querySelector('.mg-months');
    const i = monthsAhead().indexOf(m);
    if (i < 0) return;
    const left = i * months.clientWidth;
    if (Math.abs(months.scrollLeft - left) > 2) months.scrollTo({ left, behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
    host.title(el, `${m}-01`);
  }

  // ── Wide: the big month in the map's place ────────────────────────────

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

  function wideHeadHTML(el, m) {
    const t = host.today();
    const here = m === monthOf(t);
    return `<button class="mg-nav" type="button" data-mg-step="-1" aria-label="Previous month"${here ? ' disabled' : ''}>‹</button>
        <h3 class="mg-title" aria-live="polite">${esc(monthTitle(m))}<span class="mg-wait" aria-hidden="true"><i></i><i></i><i></i></span></h3>
        <button class="mg-nav" type="button" data-mg-step="1" aria-label="Next month"${m >= lastMonth() ? ' disabled' : ''}>›</button>
        <span class="mg-acts">
          ${!here || host.current(el) !== t ? '<button class="fpill" type="button" data-mg-today>Today</button>' : ''}
          ${noticesPill(el)}
          <button class="fpill" type="button" data-mg-map>Map</button>
        </span>`;
  }
  function wideBodyHTML(el, m, fit) {
    const days = monthDays(el, m);
    const notices = host.notices(el);
    return `<div class="mg-wk" aria-hidden="true">${HEAD_WIDE.map((x, i) => `<span${i === 0 ? ' class="sun"' : ''}>${x}</span>`).join('')}</div>
      <div class="mg-grid" style="--weeks:${days.length / 7}">${days.map(d => bigDay(d, notices, fit)).join('')}</div>`;
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
      wideEl.innerHTML = '<div class="mg-head"></div><div class="mg-tools"></div><div class="mg-body"></div>';
      host.viewport().appendChild(wideEl);
      host.raise(true);
      // The map's place is as tall as the window allows: a resize may fit more rows, or fewer.
      if (window.ResizeObserver) new ResizeObserver(() => { if (wideEl && fitRows() !== wideFit) paintWide(); }).observe(wideEl);
    }
    const m = shownMonth(el);
    const tools = wideEl.querySelector('.mg-tools');
    // The chips are drawn once for the card, then only switched.
    if (wideFor !== el) { tools.innerHTML = layersHTML(el); tools.hidden = !tools.innerHTML; }
    else syncTools(tools, el);
    wideFor = el;
    wideEl.querySelector('.mg-head').innerHTML = wideHeadHTML(el, m);
    const body = wideEl.querySelector('.mg-body');
    body.innerHTML = wideBodyHTML(el, m, wideFit);
    const fit = fitRows();
    if (fit !== wideFit) { wideFit = fit; body.innerHTML = wideBodyHTML(el, m, fit); }
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

  // ── Both ──────────────────────────────────────────────────────────────

  /** Everything in Month drawn where it belongs, from the bundle as it is. */
  function follow() {
    for (const el of host.stack()) paintSmall(el);
    paintWide();
  }
  /** One card's month again (its days, its parishes), and the bundle asked for the big month shown. */
  async function paint(el) {
    if (!el || !el._month) { follow(); return; }
    paintSmall(el);
    paintWide();
    if (wideFor !== el) return;
    // A big month further out than the bundle holds fills in once it has it,
    // quietly: its days drawn, faded until their services are in.
    const m = shownMonth(el);
    if (!host.holds(pastEnd(m))) {
      wideEl.classList.add('waiting');
      try { await host.ensure(pastEnd(m)); } catch (err) { console.warn(err); }
      if (!el._month || shownMonth(el) !== m || wideFor !== el) return;
      paintWide();
      wideEl.classList.remove('waiting');
    }
    // The month after, asked for now, so that › shows it at once.
    const next = addMonths(m, 1);
    if (next <= lastMonth()) host.ensure(pastEnd(next)).catch(() => {});
  }
  /** The day the list is on, as it scrolls: the month open in the week bar brought to its month. Nothing is marked (Kevin, 7 Nov 2026). */
  function mark(el, k) {
    const box = smallOf(el);
    if (!box) return;
    const months = box.querySelector('.mg-months');
    const shown = months.children[Math.round(months.scrollLeft / Math.max(1, months.clientWidth))];
    if (!shown || shown.dataset.m !== monthOf(k)) showMonth(el, box, monthOf(k), true);
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
      Promise.resolve(host.pick(el, host.today())).then(() => paint(el));
      return true;
    }
    // Notices changes the dots, not the list.
    if (t.closest('[data-mg-notices]')) { el._notices = !host.notices(el); host.redot(el); paint(el); return true; }
    if (t.closest('[data-mg-map]')) { host.setMonth(el, false); return true; }
    if ((b = t.closest('[data-mg-view]'))) { host.setView(b.dataset.mgView); return true; }
    if ((b = t.closest('[data-mg-layer]'))) {
      const off = el._off || (el._off = new Set());
      const id = b.dataset.mgLayer;
      if (off.has(id)) off.delete(id); else off.add(id);
      // Its state at once; the list, and the days, as they come.
      syncTools(box.querySelector('.mg-tools') || box, el);
      host.refresh(el);
      return true;
    }
    if ((b = t.closest('[data-mg-day]'))) {
      // The list goes to it; in the week bar, the month closes back to the week
      // (host.pick); in the Month view it stays, the list under it from that day.
      host.pick(el, b.dataset.mgDay);
      return true;
    }
    return box.contains(t);
  }

  root.NextMonth = { init, paint, follow, click, mark };
})(window);
