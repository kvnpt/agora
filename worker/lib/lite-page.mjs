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

const esc = (s) => String(s == null ? '' : s)
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
export function liteModel({ parish, rows, events = [], cross = [], links = [], route, pinnedEvent = null, now, origin }) {
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
    color: jurisColors.jurisdictionColor(parish.jurisdiction),
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

function sourceLine(name, ref, checked, now, cls) {
  if (!name) return '';
  const age = relativeAge(checked, now);
  const label = /^https?:/.test(ref || '')
    ? `<a href="${esc(ref)}" rel="noopener nofollow">${esc(name)}</a>` : esc(name);
  return `<p class="${cls}">${age ? `Updated ${esc(age)} · ` : ''}${label}</p>`;
}

const ORDINAL = { first: '1st', second: '2nd', third: '3rd', fourth: '4th', last: 'last' };
function weeksLabel(rule) {
  const range = rangeLabel(rule);
  let weeks = '';
  if (rule.week_parity) weeks = 'fortnightly';
  else if (rule.week_of_month) {
    weeks = String(rule.week_of_month).split(',').map(w => ORDINAL[w.trim()] || w.trim()).join(', ')
      + ' of the month';
  }
  return [weeks, range].filter(Boolean).join(' · ');
}

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

const isNarrowed = (r) => !!(r.service || r.day != null || r.part);

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

function eventStatus(e) {
  if (e.status === 'cancelled') return 'Cancelled';
  if (e.status === 'combined') return 'Combined';
  if (e.status === 'break') return 'On a break';
  return '';
}

function eventDetailsHTML(e, m) {
  const p = m.parish;
  const end = endTimeOf(e, m.zone);
  const langs = langsOf(e.languages);
  const where = e.location_override || p.address || '';
  return `
      ${e.feast ? `<p class="lf-feast">${esc(e.feast)}</p>` : ''}
      <p class="lf-when">${esc(longDate(e._local.date, m.start.slice(0, 4)))} · ${esc(time12(e._local.time))}${end ? `–${esc(time12(end))}` : ''}</p>
      ${where ? `<p class="lf-where">${esc(where)}</p>` : ''}
      ${langs.length ? `<p class="lf-langs">${esc(langs.join(', '))}</p>` : ''}
      ${e.break_note ? `<p class="lf-note">${esc(e.break_note)}</p>` : ''}
      ${e.description ? `<p class="lf-desc">${esc(e.description).replace(/\n/g, '<br>')}</p>` : ''}
      ${e.poster_path ? `<img class="lf-poster" src="${esc(e.poster_path)}" alt="Poster for ${esc(e.title)}" loading="lazy">` : ''}`;
}

function listHTML(m) {
  if (!m.list.length) {
    return `<p class="lc-empty">Nothing on file ${m.route.dateFocus ? `from ${esc(longDate(m.start, m.start.slice(0, 4)))}` : 'in the next few weeks'}.</p>`;
  }
  let html = '';
  let day = null;
  for (const e of m.list) {
    if (e._local.date !== day) {
      if (day) html += '</div>';
      day = e._local.date;
      html += `<div class="lc-day" data-date="${esc(day)}"><h3>${esc(longDate(day, m.start.slice(0, 4)))}</h3>`;
    }
    const status = eventStatus(e);
    const isPin = m.pinned && String(m.pinned.id) === String(e.id);
    html += `
      <details class="lc-ev${e.is_tombstone ? ' tomb' : ''}${isPin ? ' pinned-twin' : ''}" data-start="${esc(e.start_utc)}" data-end="${esc(e.end_utc || '')}">
        <summary><time>${esc(time12(e._local.time))}</time><span class="lc-ev-title">${esc(e.title)}</span>${status ? `<span class="lc-badge">${esc(status)}</span>` : ''}</summary>
        <div class="lc-ev-body">${eventDetailsHTML(e, m)}
          <a class="lc-ev-link" href="/${esc(e.id)}">Link to this service</a>
        </div>
      </details>`;
  }
  return html + '</div>';
}

function timetableHTML(m, rules, heading, empty = '') {
  if (!rules.length) {
    return empty ? `
    <section class="lc-times" aria-labelledby="lt-h">
      <h2 id="lt-h">${esc(heading)}</h2>
      <p class="lc-empty">${esc(empty)}</p>
    </section>` : '';
  }
  let html = '';
  let dow = null;
  for (const r of rules) {
    if (r.day_of_week !== dow) {
      dow = r.day_of_week;
      html += `<h3 class="lt-day">${esc(services.DAY_NAMES[dow])}</h3>`;
    }
    const svc = services.serviceOf(r);
    const href = `/${m.slug}/${services.daySlug(dow)}${svc ? `/${svc}` : ''}`;
    const weeks = weeksLabel(r);
    html += `<a class="lt-row" href="${esc(href)}"><time>${esc(time12(r.start_time))}</time><span>${esc(r.title)}${weeks ? `<small>${esc(weeks)}</small>` : ''}</span></a>`;
  }
  // One source for the whole timetable: the most recent stamp among its rules.
  const latest = rules.filter(r => r.source_name)
    .sort((a, b) => String(b.source_checked_at || '').localeCompare(String(a.source_checked_at || '')))[0];
  return `
    <section class="lc-times" aria-labelledby="lt-h">
      <h2 id="lt-h">${esc(heading)}</h2>
      ${html}
      ${latest ? sourceLine(latest.source_name, latest.source_ref, latest.source_checked_at, m.now, 'lc-src') : ''}
    </section>`;
}

function actionsHTML(m) {
  const p = m.parish;
  const btn = (href, label, cls = '') => `<a class="lc-btn${cls}" href="${esc(href)}" rel="noopener">${esc(label)}</a>`;
  const out = [];
  const maps = mapsHref(p);
  if (maps) out.push(btn(maps, 'Google Maps', ' primary'));
  if (p.website) out.push(btn(p.website, 'Website'));
  if (p.phone) out.push(btn(`tel:${p.phone.replace(/\s+/g, '')}`, 'Call'));
  if (p.live_url) out.push(btn(p.live_url, 'Watch Live'));
  if (p.donation_url) out.push(btn(`/${m.slug}/donate`, 'Donate'));
  for (const l of m.links || []) if (l.url) out.push(btn(`/${m.slug}/${l.slug}`, l.label || l.slug));
  // Share needs JavaScript; lite.js reveals it.
  out.push(`<button class="lc-btn" type="button" data-share hidden>Share</button>`);
  return `<nav class="lc-actions" aria-label="Parish links">${out.join('')}</nav>`;
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
  return `
    <article class="lc-pin${e.is_tombstone ? ' tomb' : ''}" data-start="${esc(e.start_utc)}" data-end="${esc(e.end_utc || '')}">
      ${status ? `<p class="lc-pin-status">${esc(status.toUpperCase())}</p>` : ''}
      <h2>${esc(e.title)}</h2>
      ${eventDetailsHTML(e, m)}
    </article>`;
}

function listHeading(m) {
  const r = m.route;
  if (isNarrowed(r)) return kindLabel(r);
  if (m.pinned && m.pinned.schedule_id != null && r.eventId) return `More dates for ${m.pinned.title}`;
  return r.dateFocus ? `From ${longDate(m.start, m.start.slice(0, 4))}` : 'Coming up';
}

/**
 * The way into the app: a button in the parish's colour, directly above the
 * list it continues. It was a line of small print under everything, and the
 * app is where the rest of the year, the map and the other parishes are.
 */
function appButtonHTML(m, label) {
  return `<a class="lc-app" href="${esc(m.appHref)}">${esc(label)}</a>`;
}

/** The middle of the page: a card's pin and list, or /services' timetable. */
function bodyHTML(m) {
  if (m.servicesMode) {
    const heading = isNarrowed(m.route) ? kindLabel(m.route) : 'Service times';
    const empty = isNarrowed(m.route) ? 'No service on the timetable matches.' : 'No service times on file yet.';
    return `
  ${timetableHTML(m, m.timetable, heading, empty)}
  ${appButtonHTML(m, 'View upcoming events →')}`;
  }
  return `
  ${pinnedHTML(m)}
  ${appButtonHTML(m, 'Open in the app →')}
  <section class="lc-list" aria-labelledby="ll-h">
    <h2 id="ll-h">${esc(listHeading(m))}</h2>
    ${listHTML(m)}
  </section>
  ${timetableHTML(m, m.rules, 'Service times')}
  <footer class="lc-foot">
    <span>Showing to ${esc(longDate(m.endBound, m.start.slice(0, 4)))}</span>
  </footer>`;
}

/** The whole page. */
export function renderLitePage(m) {
  const p = m.parish;
  const meta = liteMeta(m);
  const image = liteImage(m);
  const initial = (p.name || p.full_name || '?').trim()[0].toUpperCase();
  const avatar = p.logo_path
    ? `<img class="lc-avatar" src="${esc(p.logo_path)}" alt="" width="56" height="56">`
    : `<span class="lc-avatar" aria-hidden="true">${esc(initial)}</span>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(meta.title)} | orthodoxy.au</title>
<meta name="description" content="${esc(meta.description)}">
<link rel="canonical" href="${esc(m.canonical)}">
<meta name="robots" content="${m.indexable ? 'index,follow' : 'noindex,follow'}">
<meta property="og:site_name" content="orthodoxy.au">
<meta property="og:type" content="${m.pinned ? 'article' : 'place'}">
<meta property="og:title" content="${esc(meta.title)}">
<meta property="og:description" content="${esc(meta.description)}">
<meta property="og:url" content="${esc(m.canonical)}">
<meta property="og:image" content="${esc(image)}">
<meta name="twitter:card" content="${m.pinned && m.pinned.poster_path ? 'summary_large_image' : 'summary'}">
<meta name="theme-color" content="${esc(m.color)}">
<script type="application/ld+json">${churchJsonLd(m)}</script>
<style>${LITE_CSS}</style>
</head>
<body style="--juris:${esc(m.color)}">
<header class="lite-bar">
  <a class="lite-back" href="/">← Back to App</a>
  <span class="lite-brand">orthodoxy.au</span>
</header>
<main class="lite-card">
  <section class="lc-head">
    ${avatar}
    <div>
      <h1>${esc(p.full_name || p.name)}</h1>
      <p class="lc-juris">${esc(jurisLabel(p.jurisdiction))}${p.full_name && p.name !== p.full_name ? ` · ${esc(p.name)}` : ''}</p>
    </div>
  </section>
  <section class="lc-info">
    ${p.address ? `<button class="lc-addr" type="button" data-copy="${esc(p.address)}">${esc(p.address)}</button>` : ''}
    ${sourceLine(p.info_source_name, p.info_source_ref, p.info_checked_at, m.now, 'lc-src')}
    ${actionsHTML(m)}
  </section>
  ${bodyHTML(m)}
  <p class="lc-claim"><a href="/admin?claim=${esc(encodeURIComponent(m.parish.id))}" rel="nofollow">${m.rules.length ? 'Is this your parish? Help keep its times right' : 'Is this your parish? Add its service times'} →</a></p>
</main>
<script src="/lite.js" defer></script>
</body>
</html>`;
}

// Inline, because a separate stylesheet is a second round trip before first
// paint and this page exists to paint first. Small on purpose: it styles one
// card, not the app.
const LITE_CSS = `
:root{--bg:#fff;--surface:#f6f5f2;--text:#1d1d1f;--muted:#6b6b70;--line:#e6e4df;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#15161a;--surface:#1f2026;--text:#ececef;--muted:#9a9aa3;--line:#2c2d34}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%}
a{color:inherit}
.lite-bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 16px;background:var(--bg);border-bottom:1px solid var(--line)}
.lite-back{display:inline-flex;align-items:center;padding:7px 14px;border-radius:999px;background:var(--juris);color:#fff;font-weight:700;font-size:14px;text-decoration:none}
.lite-brand{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.lite-card{max-width:640px;margin:0 auto;padding:0 16px 40px}
.lc-head{display:flex;align-items:center;gap:14px;padding:20px 0 12px}
.lc-avatar{flex:none;width:56px;height:56px;border-radius:50%;object-fit:cover;display:flex;align-items:center;justify-content:center;background:var(--juris);color:#fff;font-weight:700;font-size:22px;box-shadow:0 0 0 3px var(--bg),0 0 14px 2px color-mix(in srgb,var(--juris) 45%,transparent)}
h1{margin:0;font-size:22px;line-height:1.15;letter-spacing:-.01em}
.lc-juris{margin:3px 0 0;color:var(--muted);font-size:13px}
.lc-info{padding:4px 0 16px;border-bottom:1px solid var(--line)}
.lc-addr{display:block;margin:0 0 6px;padding:0;border:0;background:none;color:var(--text);font:inherit;font-size:14px;text-align:left;cursor:pointer}
.lc-src{margin:0 0 12px;font-size:11.5px;color:var(--muted)}
.lc-src a{text-decoration:underline dotted}
.lc-actions{display:flex;flex-wrap:wrap;gap:8px}
.lc-btn{display:inline-flex;align-items:center;padding:7px 15px;border:1px solid var(--juris);border-radius:999px;background:var(--bg);color:var(--juris);font:inherit;font-size:13.5px;font-weight:600;text-decoration:none;cursor:pointer}
.lc-btn.primary{background:var(--juris);color:#fff}
@media (prefers-color-scheme:dark){.lc-btn{color:var(--text)}}
.lc-notice{margin:16px 0 0;padding:12px 14px;border-radius:12px;background:var(--surface);color:var(--muted);font-size:14px}
.lc-pin{margin:16px 0 0;padding:16px;border-radius:14px;border:1.5px solid var(--juris);background:color-mix(in srgb,var(--juris) 6%,var(--bg))}
.lc-pin h2{margin:0 0 6px;font-size:19px;line-height:1.25}
.lc-pin-status{margin:0 0 4px;font-size:12px;font-weight:800;letter-spacing:.08em;color:#b3261e}
.lc-pin.tomb h2{text-decoration:line-through}
.lf-feast{margin:0 0 4px;font-style:italic}
.lf-when{margin:0 0 2px;font-weight:600}
.lf-where,.lf-langs,.lf-note{margin:0 0 2px;color:var(--muted);font-size:14px}
.lf-desc{margin:8px 0 0;font-size:14px}
.lf-poster{display:block;width:100%;height:auto;margin:12px 0 0;border-radius:10px}
.lc-list,.lc-times{padding:20px 0 4px}
.lc-list>h2,.lc-times>h2{margin:0 0 8px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)}
.lc-day h3,.lt-day{margin:14px 0 4px;font-size:11.5px;letter-spacing:.07em;text-transform:uppercase;color:var(--muted)}
.lc-ev{border-bottom:1px solid var(--line)}
.lc-ev summary{display:grid;grid-template-columns:66px minmax(0,1fr) auto;gap:8px;align-items:baseline;padding:9px 0;cursor:pointer;list-style:none}
.lc-ev summary::-webkit-details-marker{display:none}
.lc-ev time,.lt-row time{font-weight:600;font-variant-numeric:tabular-nums}
.lc-ev-title{font-weight:500}
.lc-ev.tomb .lc-ev-title{text-decoration:line-through;color:var(--muted)}
.lc-ev.past{opacity:.55}
.lc-badge{font-size:11px;font-weight:700;padding:1px 7px;border-radius:999px;background:var(--surface);color:var(--muted)}
.lc-badge.now{background:#1f8a3b;color:#fff}
.lc-ev-body{padding:0 0 12px 74px}
.lc-ev-link{display:inline-block;margin-top:8px;font-size:13px;color:var(--muted)}
.lc-empty{color:var(--muted)}
.lt-row{display:grid;grid-template-columns:66px minmax(0,1fr);gap:8px;padding:7px 0;text-decoration:none;border-bottom:1px solid var(--line)}
.lt-row small{display:block;color:var(--muted);font-size:12px}
.lc-app{display:flex;align-items:center;justify-content:center;margin:16px 0 0;padding:12px 16px;border-radius:12px;background:var(--juris);color:#fff;font-weight:700;font-size:15px;text-decoration:none;box-shadow:0 1px 3px color-mix(in srgb,var(--juris) 40%,transparent)}
.lc-app:hover{filter:brightness(1.08)}
.lc-foot{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;margin-top:24px;padding-top:14px;border-top:1px solid var(--line);font-size:13px;color:var(--muted)}
.lc-claim{margin:10px 0 0;font-size:13px}.lc-claim a{color:var(--muted)}
`;
