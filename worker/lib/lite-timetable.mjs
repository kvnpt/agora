// The timetable page: a general link, answered by the Worker.
//
// /greek/qld, /liturgy, /wed/evening, /en, /smg+sgr, /services — a link that
// names no single parish used to boot the whole app, map first, to show what is
// really a list: which parishes hold which services when. This is that list,
// in the HTML itself: the rules of every parish the link covers, grouped by
// state and then jurisdiction, alphabetical all the way down, with the way on
// into the app's dated feed under it.
//
// Rules, not occurrences. A timetable is what a parish does week by week, and
// it needs no projection — which is also what makes it cheap for 293 parishes.
// "What is on next Sunday" is a list of dates, so a link with a date in it is
// left to the app (routes/pages.mjs).
//
// Most parishes have no times on file yet — 253 of 293 in October 2026 — so
// the page says how many, and that count opens the app's Schedules view, which
// lists them by name.
//
// PURE, like lite-page.mjs: rows in, a model out, markup out of the model.
// Which parishes and rules a link means is public/shared/timetable.js, the
// same question the app's Schedules view asks.

import services from '../../public/shared/services.js';
import locations from '../../public/shared/locations.js';
import timetable from '../../public/shared/timetable.js';
import jurisColors from '../../public/shared/jurisdiction-colors.js';
import { localDateOf } from '../../public/shared/tz.mjs';
import {
  esc, jurisLabel, timetableLabel, parishSlug, isNarrowed, liteDocument, scheduleRowsHTML,
} from './lite-page.mjs';

const DEFAULT_ZONE = 'Australia/Sydney';
/** The accent when the page is not one jurisdiction's: the app's own blue. */
const NEUTRAL = '#1565c0';

const AU_STATES = {
  ACT: 'Australian Capital Territory', NSW: 'New South Wales', NT: 'Northern Territory',
  QLD: 'Queensland', SA: 'South Australia', TAS: 'Tasmania', VIC: 'Victoria', WA: 'Western Australia',
};
const COUNTRIES = locations.LOCATIONS.filter(l => l.kind === 'country' && l.bbox);

/**
 * Where a parish is, as the page's top heading. An Australian state by its
 * address (locations.js says why the address and not the pin); elsewhere the
 * country whose box holds the pin. States first, then countries, each
 * alphabetical — `rank` orders the two bands.
 */
export function regionOf(parish) {
  const st = locations.parishAuState(parish);
  if (st && AU_STATES[st]) return { key: st, label: AU_STATES[st], rank: 0 };
  const country = parish.lat != null && parish.lng != null
    ? COUNTRIES.find(c => locations.locationMatchesParish(c, parish)) : null;
  if (country) return { key: country.slug, label: country.label, rank: 1 };
  return { key: 'elsewhere', label: 'Elsewhere', rank: 2 };
}

const OG_CARDS = new Set(['antiochian', 'greek', 'serbian', 'russian', 'romanian', 'macedonian']);
const byLabel = (a, b) => a.rank - b.rank || a.label.localeCompare(b.label);
const pathOf = (segs) => `/${segs.map(s => encodeURI(String(s))).join('/')}`;
const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');

/**
 * Everything the page says.
 *
 * `route` is url-state's classification of the path. `parishes` is every
 * parish (the scope is decided here, not in SQL, because a region is a
 * question for locations.js); `rules` every active rule. Null when the link
 * names parishes and none of them exists — the app answers that one.
 */
export function timetableModel({ parishes, rules, route, now, origin, overrides = {} }) {
  // Several parishes by name: /smg+sgr. Acronym first, the id as the fallback,
  // in the order the link gives them — the same reading the app makes.
  let named = null;
  if (route.parishSlugs && route.parishSlugs.length > 1) {
    named = [];
    for (const slug of route.parishSlugs) {
      const p = parishes.find(x => x.id !== '_unassigned' && x.acronym && norm(x.acronym) === norm(slug))
        || parishes.find(x => x.id !== '_unassigned' && norm(x.id) === norm(slug));
      if (p && !named.includes(p)) named.push(p);
    }
    if (!named.length) return null;
  }
  const f = {
    jurisdiction: route.jurisdiction, location: route.location,
    service: route.service, day: route.day, part: route.part,
    englishOnly: route.englishOnly, englishStrict: route.englishStrict,
    parishIds: named ? new Set(named.map(p => p.id)) : null,
  };

  const scope = parishes.filter(p => timetable.parishInScope(p, f));
  const rulesOf = new Map();
  for (const r of rules) {
    if (r.active === 0) continue;
    if (!rulesOf.has(r.parish_id)) rulesOf.set(r.parish_id, []);
    rulesOf.get(r.parish_id).push(r);
  }

  let withoutTimes = 0;
  let parishCount = 0;
  const regions = new Map();
  for (const p of scope) {
    // Ended rules are off the timetable, by the parish's own calendar; one that
    // starts later stays on, marked "from" — as on the parish card.
    const today = localDateOf(p.timezone || DEFAULT_ZONE, now);
    const own = (rulesOf.get(p.id) || []).filter(r => !r.effective_to || r.effective_to >= today);
    if (!own.length) { withoutTimes++; continue; }
    const matching = own
      .filter(r => timetable.ruleMatches(r, f, { parishLanguages: p.languages }))
      .map(r => ({ ...r, _today: today }))
      .sort((a, b) => a.day_of_week - b.day_of_week || String(a.start_time).localeCompare(String(b.start_time)));
    if (!matching.length) continue;
    parishCount++;
    const region = regionOf(p);
    if (!regions.has(region.key)) regions.set(region.key, { ...region, juris: new Map() });
    const jmap = regions.get(region.key).juris;
    const j = p.jurisdiction || 'other';
    if (!jmap.has(j)) jmap.set(j, { key: j, label: jurisLabel(j), rank: 0, parishes: [] });
    jmap.get(j).parishes.push({ parish: p, rules: matching });
  }
  const groups = [...regions.values()].sort(byLabel).map(r => ({
    ...r,
    juris: [...r.juris.values()].sort(byLabel).map(j => ({
      ...j,
      parishes: j.parishes.sort((a, b) => String(a.parish.name).localeCompare(String(b.parish.name))),
    })),
  }));

  // The link's own filters, in the order the app writes them. /services is
  // not one of them: this page IS the timetable, so the canonical drops it —
  // except on its own, where nothing else would be left to name the page.
  const loc = route.location ? locations.resolveLocation(route.location) : null;
  const segs = [
    ...(route.jurisdiction ? [route.jurisdiction] : []),
    ...(loc ? [loc.slug] : []),
    ...(route.day != null ? [services.daySlug(route.day)] : []),
    ...(route.part ? [route.part] : []),
    ...(route.service ? [route.service] : []),
    ...(named ? [named.map(parishSlug).join('+')] : []),
    ...(route.englishOnly ? [route.englishStrict ? 'en' : 'bilingual'] : []),
  ];
  const canonicalPath = segs.length ? pathOf(segs) : '/services';

  return {
    route, named, loc, groups, parishCount, withoutTimes, scopeCount: scope.length, now, origin,
    canonical: `${origin}${canonicalPath}`,
    // The dated feed for the same link, and the Schedules view, where the
    // parishes with no times are listed by name. ?app is the Worker's cue to
    // serve the app rather than this page again.
    eventsHref: `${segs.length ? pathOf(segs) : '/'}?app`,
    servicesHref: `${pathOf([...segs, 'services'])}?app#no-times`,
    overrides,
    color: route.jurisdiction ? jurisColors.jurisdictionColorFrom(overrides, route.jurisdiction) : NEUTRAL,
  };
}

// ── words ────────────────────────────────────────────────────────────────

/**
 * "Greek Orthodox service times in Queensland", "Orthodox evening Vespers on
 * Wednesdays", "Antiochian Orthodox Liturgies in English".
 */
export function timetableHeading(m) {
  const r = m.route;
  const who = r.jurisdiction ? jurisLabel(r.jurisdiction) : 'Orthodox';
  const svc = r.service ? services.servicePlural(r.service) : null;
  const noun = svc || (isNarrowed(r) ? 'services' : 'service times');
  const day = r.day != null ? ` on ${services.dayName(r.day)}s` : '';
  const lang = r.englishOnly ? (r.englishStrict ? ' in English' : ' in English or bilingual') : '';
  let where = m.loc ? ` in ${m.loc.label}` : '';
  if (m.named) {
    const names = m.named.map(p => p.name);
    where = ` at ${names.length > 2 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join(' and ')}`;
  }
  return [who, r.part || '', noun].filter(Boolean).join(' ') + day + lang + where;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export function timetableMeta(m) {
  const heading = timetableHeading(m);
  const listed = m.groups.flatMap(g => g.juris.flatMap(j => j.parishes));
  const names = listed.slice(0, 4).map(x => x.parish.name).join(', ');
  return {
    title: heading,
    description: listed.length
      ? `${plural(m.parishCount, 'parish', 'parishes')}: ${names}${listed.length > 4 ? ' and more' : ''}.`
      : 'No service times on file for this yet.',
  };
}

// ── markup ───────────────────────────────────────────────────────────────
//
// The app's Schedules view (renderServices in app.js), in its own class names
// so /app.css styles it: a framed jurisdiction-box per jurisdiction, a
// parish-schedule block per parish, renderScheduleDaysHTML's rows. The state
// headings over them are the page's own — the app's view has no states.

/** A parish's colour, as the app picks it: its own, else its jurisdiction's. */
function parishColor(p, m) {
  const own = typeof p.color === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(p.color.trim()) ? p.color.trim() : null;
  return own || jurisColors.jurisdictionColorFrom(m.overrides, p.jurisdiction);
}

function parishHTML({ parish: p, rules }, m, n) {
  const slug = parishSlug(p);
  const initial = (p.name || '?').trim()[0].toUpperCase();
  const avatar = p.logo_path
    ? `<div class="parish-schedule-avatar"><img src="${esc(p.logo_path)}" alt=""></div>`
    : `<div class="parish-schedule-avatar">${esc(initial)}</div>`;
  return `
        <div class="parish-schedule tt-parish pc-${n}">
          <a class="parish-schedule-head" href="/${esc(slug)}">${avatar}<div class="parish-schedule-name"><span class="tt-name">${esc(p.name)}</span>${p.address ? `<span class="tt-addr">${esc(p.address)}</span>` : ''}</div></a>
          ${scheduleRowsHTML(rules, slug, m.now)}
        </div>`;
}

function groupsHTML(m, vars) {
  if (!m.groups.length) {
    const msg = !m.scopeCount ? 'No parishes on file here yet.'
      : m.withoutTimes === m.scopeCount ? 'None of these parishes has its service times on file yet.'
        : 'No service on the timetable matches.';
    return `<p class="lc-empty">${esc(msg)}</p>`;
  }
  let n = 0;
  return m.groups.map(g => `
  <section class="tt-region" aria-label="${esc(g.label)}">
    <div class="month-header">${esc(g.label)}</div>
    ${g.juris.map(j => {
      vars[`j-${j.key}`] = jurisColors.jurisdictionColorFrom(m.overrides, j.key);
      vars[`j-${j.key}Dark`] = jurisColors.liftForDark(vars[`j-${j.key}`]);
      return `
    <div class="jurisdiction-box tt-juris-box" style="--juris-color:var(--j-${esc(j.key)})">
      <div class="section-header jurisdiction-header">${esc(timetableLabel(j.key))}</div>
      ${j.parishes.map(x => {
        n++;
        const c = parishColor(x.parish, m);
        vars[`pc${n}`] = c;
        vars[`pc${n}Dark`] = jurisColors.liftForDark(c);
        return parishHTML(x, m, n);
      }).join('')}
    </div>`;
    }).join('')}
  </section>`).join('');
}

export function renderTimetablePage(m) {
  const meta = timetableMeta(m);
  const sub = m.parishCount ? `${plural(m.parishCount, 'parish', 'parishes')} with times` : '';
  // The jurisdiction's card, as a parish without a logo previews.
  const image = `${m.origin}/og/${OG_CARDS.has(m.route.jurisdiction) ? m.route.jurisdiction : 'default'}.jpg`;
  // The page's colours, collected while the groups render: one custom property
  // per jurisdiction and per parish, each with the app's dark lift.
  const vars = { parish: m.color, parishDark: jurisColors.liftForDark(m.color) };
  const groups = groupsHTML(m, vars);
  const parishVars = Object.keys(vars).filter(k => /^pc\d+$/.test(k))
    .map(k => `.${k.replace('pc', 'pc-')}{--pc:var(--${k})}`).join('');
  return liteDocument({
    title: meta.title,
    description: meta.description,
    canonical: m.canonical,
    // Not yet: Search Console has indexed nothing but the home page, and a
    // mostly empty /macedonian is thin content. docs/lite-pages.md.
    indexable: false,
    ogType: 'website',
    image,
    color: m.color,
    vars,
    main: `
  <style>${parishVars}</style>
  <section class="lc-head tt-head">
    <h1>${esc(timetableHeading(m))}</h1>
    ${sub ? `<p>${esc(sub)}</p>` : ''}
  </section>
  ${groups}
  ${m.withoutTimes ? `<a class="tt-more" href="${esc(m.servicesHref)}">${esc(plural(m.withoutTimes, 'parish', 'parishes'))} without service times on file →</a>` : ''}
  <a class="lc-app" href="${esc(m.eventsHref)}">View upcoming events →</a>`,
  });
}
