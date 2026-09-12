// Step 1 of the pipeline in docs/parish-ingestion.md: turn the Antiochian
// Archdiocese's location directory into rows, with no geocoding and no writes.
//
// WHY THIS SCRIPT DOES NOT FETCH. antiochian.org.au sits behind a Cloudflare
// managed challenge that refuses every automated client — curl, Node's fetch, a
// headless Chromium, and the harness's own fetcher all get 403 on every path,
// robots.txt included, so there is no published policy to read either. The site
// is not broken and the Archdiocese is not hiding: a human browser loads it
// fine. So the fetching is done by a person and the responses are dropped into
// `cache/antiochian/`; this script only ever parses what is already on disk.
// That keeps the three-pass shape the brief asks for — the parse stays
// iterative and re-running costs the site nothing at all.
//
// WHAT THE DIRECTORY IS. An Avada "portfolio" post type, `avada_portfolio`,
// exposed at /wp-json/wp/v2/avada_portfolio. Two things matter about it:
//
//   - It is NOT only parishes. 838 of the ~900 posts are daily scripture
//     bulletins, and the rest mixes churches with childcare centres, two
//     archdiocesan departments, a homeless charity and catechism articles.
//     The `portfolio_category` taxonomy is what separates them, and its
//     published per-term counts are a checksum: if the parishes selected here
//     do not add up to what the taxonomy says, something has been missed.
//
//   - Each parish page is a set of Avada tabs — CONTACT, ABOUT, LOCATION,
//     PRAYER SERVICES, EDUCATION, COMMITTEES — rendered into `content`. The
//     address is prose under an <h3>Location</h3>, not a field, so it arrives
//     as whatever the parish wrote and has to be read as such.
//
// PRAYER SERVICES is left on the floor here deliberately. It carries real
// service times ("9:00AM Matins (Arabic), 10:00AM Liturgy") and those are the
// raw material for an adapter, which is a different job from putting parishes
// on a map. It is parsed and kept in the output so the next person does not
// have to ask for these pages a second time.

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

// portfolio_category terms that mean "people worship here". Monasteries and
// missions are in: they hold public services, which is the only test that
// matters for a feed of services. Charities, childcare and departments are not.
export const WORSHIP_TERMS = new Set([
  112, // parishes
  116, // australian-parishes
  146, // missions
  148, // australian-missions
  114, // nsw-parishes
  124, // vic-parishes
  128, // qld-parishes
  138, // sa-parishes
  156, // vic-missions
  152, // qld-missions
  160, // new-zealand-parishes
  162, // new-zealand-missions
  646, // monastery
]);

// The state a parish is filed under. Only ever a HINT for the geocoder: the
// ROCOR directory filed Tweed Heads under Queensland when it is in New South
// Wales, which is an hour's error twice a year, so the real state comes from
// the geocode and this is used only to narrow the first query.
const STATE_TERMS = {
  24: 'NSW', 114: 'NSW',
  126: 'VIC', 124: 'VIC', 156: 'VIC',
  130: 'QLD', 128: 'QLD', 152: 'QLD',
  140: 'SA', 138: 'SA',
  158: 'NZ', 160: 'NZ', 162: 'NZ',
};

const STATE_NAME = {
  NSW: 'New South Wales', VIC: 'Victoria', QLD: 'Queensland',
  SA: 'South Australia', NZ: null,
};

// ── reading the rendered tabs ──────────────────────────────────────────────

const entities = (s) => s
  .replace(/&#8217;|&#x2019;/g, '’').replace(/&#8216;/g, '‘')
  .replace(/&#8211;/g, '–').replace(/&#8212;/g, '—')
  .replace(/&#038;|&amp;/g, '&').replace(/&nbsp;|&#160;/g, ' ')
  .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));

/** Rendered HTML to readable text, keeping list items on separate lines. */
export const text = (html) => entities((html || '')
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<\/(li|p|h[1-6]|div|tr)>/gi, '\n')
  .replace(/<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' '))
  .replace(/[ \t ]+/g, ' ')
  .split('\n').map((l) => l.trim()).filter(Boolean)
  .join('\n');

/**
 * The <h3> sections of a rendered parish page, as `{ heading: body }`.
 *
 * Keyed on the h3 rather than on the tab, because the tab titles live in a nav
 * elsewhere in the markup and are joined to their panes by an aria id — while
 * the headings sit directly above the thing they label. "Location", "Languages"
 * and "Main Parish Contact" are all h3s.
 */
export function sections(contentHtml) {
  const out = {};
  const parts = String(contentHtml || '').split(/<h3[^>]*>/i);
  for (const part of parts.slice(1)) {
    const close = part.search(/<\/h3>/i);
    if (close < 0) continue;
    const heading = text(part.slice(0, close)).replace(/\s+/g, ' ').trim();
    const body = text(part.slice(close + 5));
    if (heading) out[heading] = body;
  }
  return out;
}

/** Every href matching a scheme, deduped, in document order. */
const hrefs = (html, re) => [...new Set(
  [...String(html || '').matchAll(/href="([^"]+)"/gi)]
    .map((m) => entities(m[1]))
    .filter((h) => re.test(h)),
)];

const OWN_SITE = /antiochian\.org\.au|jotform|facebook|youtube|instagram|google\.com\/maps|wp-content|^#|^javascript:|^mailto:|^tel:/i;

/** The parish's own website: an external link that is not the Archdiocese's. */
export const parishWebsite = (html) => hrefs(html, /^https?:/i)
  .find((h) => !OWN_SITE.test(h)) || null;

export const email = (html) => (hrefs(html, /^mailto:/i)[0] || '').replace(/^mailto:/i, '') || null;
export const phone = (html) => {
  const raw = (hrefs(html, /^tel:/i)[0] || '').replace(/^tel:/i, '').trim();
  return raw || null;
};

/**
 * A parish's address as the Location section words it.
 *
 * Deliberately NOT cleaned up beyond whitespace. The Greek run's lesson was
 * that field labels are not a schema and normalisation is wrong somewhere; here
 * the same applies to the address itself, which is prose. What the parish wrote
 * is kept verbatim and the geocoder is given the job of making sense of it.
 */
export function location(secs) {
  for (const [heading, body] of Object.entries(secs)) {
    if (/^location$/i.test(heading)) return body.split('\n').join(', ') || null;
  }
  return null;
}

/** Languages, as `parishes.languages` wants them: a JSON array of names. */
export function languages(secs) {
  const body = Object.entries(secs).find(([h]) => /^languages?$/i.test(h))?.[1];
  if (!body) return null;
  const list = body.split('\n').map((l) => l.trim())
    .filter((l) => l && l.length < 30 && !/[.:]$/.test(l));
  return list.length ? list : null;
}

/**
 * An address that names no street.
 *
 * "Temporary place of worship in Kalkallo, VIC, Australia (contact the clergy)"
 * is a suburb and an apology, not a location, and geocoding it lands on the
 * locality centroid while looking like a real pin. A PO box is the same problem
 * — ROCOR's Marrickville monastery publishes one — so both are flagged here and
 * the row is held back unless somebody decides otherwise.
 */
export const isVague = (addr) => !addr
  || /\bP\.?O\.?\s*box\b/i.test(addr)
  || !/\d/.test(addr)
  || /\b(temporary|contact the clergy|tba|to be advised)\b/i.test(addr);

// ── the run ────────────────────────────────────────────────────────────────

/** A cached REST post to a scraped parish row. */
export function toParish(post, { indexEntry } = {}) {
  const html = post.content?.rendered ?? post.content ?? '';
  const secs = sections(html);
  const title = entities(String(post.title?.rendered ?? post.title ?? '')).trim();
  // The directory names every parish "<dedication>, <suburb>", so the suburb is
  // the last comma-separated piece — except Goulburn's monastery, whose title
  // carries a second dedication after a pipe.
  const head = title.split('|')[0].trim();
  const bits = head.split(',').map((s) => s.trim()).filter(Boolean);
  const suburb = bits.length > 1 ? bits[bits.length - 1] : null;
  const cats = indexEntry?.cats || [];
  const stateAbbr = cats.map((c) => STATE_TERMS[c]).find(Boolean) || null;
  const addr = location(secs);

  return {
    name: head,
    full_title: title,
    suburb,
    state_abbr: stateAbbr === 'NZ' ? null : stateAbbr,
    state: stateAbbr === 'NZ' ? null : STATE_NAME[stateAbbr] || null,
    country: stateAbbr === 'NZ' ? 'New Zealand' : 'Australia',
    jurisdiction: 'antiochian',
    address: addr,
    address_vague: isVague(addr),
    website: parishWebsite(html),
    email: email(html),
    phone: phone(html),
    languages: languages(secs),
    is_mission: cats.includes(146),
    is_monastery: cats.includes(646),
    // Each row points at the page its address actually came from, not at the
    // directory index — that is what makes the provenance checkable.
    source_ref: post.link || `https://www.antiochian.org.au/avada_portfolio/${post.slug}/`,
    slug: post.slug,
    post_id: post.id,
    // Kept so the next person does not have to fetch these pages again. Service
    // times are an adapter's job, not this import's.
    sections: secs,
  };
}

export async function scrapeAll(cacheDir) {
  const index = JSON.parse(await readFile(join(cacheDir, 'index.json'), 'utf8'));
  const bySlug = new Map(index.posts.map((p) => [p.slug, p]));

  const postsDir = join(cacheDir, 'posts');
  const files = (await readdir(postsDir)).filter((f) => f.endsWith('.json'));
  const seen = new Map();
  for (const file of files) {
    const body = JSON.parse(await readFile(join(postsDir, file), 'utf8'));
    for (const post of Array.isArray(body) ? body : [body]) {
      if (!bySlug.has(post.slug)) continue;   // a bulletin or a childcare centre
      seen.set(post.slug, post);
    }
  }

  const parishes = [...bySlug.keys()]
    .filter((s) => seen.has(s))
    .map((s) => toParish(seen.get(s), { indexEntry: bySlug.get(s) }));

  const missing = [...bySlug.keys()].filter((s) => !seen.has(s));
  return { source: index.source, scraped_at: new Date().toISOString(), parishes, missing };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cacheDir = process.argv[2] || './cache/antiochian';
  const output = process.argv[3] || './antiochian-scraped.json';
  const { writeFile } = await import('node:fs/promises');

  const result = await scrapeAll(cacheDir);
  const { parishes, missing } = result;

  console.log(`${parishes.length} places of worship parsed from ${cacheDir}\n`);
  for (const p of parishes) {
    const flag = p.address_vague ? '  NO STREET' : '';
    console.log(`  ${(p.name + ',').padEnd(42)} ${(p.suburb || '?').padEnd(18)} ${p.state_abbr || p.country}${flag}`);
    if (p.address) console.log(`      ${p.address}`);
  }
  if (missing.length) {
    console.log(`\nnot yet cached (${missing.length}): ${missing.join(', ')}`);
  }
  const vague = parishes.filter((p) => p.address_vague);
  console.log(`\naddresses: ${parishes.length - vague.length}/${parishes.length} name a street`);
  if (vague.length) for (const p of vague) console.log(`  vague: ${p.name} — ${p.address || '(none)'}`);
  console.log(`websites: ${parishes.filter((p) => p.website).length}  emails: ${parishes.filter((p) => p.email).length}  phones: ${parishes.filter((p) => p.phone).length}`);

  await writeFile(output, JSON.stringify(result, null, 1));
  console.log(`\nwrote ${output}`);
}
