// A filter link's timetable: which parishes and rules it means, and its words.
//
// /greek/qld, /liturgy, /wed/evening, /en, /smg+sgr, /timetables — a link that
// names no single parish. The page answers it (routes/pages.mjs): its head
// says what the link is, from the words here (timetableMeta, timetableImage,
// timetableIndexable), and a collection's card is painted from the model
// (lib/page-card.mjs collectionCardHTML), so a reader with no JavaScript, a
// chat preview and a search engine get the parishes and their times. The
// sitemap lists the collections that list somebody (seo.mjs).
//
// Rules, not occurrences. A timetable is what a parish does week by week, and
// it needs no projection — which is also what makes it cheap for 293 parishes.
// "What is on next Sunday" is a list of dates, so a link with a date in it is
// left to the page's own stream.
//
// PURE: rows in, a model out, words out of the model. Which parishes and
// rules a link means is public/shared/timetable.js, the same question the
// page's collections ask.

import services from '../../public/shared/services.js';
import locations from '../../public/shared/locations.js';
import timetable from '../../public/shared/timetable.js';
import collections from '../../public/shared/collections.js';
import urlState from '../../public/shared/url-state.js';
import jurisColors from '../../public/shared/jurisdiction-colors.js';
import linkWords from '../../public/shared/link-words.js';
import lines from '../../public/shared/timetable-lines.js';
import { localDateOf } from '../../public/shared/tz.mjs';
import { previewLogo } from './juris-logos.mjs';
import { jurisLabel, weekFrom, parishSlug, isNarrowed, time12 } from './lite-page.mjs';

const DEFAULT_ZONE = 'Australia/Sydney';
/** The accent when the page is not one jurisdiction's: the app's own blue (next.css --accent). */
const NEUTRAL = '#007aff';

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
 * question for locations.js); `rules` every active rule. `logos` is /admin's
 * jurisdiction logos, { greek: '/logos/…' }. Null when the link names
 * parishes and none of them exists — the app answers that one.
 */
export function timetableModel({ parishes, rules, route, now, origin, overrides = {}, logos = {} }) {
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
    jurisdiction: route.jurisdiction, location: route.location, monasteries: route.monasteries,
    service: route.service, day: route.day, dayGroup: route.dayGroup, part: route.part,
    kind: route.kind, kindSub: route.kindSub,
    lang: route.lang, langStrict: route.langStrict,
    parishIds: named ? new Set(named.map(p => p.id)) : null,
  };

  const scope = parishes.filter(p => timetable.parishInScope(p, f));
  const rulesOf = new Map();
  for (const r of rules) {
    if (r.active === 0) continue;
    if (!rulesOf.has(r.parish_id)) rulesOf.set(r.parish_id, []);
    rulesOf.get(r.parish_id).push(r);
  }

  // A link that asks nothing of the rules (/timetables, /greek, /qld) is a
  // list of the parishes and their times: a parish with no times on file is
  // listed too, in its own jurisdiction's box under the ones that have them.
  // A link that does narrow the rules (/services, /liturgy, /en) lists only
  // the parishes it found an answer at.
  const listsAll = !timetable.narrowsRules(f);
  let withoutTimes = 0;
  let parishCount = 0;
  const regions = new Map();
  for (const p of scope) {
    // Ended rules are off the timetable, by the parish's own calendar; one that
    // starts later stays on, marked "from" — as on the parish card.
    const today = localDateOf(p.timezone || DEFAULT_ZONE, now);
    const own = (rulesOf.get(p.id) || []).filter(r => !r.effective_to || r.effective_to >= today);
    if (!own.length) withoutTimes++;
    if (!own.length && !listsAll) continue;
    const parishOk = timetable.parishAnswersLang(own, timetable.langFilterOf(f));
    const matching = own
      .filter(r => timetable.ruleMatches(r, f, { parishOk }))
      .map(r => ({ ...r, _today: today }))
      .sort(weekFrom(today));
    if (!matching.length && !listsAll) continue;
    if (matching.length) parishCount++;
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
      // Those with times first, then those without; each alphabetical.
      parishes: j.parishes.sort((a, b) => (!a.rules.length - !b.rules.length)
        || String(a.parish.name).localeCompare(String(b.parish.name))),
    })),
  }));

  // The link's own filters, in the order the app writes them. /timetables is
  // not one of them: this page IS the timetable, so the canonical drops it —
  // except on its own, where nothing else would be left to name the page.
  const loc = route.location ? locations.resolveLocation(route.location) : null;
  const segs = [
    ...(route.jurisdiction ? [urlState.jurisdictionSegment(route.jurisdiction)] : []),
    ...(loc ? [loc.slug] : []),
    ...(route.monasteries ? ['monasteries'] : []),
    ...(route.day != null ? [services.daySegment(route.day)] : []),
    ...(route.dayGroup ? [route.dayGroup] : []),
    ...(route.part ? [route.part] : []),
    ...(route.service ? [route.service] : []),
    ...(route.kind ? [urlState.kindSegment(route.kind, route.kindSub)] : []),
    ...(named ? [named.map(parishSlug).join('+')] : []),
    ...(route.lang ? [urlState.englishSegment(route)] : []),
  ];
  // A collection (shared/collections.js) is named by its own link, however
  // this one spelt it: /liturgy/sun is /sun/liturgy.
  const collection = named ? null : collections.collectionFor(route);
  const canonicalPath = collection ? collection.path : segs.length ? pathOf(segs) : '/timetables';

  // The parishes a rule meets at, when it meets at another (venueLite).
  const venueIds = new Set(rules.map(r => r.location_parish_id).filter(Boolean));
  const venues = Object.fromEntries(parishes.filter(p => venueIds.has(p.id))
    .map(p => [p.id, { name: p.name, address: p.address }]));

  return {
    route, named, loc, groups, parishCount, withoutTimes, scopeCount: scope.length, now, origin, venues,
    listsAll, collection, logos,
    canonical: `${origin}${canonicalPath}`,
    overrides,
    // One jurisdiction's page is its colour; several are the site's.
    color: typeof route.jurisdiction === 'string' ? jurisColors.jurisdictionColorFrom(overrides, route.jurisdiction) : NEUTRAL,
  };
}

// ── words ────────────────────────────────────────────────────────────────

/**
 * "Greek Orthodox parishes and times in Queensland" (/greek/qld), "Antiochian
 * Orthodox Liturgies in English": public/shared/link-words.js, whose words the
 * page uses too for what its map is showing.
 */
export function timetableHeading(m) {
  // A few parishes by name, said short: "Feasts at SMG and SMK" (Kevin, 2 Nov 2026).
  if (m.named && m.named.length <= linkWords.FEW) return linkWords.shortHeadingOf(m.route, m.named);
  return linkWords.headingOf(m.route, { loc: m.loc, named: m.named });
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const UPCOMING_SAID = 3;
/**
 * "Sat 7 Nov 6pm: Great Vespers at Sts. Michael & Gabriel, Ryde · Sun 8 Nov
 * 8:45am: Feast of Saint Michael at St. Michael, Kirrawee": what is on next
 * at the parishes a link names (`m.upcoming`, routes/pages.mjs), each on its
 * own parish's clock.
 */
function upcomingWords(m) {
  const nameOf = (id) => ((m.named || []).find(p => p.id === id) || {}).name;
  const said = m.upcoming.slice(0, UPCOMING_SAID).map(e => {
    const { date, time } = e._local;
    const d = new Date(`${date}T00:00:00Z`);
    const at = nameOf(e.parish_id) || e.parish_name;
    return `${services.DAY_NAMES[d.getUTCDay()].slice(0, 3)} ${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${time12(time)}: ${e.title}${at ? ` at ${at}` : ''}`;
  });
  return `${said.join(' · ')}${m.upcoming.length > UPCOMING_SAID ? ' · and more' : ''}.`;
}

/**
 * A city's page (collections.js PLACES), as a search result shows it: "14
 * parishes with services in English. St George Cathedral, Redfern: Wed 7pm
 * Liturgy · …", or "71 Orthodox parishes in Sydney, 30 with their service
 * times. …" — each parish by the first line of its timetable that answers,
 * those with the most lines first, as a parish's own page says its times
 * (Kevin, 10 Nov 2026: Google quotes /smg's).
 */
const PLACE_SAID = 3;
function placeWords(m) {
  const c = m.collection;
  const listed = m.groups.flatMap(g => g.juris.flatMap(j => j.parishes)).filter(x => x.rules.length)
    .map(x => ({ ...x, lines: lines.linesOf(x.rules, { today: x.rules[0]._today }) }))
    .sort((a, b) => b.lines.length - a.lines.length || String(a.parish.name).localeCompare(String(b.parish.name)));
  if (!listed.length) return 'Nothing on file for this yet.';
  // Its Liturgy where it has one: what somebody looking for a church comes for.
  const said = listed.slice(0, PLACE_SAID).map(({ parish, lines: ls }) => {
    const l = ls.find(x => x.r.event_type === 'liturgy') || ls[0];
    const when = [l.q, lines.dayList(l.days), lines.clockText(l.r.start_time)].filter(Boolean).join(' ');
    return `${parish.name}: ${when} ${l.r.title}${l.notes && l.notes.length ? ` (${l.notes[0]})` : ''}`;
  });
  const more = listed.length - said.length;
  const lead = c.lang
    ? `${plural(listed.length, 'parish', 'parishes')} with services in English.`
    : `${plural(m.scopeCount, 'Orthodox parish', 'Orthodox parishes')} in ${c.city}, ${listed.length} with their service times.`;
  return `${lead} ${said.join(' · ')}${more ? ` · and ${more} more` : ''}.`;
}

export function timetableMeta(m) {
  if (m.collection && m.collection.group === 'place') {
    return { title: `${m.collection.headTitle} — service times`, description: placeWords(m) };
  }
  const heading = timetableHeading(m);
  const listed = m.groups.flatMap(g => g.juris.flatMap(j => j.parishes));
  const names = listed.slice(0, 4).map(x => x.parish.name).join(', ');
  const which = m.upcoming && m.upcoming.length ? upcomingWords(m)
    : listed.length
      ? `${plural(m.parishCount, 'parish', 'parishes')}: ${names}${listed.length > 4 ? ' and more' : ''}.`
      : 'Nothing on file for this yet.';
  return {
    title: heading,
    // A collection says what it holds first, then what it holds now.
    description: m.collection ? `${m.collection.blurb} ${which}` : which,
  };
}

/**
 * Is this page for a search engine? A collection's is, once it lists
 * somebody: the owner's ruling of October 2026, which replaced "only the parish
 * pages" (docs/lite-pages.md). Every other link stays noindex: a list picked
 * by hand is its maker's, and the other mixes of filters are an endless space
 * of near-copies of these.
 */
export function timetableIndexable(m) {
  // A city's English page waits for enough parishes to be a page of its own.
  const enough = !m.collection || !m.collection.minParishes || m.parishCount >= m.collection.minParishes;
  return !!m.collection && !m.named && m.groups.length > 0 && enough;
}

/**
 * The preview's picture: the poster of what is on next at the parishes a
 * link names; a jurisdiction's logo once /admin has one, as a parish
 * previews with its own; else the collection's card, else the
 * jurisdiction's, else the site's.
 */
export function timetableImage(m) {
  // What is on next at the parishes a link names, by its poster.
  const poster = (m.upcoming || []).find(e => e.poster_path);
  if (poster) return /^https?:/.test(poster.poster_path) ? poster.poster_path : `${m.origin}${poster.poster_path}`;
  const j = m.route.jurisdiction;
  const logo = m.collection && previewLogo(m.logos, m.collection.jurisdiction);
  const path = logo || (m.collection && m.collection.image) || `/og/${OG_CARDS.has(j) ? j : 'default'}.jpg`;
  return /^https?:/.test(path) ? path : `${m.origin}${path}`;
}
