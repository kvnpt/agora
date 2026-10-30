// Every link, answered with the page.
//
// Every path reaches the Worker (run_worker_first in wrangler.toml), and every
// page path gets v3: one page that reads its own address (public/index.html,
// public/next/next.js). What the Worker adds is what that page cannot say for
// itself to a reader that runs no JavaScript — a chat app's preview, a search
// engine — which is what the link is, in the page's head (lib/page-head.mjs):
//   - a link to ONE parish, with or without a focus (/sgr, /sgr/next-tue,
//     /sgr/wed/evening/liturgy, /sgr/timetables): the parish's words, its
//     Church structured data, indexable at its plain link alone;
//   - a link to one event (/102, /42:2026-10-04): the event's, never indexed;
//   - a collection (/en, /greek, /sun/liturgy, /talks) and every other filter
//     link (/greek/qld, /smg+sgr): the timetable's heading, a collection
//     indexable once it lists somebody, every other mix noindex;
//   - the home page: the site's;
//   - words that name no parish (/village, /vigil): what the site's search
//     finds for them (wordsPage), never indexed;
//   - anything else (/2026-10-25, /donate): the home page's words, noindex.
// A parish or an event that is not there, and words that find nothing, are a
// 404 with those words.
//
// It FAILS OPEN. Any error reading D1 serves the page as it is deployed, whose
// own head is the home page's, noindex: a head that cannot be built must never
// be the reason a link does not work.

import urlState from '../../public/shared/url-state.js';
import slugs from '../../public/shared/slugs.js';
import { localDateOf, localPartsOf } from '../../public/shared/tz.mjs';
import { fetchWindowRows, expandOne, parseInstanceId } from '../lib/expand.mjs';
import { cachedHtml, cachedText, revalidated, hashEtag } from '../lib/data-version.mjs';
import { liteModel, liteWindow, liteDays, liteStartDate, parishSlug, collectionFeed, COLLECTION_FEED_DAYS,
  wordsQuery, answersRoute, WORDS_WINDOW_DAYS } from '../lib/lite-page.mjs';
import jurisColors from '../../public/shared/jurisdiction-colors.js';
import { timetableModel, timetableIndexable, timetableMeta } from '../lib/lite-timetable.mjs';
import { homeMeta, otherMeta, parishMeta, timetableHeadMeta, wordsMeta, headHTML, withPage } from '../lib/page-head.mjs';
import { parishCardHTML, eventCardHTML, collectionCardHTML } from '../lib/page-card.mjs';
import { sitemapXml } from '../lib/seo.mjs';
import { jurisdictionColorOverrides, PARISH_COLOR_SQL } from '../lib/juris-colors.mjs';
import { jurisdictionLogos } from '../lib/juris-logos.mjs';
import collections from '../../public/shared/collections.js';
import search from '../../public/shared/search-words.js';
import ruleFilters from '../../public/shared/timetable.js';
import { liteSwitch, wantsLite, liteIndex, liteHomeHTML, readerPlace, withLite } from '../lib/lite-mode.mjs';

const DEFAULT_ZONE = 'Australia/Sydney';

// The parish columns a page shows. Not SELECT *: `updated_by` is an admin's
// email and nothing public carries it.
const PARISH_PAGE_COLS = `id, name, full_name, jurisdiction, address, lat, lng, timezone,
  website, phone, email, logo_path, acronym, languages, live_url, donation_url,
  info_source_name, info_source_ref, info_checked_at, maps_url, updated_at`;

const SITE_PATHS = new Set(slugs.SITE_PATHS);

/** The page the Worker wraps every link in: v3, as deployed. */
export const SHELL = '/';
/** The lite version's (public/lite.html; the asset router drops the .html). */
export const LITE_SHELL = '/lite';

/**
 * Which kind of page is this path, or null when it is not a page at all (a
 * site path, a file). Classified against Sydney's today first; a parish's
 * card reclassifies against the parish's own once it knows which parish it
 * is, so /next-tue at a Perth parish means Perth's next Tuesday.
 *
 * `indexable` on a parish says whether the link is the parish's own and
 * nothing else: /greek/sgr and /sgr/en open the same card, under the card's
 * canonical, but are not offered to a search engine themselves.
 */
export function pageOf(pathname, now = Date.now()) {
  const segs = pathname.split('/').filter(Boolean);
  if (!segs.length) return { kind: 'home' };
  if (SITE_PATHS.has(segs[0].toLowerCase())) return null;
  // No parish id, acronym, date or event id has a dot in it, so a dotted last
  // segment is a file — /apple-touch-icon.png, which every iPhone asks for —
  // and not worth a scan of `parishes` to find out.
  if (/\.[a-z0-9]+$/i.test(segs[segs.length - 1])) return null;
  let route;
  try { route = urlState.classifyPath(pathname, { today: localDateOf(DEFAULT_ZONE, now) }); } catch { return { kind: 'other', route: {} }; }
  const named = route.parishSlugs ? route.parishSlugs.length : 0;
  if (route.donate) return { kind: 'other', route };
  if (named === 1) return { kind: 'parish', slug: route.parishSlugs[0], route, indexable: urlState.pageKind(route) === 'parish' };
  if (route.eventId && !named) return { kind: 'event', route };
  if (collections.collectionFor(route) || urlState.pageKind(route) === 'timetable') return { kind: 'timetable', route };
  return { kind: 'other', route };
}

// The parish columns the timetable page reads — address and pin for the
// region, languages for /en, and nothing an admin wrote about themselves.
// A rule's subtitle and description are what a link's words are looked for
// in (wordsPage), as the search box looks.
const TIMETABLE_PARISH_COLS = `id, name, full_name, jurisdiction, address, lat, lng, timezone, acronym, languages,
  logo_path`;
const TIMETABLE_RULE_COLS = `id, parish_id, day_of_week, start_time, end_time, title, event_type,
  feast, description, poster_path, languages, week_of_month, week_parity, effective_from, effective_to, active, parish_scoped,
  source_name, source_ref, source_checked_at, location_override, location_parish_id`;

/** What every timetable page reads: the parishes, their rules, /admin's colours and logos. */
async function timetableRows(env) {
  const [parishes, rules, overrides, logos] = await Promise.all([
    env.DB.prepare(`SELECT ${TIMETABLE_PARISH_COLS} FROM parishes WHERE id != '_unassigned'`).all(),
    env.DB.prepare(`SELECT ${TIMETABLE_RULE_COLS} FROM schedules WHERE active = 1`).all(),
    // The colours /admin set, which the app paints and the page has to match.
    jurisdictionColorOverrides(env.DB),
    jurisdictionLogos(env.DB),
  ]);
  return { parishes: parishes.results || [], rules: rules.results || [], overrides, logos };
}

/**
 * A filter link's head, from its timetable, and a collection's card; a 404
 * when it names parishes none of which are here.
 */
async function timetablePage(env, url, page, now, { lite = false } = {}) {
  const rows = await timetableRows(env);
  const m = timetableModel({ ...rows, route: page.route, now, origin: url.origin });
  if (!m) return missing(url);
  const head = headHTML(timetableHeadMeta(m));
  if (lite) {
    // The lite version has no page to filter, so every filter link is a
    // card: a collection's own, any other mix under its heading, and all of
    // its parishes rather than the first 30.
    const as = m.collection || { id: 'link', title: timetableMeta(m).title, path: new URL(m.canonical).pathname };
    if (!m.groups.length) return { status: 200, head, card: '' };
    // And what is on at them this week, which the full page projects itself.
    const feed = await collectionFeedOf(env, m, page.route, now).catch((err) => {
      console.error(`[lite] coming up ${url.pathname}: ${err && err.message}`);
      return null;
    });
    return { status: 200, head, card: collectionCardHTML({ ...m, collection: as }, { rules: rows.rules, limit: Infinity, feed }) };
  }
  return {
    status: 200, head,
    // A collection's link opens its card (next.js); any other mix of filters is the page itself.
    card: m.collection && m.groups.length ? collectionCardHTML(m, { rules: rows.rules }) : '',
  };
}

/** A collection's week, for the lite version's card (lite-page.mjs collectionFeed). */
async function collectionFeedOf(env, m, route, now) {
  const parishIds = m.groups.flatMap(g => g.juris.flatMap(j => j.parishes.map(x => x.parish.id)));
  const start = localDateOf(DEFAULT_ZONE, now);
  const { fromUtc } = liteWindow(start);
  const toUtc = new Date(Date.parse(`${start}T00:00:00Z`) + (COLLECTION_FEED_DAYS + 1) * 86400000).toISOString();
  const [rows, events, cross] = await Promise.all([
    fetchWindowRows(env.DB, fromUtc, toUtc),
    env.DB.prepare(
      `SELECT e.*, p.name AS parish_name, p.acronym AS parish_acronym, p.jurisdiction, p.timezone
       FROM events e JOIN parishes p ON e.parish_id = p.id
       WHERE e.source_adapter != 'schedule' AND e.start_utc >= ? AND e.start_utc <= ?`
    ).bind(fromUtc, toUtc).all(),
    env.DB.prepare('SELECT event_id, parish_id FROM event_parishes').all().catch(() => ({ results: [] })),
  ]);
  return collectionFeed({
    rows, events: (events.results || []).map(({ updated_by, ...e }) => e),   // eslint-disable-line no-unused-vars
    cross: cross.results || [], parishIds, named: (m.named || []).map(p => p.id), route, now,
  });
}

/** A link to something that is not here: the home page's words, noindex. */
const missing = (url) => ({ status: 404, head: headHTML(otherMeta(url.origin)) });

/**
 * The collections a search engine is offered: every one whose page lists
 * somebody — timetableIndexable, asked of each. /talks and /social as well,
 * since v3 answers them with the same page as any other collection.
 */
export function indexedCollections({ parishes, rules, overrides, logos }, now, origin) {
  return collections.COLLECTIONS.filter(c => {
    const page = pageOf(c.path, now);
    if (!page || page.kind !== 'timetable') return false;
    const m = timetableModel({ parishes, rules, overrides, logos, route: page.route, now, origin });
    return !!m && timetableIndexable(m);
  });
}

async function findParish(db, slug) {
  const norm = String(slug).toLowerCase().replace(/\s+/g, '');
  return (await db.prepare(
    `SELECT ${PARISH_PAGE_COLS} FROM parishes
     WHERE id != '_unassigned' AND lower(replace(acronym, ' ', '')) = ?`
  ).bind(norm).first())
    || db.prepare(`SELECT ${PARISH_PAGE_COLS} FROM parishes WHERE id != '_unassigned' AND lower(id) = ?`)
      .bind(norm).first();
}

/** The event a bare id names, and its parish. Null when neither can be found. */
async function findEvent(db, id) {
  const inst = parseInstanceId(id);
  if (inst) {
    const ev = await expandOne(db, inst.scheduleId, inst.date);
    const rule = ev ? null : await db.prepare('SELECT parish_id FROM schedules WHERE id = ?')
      .bind(inst.scheduleId).first();
    const parishId = ev ? ev.parish_id : rule && rule.parish_id;
    return parishId ? { event: ev, parishId } : null;
  }
  const ev = await db.prepare(
    `SELECT e.*, p.timezone FROM events e JOIN parishes p ON e.parish_id = p.id
     WHERE e.id = ? AND e.status NOT IN ('hidden', 'rejected')`
  ).bind(id).first();
  if (!ev) return null;
  const { updated_by, ...rest } = ev;   // eslint-disable-line no-unused-vars
  // The parishes a combine added, which the card names beside its host.
  const cross = await db.prepare('SELECT parish_id FROM event_parishes WHERE event_id = ?')
    .bind(ev.id).all().catch(() => ({ results: [] }));
  return { event: { ...rest, combined_parishes: (cross.results || []).map(r => r.parish_id) }, parishId: ev.parish_id };
}

/**
 * A parish's or an event's head and card, from the card's model; a 404 when
 * it is not here. `found` is a parish the link's words found (wordsPage),
 * with the words still to ask of it: none for a parish by its name.
 */
async function parishPage(env, url, page, now, found = null) {
  const db = env.DB;
  let parish = found && found.parish, pinnedEvent = null, namedBy = null;
  if (found) {
    // Found by a search (/village): the link is not the parish's own.
  } else if (page.kind === 'parish') {
    parish = await findParish(db, page.slug);
    // /disco/smmp: the parish may be any word nothing else claimed, and the
    // rest are what is asked of it. A few at most, so a crawler's long path
    // costs no more than a handful of reads.
    for (const w of (parish ? [] : (page.route.words || []).slice(0, 3))) {
      parish = await findParish(db, w);
      if (parish) { namedBy = w; break; }
    }
    // None: the words are a search of the site.
    if (!parish) return wordsPage(env, url, page, now);
  } else {
    const found = await findEvent(db, page.route.eventId);
    if (!found) return missing(url);
    pinnedEvent = found.event;
    parish = await db.prepare(`SELECT ${PARISH_PAGE_COLS} FROM parishes WHERE id = ?`)
      .bind(found.parishId).first();
  }
  if (!parish) return missing(url);

  const zone = parish.timezone || DEFAULT_ZONE;
  const read = urlState.classifyPath(url.pathname, { today: localDateOf(zone, now) });
  const route = found ? { ...read, parishSlugs: [parishSlug(parish)], words: found.words }
    : namedBy ? urlState.parishNamed(read, namedBy) : read;
  const { fromUtc, toUtc } = liteWindow(liteStartDate(route, zone, now), liteDays(route));

  const [rows, events, cross, links, overrides] = await Promise.all([
    fetchWindowRows(db, fromUtc, toUtc, { parishId: parish.id }),
    db.prepare(
      `SELECT e.*, p.name AS parish_name, p.acronym AS parish_acronym, ${PARISH_COLOR_SQL} AS parish_color,
              p.jurisdiction, p.timezone
       FROM events e JOIN parishes p ON e.parish_id = p.id
       WHERE e.source_adapter != 'schedule' AND e.start_utc >= ? AND e.start_utc <= ?
         AND (e.parish_id = ? OR e.location_parish_id = ? OR e.id IN (SELECT event_id FROM event_parishes WHERE parish_id = ?))`
    ).bind(fromUtc, toUtc, parish.id, parish.id, parish.id).all(),
    db.prepare('SELECT event_id, parish_id FROM event_parishes WHERE parish_id = ?').bind(parish.id).all(),
    db.prepare('SELECT slug, label, url FROM parish_links WHERE parish_id = ? ORDER BY sort_order, slug')
      .bind(parish.id).all().catch(() => ({ results: [] })),
    jurisdictionColorOverrides(db),
  ]);

  // The parishes this page's events and rules are held at, when not here —
  // named on the card (venueLite) — and those taking part in the pinned
  // event. One read, whatever the count.
  const venueIds = [...new Set([
    ...(rows.schedules || []).map(r => r.location_parish_id),
    ...(rows.overrides || []).map(o => o.patch_location_parish_id),
    ...(events.results || []).map(e => e.location_parish_id),
    pinnedEvent && pinnedEvent.location_parish_id,
    ...((pinnedEvent && pinnedEvent.combined_parishes) || []),
  ].filter(Boolean))];
  const venueRows = venueIds.length
    ? await db.prepare(`SELECT id, name, address, acronym, logo_path, jurisdiction FROM parishes
                        WHERE id IN (SELECT value FROM json_each(?))`)
      .bind(JSON.stringify(venueIds)).all().catch(() => ({ results: [] }))
    : { results: [] };

  const model = liteModel({
    parish, rows,
    events: (events.results || []).map(({ updated_by, ...e }) => e),   // eslint-disable-line no-unused-vars
    cross: cross.results || [],
    links: links.results || [],
    route, pinnedEvent, now, origin: url.origin, overrides,
    venues: Object.fromEntries((venueRows.results || []).map(p => [p.id, {
      name: p.name, address: p.address, acronym: p.acronym, logo_path: p.logo_path, slug: parishSlug(p),
      color: jurisColors.jurisdictionColorFrom(overrides, p.jurisdiction),
    }])),
  });
  return {
    status: 200, head: headHTML(parishMeta(model, { indexable: !found && page.kind === 'parish' && page.indexable })),
    // An event that cannot be found where its rule was is still its parish's card.
    card: page.kind === 'event' && model.pinned ? eventCardHTML(model) : parishCardHTML(model),
  };
}

/**
 * Words that name no parish (/village, /vigil, /antiochian/festival): what
 * the site's search finds for them, read as the box reads them, under
 * whatever else the link says (its jurisdiction, its region, a kind or a
 * day). The page reaches the same verdict (next.js openWords), from the same
 * findAcross (search-words.js):
 *   - one parish by its name, and nothing elsewhere: its card, noindex;
 *   - all that is found at one parish: its first, as at /smmp/disco;
 *   - several places: the words, where they were found and the first poster
 *     (the page builds the card of them), and the places for the lite
 *     version's list;
 *   - nothing: a 404, its words in the lite version's search box.
 * A Parish only row is its parish's own business and is not found from here.
 */
async function wordsPage(env, url, page, now) {
  const read = page.route;
  const words = [...(read.parishSlugs || []), ...(read.words || [])];
  const phrase = search.phraseOf(words);
  const today = localDateOf(DEFAULT_ZONE, now);
  const Q = wordsQuery({ words }, today);
  if (!Q) return missing(url);
  const nowIso = new Date(now).toISOString();
  const toUtc = new Date(Date.parse(`${today}T00:00:00Z`) + (WORDS_WINDOW_DAYS + 1) * 86400000).toISOString();
  const [{ parishes, rules }, events] = await Promise.all([
    timetableRows(env),
    env.DB.prepare(
      `SELECT e.id, e.parish_id, e.title, e.feast, e.description, e.event_type, e.languages,
              e.start_utc, e.end_utc, e.poster_path, p.timezone
       FROM events e JOIN parishes p ON e.parish_id = p.id
       WHERE e.source_adapter != 'schedule' AND e.status = 'approved' AND e.parish_scoped = 0
         AND e.start_utc <= ? AND COALESCE(e.end_utc, e.start_utc) >= ?
       ORDER BY e.start_utc`
    ).bind(toUtc, nowIso).all(),
  ]);
  const here = parishes.filter(p => ruleFilters.parishInScope(p, {
    jurisdiction: read.jurisdiction, location: read.location, monasteries: read.monasteries,
  }));
  const byId = new Map(here.map(p => [p.id, p]));
  const zoneOf = (pid) => (byId.get(pid) && byId.get(pid).timezone) || DEFAULT_ZONE;
  const live = rules.filter(r => byId.has(r.parish_id) && r.active !== 0
    && (!r.effective_to || r.effective_to >= localDateOf(zoneOf(r.parish_id), now)));
  const oneOffs = (events.results || []).filter(e => byId.has(e.parish_id))
    .map(e => ({ ...e, _local: localPartsOf(e.timezone || DEFAULT_ZONE, Date.parse(e.start_utc)) }));
  // A parish holds a language by what its services are tagged with, as the
  // page's hasLang reads it: its timetable and its own one-offs ahead.
  const langRows = new Map();
  for (const r of [...live, ...oneOffs]) {
    if (!langRows.has(r.parish_id)) langRows.set(r.parish_id, []);
    langRows.get(r.parish_id).push(r);
  }
  const parishLang = (pid, lang) => ruleFilters.parishAnswersLang(langRows.get(pid) || [], { lang });
  const lf = ruleFilters.langFilterOf(read);
  const parishOk = (pid) => ruleFilters.parishAnswersLang(langRows.get(pid) || [], lf);
  const rows = [
    ...live.filter(r => ruleFilters.ruleMatches(r, read, { parishOk: parishOk(r.parish_id) })),
    ...oneOffs.filter(e => answersRoute(e, read, zoneOf(e.parish_id), parishOk(e.parish_id)))
      .map(e => ({ ...e, _at: { date: e._local.date, hm: e._local.time } })),
  ];
  const v = search.findAcross({ parishes: here, rows, Q, parishLang,
    hayOf: (p) => collections.JURISDICTION_NAMES[p.jurisdiction] || '' });
  if (v.verdict === 'none') return { ...missing(url), q: phrase };
  if (v.verdict === 'parish' || v.verdict === 'match') {
    const parish = await env.DB.prepare(`SELECT ${PARISH_PAGE_COLS} FROM parishes WHERE id = ?`).bind(v.pid).first();
    if (!parish) return missing(url);
    return parishPage(env, url, page, now, { parish, words: v.verdict === 'match' ? words : [] });
  }
  const poster = v.found.find(r => r.poster_path && r._at) || v.found.find(r => r.poster_path);
  return {
    status: 200,
    head: headHTML(wordsMeta({
      origin: url.origin, phrase,
      places: v.ids.map(id => byId.get(id).name),
      titles: v.found.map(r => r.title),
      image: poster ? poster.poster_path : null,
    })),
    card: '', q: phrase, ids: v.ids,
  };
}

/**
 * The page for this request, or null when it is not a page (the caller hands
 * it to the asset layer).
 *
 * What D1 says about a link — its head — is kept at the edge per data version
 * and per HOUR: "today" and a card's first day move with the clock, and an
 * hour is fine enough for both while keeping a crawler's or a chat app's
 * repeat fetch off D1 entirely. The page around it is the one deployed, read
 * on every request, so a deploy is live at once. The ETag is the finished
 * page's.
 */
export async function servePage(request, env, ctx, { now = Date.now() } = {}) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);

  if (url.pathname === '/sitemap.xml') {
    return cachedHtml({
      request, env, ctx, name: 'sitemap.xml', type: 'application/xml; charset=utf-8',
      build: async () => {
        const [r, rows] = await Promise.all([
          env.DB.prepare(
            `SELECT id, acronym, info_checked_at, updated_at FROM parishes
             WHERE id != '_unassigned' ORDER BY name`
          ).all(),
          timetableRows(env),
        ]);
        return sitemapXml(r.results || [], url.origin, indexedCollections(rows, now, url.origin));
      },
    });
  }

  // Services were /worship while /services was the timetable; the timetable
  // is /timetables now. An old link is sent to its new name, for good.
  const renamed = urlState.renamedPath(url.pathname);
  if (renamed) {
    return new Response(null, {
      status: 301,
      headers: { location: `${renamed}${url.search}`, 'cache-control': 'public, max-age=86400' },
    });
  }

  const page = pageOf(url.pathname, now);
  if (!page) return null;
  // ?lite=1 / ?lite=0: the reader's choice, kept, and the link without it.
  const toggled = liteSwitch(request);
  if (toggled) return toggled;
  const lite = wantsLite(request);
  const shell = await env.ASSETS.fetch(new Request(new URL(lite ? LITE_SHELL : SHELL, url)));
  if (!shell.ok) return null;
  const html = await shell.text();

  let built = null, version;
  const hour = new Date(now).toISOString().slice(0, 13);
  if (page.kind === 'home' && !lite) built = { status: 200, head: headHTML(homeMeta(url.origin)) };
  else {
    try {
      // The lite version's own copy of a filter link: its card differs (timetablePage).
      const own = lite && page.kind === 'timetable' ? 'lite-' : '';
      const kept = page.kind === 'home' ? null : await cachedText({
        request, env, ctx,
        name: `${own}page${encodeURI(url.pathname.toLowerCase())}@${hour}`,
        build: async () => JSON.stringify(page.kind === 'other' ? { status: 200, head: headHTML(otherMeta(url.origin)) }
          : page.kind === 'timetable' ? await timetablePage(env, url, page, now, { lite })
          : await parishPage(env, url, page, now)),
      });
      built = kept ? JSON.parse(kept.text) : { status: 200, head: headHTML(homeMeta(url.origin)) };
      version = kept && kept.version;
    } catch (err) {
      console.error(`[page] ${url.pathname}: ${err && err.message}`);
    }
  }
  if (lite) {
    // The lite home page (and a link that is no card): search and what is
    // near. A failure to read it is the search box alone.
    let main = '';
    if (page.kind === 'home' || page.kind === 'other' || (built && !built.card)) {
      try {
        const kept = await cachedText({
          request, env, ctx, name: `lite-index@${hour}`,
          build: async () => JSON.stringify(liteIndex({ ...(await timetableRows(env)), now })),
        });
        // Words that are a search (/vigil) are its query, and where they were found.
        const ask = url.searchParams.get('q') || '';
        main = liteHomeHTML({ index: JSON.parse(kept.text), q: ask || (built && built.q) || '',
          ids: ask ? null : built && built.ids, at: readerPlace(url, request.cf) });
        version = version || kept.version;
      } catch (err) {
        console.error(`[lite] ${url.pathname}: ${err && err.message}`);
      }
    }
    const body = withLite(built ? withPage(html, built) : html, {
      q: url.searchParams.get('q') || (built && built.q) || '', main, path: `${url.pathname}${url.search}`,
    });
    return revalidated(request, {
      body, etag: await hashEtag(body), version, type: 'text/html; charset=utf-8',
      status: built ? built.status : 200,
      headers: { 'x-agora-page': `lite-${built ? page.kind : 'failed-open'}`, vary: 'cookie' },
    });
  }
  // Failed open: the page as deployed, its own head and all.
  const body = built ? withPage(html, built) : html;
  return revalidated(request, {
    body, etag: await hashEtag(body), version, type: 'text/html; charset=utf-8',
    status: built ? built.status : 200,
    headers: { 'x-agora-page': built ? page.kind : 'failed-open', vary: 'cookie' },
  });
}
