// A parish or an event link: what its card holds, and its words.
//
// A link somebody sends — /sgr, /sgr/next-tue, /sgr/liturgy, /sgr/evening,
// /sgr/timetables, /102, /42:2026-10-04 — is answered with the page
// (routes/pages.mjs), and a chat app or a search engine reading it runs no
// JavaScript. So the Worker decides here what the link is about: the parish,
// the occurrence it pins, the fortnight it lists, the rules on its timetable.
// Its head is written from the words here (liteMeta, liteImage,
// churchJsonLd, by lib/page-head.mjs) and its card painted from the model
// (lib/page-card.mjs), until the page's own takes its place.
//
// PURE. Rows in, a model out, words out of the model — no D1, no fetch, no
// clock except the one passed in — so `node --test` covers every line of it.
// worker/routes/pages.mjs does the reading and the caching.
//
// THE LENS IS THE PAGE'S. The occurrences come out of expandFrom + buildFeed,
// the same two functions public/bundle.js runs in the browser, over the same
// rows narrowed to one parish; the URL is read by url-state.js, the pin chosen
// by its firstEventOnDay. The painted card and the page's cannot disagree
// about which services exist or which one a link means.

import services from '../../public/shared/services.js';
import dates from '../../public/shared/dates.js';
import urlState from '../../public/shared/url-state.js';
import linkWords from '../../public/shared/link-words.js';
import ruleFilters from '../../public/shared/timetable.js';
import search from '../../public/shared/search-words.js';
import jurisColors from '../../public/shared/jurisdiction-colors.js';
import { expandFrom } from '../../public/shared/project.mjs';
import { buildFeed } from '../../public/shared/merge.mjs';
import { localDateOf, localPartsOf } from '../../public/shared/tz.mjs';

const DAY_MS = 86400000;
/** How far a link's card looks ahead. The page's own stream is where the rest of the year lives. */
export const LITE_WINDOW_DAYS = 56;
/**
 * How far a link with words of its own looks (/smmp/disco): a season, as the
 * app's matchesAt does, so a flyer for Christmas sent in October finds it.
 */
export const WORDS_WINDOW_DAYS = 120;
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
 * starts on, `days` on. Widened by a day at the front, because a
 * parish in Auckland is already on tomorrow when Perth is on today; the list
 * trims by LOCAL date afterwards, which is the date that means anything.
 */
export function liteWindow(fromDate, days = LITE_WINDOW_DAYS) {
  const start = Date.parse(`${fromDate}T00:00:00Z`) - DAY_MS;
  return {
    fromUtc: new Date(start).toISOString(),
    toUtc: new Date(start + (days + 2) * DAY_MS).toISOString(),
  };
}

/** How many days a link's card reads: a season for one with words, else LITE_WINDOW_DAYS. */
export const liteDays = (route) => (route && route.words && route.words.length ? WORDS_WINDOW_DAYS : LITE_WINDOW_DAYS);

/**
 * What a link's own words ask (/smmp/disco), read as the search box reads
 * them (search-words.js), or null when it has none that ask anything.
 */
export function wordsQuery(route, today) {
  if (!route || !route.words || !route.words.length) return null;
  const Q = search.parseQuery(search.phraseOf(route.words), today);
  return search.asks(Q) ? Q : null;
}

/**
 * Does an occurrence answer what a link asks of it, its words aside: its
 * service, day, part of the day, kind and language? `e._local` is its
 * parish's clock; `parishOk`, whether its parish holds a service in the
 * link's language (timetable.js rowAnswersLang).
 */
export function answersRoute(e, route, zone, parishOk) {
  if (route.service && !services.serviceMatches(route.service, e)) return false;
  if (!services.dayMatches(route.day, e._local.dow)) return false;
  if (route.dayGroup && !services.dayGroupMatches(route.dayGroup, e._local.dow, e, zone)) return false;
  if (route.part && services.partOfDayOf(e, zone) !== route.part) return false;
  if (!ruleFilters.kindMatches(e, route)) return false;
  return ruleFilters.rowAnswersLang(e, ruleFilters.langFilterOf(route), parishOk);
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

/**
 * Everything the page says, decided before a character of markup is written.
 *
 * `route` is url-state's classification of the path, with a resolved parish.
 * `pinnedEvent` is the event a bare id named, resolved by the caller because it
 * may lie outside the window (a link to last month's feast still answers).
 */
export function liteModel({ parish, rows, events = [], cross = [], links = [], route, pinnedEvent = null, now, origin, overrides = {}, venues = {} }) {
  const zone = parish.timezone || DEFAULT_ZONE;
  const slug = parishSlug(parish);
  // /sgr/timetables is the parish's timetable — the rules, not the dates they
  // produce — as /timetables is in the app. It lists no occurrences and pins
  // none; its way on is the upcoming events, in the app.
  const servicesMode = !!route.timetable && !route.eventId;
  const start = liteStartDate(route, zone, now);
  const days = liteDays(route);
  const { fromUtc, toUtc } = liteWindow(start, days);

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
  // A kind (/sgr/talks) and a language (/sgr/en) ask it as much as a service
  // does: the page opens the first that answers, in front of the parish.
  const lf = ruleFilters.langFilterOf(route);
  // A service answers a language by its own tags; a talk or a social by its
  // parish holding a service in it (timetable.js rowAnswersLang).
  const today0 = localDateOf(zone, now);
  const liveRules = rows.schedules.filter(r => r.parish_id === parish.id
    && r.active !== 0 && (!r.effective_to || r.effective_to >= today0));
  const parishOk = ruleFilters.parishAnswersLang(liveRules, lf);
  // The link's own words (/smmp/disco), asked of each occurrence as the
  // search box asks them. Words nothing here answers ask nothing: the card
  // is the parish's, as the app's is when no match opens over it.
  let wq = route.eventId ? null : wordsQuery(route, today0);
  const answersWords = (e) => !wq || search.answers(e, wq, { date: e._local.date, hm: e._local.time,
    parishLang: (lang) => ruleFilters.parishAnswersLang(liveRules, { lang }) });
  if (wq && !feed.some(e => !e.is_tombstone && answersWords(e) && Date.parse(e.end_utc || e.start_utc) >= now)) wq = null;
  const asks = isNarrowed(route) || !!route.kind || !!lf || !!wq;
  const matches = (e) => {
    if (synth) return e.schedule_id === pinnedEvent.schedule_id;
    return answersWords(e) && answersRoute(e, route, zone, parishOk);
  };
  // A season for words that found something; the usual two months otherwise.
  const endBound = new Date(Date.parse(`${start}T00:00:00Z`) + (wq ? days : LITE_WINDOW_DAYS) * DAY_MS).toISOString().slice(0, 10);
  // Under an event: "More at this parish" — everything else on there in the
  // next seven days, whichever rule or none it comes from.
  const weekEnd = new Date(Date.parse(`${start}T00:00:00Z`) + 7 * DAY_MS).toISOString().slice(0, 10);
  const list = route.eventId
    ? feed.filter(e => e.id !== String(route.eventId) && e._local.date >= start && e._local.date < weekEnd)
      .slice(0, LITE_LIST_CAP)
    : feed.filter(e => matches(e) && e._local.date >= start && e._local.date < endBound)
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
  } else if (asks) {
    const pool = list.filter(e => !e.is_tombstone);
    pinned = route.dateFocus && route.precision === 'day'
      ? urlState.firstEventOnDay(pool, route.dateFocus, 'day', e => e._local.date)
      : pool.find(e => Date.parse(e.end_utc || e.start_utc) >= now) || null;
  } else if (route.dateFocus) {
    pinned = urlState.firstEventOnDay(list, route.dateFocus, route.precision, e => e._local.date);
  }

  // Words are anybody's, an endless space of pages: never offered to a search engine.
  const indexable = !route.eventId && !route.dateFocus && !isNarrowed(route) && !servicesMode
    && !(route.words && route.words.length);
  // Day, part, service — the order the app writes them in, and the order they
  // are said: /sgr/wed/evening/vespers.
  const kindSegs = [
    ...(route.day != null ? [services.daySegment(route.day)] : []),
    ...(route.dayGroup ? [route.dayGroup] : []),
    ...(route.part ? [route.part] : []),
    ...(route.service ? [route.service] : []),
  ];
  const dateSegs = route.dateFocus ? [dates.dateSlugFor(route.dateFocus, route.precision)] : [];
  const pathOf = (segs) => `/${segs.map(s => encodeURI(String(s))).join('/')}`;
  const canonicalPath = route.eventId ? pathOf([route.eventId])
    : pathOf([slug, ...kindSegs, ...(servicesMode ? ['timetables'] : []), ...dateSegs]);
  const canonical = `${origin}${canonicalPath}`;

  // A rule that has ended is not on the timetable; one that starts later is,
  // marked "from" — the same reading the app's timetable makes.
  const today = localDateOf(zone, now);
  const rules = [...rows.schedules]
    .filter(r => r.parish_id === parish.id && (!r.effective_to || r.effective_to >= today))
    .map(r => ({ ...r, _today: today }))
    .sort(weekFrom(today));
  // The timetable /timetables shows: the rules the link's filters name. A card
  // keeps the whole timetable under its list, as it always has — there it is
  // the parish's times, not the answer to the link.
  const timetable = !servicesMode ? rules : rules.filter(r =>
    (!route.service || services.serviceMatches(route.service, r))
    && services.dayMatches(route.day, r.day_of_week)
    && (!route.dayGroup || services.dayGroupMatches(route.dayGroup, r.day_of_week, r, zone))
    && (!route.part || services.partOfDayOf(r, zone) === route.part));

  return {
    parish, zone, slug, start, endBound, list, feed, pinned, rules, timetable, links, venues,
    route, servicesMode, indexable, canonical, origin, now,
    missingEvent: !!route.eventId && !pinned,
    ...pageColors(parish, overrides),
  };
}

/**
 * The page's colours and their dark variants, as the app paints them: the
 * jurisdiction's, with /admin's overrides over the shared table and the app's
 * OKLab lift for dark. The table alone was what lite pages used to read, and
 * production's overrides had replaced every one of its colours.
 *
 * `--parish` (the avatar, the buttons, the event groups) and `--juris` (the
 * timetable box) are both the jurisdiction's. They were two because a parish
 * could carry a colour of its own in `parishes.color`; the app stopped drawing
 * it, and the column then went stale under 49 parishes whose jurisdictions
 * /admin had repainted, which only these pages still showed.
 */
export function pageColors(parish, overrides = {}) {
  const juris = jurisColors.jurisdictionColorFrom(overrides, parish.jurisdiction);
  const dark = jurisColors.liftForDark(juris);
  return {
    color: juris,
    colors: { parish: juris, parishDark: dark, juris, jurisDark: dark },
  };
}

// ── words ────────────────────────────────────────────────────────────────

const JURIS_LABEL = linkWords.JURIS_LABEL;
export const jurisLabel = (j) => linkWords.jurisLabel(j);



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



export const isNarrowed = (r) => linkWords.isNarrowed(r);

/**
 * What a link narrows to, as a heading: "Vespers on Wednesdays", "Evening
 * services", "Morning Liturgies on Sundays".
 */
export function kindLabel(r) {
  const plural = r.service ? services.servicePlural(r.service) : null;
  const what = r.part ? `${services.partOfDayLabel(r.part)} ${plural || 'services'}` : (plural || 'Services');
  return what + linkWords.daysPhrase(r);
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
    // Held in another parish's church: that church is where, and its address.
    const venue = e.location_parish_id && e.location_parish_id !== e.parish_id && m.venues[e.location_parish_id];
    const at = venue || p;
    return {
      title: `${e.title} — ${when} · ${p.name}`,
      description: [
        e.is_tombstone ? (e.status === 'cancelled' ? 'CANCELLED.' : 'Not running.') : null,
        e.feast || null,
        `${when} at ${at.full_name || at.name}.`,
        e.location_override || at.address || null,
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

/** Where Google Maps opens: the parish's own Maps entry where somebody picked one, else its pin. Never directions. */
export function mapsHref(p) {
  if (p.maps_url) return p.maps_url;
  if (p.lat && p.lng) return `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`;
  return '';
}

/**
 * Day, then time, the week starting on `today` (the parish's 'YYYY-MM-DD') —
 * the order a parish's timetable reads in.
 */
export function weekFrom(today) {
  const t = new Date(`${today}T00:00:00Z`).getUTCDay();
  const from = (d) => (d - t + 7) % 7;
  return (a, b) => from(a.day_of_week) - from(b.day_of_week)
    || String(a.start_time).localeCompare(String(b.start_time));
}

/** The days a collection's Coming up lists in the lite version: a week, so a long list stays light. */
export const COLLECTION_FEED_DAYS = 7;

/**
 * What is on at a collection's parishes, as next.js's collFeedHTML lists it,
 * for the lite version, which has no page script to project it: every
 * occurrence from today for COLLECTION_FEED_DAYS, at one of `parishIds`, that
 * answers the link's filters (its service, day, part of the day, kind and
 * language). Each in its own parish's zone. A parish_scoped (Parish only)
 * row is only at a link that names its parish (/sgr+snb): `named`, those
 * the link names, as next.js's scopedOpen has it.
 */
export function collectionFeed({ rows, events = [], cross = [], parishIds, named = [], route, now, zone = DEFAULT_ZONE }) {
  const start = localDateOf(zone, now);
  const { fromUtc } = liteWindow(start);
  const toUtc = new Date(Date.parse(`${start}T00:00:00Z`) + (COLLECTION_FEED_DAYS + 1) * DAY_MS).toISOString();
  const end = new Date(Date.parse(`${start}T00:00:00Z`) + COLLECTION_FEED_DAYS * DAY_MS).toISOString().slice(0, 10);
  const ids = new Set(parishIds), mine = new Set(named);
  const instances = rows.schedules.length ? expandFrom(rows, fromUtc, toUtc) : [];
  const oneOffs = events.filter(e => { const t = Date.parse(e.start_utc); return t >= Date.parse(fromUtc) && t <= Date.parse(toUtc); });
  const extra = new Map();
  for (const c of cross) {
    if (!extra.has(c.event_id)) extra.set(c.event_id, []);
    extra.get(c.event_id).push(c.parish_id);
  }
  const lf = ruleFilters.langFilterOf(route);
  const rulesBy = new Map();
  for (const r of rows.schedules) {
    if (!rulesBy.has(r.parish_id)) rulesBy.set(r.parish_id, []);
    rulesBy.get(r.parish_id).push(r);
  }
  const answersLang = new Map();
  const parishOk = (id) => {
    if (!answersLang.has(id)) answersLang.set(id, ruleFilters.parishAnswersLang(rulesBy.get(id) || [], lf));
    return answersLang.get(id);
  };
  return buildFeed({ instances, oneOffs, crossRows: cross })
    .map(e => ({ ...e, id: String(e.id), _local: localOf(e, e.timezone || zone),
      is_tombstone: e.is_tombstone || TOMB_STATUSES.has(e.status) ? 1 : 0 }))
    .filter(e => {
      const pids = [e.parish_id, ...(extra.get(e.id) || [])];
      if (!pids.some(id => ids.has(id))) return false;
      if (e.parish_scoped && !pids.some(id => mine.has(id))) return false;
      if (e._local.date < start || e._local.date >= end) return false;
      const z = e.timezone || zone;
      if (route.service && !services.serviceMatches(route.service, e)) return false;
      if (!services.dayMatches(route.day, e._local.dow)) return false;
      if (route.dayGroup && !services.dayGroupMatches(route.dayGroup, e._local.dow, e, z)) return false;
      if (route.part && services.partOfDayOf(e, z) !== route.part) return false;
      if (!ruleFilters.kindMatches(e, route)) return false;
      return ruleFilters.rowAnswersLang(e, lf, pids.some(parishOk));
    })
    .sort((a, b) => Date.parse(a.start_utc) - Date.parse(b.start_utc));
}
