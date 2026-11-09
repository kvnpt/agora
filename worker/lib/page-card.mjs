// The card a link opens, painted by the Worker.
//
// A link to a parish (/sgr), an event (/102) or a collection (/en) opens a
// card over the page, which next.js draws once it has the bundle. Until then,
// and for a reader that runs no JavaScript (a search engine), the Worker paints
// that card into the page itself: the same sheet, in the same class names
// (public/next/next.css), with what the card says — the parish's names and
// address, its buttons, its service times, what is coming up, its details; an
// event's when and where; a collection's parishes and their times. next.js
// takes its place the moment it opens its own (pushSheet), with no slide.
//
// The page leaves a mark for it: <!--page:card--> inside #sheets. While a card
// painted here is up, the page's scrim shows under it (next.css, .ssr).
//
// What the two cards read is shared: the timetable's lines are
// public/shared/timetable-lines.js, the source lines source-line.js, a
// collection's look collections.js. The markup is written twice, here and in
// next.js, and is kept to what a first paint needs: nothing here is a control
// that needs the page's script, except Close, which is a link home.
//
// PURE: models in (lite-page.mjs liteModel, lite-timetable.mjs timetableModel),
// markup out.

import services from '../../public/shared/services.js';
import eventTypes from '../../public/shared/event-types.js';
import jurisColors from '../../public/shared/jurisdiction-colors.js';
import sourceLine from '../../public/shared/source-line.js';
import lines from '../../public/shared/timetable-lines.js';
import collections from '../../public/shared/collections.js';
import languages from '../../public/shared/languages.js';
import ruleFilters from '../../public/shared/timetable.js';
import linkify from '../../public/shared/linkify.js';
import { localDateOf, localPartsOf } from '../../public/shared/tz.mjs';
import { mapsHref } from './lite-page.mjs';

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const DAY = 86400000;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WD_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const JURIS_LONG = {
  greek: 'Greek Orthodox', antiochian: 'Antiochian Orthodox', serbian: 'Serbian Orthodox',
  russian: 'Russian Orthodox', romanian: 'Romanian Orthodox', macedonian: 'Macedonian Orthodox',
};
const JURIS_SHORT = (j) => (JURIS_LONG[j] ? JURIS_LONG[j].split(' ')[0] : '');
/** The days a parish's card lists, as next.js's CU_DAYS. */
export const CARD_DAYS = 14;

// next.js's icons, the few a first paint shows.
const I = {
  x: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  place: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"/></svg>',
  phone: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="currentColor"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1z"/></svg>',
  globe: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/></svg>',
  cross: '<svg viewBox="0 0 40 64" aria-hidden="true" fill="currentColor"><rect x="17" y="0" width="6" height="64" rx="1"/><rect x="9" y="9" width="22" height="5" rx="1"/><rect x="2" y="21" width="36" height="6" rx="1"/><rect x="9" y="44" width="22" height="5" rx="1" transform="rotate(20 20 46.5)"/></svg>',
  live: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="2.3" fill="currentColor" stroke="none"/><path d="M8.3 8.3a5.2 5.2 0 0 0 0 7.4M15.7 8.3a5.2 5.2 0 0 1 0 7.4M5.4 5.4a9.3 9.3 0 0 0 0 13.2M18.6 5.4a9.3 9.3 0 0 1 0 13.2"/></svg>',
  heart: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 20s-7.5-4.6-7.5-10.2A4.3 4.3 0 0 1 12 7.3a4.3 4.3 0 0 1 7.5 2.5C19.5 15.4 12 20 12 20z"/></svg>',
  chev: '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3a4.5 4.5 0 0 0-6.4-6.4l-1 1M14 10a4.5 4.5 0 0 0-6.4 0l-3 3a4.5 4.5 0 0 0 6.4 6.4l1-1"/></svg>',
  // An event's what, when and where (next.js eventFactsHTML).
  cal: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  where: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 21s-6.5-6.4-6.5-11.3a6.5 6.5 0 0 1 13 0C18.5 14.6 12 21 12 21z"/><circle cx="12" cy="9.7" r="2.3"/></svg>',
  chat: '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.4 8.4 0 0 1-12.3 7.5L3 21l2-5.4A8.5 8.5 0 1 1 21 11.5z"/></svg>',
};
const MOON = '<svg class="moon" viewBox="0 0 10 10" width="10" height="10" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M8.5,5 A3.5,3.5 0 1,0 1.5,5 A3.5,3.5 0 1,0 8.5,5Z M9.1,4.5 A2.9,2.9 0 1,0 3.3,4.5 A2.9,2.9 0 1,0 9.1,4.5Z"/></svg>';
const EVENING = `<div class="eve">${MOON}<span>Evening</span></div>`;

// ── small things, as next.js has them ──────────────────────────────────

const hm12 = (hm) => {
  if (!hm) return '';
  const [h, m] = hm.split(':').map(Number);
  return m ? `${h % 12 || 12}:${String(m).padStart(2, '0')}${h >= 12 ? 'pm' : 'am'}` : `${h % 12 || 12}${h >= 12 ? 'pm' : 'am'}`;
};
function timeHTML(hm) {
  if (!hm) return '';
  const [h, m] = hm.split(':').map(Number);
  const mm = m ? `<span class="t-min">:${String(m).padStart(2, '0')}</span>` : '';
  return `<span class="t-time">${h % 12 || 12}${mm}<span class="t-mer">${h >= 12 ? 'pm' : 'am'}</span></span>`;
}
const addDays = (k, n) => new Date(Date.parse(`${k}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
function dayLabel(k, today) {
  const d = new Date(`${k}T00:00:00Z`);
  const base = `${WD_LONG[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
  return k === today ? `Today · ${base}` : k === addDays(today, 1) ? `Tomorrow · ${base}` : base;
}
/** "Thursday 19 November", with its year when it is not this one (next.js fullDate). */
function fullDate(k, today) {
  const d = new Date(`${k}T00:00:00Z`);
  return `${WD_LONG[d.getUTCDay()]} ${d.getUTCDate()} ${MONTH_LONG[d.getUTCMonth()]}${k.slice(0, 4) === today.slice(0, 4) ? '' : ` ${k.slice(0, 4)}`}`;
}
/**
 * An event's day and time, a line each, as next.js's eventWhen says them:
 * "Today · Monday 9 November" over "6:30pm – 8:30pm"; over days, the span
 * over each end's time and day. `start` and `last` are { date, time }.
 */
export function eventWhen(start, last, overDays, today) {
  if (overDays) {
    const a = new Date(`${start.date}T00:00:00Z`), b = new Date(`${last.date}T00:00:00Z`);
    const from = start.date.slice(0, 7) === last.date.slice(0, 7) ? `${WD_LONG[a.getUTCDay()]} ${a.getUTCDate()}` : fullDate(start.date, today);
    return { day: `${from} – ${fullDate(last.date, today)}`, time: `${hm12(start.time)} ${WD[a.getUTCDay()]} – ${hm12(last.time)} ${WD[b.getUTCDay()]}` };
  }
  const rel = start.date === today ? 'Today · ' : start.date === addDays(today, 1) ? 'Tomorrow · ' : '';
  return { day: rel + fullDate(start.date, today), time: `${hm12(start.time)}${last && last.time ? ` – ${hm12(last.time)}` : ''}` };
}
function roundel(kind, big) {
  const c = eventTypes.kindColors(kind || 'other', false);
  const l = eventTypes.eventTypeLabel(kind || 'other');
  return `<span class="roundel${big ? ' big' : ''}" style="--k-bg:${c.bg};--k-fg:${c.fg}" title="${esc(l)}" aria-label="${esc(l)}">${esc(l[0])}</span>`;
}
/** A kind in its roundel's colours, said in full, as next.js's kindPill. */
function kindPill(kind) {
  const c = eventTypes.kindColors(kind || 'other', false);
  return `<span class="kpill" style="--k-bg:${c.bg};--k-fg:${c.fg}">${esc(eventTypes.eventTypeLabel(kind || 'other'))}</span>`;
}
function avatar(p, cls, color) {
  const tag = esc(String(p.acronym || p.name || '?').slice(0, 3));
  return `<span class="av ${cls}" style="--j:${color}">${p.logo_path ? `<img src="${esc(p.logo_path)}" alt="">` : ''}<b>${tag}</b></span>`;
}
const tel = (s) => String(s).replace(/[^\d+]/g, '');
const TOMB = { cancelled: 'Cancelled', combined: 'Combined', break: 'Break' };
const shown = (e) => !e.is_tombstone && (!e.status || e.status === 'approved') && !e.break_from && !e.combined_into_event_id;
const endMs = (e) => (e.end_utc ? Date.parse(e.end_utc) : Date.parse(e.start_utc) + (e.event_type === 'liturgy' ? 2 : 1.25) * 3600000);

/** Apple's toolbar, as a first paint has it: the title, and Close as a link home. */
function glassBar(title, sub) {
  return `<div class="glassbar">
      <span class="gbtn-sp"></span>
      <div class="gtitle"><b>${esc(title)}</b>${sub ? `<small>${esc(sub)}</small>` : ''}</div>
      <a class="gbtn" href="/" aria-label="Close">${I.x}</a>
    </div>`;
}
const COPY_ICON = '<svg class="url-copy" viewBox="0 0 256 256" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M216 32H88a8 8 0 0 0-8 8v40H40a8 8 0 0 0-8 8v128a8 8 0 0 0 8 8h128a8 8 0 0 0 8-8v-40h40a8 8 0 0 0 8-8V40a8 8 0 0 0-8-8m-56 176H48V96h112Zm48-48h-32V88a8 8 0 0 0-8-8H96V48h112Z"/></svg>';
/** The card's link, as its chip shows it: the host faint, then the path; a parish's in its colour. */
function linkChipHTML(origin, path, color = null) {
  const host = new URL(origin).host.replace(/^www\./, '');
  const segs = path.split('/').filter(Boolean).map(seg => `<span class="url-sep">/</span><span class="url-seg${color ? ' url-parish' : ''}"${color ? ` style="color:${color}"` : ''}>${esc(seg)}</span>`);
  return `<div class="sheet-link"><span class="url-chip"><span class="url-text"><span class="url-host">${esc(host)}</span>${segs.join('')}</span>${COPY_ICON}</span></div>`;
}
/** The dotted Add, which asks what to add once the page's script is up; before, the way to suggest it. */
const addBox = (pid, label) => `<a class="add-box" href="/admin?suggest=${encodeURIComponent(pid)}" rel="nofollow" aria-label="${esc(label)}">Add<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg></a>`;
const sheet = (cls, label, style, html) =>
  `<section class="sheet ${cls} open ssr" role="dialog" aria-label="${esc(label)}"${style ? ` style="${style}"` : ''}>${html}</section>`;

/** A parish's service times, compact on a collection's card, with its languages on its own. */
export function timetableHTML(rules, { today, color, compact = false } = {}) {
  const ls = lines.linesOf(rules.filter(r => lines.isLive(r, today)), { today });
  if (!ls.length) return '';
  const eve = ls.findIndex(l => l.evening);
  const out = ls.map((l, i) => {
    const langs = compact ? [] : ruleFilters.serviceLangs(l.r) || [];
    return `${i === eve ? EVENING : ''}<div class="tt-line">
        <span class="tt-days">${esc((l.q ? `${l.q} ` : '') + lines.dayList(l.days))}</span>
        ${timeHTML(l.r.start_time)}
        <span class="tt-what">${roundel(l.r.event_type)}<span class="tt-title">${esc(l.r.title)}${langs.length ? `<span class="tt-lang">${esc(langs.map(languages.shortOf).join(', '))}</span>` : ''}${l.range ? `<span class="tt-range">${esc(l.range)}</span>` : ''}${(l.notes || []).map(n => `<span class="tt-range tt-except">${esc(n)}</span>`).join('')}</span></span>
      </div>`;
  });
  return `<div class="tt${compact ? ' compact' : ''}" style="--pc:${color}">${out.join('')}</div>`;
}

// ── a parish ─────────────────────────────────────────────────────────────

function eventRowHTML(e, here, { now = false, same = false, tint = null, current = null } = {}) {
  const tomb = TOMB[e.status] || null;
  // Its own languages first on the line under its name, then another parish's name.
  const langs = ruleFilters.serviceLangs(e) || [];
  const lang = langs.length ? `<span class="elang">${esc(langs.map(languages.shortOf).join(', '))}</span>` : '';
  // Held here for another parish, it names its host.
  const away = e.parish_id !== here ? `<span class="esub">${lang}<span>${here && e.location_parish_id === here ? 'Hosted by ' : ''}${esc(e.parish_name || '')}</span></span>`
    : lang ? `<span class="esub">${lang}</span>` : '';
  // No roundel: its kind is a word under its time where its name does not say it (next.js eventRow).
  const kind = eventTypes.rowWord(e.event_type);
  // The date an event's card is open on, first in its Calendar, outlined.
  const cur = current != null && String(current) === String(e.id);
  return `<a class="erow${now ? ' now' : ''}${tomb ? ` tomb ${esc(e.status)}` : ''}${cur ? ' cur' : ''}" href="/${esc(e.id)}"${cur ? ' aria-current="true"' : ''}${tint ? ` style="--pc:${esc(tint)}"` : ''}>
      <span class="etime${same ? ' same' : ''}">${now ? '<i class="live"></i>Now' : timeHTML(e._local.time)}${kind ? `<span class="ekind" style="color:${eventTypes.kindColors(e.event_type, false).fg}">${esc(kind)}</span>` : ''}</span>
      <span class="ebody"><span class="etitle-row"><span class="etitle">${esc(e.title)}</span>${tomb ? `<span class="etomb">${esc(tomb)}</span>` : ''}</span>
        ${e.feast ? `<span class="efeast">${esc(e.feast)}</span>` : ''}
        ${away}
        ${tomb && e.break_note ? `<span class="enote">${esc(e.break_note)}</span>` : ''}</span>
      ${e.poster_path ? `<img class="ethumb" src="${esc(e.poster_path)}" alt="" loading="lazy">` : ''}
    </a>`;
}

/**
 * A day's rows by their time: those at one time on one stretch of the rule,
 * the time said once (next.js slotsHTML). `tintOf` (a collection's): each row
 * its own stretch, in the colour of the jurisdiction it is held in.
 */
const slotsHTML = (rows, here, tintOf = null, current = null) => lines.slotsOf(rows, e => e._local.time)
  .map(s => `<div class="slot${tintOf ? ' rows' : ''}">${s.rows.map((e, i) => eventRowHTML(e, here, { same: i > 0, tint: tintOf && tintOf(e), current })).join('')}</div>`).join('');

/** A list's days, each under its header, morning then evening, as next.js's daysHTML. */
function daysListHTML(list, m, today, current = null) {
  const byDay = new Map();
  for (const e of list) {
    if (!byDay.has(e._local.date)) byDay.set(e._local.date, []);
    byDay.get(e._local.date).push(e);
  }
  return [...byDay.keys()].sort().map(k => {
    const es = byDay.get(k);
    const evening = es.filter(e => services.partOfDayOf(e, m.zone) === 'evening');
    const morning = es.filter(e => !evening.includes(e));
    const sun = new Date(`${k}T00:00:00Z`).getUTCDay() === 0;
    return `<section class="sday" data-date="${k}"><h3 class="dh${sun ? ' sun' : ''}"><span>${esc(dayLabel(k, today))}</span></h3>${slotsHTML(morning, m.parish.id, null, current)}${evening.length ? EVENING + slotsHTML(evening, m.parish.id, null, current) : ''}</section>`;
  }).join('');
}

/** Coming up on a parish's card: its days from `start`, morning then evening, tombstones struck through. */
function comingUpHTML(m, start, today) {
  const end = addDays(start, CARD_DAYS);
  const list = (m.feed || []).filter(e => (shown(e) || TOMB[e.status]) && e._local.date >= start && e._local.date < end
    && endMs(e) > m.now);
  return daysListHTML(list, m, today) || '<div class="tt-none sm">Nothing on file for these days.</div>';
}

/**
 * A parish's Today, above its timetable, as next.js's todayHTML draws it:
 * with something on now, "Happening now" and then "Later today"; with nothing
 * on now, the rest of the day under the box's title, "This evening" when it
 * all is; once the day is done, tomorrow, titled so. A day with both has the
 * Evening divider. Its button goes on to the card's Coming up. Nothing today
 * or tomorrow is no box.
 */
function todayBoxHTML(m, today) {
  const all = (m.feed || []).filter(shown);
  const isEvening = (e) => services.partOfDayOf(e, m.zone) === 'evening';
  const live = all.filter(e => Date.parse(e.start_utc) <= m.now && endMs(e) > m.now);
  const later = all.filter(e => Date.parse(e.start_utc) > m.now && e._local.date === today);
  const tomorrow = all.filter(e => e._local.date === addDays(today, 1));
  let day = false, eve = false;
  const rows = (es, now) => es.map(e => {
    let div = '';
    if (!isEvening(e)) day = true;
    else if (!eve) { eve = true; if (day) div = EVENING; }
    return div + eventRowHTML(e, m.parish.id, { now });
  }).join('');
  let title = 'Today', k = today, body = '';
  const showsTomorrow = !live.length && !later.length && tomorrow.length > 0;
  if (!live.length && !later.length && !showsTomorrow) return '';
  if (live.length) {
    body += `<div class="tsub">Happening now</div>${rows(live.slice(0, 4), true)}`;
    if (later.length) body += `<div class="tsub">Later today</div>${rows(later.slice(0, 3))}`;
  } else if (later.length) {
    if (later.every(isEvening)) title = 'This evening';
    body += rows(later.slice(0, 5));
  } else if (showsTomorrow) {
    title = 'Tomorrow';
    k = addDays(today, 1);
    body += rows(tomorrow.slice(0, 4));
  }
  const d = new Date(`${k}T00:00:00Z`);
  return `<section class="today card ptoday" aria-label="Today" style="--pc:${m.color}">
      <header class="card-head"><div><h2>${title}</h2><p>${WD_LONG[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}</p></div></header>
      ${body}
      <a class="see-all" href="#coming-up">${showsTomorrow ? 'This week' : 'Tomorrow'} ${I.chev}</a>
    </section>`;
}

/** The line under a parish's buttons: next Liturgy (or anything; nothing, no Next), languages, jurisdiction. */
function summaryHTML(m, today) {
  const ahead = (m.feed || []).filter(e => shown(e) && Date.parse(e.start_utc) > m.now);
  const next = ahead.find(e => e.event_type === 'liturgy') || ahead[0] || null;
  let nextCell = '';
  if (next) {
    const k = next._local.date;
    const d = new Date(`${k}T00:00:00Z`);
    const near = Date.parse(k) - Date.parse(today) < 6 * DAY;
    const when = `${esc(k === today ? 'Today' : near ? WD[d.getUTCDay()] : `${d.getUTCDate()} ${MON[d.getUTCMonth()]}`)}<br>${esc(hm12(next._local.time))}`;
    nextCell = `<div class="sum"><small>Next ${esc(eventTypes.eventTypeLabel(next.event_type))}</small><b class="ok">${when}</b></div>\n      `;
  }
  // What its services are tagged with; none tagged, no box.
  const langs = ruleFilters.parishLangsOf(m.rules.filter(r => lines.isLive(r, today)));
  return `${nextCell}${langs.length ? `<div class="sum"><small>Languages</small><b>${esc(langs.slice(0, 2).join(' · '))}</b></div>` : ''}
      <a class="sum sum-link" href="/${esc(m.parish.jurisdiction || '')}"><small>Jurisdiction</small><b style="color:${m.color}">${esc(JURIS_SHORT(m.parish.jurisdiction) || m.parish.jurisdiction || '')}</b></a>`;
}

/** A parish's card, as next.js's openParish draws it. */
/** One of a card's buttons that leaves the site: a website, a stream, a page to give on. */
const outBtn = (href, icon, label) => `<a class="abtn" href="${esc(href)}" target="_blank" rel="noopener">${icon}<span>${esc(label)}</span></a>`;

export function parishCardHTML(m) {
  const p = m.parish;
  const today = localDateOf(m.zone, m.now);
  const start = m.route.dateFocus && m.route.dateFocus > today ? m.route.dateFocus : today;
  const gmaps = mapsHref(p);
  const times = timetableHTML(m.rules, { today, color: m.color });
  const website = p.website ? p.website.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '') : '';
  // Its own links, a festival or a youth group's page, small under the buttons; Donate stays among them.
  const own = (m.links || []).filter(l => l.url);
  return sheet('parish', p.name, `--j:${m.color}`, `${glassBar(p.name, JURIS_LONG[p.jurisdiction])}
    <div class="sheet-scroll">
      <div class="ph">${avatar(p, 'xl', m.color)}<div class="ph-text"><h1>${esc(p.full_name || p.name)}</h1><p>${esc(p.address || '')}</p></div></div>
      ${linkChipHTML(m.origin, `/${m.slug}${start !== today ? `/${start}` : ''}`, m.color)}
      <div class="actions">
        ${gmaps ? `<a class="abtn primary" href="${esc(gmaps)}" target="_blank" rel="noopener">${I.place}<span>Google Maps</span></a>` : ''}
        ${p.phone ? `<a class="abtn" href="tel:${esc(tel(p.phone))}">${I.phone}<span>Call</span></a>` : ''}
        ${p.website ? outBtn(p.website, I.globe, 'Website') : ''}
        ${p.live_url ? outBtn(p.live_url, I.live, 'Watch live') : ''}
        ${p.donation_url ? outBtn(p.donation_url, I.heart, 'Donate') : ''}
      </div>
      ${own.length ? `<div class="p-links">${own.map(l => `<a class="lbtn" href="${esc(l.url)}" target="_blank" rel="noopener">${I.link}<span>${esc(l.label || l.slug)}</span></a>`).join('')}</div>` : ''}
      <div class="summary">${summaryHTML(m, today)}</div>
      ${todayBoxHTML(m, today)}
      <div class="p-details"><h2 class="sec"><span>Details</span></h2>
        <div class="details">
          ${p.phone ? `<div class="drow"><small>Phone</small><a href="tel:${esc(tel(p.phone))}">${esc(p.phone)}</a></div>` : ''}
          ${website ? `<div class="drow"><small>Website</small><a href="${esc(p.website)}" target="_blank" rel="noopener">${esc(website)}</a></div>` : ''}
          ${p.email ? `<div class="drow"><small>Email</small><a href="mailto:${esc(p.email)}">${esc(p.email)}</a></div>` : ''}
          ${p.address ? `<div class="drow"><small>Address</small><span>${esc(p.address)}</span></div>` : ''}
        </div>
        ${sourceLine.detailsSourceHTML(p, { cls: 'src-line', now: m.now })}</div>
      <h2 class="sec">Timetable</h2>
      <div class="p-times">${times || `<div class="tt-none">No service times on file yet.${p.website ? ' The parish website is the best place to check.' : ''}</div>`}
        ${sourceLine.timetableSourceHTML(m.rules, { cls: 'src-line', now: m.now })}
        ${addBox(p.id, 'Add a service time')}</div>
      <section class="cu-band" id="coming-up">
        ${calHeadHTML(start, today)}
        <div class="cu" style="--pc:${m.color}">${comingUpHTML(m, start, today)}</div>
        ${addBox(p.id, 'Add an event')}
      </section>
    </div>`);
}

// ── an event ─────────────────────────────────────────────────────────────

/** An event's card, as next.js's openEvent draws it: the pinned event of the model. */
// What the veil over an off event's poster and words says (public/next/next.js).
const OFF_SAYS = { cancelled: 'This event has been cancelled', combined: 'Combined with another event', break: 'On a break', hidden: 'Suppressed' };
// Past a few, an event's parishes fold under a fade until Show all, as next.js's parishFold.
const PARISH_FOLD = 4;
const parishFold = (n, list) => (n > PARISH_FOLD
  ? `<section class="ev-parishes folded">${list}<label class="ctimes-open"><input type="checkbox" hidden><span>Show all ${n} parishes</span>${I.chev}</label></section>`
  : list);
export function eventCardHTML(m) {
  const e = m.pinned;
  const p = m.parish;
  const today = localDateOf(m.zone, m.now);
  const last = e.end_local ? { date: String(e.end_local).slice(0, 10), time: String(e.end_local).slice(11, 16) }
    : e.end_utc ? localPartsOf(e.timezone || m.zone, Date.parse(e.end_utc)) : null;
  const end = last ? last.time : null;
  // Over days (a weekend camp), each end says its day. A vigil past midnight is one night.
  const overDays = last && e.end_utc && last.date > e._local.date && Date.parse(e.end_utc) - Date.parse(e.start_utc) >= 12 * 3600000;
  const venue = e.location_parish_id && e.location_parish_id !== e.parish_id && m.venues[e.location_parish_id];
  // Where: a place of its own, the church it is held in (its name over its address), or its parish's.
  const where = e.location_override ? esc(e.location_override)
    : venue ? `<b>${esc(venue.name)}</b>${venue.address ? `<small>${esc(venue.address)}</small>` : ''}` : esc(p.address || '');
  // Every parish it is at, once each, as next.js's eventParishes lists them.
  const seen = new Set([p.id]);
  const parishes = [{ ...p, slug: m.slug, color: m.color, role: 'Hosting' }];
  for (const [id, role] of [[venue && e.location_parish_id, 'Held here'], ...(e.combined_parishes || []).map(id => [id, 'Taking part'])]) {
    if (!id || seen.has(id) || !m.venues[id]) continue;
    seen.add(id);
    parishes.push({ ...m.venues[id], role });
  }
  const lat = e.location_lat ?? e.lat ?? p.lat, lng = e.location_lng ?? e.lng ?? p.lng;
  const off = TOMB[e.status] || (e.status === 'hidden' ? 'Suppressed' : null);
  // Off, a quiet veil over the poster and the words, which still say it is on.
  const offCls = off ? ` off ${esc(e.status)}` : '';
  const stamp = off ? `<span class="off-veil"><span>${esc(OFF_SAYS[e.status] || off)}</span></span>` : '';
  // What it is said in: a service's own tags, never its parish's.
  const langs = ruleFilters.serviceLangs(e) || [];
  // With no poster, a band in the colour of the jurisdiction it is held in:
  // its kind said in full at the head, the church by logo and full name at the foot.
  const at = venue ? { ...venue, id: e.location_parish_id } : { ...p, slug: m.slug, color: m.color };
  const band = `<div class="ev-band${offCls}" style="--j:${at.color}">
        <span class="ev-band-kind">${kindPill(e.event_type)}</span>
        <a class="ev-at" href="/${esc(at.slug)}">${avatar(at, '', at.color)}<span class="ev-at-name">${esc(at.full_name || at.name)}</span></a>${stamp}</div>`;
  // Said in the band, the kind is not said again over the title.
  const kind = e.poster_path ? kindPill(e.event_type) : '';
  return sheet('event', e.title, '', `${glassBar(e.title, p.name)}
    <div class="sheet-scroll">
      ${e.poster_path ? `<a class="ev-poster${offCls}" href="${esc(e.poster_path)}" target="_blank" rel="noopener" aria-label="The poster, full size"><img src="${esc(e.poster_path)}" alt="">${stamp}</a>` : band}
      <div class="ev-head${off ? ` off ${esc(e.status)}` : ''}">
        ${off || kind ? `<div class="ev-kind">${off ? `<span class="ev-off">${esc(off)}</span>` : ''}${kind}</div>` : ''}
        <h1>${esc(e.title)}</h1>
        ${e.feast ? `<p class="ev-sub">${esc(e.feast)}</p>` : ''}
        ${eventFactsHTML(eventWhen(e._local, end ? last : null, overDays, today), where, langs)}
        ${off && e.break_note ? `<p class="ev-note">${esc(e.break_note)}</p>` : ''}
      </div>
      ${linkChipHTML(m.origin, `/${e.id}`)}
      <div class="actions">
        ${lat && lng ? `<a class="abtn primary" href="${esc(mapsHref({ lat, lng }))}" target="_blank" rel="noopener">${I.place}<span>Google Maps</span></a>` : ''}
        ${!e.hide_live && p.live_url ? outBtn(p.live_url, I.live, 'Watch live') : ''}
        <a class="abtn" href="/${esc(m.slug)}">${avatar(p, 'xs', m.color)}<span>Parish</span></a>
      </div>
      ${e.description ? (off ? `<div class="ev-desc${offCls}">${stamp}<div class="ev-desc-text">${linkify.linkify(e.description).replace(/\n/g, '<br>')}</div></div>`
        : `<div class="ev-desc">${linkify.linkify(e.description).replace(/\n/g, '<br>')}</div>`) : ''}
      ${parishes.length > 1 ? `<h2 class="sec">Parishes</h2>${parishFold(parishes.length, `<div class="lists">${parishes.map(x => `<a class="lrow" href="/${esc(x.slug)}">${avatar(x, 'sm', x.color)}
        <span class="ln"><b>${esc(x.name)}</b><small>${esc(x.role)}</small></span>${I.chev}</a>`).join('')}</div>`)}` : ''}
      <div class="ev-cal-box">${eventCalendarHTML(m, today)}</div>
    </div>`);
}
/** Under an event's title: its day, time, place and languages, a line each with its sign (next.js eventFactsHTML). `where` is markup. */
function eventFactsHTML(when, where, langs) {
  return `<div class="ev-facts">
          <p class="ev-fact ev-day">${I.cal}<span>${esc(when.day)}</span></p>
          <p class="ev-fact ev-time">${I.clock}<span>${esc(when.time)}</span></p>
          ${where ? `<p class="ev-fact ev-where">${I.where}<span>${where}</span></p>` : ''}
          ${langs.length ? `<p class="ev-fact ev-langs">${I.chat}<span>${esc(langs.join(', '))}</span></p>` : ''}
        </div>`;
}
/** As next.js's MATCH_CAP: the dates a Calendar lists after the one open. */
const CAL_AFTER = 10;
/**
 * A date of a regular service has its Calendar under it, as next.js's
 * calendarHTML: that date first, outlined, then its line's dates after it
 * (the rules a timetable line holds together, as the page finds them), as
 * far as the card's window reads. A one-off has none here, nor a date with
 * none after it.
 */
function eventCalendarHTML(m, today) {
  const e = m.pinned;
  if (e.schedule_id == null) return '';
  const line = lines.linesOf((m.rules || []).filter(r => lines.isLive(r, today)), { today })
    .find(l => l.ids.some(id => String(id) === String(e.schedule_id)));
  const ids = new Set((line ? line.ids : [e.schedule_id]).map(String));
  const t0 = Date.parse(e.start_utc);
  const after = (m.feed || []).filter(x => x.schedule_id != null && ids.has(String(x.schedule_id)) && String(x.id) !== String(e.id)
    && (shown(x) || TOMB[x.status]) && endMs(x) > m.now && Date.parse(x.start_utc) > t0).slice(0, CAL_AFTER);
  if (!after.length) return '';
  return `<section class="cu-band ev-cal">
        <h2 class="sec">Calendar</h2>
        <div class="cu" style="--pc:${m.color}">${daysListHTML([e, ...after], m, today, e.id)}</div>
      </section>`;
}

// ── a collection ─────────────────────────────────────────────────────────

/**
 * A collection's card, as next.js's openCollection draws it: its hero in its
 * look, then its parishes, each with its timetable, folded behind a stack of
 * their logos (a checkbox in its label, so it opens with no script). `rules` is every active rule, since a
 * card shows a parish's whole week. What is coming up under them is the
 * page's to add, once it holds the occurrences. `map`: the room at its top
 * the page's map moves into (next.js mapToCard), kept so nothing jumps
 * when it comes; the lite version has no map.
 */
export function collectionCardHTML(m, { rules, limit = 30, feed = null, parishes = [], map = false } = {}) {
  const c = m.collection;
  const colorOf = (j) => jurisColors.jurisdictionColorFrom(m.overrides, j);
  // The Calendar's rows each in the colour of where they are held: the venue
  // parish's jurisdiction (any parish, not only the collection's), else their own.
  const byId = new Map(parishes.map(p => [p.id, p]));
  const venueColor = (e) => { const v = e.location_parish_id && byId.get(e.location_parish_id); return colorOf(v ? v.jurisdiction : e.jurisdiction); };
  const look = collections.lookOf(c, colorOf);
  // A link that narrows the rules (/sun/liturgy, /en) shows the lines that
  // answer it, as the page's card does (next.js timetable's `only`); one that
  // does not (/greek, /monasteries) each parish's whole week but its Parish
  // only lines, which only a link naming the parish shows (/smg+sgr; ruleMatches).
  const byParish = new Map();
  const named = new Set((m.named || []).map(p => p.id));
  const shown = m.listsAll ? rules.filter(r => !r.parish_scoped || named.has(r.parish_id))
    : m.groups.flatMap(g => g.juris.flatMap(j => j.parishes.flatMap(x => x.rules)));
  for (const r of shown) {
    if (!byParish.has(r.parish_id)) byParish.set(r.parish_id, []);
    byParish.get(r.parish_id).push(r);
  }
  const ps = m.groups.flatMap(g => g.juris.flatMap(j => j.parishes.map(x => x.parish)));
  const todayOf = (p) => localDateOf(p.timezone || 'Australia/Sydney', m.now);
  // One list, those with times and those without together (Kevin, 29 Oct
  // 2026): by name here, where the page has them by distance.
  ps.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const item = (p) => {
    const color = colorOf(p.jurisdiction);
    const tt = timetableHTML(byParish.get(p.id) || [], { today: todayOf(p), color, compact: true });
    const langs = ruleFilters.parishLangsOf((byParish.get(p.id) || []).filter(r => lines.isLive(r, todayOf(p))));
    const slug = String(p.acronym || p.id).toLowerCase().replace(/\s+/g, '');
    return `<article class="citem">
        <a class="citem-head" href="/${esc(slug)}">${avatar(p, 'md', color)}
          <span class="citem-t"><b>${esc(p.name)}</b><small>${esc(JURIS_SHORT(p.jurisdiction))}${langs.length ? ` · ${esc(langs.slice(0, 2).join(', '))}` : ''}</small></span></a>
        ${tt}
      </article>`;
  };
  return sheet(map ? 'collection has-map' : 'collection', c.title, '', `${glassBar(c.title, `${ps.length} places`)}
    <div class="sheet-scroll">${map ? '<div class="card-map" aria-hidden="true"></div>' : ''}
      <div class="chero${look.tint ? ' soft' : ''}" style="${esc(collections.lookStyle(look))}">
        <span class="ckicker">${esc(c.kicker || '')}</span>
        <h1>${esc(c.title)}</h1>
        <p>${esc(c.blurb || '')}</p>
      </div>
      ${linkChipHTML(m.origin, c.path)}
      <section class="ctimes${ps.length > 1 ? ' stacked' : ''}">
        ${ps.length > 1 ? stackHTML(ps, colorOf) : ''}
        <div class="clist">${ps.slice(0, limit).map(item).join('') || '<div class="tt-none">Nothing here yet.</div>'}</div>
      </section>
      ${feed ? `<section class="cu-band" id="coming-up">
        ${calHeadHTML(localDateOf('Australia/Sydney', m.now), localDateOf('Australia/Sydney', m.now))}
        <div class="cu">${collectionComingUpHTML(feed, m.now, venueColor)}</div>
      </section>` : ''}
    </div>`);
}

const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/**
 * A card's Calendar, titled with the month it starts in, as the page's week
 * bar is (Kevin, 7 Nov 2026): "November", or "January 2027" out of this
 * year. Its Filters and its weeks are the page's, which need a script.
 */
const calHeadHTML = (k, today) => `<div class="cal-head"><h2 class="sec">${MONTH_LONG[+k.slice(5, 7) - 1]}${k.slice(0, 4) === today.slice(0, 4) ? '' : ` ${k.slice(0, 4)}`}</h2><div class="cal-acts"></div></div>`;
/**
 * A collection's parishes folded behind their logos, as the page's card has
 * them (next.js stackHTML): logos first, then those with times. The fold is
 * a checkbox in its label, so it opens with no script.
 */
function stackHTML(ps, colorOf) {
  const ranked = ps.slice().sort((a, b) => !!b.logo_path - !!a.logo_path);
  return `<label class="cstack"><input type="checkbox" hidden>
        <span class="stackrow">${ranked.slice(0, 5).map(p => avatar(p, 'stack', colorOf(p.jurisdiction))).join('')}</span>
        <span class="inview-text"><b>${ps.length} parishes</b><small><span class="cstack-shut">Show timetables</span><span class="cstack-open">Hide timetables</span></small></span>
        <span class="inview-go">${I.chev}</span></label>`;
}

/**
 * A collection's Coming up, for the lite version (lite-page.mjs
 * collectionFeed): its days, morning then evening, each row naming its parish.
 */
function collectionComingUpHTML(feed, now, tintOf) {
  // By each parish's own clock: 8:30 in Perth comes before 9 in Sydney.
  const list = feed.filter(e => (shown(e) || TOMB[e.status]) && endMs(e) > now)
    .sort((a, b) => a._local.time.localeCompare(b._local.time));
  const byDay = new Map();
  for (const e of list) {
    if (!byDay.has(e._local.date)) byDay.set(e._local.date, []);
    byDay.get(e._local.date).push(e);
  }
  const today = localDateOf('Australia/Sydney', now);
  const days = [...byDay.keys()].sort().map(k => {
    const es = byDay.get(k);
    const evening = es.filter(e => services.partOfDayOf(e, e.timezone || 'Australia/Sydney') === 'evening');
    const morning = es.filter(e => !evening.includes(e));
    const sun = new Date(`${k}T00:00:00Z`).getUTCDay() === 0;
    return `<section class="sday" data-date="${k}"><h3 class="dh${sun ? ' sun' : ''}"><span>${esc(dayLabel(k, today))}</span></h3>${slotsHTML(morning, null, tintOf)}${evening.length ? EVENING + slotsHTML(evening, null, tintOf) : ''}</section>`;
  });
  return days.join('') || '<div class="tt-none sm">Nothing on file this week.</div>';
}
