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
/** "Fri 13 Nov", "Today": next.js's dayLabel without `long`. */
function shortDay(k, today) {
  const d = new Date(`${k}T00:00:00Z`);
  return k === today ? 'Today' : k === addDays(today, 1) ? 'Tomorrow' : `${WD[d.getUTCDay()]} ${d.getUTCDate()} ${MON[d.getUTCMonth()]}`;
}
function roundel(kind, big) {
  const c = eventTypes.kindColors(kind || 'other', false);
  const l = eventTypes.eventTypeLabel(kind || 'other');
  return `<span class="roundel${big ? ' big' : ''}" style="--k-bg:${c.bg};--k-fg:${c.fg}" title="${esc(l)}" aria-label="${esc(l)}">${esc(l[0])}</span>`;
}
function avatar(p, cls, color) {
  const tag = esc(String(p.acronym || p.name || '?').slice(0, 3));
  return `<span class="av ${cls}" style="--j:${color}">${p.logo_path ? `<img src="${esc(p.logo_path)}" alt="">` : ''}<b>${tag}</b></span>`;
}
const langsOf = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };
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
    const langs = compact ? [] : langsOf(l.r.languages);
    return `${i === eve ? EVENING : ''}<div class="tt-line">
        <span class="tt-days">${esc((l.q ? `${l.q} ` : '') + lines.dayList(l.days))}</span>
        ${timeHTML(l.r.start_time)}
        <span class="tt-what">${roundel(l.r.event_type)}<span class="tt-title">${esc(l.r.title)}${langs.length ? `<span class="tt-lang">${esc(langs.map(languages.shortOf).join(', '))}</span>` : ''}${l.range ? `<span class="tt-range">${esc(l.range)}</span>` : ''}</span></span>
      </div>`;
  });
  return `<div class="tt${compact ? ' compact' : ''}" style="--pc:${color}">${out.join('')}</div>`;
}

// ── a parish ─────────────────────────────────────────────────────────────

function eventRowHTML(e, here, now = false) {
  const tomb = TOMB[e.status] || null;
  // Its own languages first on the line under its name, then another parish's name.
  const langs = langsOf(e.languages);
  const lang = langs.length ? `<span class="elang">${esc(langs.map(languages.shortOf).join(', '))}</span>` : '';
  // Held here for another parish, it names its host.
  const away = e.parish_id !== here ? `<span class="esub">${lang}<span>${e.location_parish_id === here ? 'Hosted by ' : ''}${esc(e.parish_name || '')}</span></span>`
    : lang ? `<span class="esub">${lang}</span>` : '';
  return `<a class="erow${now ? ' now' : ''}${tomb ? ` tomb ${esc(e.status)}` : ''}" href="/${esc(e.id)}">
      <span class="etime">${now ? '<i class="live"></i>Now' : timeHTML(e._local.time)}</span>
      ${roundel(e.event_type)}
      <span class="ebody"><span class="etitle-row"><span class="etitle">${esc(e.title)}</span>${tomb ? `<span class="etomb">${esc(tomb)}</span>` : ''}</span>
        ${away}
        ${e.feast ? `<span class="efeast">${esc(e.feast)}</span>` : ''}
        ${tomb && e.break_note ? `<span class="enote">${esc(e.break_note)}</span>` : ''}</span>
      ${e.poster_path ? `<img class="ethumb" src="${esc(e.poster_path)}" alt="" loading="lazy">` : ''}
    </a>`;
}

/** Coming up on a parish's card: its days from `start`, morning then evening, tombstones struck through. */
function comingUpHTML(m, start, today) {
  const end = addDays(start, CARD_DAYS);
  const list = (m.feed || []).filter(e => (shown(e) || TOMB[e.status]) && e._local.date >= start && e._local.date < end
    && endMs(e) > m.now);
  const byDay = new Map();
  for (const e of list) {
    if (!byDay.has(e._local.date)) byDay.set(e._local.date, []);
    byDay.get(e._local.date).push(e);
  }
  const days = [...byDay.keys()].sort().map(k => {
    const es = byDay.get(k);
    const evening = es.filter(e => services.partOfDayOf(e, m.zone) === 'evening');
    const morning = es.filter(e => !evening.includes(e));
    const sun = new Date(`${k}T00:00:00Z`).getUTCDay() === 0;
    return `<section class="sday" data-date="${k}"><h3 class="dh${sun ? ' sun' : ''}"><span>${esc(dayLabel(k, today))}</span></h3>${morning.map(e => eventRowHTML(e, m.parish.id)).join('')}${evening.length ? EVENING + evening.map(e => eventRowHTML(e, m.parish.id)).join('') : ''}</section>`;
  });
  return days.join('') || '<div class="tt-none sm">Nothing on file for these days.</div>';
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
    return div + eventRowHTML(e, m.parish.id, now);
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
  const langs = [...new Set([...m.rules.flatMap(r => langsOf(r.languages)), ...langsOf(m.parish.languages)])];
  return `${nextCell}<div class="sum"><small>Languages</small><b>${esc(langs.slice(0, 2).join(' · ') || '—')}</b></div>
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
  // Its own links, a festival or a youth group's page, small above its details; Donate stays on top.
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
      <div class="summary">${summaryHTML(m, today)}</div>
      ${todayBoxHTML(m, today)}
      <h2 class="sec">Timetable</h2>
      <div class="p-times">${times || `<div class="tt-none">No service times on file yet.${p.website ? ' The parish website is the best place to check.' : ''}</div>`}
        ${sourceLine.timetableSourceHTML(m.rules, { cls: 'src-line', now: m.now })}
        ${addBox(p.id, 'Add a service time')}</div>
      ${own.length ? `<div class="p-links">${own.map(l => `<a class="lbtn" href="${esc(l.url)}" target="_blank" rel="noopener">${I.link}<span>${esc(l.label || l.slug)}</span></a>`).join('')}</div>` : ''}
      <div class="p-details"><h2 class="sec"><span>Details</span></h2>
        <div class="details">
          ${p.phone ? `<div class="drow"><small>Phone</small><a href="tel:${esc(tel(p.phone))}">${esc(p.phone)}</a></div>` : ''}
          ${website ? `<div class="drow"><small>Website</small><a href="${esc(p.website)}" target="_blank" rel="noopener">${esc(website)}</a></div>` : ''}
          ${p.email ? `<div class="drow"><small>Email</small><a href="mailto:${esc(p.email)}">${esc(p.email)}</a></div>` : ''}
          ${p.address ? `<div class="drow"><small>Address</small><span>${esc(p.address)}</span></div>` : ''}
        </div>
        ${sourceLine.detailsSourceHTML(p, { cls: 'src-line', now: m.now })}</div>
      <section class="cu-band" id="coming-up">
        <h2 class="sec">Coming up</h2>
        <div class="cu" style="--pc:${m.color}">${comingUpHTML(m, start, today)}</div>
        ${addBox(p.id, 'Add an event')}
      </section>
    </div>`);
}

// ── an event ─────────────────────────────────────────────────────────────

/** An event's card, as next.js's openEvent draws it: the pinned event of the model. */
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
  const where = e.location_override || (venue ? `${venue.name} — ${venue.address || ''}` : p.address) || '';
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
  return sheet('event', e.title, '', `${glassBar(e.title, p.name)}
    <div class="sheet-scroll">
      ${e.poster_path ? `<a class="ev-poster" href="${esc(e.poster_path)}" target="_blank" rel="noopener" aria-label="The poster, full size"><img src="${esc(e.poster_path)}" alt=""></a>` : `<div class="ev-band" style="--j:${m.color}">${roundel(e.event_type, true)}</div>`}
      <div class="ev-head${off ? ` off ${esc(e.status)}` : ''}">
        <span class="ckicker">${off ? `<span class="ev-off">${esc(off)}</span> · ` : ''}${esc(eventTypes.eventTypeLabel(e.event_type))}${e.feast ? ` · ${esc(e.feast)}` : ''}</span>
        <h1>${esc(e.title)}</h1>
        <p class="ev-when">${overDays ? `${esc(shortDay(e._local.date, today))} ${esc(hm12(e._local.time))} – ${esc(shortDay(last.date, today))} ${esc(hm12(end))}`
          : `${esc(dayLabel(e._local.date, today))} · ${esc(hm12(e._local.time))}${end ? `–${esc(hm12(end))}` : ''}`}</p>
        ${off && e.break_note ? `<p class="ev-note">${esc(e.break_note)}</p>` : ''}
      </div>
      ${linkChipHTML(m.origin, `/${e.id}`)}
      <div class="actions">
        ${lat && lng ? `<a class="abtn primary" href="${esc(mapsHref({ lat, lng }))}" target="_blank" rel="noopener">${I.place}<span>Google Maps</span></a>` : ''}
        ${!e.hide_live && p.live_url ? outBtn(p.live_url, I.live, 'Watch live') : ''}
        <a class="abtn" href="/${esc(m.slug)}">${avatar(p, 'xs', m.color)}<span>Parish</span></a>
      </div>
      ${where ? `<div class="details"><div class="drow"><small>Where</small><span>${esc(where)}</span></div></div>` : ''}
      ${e.description ? `<div class="ev-desc">${linkify.linkify(e.description).replace(/\n/g, '<br>')}</div>` : ''}
      ${parishes.length > 1 ? `<h2 class="sec">Parishes</h2><div class="lists">${parishes.map(x => `<a class="lrow" href="/${esc(x.slug)}">${avatar(x, 'sm', x.color)}
        <span class="ln"><b>${esc(x.name)}</b><small>${esc(x.role)}</small></span>${I.chev}</a>`).join('')}</div>` : ''}
    </div>`);
}

// ── a collection ─────────────────────────────────────────────────────────

/**
 * A collection's card, as next.js's openCollection draws it: its hero in its
 * look, then its parishes, those with times first, each with its timetable,
 * folded to the first few lines until Show timetables (a checkbox in its
 * label, so it opens with no script). `rules` is every active rule, since a
 * card shows a parish's whole week. What is coming up under them is the
 * page's to add, once it holds the occurrences.
 */
export function collectionCardHTML(m, { rules, limit = 30 } = {}) {
  const c = m.collection;
  const colorOf = (j) => jurisColors.jurisdictionColorFrom(m.overrides, j);
  const look = collections.lookOf(c, colorOf);
  // A link that narrows the rules (/sun/liturgy, /en) shows the lines that
  // answer it, as the page's card does (next.js timetable's `only`); one that
  // does not (/greek, /monasteries) each parish's whole week.
  const byParish = new Map();
  const shown = m.listsAll ? rules : m.groups.flatMap(g => g.juris.flatMap(j => j.parishes.flatMap(x => x.rules)));
  for (const r of shown) {
    if (!byParish.has(r.parish_id)) byParish.set(r.parish_id, []);
    byParish.get(r.parish_id).push(r);
  }
  const ps = m.groups.flatMap(g => g.juris.flatMap(j => j.parishes.map(x => x.parish)));
  const todayOf = (p) => localDateOf(p.timezone || 'Australia/Sydney', m.now);
  const hasTimes = (p) => (byParish.get(p.id) || []).some(r => lines.isLive(r, todayOf(p)));
  ps.sort((a, b) => hasTimes(b) - hasTimes(a) || String(a.name).localeCompare(String(b.name)));
  const item = (p) => {
    const color = colorOf(p.jurisdiction);
    const tt = timetableHTML(byParish.get(p.id) || [], { today: todayOf(p), color, compact: true });
    const langs = [...new Set([...(byParish.get(p.id) || []).flatMap(r => langsOf(r.languages)), ...langsOf(p.languages)])];
    const slug = String(p.acronym || p.id).toLowerCase().replace(/\s+/g, '');
    return `<article class="citem">
        <a class="citem-head" href="/${esc(slug)}">${avatar(p, 'md', color)}
          <span class="citem-t"><b>${esc(p.name)}</b><small>${esc(JURIS_SHORT(p.jurisdiction))}${langs.length ? ` · ${esc(langs.slice(0, 2).join(', '))}` : ''}</small></span></a>
        ${tt || '<div class="tt-none sm">No service times on file yet.</div>'}
      </article>`;
  };
  return sheet('collection', c.title, '', `${glassBar(c.title, `${ps.length} places`)}
    <div class="sheet-scroll">
      <div class="chero${look.tint ? ' soft' : ''}" style="${esc(collections.lookStyle(look))}">
        <span class="ckicker">${esc(c.kicker || '')}</span>
        <h1>${esc(c.title)}</h1>
        <p>${esc(c.blurb || '')}</p>
      </div>
      ${linkChipHTML(m.origin, c.path)}
      <section class="ctimes${ps.length > 1 ? ' folded' : ''}">
        <div class="clist">${ps.slice(0, limit).map(item).join('') || '<div class="tt-none">Nothing here yet.</div>'}</div>
        ${ps.length > 1 ? `<label class="ctimes-open"><input type="checkbox" hidden><span>Show timetables</span>${I.chev}</label>` : ''}
      </section>
    </div>`);
}
