// The lite card: a shared parish or event link, answered by the Worker.
//
// A link somebody sends — /sgr, /sgr/next-tue, /sgr/liturgy, /sgr/evening,
// /sgr/services, /102, /42:2026-10-04 — used to boot the whole app before
// showing anything: the map library, the full bundle for every parish, the
// tiles, behind a loading screen. And a chat app or a search engine fetching
// the same link got an app shell with a fixed title and nothing in it. This
// page is the answer for both: the card that link is about, in the HTML itself
// — its title, description, preview image and structured data in <head>, the
// parish and its services in <body> — painting at once, readable with no
// JavaScript, and the same markup for a person and a crawler.
//
// PURE. Rows in, a model out, markup out of the model — no D1, no fetch, no
// clock except the one passed in — so `node --test` covers every line of it.
// worker/routes/pages.mjs does the reading and the caching.
//
// THE LENS IS THE APP'S. The occurrences come out of expandFrom + buildFeed,
// the same two functions public/bundle.js runs in the browser, over the same
// rows narrowed to one parish; the URL is read by url-state.js, the pin chosen
// by its firstEventOnDay. A lite card and the app's sheet cannot disagree about
// which services exist or which one a link means.
//
// It is NOT the app's renderer, and that is the honest limit of this file: the
// sheet's markup lives in app.js, a classic script the Worker cannot import,
// so the two can drift in look. They share tokens (the jurisdiction colour,
// the wording of the source line, the timetable row shape) and not code.

import services from '../../public/shared/services.js';
import dates from '../../public/shared/dates.js';
import urlState from '../../public/shared/url-state.js';
import jurisColors from '../../public/shared/jurisdiction-colors.js';
import { expandFrom } from '../../public/shared/project.mjs';
import { buildFeed } from '../../public/shared/merge.mjs';
import { localDateOf, localPartsOf } from '../../public/shared/tz.mjs';

const DAY_MS = 86400000;
/** How far a lite card looks ahead. The app is where the rest of the year lives. */
export const LITE_WINDOW_DAYS = 56;
/** The most occurrences a card lists. Enough for two months of a busy parish. */
export const LITE_LIST_CAP = 40;

const DEFAULT_ZONE = 'Australia/Sydney';

export const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** The form a parish's link takes: its acronym, or its id when it has none. */
export function parishSlug(parish) {
  const acr = String(parish.acronym || '').trim().toLowerCase().replace(/\s+/g, '');
  return acr || parish.id;
}

/**
 * The window a card reads, as UTC instants: from the parish-local day the list
 * starts on, LITE_WINDOW_DAYS on. Widened by a day at the front, because a
 * parish in Auckland is already on tomorrow when Perth is on today; the list
 * trims by LOCAL date afterwards, which is the date that means anything.
 */
export function liteWindow(fromDate) {
  const start = Date.parse(`${fromDate}T00:00:00Z`) - DAY_MS;
  return {
    fromUtc: new Date(start).toISOString(),
    toUtc: new Date(start + (LITE_WINDOW_DAYS + 2) * DAY_MS).toISOString(),
  };
}

/** Where the list starts: the focused date, or the parish's today. */
export function liteStartDate(route, zone, now) {
  // A focus is a FROM (dates.js), past or future, exactly as in the app.
  return route.dateFocus || localDateOf(zone, now);
}

const TOMB_STATUSES = new Set(['cancelled', 'combined', 'replaced', 'break']);

// An event's local date/time/weekday in its own zone. Projected instances carry
// start_local already; stored one-offs carry only the instant.
function localOf(e, zone) {
  if (e.start_local) {
    const date = String(e.start_local).slice(0, 10);
    return { date, time: String(e.start_local).slice(11, 16), dow: new Date(`${date}T00:00:00Z`).getUTCDay() };
  }
  return localPartsOf(e.timezone || zone, Date.parse(e.start_utc));
}
const endTimeOf = (e, zone) => {
  if (e.end_local) return String(e.end_local).slice(11, 16);
  return e.end_utc ? localPartsOf(e.timezone || zone, Date.parse(e.end_utc)).time : null;
};

/**
 * Everything the page says, decided before a character of markup is written.
 *
 * `route` is url-state's classification of the path, with a resolved parish.
 * `pinnedEvent` is the event a bare id named, resolved by the caller because it
 * may lie outside the window (a link to last month's feast still answers).
 */
export function liteModel({ parish, rows, events = [], cross = [], links = [], route, pinnedEvent = null, now, origin, overrides = {} }) {
  const zone = parish.timezone || DEFAULT_ZONE;
  const slug = parishSlug(parish);
  // /sgr/services is the parish's timetable — the rules, not the dates they
  // produce — as /services is in the app. It lists no occurrences and pins
  // none; its way on is the upcoming events, in the app.
  const servicesMode = !!route.services && !route.eventId;
  const start = liteStartDate(route, zone, now);
  const { fromUtc, toUtc } = liteWindow(start);

  const instances = rows.schedules.length ? expandFrom(rows, fromUtc, toUtc) : [];
  const oneOffs = events.filter(e => {
    const t = Date.parse(e.start_utc);
    return t >= Date.parse(fromUtc) && t <= Date.parse(toUtc);
  });
  const feed = buildFeed({ instances, oneOffs, crossRows: cross })
    .map(e => ({ ...e, id: String(e.id), _local: localOf(e, zone),
      // A stored one-off carries its state in `status` alone; a projected one
      // also sets is_tombstone. Either way it renders as a tombstone.
      is_tombstone: e.is_tombstone || TOMB_STATUSES.has(e.status) ? 1 : 0 }))
    .sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));

  // The filter a link asks for. A synthetic occurrence narrows to its own rule —
  // "the other dates of this service" is what somebody who was sent one wants
  // next — and a stored one-off shows the parish's whole list.
  const synth = pinnedEvent && pinnedEvent.schedule_id != null && /:/.test(String(route.eventId || ''));
  const matches = (e) => {
    if (synth) return e.schedule_id === pinnedEvent.schedule_id;
    if (route.service && !services.serviceMatches(route.service, e)) return false;
    if (route.day != null && e._local.dow !== route.day) return false;
    if (route.part && services.partOfDayOf(e, zone) !== route.part) return false;
    return true;
  };
  const endBound = new Date(Date.parse(`${start}T00:00:00Z`) + LITE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10);
  const list = feed.filter(e => matches(e) && e._local.date >= start && e._local.date < endBound)
    .slice(0, LITE_LIST_CAP);

  // The pin, by the rules the app's sheet follows (#63/#64): an id pins its
  // event; a day pins only an event ON that day; a service or weekday pins the
  // first of its kind from the date (only that day, when the date is a day).
  // A part of the day is a kind like the others: /sgr/evening pins the next
  // evening service.
  let pinned = null;
  if (servicesMode) {
    pinned = null;
  } else if (route.eventId) {
    pinned = pinnedEvent
      ? { ...pinnedEvent, id: String(pinnedEvent.id), _local: localOf(pinnedEvent, zone),
        is_tombstone: pinnedEvent.is_tombstone || TOMB_STATUSES.has(pinnedEvent.status) ? 1 : 0 }
      : null;
  } else if (route.service || route.day != null || route.part) {
    const pool = list.filter(e => !e.is_tombstone);
    pinned = route.dateFocus && route.precision === 'day'
      ? urlState.firstEventOnDay(pool, route.dateFocus, 'day', e => e._local.date)
      : pool.find(e => Date.parse(e.end_utc || e.start_utc) >= now) || null;
  } else if (route.dateFocus) {
    pinned = urlState.firstEventOnDay(list, route.dateFocus, route.precision, e => e._local.date);
  }

  const indexable = !route.eventId && !route.dateFocus && route.day == null && !route.service
    && !route.part && !servicesMode;
  // Day, part, service — the order the app writes them in, and the order they
  // are said: /sgr/wed/evening/vespers.
  const kindSegs = [
    ...(route.day != null ? [services.daySlug(route.day)] : []),
    ...(route.part ? [route.part] : []),
    ...(route.service ? [route.service] : []),
  ];
  const dateSegs = route.dateFocus ? [dates.dateSlugFor(route.dateFocus, route.precision)] : [];
  const pathOf = (segs) => `/${segs.map(s => encodeURI(String(s))).join('/')}`;
  const canonicalPath = route.eventId ? pathOf([route.eventId])
    : pathOf([slug, ...kindSegs, ...(servicesMode ? ['services'] : []), ...dateSegs]);
  const canonical = `${origin}${canonicalPath}`;
  // The way into the app. ?app is the Worker's cue to serve the app rather
  // than this card again (routes/pages.mjs). From a card it is the same link;
  // from the timetable it is the upcoming events — every filter the page
  // carries except /services, which is the one thing that page is.
  const appHref = `${servicesMode ? pathOf([slug, ...kindSegs, ...dateSegs]) : canonicalPath}?app`;

  // A rule that has ended is not on the timetable; one that starts later is,
  // marked "from" — the same reading the app's timetable makes.
  const today = localDateOf(zone, now);
  const rules = [...rows.schedules]
    .filter(r => r.parish_id === parish.id && (!r.effective_to || r.effective_to >= today))
    .map(r => ({ ...r, _today: today }))
    .sort((a, b) => a.day_of_week - b.day_of_week || String(a.start_time).localeCompare(String(b.start_time)));
  // The timetable /services shows: the rules the link's filters name. A card
  // keeps the whole timetable under its list, as it always has — there it is
  // the parish's times, not the answer to the link.
  const timetable = !servicesMode ? rules : rules.filter(r =>
    (!route.service || services.serviceMatches(route.service, r))
    && (route.day == null || r.day_of_week === route.day)
    && (!route.part || services.partOfDayOf(r, zone) === route.part));

  return {
    parish, zone, slug, start, endBound, list, pinned, rules, timetable, links,
    route, servicesMode, indexable, canonical, appHref, origin, now,
    missingEvent: !!route.eventId && !pinned,
    ...pageColors(parish, overrides),
  };
}

/**
 * The page's two colours and their dark variants, as the app paints them: the
 * PARISH's own colour where the parish is the subject (its avatar, its
 * buttons, its event groups), the JURISDICTION's on the timetable box, with
 * /admin's overrides over the shared table and the app's OKLab lift for dark.
 * The table alone was what lite pages used to read, and production's
 * overrides had replaced every one of its colours.
 */
export function pageColors(parish, overrides = {}) {
  const juris = jurisColors.jurisdictionColorFrom(overrides, parish.jurisdiction);
  const own = typeof parish.color === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(parish.color.trim())
    ? parish.color.trim() : juris;
  return {
    color: own,
    colors: {
      parish: own, parishDark: jurisColors.liftForDark(own),
      juris, jurisDark: jurisColors.liftForDark(juris),
    },
  };
}

// ── words ────────────────────────────────────────────────────────────────

const JURIS_LABEL = {
  antiochian: 'Antiochian Orthodox', greek: 'Greek Orthodox', serbian: 'Serbian Orthodox',
  russian: 'Russian Orthodox (ROCOR)', romanian: 'Romanian Orthodox', macedonian: 'Macedonian Orthodox',
};
export const jurisLabel = (j) => JURIS_LABEL[j] || 'Orthodox';

/** '10:00' → '10am', '18:30' → '6:30pm'. */
export function time12(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (!Number.isFinite(h)) return '';
  const suffix = h >= 12 ? 'pm' : 'am';
  const h12 = h % 12 || 12;
  return m ? `${h12}:${String(m).padStart(2, '0')}${suffix}` : `${h12}${suffix}`;
}

/** '2026-10-04' → 'Sunday 4 October'. The year only when it is not this one. */
export function longDate(date, thisYear) {
  const d = new Date(`${date}T00:00:00Z`);
  const s = new Intl.DateTimeFormat('en-AU', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
    ...(String(date).slice(0, 4) !== String(thisYear) ? { year: 'numeric' } : {}),
  }).format(d);
  return s.replace(',', '');
}

/** The app's wording: "Updated 3 months ago", from relativeAge in app.js. */
export function relativeAge(iso, now) {
  const then = Date.parse(iso || '');
  if (!Number.isFinite(then)) return null;
  const days = Math.floor((now - then) / DAY_MS);
  if (days < 0) return 'just now';
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  const [value, unit] = days < 30 ? [days, 'day']
    : days < 365 ? [Math.round(days / 30.44), 'month'] : [Math.round(days / 365.25), 'year'];
  return new Intl.RelativeTimeFormat('en', { numeric: 'always' }).format(-value, unit);
}


const ORDINAL = { first: '1st', second: '2nd', third: '3rd', fourth: '4th', last: 'last' };

/** "until 5 Oct", "from 1 Nov", "2 Mar – 20 Apr" — a start already past is not news. */
function rangeLabel(rule) {
  const fmt = (d) => `${Number(d.slice(8, 10))} ${MONTHS_SHORT[Number(d.slice(5, 7)) - 1]}`;
  const from = rule.effective_from && rule.effective_from > (rule._today || '') ? rule.effective_from : null;
  const to = rule.effective_to || null;
  if (from && to) return `${fmt(from)} – ${fmt(to)}`;
  if (from) return `from ${fmt(from)}`;
  if (to) return `until ${fmt(to)}`;
  return '';
}
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const langsOf = (v) => { try { const a = JSON.parse(v || '[]'); return Array.isArray(a) ? a : []; } catch { return []; } };

export const isNarrowed = (r) => !!(r.service || r.day != null || r.part);

/**
 * What a link narrows to, as a heading: "Vespers on Wednesdays", "Evening
 * services", "Morning Liturgies on Sundays".
 */
export function kindLabel(r) {
  const plural = r.service ? services.servicePlural(r.service) : null;
  const what = r.part ? `${services.partOfDayLabel(r.part)} ${plural || 'services'}` : (plural || 'Services');
  return what + (r.day != null ? ` on ${services.dayName(r.day)}s` : '');
}

/** "Sun 10am Divine Liturgy · Sat 6pm Vespers" — what runs now, for a preview. */
function rulesSummary(rules) {
  // A rule that has not started yet is on the timetable but is not what a
  // preview should say the times ARE.
  return rules.filter(r => r.active !== 0 && !(r.effective_from && r.effective_from > r._today)).slice(0, 4)
    .map(r => `${services.DAY_NAMES[r.day_of_week].slice(0, 3)} ${time12(r.start_time)} ${r.title}`)
    .join(' · ');
}

/** What a chat preview and a search result say about this page. */
export function liteMeta(m) {
  const p = m.parish;
  const where = p.address ? ` · ${p.address}` : '';
  const year = m.start.slice(0, 4);
  if (m.servicesMode) {
    return {
      title: isNarrowed(m.route)
        ? `${kindLabel(m.route)} at ${p.name} — service times`
        : `${p.name} — ${jurisLabel(p.jurisdiction)} service times`,
      description: (rulesSummary(m.timetable) || `${jurisLabel(p.jurisdiction)} parish`) + where,
    };
  }
  if (m.pinned) {
    const e = m.pinned;
    const when = `${longDate(e._local.date, year)}, ${time12(e._local.time)}`;
    return {
      title: `${e.title} — ${when} · ${p.name}`,
      description: [
        e.is_tombstone ? (e.status === 'cancelled' ? 'CANCELLED.' : 'Not running.') : null,
        e.feast || null,
        `${when} at ${p.full_name || p.name}.`,
        p.address || null,
      ].filter(Boolean).join(' '),
    };
  }
  if (isNarrowed(m.route)) {
    const what = kindLabel(m.route);
    return {
      title: `${what} at ${p.name}`,
      description: `${what} at ${p.full_name || p.name}, from ${longDate(m.start, year)}${where}`,
    };
  }
  const summary = rulesSummary(m.rules);
  return {
    title: m.route.dateFocus
      ? `${p.name} — ${m.route.precision === 'month' ? dates.dateFocusLabel(m.route.dateFocus, 'month') : longDate(m.route.dateFocus, year)}`
      : `${p.name} — ${jurisLabel(p.jurisdiction)} service times`,
    description: (summary || `${jurisLabel(p.jurisdiction)} parish`) + where,
  };
}

/** The preview image: the pinned event's poster, the parish logo, or the jurisdiction's card. */
export function liteImage(m) {
  const path = (m.pinned && (m.pinned.poster_path)) || m.parish.logo_path
    || `/og/${JURIS_LABEL[m.parish.jurisdiction] ? m.parish.jurisdiction : 'default'}.jpg`;
  return /^https?:/.test(path) ? path : `${m.origin}${path}`;
}

/** schema.org Church, for the parish page. `<` escaped so a name cannot close the script. */
export function churchJsonLd(m) {
  const p = m.parish;
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Church',
    name: p.full_name || p.name,
    ...(p.full_name && p.name !== p.full_name ? { alternateName: p.name } : {}),
    url: `${m.origin}/${m.slug}`,
    ...(p.address ? { address: { '@type': 'PostalAddress', streetAddress: p.address } } : {}),
    ...(p.lat && p.lng ? { geo: { '@type': 'GeoCoordinates', latitude: p.lat, longitude: p.lng } } : {}),
    ...(p.phone ? { telephone: p.phone } : {}),
    ...(p.website ? { sameAs: [p.website] } : {}),
    ...(p.logo_path ? { logo: `${m.origin}${p.logo_path}`, image: `${m.origin}${p.logo_path}` } : {}),
    hasMap: mapsHref(p),
  };
  return JSON.stringify(data).replace(/</g, '\\u003c');
}

/** The Google Maps button's target — the app's parishMapsHref, same rule. */
export function mapsHref(p) {
  if (p.maps_url) return p.maps_url;
  if (p.lat && p.lng) return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
  return '';
}

// ── markup ───────────────────────────────────────────────────────────────
//
// THE APP'S MARKUP, AND THE APP'S STYLESHEET. The page links /app.css and
// writes the class names the app's parish sheet writes — ps-header, the
// jurisdiction-box timetable, day-section / time-card / event-card — so it
// looks like the card a visitor would see in the app, and what an editor sees
// in the app is what a visitor sees here. What remains below in LITE_CSS is
// only what a page needs and a sheet does not: the bar, the column, the
// no-JavaScript <details> that open an event, and the colours.
//
// The markup is copied, not shared: app.js is a classic script the Worker
// cannot import (roadmap phase 3 is moving it into public/shared/). Each
// function below names the app function it mirrors; change them together.

// The type dot's letter and colours, from app.js's TYPE_DISPLAY and
// eventTypeDotColor/eventTypeDotTextColor. Classes rather than inline styles
// so the dark variant is a media query and not a render-time choice.
const TYPE_DISPLAY = { vespers: 'prayer', matins: 'prayer', festival: 'social', fundraiser: 'social' };
const DOTS = {
  liturgy: ['#e8d5e8', '#6b2d6b', '#3a2840', '#d4a3d4'],
  feast: ['#f5ecd0', '#7a6520', '#3a3220', '#d4c082'],
  prayer: ['#d5e0f0', '#2d4a7a', '#1f2a3a', '#9bb8e0'],
  talk: ['#f0e8d5', '#7a5a20', '#3a2f1c', '#d4b682'],
  youth: ['#d0e8f5', '#2d5a8a', '#1c303d', '#a8c8de'],
  social: ['#d5ead5', '#2d6a2d', '#1f2e1f', '#a3c8a3'],
  other: ['#e8e8e8', '#555555', '#26272c', '#aaaaaa'],
};
const DOT_CSS = Object.entries(DOTS).map(([k, [bg, fg]]) => `.lc-dot-${k}{--dot-color:${bg};--dot-text:${fg}}`).join('')
  + `@media (prefers-color-scheme:dark){${Object.entries(DOTS).map(([k, [, , bg, fg]]) => `.lc-dot-${k}{--dot-color:${bg};--dot-text:${fg}}`).join('')}}`;

const icon = (name) => `https://api.iconify.design/${name}.svg`;
const glyph = (name) => `<span class="ps-btn-glyph" style="--glyph:url(${icon(name)})" aria-hidden="true"></span>`;

/** '18:30' → '6<span class="t-min">:30</span><span class="t-mer">pm</span>' — formatEventTime. */
function eventTimeHTML(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (!Number.isFinite(h)) return '';
  const min = m ? `<span class="t-min">:${String(m).padStart(2, '0')}</span>` : '';
  return `${h % 12 || 12}${min}<span class="t-mer">${h >= 12 ? 'pm' : 'am'}</span>`;
}

/** '18:30' → '6:30<span class="ampm">PM</span>' — formatTime12. */
function ruleTimeHTML(hhmm) {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (!Number.isFinite(h)) return '';
  return `${h % 12 || 12}:${String(m || 0).padStart(2, '0')}<span class="ampm">${h >= 12 ? 'PM' : 'AM'}</span>`;
}

/** sourceLineHTML: "Updated 3 months ago · Antiochian Archdiocese ↗". */
function sourceLineHTMLApp(name, ref, checked, now, cls) {
  if (!name) return '';
  const age = relativeAge(checked, now);
  const linkIcon = '<span class="source-link-icon" aria-hidden="true"></span>';
  const label = /^https?:/.test(ref || '')
    ? `<a href="${esc(ref)}" target="_blank" rel="noopener nofollow">${esc(name)}${linkIcon}</a>` : esc(name);
  return `<div class="${cls}">${age ? `Updated ${esc(age)} &middot; ` : ''}${label}</div>`;
}

/**
 * The page's colours as custom properties, with their dark variants: the
 * app lifts a colour per render in JavaScript; a cached page has to say both
 * and let the media query choose.
 */
export function colorVarsCSS(vars) {
  const light = Object.entries(vars).filter(([k]) => !k.endsWith('Dark'))
    .map(([k, v]) => `--${k}:${v}`).join(';');
  const dark = Object.entries(vars).filter(([k]) => k.endsWith('Dark'))
    .map(([k, v]) => `--${k.slice(0, -4)}:${v}`).join(';');
  return `:root{${light}}@media (prefers-color-scheme:dark){:root{${dark}}}`;
}

function eventStatus(e) {
  if (e.status === 'cancelled') return 'Cancelled';
  if (e.status === 'combined') return 'Combined';
  if (e.status === 'break') return 'On a break';
  return '';
}

/** The badges renderEventCard puts after a title — the ones that do not depend on the clock. */
function badgesHTML(e) {
  const out = [];
  if (langsOf(e.languages).length >= 2) out.push('<span class="event-badge badge-bilingual">BILINGUAL</span>');
  if (e.extra_parishes && e.extra_parishes.length) out.push('<span class="event-badge badge-combined">COMBINED</span>');
  if (e.status === 'combined') out.push('<span class="event-badge badge-combined">COMBINED</span>');
  if (e.status === 'cancelled') out.push('<span class="event-badge badge-cancelled">CANCELLED</span>');
  if (e.status === 'break') out.push('<span class="event-badge badge-break">BREAK</span>');
  return out.length ? `<span class="event-inline-badges">${out.join('')}</span>` : '';
}

/**
 * renderEventCard, as a <details> so it opens with no JavaScript: the
 * summary is the card a visitor scans, the body what the app's drawer says.
 */
function eventCardHTML(e, m, { open = false, cls = '' } = {}) {
  const type = TYPE_DISPLAY[e.event_type] || e.event_type || 'other';
  const dot = `<span class="event-type-dot lc-dot-${esc(DOTS[type] ? type : 'other')}">${esc(type[0].toUpperCase())}</span>`;
  const tomb = e.is_tombstone;
  const ownParish = e.parish_id === m.parish.id;
  const acronym = ownParish ? m.parish.acronym : e.parish_acronym;
  const color = ownParish ? 'var(--parish)' : esc(e.parish_color || 'var(--text-secondary)');
  const parishRow = `<div class="event-parish-row">${acronym ? `<span class="event-parish-acronym" style="color:${color}">${esc(acronym)}</span>` : ''}${esc(e.parish_name || m.parish.name)}</div>`;
  return `
      <details class="lc-ev event-card${tomb ? ' event-cancelled tomb' : ''}${cls}" data-id="${esc(e.id)}" data-event-type="${esc(e.event_type || '')}" data-start="${esc(e.start_utc)}" data-end="${esc(e.end_utc || '')}"${open ? ' open' : ''}>
        <summary class="event-content">
          <div class="event-title-row">
            <span class="event-time">${eventTimeHTML(e._local.time)}</span>
            ${dot}
            <div class="event-title-block"><span class="event-title">${esc(e.title)}${badgesHTML(e)}<span class="event-card-chev"></span></span></div>
          </div>
          ${parishRow}
          ${e.feast ? `<div class="event-feast-row">✛ ${esc(e.feast)}</div>` : ''}
          ${e.break_note ? `<div class="event-break-row">${esc(e.break_note)}</div>` : ''}
        </summary>
        <div class="lc-ev-body">${eventDetailsHTML(e, m)}
          <a class="lc-ev-link" href="/${esc(e.id)}">Link to this service</a>
        </div>
      </details>`;
}

function eventDetailsHTML(e, m) {
  const p = m.parish;
  const end = endTimeOf(e, m.zone);
  const langs = langsOf(e.languages);
  const where = e.location_override || p.address || '';
  return `
          <p class="lf-when">${esc(longDate(e._local.date, m.start.slice(0, 4)))} · ${esc(time12(e._local.time))}${end ? `–${esc(time12(end))}` : ''}</p>
          ${where ? `<p class="lf-where">${esc(where)}</p>` : ''}
          ${langs.length ? `<p class="lf-langs">${esc(langs.join(', '))}</p>` : ''}
          ${e.description ? `<p class="lf-desc">${esc(e.description).replace(/\n/g, '<br>')}</p>` : ''}
          ${e.poster_path ? `<img class="lf-poster" src="${esc(e.poster_path)}" alt="Poster for ${esc(e.title)}" loading="lazy">` : ''}`;
}

// The time-card heads, verbatim from renderSubDaySections.
const MORNING_HEAD = '<div class="time-card-head"><svg class="tc-icon" width="10" height="10" viewBox="0 0 10 10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="5" cy="5" r="1.8" fill="currentColor" stroke="none"/><line x1="5" y1="0.5" x2="5" y2="1.9"/><line x1="5" y1="8.1" x2="5" y2="9.5"/><line x1="0.5" y1="5" x2="1.9" y2="5"/><line x1="8.1" y1="5" x2="9.5" y2="5"/><line x1="1.5" y1="1.5" x2="2.4" y2="2.4"/><line x1="7.6" y1="7.6" x2="8.5" y2="8.5"/><line x1="8.5" y1="1.5" x2="7.6" y2="2.4"/><line x1="2.4" y1="7.6" x2="1.5" y2="8.5"/></svg><span class="tc-label">Morning</span></div>';
const EVENING_HEAD = '<div class="time-card-head"><svg class="tc-icon" width="10" height="10" viewBox="0 0 10 10" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="M8.5,5 A3.5,3.5 0 1,0 1.5,5 A3.5,3.5 0 1,0 8.5,5Z M9.1,4.5 A2.9,2.9 0 1,0 3.3,4.5 A2.9,2.9 0 1,0 9.1,4.5Z"/></svg><span class="tc-label">Evening</span></div>';

/** renderParishGroupsHTML: a run of one parish's cards with its name underneath. */
function parishGroupsHTML(events, m) {
  const byParish = new Map();
  for (const e of events) {
    if (!byParish.has(e.parish_id)) byParish.set(e.parish_id, []);
    byParish.get(e.parish_id).push(e);
  }
  return [...byParish.values()].map((evts, i) => {
    const first = evts[0];
    const own = first.parish_id === m.parish.id;
    const color = own ? 'var(--parish)' : esc(first.parish_color || 'var(--text-secondary)');
    const acr = own ? m.parish.acronym : first.parish_acronym;
    return `${i ? '<div class="parish-group-sep" aria-hidden="true"></div>' : ''}
      <div class="parish-group" style="--parish-color:${color}">
        ${evts.map(e => eventCardHTML(e, m)).join('')}
        <div class="parish-group-footer">${acr ? `<span class="parish-group-acro" style="color:${color}">${esc(acr)}</span>` : ''}<span class="parish-group-name">${esc(first.parish_name || m.parish.name)}</span></div>
      </div>`;
  }).join('');
}

/** renderFutureDays + renderSubDaySections, by the parish's own calendar. */
function listHTML(m) {
  if (!m.list.length) {
    return `<p class="lc-empty">Nothing on file ${m.route.dateFocus ? `from ${esc(longDate(m.start, m.start.slice(0, 4)))}` : 'in the next few weeks'}.</p>`;
  }
  const today = localDateOf(m.zone, m.now);
  const weekOut = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * DAY_MS).toISOString().slice(0, 10);
  const byDay = new Map();
  for (const e of m.list) {
    if (!byDay.has(e._local.date)) byDay.set(e._local.date, []);
    byDay.get(e._local.date).push(e);
  }
  let html = '';
  let month = today.slice(0, 7);
  for (const [date, evts] of byDay) {
    const d = new Date(`${date}T00:00:00Z`);
    if (date.slice(0, 7) !== month) {
      month = date.slice(0, 7);
      html += `<div class="month-header">${esc(new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', month: 'long', year: 'numeric' }).format(d))}</div>`;
    }
    const label = date === today ? 'Today'
      : new Intl.DateTimeFormat('en-AU', { timeZone: 'UTC', weekday: date < weekOut ? 'long' : 'short', day: 'numeric', month: 'short' }).format(d);
    const morning = evts.filter(e => services.partOfDayOf(e, m.zone) !== 'evening');
    const evening = evts.filter(e => services.partOfDayOf(e, m.zone) === 'evening');
    html += `<div class="day-section lc-day${d.getUTCDay() === 0 ? ' day-section-sunday' : ''}" data-date="${esc(date)}">
      <div class="day-hdr">${esc(label)}</div>
      ${morning.length ? `<div class="time-card time-card-morning">${MORNING_HEAD}${parishGroupsHTML(morning, m)}</div>` : ''}
      ${evening.length ? `<div class="time-card time-card-evening">${EVENING_HEAD}${parishGroupsHTML(evening, m)}</div>` : ''}
    </div>`;
  }
  return html;
}

/** renderScheduleDaysHTML's rows, read-only: a row opens that rule's own card. */
export function scheduleRowsHTML(rules, slug, now) {
  let html = '';
  let dow = null;
  for (const r of rules) {
    if (r.day_of_week !== dow) {
      dow = r.day_of_week;
      html += `<div class="schedule-day">${esc(services.DAY_NAMES[dow])}</div>`;
    }
    const svc = services.serviceOf(r);
    const href = `/${slug}/${services.daySlug(dow)}${svc ? `/${svc}` : ''}`;
    const langs = langsOf(r.languages);
    const meta = [
      r.week_parity ? '<span class="schedule-item-wom">fortnightly</span>'
        : r.week_of_month ? `<span class="schedule-item-wom">${esc(String(r.week_of_month).split(',').map(w => ORDINAL[w.trim()] || w.trim()).join(', '))} ${esc(services.DAY_NAMES[dow])}</span>` : '',
      rangeLabel(r) ? `<span class="schedule-item-range">${esc(rangeLabel(r))}</span>` : '',
      langs.length ? `<span class="schedule-item-lang">${esc(langs.join(', '))}</span>` : '',
      r.parish_scoped ? '<span class="schedule-item-scope">parish only</span>' : '',
    ].join('');
    html += `<a class="schedule-item lt-row" href="${esc(href)}">
          <div class="si-main"><span class="schedule-item-time">${ruleTimeHTML(r.start_time)}</span><span class="si-title"><span class="schedule-item-title" title="${esc(r.title)}">${esc(r.title)}</span><img class="si-chev" src="${icon('ph:caret-right-bold')}" alt=""></span></div>
          ${meta ? `<div class="si-meta">${meta}</div>` : ''}
          ${r.location_override ? `<div class="si-where">${esc(r.location_override)}</div>` : ''}
        </a>`;
  }
  // scheduleSourceHTML: one line, whoever changed the timetable last.
  const latest = rules.filter(r => r.source_name)
    .sort((a, b) => String(b.source_checked_at || '').localeCompare(String(a.source_checked_at || '')))[0];
  return html + (latest ? sourceLineHTMLApp(latest.source_name, latest.source_ref, latest.source_checked_at, now, 'sched-source') : '');
}

/** parishTimetableHTML, read-only: the framed box the parish card shows, above its events. */
function timetableHTML(m, rules, empty) {
  const p = m.parish;
  const initial = (p.name || p.full_name || '?').trim()[0].toUpperCase();
  const avatar = p.logo_path
    ? `<div class="parish-schedule-avatar"><img src="${esc(p.logo_path)}" alt=""></div>`
    : `<div class="parish-schedule-avatar" style="background:var(--juris)">${esc(initial)}</div>`;
  return `
  <section class="lc-times ps-section ps-sched-section" aria-labelledby="lt-h">
    <div class="jurisdiction-box" style="--juris-color:var(--juris)">
      <h2 class="section-header jurisdiction-header" id="lt-h">${esc(jurisLabel(p.jurisdiction))}</h2>
      <div class="parish-schedule ps-timetable">
        <div class="parish-schedule-head">${avatar}<div class="parish-schedule-name">${esc(p.name || p.full_name)}</div></div>
        ${rules.length ? scheduleRowsHTML(rules, m.slug, m.now) : `<div class="ps-sched-empty">${esc(empty)}</div>`}
      </div>
    </div>
  </section>`;
}

/** The "Showing …" banner the parish card puts over a narrowed list. */
function bannerHTML(text, id = 'll-h') {
  return `<div class="ps-focus-banner lc-banner"><h2 class="ps-focus-banner-text" id="${id}">${esc(text)}</h2></div>`;
}

/**
 * "Become a contributor": the claim (/admin?claim=, behind Cloudflare Access),
 * under the parish's source line, where the app's card puts it
 * (contributeButtonHTML). nofollow: it leads to a sign-in.
 */
function contributeHTML(m) {
  return `<a class="ps-btn ps-btn-ghost ps-contribute lc-contrib" href="/admin?claim=${esc(encodeURIComponent(m.parish.id))}" rel="nofollow">${glyph('ph:user-plus')}Become a contributor</a>`;
}

/** The info section's copy chips — the app's ps-info-copy. lite.js does the copying. */
function copyChipHTML(value, shown, label) {
  return `<button class="ps-info-copy" type="button" data-copy="${esc(value)}" aria-label="${esc(label)}"><span class="ps-info-copy-text">${esc(shown)}</span><img class="ps-info-copy-icon" src="${icon('ph:copy')}" alt=""></button>`;
}

function actionsHTML(m) {
  const p = m.parish;
  const btn = (href, label, cls = '', ic = '') => `<a class="ps-btn${cls}" href="${esc(href)}" target="_blank" rel="noopener">${ic ? `<img class="ps-btn-icon" src="${icon(ic)}" alt="">` : ''}<span>${esc(label)}</span></a>`;
  const out = [];
  const maps = mapsHref(p);
  if (maps) out.push(btn(maps, 'Google Maps', ' ps-btn-primary'));
  if (p.website) out.push(btn(p.website, 'Website'));
  if (p.phone) out.push(`<a class="ps-btn" href="tel:${esc(p.phone.replace(/\s+/g, ''))}"><span>Call</span></a>`);
  if (p.live_url) out.push(btn(p.live_url, 'Watch Live'));
  if (p.donation_url) out.push(btn(`/${m.slug}/donate`, 'Donate', ' ps-donate-btn', 'ph:hand-heart'));
  for (const l of m.links || []) if (l.url) out.push(btn(`/${m.slug}/${l.slug}`, l.label || l.slug));
  // Share needs JavaScript; lite.js reveals it.
  out.push(`<button class="ps-btn ps-share-btn" type="button" data-share hidden><img class="ps-btn-icon" src="${icon('ph:paper-plane-tilt')}" alt=""><span>Share</span></button>`);
  return `<nav class="ps-actions lc-actions" aria-label="Parish links" style="--parish-color:var(--parish)">${out.join('')}</nav>`;
}

function pinnedHTML(m) {
  if (m.missingEvent) {
    return `<p class="lc-notice">That event is no longer on file — here is ${esc(m.parish.name)} instead.</p>`;
  }
  if (!m.pinned) {
    if (m.route.dateFocus && m.route.precision === 'day') {
      return `<p class="lc-notice">Nothing on ${esc(longDate(m.route.dateFocus, m.start.slice(0, 4)))}${m.route.service ? ` for ${esc(services.servicePlural(m.route.service))}` : ''}. The next services are below.</p>`;
    }
    return '';
  }
  const e = m.pinned;
  const status = eventStatus(e);
  // The app's pinned slot: the card, open, above everything else on the sheet.
  return `
  <article class="lc-pin ps-pinned-event${e.is_tombstone ? ' tomb' : ''}">
    ${status ? `<p class="lc-pin-status">${esc(status.toUpperCase())}</p>` : ''}
    <h2 class="lc-pin-title">${esc(e.title)}</h2>
    ${eventCardHTML(e, m, { open: true, cls: ' lc-pin-card' })}
  </article>`;
}

function listHeading(m) {
  const r = m.route;
  if (isNarrowed(r)) return `Showing ${kindLabel(r)}`;
  if (m.pinned && m.pinned.schedule_id != null && r.eventId) return `More dates for ${m.pinned.title}`;
  return r.dateFocus ? `Showing from ${longDate(m.start, m.start.slice(0, 4))}` : '';
}

/**
 * The way into the app: a button in the parish's colour, directly above the
 * list it continues.
 */
function appButtonHTML(m, label) {
  return `<a class="lc-app" href="${esc(m.appHref)}">${esc(label)}</a>`;
}

/** The middle of the page: the timetable, then a card's list — or /services' timetable alone. */
function bodyHTML(m) {
  if (m.servicesMode) {
    const narrowed = isNarrowed(m.route);
    return `
  ${narrowed ? bannerHTML(`Showing ${kindLabel(m.route)}`) : ''}
  ${timetableHTML(m, m.timetable, narrowed ? 'No service on the timetable matches.' : 'No service times on file yet.')}
  ${appButtonHTML(m, 'View upcoming events →')}`;
  }
  const heading = listHeading(m);
  return `
  ${timetableHTML(m, m.rules, 'No service times on file.')}
  ${appButtonHTML(m, 'Open in the app →')}
  <section class="lc-list" aria-labelledby="ll-h">
    ${heading ? bannerHTML(heading) : '<h2 class="lc-sr" id="ll-h">Coming up</h2>'}
    <div class="ps-events-list">${listHTML(m)}</div>
  </section>
  <footer class="lc-foot">
    <span>Showing to ${esc(longDate(m.endBound, m.start.slice(0, 4)))}</span>
  </footer>`;
}

/** The whole page — the parish sheet's content, as a page. */
export function renderLitePage(m) {
  const p = m.parish;
  const meta = liteMeta(m);
  const initial = (p.name || p.full_name || '?').trim()[0].toUpperCase();
  const avatar = p.logo_path
    ? `<div class="ps-avatar" style="--parish-glow:color-mix(in srgb,var(--parish) 45%,transparent)"><img src="${esc(p.logo_path)}" alt=""></div>`
    : `<div class="ps-avatar" style="background:var(--parish);--parish-glow:color-mix(in srgb,var(--parish) 45%,transparent)">${esc(initial)}</div>`;
  const website = p.website ? p.website.replace(/^https?:\/\//, '').replace(/\/$/, '') : '';

  return liteDocument({
    title: meta.title,
    description: meta.description,
    canonical: m.canonical,
    indexable: m.indexable,
    ogType: m.pinned ? 'article' : 'place',
    image: liteImage(m),
    twitterCard: m.pinned && m.pinned.poster_path ? 'summary_large_image' : 'summary',
    color: m.color,
    vars: m.colors,
    jsonLd: churchJsonLd(m),
    main: `
  <div class="ps-header lc-head">
    ${avatar}
    <div class="ps-header-info">
      <h1 class="ps-name">${esc(p.full_name || p.name)}</h1>
      <div class="ps-meta">${esc(jurisLabel(p.jurisdiction))}${p.full_name && p.name !== p.full_name ? ` · ${esc(p.name)}` : ''}</div>
    </div>
  </div>
  ${pinnedHTML(m)}
  <section class="ps-section lc-info">
    ${p.address ? copyChipHTML(p.address, p.address, 'Copy address') : ''}
    ${website ? copyChipHTML(p.website, website, 'Copy website URL') : ''}
    ${sourceLineHTMLApp(p.info_source_name, p.info_source_ref, p.info_checked_at, m.now, 'ps-source lc-src')}
    ${contributeHTML(m)}
    ${actionsHTML(m)}
  </section>
  ${bodyHTML(m)}`,
  });
}

/**
 * The page around a card: the <head> a preview and a search engine read, the
 * bar, the stylesheets and the script. One shell for the parish card and the
 * timetable page (lite-timetable.mjs), so the two cannot differ in what they
 * tell a crawler or in how they look.
 *
 * /app.css first, so the page wears the app's own styles, then LITE_CSS for
 * what only a page needs, then the page's colours. `vars` is
 * { name: light, nameDark: dark } — see colorVarsCSS.
 */
export function liteDocument({ title, description, canonical, indexable, ogType, image, twitterCard = 'summary', color, vars = {}, jsonLd = '', main }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} | orthodoxy.au</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${esc(canonical)}">
<meta name="robots" content="${indexable ? 'index,follow' : 'noindex,follow'}">
<meta property="og:site_name" content="orthodoxy.au">
<meta property="og:type" content="${esc(ogType)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(canonical)}">
<meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="${esc(twitterCard)}">
<meta name="theme-color" content="${esc(color)}">
${jsonLd ? `<script type="application/ld+json">${jsonLd}</script>\n` : ''}<link rel="stylesheet" href="/app.css">
<style>${LITE_CSS}${DOT_CSS}${colorVarsCSS({ page: color, pageDark: jurisColors.liftForDark(color), ...vars })}</style>
</head>
<body class="lite">
<header class="lite-bar">
  <span class="lite-brand">orthodoxy.au</span>
  <a class="lite-close" href="/" aria-label="Close — to the map">&times;</a>
</header>
<main class="lite-card">${main}
</main>
<script src="/lite.js" defer></script>
</body>
</html>`;
}

// What a page needs that a sheet does not, on top of /app.css. The app's
// tokens (--bg, --text, --text-secondary, --border, --surface-2) are app.css's
// own, so a page follows the app's light and dark exactly.
const LITE_CSS = `
html{overscroll-behavior-y:auto}
body.lite{margin:0;background:var(--bg);color:var(--text);font-size:15px;-webkit-text-size-adjust:100%}
.lite a{color:inherit}
.lite-bar{position:sticky;top:0;z-index:20;display:flex;align-items:center;justify-content:space-between;gap:12px;height:48px;padding:0 8px 0 16px;background:var(--bg);border-bottom:1px solid var(--border-light)}
.lite-brand{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--text-secondary)}
.lite-close{display:flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:50%;font-size:26px;line-height:1;color:var(--text-secondary);text-decoration:none}
.lite-close:hover{color:var(--text);background:var(--surface-2)}
.lite-card{--ps-stack-h:48px;max-width:680px;margin:0 auto;padding:0 0 48px}
.lite .ps-header{position:static;padding-top:18px}
.lite h1.ps-name,.lite h2.section-header,.lite h2.ps-focus-banner-text{margin:0;font:inherit}
.lite h1.ps-name{font-size:21px;font-weight:700;line-height:1.2}
.lite h2.section-header{font-size:11px;font-weight:600}
.lc-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.lite .ps-section{padding-left:16px;padding-right:16px}
.lite .ps-actions{margin-top:10px}
.lite a.ps-btn{text-decoration:none}
.lite a.schedule-item{display:block;color:inherit;text-decoration:none}
.lite .ps-sched-section{padding:8px 0 0}
.lite .lc-contrib{margin-top:4px}
.lc-notice{margin:14px 16px 0;padding:12px 14px;border-radius:12px;background:var(--surface-2);color:var(--text-secondary);font-size:14px}
.lc-pin{margin:12px 12px 0}
.lc-pin-status{margin:0 4px 4px;font-size:12px;font-weight:800;letter-spacing:.08em;color:var(--danger)}
.lc-pin-title{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.lc-banner{--parish-color:var(--parish);margin:14px 16px 4px}
.lc-app{display:flex;align-items:center;justify-content:center;margin:16px;padding:12px 16px;border-radius:12px;background:var(--parish);color:#fff !important;font-weight:700;font-size:15px;text-decoration:none;box-shadow:0 1px 3px color-mix(in srgb,var(--parish) 40%,transparent)}
.lc-app:hover{filter:brightness(1.08)}
/* The app's .event-card is a flex row (card + drawer side by side when its JS
   expands it); a <details> holds summary over body, so it stacks. */
details.lc-ev.event-card{display:block}
details.lc-ev>summary{display:block;list-style:none;cursor:pointer}
.lc-ev-body{margin-top:10px}
details.lc-ev>summary::-webkit-details-marker{display:none}
details.lc-ev.past{opacity:.55}
.lc-ev-body{font-size:14px}
.lc-ev-body p{margin:0 0 2px}
.lf-when{font-weight:600}
.lf-where,.lf-langs{color:var(--text-secondary)}
.lf-desc{margin-top:8px !important}
.lf-poster{display:block;width:100%;height:auto;margin:10px 0 0;border-radius:10px}
.lc-ev-link{display:inline-block;margin-top:8px;font-size:13px;color:var(--text-secondary) !important}
.lc-badge.now{display:inline-block;margin-left:6px;padding:1px 7px;border-radius:999px;background:var(--now-dot);color:#fff;font-size:10px;font-weight:800;letter-spacing:.04em;vertical-align:middle}
.lc-empty{margin:12px 16px;color:var(--text-secondary)}
.lc-foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;margin:24px 16px 0;padding-top:14px;border-top:1px solid var(--border-light);font-size:13px;color:var(--text-secondary)}
.tt-head{padding:20px 16px 4px}
.tt-head h1{margin:0;font-size:21px;font-weight:700;line-height:1.2}
.tt-head p{margin:4px 0 0;color:var(--text-secondary);font-size:13px}
.tt-region>.month-header{margin-top:6px}
.tt-parish .parish-schedule-avatar{background:var(--pc)}
.tt-parish a.parish-schedule-head{color:inherit;text-decoration:none}
.tt-addr{display:block;margin-top:1px;font-size:12px;font-weight:400;color:var(--text-secondary)}
.tt-more{display:block;margin:16px;padding:12px 14px;border-radius:12px;background:var(--surface-2);color:var(--text) !important;font-size:14px;font-weight:600;text-decoration:none}
`;
